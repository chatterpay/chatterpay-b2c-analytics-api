import type { NetworkFamily, NetworkId } from '../metrics/catalog.js';
import type {
  IngestRunStatus,
  NativeCoverage,
  NetworkReadReason,
  NetworkReadStatus,
  UsdValuation
} from '../metrics/types.js';

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

/**
 * B2C user as read by the ingestion: the copied fields plus the country of the phone number. The
 * country is only counted; neither it nor the number is stored per user.
 */
export interface B2cUserRecord extends IngestedUser {
  /** ISO 3166-1 alpha-2 code, or `Unknown` when the number gives no single country. */
  country: string;
}

/** Token of the B2C `tokens` collection. */
export interface TokenInfo {
  chainId: string;
  symbol: string;
  /** `type: 'stable'` in the collection; stable tokens are valued at 1 USD. */
  stable: boolean;
  /**
   * Contract address on EVM networks; `policyId + assetName` in hex, or `cardano:...` for ADA, on
   * Cardano networks. Empty when the document has none.
   */
  address: string;
  /** Decimals of the token; `null` when the document has none, which leaves it out of snapshots. */
  decimals: number | null;
}

/**
 * Endpoint the ingestion reads balances through: the `rpc` of an EVM network, the `providerUrl`
 * of a Cardano network. Read from the B2C `blockchains` collection on every run and never stored,
 * because the URL can carry a provider key.
 */
export interface ChainEndpoint {
  chainId: string;
  family: 'evm' | 'cardano';
  url: string;
}

/** Network of the B2C `blockchains` collection, with its public contract addresses. */
export interface ChainInfo {
  chainId: string;
  /** Network id of the catalog (slug of the name). */
  network: string;
  name: string;
  family: NetworkFamily;
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
  /**
   * Start of the first run that recorded wallet observations; `null` before it. Wallets seen in
   * that run may be older than it, so only wallets that appear in later runs are dated by the run.
   */
  walletsTrackingSince: Date | null;
}

/** First ingestion run that saw a wallet in the B2C users. */
export interface WalletObservation {
  chainId: string;
  /** Lower case for EVM addresses, as stored for Cardano ones. */
  address: string;
  firstObservedAt: Date;
  /**
   * `true` when an earlier run had already looked and not found the wallet, so it appeared between
   * that run and `firstObservedAt`. `false` for wallets seen by the first tracking run.
   */
  bounded: boolean;
}

/** Balance of one asset summed over the user wallets of a network, in a snapshot. */
export interface SnapshotHolding {
  network: NetworkId;
  asset: string;
  /** Units of the asset, as a decimal string. */
  amount: string;
  /** USD cents at the price of the snapshot day; `null` when the asset had no price that day. */
  valueCents: number | null;
}

/**
 * Read of the user wallets of one network in a snapshot. The optional fields are absent in
 * snapshots stored before they were recorded.
 */
export interface SnapshotNetwork {
  network: NetworkId;
  status: NetworkReadStatus;
  wallets: number;
  walletsRead: number;
  /** Balance requests sent for the network (`eth_call` batches or Koios pages). */
  calls?: number;
  /** Of those, the requests that failed. */
  failedCalls?: number;
  /**
   * B2C `enabled` of the network at the run; `null` when the document has no boolean `enabled` or
   * the B2C database no longer lists the network.
   */
  b2cEnabled?: boolean | null;
  /** Why the network was not read, or not completely; `null` when it was read in full. */
  reason?: NetworkReadReason | null;
  /**
   * Whether the user wallets were read with the native coin. Absent in snapshots stored before it
   * was recorded, when EVM user wallets were read without it.
   */
  native?: NativeCoverage;
}

/** Balances of one configured master wallet in a snapshot. */
export interface MasterWalletReading {
  network: NetworkId;
  role: string;
  address: string;
  explorerUrl: string | null;
  status: 'complete' | 'failed' | 'unsupported';
  balances: Array<{ asset: string; amount: string; valueCents: number | null }>;
}

/** Balances read in one ingestion run. Per-wallet balances are summed, not stored. */
export interface BalanceSnapshot {
  networks: SnapshotNetwork[];
  holdings: SnapshotHolding[];
  masterWallets: MasterWalletReading[];
  /**
   * `none` when the run valued nothing (every `valueCents` is `null`); absent in snapshots stored
   * before it was recorded, which valued at market.
   */
  valuation?: UsdValuation;
}

/**
 * Users per country at an ingestion run. `network` `null` counts each user once across the
 * networks of the catalog; a network row counts the users with a wallet on it.
 */
export interface CountryCount {
  network: NetworkId | null;
  country: string;
  users: number;
}

/**
 * Users per country and set of catalog networks of their wallets at an ingestion run. Each counted
 * user is in exactly one row, so the users of any subset of the networks, each counted once, are
 * the sum of the rows whose networks meet the subset.
 */
export interface CountryCombinationCount {
  /** Networks of the user's wallets, sorted. */
  networks: NetworkId[];
  country: string;
  users: number;
}

