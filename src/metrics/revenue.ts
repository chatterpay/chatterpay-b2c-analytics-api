import { dayHourOf, hourIndexOf, periodOf } from './calendar.js';
import { type NetworkFilter, type NetworkId, networkProfile, networksFor } from './catalog.js';
import { type Facts, feesCents, sumAssets, volumeCents } from './facts.js';
import { centsToUsd, moneyMetric } from './format.js';
import { buildMasterWallets } from './holdings.js';
import { rangeMeta } from './overview.js';
import {
  activityTotals,
  buildAverageFee,
  buildFeesByProduct,
  buildPolymarketVolume
} from './products.js';
import { resolveRange } from './ranges.js';
import { sourceFor } from './sources.js';
import type { MetricsRange, RevenueResponse } from './types.js';

function assetsOf(facts: Facts): string[] {
  return [
    ...new Set([
      ...Object.keys(facts.transferVolume),
      ...Object.keys(facts.swapVolume),
      ...Object.keys(facts.transferFees),
      ...Object.keys(facts.swapFees)
    ])
  ];
}

/**
 * Builds the Revenue dataset from the `activity` metric group: the `fee` recorded on each counted
 * B2C operation when the group is live, synthetic fees otherwise. A recorded fee is what the
 * backend computed for the operation, not a reconciled charge.
 *
 * Fee totals equal transfer plus swap fees, and the sums of the network and asset breakdowns and
 * of the series. The average fee per transaction divides those fees by the counted transfers and
 * swaps; Polymarket volume and fees are `unavailable` because the B2C data does not record them
 * verifiably. Master wallets come from the balance snapshots and are balances, not revenue.
 *
 * @param network - Network filter.
 * @param range - Time range.
 * @param now - Current instant; the dataset ends at its hour.
 * @param visible - Networks visible in the analytics, which `all` covers; every network of the
 *   catalog when omitted.
 * @returns The Revenue response.
 */
export function buildRevenue(
  network: NetworkFilter,
  range: MetricsRange,
  now: Date,
  visible?: readonly NetworkId[]
): RevenueResponse {
  const resolved = resolveRange(range, dayHourOf(now));
  const networks = networksFor(network, visible);
  const activity = sourceFor('activity');
  const current = networks.map((id) => ({
    network: id,
    facts: activity.facts(id, resolved.current)
  }));
  const previousWindow = resolved.previous;
  const previous =
    previousWindow === null ? null : networks.map((id) => activity.facts(id, previousWindow));

  const total = (pick: (facts: Facts) => number): number =>
    current.reduce((sum, item) => sum + pick(item.facts), 0);
  const previousTotal = (pick: (facts: Facts) => number): number | null =>
    previous === null ? null : previous.reduce((sum, facts) => sum + pick(facts), 0);

  const transferFees = (facts: Facts): number => sumAssets(facts.transferFees);
  const swapFees = (facts: Facts): number => sumAssets(facts.swapFees);
  const swapVolume = (facts: Facts): number => sumAssets(facts.swapVolume);
  const currentTotals = activityTotals(current.map((item) => item.facts));
  const previousTotals = previous === null ? null : activityTotals(previous);

  const byAsset = current
    .flatMap(({ network: id, facts }) =>
      assetsOf(facts).map((asset) => ({
        network: id,
        asset,
        volume: (facts.transferVolume[asset] ?? 0) + (facts.swapVolume[asset] ?? 0),
        fees: (facts.transferFees[asset] ?? 0) + (facts.swapFees[asset] ?? 0)
      }))
    )
    .sort(
      (a, b) =>
        b.fees - a.fees || a.network.localeCompare(b.network) || a.asset.localeCompare(b.asset)
    );

  return {
    meta: rangeMeta(network, range, now, ['activity', 'balances']),
    tiles: {
      feesUsd: moneyMetric(total(feesCents), previousTotal(feesCents)),
      transferFeesUsd: moneyMetric(total(transferFees), previousTotal(transferFees)),
      swapFeesUsd: moneyMetric(total(swapFees), previousTotal(swapFees)),
      volumeUsd: moneyMetric(total(volumeCents), previousTotal(volumeCents)),
      swapVolumeUsd: moneyMetric(total(swapVolume), previousTotal(swapVolume))
    },
    series: resolved.buckets.map((bucket) => {
      const facts = networks.map((id) => activity.facts(id, bucket));
      const transfer = facts.reduce((sum, item) => sum + transferFees(item), 0);
      const swap = facts.reduce((sum, item) => sum + swapFees(item), 0);
      return {
        ...periodOf(bucket),
        feesUsd: centsToUsd(transfer + swap),
        transferFeesUsd: centsToUsd(transfer),
        swapFeesUsd: centsToUsd(swap)
      };
    }),
    byNetwork: current.map(({ network: id, facts }) => ({
      network: id,
      label: networkProfile(id).label,
      feesUsd: centsToUsd(feesCents(facts)),
      transferFeesUsd: centsToUsd(transferFees(facts)),
      swapFeesUsd: centsToUsd(swapFees(facts)),
      volumeUsd: centsToUsd(volumeCents(facts))
    })),
    byAsset: byAsset.map((item) => ({
      network: item.network,
      asset: item.asset,
      volumeUsd: centsToUsd(item.volume),
      feesUsd: centsToUsd(item.fees)
    })),
    avgFeePerTransaction: buildAverageFee(currentTotals, previousTotals),
    polymarketVolume: buildPolymarketVolume(),
    feesByProduct: buildFeesByProduct(currentTotals),
    masterWallets: buildMasterWallets(networks, hourIndexOf(now))
  };
}
