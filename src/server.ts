import { randomUUID } from 'node:crypto';
import { buildApp } from './app.js';
import { googleServiceAccountVerifier } from './auth/scheduler-identity.js';
import { type AppEnv, loadEnv } from './config/env.js';
import { rpcBalanceReader } from './ingest/balance-reader.js';
import { coingeckoPriceProvider } from './ingest/coingecko.js';
import { refreshLiveMetrics } from './ingest/live-loader.js';
import { polygonFillReader } from './ingest/polymarket-fills.js';
import { type IngestionReport, runIngestion } from './ingest/run.js';
import { failedRunEvent, type IngestRunEvent, ingestRunEvent } from './ingest/run-event.js';
import { httpLogoFetcher } from './ingest/token-logos.js';
import { listNetworks, type NetworkDefinition, setNetworks } from './metrics/catalog.js';
import { resetFactsCaches } from './metrics/facts.js';
import { setTokens } from './metrics/tokens.js';
import type { IngestionHandle } from './routes/ingest.js';
import { B2cNetworkSource, databaseFromUri, mergeCatalog } from './store/b2c-networks.js';
import { type ConnectAttempt, connectWithRetry } from './store/connect-retry.js';
import { MongoIngestRepository } from './store/ingest-store.js';
import { MemoryStore } from './store/memory-store.js';
import { MongoStore } from './store/mongo-store.js';
import { visibleNetworks } from './store/network-visibility.js';
import { withReadCache } from './store/read-cache.js';
import type { Store } from './store/types.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
/**
 * Interval between reads of the B2C networks, so a network added there shows up without a deploy.
 * It bounds how long instances can disagree on the catalog; the visibility policy is read on every
 * request and has no such delay.
 */
const NETWORKS_REFRESH_MS = 5 * 60 * 1000;
/** Margin between the run deadline and the lock expiry, so a slow last batch keeps the lock. */
const LOCK_MARGIN_MS = 5 * 60 * 1000;
/**
 * Time the startup has to open its MongoDB connections. Direct VPC egress may take a minute or more
 * to route traffic after an instance starts; the startup probe of the Cloud Run service has to
 * allow longer than this.
 */
const STARTUP_CONNECT_MS = 120 * 1000;

/**
 * Lifetime of the cached session, user and visibility reads. It bounds how long a session revoked,
 * a member removed or a policy changed through another instance keeps applying on this one.
 */
const READ_CACHE_TTL_MS = 30 * 1000;

/**
 * Writes a connection attempt as a structured line before the Fastify logger exists. Cloud Logging
 * reads `severity` and `message`; the line carries no connection string.
 */
function logConnectAttempt(attempt: ConnectAttempt): void {
  const line = {
    severity: attempt.outcome === 'connected' ? 'INFO' : 'WARNING',
    message: `mongodb ${attempt.database} connection attempt ${attempt.attempt} ${attempt.outcome}`,
    time: new Date().toISOString(),
    ...attempt
  };
  process.stdout.write(`${JSON.stringify(line)}
`);
}

/**
 * Ingestion of this process. After each run it loads the new build (`afterRun`, which returns how
 * long that took) and writes one structured event with the run's counters and phase durations;
 * the scheduler keeps the report as the response body, which no log records.
 */
