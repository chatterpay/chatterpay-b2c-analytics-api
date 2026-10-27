import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Digits of a login code sent by email. */
export const LOGIN_CODE_DIGITS = 6;

/**
 * Draws a one-time login code from the CSPRNG.
 *
 * @returns Six digits, leading zeros kept.
 */
export function generateLoginCode(): string {
  return String(randomInt(0, 10 ** LOGIN_CODE_DIGITS)).padStart(LOGIN_CODE_DIGITS, '0');
}

function digest(salt: string, code: string): Buffer {
  return createHash('sha256').update(`${salt}:${code.trim()}`).digest();
}

/**
 * Salted digest stored on the challenge instead of the code, as `salt.digest` in hex. Six digits
 * can be found from the digest by trying them all; what limits guessing is the challenge: few
 * attempts, a short life and a single use.
 *
 * @param code - Code sent by email.
 * @param salt - Hex salt; a new random one by default.
 * @returns The value to store.
 */
export function hashLoginCode(
  code: string,
  salt: string = randomBytes(16).toString('hex')
): string {
  return `${salt}.${digest(salt, code).toString('hex')}`;
}

/**
 * Compares a typed code with the stored digest in constant time.
 *
 * @param candidate - Code as typed.
 * @param codeHash - Value from {@link hashLoginCode}; `null` never matches.
 * @returns Whether the code is the one that was sent.
 */
export function loginCodeMatches(candidate: string, codeHash: string | null): boolean {
  const [salt = '', stored = ''] = (codeHash ?? '').split('.');
  const expected = Buffer.from(stored, 'hex');
  const actual = digest(salt, candidate);
  return (
    codeHash !== null && expected.length === actual.length && timingSafeEqual(actual, expected)
  );
}
