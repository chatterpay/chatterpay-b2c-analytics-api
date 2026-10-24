/**
 * Splits a non-negative integer into integer parts proportional to the weights.
 *
 * Uses the largest remainder method, ties broken by position, so the parts always add up to
 * `total` exactly and the result is deterministic.
 *
 * @param total - Non-negative integer to split.
 * @param weights - Non-negative weights; at least one must be positive when `total` is positive.
 * @returns One integer part per weight.
 * @throws {Error} When `total` is not a non-negative integer or all weights are zero for a
 *   positive total.
 */
export function allocateInteger(total: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('total must be a non-negative integer');
  }
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0) {
    return weights.map(() => 0);
  }
  if (weightSum <= 0) {
    throw new Error('weights must contain a positive value');
  }

  const parts = weights.map((weight) => Math.floor((total * weight) / weightSum));
  let remaining = total - parts.reduce((sum, part) => sum + part, 0);
  const byRemainder = weights
    .map((weight, index) => ({
      index,
      remainder: (total * weight) / weightSum - (parts[index] ?? 0)
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const { index } of byRemainder) {
    if (remaining === 0) {
      break;
    }
    parts[index] = (parts[index] ?? 0) + 1;
    remaining -= 1;
  }
  return parts;
}