function ingestionHandle(
  env: AppEnv,
  networks: B2cNetworkSource,
  repository: MongoIngestRepository,
  afterRun: () => Promise<{ readbackMs: number }>,
  logRun: (event: IngestRunEvent) => void
): IngestionHandle {
  const maxRunMs = env.INGEST_MAX_RUN_SECONDS * 1000;
  return {
    run: async () => {
      const owner = randomUUID();
      const startedAt = new Date();
      let report: IngestionReport;
      try {
        // The run copies every network and token whatever the B2C `enabled` and the analytics
        // visibility; the visibility only filters what the metrics endpoints serve.
        report = await runIngestion({
          reader: networks.activity(),
          repository,
          prices: env.PRICES_PROVIDER === 'coingecko' ? coingeckoPriceProvider() : null,
          balances:
            env.BALANCES_PROVIDER === 'rpc'
              ? rpcBalanceReader(fetch, Date.now, env.CARDANO_PROVIDER_API_KEY)
              : null,
          polygon:
            env.POLYMARKET_POLYGON_RPC_URL === null
              ? null
              : polygonFillReader(env.POLYMARKET_POLYGON_RPC_URL),
          masterWallets: env.MASTER_WALLETS,
          logos: httpLogoFetcher(fetch),
          valuation: env.USD_VALUATION,
          clock: () => new Date(),
          options: {
            batchSize: env.INGEST_BATCH_SIZE,
            maxTransactionsPerRun: env.INGEST_MAX_TRANSACTIONS_PER_RUN,
            revisitHours: env.INGEST_REVISIT_HOURS,
            maxProviderCallsPerRun: env.PRICES_MAX_CALLS_PER_RUN,
            maxBalanceCallsPerRun: env.BALANCES_MAX_CALLS_PER_RUN,
            maxPolymarketCallsPerRun: env.POLYMARKET_MAX_CALLS_PER_RUN,
            maxRunMs,
            lockTtlMs: maxRunMs + LOCK_MARGIN_MS
          },
          owner
        });
      } catch (error) {
        logRun(failedRunEvent(owner, startedAt, Date.now() - startedAt.getTime(), error));
        throw error;
      }
      const { readbackMs } = await afterRun();
      logRun(ingestRunEvent(report, report.status === 'locked' ? null : readbackMs));
      return report;
    },
    verifyCaller:
      env.INGEST_SCHEDULER_SA_EMAIL === null || env.INGEST_OIDC_AUDIENCE === null
        ? null
        : googleServiceAccountVerifier({
            audience: env.INGEST_OIDC_AUDIENCE,
            serviceAccountEmail: env.INGEST_SCHEDULER_SA_EMAIL
          }),
    devTrigger: env.INGEST_DEV_TRIGGER
  };
}

