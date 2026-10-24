import {
  addMonths,
  type DayHour,
  dayBuckets,
  dayHourOf,
  dayNumberFromIso,
  dayWindow,
  isoMonthOf,
  monthBuckets,
  periodOf,
  shiftWindow,
  type TimeWindow,
  yearBuckets,
  yearStartOf
} from './calendar.js';
import {
  DATASET_START_DAY,
  type NetworkFilter,
  type NetworkId,
  networkProfile,
  networksFor
} from './catalog.js';
import { shareOf } from './decimal.js';
import { countMetric } from './format.js';
import { liveAsOf, type MetricGroup, provenanceOf, sourceFor } from './sources.js';
import type {
  CountMetric,
  NewWalletsBlock,
  RetentionMonth,
  RetentionSummaryBlock,
  SeriesBucket,
  UsersGranularity,
  UsersResponse
} from './types.js';

const RETENTION_COHORTS = 6;
/** Monthly cohorts the retention summary looks at; month 6 needs cohorts at least 7 months old. */
const SUMMARY_COHORTS = 12;
const SUMMARY_MONTHS: ReadonlyArray<RetentionMonth['month']> = [1, 3, 6];
const USERS_GROUPS: readonly MetricGroup[] = ['activeUsers', 'signups', 'retention', 'wallets'];
const START_DAY = dayNumberFromIso(DATASET_START_DAY);

interface SeriesPlan {
  bucket: SeriesBucket;
  span: TimeWindow;
  buckets: TimeWindow[];
  /** Window of the breakdown value: the last day, 30 days or 365 days. */
  current: TimeWindow;
}

function planSeries(granularity: UsersGranularity, now: DayHour): SeriesPlan {
  switch (granularity) {
    case 'daily': {
      const span = dayWindow(now.day - 29, now.day, now.hour);
      return {
        bucket: 'day',
        span,
        buckets: dayBuckets(span),
        current: dayWindow(now.day, now.day, now.hour)
      };
    }
    case 'monthly': {
      const span = dayWindow(addMonths(now.day, -11), now.day, now.hour);
      return {
        bucket: 'month',
        span,
        buckets: monthBuckets(span),
        current: dayWindow(now.day - 29, now.day, now.hour)
      };
    }
    case 'yearly': {
      const span = dayWindow(yearStartOf(START_DAY), now.day, now.hour);
      return {
        bucket: 'year',
        span,
        buckets: yearBuckets(span),
        current: dayWindow(now.day - 364, now.day, now.hour)
      };
    }
  }
}

function activeMetric(
  networks: readonly NetworkId[],
  window: TimeWindow,
  days: number
): CountMetric {
  const previous = shiftWindow(window, -days);
  const source = sourceFor('activeUsers');
  return countMetric(
    source.activeUsersAcross(networks, window),
    source.activeUsersAcross(networks, previous)
  );
}

function retention(networks: readonly NetworkId[], now: DayHour): UsersResponse['retention'] {
  const cohorts: UsersResponse['retention'] = [];
  const retention = sourceFor('retention');
  // Only complete months: the most recent cohort is last month, with no later month yet.
  for (let monthsAgo = RETENTION_COHORTS; monthsAgo >= 1; monthsAgo -= 1) {
    const cohortStart = addMonths(now.day, -monthsAgo);
    const { size, retained } = retention.cohortAcross(networks, cohortStart, monthsAgo - 1);
    cohorts.push({ cohort: isoMonthOf(cohortStart), size, retained });
  }
  return cohorts;
}

function newWalletsIn(networks: readonly NetworkId[], window: TimeWindow): number {
  const source = sourceFor('wallets');
  return networks.reduce((sum, id) => sum + source.facts(id, window).newWallets, 0);
}

/**
 * Builds the New Wallets block. A wallet is a chain id and address of a B2C user; it counts on the
 * hour of its first verifiable appearance (see `LIVE_METRIC_GROUPS`). Wallets without one are not
 * counted and lower the coverage, so the figures are then a lower bound.
 */
function newWallets(
  networks: readonly NetworkId[],
  plan: SeriesPlan,
  point: DayHour,
  last30: TimeWindow,
  previous30: TimeWindow
): NewWalletsBlock {
  const source = sourceFor('wallets');
  const byNetwork = networks.map((id) => {
    const coverage = source.walletCoverage(id, point);
    return {
      network: id,
      label: networkProfile(id).label,
      newWallets: source.facts(id, plan.current).newWallets,
      wallets: coverage.wallets,
      verifiedWallets: coverage.verified
    };
  });
  const wallets = byNetwork.reduce((sum, item) => sum + item.wallets, 0);
  const verified = byNetwork.reduce((sum, item) => sum + item.verifiedWallets, 0);
  const since = source.walletsTrackingSince();
  return {
    source: source.kind,
    availability: verified < wallets ? 'partial' : 'available',
    reason: verified < wallets ? 'unverified_wallets' : null,
    asOf: liveAsOf('wallets'),
    definition: 'first_verifiable_appearance',
    trackingSince: since?.toISOString() ?? null,
    tile: countMetric(newWalletsIn(networks, last30), newWalletsIn(networks, previous30)),
    series: plan.buckets.map((bucket) => ({
      ...periodOf(bucket),
      newWallets: newWalletsIn(networks, bucket)
    })),
    byNetwork,
    coverage: { wallets, verifiedWallets: verified }
  };
}

