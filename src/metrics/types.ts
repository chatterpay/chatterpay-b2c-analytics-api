import type { NetworkFilter, NetworkId } from './catalog.js';

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

/** Fields shared by the `meta` object of every metrics response. */
export interface MetricsMetaBase {
  datasetVersion: string;
  dataStatus: 'mock';
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
}

/** Response of `GET /v1/metrics/revenue`. */
export interface RevenueResponse {
  meta: RangeMeta;
  tiles: {
    feesUsd: MoneyMetric;
    transferFeesUsd: MoneyMetric;
    swapFeesUsd: MoneyMetric;
    volumeUsd: MoneyMetric;
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
}
