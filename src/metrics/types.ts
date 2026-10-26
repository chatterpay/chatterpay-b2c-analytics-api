import type { NetworkFilter, NetworkId } from './catalog.js';
import type { DataStatus } from './sources.js';

/** Time range of Overview and Revenue. */
export type MetricsRange = 'today' | 'week' | 'month' | 'year' | 'ytd' | 'all';

/** Series granularity of Users. */
export type UsersGranularity = 'daily' | 'monthly' | 'yearly';

/** Size of each series point. */
export type SeriesBucket = 'hour' | 'day' | 'month' | 'year';

/** Half-open interval of ISO-8601 UTC instants. */
export interface Period {
  start: string;
  end: string;
}

/** Per-source status of the last ingestion run. */
export interface IngestRunStatus {
  /** `partial` when a limit stopped the copy of the B2C transactions. */
  status: 'completed' | 'partial';
  finishedAt: string;
  sources: {
    /** `partial`: rows remain for the next run, so recent activity can be missing. */
    transactions: 'complete' | 'partial';
    /** `skipped`: the provider was already asked that UTC day. */
    prices: 'complete' | 'failed' | 'skipped' | 'disabled';
    /** Balance snapshot of the run. */
    balances: 'complete' | 'partial' | 'failed' | 'disabled';
  };
  /**
   * USD valuation of the run (`USD_VALUATION`): `market` values balances and operations with
   * stable and provider prices, `none` values nothing because the networks hold test assets
   * without market value. Absent in runs stored before it was recorded, which valued at market.
   */
  valuation?: UsdValuation;
}

/** USD valuation policy of a deployment; see {@link IngestRunStatus.valuation}. */
export type UsdValuation = 'market' | 'none';

/** Fields shared by the `meta` object of every metrics response. */
export interface MetricsMetaBase {
  datasetVersion: string;
  /** `live` when every value comes from the B2C data, `mixed` when some do, `mock` otherwise. */
  dataStatus: DataStatus;
  /** End of the ingestion run the live values come from; `null` when every value is synthetic. */
  lastUpdatedAt: string | null;
  /** Last ingestion run behind the live values; `null` when every value is synthetic. */
  ingest: IngestRunStatus | null;
  generatedAt: string;
  currency: 'USD';
  network: NetworkFilter;
  period: Period;
  /** Comparison period of the tiles; `null` when the range has none (`all`). */
  previousPeriod: Period | null;
  bucket: SeriesBucket;
}

/** `meta` of Overview and Revenue. */
export interface RangeMeta extends MetricsMetaBase {
  range: MetricsRange;
  tokenScope: TokenScope;
}

/**
 * Tokens an admin hid from the statistics (`/v1/admin/tokens`) among the selected networks. They
 * are left out of every money figure, of Top tokens, of the asset breakdowns and of the master
 * wallet balances before anything is added; users, signups, wallets and countries keep counting
 * them, because those figures have no token.
 */
export interface TokenScope {
  /** Hidden tokens of the selected networks, by network and catalog symbol. */
  hidden: Array<{ network: NetworkId; asset: string }>;
  /**
   * `filtered` when the transaction counts leave the hidden tokens out too; `unfiltered` when the
   * build behind them has no count per asset (builds stored before it was recorded, synthetic
   * data), so they still count the operations of hidden tokens.
   */
  operationCounts: 'filtered' | 'unfiltered';
}

/** `meta` of Users. */
export interface UsersMeta extends MetricsMetaBase {
  granularity: UsersGranularity;
}

/**
 * Count with its comparison value. `changeRatio` is `(value - previous) / previous` as a decimal
 * string with 4 places; `null` when there is no previous value or it is zero.
 */
export interface CountMetric {
  value: number;
  previous: number | null;
  changeRatio: string | null;
}

/** USD amount with its comparison value; amounts are decimal strings with 2 places. */
export interface MoneyMetric {
  value: string;
  previous: string | null;
  changeRatio: string | null;
}

