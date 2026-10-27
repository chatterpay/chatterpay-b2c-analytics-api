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
  /**
   * Polymarket account of the user; `null` or absent when the document has none. Only counted,
   * like the country: neither the address nor the date is stored per user.
   */
  polymarket?: PolymarketAccountRecord | null;
}

/**
 * What the ingestion reads of `users.polymarket_account`: whether `polygon_address` is an EVM
 * address, the address itself and `created_at`. The encrypted API credentials and the signer are
 * never read.
 */
export interface PolymarketAccountRecord {
  validAddress: boolean;
  /**
   * `polygon_address` in lower case when it is an EVM address, else `null`. It is the funder of the
   * account's CLOB orders, the `maker` of their fills; the run uses it to read the fills and never
   * stores it.
   */
  address: string | null;
  /** `null` when the account has no `created_at`. */
  createdAt: Date | null;
}

/**
 * One fill of an order of a ChatterPay Polymarket account, from an `OrderFilled` event of the
 * Polymarket exchanges on Polygon whose `maker` is the account. A fill of an order matched as
 * taker is its own event with the account as `maker`, so every executed fill of an account is one
 * event and none is counted twice. No address is kept.
 */
export interface PolymarketFill {
  /** `transactionHash:logIndex` of the event, in lower case; unique on chain. */
  id: string;
  /** Hour of the block, in hours since 1970-01-01T00:00Z. */
  hour: number;
  side: 'buy' | 'sell';
  /** pUSD paid on a buy or received on a sell, in millionths (6 decimals, 1 pUSD = 1 USD). */
  collateralMicro: number;
  /** Fee Polymarket charged on the fill, in millionths of pUSD; a third-party charge. */
  feeMicro: number;
  /**
   * Whether the order carried a builder code, which lets its builder charge a fee of its own.
   * ChatterPay orders carry none.
   */
  attributed: boolean;
}

/** Fills of the ChatterPay Polymarket accounts in one hour. */
export interface PolymarketHour {
  /** Hours since 1970-01-01T00:00Z. */
  hour: number;
  fills: number;
  /** pUSD paid by buys, in millionths. */
  buyMicro: number;
  /** pUSD received by sells, in millionths. */
  sellMicro: number;
  /** Fees Polymarket charged, in millionths of pUSD. */
  feeMicro: number;
  /** Fills of orders with a builder code. */
  attributed: number;
}

/** Blocks of Polygon whose fills the ingestion has read. */
export interface PolymarketCoverage {
  /** Instant of the first block read; no account of the run could fill an order before it. */
  from: Date;
  /** Instant of the last block read. */
  through: Date;
  /** Whether the last run read up to the confirmed head of the chain. */
  caughtUp: boolean;
}

/** Polymarket fills of a build: per hour, with the blocks they cover. */
export interface PolymarketAggregates {
  hours: PolymarketHour[];
  /** `null` while no run has read any block. */
  coverage: PolymarketCoverage | null;
}

/**
 * Polymarket accounts of the B2C users at an ingestion run. An account is a Polygon wallet outside
 * the networks of the catalog, so the counts cover every user whatever the network filter.
 */
