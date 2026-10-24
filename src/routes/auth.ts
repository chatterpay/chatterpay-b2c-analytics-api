import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createCodeMatcher } from '../auth/access-code.js';
import { clientIp } from '../auth/client-ip.js';
import { requireRoles } from '../auth/principal.js';
import { type SigningKeys, signSessionToken } from '../auth/session-token.js';
import { type AppEnv, normalizeEmail } from '../config/env.js';
import { ApiError } from '../errors/api-error.js';
import type { Store } from '../store/types.js';
import { emailSchema, memberSchema, toMemberBody } from './representations.js';
import { errorResponsesFor, object } from './schemas.js';

/** Options of the auth routes. */
export interface AuthRoutesOptions {
  env: AppEnv;
  store: Store;
  keys: SigningKeys;
  clock: () => Date;
}

const RATE_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_CODE_PER_EMAIL = 5;
const REQUEST_CODE_PER_IP = 20;
const VERIFY_CODE_PER_IP = 30;
const MAX_CHALLENGE_ATTEMPTS = 5;
const MINUTE_MS = 60 * 1000;

const INVALID_CODE_MESSAGE = 'Invalid or expired code';

const instant = { type: 'string', format: 'date-time' } as const;

const requestCodeBody = object({ email: emailSchema });
const requestCodeResponse = object({ challengeId: { type: 'string' }, expiresAt: instant });

const verifyCodeBody = object({
  challengeId: { type: 'string', minLength: 1, maxLength: 64 },
  email: emailSchema,
  code: { type: 'string', minLength: 6, maxLength: 64 }
});
const verifyCodeResponse = object({
  token: { type: 'string', description: 'Session JWT (EdDSA) for `Authorization: Bearer`.' },
  expiresAt: instant,
  user: memberSchema
});

const meResponse = object({ user: memberSchema, session: object({ expiresAt: instant }) });

async function enforceRateLimit(
  store: Store,
  key: string,
  limit: number,
  now: Date
): Promise<void> {
  const result = await store.hit(key, limit, RATE_WINDOW_MS, now);
  if (!result.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', {
      'retry-after': String(result.retryAfterSeconds)
    });
  }
}

function invalidCode(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', INVALID_CODE_MESSAGE);
}

/**
 * Registers the login and session endpoints under the plugin prefix.
 *
 * `request-code` and `verify-code` are public: the BFF calls them for the browser and forwards
 * the browser IP in `x-client-ip`. Every verification failure answers the same 401, so callers
 * cannot tell an unknown email from a wrong or expired code. No email is sent and the code is
 * never returned or recorded. Every response carries `Cache-Control: private, no-store`.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Configuration, store, signing keys and clock.
 */
export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { env, store, keys, clock } = options;
  const codeMatches =
    env.DEMO_ACCESS_CODE === null ? null : createCodeMatcher(env.DEMO_ACCESS_CODE);
  const signedIn = requireRoles(['admin', 'viewer']);

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });

  app.post<{ Body: { email: string } }>(
    '/request-code',
    {
      schema: {
        operationId: 'requestLoginCode',
        summary: 'Open a login challenge for an email; answers the same for unknown emails',
        tags: ['auth'],
        body: requestCodeBody,
        response: { 202: requestCodeResponse, ...errorResponsesFor([400, 429]) }
      }
    },
    async (request, reply) => {
      const now = clock();
      const email = normalizeEmail(request.body.email);
      await enforceRateLimit(
        store,
        `request-code:ip:${clientIp(request)}`,
        REQUEST_CODE_PER_IP,
        now
      );
      await enforceRateLimit(store, `request-code:email:${email}`, REQUEST_CODE_PER_EMAIL, now);
      // Created for every email so the answer does not reveal which emails are members.
      const expiresAt = new Date(now.getTime() + env.CHALLENGE_TTL_MINUTES * MINUTE_MS);
      const challenge = await store.createChallenge(email, now, expiresAt);
      reply.status(202);
      return { challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString() };
    }
  );

  app.post<{ Body: { challengeId: string; email: string; code: string } }>(
    '/verify-code',
    {
      schema: {
        operationId: 'verifyLoginCode',
        summary: 'Exchange a challenge and access code for a session token',
        tags: ['auth'],
        body: verifyCodeBody,
        response: { 200: verifyCodeResponse, ...errorResponsesFor([400, 401, 429, 503]) }
      }
    },
    async (request) => {
      if (codeMatches === null) {
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Login is not configured');
      }
      const now = clock();
      await enforceRateLimit(store, `verify-code:ip:${clientIp(request)}`, VERIFY_CODE_PER_IP, now);
      const email = normalizeEmail(request.body.email);
      const challenge = await store.recordChallengeAttempt(
        request.body.challengeId,
        MAX_CHALLENGE_ATTEMPTS,
        now
      );
      const codeOk = codeMatches(request.body.code);

      if (
        challenge === null ||
        challenge.email !== email ||
        !codeOk ||
        !(await store.consumeChallenge(challenge.id, now))
      ) {
        // Only failures against existing members are recorded, so the log holds no unknown emails.
        const member = await store.findActiveUserByEmail(email);
        if (member !== null) {
          await store.appendActivity({
            at: now,
            actorId: member.id,
            action: 'login_failed',
            target: null,
            outcome: 'failure'
          });
        }
        throw invalidCode();
      }

      const activated = await store.activateMember(email, now);
      if (activated === null) {
        throw invalidCode();
      }
      if (activated.acceptedInvite !== null) {
        await store.appendActivity({
          at: now,
          actorId: activated.user.id,
          action: 'invite_accepted',
          target: email,
          outcome: 'success'
        });
      }
      const user = (await store.recordLogin(activated.user.id, now)) ?? activated.user;
      const expiresAt = new Date(now.getTime() + env.SESSION_TTL_MINUTES * MINUTE_MS);
      const session = await store.createSession({
        jti: randomUUID(),
        userId: user.id,
        createdAt: now,
        expiresAt
      });
      const token = await signSessionToken(keys, env, {
        userId: user.id,
        jti: session.jti,
        role: user.role,
        issuedAt: now,
        expiresAt
      });
      await store.appendActivity({
        at: now,
        actorId: user.id,
        action: 'login',
        target: null,
        outcome: 'success'
      });
      return { token, expiresAt: expiresAt.toISOString(), user: toMemberBody(user) };
    }
  );

  app.get(
    '/me',
    {
      onRequest: signedIn,
      schema: {
        operationId: 'getCurrentSession',
        summary: 'Member and session behind the bearer token',
        tags: ['auth'],
        response: { 200: meResponse, ...errorResponsesFor([401, 403]) }
      }
    },
    async (request) => {
      const sessionId = request.principal?.sessionId;
      const session = sessionId === undefined ? null : await store.findSession(sessionId);
      const user =
        request.principal === null ? null : await store.findUserById(request.principal.userId);
      if (session === null || user === null) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      }
      return { user: toMemberBody(user), session: { expiresAt: session.expiresAt.toISOString() } };
    }
  );

  app.post(
    '/logout',
    {
      onRequest: signedIn,
      schema: {
        operationId: 'logout',
        summary: 'Revoke the session behind the bearer token',
        tags: ['auth'],
        response: {
          204: { type: 'null', description: 'Session revoked' },
          ...errorResponsesFor([401, 403])
        }
      }
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === null || principal.sessionId === undefined) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      }
      const now = clock();
      await store.revokeSession(principal.sessionId, now);
      await store.appendActivity({
        at: now,
        actorId: principal.userId,
        action: 'logout',
        target: null,
        outcome: 'success'
      });
      return reply.status(204).send();
    }
  );
}