/**
 * USD amount of counted operations with the coverage of its valuation. `available`: every
 * operation of the figure has a USD value. `partial`: some have none; `value` is the subtotal of
 * the valued ones, never the total. `unavailable`: none has one, or the deployment values nothing
 * (`not_valued`); `value` is `null`. `previous` is `null` unless the previous period was valued
 * completely, and `changeRatio` is `null` unless both periods were, so a change never compares a
 * subtotal.
 */
export interface ValuedMoneyMetric {
  value: string | null;
  previous: string | null;
  changeRatio: string | null;
  availability: Availability;
  reason: UnavailableReason | null;
}

/** Network label as shown in breakdowns. */
export interface NetworkRef {
  network: NetworkId;
  label: string;
}

/**
 * Whether a block can be served: `available` when it is complete, `partial` when part of what it
 * covers could not be read, priced or verified (its coverage says which part), `unavailable` when
 * there is nothing verifiable to serve; its values are then `null`, never a substitute.
 */
export type Availability = 'available' | 'partial' | 'unavailable';

/**
 * Why a block or item is not `available`.
 *
 * - `no_snapshot`: no balance snapshot was taken yet, or none inside the requested period.
 * - `snapshots_disabled`: the last ingestion took no balance snapshot (`BALANCES_PROVIDER=none`).
 * - `partial_coverage`: some wallets or networks could not be read.
 * - `unpriced_assets`: some assets had no USD price on the day of the snapshot.
 * - `unverified_wallets`: some wallets have no verifiable first appearance and are not counted.
 * - `not_recorded`: the B2C data does not record the figure verifiably.
 * - `no_transactions`: the figure divides by a number of operations that is zero.
 * - `no_eligible_cohort`: no cohort with users is old enough for the retention month.
 * - `not_configured`: nothing is configured to read (no master wallets).
 * - `not_read`: the snapshot holds no reading of the selected networks (balance reads stopped by
 *   the analytics settings, no longer listed by B2C, without a supported endpoint, every request
 *   failed, or the budget or deadline ran out). Earlier snapshots keep their own values; they are
 *   not served as the current one.
 * - `not_valued`: the deployment does not value in USD (`USD_VALUATION=none`, test networks whose
 *   assets have no market value); amounts and counts are kept.
 * - `native_not_covered`: the native coin of an EVM network is neither in the B2C token list nor
 *   named by the `nativeSymbol` of a master wallet of the network, so the user wallets were read
 *   without it.
 * - `undated_users`: some users have no signup date; they count in the totals but in no signup
 *   window or cohort.
 * - `undated_accounts`: some Polymarket accounts have no creation date; they count in the total
 *   but in no creation window.
 */
export type UnavailableReason =
  | 'no_snapshot'
  | 'snapshots_disabled'
  | 'partial_coverage'
  | 'unpriced_assets'
  | 'unverified_wallets'
  | 'not_recorded'
  | 'no_transactions'
  | 'no_eligible_cohort'
  | 'not_configured'
  | 'not_read'
  | 'not_valued'
  | 'native_not_covered'
  | 'undated_users'
  | 'undated_accounts';

/** Origin, availability and freshness of a block of a response. */
export interface BlockStatus {
  /** `mock` for synthetic values, `live` for values built from the B2C data and snapshots. */
  source: 'mock' | 'live';
  availability: Availability;
  /** `null` when `availability` is `available`. */
  reason: UnavailableReason | null;
  /** Instant the values reflect (snapshot or aggregate build); `null` for synthetic values. */
  asOf: string | null;
}

/** Status of the read of one network in a balance snapshot. */
export type NetworkReadStatus = 'complete' | 'partial' | 'failed' | 'unsupported';

