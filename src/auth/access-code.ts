import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Builds a constant-time comparator against the expected access code.
 *
 * Both values go through HMAC-SHA256 with a per-process random key, so `timingSafeEqual` always
 * compares two 32-byte digests and the comparison time reveals neither the content nor the
 * length of the expected code.
 *
 * @param expected - The configured access code.
 * @returns Function that reports whether a candidate equals the expected code.
 */
export function createCodeMatcher(expected: string): (candidate: string) => boolean {
  const key = randomBytes(32);
  const digest = (value: string): Buffer => createHmac('sha256', key).update(value).digest();
  const expectedDigest = digest(expected);
  return (candidate) => timingSafeEqual(digest(candidate), expectedDigest);
}
