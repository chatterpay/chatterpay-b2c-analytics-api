import {
  addMonths,
  type DayHour,
  dayNumberFromIso,
  dayWindow,
  type TimeWindow
} from './calendar.js';
import { DATASET_START_DAY, DATASET_VERSION, type NetworkId } from './catalog.js';
import {
  activeUsersInWindow,
  type Facts,
  factsInWindow,
  retainedUsers,
  totalUsersAt
} from './facts.js';
import { EMPTY_LIVE_SNAPSHOTS, MOCK_SNAPSHOTS, type SnapshotSource } from './snapshot-source.js';
import type { IngestRunStatus, UsdValuation } from './types.js';

/** Version of the live dataset; changing how B2C rows become metrics requires a new value. */
export const LIVE_DATASET_VERSION = 'live-v3';

/** Where the values of a response come from. */
export type DataStatus = 'mock' | 'mixed' | 'live';

/** Wallets of a network and how many of them have a verifiable first appearance. */
export interface WalletCoverage {
  wallets: number;
  verified: number;
}

/** Data the metrics of one group are computed from. */
export interface MetricsSource {
  readonly kind: 'mock' | 'live';
  /** Additive activity of a network inside a window. */
  facts(network: NetworkId, window: TimeWindow): Facts;
  /**
   * Whether every hour of the source counts its operations per asset, so the operations of a
   * hidden token can leave the transaction counts.
   */
  countsByAsset(): boolean;
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
  /**
   * Distinct users active on any of `networks` inside a window. A person active on several of them
   * counts once, so the result can be lower than the sum of {@link MetricsSource.activeUsers}.
   */
  activeUsersAcross(networks: readonly NetworkId[], window: TimeWindow): number;
  /** Distinct users of any of `networks` that joined inside a window, each counted once. */
  newUsersAcross(networks: readonly NetworkId[], window: TimeWindow): number;
  /** Distinct users of any of `networks` that joined through `point`, inclusive, each once. */
  totalUsersAcross(networks: readonly NetworkId[], point: DayHour): number;
  /**
   * Distinct users of any of `networks` without a signup date. They are in the totals from the
   * start, and in no signup window or cohort.
   */
  undatedUsersAcross(networks: readonly NetworkId[]): number;
  /**
   * Monthly cohort over `networks`: distinct users that joined in the month starting on
   * `cohortStartDay`, and how many of them were active on any of the networks in each of the
   * `months` following months.
   */
  cohortAcross(
    networks: readonly NetworkId[],
    cohortStartDay: number,
    months: number
  ): { size: number; retained: number[] };
  /** Wallets of a network through `point` and how many have a verifiable first appearance. */
  walletCoverage(network: NetworkId, point: DayHour): WalletCoverage;
  /** First ingestion run that observed the wallets; `null` before any. */
  walletsTrackingSince(): Date | null;
}

/** Users that joined a network inside a window, per the synthetic model. */
function mockNewUsers(network: NetworkId, window: TimeWindow): number {
  return factsInWindow(network, window).newUsers;
}

const MOCK_START_DAY = dayNumberFromIso(DATASET_START_DAY);

/**
 * Synthetic dataset of `facts.ts`. It has no user identities: each network is modelled as its own
 * population, so the totals over several networks are the sums of the networks. Every synthetic
 * wallet has a first appearance, so the synthetic coverage is complete.
 */
export const MOCK_SOURCE: MetricsSource = {
  kind: 'mock',
  facts: factsInWindow,
  countsByAsset: () => false,
  activeUsers: activeUsersInWindow,
  totalUsersAt,
  retained: retainedUsers,
  activeUsersAcross: (networks, window) =>
    networks.reduce((sum, id) => sum + activeUsersInWindow(id, window), 0),
  newUsersAcross: (networks, window) =>
    networks.reduce((sum, id) => sum + mockNewUsers(id, window), 0),
  totalUsersAcross: (networks, point) =>
    networks.reduce((sum, id) => sum + totalUsersAt(id, point), 0),
  undatedUsersAcross: () => 0,
  cohortAcross: (networks, cohortStartDay, months) => {
    const cohortWindow = dayWindow(cohortStartDay, addMonths(cohortStartDay, 1) - 1);
    let size = 0;
    const retained = new Array<number>(months).fill(0);
    for (const id of networks) {
      const networkSize = mockNewUsers(id, cohortWindow);
      size += networkSize;
      retainedUsers(id, cohortStartDay, networkSize, months).forEach((value, index) => {
        retained[index] = (retained[index] ?? 0) + value;
      });
    }
    return { size, retained };
  },
  walletCoverage: (network, point) => {
    if (point.day < MOCK_START_DAY) {
      return { wallets: 0, verified: 0 };
    }
    const wallets = factsInWindow(
      network,
      dayWindow(MOCK_START_DAY, point.day, point.hour)
    ).newWallets;
    return { wallets, verified: wallets };
  },
  walletsTrackingSince: () => new Date(MOCK_START_DAY * 86_400_000)
};

/**
 * Groups of metrics. Every metric of a group comes from the same source, so totals, breakdowns and
 * series of a group stay consistent with each other.
 *
 * - `activity`: volume, transaction counts and fees, overall, per network, per asset and product.
 * - `activeUsers`: distinct users that started an operation.
 * - `signups`: new users and total users.
 * - `retention`: monthly cohorts and the users retained after each month.
 * - `wallets`: first verifiable appearance of each wallet per network.
 * - `balances`: balance snapshots of user and master wallets (TVL, top tokens, master wallets).
 * - `countries`: users per country of their phone number, at the last ingestion run.
 */