/** What one ingestion run observed at its start: balances and users per country. */
export interface RunSnapshot {
  takenAt: Date;
  /** `null` when the run took no balance snapshot (`BALANCES_PROVIDER=none` or no budget). */
  balances: BalanceSnapshot | null;
  countries: CountryCount[];
  /** Absent in snapshots stored before the combinations were counted. */
  countryCombinations?: CountryCombinationCount[];
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
  /** Every user, with the projected fields only and the country of the phone number. */
  users(): Promise<B2cUserRecord[]>;
  tokens(): Promise<TokenInfo[]>;
  /** Networks the catalog accepts, with their chain ids. */
  chains(): Promise<ChainInfo[]>;
  /** Balance endpoints of the networks the catalog accepts; networks without one are absent. */
  endpoints(): Promise<ChainEndpoint[]>;
  /**
   * B2C `enabled` of the networks the catalog accepts, by chain id; `null` when the document has
   * no boolean `enabled`. Networks the B2C database does not list are absent.
   */
  b2cEnabled(): Promise<Map<string, boolean | null>>;
}

/**
 * Counted operations whose amount or fee had no USD value, per money figure and asset. A fee of
 * zero is valued at zero and never counted here.
 */
export interface UnpricedOperations {
  transferVolume: Record<string, number>;
  swapVolume: Record<string, number>;
  transferFees: Record<string, number>;
  swapFees: Record<string, number>;
}

/** Additive activity of one network in one UTC hour. Money in USD cents per asset. */
export interface HourlyFacts {
  network: string;
  /** Hours since 1970-01-01T00:00Z. */
  hour: number;
  newUsers: number;
  /** Wallets whose first verifiable appearance falls in the hour. */
  newWallets: number;
  transfers: number;
  swaps: number;
  transferVolume: Record<string, number>;
  swapVolume: Record<string, number>;
  transferFees: Record<string, number>;
  swapFees: Record<string, number>;
  /**
   * Operations of the hour left out of the money figures for lack of a USD value. Absent in builds
   * stored before it was recorded, which valued those operations at zero.
   */
  unpriced?: UnpricedOperations;
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

/** Wallets of a network in the user copy and how many have a verifiable first appearance. */
export interface NetworkWallets {
  network: NetworkId;
  wallets: number;
  verified: number;
}

/** Aggregates the metrics endpoints read. */
export interface LiveAggregates {
  hourly: HourlyFacts[];
  activity: UserActivity[];
  signups: UserSignup[];
  wallets: NetworkWallets[];
}

/** Aggregates with the instant they were built and what the endpoints read with them. */
export interface StoredAggregates extends LiveAggregates {
  builtAt: Date;
  /** Status of the run that built them; `null` for builds stored before it was recorded. */
  run: IngestRunStatus | null;
  walletsTrackingSince: Date | null;
  /** Every run snapshot, ascending by `takenAt`. */
  snapshots: RunSnapshot[];
}

/** Copies kept by {@link IngestRepository.replaceCatalog} although the B2C database dropped them. */
export interface CatalogRetention {
  networks: number;
  tokens: number;
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
  /**
   * Replaces the copies of the token list and the networks with what the B2C database lists now,
   * stamping them with `now`. A network or token the B2C database no longer lists is kept, marked
   * as absent from the source, while copied rows still use it: a copied transaction, user wallet or
   * wallet observation on the network, or a copied transaction on the chain in the token's symbol
   * (any case). The others are removed.
   *
   * @returns How many networks and tokens absent from the source were kept.
   */
  replaceCatalog(
    tokens: readonly TokenInfo[],
    chains: readonly ChainInfo[],
    now: Date
  ): Promise<CatalogRetention>;
  savePrices(items: readonly DailyPrice[]): Promise<void>;
  /** Stores the snapshot of a run, keyed by `takenAt`, so a repeated write replaces it. */
  saveSnapshot(snapshot: RunSnapshot): Promise<void>;
  /** Wallet observations of every earlier run. */
  walletObservations(): Promise<WalletObservation[]>;
  /** Adds observations of wallets not seen before; known wallets keep their first observation. */
  addWalletObservations(items: readonly WalletObservation[]): Promise<void>;
  transactions(): Promise<IngestedTransaction[]>;
  users(): Promise<IngestedUser[]>;
  tokens(): Promise<TokenInfo[]>;
  chains(): Promise<ChainInfo[]>;
  prices(): Promise<DailyPrice[]>;
  /** Replaces every aggregate and records `builtAt` with the status of the run. */
  saveAggregates(aggregates: LiveAggregates, builtAt: Date, run: IngestRunStatus): Promise<void>;
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

/** Shared limits of the balance reads of one run. */
export interface CallBudget {
  /** Provider requests left. */
  remaining: number;
  /** Epoch milliseconds after which no request starts. */
  deadline: number;
  /** Requests sent so far. */
  used: number;
  /** Requests that failed (HTTP, timeout, RPC or decoding error). */
  failed: number;
}

/** One balance to read on an EVM network: an ERC-20 balance, or the native one when `token` is `null`. */
export interface EvmBalanceQuery {
  holder: string;
  token: string | null;
}

/** Balances of a Cardano address: lovelace and native assets by unit (`policyId + assetName`). */
export interface CardanoHoldings {
  lovelace: bigint;
  assets: Map<string, bigint>;
}

/** Reads on-chain balances in batches. Every request counts against the budget. */
export interface BalanceReader {
  /**
   * @returns Raw balances aligned with `queries`; `null` for a query that was not read.
   */
  evm(
    url: string,
    queries: readonly EvmBalanceQuery[],
    budget: CallBudget
  ): Promise<Array<bigint | null>>;
  /**
   * @returns Holdings per address; an address absent from the map was not read.
   */
  cardano(
    url: string,
    addresses: readonly string[],
    budget: CallBudget
  ): Promise<Map<string, CardanoHoldings>>;
  /** Whether the reader can read a Cardano endpoint (the Koios dialect). */
  supportsCardano(url: string): boolean;
}
