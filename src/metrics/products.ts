import { shareOf, tenThousandthsToUsd } from './decimal.js';
import { type Facts, sumAssets } from './facts.js';
import { centsToUsd, changeRatio } from './format.js';
import { liveAsOf, sourceFor } from './sources.js';
import type {
  Availability,
  AverageFeeBlock,
  BlockStatus,
  FeesByProductBlock,
  PolymarketVolumeBlock,
  UnavailableReason,
  VolumeByProductBlock
} from './types.js';
import { valuedAvailability, valuedReason } from './valuation.js';

/**
 * Activity of the selected networks added together. Cents are those of the valued operations;
 * the `unpriced*` counters are the operations left out of each figure for lack of a USD value.
 */
export interface ActivityTotals {
  transfers: number;
  swaps: number;
  transferVolumeCents: number;
  swapVolumeCents: number;
  transferFeesCents: number;
  swapFeesCents: number;
  unpricedTransferVolume: number;
  unpricedSwapVolume: number;
  unpricedTransferFees: number;
  unpricedSwapFees: number;
}

/**
 * Adds the facts of several networks.
 *
 * @param items - Facts of each network over the same window.
 * @returns The totals.
 */
export function activityTotals(items: readonly Facts[]): ActivityTotals {
  const totals: ActivityTotals = {
    transfers: 0,
    swaps: 0,
    transferVolumeCents: 0,
    swapVolumeCents: 0,
    transferFeesCents: 0,
    swapFeesCents: 0,
    unpricedTransferVolume: 0,
    unpricedSwapVolume: 0,
    unpricedTransferFees: 0,
    unpricedSwapFees: 0
  };
  for (const facts of items) {
    totals.transfers += facts.transfers;
    totals.swaps += facts.swaps;
    totals.transferVolumeCents += sumAssets(facts.transferVolume);
    totals.swapVolumeCents += sumAssets(facts.swapVolume);
    totals.transferFeesCents += sumAssets(facts.transferFees);
    totals.swapFeesCents += sumAssets(facts.swapFees);
    totals.unpricedTransferVolume += sumAssets(facts.unpriced.transferVolume);
    totals.unpricedSwapVolume += sumAssets(facts.unpriced.swapVolume);
    totals.unpricedTransferFees += sumAssets(facts.unpriced.transferFees);
    totals.unpricedSwapFees += sumAssets(facts.unpriced.swapFees);
  }
  return totals;
}

/** Availability, reason and value of one product figure; the value is `null` when unavailable. */
function productFigure(
  cents: number,
  operations: number,
  unpriced: number
): { availability: Availability; reason: UnavailableReason | null; usd: string | null } {
  const availability = valuedAvailability({ cents, operations, unpriced });
  return {
    availability,
    reason: valuedReason(availability),
    usd: availability === 'unavailable' ? null : centsToUsd(cents)
  };
}

function activityStatus(availability: BlockStatus['availability']): BlockStatus {
  return {
    source: sourceFor('activity').kind,
    availability,
    reason: availability === 'available' ? null : 'not_recorded',
    asOf: liveAsOf('activity')
  };
}

/**
 * Polymarket orders are recorded with the amount requested and `fee: 0`; the executed amount of a
 * fill and the fee charged are not recorded, so the product has no volume or fee to report.
 */
const POLYMARKET_UNAVAILABLE = {
  product: 'polymarket',
  availability: 'unavailable',
  reason: 'not_recorded'
} as const;

/**
 * Builds the volume per product. A swap counts once, in `swap`, on its input side, and never in
 * `transfer`; the available products add up to the total volume of the range. A product with
 * operations without a USD value is `partial` with the subtotal of the valued ones, or
 * `unavailable` when none has one; `transactions` counts them all and shares are of the subtotals.
 *
 * @param totals - Activity of the range.
 * @returns The block; `partial` because Polymarket has no verifiable volume.
 */
export function buildVolumeByProduct(totals: ActivityTotals): VolumeByProductBlock {
  const total = totals.transferVolumeCents + totals.swapVolumeCents;
  const transfer = productFigure(
    totals.transferVolumeCents,
    totals.transfers,
    totals.unpricedTransferVolume
  );
  const swap = productFigure(totals.swapVolumeCents, totals.swaps, totals.unpricedSwapVolume);
  return {
    ...activityStatus('partial'),
    items: [
      {
        product: 'transfer',
        availability: transfer.availability,
        reason: transfer.reason,
        volumeUsd: transfer.usd,
        transactions: totals.transfers,
        share: transfer.usd === null ? null : shareOf(totals.transferVolumeCents, total)
      },
      {
        product: 'swap',
        availability: swap.availability,
        reason: swap.reason,
        volumeUsd: swap.usd,
        transactions: totals.swaps,
        share: swap.usd === null ? null : shareOf(totals.swapVolumeCents, total)
      },
      { ...POLYMARKET_UNAVAILABLE, volumeUsd: null, transactions: null, share: null }
    ]
  };
}

