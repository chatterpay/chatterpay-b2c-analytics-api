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
    networks.reduce((sum, id) => sum + source.activeUsers(id, window), 0),
    networks.reduce((sum, id) => sum + source.activeUsers(id, previous), 0)
  );
}

function retention(networks: readonly NetworkId[], now: DayHour): UsersResponse['retention'] {
  const cohorts: UsersResponse['retention'] = [];
  const signups = sourceFor('signups');
  const retention = sourceFor('retention');
  // Only complete months: the most recent cohort is last month, with no later month yet.
  for (let monthsAgo = RETENTION_COHORTS; monthsAgo >= 1; monthsAgo -= 1) {
    const cohortStart = addMonths(now.day, -monthsAgo);
    const cohortWindow = dayWindow(cohortStart, addMonths(now.day, -monthsAgo + 1) - 1);
    let size = 0;
    const retained: number[] = new Array<number>(monthsAgo - 1).fill(0);
    for (const id of networks) {
      const networkSize = signups.facts(id, cohortWindow).newUsers;
      size += networkSize;
      retention.retained(id, cohortStart, networkSize, monthsAgo - 1).forEach((value, index) => {
        retained[index] = (retained[index] ?? 0) + value;
      });
    }
    cohorts.push({ cohort: isoMonthOf(cohortStart), size, retained });
  }
  return cohorts;
}

/**
 * Builds the Users dataset.
 *
 * Tiles compare trailing windows with the same span right before: today against the same hours of
 * yesterday, 30 days, 365 days. The series and the network breakdown follow the granularity.
 * Users are counted per network; a person active on two networks counts once on each. Each metric
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
        networks.reduce((sum, id) => sum + signups.facts(id, last30).newUsers, 0),
        networks.reduce((sum, id) => sum + signups.facts(id, previous30).newUsers, 0)
      ),
      totalUsers: countMetric(
        networks.reduce((sum, id) => sum + signups.totalUsersAt(id, point), 0),
        networks.reduce((sum, id) => sum + signups.totalUsersAt(id, previous30.end), 0)
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
        activeUsers: byNetwork.reduce((sum, item) => sum + item.activeUsers, 0),
        newUsers: byNetwork.reduce((sum, item) => sum + item.newUsers, 0),
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
