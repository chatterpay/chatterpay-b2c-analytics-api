import { isoDayOf } from '../metrics/calendar.js';
import { type AggregationStats, aggregateActivity } from '../metrics/live.js';
import type { IngestRunStatus } from '../metrics/types.js';
import { type MasterWalletConfig, takeBalanceSnapshot } from './snapshot.js';
import type {
  B2cActivityReader,
  B2cUserRecord,
  BalanceReader,
  BalanceSnapshot,
  CallBudget,
  ChainInfo,
  CountryCombinationCount,
  CountryCount,
  DailyPrice,
  IngestedUser,
  IngestRepository,
  PriceProvider,
  SnapshotNetwork,
  TokenInfo,
  TransactionCursor,
  WalletObservation
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
  /** Ceiling on balance requests (`eth_call` and Koios) in one run; zero disables snapshots. */
  maxBalanceCallsPerRun: number;
  /** Time after which no new batch or balance request is started; the run then saves and returns. */
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
  /** `null` when no balance snapshots are taken. */
  balances: BalanceReader | null;
  /** Configured signers whose balances the snapshot reads. */
  masterWallets: readonly MasterWalletConfig[];
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
    users: {
      read: number;
      /** Wallets of every network seen for the first time by this run. */
      newWallets: number;
      /** Users with a wallet on a catalog network, counted per country. */
      countedInCountries: number;
    };
    catalog: {
      tokens: number;
      networks: number;
      /** Tokens the B2C database no longer lists, kept because copied rows still use them. */
      retainedTokens: number;
      /** Networks the B2C database no longer lists, kept because copied rows still use them. */
      retainedNetworks: number;
    };
    prices: {
      provider: string | null;
      calls: number;
      prices: number;
      /** The provider request failed; valuation uses swap-implied and earlier prices. */
      failed: boolean;
    };
    balances: {
      status: IngestRunStatus['sources']['balances'];
      /** Requests sent (`eth_call` batches and Koios pages). */
      calls: number;
      failedCalls: number;
      networks: SnapshotNetwork[];
      masterWallets: number;
    };
  };
  /** Counters of the aggregate build; `null` when the run did not build. */
  aggregates: (AggregationStats & { builtAt: string }) | null;
}

const HOUR_MS = 3_600_000;

/** Key of a wallet in the observations: chain id and address, EVM addresses in lower case. */
function observationKey(chainId: string, address: string): string {
  return `${chainId}|${address.startsWith('0x') ? address.toLowerCase() : address}`;
}

/**
 * Counts users per country: per catalog network of their wallets, once across all of them, and
 * per set of networks of their wallets, which lets a subset of the networks count each user once.
 * Users without a wallet on a catalog network are not counted.
 */
function countCountries(
  users: readonly B2cUserRecord[],
  chains: readonly ChainInfo[]
): {
  rows: CountryCount[];
  combinations: CountryCombinationCount[];
  counted: number;
} {
  const networkOf = new Map(chains.map((chain) => [chain.chainId, chain.network]));
  const counts = new Map<string, CountryCount>();
  const add = (network: string | null, country: string): void => {
    const key = `${network ?? ''}|${country}`;
    const row = counts.get(key) ?? { network, country, users: 0 };
    row.users += 1;
    counts.set(key, row);
  };
  const combinations = new Map<string, CountryCombinationCount>();
  let counted = 0;
  for (const user of users) {
    const networks = new Set(
      user.wallets.flatMap((wallet) => {
        const network = networkOf.get(wallet.chainId);
        return network === undefined ? [] : [network];
      })
    );
    if (networks.size === 0) {
      continue;
    }
    counted += 1;
    add(null, user.country);
    for (const network of networks) {
      add(network, user.country);
    }
    const sorted = [...networks].sort();
    const key = `${sorted.join(',')}|${user.country}`;
    const row = combinations.get(key) ?? { networks: sorted, country: user.country, users: 0 };
    row.users += 1;
    combinations.set(key, row);
  }
  return { rows: [...counts.values()], combinations: [...combinations.values()], counted };
}

/** Copy of a user without the country, the only fields the analytics database keeps. */
function stripped(user: B2cUserRecord): IngestedUser {
  return { id: user.id, createdAt: user.createdAt, wallets: user.wallets };
}

/**
 * Symbols the price provider is asked for, all in one request: non-stable tokens and the native
 * coin of the signers (ADA is a token of the list; EVM coins are not).
 */
function pricedSymbols(
  tokens: readonly TokenInfo[],
  masterWallets: readonly MasterWalletConfig[]
): string[] {
  return [
    ...new Set([
      ...tokens.filter((token) => !token.stable).map((token) => token.symbol),
      ...masterWallets
        .filter((wallet) => wallet.address.startsWith('0x'))
        .map((wallet) => wallet.nativeSymbol ?? 'ETH')
    ])
  ];
}