/**
 * Builds the fees per product: the `fee` recorded on each counted operation, valued in USD; they
 * are not reconciled charges. A product with fees without a USD value is `partial` or
 * `unavailable`, as in {@link buildVolumeByProduct}.
 *
 * @param totals - Activity of the range.
 * @returns The block; `partial` because Polymarket has no recorded fee.
 */
export function buildFeesByProduct(totals: ActivityTotals): FeesByProductBlock {
  const total = totals.transferFeesCents + totals.swapFeesCents;
  const transfer = productFigure(
    totals.transferFeesCents,
    totals.transfers,
    totals.unpricedTransferFees
  );
  const swap = productFigure(totals.swapFeesCents, totals.swaps, totals.unpricedSwapFees);
  return {
    ...activityStatus('partial'),
    items: [
      {
        product: 'transfer',
        availability: transfer.availability,
        reason: transfer.reason,
        feesUsd: transfer.usd,
        share: transfer.usd === null ? null : shareOf(totals.transferFeesCents, total)
      },
      {
        product: 'swap',
        availability: swap.availability,
        reason: swap.reason,
        feesUsd: swap.usd,
        share: swap.usd === null ? null : shareOf(totals.swapFeesCents, total)
      },
      { ...POLYMARKET_UNAVAILABLE, feesUsd: null, share: null }
    ]
  };
}

/** Operations whose fee has a USD value, the divisor of the average fee. */
function valuedFeeOperations(totals: ActivityTotals): number {
  return totals.transfers + totals.swaps - totals.unpricedTransferFees - totals.unpricedSwapFees;
}

/** Recorded fees per operation with a valued fee, in 1/10000 USD; `null` without any. */
function averageFee(totals: ActivityTotals): number | null {
  const transactions = valuedFeeOperations(totals);
  if (transactions <= 0) {
    return null;
  }
  return Math.round(((totals.transferFeesCents + totals.swapFeesCents) * 100) / transactions);
}

/**
 * Builds the average fee per transaction: recorded transfer and swap fees divided by the counted
 * transfers and swaps. It is a separate figure from the fee rate (fees over volume). Operations
 * whose fee has no USD value are left out of both terms: the block is then `partial`, the average
 * of the others, or `unavailable` when no fee has a value. The comparison value is served only for
 * a previous period with every fee valued.
 *
 * @param current - Activity of the range.
 * @param previous - Activity of the previous period; `null` when the range has none.
 * @returns The block; `unavailable` when the range has no counted operation.
 */
export function buildAverageFee(
  current: ActivityTotals,
  previous: ActivityTotals | null
): AverageFeeBlock {
  const value = averageFee(current);
  const unpriced = current.unpricedTransferFees + current.unpricedSwapFees;
  const previousComplete =
    previous !== null && previous.unpricedTransferFees + previous.unpricedSwapFees === 0;
  const previousValue = previous === null || !previousComplete ? null : averageFee(previous);
  const availability: Availability =
    value === null ? 'unavailable' : unpriced > 0 ? 'partial' : 'available';
  const reason: UnavailableReason | null =
    current.transfers + current.swaps === 0 ? 'no_transactions' : valuedReason(availability);
  return {
    source: sourceFor('activity').kind,
    availability,
    reason,
    asOf: liveAsOf('activity'),
    valueUsd: value === null ? null : tenThousandthsToUsd(value),
    previousUsd: previousValue === null ? null : tenThousandthsToUsd(previousValue),
    changeRatio:
      value === null || availability !== 'available' ? null : changeRatio(value, previousValue),
    transactions: current.transfers + current.swaps,
    previousTransactions: previous === null ? null : previous.transfers + previous.swaps
  };
}

/**
 * Builds the Polymarket volume block.
 *
 * @returns Always `unavailable`: see {@link POLYMARKET_UNAVAILABLE}.
 */
export function buildPolymarketVolume(): PolymarketVolumeBlock {
  return { ...activityStatus('unavailable'), valueUsd: null };
}
