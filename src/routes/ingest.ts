import type { FastifyInstance } from 'fastify';
import type { IngestCallerVerifier } from '../auth/scheduler-identity.js';
import { ApiError } from '../errors/api-error.js';
import type { IngestionReport } from '../ingest/run.js';
import { arrayOf, errorResponsesFor, object } from './schemas.js';

/** Ingestion wired by the server; absent without MongoDB. */
export interface IngestionHandle {
  /** Runs one ingestion and refreshes the live metrics of this instance. */
  run: () => Promise<IngestionReport>;
  /** Scheduler identity check; `null` when no scheduler service account is configured. */
  verifyCaller: IngestCallerVerifier | null;
  /** Admits any caller; only accepted outside production by the environment validation. */
  devTrigger: boolean;
}

/** Options of {@link ingestRoutes}. */
export interface IngestRoutesOptions {
  ingestion: IngestionHandle | null;
}

const count = { type: 'integer', minimum: 0 } as const;
const nullableString = { type: ['string', 'null'] } as const;

const reportSchema = object({
  status: { type: 'string', enum: ['completed', 'partial', 'locked'] },
  runId: { type: 'string' },
  startedAt: { type: 'string', format: 'date-time' },
  durationMs: count,
  valuation: { type: 'string', enum: ['market', 'none'] },
  phasesMs: object({
    copyTransactions: count,
    revisit: count,
    catalogUsers: count,
    prices: count,
    snapshot: count,
    aggregateRebuild: count,
    persist: count
  }),
  sources: object({
    transactions: object({ read: count, revisited: count, lastId: nullableString }),
    users: object({ read: count, newWallets: count, countedInCountries: count }),
    catalog: object({
      tokens: count,
      networks: count,
      retainedTokens: count,
      retainedNetworks: count
    }),
    prices: object({
      provider: nullableString,
      calls: count,
      prices: count,
      failed: { type: 'boolean' }
    }),
    balances: object({
      status: { type: 'string', enum: ['complete', 'partial', 'failed', 'disabled'] },
      calls: count,
      failedCalls: count,
      networks: arrayOf(
        object({
          network: { type: 'string' },
          status: { type: 'string', enum: ['complete', 'partial', 'failed', 'unsupported'] },
          wallets: count,
          walletsRead: count,
          calls: count,
          failedCalls: count,
          b2cEnabled: { type: ['boolean', 'null'] },
          reason: {
            type: ['string', 'null'],
            enum: [
              'b2c_disabled',
              'source_absent',
              'no_endpoint',
              'unsupported_provider',
              'read_incomplete',
              null
            ]
          },
          native: { type: 'string', enum: ['included', 'not_listed'] },
          takenAt: { type: 'string', format: 'date-time' }
        })
      ),
      masterWallets: count
    })
  }),
  aggregates: {
    anyOf: [
      object({
        transfers: count,
        swaps: count,
        unpriced: count,
        unpricedFees: count,
        unverifiedSwaps: count,
        outsideCatalog: count,
        users: count,
        undatedUsers: count,
        wallets: count,
        verifiedWallets: count,
        builtAt: { type: 'string', format: 'date-time' }
      }),
      { type: 'null' }
    ]
  }
});

/**
 * Registers `POST /ingest` under the plugin prefix: one ingestion run, meant for Cloud Scheduler.
 *
 * Admitted callers are the scheduler service account (see `googleServiceAccountVerifier`) or,
 * with the development trigger on, anyone. Sessions and the site never pass. Without MongoDB or
 * without an admitted caller configured it answers 503. A run that finds the lock taken answers
 * 200 with `status: locked`, so a scheduler retry does not start a second run.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Ingestion handle.
 */
export async function ingestRoutes(
  app: FastifyInstance,
  options: IngestRoutesOptions
): Promise<void> {
  app.post(
    '/ingest',
    {
      schema: {
        operationId: 'runIngestion',
        summary: 'Ingests the B2C activity into the analytics database (Cloud Scheduler only)',
        tags: ['internal'],
        response: { 200: reportSchema, ...errorResponsesFor([401, 503]) }
      }
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const ingestion = options.ingestion;
      if (ingestion === null || (!ingestion.devTrigger && ingestion.verifyCaller === null)) {
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Ingestion is not configured');
      }
      if (!ingestion.devTrigger && !(await ingestion.verifyCaller?.(request))) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      }
      return ingestion.run();
    }
  );
}