/**
 * Why a network of a balance snapshot was not read, or not read completely.
 *
 * - `b2c_disabled`: only in snapshots stored while a B2C document with `enabled: false` kept the
 *   network from being read. B2C `enabled` no longer plays any part in what is read.
 * - `collection_off`: the analytics settings stop the balance reads of the network
 *   (`uncollectedChainIds`); no request is sent for it.
 * - `source_absent`: the B2C database no longer lists the network, so there is no endpoint to read;
 *   no request is sent for it.
 * - `no_endpoint`: the B2C document has no HTTPS `rpc` or `providerUrl`.
 * - `unsupported_provider`: the endpoint speaks a dialect the reader does not.
 * - `rpc_failed`: no wallet was read and every request sent for the network failed.
 * - `budget_exhausted`: the call budget of the run ran out before every wallet was read.
 * - `deadline_reached`: the run deadline passed before every wallet was read.
 * - `read_incomplete`: some wallets were not read for another cause, such as some failed requests.
 */
export type NetworkReadReason =
  | 'b2c_disabled'
  | 'collection_off'
  | 'source_absent'
  | 'no_endpoint'
  | 'unsupported_provider'
  | 'rpc_failed'
  | 'budget_exhausted'
  | 'deadline_reached'
  | 'read_incomplete';

/**
 * Whether the user wallets of a network were read with its native coin: `included` on Cardano
 * (ADA comes with the UTxOs) and on EVM networks whose B2C token list carries the native coin or
 * that have a master wallet whose `nativeSymbol` names it (`MASTER_WALLETS`), `not_listed` on EVM
 * networks with neither. A master wallet without `nativeSymbol` names no coin for the user wallets.
 */
export type NativeCoverage = 'included' | 'not_listed';

/** Wallets a balance snapshot covers. */
export interface SnapshotCoverage {
  /** User wallets on the selected networks when the snapshot was taken. */
  wallets: number;
  /** Of those, the wallets whose balances were read. */
  walletsRead: number;
  /** Assets held without a USD price on the snapshot day; their value is not in the totals. */
  unpricedAssets: Array<{ network: NetworkId; asset: string }>;
  /** Selected networks whose user wallets were read without the native coin. */
  nativeNotCovered: NetworkId[];
}

/**
 * Coverage of the USD valuation of the counted operations of the period. An operation is counted
 * in `transactions` whatever its valuation; its amount or fee without a USD value is left out of
 * the money figures instead of being taken as zero. A fee of zero is a measured zero.
 */
export interface ValuationBlock extends BlockStatus {
  /** Counted transfers and swaps of the period. */
  operations: number;
  /** Operations whose amount has no USD value; their volume is not in the figures. */
  unpricedVolume: number;
  /** Operations with a fee other than zero that has no USD value; not in the fee figures. */
  unpricedFees: number;
  /** Assets of those operations per network, with how many of each were left out of each figure. */
  unpricedAssets: Array<{
    network: NetworkId;
    asset: string;
    unpricedVolume: number;
    unpricedFees: number;
  }>;
}

/** Users with and without a signup date; the latter are in no signup window or cohort. */
export interface SignupsBlock extends BlockStatus {
  /** Users of the selected networks through the current hour, each counted once. */
  users: number;
  /** Of those, users without `creationDate`. */
  undatedUsers: number;
}