export interface PolymarketAccountCounts {
  /** Users whose account has a valid `polygon_address`. */
  accounts: number;
  /** Users with an account whose `polygon_address` is missing or not an EVM address. */
  invalid: number;
  /** Of `accounts`, the accounts without `created_at`; they are in no creation window. */
  undated: number;
  /** Valid accounts per hour of `created_at`, in hours since 1970-01-01T00:00Z, ascending. */
  createdPerHour: Array<{ hour: number; accounts: number }>;
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
  /**
   * `enabled` of the B2C document: whether B2C takes new operations in the token. Informative
   * only; it plays no part in what is read or shown. `null` when the document has no boolean
   * `enabled`; absent in copies written before it was read.
   */
  b2cEnabled?: boolean | null;
  /**
   * Whether the B2C database listed the token in the last run; `false` for a token kept for its
   * history. Set by the analytics copy only.
   */
  sourcePresent?: boolean;
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
  /** Next Polygon block whose Polymarket fills are read; `null` before the first read. */
  polymarketNextBlock: number | null;
  /** Instant of the first Polygon block read for Polymarket fills; `null` before the first read. */
  polymarketFrom: Date | null;
  /** Instant of the last Polygon block read for Polymarket fills; `null` before the first read. */
  polymarketThrough: Date | null;
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
   * B2C `enabled` of the network at the run, informative only: it says whether B2C takes new
   * operations and plays no part in what is read. `null` when the document has no boolean
   * `enabled` or the B2C database no longer lists the network.
   */
  b2cEnabled?: boolean | null;
  /** Whether the analytics settings let the run read the balances of the network. */
  collectBalances?: boolean;
  /** Whether the run sent, or tried to send within its budget, the balance reads of the network. */
  attempted?: boolean;
  /**
   * Start of the last run, this one included, that read every user wallet of the network; `null`
   * when none did. The date of an observation, never a current balance.
   */
  lastSuccessAt?: Date | null;
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
  /** Absent in snapshots stored before the Polymarket accounts were counted. */
  polymarket?: PolymarketAccountCounts;
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
  /**
   * Counted transfers and swaps of the hour per asset, which let a hidden token leave the counts.
   * Absent in builds stored before it was recorded.
   */
  transfersByAsset?: Record<string, number>;
  swapsByAsset?: Record<string, number>;
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
  /** Absent in builds stored before the Polymarket fills were read. */
  polymarket?: PolymarketAggregates;
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

/**
 * Settings of the analytics that the ingestion reads, by chain id, from the `network_visibility`
 * document of `analytics_settings`.
 */
export interface IngestNetworkSettings {
  /** Networks hidden from the statistics. Reported only: the run copies and reads them anyway. */
  hiddenChainIds: string[];
  /**
   * Networks whose balances the run does not read, such as a network whose node was shut down.
   * Absent from documents written before it existed, which read every network.
   */
  uncollectedChainIds: string[];
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
  /** Visibility and balance collection settings; by default nothing hidden, every network read. */
  networkSettings(): Promise<IngestNetworkSettings>;
  /**
   * `takenAt` of the last stored snapshot that read every user wallet of each network: a row with
   * `status: complete` and no reason. Networks never read in full are absent.
   */
  lastBalanceSuccess(): Promise<Map<NetworkId, Date>>;
  /** Wallet observations of every earlier run. */
  walletObservations(): Promise<WalletObservation[]>;
  /** Adds observations of wallets not seen before; known wallets keep their first observation. */
  addWalletObservations(items: readonly WalletObservation[]): Promise<void>;
  /** Stores fills keyed by their `id`, so a fill read again replaces itself. */
  upsertPolymarketFills(items: readonly PolymarketFill[]): Promise<void>;
  polymarketFills(): Promise<PolymarketFill[]>;
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

/** A Polygon block number and its timestamp. */
export interface PolygonBlock {
  number: number;
  at: Date;
}

/**
 * Reads the Polymarket fills of Polygon. Every request counts against the budget; a method that
 * could not complete answers `null`.
 */
export interface PolygonFillReader {
  /** Latest block deep enough not to be reorganized. */
  head(budget: CallBudget): Promise<PolygonBlock | null>;
  /** Block `number` with its timestamp. */
  block(number: number, budget: CallBudget): Promise<PolygonBlock | null>;
  /** First block at or after `at`, searched up to `head`. */
  blockAt(at: Date, head: PolygonBlock, budget: CallBudget): Promise<PolygonBlock | null>;
  /**
   * Fills of the orders of `makers` (lower case) in blocks `fromBlock` to `toBlock`, both
   * included; every fill or `null`, never part of them.
   */
  fills(
    makers: readonly string[],
    fromBlock: number,
    toBlock: number,
    budget: CallBudget
  ): Promise<PolymarketFill[] | null>;
}
