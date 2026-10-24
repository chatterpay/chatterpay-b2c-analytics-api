import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject
} from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AppEnv } from '../config/env.js';
import type { Role } from './principal.js';

/** Ed25519 key pair that signs and verifies session JWTs. */
export interface SigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
  /** `true` when generated at startup because `JWT_PRIVATE_KEY` is unset. */
  ephemeral: boolean;
}

/** Claims of a verified session JWT that the authenticator relies on. */
export interface SessionClaims {
  userId: string;
  jti: string;
}

/** Input of {@link signSessionToken}. */
export interface SessionTokenInput {
  userId: string;
  jti: string;
  role: Role;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Loads the session signing keys from `JWT_PRIVATE_KEY`, or generates an ephemeral pair when it is
 * unset. `loadEnv` already rejects a missing key in production and keys that are not Ed25519.
 *
 * @param env - Validated configuration.
 * @returns The key pair; with an ephemeral pair, sessions do not survive a restart.
 */
export function loadSigningKeys(env: AppEnv): SigningKeys {
  if (env.JWT_PRIVATE_KEY !== null) {
    const privateKey = createPrivateKey({ key: env.JWT_PRIVATE_KEY, format: 'pem' });
    return {
      privateKey,
      publicKey: createPublicKey(privateKey),
      keyId: env.JWT_KEY_ID,
      ephemeral: false
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId: env.JWT_KEY_ID, ephemeral: true };
}

function epochSeconds(instant: Date): number {
  return Math.floor(instant.getTime() / 1000);
}

/**
 * Signs a session JWT: alg EdDSA with `kid`, claims `iss`, `aud`, `sub`, `jti`, `role`, `iat`,
 * `exp`. The `role` claim is informative; the authenticator reads the current role from the store.
 *
 * @param keys - Signing keys.
 * @param env - Issuer and audience.
 * @param input - Session data.
 * @returns The compact JWS.
 */
export async function signSessionToken(
  keys: SigningKeys,
  env: Pick<AppEnv, 'JWT_ISSUER' | 'JWT_AUDIENCE'>,
  input: SessionTokenInput
): Promise<string> {
  return new SignJWT({ role: input.role })
    .setProtectedHeader({ alg: 'EdDSA', kid: keys.keyId, typ: 'JWT' })
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setSubject(input.userId)
    .setJti(input.jti)
    .setIssuedAt(epochSeconds(input.issuedAt))
    .setExpirationTime(epochSeconds(input.expiresAt))
    .sign(keys.privateKey);
}

/**
 * Verifies signature (EdDSA only), issuer, audience and expiry of a session JWT.
 *
 * @param token - Compact JWS from the `Authorization` header.
 * @param keys - Verification key.
 * @param env - Expected issuer and audience.
 * @param now - Instant used for `exp` and `nbf`.
 * @returns The claims, or `null` for any invalid token.
 */
export async function verifySessionToken(
  token: string,
  keys: SigningKeys,
  env: Pick<AppEnv, 'JWT_ISSUER' | 'JWT_AUDIENCE'>,
  now: Date
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      algorithms: ['EdDSA'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      currentDate: now,
      requiredClaims: ['sub', 'jti', 'iat', 'exp']
    });
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      return null;
    }
    return { userId: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}