/** Total value of the assets held in user wallets, from the balance snapshots. */
export interface TvlBlock extends BlockStatus {
  /**
   * Last snapshot taken at or before the end of the period; `previous` is the last snapshot inside
   * the previous period, `null` when there is none. `null` when no snapshot exists yet. A `partial`
   * value is the subtotal of what was read, not the total; `previous` and `changeRatio` are `null`
   * unless both snapshots are complete, so a change never compares a subtotal.
   */
  value: MoneyMetric | null;
  /** First snapshot ever taken; earlier periods have no TVL. */
  firstSnapshotAt: string | null;
  /** Coverage of the snapshot behind `value`; `null` when there is none. */
  coverage: SnapshotCoverage | null;
  /** Last snapshot inside each bucket; `tvlUsd` and `asOf` are `null` for a bucket without one. */
  series: Array<Period & { tvlUsd: string | null; asOf: string | null }>;
  /**
   * Networks of the snapshot behind `value`; `share` is a ratio of the total with 4 places.
   * `tvlUsd` and `share` are `null` for a network with wallets that was not read (`failed` or
   * `unsupported`); `reason` says why, and is `null` for snapshots stored before it was recorded.
   * `lastSuccessAt` is the last snapshot, through the one behind `value`, that read the network
   * in full: the date of an observation, never a current balance; `null` when none did or the
   * snapshot was stored before it was recorded.
   */
  byNetwork: Array<
    NetworkRef & {
      tvlUsd: string | null;
      share: string | null;
      status: NetworkReadStatus;
      reason: NetworkReadReason | null;
      lastSuccessAt: string | null;
    }
  >;
  /**
   * Only when the block is `unavailable` with `not_read`: the last earlier snapshot, through the
   * end of the period, that read every selected network completely, with the native coin and a
   * USD price for every held asset. A dated historical balance, never the current value; `null`
   * when no snapshot qualifies.
   */
  lastComplete: { asOf: string; valueUsd: string } | null;
}

/** Balance of one asset across user wallets, from the snapshot behind the TVL. */
export interface TokenHolding {
  asset: string;
  /** Units of the asset, as a decimal string. */
  amount: string;
  /** `null` when the asset had no USD price on the snapshot day. */
  valueUsd: string | null;
  /** Ratio of the priced total with 4 places; `null` when unpriced or the total is zero. */
  share: string | null;
  /**
   * The same asset per selected network that holds it: the row adds tokens of the same symbol on
   * different networks, each a token of its own. `valueUsd` is `null` when unpriced.
   */
  networks: Array<{ network: NetworkId; amount: string; valueUsd: string | null }>;
}

/** Assets held in user wallets, by USD value, from the same snapshot as the TVL. */
export interface TopTokensBlock extends BlockStatus {
  items: TokenHolding[];
  /** Sum of the priced items; `null` when there is no snapshot. */
  totalUsd: string | null;
}

/**
 * Tokens moved by the counted operations of the period, per network and asset: flows, not
 * balances. `operations` counts transfers plus swaps on their input side; `volumeUsd` is `null`
 * when an operation of the asset has no USD value. `unavailable` (`not_recorded`) when the build
 * has no count per asset.
 */
export interface TradedTokensBlock extends BlockStatus {
  items: Array<{
    network: NetworkId;
    asset: string;
    operations: number;
    volumeUsd: string | null;
  }>;
}

/** Users per country, estimated from the calling code of their phone number. */
export interface TopCountriesBlock extends BlockStatus {
  method: 'phone_prefix';
  /**
   * ISO 3166-1 alpha-2 code, or `Unknown` when the number gives no single country. Users with a
   * wallet on the selected networks, each counted once, at the last ingestion run; the range does
   * not apply.
   */
  items: Array<{ country: string; users: number; share: string | null }>;
  totalUsers: number;
}

/** Product of a completed operation. */
export type Product = 'transfer' | 'swap' | 'polymarket';

/** Volume of one product in the range. */
export interface ProductVolume {
  product: Product;
  availability: Availability;
  reason: UnavailableReason | null;
  volumeUsd: string | null;
  transactions: number | null;
  /** Ratio of the volume of the available products with 4 places. */
  share: string | null;
}

/** Volume of completed operations per product; each operation counts in one product only. */
export interface VolumeByProductBlock extends BlockStatus {
  items: ProductVolume[];
}

/** Fees recorded on the operations of one product in the range; not reconciled charges. */
export interface ProductFees {
  product: Product;
  availability: Availability;
  reason: UnavailableReason | null;
  feesUsd: string | null;
  share: string | null;
}

