import { dayHourOf, hourIndexOf, periodOf } from './calendar.js';
import { type NetworkFilter, type NetworkId, networkProfile, networksFor } from './catalog.js';
import type { Facts, MoneyKey } from './facts.js';
import { centsToUsd } from './format.js';
import { buildMasterWallets } from './holdings.js';
import { rangeMeta } from './overview.js';
import {
  activityTotals,
  buildAverageFee,
  buildFeesByProduct,
  buildPolymarketAccounts,
  buildPolymarketVolume
} from './products.js';
import { resolveRange } from './ranges.js';
import { sourceFor } from './sources.js';
import {
  type HiddenAssets,
  NO_HIDDEN_ASSETS,
  scopedActivity,
  tokenScopeOf
} from './token-scope.js';
import type { MetricsRange, RevenueResponse, ValuedMoneyMetric } from './types.js';
import {
  buildValuation,
  FEE_KEYS,
  VOLUME_KEYS,
  valuedMoneyMetric,
  valuedOf,
  valuedUsd
} from './valuation.js';

/** Assets of the facts, valued or not: an asset without any USD value has no cents entry. */
function assetsOf(facts: Facts): string[] {
  return [
    ...new Set(
      [...VOLUME_KEYS, ...FEE_KEYS].flatMap((key) => [
        ...Object.keys(facts[key]),
        ...Object.keys(facts.unpriced[key])
      ])
    )
  ];
}

/** Cents of an asset in some figures; `null` when an operation of the asset has no USD value. */
function assetCents(facts: Facts, asset: string, keys: readonly MoneyKey[]): number | null {
  const unpriced = keys.reduce((sum, key) => sum + (facts.unpriced[key][asset] ?? 0), 0);
  return unpriced > 0 ? null : keys.reduce((sum, key) => sum + (facts[key][asset] ?? 0), 0);
}

/**
 * Builds the Revenue dataset from the `activity` metric group: the `fee` recorded on each counted
 * B2C operation when the group is live, synthetic fees otherwise. A recorded fee is what the
 * backend computed for the operation, not a reconciled charge.
 *
 * Fee totals equal transfer plus swap fees, and the sums of the network and asset breakdowns and
 * of the series. Operations without a USD value are left out of every money figure; the tiles
 * then answer `partial` (subtotal of the valued ones) or `unavailable`, `valuation` says which
 * networks and assets, an asset row has no value for a figure it was not valued in, and a network
 * row or series point whose operations have none answers `null` instead of zero. The
 * average fee per transaction divides those fees by the counted transfers and swaps; Polymarket
 * volume and fees are `unavailable` because the B2C data does not record them verifiably. Master
 * wallets come from the balance snapshots and are balances, not revenue. Polymarket accounts
 * come from the last ingestion run and cover every network.
 *
 * Hidden tokens (`meta.tokenScope`) leave every money figure, the asset breakdown, the average
 * fee and the master wallet balances before anything is added.
 *
 * @param network - Network filter.
 * @param range - Time range.
 * @param now - Current instant; the dataset ends at its hour.
 * @param visible - Networks visible in the analytics, which `all` covers; every network of the
 *   catalog when omitted.
 * @param hidden - Hidden tokens per network.
 * @returns The Revenue response.
 */
export function buildRevenue(
  network: NetworkFilter,
  range: MetricsRange,
  now: Date,
  visible?: readonly NetworkId[],
  hidden: HiddenAssets = NO_HIDDEN_ASSETS
): RevenueResponse {
  const resolved = resolveRange(range, dayHourOf(now));
  const networks = networksFor(network, visible);
  const source = sourceFor('activity');
  const activity = scopedActivity(source, hidden);
  const current = networks.map((id) => ({
    network: id,
    facts: activity(id, resolved.current)
  }));
  const previousWindow = resolved.previous;
  const previous =
    previousWindow === null ? null : networks.map((id) => activity(id, previousWindow));

  const valued = (keys: readonly MoneyKey[]): ValuedMoneyMetric =>
    valuedMoneyMetric(
      valuedOf(
        current.map((item) => item.facts),
        keys
      ),
      previous === null ? null : valuedOf(previous, keys)
    );

  const currentTotals = activityTotals(current.map((item) => item.facts));
  const previousTotals = previous === null ? null : activityTotals(previous);

  const byAsset = current
    .flatMap(({ network: id, facts }) =>
      assetsOf(facts).map((asset) => ({
        network: id,
        asset,
        volume: assetCents(facts, asset, VOLUME_KEYS),
        fees: assetCents(facts, asset, FEE_KEYS)
      }))
    )
    .sort(
      (a, b) =>
        (b.fees ?? -1) - (a.fees ?? -1) ||
        a.network.localeCompare(b.network) ||
        a.asset.localeCompare(b.asset)
    );

  return {
    meta: rangeMeta(
      network,
      range,
      now,
      ['activity', 'balances', 'countries'],
      tokenScopeOf(networks, hidden, source)
    ),
    tiles: {
      feesUsd: valued(FEE_KEYS),
      transferFeesUsd: valued(['transferFees']),
      swapFeesUsd: valued(['swapFees']),
      volumeUsd: valued(VOLUME_KEYS),
      swapVolumeUsd: valued(['swapVolume'])
    },
    series: resolved.buckets.map((bucket) => {
      const facts = networks.map((id) => activity(id, bucket));
      return {
        ...periodOf(bucket),
        feesUsd: valuedUsd(facts, FEE_KEYS),
        transferFeesUsd: valuedUsd(facts, ['transferFees']),
        swapFeesUsd: valuedUsd(facts, ['swapFees'])
      };
    }),
    byNetwork: current.map(({ network: id, facts }) => ({
      network: id,
      label: networkProfile(id).label,
      feesUsd: valuedUsd([facts], FEE_KEYS),
      transferFeesUsd: valuedUsd([facts], ['transferFees']),
      swapFeesUsd: valuedUsd([facts], ['swapFees']),
      volumeUsd: valuedUsd([facts], VOLUME_KEYS)
    })),
    byAsset: byAsset.map((item) => ({
      network: item.network,
      asset: item.asset,
      volumeUsd: item.volume === null ? null : centsToUsd(item.volume),
      feesUsd: item.fees === null ? null : centsToUsd(item.fees)
    })),
    valuation: buildValuation(current),
    avgFeePerTransaction: buildAverageFee(currentTotals, previousTotals),
    polymarketVolume: buildPolymarketVolume(),
    polymarketAccounts: buildPolymarketAccounts(resolved, hourIndexOf(now)),
    feesByProduct: buildFeesByProduct(currentTotals),
    masterWallets: buildMasterWallets(networks, hourIndexOf(now), hidden)
  };
}
