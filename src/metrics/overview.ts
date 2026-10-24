import { dayHourOf, periodOf, type TimeWindow } from './calendar.js';
import { type NetworkFilter, type NetworkId, networkProfile, networksFor } from './catalog.js';
import { type Facts, feesCents, volumeCents } from './facts.js';
import { centsToUsd, countMetric, moneyMetric } from './format.js';
import { resolveRange } from './ranges.js';
import { type MetricGroup, provenanceOf, sourceFor } from './sources.js';
import type { MetricsRange, OverviewResponse, RangeMeta } from './types.js';

const OVERVIEW_GROUPS: readonly MetricGroup[] = ['activity', 'activeUsers', 'signups'];

/**
 * Builds the `meta` object of a range response.
 *
 * @param network - Requested network filter.
 * @param range - Requested range.
 * @param now - Generation instant.
 * @param groups - Metric groups of the response, which set its provenance.
 * @returns The meta object.
 */
export function rangeMeta(
  network: NetworkFilter,
  range: MetricsRange,
  now: Date,
  groups: readonly MetricGroup[]
): RangeMeta {
  const resolved = resolveRange(range, dayHourOf(now));
  return {
    ...provenanceOf(groups),
    generatedAt: now.toISOString(),
    currency: 'USD',
    network,
    range,
    period: periodOf(resolved.current),
    previousPeriod: resolved.previous === null ? null : periodOf(resolved.previous),
    bucket: resolved.bucket
  };
}

interface NetworkTotals {
  network: NetworkId;
  facts: Facts;
  previous: Facts | null;
  activeUsers: number;
  previousActiveUsers: number | null;
  newUsers: number;
  previousNewUsers: number | null;
}

function totalsFor(
  network: NetworkId,
  current: TimeWindow,
  previous: TimeWindow | null
): NetworkTotals {
  const activity = sourceFor('activity');
  const active = sourceFor('activeUsers');
  const signups = sourceFor('signups');
  return {
    network,
    facts: activity.facts(network, current),
    previous: previous === null ? null : activity.facts(network, previous),
    activeUsers: active.activeUsers(network, current),
    previousActiveUsers: previous === null ? null : active.activeUsers(network, previous),
    newUsers: signups.facts(network, current).newUsers,
    previousNewUsers: previous === null ? null : signups.facts(network, previous).newUsers
  };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function sumOrNull<T>(items: readonly T[], pick: (item: T) => number | null): number | null {
  let total = 0;
  for (const item of items) {
    const value = pick(item);
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

/**
 * Builds the Overview dataset.
 *
 * Totals, series points and the network breakdown of a metric group come from the same source, so
 * tiles equal the sum of the breakdown and of the series. Each group is live or synthetic as set in
 * `LIVE_METRIC_GROUPS`.
 *
 * @param network - Network filter.
 * @param range - Time range.
 * @param now - Current instant; the dataset ends at its hour.
 * @returns The Overview response.
 */
export function buildOverview(
  network: NetworkFilter,
  range: MetricsRange,
  now: Date
): OverviewResponse {
  const resolved = resolveRange(range, dayHourOf(now));
  const networks = networksFor(network);
  const totals = networks.map((id) => totalsFor(id, resolved.current, resolved.previous));

  const activity = sourceFor('activity');
  const series = resolved.buckets.map((bucket) => {
    const byNetwork = networks.map((id) => {
      const facts = activity.facts(id, bucket);
      return {
        network: id,
        volume: volumeCents(facts),
        transactions: facts.transfers + facts.swaps
      };
    });
    return {
      ...periodOf(bucket),
      volumeUsd: centsToUsd(sum(byNetwork, (item) => item.volume)),
      transactions: sum(byNetwork, (item) => item.transactions),
      byNetwork: byNetwork.map((item) => ({
        network: item.network,
        volumeUsd: centsToUsd(item.volume),
        transactions: item.transactions
      }))
    };
  });

  return {
    meta: rangeMeta(network, range, now, OVERVIEW_GROUPS),
    tiles: {
      volumeUsd: moneyMetric(
        sum(totals, (t) => volumeCents(t.facts)),
        sumOrNull(totals, (t) => (t.previous === null ? null : volumeCents(t.previous)))
      ),
      transactions: countMetric(
        sum(totals, (t) => t.facts.transfers + t.facts.swaps),
        sumOrNull(totals, (t) =>
          t.previous === null ? null : t.previous.transfers + t.previous.swaps
        )
      ),
      feesUsd: moneyMetric(
        sum(totals, (t) => feesCents(t.facts)),
        sumOrNull(totals, (t) => (t.previous === null ? null : feesCents(t.previous)))
      ),
      activeUsers: countMetric(
        sum(totals, (t) => t.activeUsers),
        sumOrNull(totals, (t) => t.previousActiveUsers)
      ),
      newUsers: countMetric(
        sum(totals, (t) => t.newUsers),
        sumOrNull(totals, (t) => t.previousNewUsers)
      )
    },
    series,
    byNetwork: totals.map((t) => ({
      network: t.network,
      label: networkProfile(t.network).label,
      volumeUsd: centsToUsd(volumeCents(t.facts)),
      transactions: t.facts.transfers + t.facts.swaps,
      feesUsd: centsToUsd(feesCents(t.facts)),
      activeUsers: t.activeUsers,
      newUsers: t.newUsers
    }))
  };
}
