import type { NetworkId } from './catalog.js';
import { type Facts, type MoneyKey, sumAssets } from './facts.js';
import { centsToUsd, changeRatio } from './format.js';
import { liveAsOf, liveValuation, sourceFor } from './sources.js';
import type {
  Availability,
  UnavailableReason,
  ValuationBlock,
  ValuedMoneyMetric
} from './types.js';

/** Volume figures: transfers plus the input side of swaps. */
export const VOLUME_KEYS: readonly MoneyKey[] = ['transferVolume', 'swapVolume'];
/** Fee figures: transfer plus swap fees. */
export const FEE_KEYS: readonly MoneyKey[] = ['transferFees', 'swapFees'];

/** Cents of some money figures over a window, with the coverage of their valuation. */
export interface ValuedCents {
  /** Cents of the valued operations. */
  cents: number;
  /** Counted operations behind the figures. */
  operations: number;
  /** Of those, operations without a USD value, whose amount is not in `cents`. */
  unpriced: number;
}

function operationsOf(facts: Facts, key: MoneyKey): number {
  return key === 'transferVolume' || key === 'transferFees' ? facts.transfers : facts.swaps;
}

/**
 * Adds money figures of several facts with their coverage.
 *
 * @param items - Facts over the same window, one per network.
 * @param keys - Figures to add; a transfer and a swap figure count both kinds of operations.
 * @returns Cents of the valued operations, operations and unpriced operations.
 */
export function valuedOf(items: readonly Facts[], keys: readonly MoneyKey[]): ValuedCents {
  return items.reduce(
    (total, facts) => ({
      cents: total.cents + keys.reduce((sum, key) => sum + sumAssets(facts[key]), 0),
      operations: total.operations + keys.reduce((sum, key) => sum + operationsOf(facts, key), 0),
      unpriced: total.unpriced + keys.reduce((sum, key) => sum + sumAssets(facts.unpriced[key]), 0)
    }),
    { cents: 0, operations: 0, unpriced: 0 }
  );
}

/**
 * Availability of a valued figure: `available` when every operation has a USD value (zero
 * operations included, a measured zero), `unavailable` when none has, `partial` otherwise.
 *
 * @param value - Figure with its coverage.
 * @returns The availability.
 */
export function valuedAvailability(value: ValuedCents): Availability {
  if (value.unpriced === 0) {
    return 'available';
  }
  return value.unpriced >= value.operations ? 'unavailable' : 'partial';
}

/**
 * Reason of a valued activity figure that is not `available`.
 *
 * @param availability - Availability of the figure.
 * @returns `not_valued` when the build valued nothing, `unpriced_assets` otherwise; `null` when
 *   the figure is available.
 */
export function valuedReason(availability: Availability): UnavailableReason | null {
  if (availability === 'available') {
    return null;
  }
  return liveValuation('activity') === 'none' ? 'not_valued' : 'unpriced_assets';
}

/**
 * USD amount of a breakdown or series point: the subtotal of its valued operations.
 *
 * @param items - Facts of the point, one per network.
 * @param keys - Figures to add.
 * @returns The amount; `null` when the point has operations and none of them has a USD value,
 *   never a zero. A point without operations is a measured `0.00`.
 */
export function valuedUsd(items: readonly Facts[], keys: readonly MoneyKey[]): string | null {
  const value = valuedOf(items, keys);
  return valuedAvailability(value) === 'unavailable' ? null : centsToUsd(value.cents);
}

/**
 * Builds a USD metric of counted operations with its valuation coverage. A partial figure keeps
 * the subtotal of the valued operations; an unavailable one has no value. The comparison value is
 * served only for a previous period valued completely, and the change only when both are.
 *
 * @param current - Figure of the period.
 * @param previous - Figure of the previous period; `null` when the range has none.
 * @returns The metric.
 */
export function valuedMoneyMetric(
  current: ValuedCents,
  previous: ValuedCents | null
): ValuedMoneyMetric {
  const availability = valuedAvailability(current);
  const previousCents =
    previous !== null && valuedAvailability(previous) === 'available' ? previous.cents : null;
  return {
    value: availability === 'unavailable' ? null : centsToUsd(current.cents),
    previous: previousCents === null ? null : centsToUsd(previousCents),
    changeRatio:
      availability === 'available' && previousCents !== null
        ? changeRatio(current.cents, previousCents)
        : null,
    availability,
    reason: valuedReason(availability)
  };
}

/**
 * Builds the valuation block of a period: how many counted operations have no USD value for their
 * amount or fee, and on which networks and assets.
 *
 * @param items - Facts of the period per network.
 * @returns The block; `unavailable` when no operation has a USD value for its amount.
 */
export function buildValuation(
  items: ReadonlyArray<{ network: NetworkId; facts: Facts }>
): ValuationBlock {
  const facts = items.map((item) => item.facts);
  const volume = valuedOf(facts, VOLUME_KEYS);
  const fees = valuedOf(facts, FEE_KEYS);
  const availability: Availability =
    volume.unpriced === 0 && fees.unpriced === 0
      ? 'available'
      : valuedAvailability(volume) === 'unavailable'
        ? 'unavailable'
        : 'partial';
  const unpricedAssets = items.flatMap(({ network, facts: networkFacts }) => {
    const { unpriced } = networkFacts;
    const assets = new Set(
      [...VOLUME_KEYS, ...FEE_KEYS].flatMap((key) => Object.keys(unpriced[key]))
    );
    return [...assets].sort().map((asset) => ({
      network,
      asset,
      unpricedVolume: VOLUME_KEYS.reduce((sum, key) => sum + (unpriced[key][asset] ?? 0), 0),
      unpricedFees: FEE_KEYS.reduce((sum, key) => sum + (unpriced[key][asset] ?? 0), 0)
    }));
  });
  return {
    source: sourceFor('activity').kind,
    availability,
    reason: valuedReason(availability),
    asOf: liveAsOf('activity'),
    operations: volume.operations,
    unpricedVolume: volume.unpriced,
    unpricedFees: fees.unpriced,
    unpricedAssets
  };
}