/**
 * Runs one ingestion of the B2C activity into the analytics database.
 *
 * 1. Takes the run lock, so retries of the scheduler never overlap.
 * 2. Copies B2C transactions with an id above the checkpoint, in batches, saving the checkpoint
 *    after each batch; copies are keyed by the B2C id, so a repeated read never duplicates a row.
 * 3. Reads again the rows inserted in the last `revisitHours` up to the checkpoint, to pick up
 *    status changes.
 * 4. Replaces the copies of the users (id, signup date, wallets), the tokens and the networks,
 *    whatever their B2C `enabled` (networks and tokens the B2C database dropped are kept while
 *    copied rows use them), counts users per country of their phone number, and records the
 *    wallets seen for the first time.
 * 5. Requests at most one provider price snapshot per UTC day, within `maxProviderCallsPerRun`.
 * 6. Reads the balances of the user and master wallets, within `maxBalanceCallsPerRun`, and stores
 *    the run snapshot (balance sums and country counts).
 * 7. Rebuilds every aggregate from the copies and records the status of the run.
 *
 * Steps 2 and 3 stop starting batches at `maxTransactionsPerRun` rows or `maxRunMs`; the run then
 * reports `partial` and the next one continues from the checkpoint. Steps 5 and 6 are the only
 * calls to external APIs; a failed request lowers the coverage of the snapshot instead of failing
 * the run.
 *
 * @param deps - Reader, repository, providers, clock and limits.
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
      users: { read: 0, newWallets: 0, countedInCountries: 0 },
      catalog: { tokens: 0, networks: 0, retainedTokens: 0, retainedNetworks: 0 },
      prices: { provider: deps.prices?.name ?? null, calls: 0, prices: 0, failed: false },
      balances: { status: 'disabled', calls: 0, failedCalls: 0, networks: [], masterWallets: 0 }
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
    const copies = users.map(stripped);
    await repository.replaceUsers(copies, startedAt);
    report.sources.users.read = users.length;

    const [tokens, chains] = await Promise.all([reader.tokens(), reader.chains()]);
    const retained = await repository.replaceCatalog(tokens, chains, startedAt);
    report.sources.catalog = {
      tokens: tokens.length,
      networks: chains.length,
      retainedTokens: retained.tokens,
      retainedNetworks: retained.networks
    };

    const countries = countCountries(users, chains);
    report.sources.users.countedInCountries = countries.counted;

    // Wallets of every network are observed, so a network added to the catalog later already has
    // the first observation of its wallets.
    const known = new Set(
      (await repository.walletObservations()).map((item) =>
        observationKey(item.chainId, item.address)
      )
    );
    const trackingSince = checkpoints.walletsTrackingSince;
    const observations: WalletObservation[] = [];
    for (const user of copies) {
      for (const wallet of user.wallets) {
        const key = observationKey(wallet.chainId, wallet.address);
        if (!known.has(key)) {
          known.add(key);
          observations.push({
            chainId: wallet.chainId,
            address: key.slice(wallet.chainId.length + 1),
            firstObservedAt: startedAt,
            bounded: trackingSince !== null
          });
        }
      }
    }
    await repository.addWalletObservations(observations);
    report.sources.users.newWallets = observations.length;
    if (trackingSince === null) {
      await repository.saveCheckpoints({ walletsTrackingSince: startedAt });
    }

    const today = isoDayOf(Math.floor(startedAt.getTime() / (24 * HOUR_MS)));
    let pricesStatus: IngestRunStatus['sources']['prices'] =
      deps.prices === null || options.maxProviderCallsPerRun <= 0 ? 'disabled' : 'skipped';
    if (
      deps.prices !== null &&
      options.maxProviderCallsPerRun > 0 &&
      checkpoints.pricesLastDay !== today
    ) {
      const symbols = pricedSymbols(tokens, deps.masterWallets);
      // The day is marked before the request, so a failing provider is asked once a day at most.
      await repository.saveCheckpoints({ pricesLastDay: today });
      pricesStatus = 'complete';
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
          pricesStatus = 'failed';
        }
      }
    }

    let balances: BalanceSnapshot | null = null;
    if (deps.balances !== null && options.maxBalanceCallsPerRun > 0) {
      const callBudget: CallBudget = {
        remaining: options.maxBalanceCallsPerRun,
        deadline,
        used: 0,
        failed: 0
      };
      // Only prices of the snapshot day: an older price would value today's balances with a
      // price of another moment.
      const dayPrices = new Map(
        (await repository.prices())
          .filter((price) => price.day === today && price.source === 'provider')
          .map((price) => [price.symbol, price.usd])
      );
      const result = await takeBalanceSnapshot({
        reader: deps.balances,
        endpoints: await reader.endpoints(),
        chains,
        tokens,
        users: copies,
        masterWallets: deps.masterWallets,
        prices: dayPrices,
        budget: callBudget
      });
      balances = result.snapshot;
      report.sources.balances = {
        status: result.status,
        calls: callBudget.used,
        failedCalls: callBudget.failed,
        networks: result.snapshot.networks,
        masterWallets: result.snapshot.masterWallets.length
      };
    }
    await repository.saveSnapshot({
      takenAt: startedAt,
      balances,
      countries: countries.rows,
      countryCombinations: countries.combinations
    });

    const [transactions, storedUsers, storedTokens, storedChains, prices, seen] = await Promise.all(
      [
        repository.transactions(),
        repository.users(),
        repository.tokens(),
        repository.chains(),
        repository.prices(),
        repository.walletObservations()
      ]
    );
    const { aggregates, stats } = aggregateActivity({
      transactions,
      users: storedUsers,
      tokens: storedTokens,
      chains: new Map(storedChains.map((chain) => [chain.chainId, chain.network])),
      prices,
      observations: seen
    });
    const builtAt = deps.clock();
    report.status = stopped ? 'partial' : 'completed';
    await repository.saveAggregates(aggregates, builtAt, {
      status: report.status,
      finishedAt: builtAt.toISOString(),
      sources: {
        transactions: stopped ? 'partial' : 'complete',
        prices: pricesStatus,
        balances: report.sources.balances.status
      }
    });
    report.aggregates = { ...stats, builtAt: builtAt.toISOString() };
    return finish();
  } finally {
    await repository.releaseLock(deps.owner);
  }
}
