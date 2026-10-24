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
import { countMetric } from './format.js';
import { type MetricGroup, provenanceOf, sourceFor } from './sources.js';
import type { CountMetric, SeriesBucket, UsersGranularity, UsersResponse } from './types.js';

const RETENTION_COHORTS = 6;
const USERS_GROUPS: readonly MetricGroup[] = ['activeUsers', 'signups', 'retention'];
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
    }))
  };
}
