import type { DailyPrice } from '../ingest/types.js';
import { dayNumberFromIso } from './calendar.js';

interface PricePoint {
  day: number;
  usd: number;
}

/**
 * USD prices per symbol and day, for valuing volume and fees of non-stable tokens.
 *
 * A provider snapshot wins over a swap-implied price of the same day. A day without a price takes
 * the closest earlier day, and failing that the closest later day: history older than the first
 * snapshot is valued at the earliest known price, an approximation that grows with the distance.
 */
export class PriceBook {
  private readonly points = new Map<string, PricePoint[]>();

  /**
   * @param prices - Daily prices of any source.
   */
  constructor(prices: readonly DailyPrice[]) {
    const best = new Map<string, DailyPrice>();
    for (const price of prices) {
      if (!Number.isFinite(price.usd) || price.usd <= 0) {
        continue;
      }
      const key = `${price.symbol}|${price.day}`;
      const current = best.get(key);
      if (current === undefined || (current.source === 'swap' && price.source === 'provider')) {
        best.set(key, price);
      }
    }
    for (const price of best.values()) {
      const list = this.points.get(price.symbol) ?? [];
      list.push({ day: dayNumberFromIso(price.day), usd: price.usd });
      this.points.set(price.symbol, list);
    }
    for (const list of this.points.values()) {
      list.sort((left, right) => left.day - right.day);
    }
  }

  /**
   * Price of a symbol on a day.
   *
   * @param symbol - Canonical token symbol.
   * @param day - UTC day number.
   * @returns The USD price; `null` when the symbol has no price on any day.
   */
  usd(symbol: string, day: number): number | null {
    const list = this.points.get(symbol);
    if (list === undefined || list.length === 0) {
      return null;
    }
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((list[middle]?.day ?? Number.POSITIVE_INFINITY) <= day) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const candidate = list[low];
    if (candidate === undefined) {
      return null;
    }
    return candidate.day <= day ? candidate.usd : (list[0]?.usd ?? null);
  }
}

/** One swap with a stable leg and a non-stable leg, in token units. */
export interface StableSwap {
  /** `YYYY-MM-DD` of the swap. */
  day: string;
  symbol: string;
  amount: number;
  stableAmount: number;
}

/**
 * Daily prices implied by swaps against a stable token: stable units received or paid divided by
 * units of the other token, weighted by volume within the day.
 *
 * @param swaps - Swaps with one stable leg.
 * @returns One price per symbol and day.
 */
export function impliedSwapPrices(swaps: readonly StableSwap[]): DailyPrice[] {
  const totals = new Map<string, { symbol: string; day: string; amount: number; stable: number }>();
  for (const swap of swaps) {
    if (!(swap.amount > 0 && swap.stableAmount > 0)) {
      continue;
    }
    const key = `${swap.symbol}|${swap.day}`;
    const total = totals.get(key) ?? { symbol: swap.symbol, day: swap.day, amount: 0, stable: 0 };
    total.amount += swap.amount;
    total.stable += swap.stableAmount;
    totals.set(key, total);
  }
  return [...totals.values()].map((total) => ({
    symbol: total.symbol,
    day: total.day,
    usd: total.stable / total.amount,
    source: 'swap'
  }));
}