/** Recorded fees per product. */
export interface FeesByProductBlock extends BlockStatus {
  items: ProductFees[];
}

/** Recorded fees divided by the counted operations, in USD with 4 places. */
export interface AverageFeeBlock extends BlockStatus {
  valueUsd: string | null;
  previousUsd: string | null;
  changeRatio: string | null;
  /** Counted transfers and swaps of the period; the divisor. */
  transactions: number;
  previousTransactions: number | null;
}

/** USD volume of the Polymarket product in the range. */
export interface PolymarketVolumeBlock extends BlockStatus {
  valueUsd: string | null;
}

/**
 * Users with a Polymarket account linked, from the counts of the last ingestion run. A linked
 * account is a Polygon address stored for the user; it proves neither trading nor a fee, so it
 * never enters the volume or fee figures. The account lives outside the networks of the catalog,
 * so the counts cover every user whatever the network filter (`scope: all_networks`).
 */
export interface PolymarketAccountsBlock extends BlockStatus {
  scope: 'all_networks';
  /** Users whose account has a valid Polygon address; `null` when no run counted them. */
  accounts: number | null;
  /** Users with an account whose address is missing or not an EVM address; not in `accounts`. */
  invalidAccounts: number;
  /** Of `accounts`, accounts without a creation date; they are in no creation window. */
  undatedAccounts: number;
  /**
   * Accounts created inside the period, against the previous period; `null` when no run counted
   * them. Accounts without a creation date are in neither.
   */
  newAccounts: CountMetric | null;
}

/** Balance of one asset of a master wallet. */
export interface MasterWalletBalance {
  asset: string;
  amount: string;
  valueUsd: string | null;
}

/** Configured signer of a network: public address and balances from the last snapshot. */
export interface MasterWallet extends NetworkRef {
  /** Role given in the configuration, such as `Backend signer`. */
  role: string;
  address: string;
  /** Address page in the network explorer; `null` when the network has no explorer. */
  explorerUrl: string | null;
  status: 'complete' | 'failed' | 'unsupported';
  balances: MasterWalletBalance[];
  /** Sum of the priced balances; `null` when none was read. */
  valueUsd: string | null;
  /** Ratio of the total of the listed wallets with 4 places. */
  share: string | null;
}

/** Master wallets of the selected networks. Balances only: they are not fees or revenue. */
export interface MasterWalletsBlock extends BlockStatus {
  items: MasterWallet[];
  totalUsd: string | null;
}

/** First verifiable appearance of the wallets of each network. */
export interface NewWalletsBlock extends BlockStatus {
  definition: 'first_verifiable_appearance';
  /** First ingestion run that observed the wallets; `null` before any. */
  trackingSince: string | null;
  /** Wallets that first appeared in the last 30 days, against the 30 days before. */
  tile: CountMetric;
  /** Aligned with the `series` of the response. */
  series: Array<Period & { newWallets: number }>;
  byNetwork: Array<
    NetworkRef & {
      /** Wallets that first appeared in the breakdown window of the granularity. */
      newWallets: number;
      wallets: number;
      verifiedWallets: number;
    }
  >;
  coverage: { wallets: number; verifiedWallets: number };
}

/** Share of the users of the eligible cohorts active in the N-th month after joining. */
export interface RetentionMonth {
  month: 1 | 3 | 6;
  availability: Availability;
  reason: UnavailableReason | null;
  /** Cohorts with at least `month` complete months after their own. */
  eligibleCohorts: number;
  cohortUsers: number;
  retainedUsers: number;
  /** `retainedUsers / cohortUsers` with 4 places; `null` when no eligible cohort has users. */
  rate: string | null;
}

/** Retention at 1, 3 and 6 months over the last 12 monthly cohorts. */
export interface RetentionSummaryBlock extends BlockStatus {
  months: RetentionMonth[];
  cohorts: Array<{
    cohort: string;
    size: number;
    /** `users` is `null` when the cohort is not old enough for that month. */
    retained: Array<{ month: 1 | 3 | 6; users: number | null }>;
  }>;
}

