import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AppEnv } from '../config/env.js';

/**
 * Keys of the login codes. Each one is dedicated to its use and shared with no other feature of
 * the API: `code` computes the verifier stored on a challenge and `identity` the pseudonymous
 * identifiers of emails and client IPs in challenges and rate limit counters.
 */
export interface LoginCodeKeys {
  code: Buffer;
  identity: Buffer;
  /**
   * Fingerprint of the `code` key stored on each challenge. A challenge issued under another key
   * never verifies, so a rotation fails closed instead of comparing against the wrong key.
   */
  codeKeyVersion: string;
  /** The keys were generated at startup because the variables are unset; outside production only. */
  ephemeral: boolean;
}

const MIN_KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-fA-F]+$/;
const BASE64_KEY = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decodes key material written as hex or base64 (standard or URL-safe).
 *
 * @param value - Encoded key.
 * @returns The key bytes; `null` when the value is in neither encoding or shorter than 256 bits.
 */
export function decodeKeyMaterial(value: string): Buffer | null {
  const trimmed = value.trim();
  let bytes: Buffer | null = null;
  if (HEX_KEY.test(trimmed) && trimmed.length % 2 === 0) {
    bytes = Buffer.from(trimmed, 'hex');
  } else if (BASE64_KEY.test(trimmed)) {
    bytes = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  return bytes !== null && bytes.length >= MIN_KEY_BYTES ? bytes : null;
}

/**
 * Canonical encoding of a list of fields: each field is its UTF-8 length as 4 bytes big endian
 * followed by its bytes, so no two different lists encode alike whatever characters they hold.
 *
 * @param fields - Fields in order.
 * @returns The encoded bytes.
 */
export function encodeFields(fields: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function hmac(key: Buffer, fields: readonly string[]): Buffer {
  return createHmac('sha256', key).update(encodeFields(fields)).digest();
}

/**
 * Builds the login code keys from `OTP_HMAC_SECRET` and `OTP_EMAIL_HMAC_SECRET`. Outside
 * production, unset variables get random keys for the life of the process: pending codes and the
 * rate limit state of emails do not survive a restart.
 *
 * @param env - Validated configuration; production guarantees both variables.
 * @returns The keys.
 */
export function loadLoginCodeKeys(
  env: Pick<AppEnv, 'OTP_HMAC_SECRET' | 'OTP_EMAIL_HMAC_SECRET'>
): LoginCodeKeys {
  const configuredCode =
    env.OTP_HMAC_SECRET === null ? null : decodeKeyMaterial(env.OTP_HMAC_SECRET);
  const configuredIdentity =
    env.OTP_EMAIL_HMAC_SECRET === null ? null : decodeKeyMaterial(env.OTP_EMAIL_HMAC_SECRET);
  const code = configuredCode ?? randomBytes(MIN_KEY_BYTES);
  const identity = configuredIdentity ?? randomBytes(MIN_KEY_BYTES);
  return {
    code,
    identity,
    codeKeyVersion: hmac(code, ['otp-key:v1']).subarray(0, 8).toString('hex'),
    ephemeral: configuredCode === null || configuredIdentity === null
  };
}

/**
 * Draws a login code from the CSPRNG.
 *
 * @param digits - Length of the code.
 * @returns The digits, leading zeros kept.
 */
export function generateLoginCode(digits: number): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

/**
 * Verifier stored on the challenge instead of the code: an HMAC of the code bound to the challenge
 * and the email. Without the key, the stored value does not lead back to the code.
 *
 * @param keys - Login code keys.
 * @param challengeId - Id of the challenge.
 * @param email - Normalized email of the challenge.
 * @param code - Code sent by email.
 * @returns The verifier, hex.
 */
export function codeVerifier(
  keys: LoginCodeKeys,
  challengeId: string,
  email: string,
  code: string
): string {
  return hmac(keys.code, ['otp:v1', challengeId, email, code]).toString('hex');
}

/**
 * Checks a typed code against the verifier of its challenge in constant time. A code typed with
 * the wrong shape, a challenge issued under another key or a malformed verifier never matches.
 *
 * @param keys - Login code keys.
 * @param challenge - Id, key version and verifier of the challenge.
 * @param email - Normalized email of the request.
 * @param candidate - Code as typed.
 * @param digits - Expected length of the code.
 * @returns Whether the code is the one that was sent.
 */
export function codeMatches(
  keys: LoginCodeKeys,
  challenge: { id: string; keyVersion: string | null; codeDigest: string | null },
  email: string,
  candidate: string,
  digits: number
): boolean {
  const code = candidate.trim();
  const expected = Buffer.from(challenge.codeDigest ?? '', 'hex');
  const actual = Buffer.from(codeVerifier(keys, challenge.id, email, code), 'hex');
  const wellFormed =
    new RegExp(`^\\d{${digits}}$`).test(code) &&
    challenge.keyVersion === keys.codeKeyVersion &&
    expected.length === actual.length;
  return wellFormed && timingSafeEqual(actual, expected);
}

/**
 * Pseudonymous identifier of an email for challenges and rate limit counters.
 *
 * @param keys - Login code keys.
 * @param email - Normalized email.
 * @returns The identifier, hex.
 */
export function emailKey(keys: LoginCodeKeys, email: string): string {
  return hmac(keys.identity, ['email:v1', email]).toString('hex');
}

/**
 * Pseudonymous identifier of a client IP for rate limit counters.
 *
 * @param keys - Login code keys.
 * @param ip - Client IP as resolved by `clientIp`.
 * @returns The identifier, hex.
 */
export function originKey(keys: LoginCodeKeys, ip: string): string {
  return hmac(keys.identity, ['ip:v1', ip]).toString('hex');
}