export type MetricGroup =
  | 'activity'
  | 'activeUsers'
  | 'signups'
  | 'retention'
  | 'wallets'
  | 'balances'
  | 'countries';

/**
 * Groups served from the B2C data once a live dataset is loaded; a group set to `false` keeps the
 * synthetic values. Without a live dataset (no MongoDB, ingestion disabled or not run yet) every
 * group is synthetic. Once a live dataset is loaded, a live group without data (no snapshot yet)
 * answers `unavailable`; it never falls back to the synthetic values.
 *
 * - `activity`: completed `transfer` rows and complete swaps (both legs completed) of the B2C
 *   `transactions` collection. A swap counts once, valued on its stable leg when it has one; fees
 *   are the `fee` field. An operation without a USD value counts as an operation and is left out
 *   of the money figures, which then answer `partial` or `unavailable`. Deposits and Polymarket
 *   rows are copied but not counted.
 * - `activeUsers`: users whose wallet sent a counted operation.
 * - `signups`: `users.creationDate`, per network of the user's wallets. Wallets carry no date of
 *   their own, so a wallet added later counts from the user's signup.
 * - `retention`: cohorts by `creationDate`, retained by later counted operations.
 * - `wallets`: earliest completed B2C operation that sent from or paid to the wallet, or the first
 *   ingestion run that saw the wallet when the run before did not.
 * - `balances`: on-chain balances read by the ingestion, one snapshot per run.
 * - `countries`: calling code of `users.phone_number`, counted during the ingestion; the numbers
 *   are not stored.
 */
export const LIVE_METRIC_GROUPS: Readonly<Record<MetricGroup, boolean>> = {
  activity: true,
  activeUsers: true,
  signups: true,
  retention: true,
  wallets: true,
  balances: true,
  countries: true
};

interface LiveState {
  source: MetricsSource;
  snapshots: SnapshotSource;
  /** End of the ingestion run the dataset was built from. */
  asOf: Date;
  ingest: IngestRunStatus | null;
}

/** Parts of a live dataset besides the aggregates. */
export interface LiveExtras {
  /** Balance and country snapshots; none when omitted, so those groups answer `unavailable`. */
  snapshots?: SnapshotSource;
  /** Per-source status of the run that built the dataset. */
  ingest?: IngestRunStatus | null;
}

let live: LiveState | null = null;

/**
 * Installs or removes the live dataset used by the groups enabled in {@link LIVE_METRIC_GROUPS}.
 *
 * @param source - Live source; `null` returns every group to the synthetic dataset.
 * @param asOf - Instant the live data reflects.
 * @param extras - Snapshots and run status of the same build.
 */
export function setLiveSource(
  source: MetricsSource | null,
  asOf: Date = new Date(),
  extras: LiveExtras = {}
): void {
  live =
    source === null
      ? null
      : {
          source,
          snapshots: extras.snapshots ?? EMPTY_LIVE_SNAPSHOTS,
          asOf,
          ingest: extras.ingest ?? null
        };
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

/**
 * Snapshot source of a metric group.
 *
 * @param group - `balances` or `countries`.
 * @returns The live snapshots when the group is enabled and a live dataset is loaded; else the
 *   synthetic ones.
 */
export function snapshotsFor(group: 'balances' | 'countries'): SnapshotSource {
  return live !== null && LIVE_METRIC_GROUPS[group] ? live.snapshots : MOCK_SNAPSHOTS;
}

/**
 * Instant a group's live values reflect.
 *
 * @param group - Metric group.
 * @returns The end of the run behind the live dataset; `null` when the group is synthetic.
 */
export function liveAsOf(group: MetricGroup): string | null {
  return live !== null && LIVE_METRIC_GROUPS[group] ? live.asOf.toISOString() : null;
}

/**
 * USD valuation of the build behind a group's live values.
 *
 * @param group - Metric group.
 * @returns `none` when that build valued nothing; `market` otherwise, synthetic values included.
 */
export function liveValuation(group: MetricGroup): UsdValuation {
  return live !== null && LIVE_METRIC_GROUPS[group]
    ? (live.ingest?.valuation ?? 'market')
    : 'market';
}

/** Provenance fields of the `meta` object of a response. */
export interface Provenance {
  datasetVersion: string;
  dataStatus: DataStatus;
  /** End of the ingestion run the live values come from; `null` when every value is synthetic. */
  lastUpdatedAt: string | null;
  /** Status of that run per source; `null` when every value is synthetic. */
  ingest: IngestRunStatus | null;
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
  const anyLive = dataStatus !== 'mock' && live !== null;
  return {
    datasetVersion:
      dataStatus === 'mock'
        ? DATASET_VERSION
        : dataStatus === 'live'
          ? LIVE_DATASET_VERSION
          : `${LIVE_DATASET_VERSION}+${DATASET_VERSION}`,
    dataStatus,
    lastUpdatedAt: anyLive && live !== null ? live.asOf.toISOString() : null,
    // Runs stored before the valuation was recorded valued at market.
    ingest:
      anyLive && live !== null && live.ingest !== null
        ? { ...live.ingest, valuation: live.ingest.valuation ?? 'market' }
        : null
  };
}
