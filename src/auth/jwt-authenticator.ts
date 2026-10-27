import type { AppEnv } from '../config/env.js';
import type { Store } from '../store/types.js';
import type { Authenticator, Principal } from './principal.js';
import { type SigningKeys, verifySessionToken } from './session-token.js';

/** Dependencies of {@link createJwtAuthenticator}. */
export interface JwtAuthenticatorOptions {
  env: Pick<AppEnv, 'JWT_ISSUER' | 'JWT_AUDIENCE'>;
  keys: SigningKeys;
  store: Store;
  clock: () => Date;
}

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)$/;

/**
 * Builds the authenticator of session JWTs sent as `Authorization: Bearer <jwt>`.
 *
 * Beyond the token checks, the session must exist in the store, be neither revoked nor expired
 * and belong to an active user. The principal role is the current role in the store, so a role
 * change or removal applies without a new login: on the next request of the instance that made it,
 * and on the others once their cached read expires (`withReadCache`).
 *
 * @param options - Configuration, keys, store and clock.
 * @returns Authenticator that resolves `null` for any missing or invalid session.
 */
export function createJwtAuthenticator(options: JwtAuthenticatorOptions): Authenticator {
  const { env, keys, store, clock } = options;
  return async (request): Promise<Principal | null> => {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? BEARER_PATTERN.exec(header) : null;
    const token = match?.[1];
    if (token === undefined) {
      return null;
    }
    const now = clock();
    const claims = await verifySessionToken(token, keys, env, now);
    if (claims === null) {
      return null;
    }
    const session = await store.findSession(claims.jti);
    if (
      session === null ||
      session.userId !== claims.userId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    const user = await store.findUserById(session.userId);
    if (user === null || user.status !== 'active') {
      return null;
    }
    return { userId: user.id, role: user.role, sessionId: session.jti };
  };
}
