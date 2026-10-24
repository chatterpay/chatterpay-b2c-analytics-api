import type { DayHour, TimeWindow } from './calendar.js';
import { DATASET_VERSION, type NetworkId } from './catalog.js';
import {
  activeUsersInWindow,
  type Facts,
  factsInWindow,
  retainedUsers,
  totalUsersAt
} from './facts.js';

/** Version of the live dataset; changing how B2C rows become metrics requires a new value. */
export const LIVE_DATASET_VERSION = 'live-v1';

/** Where the values of a response come from. */
export type DataStatus = 'mock' | 'mixed' | 'live';

/** Data the metrics of one group are computed from. */
export interface MetricsSource {
  readonly kind: 'mock' | 'live';
  /** Additive activity of a network inside a window. */
  facts(network: NetworkId, window: TimeWindow): Facts;
  /** Distinct active users of a network inside a window. */
  activeUsers(network: NetworkId, window: TimeWindow): number;
  /** Users of a network that joined through `point`, inclusive. */
  totalUsersAt(network: NetworkId, point: DayHour): number;
  /**
   * Users of the cohort that joined in the month starting on `cohortStartDay`, active in each of the
   * `months` following months.
   */
  retained(
    network: NetworkId,
    cohortStartDay: number,
    cohortSize: number,
    months: number
  ): number[];
}

/** Synthetic dataset of `facts.ts`. */
export const MOCK_SOURCE: MetricsSource = {
  kind: 'mock',
  facts: factsInWindow,
  activeUsers: activeUsersInWindow,
  totalUsersAt,
  retained: retainedUsers
};

/**
 * Groups of metrics. Every metric of a group comes from the same source, so totals, breakdowns and
 * series of a group stay consistent with each other.
 *
 * - `activity`: volume, transaction counts and fees, overall, per network and per asset.
 * - `activeUsers`: distinct users that started an operation.
 * - `signups`: new users and total users.
 * - `retention`: monthly cohorts and the users retained after each month.
 */
export type MetricGroup = 'activity' | 'activeUsers' | 'signups' | 'retention';

/**
 * Groups served from the B2C data once a live dataset is loaded; a group set to `false` keeps the
 * synthetic values. Without a live dataset (no MongoDB, ingestion disabled or not run yet) every
 * group is synthetic.
 *
 * - `activity`: completed `transfer` and `swap` rows of the B2C `transactions` collection. A swap
 *   counts once, valued on its stable leg when it has one; fees are the `fee` field. Deposits and
 *   Polymarket rows are copied but not counted.
 * - `activeUsers`: users whose wallet sent a counted operation.
 * - `signups`: `users.creationDate`, per network of the user's wallets. Wallets carry no date of
 *   their own, so a wallet added later counts from the user's signup.
 * - `retention`: cohorts by `creationDate`, retained by later counted operations.
 */
export const LIVE_METRIC_GROUPS: Readonly<Record<MetricGroup, boolean>> = {
  activity: true,
  activeUsers: true,
  signups: true,
  retention: true
};

interface LiveState {
  source: MetricsSource;
  /** End of the ingestion run the dataset was built from. */
  asOf: Date;
}

let live: LiveState | null = null;

/**
 * Installs or removes the live dataset used by the groups enabled in {@link LIVE_METRIC_GROUPS}.
 *
 * @param source - Live source; `null` returns every group to the synthetic dataset.
 * @param asOf - Instant the live data reflects.
 */
export function setLiveSource(source: MetricsSource | null, asOf: Date = new Date()): void {
  live = source === null ? null : { source, asOf };
}

/**
 * Source of a metric group.
 *
 * @param group - Metric group.
 * @returns The live source when the group is enabled and a live dataset is loaded; else the mock.
 */
export function sourceFor(group: MetricGroup): MetricsSource {
  return live !== null && LIVE_METRIC_GROUPS[group] ? live.source : MOCK_SOURCE;
}

/** Provenance fields of the `meta` object of a response. */
export interface Provenance {
  datasetVersion: string;
  dataStatus: DataStatus;
  /** End of the ingestion run the live values come from; `null` when every value is synthetic. */
  lastUpdatedAt: string | null;
}

/**
 * Provenance of a response built from some metric groups.
 *
 * @param groups - Groups the response uses.
 * @returns `live` when every group is live, `mixed` when some are, `mock` otherwise.
 */
export function provenanceOf(groups: readonly MetricGroup[]): Provenance {
  const liveCount = groups.filter((group) => sourceFor(group).kind === 'live').length;
  const dataStatus: DataStatus =
    liveCount === 0 ? 'mock' : liveCount === groups.length ? 'live' : 'mixed';
  return {
    datasetVersion:
      dataStatus === 'mock'
        ? DATASET_VERSION
        : dataStatus === 'live'
          ? LIVE_DATASET_VERSION
          : `${LIVE_DATASET_VERSION}+${DATASET_VERSION}`,
    dataStatus,
    lastUpdatedAt: dataStatus === 'mock' || live === null ? null : live.asOf.toISOString()
  };
}
