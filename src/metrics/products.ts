import type { TimeWindow } from './calendar.js';
import type { NetworkId } from './catalog.js';
import { shareOf, tenThousandthsToUsd } from './decimal.js';
import { type Facts, sumAssets } from './facts.js';
import { centsToUsd, changeRatio, countMetric } from './format.js';
import type { ResolvedRange } from './ranges.js';
import { liveAsOf, snapshotsFor, sourceFor } from './sources.js';
import type {
  Availability,
  AverageFeeBlock,
  BlockStatus,
  FeesByProductBlock,
  PolymarketAccountsBlock,
  PolymarketVolumeBlock,
  TradedTokensBlock,
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

/**
 * Builds the most traded tokens: counted transfers and swaps per network and asset in the range, a
 * swap under its input asset, by operations descending. `volumeUsd` is the transfer plus swap
 * volume of the asset, `null` when an operation of it has no USD value; the block is then
 * `partial` (`unpriced_assets`). Balances are a different figure: see Top Tokens. A build without
 * the operations per asset (builds stored before they were counted, synthetic data) answers
 * `unavailable` (`not_recorded`) instead of ranking by volume.
 *
 * @param items - Facts of each selected network over the range, hidden tokens already left out.
 * @param countsByAsset - Whether the source counts operations per asset.
 * @returns The block.
 */
export function buildTradedTokens(
  items: ReadonlyArray<{ network: NetworkId; facts: Facts }>,
  countsByAsset: boolean
): TradedTokensBlock {
  const status = {
    source: sourceFor('activity').kind,
    asOf: liveAsOf('activity')
  };
  if (!countsByAsset) {
    return { ...status, availability: 'unavailable', reason: 'not_recorded', items: [] };
  }
  const order = new Map(items.map((item, index) => [item.network, index]));
  const rows = items.flatMap(({ network, facts }) => {
    const transfers = facts.transfersByAsset ?? {};
    const swaps = facts.swapsByAsset ?? {};
    return [...new Set([...Object.keys(transfers), ...Object.keys(swaps)])].map((asset) => {
      const unpriced =
        (facts.unpriced.transferVolume[asset] ?? 0) + (facts.unpriced.swapVolume[asset] ?? 0);
      const cents = (facts.transferVolume[asset] ?? 0) + (facts.swapVolume[asset] ?? 0);
      return {
        network,
        asset,
        operations: (transfers[asset] ?? 0) + (swaps[asset] ?? 0),
        volumeUsd: unpriced > 0 ? null : centsToUsd(cents)
      };
    });
  });
  const counted = rows
    .filter((row) => row.operations > 0)
    .sort(
      (left, right) =>
        right.operations - left.operations ||
        (order.get(left.network) ?? 0) - (order.get(right.network) ?? 0) ||
        left.asset.localeCompare(right.asset)
    );
  const unpriced = counted.some((row) => row.volumeUsd === null);
  return {
    ...status,
    availability: unpriced ? 'partial' : 'available',
    reason: unpriced ? 'unpriced_assets' : null,
    items: counted
  };
}

function hourSpan(window: TimeWindow): { first: number; last: number } {
  return {
    first: window.start.day * 24 + window.start.hour,
    last: window.end.day * 24 + window.end.hour
  };
}

function createdIn(
  perHour: ReadonlyArray<{ hour: number; accounts: number }>,
  window: TimeWindow
): number {
  const { first, last } = hourSpan(window);
  return perHour.reduce(
    (sum, item) => sum + (item.hour >= first && item.hour <= last ? item.accounts : 0),
    0
  );
}

/**
 * Builds the Polymarket accounts block from the last ingestion run: users whose B2C document has a
 * `polymarket_account` with a valid Polygon address. An account is a Polygon wallet outside the
 * networks of the catalog, so the counts cover every user whatever the network filter
 * (`scope: all_networks`). Accounts are not volume: orders keep the amount requested and no
 * executed amount or fee, so Polymarket volume and fees stay `not_recorded`. `newAccounts`
 * counts creation dates inside the period and the previous one; accounts without a creation date
 * leave the block `partial` (`undated_accounts`). No address is exposed.
 *
 * @param resolved - Range windows.
 * @param now - Current hour, in hours since 1970-01-01T00:00Z.
 * @returns The block; `unavailable` (`no_snapshot`) when no run counted the accounts.
 */
export function buildPolymarketAccounts(
  resolved: ResolvedRange,
  now: number
): PolymarketAccountsBlock {
  const source = snapshotsFor('countries');
  const run = source.latestRun(now);
  const counts = run?.polymarket;
  if (run === null || counts === undefined) {
    return {
      source: source.kind,
      availability: 'unavailable',
      reason: 'no_snapshot',
      asOf: null,
      scope: 'all_networks',
      accounts: null,
      invalidAccounts: 0,
      undatedAccounts: 0,
      newAccounts: null
    };
  }
  const previous = resolved.previous;
  return {
    source: source.kind,
    availability: counts.undated > 0 ? 'partial' : 'available',
    reason: counts.undated > 0 ? 'undated_accounts' : null,
    asOf: source.kind === 'live' ? run.takenAt.toISOString() : null,
    scope: 'all_networks',
    accounts: counts.accounts,
    invalidAccounts: counts.invalid,
    undatedAccounts: counts.undated,
    newAccounts: countMetric(
      createdIn(counts.createdPerHour, resolved.current),
      previous === null ? null : createdIn(counts.createdPerHour, previous)
    )
  };
}
