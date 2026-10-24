import type { CountMetric, MoneyMetric } from './types.js';

/**
 * Formats integer cents as a USD decimal string with 2 places.
 *
 * @param cents - Non-negative integer amount in cents.
 * @returns The amount, e.g. `1234.05`.
 */
export function centsToUsd(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * Relative change between two values, rounded to 4 decimal places.
 *
 * @param value - Current value.
 * @param previous - Comparison value, `null` when there is none.
 * @returns `(value - previous) / previous` as a decimal string, or `null` when `previous` is
 *   `null` or zero.
 */
export function changeRatio(value: number, previous: number | null): string | null {
  if (previous === null || previous === 0) {
    return null;
  }
  const basisPoints = Math.round(((value - previous) * 10_000) / previous);
  const sign = basisPoints < 0 ? '-' : '';
  const absolute = Math.abs(basisPoints);
  return `${sign}${Math.trunc(absolute / 10_000)}.${String(absolute % 10_000).padStart(4, '0')}`;
}

/**
 * Builds a count metric.
 *
 * @param value - Current count.
 * @param previous - Comparison count, `null` when there is none.
 * @returns The metric with its change ratio.
 */
export function countMetric(value: number, previous: number | null): CountMetric {
  return { value, previous, changeRatio: changeRatio(value, previous) };
}

/**
 * Builds a USD metric from cents.
 *
 * @param cents - Current amount in cents.
 * @param previousCents - Comparison amount in cents, `null` when there is none.
 * @returns The metric with amounts as decimal strings and its change ratio.
 */
export function moneyMetric(cents: number, previousCents: number | null): MoneyMetric {
  return {
    value: centsToUsd(cents),
    previous: previousCents === null ? null : centsToUsd(previousCents),
    changeRatio: changeRatio(cents, previousCents)
  };
}
