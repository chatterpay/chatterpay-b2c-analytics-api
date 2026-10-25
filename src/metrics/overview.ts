import { dayHourOf, hourIndexOf, periodOf, type TimeWindow } from './calendar.js';
import { type NetworkFilter, type NetworkId, networkProfile, networksFor } from './catalog.js';
import type { Facts, MoneyKey } from './facts.js';
import { countMetric } from './format.js';
import { buildTopCountries, buildTopTokens, buildTvl } from './holdings.js';
import { activityTotals, buildVolumeByProduct } from './products.js';
import { resolveRange } from './ranges.js';
import { type MetricGroup, provenanceOf, sourceFor } from './sources.js';
import type { MetricsRange, OverviewResponse, RangeMeta } from './types.js';
import {
  buildValuation,
  FEE_KEYS,
  type ValuedCents,
  VOLUME_KEYS,
  valuedMoneyMetric,
  valuedOf,
  valuedUsd
} from './valuation.js';

const OVERVIEW_GROUPS: readonly MetricGroup[] = [
  'activity',
  'activeUsers',
  'signups',
  'balances',
  'countries'
];

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
  newUsers: number;
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
    newUsers: signups.facts(network, current).newUsers
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

/** Valued figures of the previous period; `null` when the range has none. */
function previousValued(
  totals: readonly NetworkTotals[],
  keys: readonly MoneyKey[]
): ValuedCents | null {
  const previous = totals.flatMap((t) => (t.previous === null ? [] : [t.previous]));
  return previous.length < totals.length ? null : valuedOf(previous, keys);
}

/**
 * Builds the Overview dataset.
 *
 * Totals, series points and the network breakdown of a metric group come from the same source, so
 * money and transaction tiles equal the sum of the breakdown and of the series. User tiles count a
 * person once however many of the selected networks they use, while `byNetwork` counts per
 * network, so its user rows can add up to more than the tile. Each group is live or synthetic as
 * set in `LIVE_METRIC_GROUPS`.
 *
 * TVL and Top Tokens come from the balance snapshots and Top Countries from the country counts of
 * the last ingestion run; each block states its own availability and the instant it reflects.
 *
 * @param network - Network filter.
 * @param range - Time range.
 * @param now - Current instant; the dataset ends at its hour.
 * @param visible - Networks visible in the analytics, which `all` covers; every network of the
 *   catalog when omitted.
 * @returns The Overview response.
 */
export function buildOverview(
  network: NetworkFilter,
  range: MetricsRange,
  now: Date,
  visible?: readonly NetworkId[]
): OverviewResponse {
  const resolved = resolveRange(range, dayHourOf(now));
  const networks = networksFor(network, visible);
  const totals = networks.map((id) => totalsFor(id, resolved.current, resolved.previous));

  const activity = sourceFor('activity');
  const active = sourceFor('activeUsers');
  const signups = sourceFor('signups');
  const series = resolved.buckets.map((bucket) => {
    const byNetwork = networks.map((id) => {
      const facts = activity.facts(id, bucket);
      return { network: id, facts, transactions: facts.transfers + facts.swaps };
    });
    return {
      ...periodOf(bucket),
      volumeUsd: valuedUsd(
        byNetwork.map((item) => item.facts),
        VOLUME_KEYS
      ),
      transactions: sum(byNetwork, (item) => item.transactions),
      byNetwork: byNetwork.map((item) => ({
        network: item.network,
        volumeUsd: valuedUsd([item.facts], VOLUME_KEYS),
        transactions: item.transactions
      }))
    };
  });

  return {
    meta: rangeMeta(network, range, now, OVERVIEW_GROUPS),
    tiles: {
      volumeUsd: valuedMoneyMetric(
        valuedOf(
          totals.map((t) => t.facts),
          VOLUME_KEYS
        ),
        previousValued(totals, VOLUME_KEYS)
      ),
      transactions: countMetric(
        sum(totals, (t) => t.facts.transfers + t.facts.swaps),
        sumOrNull(totals, (t) =>
          t.previous === null ? null : t.previous.transfers + t.previous.swaps
        )
      ),
      feesUsd: valuedMoneyMetric(
        valuedOf(
          totals.map((t) => t.facts),
          FEE_KEYS
        ),
        previousValued(totals, FEE_KEYS)
      ),
      activeUsers: countMetric(
        active.activeUsersAcross(networks, resolved.current),
        resolved.previous === null ? null : active.activeUsersAcross(networks, resolved.previous)
      ),
      newUsers: countMetric(
        signups.newUsersAcross(networks, resolved.current),
        resolved.previous === null ? null : signups.newUsersAcross(networks, resolved.previous)
      )
    },
    series,
    byNetwork: totals.map((t) => ({
      network: t.network,
      label: networkProfile(t.network).label,
      volumeUsd: valuedUsd([t.facts], VOLUME_KEYS),
      transactions: t.facts.transfers + t.facts.swaps,
      feesUsd: valuedUsd([t.facts], FEE_KEYS),
      activeUsers: t.activeUsers,
      newUsers: t.newUsers
    })),
    valuation: buildValuation(totals.map((t) => ({ network: t.network, facts: t.facts }))),
    tvl: buildTvl(networks, resolved),
    topTokens: buildTopTokens(networks, resolved),
    topCountries: buildTopCountries(network, hourIndexOf(now), visible),
    volumeByProduct: buildVolumeByProduct(activityTotals(totals.map((t) => t.facts)))
  };
}
