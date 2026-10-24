import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors/api-error.js';

/** Roles of an analytics member. */
export type Role = 'admin' | 'viewer';

/** Identity behind a request, resolved from the session. */
export interface Principal {
  userId: string;
  role: Role;
  /** `jti` of the session behind the request; absent for principals not backed by a session. */
  sessionId?: string;
}

/**
 * Resolves the principal of a request, or `null` when the request carries no valid session.
 * Implementations must check revocation and the current role on every call.
 */
export type Authenticator = (request: FastifyRequest) => Promise<Principal | null>;

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/**
 * Authenticator that admits nobody: every request is anonymous, so protected routes answer 401.
 *
 * @returns Always `null`.
 */
export async function denyAllAuthenticator(): Promise<Principal | null> {
  return null;
}

/**
 * Builds a pre-handler that admits only authenticated principals with one of the roles.
 *
 * @param roles - Roles allowed on the route.
 * @returns Hook that throws 401 without principal and 403 for other roles.
 */
export function requireRoles(
  roles: readonly Role[]
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    if (request.principal === null) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    if (!roles.includes(request.principal.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'Insufficient role');
    }
  };
}
