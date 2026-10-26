import type { AggregationStats } from '../metrics/live.js';
import type { UsdValuation } from '../metrics/types.js';
import type { IngestionPhases, IngestionReport } from './run.js';

/**
 * Structured log line of one ingestion run. It carries counters, statuses and durations only: no
 * endpoint URL, connection string, credential, phone number, wallet address or per-person figure.
 * Each network row says whether an endpoint exists (`endpointPresent`), never which one.
 */
export interface IngestRunEvent {
  event: 'ingest_run';
  runId: string;
  /** `failed` when the run threw; the other values are those of the report. */
  status: IngestionReport['status'] | 'failed';
  startedAt: string;
  durationMs: number;
  /** End of the aggregate build; `null` when the run built none. */
  builtAt: string | null;
  valuation: UsdValuation | null;
  /**
   * Phases of the run plus `readback`: the load of the new build into this instance after the
   * run; `null` when it did not happen.
   */
  phasesMs: (IngestionPhases & { readback: number | null }) | null;
  transactions: { read: number; revisited: number } | null;
  users: IngestionReport['sources']['users'] | null;
  catalog: IngestionReport['sources']['catalog'] | null;
  prices: IngestionReport['sources']['prices'] | null;
  balances: {
    status: IngestionReport['sources']['balances']['status'];
    calls: number;
    failedCalls: number;
    masterWallets: number;
    networks: Array<
      Pick<
        IngestionReport['sources']['balances']['networks'][number],
        | 'network'
        | 'chainId'
        | 'status'
        | 'reason'
        | 'b2cEnabled'
        | 'analyticsVisible'
        | 'collectBalances'
        | 'endpointPresent'
        | 'attempted'
        | 'wallets'
        | 'walletsRead'
        | 'calls'
        | 'failedCalls'
        | 'native'
        | 'unpricedAssets'
        | 'startedAt'
        | 'finishedAt'
        | 'durationMs'
        | 'takenAt'
        | 'lastSuccessAt'
      >
    >;
  } | null;
  aggregates: AggregationStats | null;
  /** Class of the error of a failed run; never its message, which may quote a URL. */
  error: string | null;
}

/**
 * Builds the log line of a finished run from its report.
 *
 * @param report - Report of the run.
 * @param readbackMs - Time to load the new build into the instance; `null` when not loaded.
 * @returns The event.
 */
export function ingestRunEvent(report: IngestionReport, readbackMs: number | null): IngestRunEvent {
  const { sources } = report;
  const stats = report.aggregates;
  return {
    event: 'ingest_run',
    runId: report.runId,
    status: report.status,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    builtAt: stats?.builtAt ?? null,
    valuation: report.valuation,
    phasesMs: { ...report.phasesMs, readback: readbackMs },
    transactions: { read: sources.transactions.read, revisited: sources.transactions.revisited },
    users: { ...sources.users },
    catalog: { ...sources.catalog },
    prices: { ...sources.prices },
    balances: {
      status: sources.balances.status,
      calls: sources.balances.calls,
      failedCalls: sources.balances.failedCalls,
      masterWallets: sources.balances.masterWallets,
      networks: sources.balances.networks.map((row) => ({
        network: row.network,
        chainId: row.chainId,
        status: row.status,
        reason: row.reason,
        b2cEnabled: row.b2cEnabled,
        analyticsVisible: row.analyticsVisible,
        collectBalances: row.collectBalances,
        endpointPresent: row.endpointPresent,
        attempted: row.attempted,
        wallets: row.wallets,
        walletsRead: row.walletsRead,
        calls: row.calls,
        failedCalls: row.failedCalls,
        native: row.native,
        unpricedAssets: row.unpricedAssets,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        takenAt: row.takenAt,
        lastSuccessAt: row.lastSuccessAt
      }))
    },
    aggregates:
      stats === null
        ? null
        : {
            transfers: stats.transfers,
            swaps: stats.swaps,
            unpriced: stats.unpriced,
            unpricedFees: stats.unpricedFees,
            unverifiedSwaps: stats.unverifiedSwaps,
            outsideCatalog: stats.outsideCatalog,
            users: stats.users,
            undatedUsers: stats.undatedUsers,
            wallets: stats.wallets,
            verifiedWallets: stats.verifiedWallets
          },
    error: null
  };
}

/**
 * Builds the log line of a run that threw before returning its report.
 *
 * @param runId - Id of the run.
 * @param startedAt - Instant the run was started.
 * @param durationMs - Time until it threw.
 * @param error - What it threw.
 * @returns The event, with the class of the error only.
 */
export function failedRunEvent(
  runId: string,
  startedAt: Date,
  durationMs: number,
  error: unknown
): IngestRunEvent {
  return {
    event: 'ingest_run',
    runId,
    status: 'failed',
    startedAt: startedAt.toISOString(),
    durationMs,
    builtAt: null,
    valuation: null,
    phasesMs: null,
    transactions: null,
    users: null,
    catalog: null,
    prices: null,
    balances: null,
    aggregates: null,
    error: error instanceof Error ? error.name : typeof error
  };
}