/** Response of `GET /v1/metrics/overview`. */
export interface OverviewResponse {
  meta: RangeMeta;
  tiles: {
    volumeUsd: ValuedMoneyMetric;
    transactions: CountMetric;
    feesUsd: ValuedMoneyMetric;
    activeUsers: CountMetric;
    newUsers: CountMetric;
  };
  series: Array<
    Period & {
      volumeUsd: string | null;
      transactions: number;
      byNetwork: Array<{ network: NetworkId; volumeUsd: string | null; transactions: number }>;
    }
  >;
  byNetwork: Array<
    NetworkRef & {
      volumeUsd: string | null;
      transactions: number;
      feesUsd: string | null;
      activeUsers: number;
      newUsers: number;
    }
  >;
  /**
   * Valuation of the operations of the period. The series and `byNetwork` amounts are subtotals of
   * the valued operations, `null` where operations exist and none is valued; `unpricedAssets` names
   * the networks and assets they leave out.
   */
  valuation: ValuationBlock;
  tvl: TvlBlock;
  topTokens: TopTokensBlock;
  tradedTokens: TradedTokensBlock;
  topCountries: TopCountriesBlock;
  volumeByProduct: VolumeByProductBlock;
}

/** Response of `GET /v1/metrics/users`. */
export interface UsersResponse {
  meta: UsersMeta;
  tiles: {
    dailyActiveUsers: CountMetric;
    monthlyActiveUsers: CountMetric;
    yearlyActiveUsers: CountMetric;
    newUsers: CountMetric;
    totalUsers: CountMetric;
  };
  series: Array<
    Period & {
      activeUsers: number;
      newUsers: number;
      byNetwork: Array<{ network: NetworkId; activeUsers: number; newUsers: number }>;
    }
  >;
  retention: Array<{ cohort: string; size: number; retained: number[] }>;
  byNetwork: Array<NetworkRef & { activeUsers: number; totalUsers: number }>;
  newWallets: NewWalletsBlock;
  retentionSummary: RetentionSummaryBlock;
  /** Signup dates behind `newUsers`, the series and the cohorts. */
  signups: SignupsBlock;
}

/** Response of `GET /v1/metrics/revenue`. */
export interface RevenueResponse {
  meta: RangeMeta;
  tiles: {
    feesUsd: ValuedMoneyMetric;
    transferFeesUsd: ValuedMoneyMetric;
    swapFeesUsd: ValuedMoneyMetric;
    volumeUsd: ValuedMoneyMetric;
    /** Input side of the counted swaps, the same figure as the swap part of `volumeUsd`. */
    swapVolumeUsd: ValuedMoneyMetric;
  };
  /** Subtotals of the valued operations, as the Overview series. */
  series: Array<
    Period & { feesUsd: string | null; transferFeesUsd: string | null; swapFeesUsd: string | null }
  >;
  /** Subtotals of the valued operations, as the Overview breakdown. */
  byNetwork: Array<
    NetworkRef & {
      feesUsd: string | null;
      transferFeesUsd: string | null;
      swapFeesUsd: string | null;
      volumeUsd: string | null;
    }
  >;
  /** `volumeUsd` or `feesUsd` is `null` when an operation of the asset has no USD value for it. */
  byAsset: Array<{
    network: NetworkId;
    asset: string;
    volumeUsd: string | null;
    feesUsd: string | null;
  }>;
  /** Valuation of the operations of the period; see {@link OverviewResponse.valuation}. */
  valuation: ValuationBlock;
  avgFeePerTransaction: AverageFeeBlock;
  polymarketVolume: PolymarketVolumeBlock;
  polymarketAccounts: PolymarketAccountsBlock;
  feesByProduct: FeesByProductBlock;
  masterWallets: MasterWalletsBlock;
}
