import { isoDayOf } from '../metrics/calendar.js';
import { type AggregationStats, aggregateActivity } from '../metrics/live.js';
import type {
  B2cActivityReader,
  DailyPrice,
  IngestRepository,
  PriceProvider,
  TransactionCursor
} from './types.js';

/** Limits of one ingestion run. */
export interface IngestionOptions {
  /** Rows read from the B2C `transactions` collection per batch. */
  batchSize: number;
  /** Ceiling on B2C transaction rows read in one run, new and revisited together. */
  maxTransactionsPerRun: number;
  /**
   * Rows inserted this many hours before the run are read again, because the backend updates the
   * status of some rows after inserting them (Polymarket orders). Zero disables the revisit.
   */
  revisitHours: number;
  /** Ceiling on price provider requests in one run; zero disables the provider. */
  maxProviderCallsPerRun: number;
  /** Time after which no new batch is started; the run then saves and returns. */
  maxRunMs: number;
  /** Lifetime of the run lock; longer than `maxRunMs`, so a crashed run frees it on its own. */
  lockTtlMs: number;
}

/** Dependencies of {@link runIngestion}. */
export interface IngestionDependencies {
  reader: B2cActivityReader;
  repository: IngestRepository;
  /** `null` when no price provider is configured. */
  prices: PriceProvider | null;
  clock: () => Date;
  options: IngestionOptions;
  /** Lock owner, unique per run. */
  owner: string;
}

/** Summary of one ingestion run, returned by the ingestion endpoint. */
export interface IngestionReport {
  /**
   * `completed`: every pending row was read and the aggregates were rebuilt. `partial`: a limit
   * stopped the run; the checkpoint is saved, the aggregates were rebuilt with what was read, and
   * the next run continues. `locked`: another run holds the lock and nothing was done.
   */
  status: 'completed' | 'partial' | 'locked';
  startedAt: string;
  durationMs: number;
  sources: {
    transactions: {
      read: number;
      revisited: number;
      /** Checkpoint after the run. */
      lastId: string | null;
    };
    users: { read: number };
    catalog: { tokens: number; networks: number };
    prices: {
      provider: string | null;
      calls: number;
      prices: number;
      /** The provider request failed; valuation uses swap-implied and earlier prices. */
      failed: boolean;
    };
  };
  /** Counters of the aggregate build; `null` when the run did not build. */
  aggregates: (AggregationStats & { builtAt: string }) | null;
}

const HOUR_MS = 3_600_000;

/**
 * Runs one ingestion of the B2C activity into the analytics database.
 *
 * 1. Takes the run lock, so retries of the scheduler never overlap.
 * 2. Copies B2C transactions with an id above the checkpoint, in batches, saving the checkpoint
 *    after each batch; copies are keyed by the B2C id, so a repeated read never duplicates a row.
 * 3. Reads again the rows inserted in the last `revisitHours` up to the checkpoint, to pick up
 *    status changes.
 * 4. Replaces the copies of the users (id, signup date, wallets), the tokens and the networks.
 * 5. Requests at most one provider price snapshot per UTC day, within `maxProviderCallsPerRun`.
 * 6. Rebuilds every aggregate from the copies.
 *
 * Steps 2 and 3 stop starting batches at `maxTransactionsPerRun` rows or `maxRunMs`; the run then
 * reports `partial` and the next one continues from the checkpoint. Only step 5 calls an external
 * API; the rest reads MongoDB.
 *
 * @param deps - Reader, repository, provider, clock and limits.
 * @returns The summary of the run.
 */
