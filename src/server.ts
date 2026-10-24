import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { listNetworks, setNetworks } from './metrics/catalog.js';
import { resetFactsCaches } from './metrics/facts.js';
import { B2cNetworkSource } from './store/b2c-networks.js';
import { MemoryStore } from './store/memory-store.js';
import { MongoStore } from './store/mongo-store.js';
import type { Store } from './store/types.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
/** Interval between reads of the B2C networks, so a network added there shows up without a deploy. */
const NETWORKS_REFRESH_MS = 5 * 60 * 1000;

/**
 * Process entry point: validates the environment, connects the store, loads the networks of the
 * B2C database, starts listening and closes gracefully on SIGINT/SIGTERM (Cloud Run sends SIGTERM
 * before stopping an instance).
 *
 * With Mongo configured, the first read of the networks must succeed or the process does not
 * start. Later reads that fail keep the previous catalog.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const store: Store =
    env.MONGO_URI === null
      ? new MemoryStore()
      : await MongoStore.connect({ uri: env.MONGO_URI, dbName: env.MONGO_DB_NAME });
  const b2cUri = env.B2C_MONGO_URI ?? env.MONGO_URI;
  const networks =
    b2cUri === null
      ? null
      : await B2cNetworkSource.connect({ uri: b2cUri, dbName: env.B2C_MONGO_DB_NAME });
  if (networks !== null) {
    setNetworks(await networks.load());
  }

  const app = await buildApp(env, { store });
  app.log.info({ networks: listNetworks().map((network) => network.id) }, 'network catalog');

  const refresh =
    networks === null
      ? null
      : setInterval(() => {
          networks.load().then(
            (definitions) => {
              const current = JSON.stringify(listNetworks());
              if (definitions.length > 0 && JSON.stringify(definitions) !== current) {
                setNetworks(definitions);
                resetFactsCaches();
                app.log.info(
                  { networks: definitions.map((network) => network.id) },
                  'network catalog changed'
                );
              }
            },
            (error: unknown) => {
              app.log.warn({ err: error }, 'network catalog refresh failed');
            }
          );
        }, NETWORKS_REFRESH_MS);
  refresh?.unref();

  app.addHook('onClose', async () => {
    if (refresh !== null) {
      clearInterval(refresh);
    }
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