/**
 * Builds the retention summary at 1, 3 and 6 months. A cohort counts for month N only when the N-th
 * month after its own is complete, so every rate compares cohorts that all had the chance to
 * return in that month.
 */
function retentionSummary(networks: readonly NetworkId[], now: DayHour): RetentionSummaryBlock {
  const source = sourceFor('retention');
  const cohorts: RetentionSummaryBlock['cohorts'] = [];
  const totals = new Map<RetentionMonth['month'], { eligible: number; size: number; kept: number }>(
    SUMMARY_MONTHS.map((month) => [month, { eligible: 0, size: 0, kept: 0 }])
  );
  for (let monthsAgo = SUMMARY_COHORTS; monthsAgo >= 1; monthsAgo -= 1) {
    const cohortStart = addMonths(now.day, -monthsAgo);
    // A cohort of `monthsAgo` months ago has `monthsAgo - 1` complete months after its own.
    const complete = monthsAgo - 1;
    const { size, retained } = source.cohortAcross(
      networks,
      cohortStart,
      Math.min(complete, SUMMARY_MONTHS.at(-1) ?? 0)
    );
    cohorts.push({
      cohort: isoMonthOf(cohortStart),
      size,
      retained: SUMMARY_MONTHS.map((month) => ({
        month,
        users: month <= complete ? (retained[month - 1] ?? 0) : null
      }))
    });
    for (const month of SUMMARY_MONTHS) {
      const total = totals.get(month);
      if (total !== undefined && month <= complete) {
        total.eligible += 1;
        total.size += size;
        total.kept += retained[month - 1] ?? 0;
      }
    }
  }
  const months: RetentionMonth[] = SUMMARY_MONTHS.map((month) => {
    const total = totals.get(month) ?? { eligible: 0, size: 0, kept: 0 };
    const rate = shareOf(total.kept, total.size);
    return {
      month,
      availability: rate === null ? 'unavailable' : 'available',
      reason: rate === null ? 'no_eligible_cohort' : null,
      eligibleCohorts: total.eligible,
      cohortUsers: total.size,
      retainedUsers: total.kept,
      rate
    };
  });
  const available = months.filter((month) => month.availability === 'available').length;
  return {
    source: source.kind,
    availability:
      available === months.length ? 'available' : available === 0 ? 'unavailable' : 'partial',
    reason: available === months.length ? null : 'no_eligible_cohort',
    asOf: liveAsOf('retention'),
    months,
    cohorts
  };
}

/**
 * Builds the Users dataset.
 *
 * Tiles compare trailing windows with the same span right before: today against the same hours of
 * yesterday, 30 days, 365 days. The series and the network breakdown follow the granularity.
 * Tiles, series totals and cohorts count a person once however many of the selected networks they
 * use; `byNetwork` and the `byNetwork` of each series point count per network, so a person active
 * on two networks appears in both and those rows can add up to more than the total. Each metric
 * group is live or synthetic as set in `LIVE_METRIC_GROUPS`.
 *
 * @param network - Network filter.
 * @param granularity - Series granularity.
 * @param now - Current instant; the dataset ends at its hour.
 * @returns The Users response.
 */
export function buildUsers(
  network: NetworkFilter,
  granularity: UsersGranularity,
  now: Date
): UsersResponse {
  const point = dayHourOf(now);
  const networks = networksFor(network);
  const plan = planSeries(granularity, point);
  const last30 = dayWindow(point.day - 29, point.day, point.hour);
  const previous30 = shiftWindow(last30, -30);
  const active = sourceFor('activeUsers');
  const signups = sourceFor('signups');

  return {
    meta: {
      ...provenanceOf(USERS_GROUPS),
      generatedAt: now.toISOString(),
      currency: 'USD',
      network,
      granularity,
      period: periodOf(plan.span),
      previousPeriod: null,
      bucket: plan.bucket
    },
    tiles: {
      dailyActiveUsers: activeMetric(networks, dayWindow(point.day, point.day, point.hour), 1),
      monthlyActiveUsers: activeMetric(networks, last30, 30),
      yearlyActiveUsers: activeMetric(
        networks,
        dayWindow(point.day - 364, point.day, point.hour),
        365
      ),
      newUsers: countMetric(
        signups.newUsersAcross(networks, last30),
        signups.newUsersAcross(networks, previous30)
      ),
      totalUsers: countMetric(
        signups.totalUsersAcross(networks, point),
        signups.totalUsersAcross(networks, previous30.end)
      )
    },
    series: plan.buckets.map((bucket) => {
      const byNetwork = networks.map((id) => ({
        network: id,
        activeUsers: active.activeUsers(id, bucket),
        newUsers: signups.facts(id, bucket).newUsers
      }));
      return {
        ...periodOf(bucket),
        activeUsers: active.activeUsersAcross(networks, bucket),
        newUsers: signups.newUsersAcross(networks, bucket),
        byNetwork
      };
    }),
    retention: retention(networks, point),
    byNetwork: networks.map((id) => ({
      network: id,
      label: networkProfile(id).label,
      activeUsers: active.activeUsers(id, plan.current),
      totalUsers: signups.totalUsersAt(id, point)
    })),
    newWallets: newWallets(networks, plan, point, last30, previous30),
    retentionSummary: retentionSummary(networks, point)
  };
}
