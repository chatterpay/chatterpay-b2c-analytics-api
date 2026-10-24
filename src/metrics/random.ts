/**
 * Maps a key to a pseudo-random number in [0, 1).
 *
 * The same key always yields the same number (FNV-1a hash followed by one mulberry32 step), so the
 * dataset is reproducible across processes and instances without storing it.
 *
 * @param key - Stable key that identifies the value.
 * @returns A number in [0, 1).
 */
export function seededUnit(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  let state = (hash + 0x6d2b79f5) | 0;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
}