export async function runIngestion(deps: IngestionDependencies): Promise<IngestionReport> {
  const { reader, repository, options } = deps;
  const startedAt = deps.clock();
  const deadline = startedAt.getTime() + options.maxRunMs;
  const report: IngestionReport = {
    status: 'locked',
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    sources: {
      transactions: { read: 0, revisited: 0, lastId: null },
      users: { read: 0 },
      catalog: { tokens: 0, networks: 0 },
      prices: { provider: deps.prices?.name ?? null, calls: 0, prices: 0, failed: false }
    },
    aggregates: null
  };
  const finish = (): IngestionReport => {
    report.durationMs = deps.clock().getTime() - startedAt.getTime();
    return report;
  };
  if (!(await repository.acquireLock(deps.owner, startedAt, options.lockTtlMs))) {
    return finish();
  }

  try {
    const checkpoints = await repository.readCheckpoints();
    let budget = options.maxTransactionsPerRun;
    let stopped = false;
    const copy = async (
      cursor: TransactionCursor,
      onBatch: (lastId: string) => Promise<void>
    ): Promise<number> => {
      let read = 0;
      let afterId = cursor.afterId;
      for (;;) {
        if (budget <= 0 || deps.clock().getTime() >= deadline) {
          stopped = true;
          break;
        }
        const limit = Math.min(options.batchSize, budget);
        const batch = await reader.transactions({ ...cursor, afterId }, limit);
        const last = batch.at(-1);
        if (last === undefined) {
          break;
        }
        await repository.upsertTransactions(batch);
        await onBatch(last.id);
        afterId = last.id;
        read += batch.length;
        budget -= batch.length;
        if (batch.length < limit) {
          break;
        }
      }
      return read;
    };

    const checkpoint = checkpoints.transactionsLastId;
    report.sources.transactions.lastId = checkpoint;
    report.sources.transactions.read = await copy(
      { afterId: checkpoint, since: null, untilId: null },
      async (id) => {
        report.sources.transactions.lastId = id;
        await repository.saveCheckpoints({ transactionsLastId: id });
      }
    );

    if (options.revisitHours > 0 && checkpoint !== null && !stopped) {
      report.sources.transactions.revisited = await copy(
        {
          afterId: null,
          since: new Date(startedAt.getTime() - options.revisitHours * HOUR_MS),
          untilId: checkpoint
        },
        async () => {}
      );
    }

    const users = await reader.users();
    await repository.replaceUsers(users, startedAt);
    report.sources.users.read = users.length;

    const [tokens, chains] = await Promise.all([reader.tokens(), reader.chains()]);
    await repository.replaceCatalog(tokens, chains);
    report.sources.catalog = { tokens: tokens.length, networks: chains.length };

    const today = isoDayOf(Math.floor(startedAt.getTime() / (24 * HOUR_MS)));
    if (
      deps.prices !== null &&
      options.maxProviderCallsPerRun > 0 &&
      checkpoints.pricesLastDay !== today
    ) {
      const symbols = [
        ...new Set(tokens.filter((token) => !token.stable).map((token) => token.symbol))
      ];
      // The day is marked before the request, so a failing provider is asked once a day at most.
      await repository.saveCheckpoints({ pricesLastDay: today });
      if (symbols.length > 0) {
        report.sources.prices.calls += 1;
        try {
          const quoted = await deps.prices.current(symbols);
          const snapshot: DailyPrice[] = Object.entries(quoted).map(([symbol, usd]) => ({
            symbol,
            day: today,
            usd,
            source: 'provider'
          }));
          await repository.savePrices(snapshot);
          report.sources.prices.prices = snapshot.length;
        } catch {
          report.sources.prices.failed = true;
        }
      }
    }

    const [transactions, storedUsers, storedTokens, storedChains, prices] = await Promise.all([
      repository.transactions(),
      repository.users(),
      repository.tokens(),
      repository.chains(),
      repository.prices()
    ]);
    const { aggregates, stats } = aggregateActivity({
      transactions,
      users: storedUsers,
      tokens: storedTokens,
      chains: new Map(storedChains.map((chain) => [chain.chainId, chain.network])),
      prices
    });
    const builtAt = deps.clock();
    await repository.saveAggregates(aggregates, builtAt);
    report.aggregates = { ...stats, builtAt: builtAt.toISOString() };
    report.status = stopped ? 'partial' : 'completed';
    return finish();
  } finally {
    await repository.releaseLock(deps.owner);
  }
}
