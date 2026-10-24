/**
 * Formats a raw integer amount in base units as a decimal string, without losing precision.
 *
 * @param raw - Non-negative amount in base units (wei, lovelace, ...).
 * @param decimals - Decimals of the asset.
 * @returns The amount, e.g. `12.5` or `0.0`; trailing zeros of the fraction are dropped.
 */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction =
    decimals === 0 ? '' : (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}.${fraction === '' ? '0' : fraction}`;
}

/**
 * Parses a decimal string into an integer scaled by `10^places`, truncating extra places.
 *
 * @param value - Decimal string such as `12.5`.
 * @param places - Places of the result.
 * @returns The scaled integer.
 */
function scaled(value: string, places: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole + fraction.slice(0, places).padEnd(places, '0'));
}

function placesOf(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

/**
 * Adds decimal strings exactly.
 *
 * @param values - Non-negative decimal strings.
 * @returns The sum as a decimal string; `0.0` for no values.
 */
export function addDecimals(values: readonly string[]): string {
  const places = values.reduce((max, value) => Math.max(max, placesOf(value)), 0);
  const total = values.reduce((sum, value) => sum + scaled(value, places), 0n);
  return formatUnits(total, places);
}

/**
 * Formats a non-negative number as a decimal string with a fixed number of places, for synthetic
 * amounts.
 *
 * @param value - Amount.
 * @param places - Places kept.
 * @returns The amount, e.g. `0.412300`.
 */
export function fixedAmount(value: number, places: number): string {
  return Math.max(0, value).toFixed(places);
}

/**
 * Share of a part in a total as a decimal string with 4 places.
 *
 * @param part - Non-negative part.
 * @param total - Total the part belongs to.
 * @returns `part / total`, e.g. `0.2500`; `null` when the total is zero.
 */
export function shareOf(part: number, total: number): string | null {
  if (total <= 0) {
    return null;
  }
  const basisPoints = Math.round((part * 10_000) / total);
  return `${Math.trunc(basisPoints / 10_000)}.${String(basisPoints % 10_000).padStart(4, '0')}`;
}

/**
 * Formats an amount in ten-thousandths of a USD as a decimal string with 4 places.
 *
 * @param value - Non-negative integer amount in 1/10000 USD.
 * @returns The amount, e.g. `0.0123`.
 */
export function tenThousandthsToUsd(value: number): string {
  return `${Math.trunc(value / 10_000)}.${String(value % 10_000).padStart(4, '0')}`;
}
