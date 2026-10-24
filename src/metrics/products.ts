import { shareOf, tenThousandthsToUsd } from './decimal.js';
import { type Facts, sumAssets } from './facts.js';
import { centsToUsd, changeRatio } from './format.js';
import { liveAsOf, sourceFor } from './sources.js';
import type {
  AverageFeeBlock,
  BlockStatus,
  FeesByProductBlock,
  PolymarketVolumeBlock,
  VolumeByProductBlock
} from './types.js';

/** Activity of the selected networks added together. */
export interface ActivityTotals {
  transfers: number;
  swaps: number;
  transferVolumeCents: number;
  swapVolumeCents: number;
  transferFeesCents: number;
  swapFeesCents: number;
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
    swapFeesCents: 0
  };
  for (const facts of items) {
    totals.transfers += facts.transfers;
    totals.swaps += facts.swaps;
    totals.transferVolumeCents += sumAssets(facts.transferVolume);
    totals.swapVolumeCents += sumAssets(facts.swapVolume);
    totals.transferFeesCents += sumAssets(facts.transferFees);
    totals.swapFeesCents += sumAssets(facts.swapFees);
  }
  return totals;
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
 * `transfer`; the available products add up to the total volume of the range.
 *
 * @param totals - Activity of the range.
 * @returns The block; `partial` because Polymarket has no verifiable volume.
 */
export function buildVolumeByProduct(totals: ActivityTotals): VolumeByProductBlock {
  const total = totals.transferVolumeCents + totals.swapVolumeCents;
  return {
    ...activityStatus('partial'),
    items: [
      {
        product: 'transfer',
        availability: 'available',
        reason: null,
        volumeUsd: centsToUsd(totals.transferVolumeCents),
        transactions: totals.transfers,
        share: shareOf(totals.transferVolumeCents, total)
      },
      {
        product: 'swap',
        availability: 'available',
        reason: null,
        volumeUsd: centsToUsd(totals.swapVolumeCents),
        transactions: totals.swaps,
        share: shareOf(totals.swapVolumeCents, total)
      },
      { ...POLYMARKET_UNAVAILABLE, volumeUsd: null, transactions: null, share: null }
    ]
  };
}

/**
 * Builds the fees per product: the `fee` recorded on each counted operation, valued in USD; they
 * are not reconciled charges.
 *
 * @param totals - Activity of the range.
 * @returns The block; `partial` because Polymarket has no recorded fee.
 */
export function buildFeesByProduct(totals: ActivityTotals): FeesByProductBlock {
  const total = totals.transferFeesCents + totals.swapFeesCents;
  return {
    ...activityStatus('partial'),
    items: [
      {
        product: 'transfer',
        availability: 'available',
        reason: null,
        feesUsd: centsToUsd(totals.transferFeesCents),
        share: shareOf(totals.transferFeesCents, total)
      },
      {
        product: 'swap',
        availability: 'available',
        reason: null,
        feesUsd: centsToUsd(totals.swapFeesCents),
        share: shareOf(totals.swapFeesCents, total)
      },
      { ...POLYMARKET_UNAVAILABLE, feesUsd: null, share: null }
    ]
  };
}

/** Recorded fees per counted operation in 1/10000 USD; `null` without operations. */
function averageFee(totals: ActivityTotals): number | null {
  const transactions = totals.transfers + totals.swaps;
  if (transactions === 0) {
    return null;
  }
  return Math.round(((totals.transferFeesCents + totals.swapFeesCents) * 100) / transactions);
}

/**
 * Builds the average fee per transaction: recorded transfer and swap fees divided by the counted
 * transfers and swaps. It is a separate figure from the fee rate (fees over volume).
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
  const previousValue = previous === null ? null : averageFee(previous);
  return {
    source: sourceFor('activity').kind,
    availability: value === null ? 'unavailable' : 'available',
    reason: value === null ? 'no_transactions' : null,
    asOf: liveAsOf('activity'),
    valueUsd: value === null ? null : tenThousandthsToUsd(value),
    previousUsd: previousValue === null ? null : tenThousandthsToUsd(previousValue),
    changeRatio: value === null ? null : changeRatio(value, previousValue),
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
