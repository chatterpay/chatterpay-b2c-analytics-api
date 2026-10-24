/**
 * Row of the B2C `transactions` collection, as copied into the analytics database. Every type and
 * status is copied; the aggregation decides which ones count.
 */
export interface IngestedTransaction {
  /** Hex of the B2C `_id`; ids grow with insertion, which is what the checkpoint relies on. */
  id: string;
  hash: string;
  from: string;
  to: string;
  type: string;
  status: string;
  date: Date;
  /** Amount in token units, as the backend stores it. */
  amount: number;
  /** ChatterPay fee in units of `token`. */
  fee: number;
  token: string;
  /** Decimal string, because Cardano chain ids do not fit in an int32 and arrive as `Long`. */
  chainId: string;
}

/** Wallet of a B2C user. */
export interface IngestedWallet {
  chainId: string;
  address: string;
}

/**
 * B2C user as copied into the analytics database: id, signup date and wallets. Phone numbers,
 * names and emails are not copied.
 */
export interface IngestedUser {
  id: string;
  /** `creationDate` of the user; `null` when the document has none. */
  createdAt: Date | null;
  wallets: IngestedWallet[];
}

/** Token of the B2C `tokens` collection. */
export interface TokenInfo {
  chainId: string;
  symbol: string;
  /** `type: 'stable'` in the collection; stable tokens are valued at 1 USD. */
  stable: boolean;
}

/** Network of the B2C `blockchains` collection, with its public contract addresses. */
export interface ChainInfo {
  chainId: string;
  /** Network id of the catalog (slug of the name). */
  network: string;
  name: string;
  explorer: string;
  /** Contract addresses by role (`paymasterAddress`, `factoryAddress`, ...). */
  contracts: Record<string, string>;
}

/** USD price of a token symbol on one UTC day. */
export interface DailyPrice {
  symbol: string;
  /** `YYYY-MM-DD`. */
  day: string;
  usd: number;
  /** `provider`: a price API snapshot; `swap`: implied by the stable leg of recorded swaps. */
  source: 'provider' | 'swap';
}

/** Checkpoints of the ingestion, one per source, kept in the analytics database. */
export interface IngestCheckpoints {
  /** Highest B2C transaction id copied; `null` before the first run. */
  transactionsLastId: string | null;
  /** Last UTC day (`YYYY-MM-DD`) a provider price snapshot was requested; `null` when never. */
  pricesLastDay: string | null;
}

/** Bounds of a read of B2C transactions, by id. */
export interface TransactionCursor {
  /** Exclusive lower bound. */
  afterId: string | null;
  /** Rows inserted at or after this instant, read from the id timestamp. */
  since: Date | null;
  /** Inclusive upper bound. */
  untilId: string | null;
}

/** Read-only access to the B2C collections the ingestion copies. */
export interface B2cActivityReader {
  /**
   * Transactions inside the cursor, sorted by id ascending.
   *
   * @param cursor - Bounds of the read.
   * @param limit - Maximum rows returned.
   */
  transactions(cursor: TransactionCursor, limit: number): Promise<IngestedTransaction[]>;
  /** Every user, with the projected fields only. */
  users(): Promise<IngestedUser[]>;
  tokens(): Promise<TokenInfo[]>;
  /** Networks the catalog accepts, with their chain ids. */
  chains(): Promise<ChainInfo[]>;
}

/** Additive activity of one network in one UTC hour. Money in USD cents per asset. */
export interface HourlyFacts {
  network: string;
  /** Hours since 1970-01-01T00:00Z. */
  hour: number;
  newUsers: number;
  transfers: number;
  swaps: number;
  transferVolume: Record<string, number>;
  swapVolume: Record<string, number>;
  transferFees: Record<string, number>;
  swapFees: Record<string, number>;
}

/** Hours in which a user started a counted operation on a network, ascending. */
export interface UserActivity {
  network: string;
  /** B2C user id, or `address:<address>` for a sender that is not a known user. */
  user: string;
  hours: number[];
}

/** Signup of a user on a network. */
export interface UserSignup {
  network: string;
  user: string;
  /** Signup hour; `null` when the user has no `creationDate`. */
  hour: number | null;
}

/** Aggregates the metrics endpoints read. */
export interface LiveAggregates {
  hourly: HourlyFacts[];
  activity: UserActivity[];
  signups: UserSignup[];
}

/** Aggregates with the instant they were built. */
export interface StoredAggregates extends LiveAggregates {
  builtAt: Date;
}

/** Analytics-database side of the ingestion. */
export interface IngestRepository {
  readCheckpoints(): Promise<IngestCheckpoints>;
  saveCheckpoints(patch: Partial<IngestCheckpoints>): Promise<void>;
  /**
   * Takes the run lock, so two runs never overlap.
   *
   * @returns `false` when another owner holds an unexpired lock.
   */
  acquireLock(owner: string, now: Date, ttlMs: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  upsertTransactions(items: readonly IngestedTransaction[]): Promise<void>;
  /** Replaces the user copy with `items`; users absent from it are removed. */
  replaceUsers(items: readonly IngestedUser[], now: Date): Promise<void>;
  /** Replaces the copies of the token list and the networks. */
  replaceCatalog(tokens: readonly TokenInfo[], chains: readonly ChainInfo[]): Promise<void>;
  savePrices(items: readonly DailyPrice[]): Promise<void>;
  transactions(): Promise<IngestedTransaction[]>;
  users(): Promise<IngestedUser[]>;
  tokens(): Promise<TokenInfo[]>;
  chains(): Promise<ChainInfo[]>;
  prices(): Promise<DailyPrice[]>;
  /** Replaces every aggregate and records `builtAt`. */
  saveAggregates(aggregates: LiveAggregates, builtAt: Date): Promise<void>;
  /** Instant of the last aggregate build; `null` when none was built. */
  aggregatesBuiltAt(): Promise<Date | null>;
  /** The last built aggregates; `null` when none were built. */
  loadAggregates(): Promise<StoredAggregates | null>;
}

/** Current USD prices from an external API. Each call to `current` is one provider request. */
export interface PriceProvider {
  readonly name: string;
  /**
   * @param symbols - Token symbols to price.
   * @returns USD price per symbol; symbols the provider does not know are absent.
   */
  current(symbols: readonly string[]): Promise<Record<string, number>>;
}