/**
 * Process entry point: validates the environment, connects the store, loads the networks of the
 * B2C database, starts listening and closes gracefully on SIGINT/SIGTERM (Cloud Run sends SIGTERM
 * before stopping an instance).
 *
 * With Mongo configured, the analytics and B2C connections and the first read of the networks must
 * succeed or the process does not start. The connections are retried until `STARTUP_CONNECT_MS`
 * after startup. The catalog is the B2C networks plus the networks the analytics database retains
 * for their history. Later reads that fail keep the previous catalog, and so does a read after
 * which no network would be visible. The tokens the admin can hide are the token copies of the
 * analytics database, retained ones included, read with the catalog.
 *
 * Live metrics are the last aggregate build of the analytics database, loaded at startup, after
 * each ingestion run of this instance and every `METRICS_REFRESH_SECONDS` (another instance may
 * have run it). The ingestion itself only runs through `POST /v1/internal/ingest`.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const deadline = Date.now() + STARTUP_CONNECT_MS;
  const mongoUri = env.MONGO_URI;
  const store: Store = withReadCache(
    mongoUri === null
      ? new MemoryStore()
      : await connectWithRetry({
          database: 'analytics',
          connect: () => MongoStore.connect({ uri: mongoUri, dbName: env.MONGO_DB_NAME }),
          deadline,
          log: logConnectAttempt
        }),
    { ttlMs: READ_CACHE_TTL_MS }
  );
  const b2cUri = env.B2C_MONGO_URI ?? env.MONGO_URI;
  const networks =
    b2cUri === null
      ? null
      : await connectWithRetry({
          database: 'b2c',
          connect: () =>
            B2cNetworkSource.connect({
              uri: b2cUri,
              dbName: databaseFromUri(b2cUri) ?? env.B2C_MONGO_DB_NAME
            }),
          deadline,
          log: logConnectAttempt
        });
  const ingest =
    mongoUri === null || networks === null
      ? null
      : await connectWithRetry({
          database: 'analytics-ingest',
          connect: () =>
            MongoIngestRepository.connect({ uri: mongoUri, dbName: env.MONGO_DB_NAME }),
          deadline,
          log: logConnectAttempt
        });

  // B2C networks plus the networks the analytics database retains for their history.
  const loadCatalog = async (source: B2cNetworkSource): Promise<NetworkDefinition[]> =>
    mergeCatalog(await source.load(), ingest === null ? [] : await ingest.chains());
  if (networks !== null) {
    setNetworks(await loadCatalog(networks));
  }
  // Token copies of the analytics database, retained ones included, for the token policy.
  const loadTokens = async (): Promise<void> => {
    if (ingest !== null) {
      setTokens(await ingest.tokens());
    }
  };
  await loadTokens();

  let loadedAt: Date | null = null;
  const refreshLive = async (): Promise<void> => {
    if (ingest !== null) {
      const previous = loadedAt;
      loadedAt = await refreshLiveMetrics(ingest, loadedAt);
      if (loadedAt !== previous) {
        app.log.info({ builtAt: loadedAt?.toISOString() ?? null }, 'live metrics loaded');
      }
    }
  };

  /**
   * Replaces the catalog when it changed. A catalog in which no network would be visible under the
   * current policy is refused and the previous one kept, so the metrics never serve zero networks.
   */
  const applyCatalog = async (definitions: NetworkDefinition[]): Promise<void> => {
    if (
      definitions.length === 0 ||
      JSON.stringify(definitions) === JSON.stringify(listNetworks())
    ) {
      return;
    }
    if (visibleNetworks(definitions, await store.networkVisibility()).length === 0) {
      app.log.error(
        { networks: definitions.map((network) => network.id) },
        'network catalog change refused: no network would be visible'
      );
      return;
    }
    setNetworks(definitions);
    resetFactsCaches();
    app.log.info({ networks: definitions.map((network) => network.id) }, 'network catalog changed');
  };

  const app = await buildApp(env, {
    store,
    ingestion:
      ingest === null || networks === null
        ? null
        : ingestionHandle(
            env,
            networks,
            ingest,
            async () => {
              const readStarted = Date.now();
              await refreshLive();
              const readbackMs = Date.now() - readStarted;
              // A run can retain a network the B2C database dropped; the catalog follows at once.
              try {
                await applyCatalog(await loadCatalog(networks));
                await loadTokens();
                const catalog = listNetworks();
                const visible = visibleNetworks(catalog, await store.networkVisibility()).length;
                app.log.info(
                  {
                    catalogNetworks: catalog.length,
                    catalogRetained: catalog.filter((network) => !network.sourcePresent).length,
                    analyticsEnabled: visible,
                    analyticsDisabled: catalog.length - visible
                  },
                  'network catalog after ingestion'
                );
              } catch (error) {
                app.log.warn({ err: error }, 'network catalog refresh failed');
              }
              return { readbackMs };
            },
            (event) => {
              if (event.status === 'failed') {
                app.log.error(event, 'ingest run');
              } else {
                app.log.info(event, 'ingest run');
              }
            }
          )
  });
  app.log.info({ networks: listNetworks().map((network) => network.id) }, 'network catalog');
  await refreshLive().catch((error: unknown) => {
    app.log.warn({ err: error }, 'live metrics load failed; serving synthetic metrics');
  });
  const liveRefresh =
    ingest === null
      ? null
      : setInterval(() => {
          refreshLive().catch((error: unknown) => {
            app.log.warn({ err: error }, 'live metrics refresh failed');
          });
        }, env.METRICS_REFRESH_SECONDS * 1000);
  liveRefresh?.unref();

  const refresh =
    networks === null
      ? null
      : setInterval(() => {
          loadCatalog(networks)
            .then(applyCatalog)
            .then(loadTokens)
            .catch((error: unknown) => {
              app.log.warn({ err: error }, 'network catalog refresh failed');
            });
        }, NETWORKS_REFRESH_MS);
  refresh?.unref();

  app.addHook('onClose', async () => {
    if (refresh !== null) {
      clearInterval(refresh);
    }
    if (liveRefresh !== null) {
      clearInterval(liveRefresh);
    }
    await ingest?.close();
    await networks?.close();
    await store.close();
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'shutdown failed');
          process.exit(1);
        }
      );
    });
  }

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
