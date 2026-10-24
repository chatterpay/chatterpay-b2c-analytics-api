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
}

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
  | 'not_configured';

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

/** Wallets a balance snapshot covers. */
export interface SnapshotCoverage {
  /** User wallets on the selected networks when the snapshot was taken. */
  wallets: number;
  /** Of those, the wallets whose balances were read. */
  walletsRead: number;
  /** Assets held without a USD price on the snapshot day; their value is not in the totals. */
  unpricedAssets: Array<{ network: NetworkId; asset: string }>;
}

/** Total value of the assets held in user wallets, from the balance snapshots. */
export interface TvlBlock extends BlockStatus {
  /**
   * Last snapshot taken at or before the end of the period; `previous` is the last snapshot inside
   * the previous period, `null` when there is none. `null` when no snapshot exists yet.
   */
  value: MoneyMetric | null;
  /** First snapshot ever taken; earlier periods have no TVL. */
  firstSnapshotAt: string | null;
  /** Coverage of the snapshot behind `value`; `null` when there is none. */
  coverage: SnapshotCoverage | null;
  /** Last snapshot inside each bucket; `tvlUsd` and `asOf` are `null` for a bucket without one. */
  series: Array<Period & { tvlUsd: string | null; asOf: string | null }>;
  /** Networks of the snapshot behind `value`; `share` is a ratio of the total with 4 places. */
  byNetwork: Array<
    NetworkRef & { tvlUsd: string; share: string | null; status: NetworkReadStatus }
  >;
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
}

/** Assets held in user wallets, by USD value, from the same snapshot as the TVL. */
export interface TopTokensBlock extends BlockStatus {
  items: TokenHolding[];
  /** Sum of the priced items; `null` when there is no snapshot. */
  totalUsd: string | null;
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
    volumeUsd: MoneyMetric;
    transactions: CountMetric;
    feesUsd: MoneyMetric;
    activeUsers: CountMetric;
    newUsers: CountMetric;
  };
  series: Array<
    Period & {
      volumeUsd: string;
      transactions: number;
      byNetwork: Array<{ network: NetworkId; volumeUsd: string; transactions: number }>;
    }
  >;
  byNetwork: Array<
    NetworkRef & {
      volumeUsd: string;
      transactions: number;
      feesUsd: string;
      activeUsers: number;
      newUsers: number;
    }
  >;
  tvl: TvlBlock;
  topTokens: TopTokensBlock;
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
}

/** Response of `GET /v1/metrics/revenue`. */
export interface RevenueResponse {
  meta: RangeMeta;
  tiles: {
    feesUsd: MoneyMetric;
    transferFeesUsd: MoneyMetric;
    swapFeesUsd: MoneyMetric;
    volumeUsd: MoneyMetric;
    /** Input side of the counted swaps, the same figure as the swap part of `volumeUsd`. */
    swapVolumeUsd: MoneyMetric;
  };
  series: Array<Period & { feesUsd: string; transferFeesUsd: string; swapFeesUsd: string }>;
  byNetwork: Array<
    NetworkRef & {
      feesUsd: string;
      transferFeesUsd: string;
      swapFeesUsd: string;
      volumeUsd: string;
    }
  >;
  byAsset: Array<{ network: NetworkId; asset: string; volumeUsd: string; feesUsd: string }>;
  avgFeePerTransaction: AverageFeeBlock;
  polymarketVolume: PolymarketVolumeBlock;
  feesByProduct: FeesByProductBlock;
  masterWallets: MasterWalletsBlock;
}
