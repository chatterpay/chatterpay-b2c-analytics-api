import { dayHourOf, periodOf, type TimeWindow } from './calendar.js';
import {
  DATASET_VERSION,
  type NetworkFilter,
  type NetworkId,
  networkProfile,
  networksFor
} from './catalog.js';
import { activeUsersInWindow, type Facts, factsInWindow, feesCents, volumeCents } from './facts.js';
import { centsToUsd, countMetric, moneyMetric } from './format.js';
import { resolveRange } from './ranges.js';
import type { MetricsRange, OverviewResponse, RangeMeta } from './types.js';

/**
 * Builds the `meta` object of a range response.
 *
 * @param network - Requested network filter.
 * @param range - Requested range.
 * @param now - Generation instant.
 * @returns The meta object.
 */
export function rangeMeta(network: NetworkFilter, range: MetricsRange, now: Date): RangeMeta {
  const resolved = resolveRange(range, dayHourOf(now));
  return {
    datasetVersion: DATASET_VERSION,
    dataStatus: 'mock',
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
}

function totalsFor(
  network: NetworkId,
  current: TimeWindow,
  previous: TimeWindow | null
): NetworkTotals {
  return {
    network,
    facts: factsInWindow(network, current),
    previous: previous === null ? null : factsInWindow(network, previous),
    activeUsers: activeUsersInWindow(network, current),
    previousActiveUsers: previous === null ? null : activeUsersInWindow(network, previous)
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
 * Totals, series points and the network breakdown come from the same facts, so tiles equal the sum
 * of the breakdown and of the series.
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

  const series = resolved.buckets.map((bucket) => {
    const byNetwork = networks.map((id) => {
      const facts = factsInWindow(id, bucket);
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
    meta: rangeMeta(network, range, now),
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
        sum(totals, (t) => t.facts.newUsers),
        sumOrNull(totals, (t) => (t.previous === null ? null : t.previous.newUsers))
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
      newUsers: t.facts.newUsers
    }))
  };
}
