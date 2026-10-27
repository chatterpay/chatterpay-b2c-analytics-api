import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createCodeMatcher } from '../auth/access-code.js';
import { clientIp } from '../auth/client-ip.js';
import {
  codeMatches,
  codeVerifier,
  emailKey,
  generateLoginCode,
  type LoginCodeKeys,
  originKey
} from '../auth/login-code.js';
import {
  IP_WINDOW_MS,
  liveThrottle,
  nextCodeAt,
  requestCounterKey,
  SEND_DAY_WINDOW_MS,
  SEND_HOUR_WINDOW_MS,
  secondsUntil,
  sendCounterKeys,
  THROTTLE_FORGET_MS,
  throttleKey,
  verifyCounterKey
} from '../auth/login-limits.js';
import { requireRoles } from '../auth/principal.js';
import { type SigningKeys, signSessionToken } from '../auth/session-token.js';
import { type AppEnv, normalizeEmail } from '../config/env.js';
import type { EmailService } from '../email/service.js';
import type { EmailLocale } from '../email/types.js';
import { ApiError } from '../errors/api-error.js';
import type { Challenge, Store } from '../store/types.js';
import { emailLocaleSchema, emailSchema, memberSchema, toMemberBody } from './representations.js';
import { errorResponsesFor, object } from './schemas.js';

/** Options of the auth routes. */
export interface AuthRoutesOptions {
  env: AppEnv;
  store: Store;
  keys: SigningKeys;
  loginKeys: LoginCodeKeys;
  clock: () => Date;
  email: EmailService;
}

const SECOND_MS = 1000;

const INVALID_CODE_MESSAGE = 'Invalid or expired code';

const instant = { type: 'string', format: 'date-time' } as const;

const requestCodeBody = {
  ...object({ email: emailSchema }),
  properties: { email: emailSchema, locale: emailLocaleSchema }
};
const requestCodeResponse = object({
  challengeId: { type: 'string' },
  expiresAt: instant,
  delivery: {
    type: 'string',
    enum: ['email', 'access_code'],
    description:
      '`email`: a code is emailed to members and invited emails, and the answer is the same for any other email. `access_code`: a demo account, which signs in with the shared demo code.'
  },
  codeLength: {
    type: ['integer', 'null'],
    description: 'Digits of the emailed code; `null` with `access_code`.'
  }
});

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

function tooManyRequests(retryAfterSeconds: number): ApiError {
  return new ApiError(429, 'RATE_LIMITED', 'Too many requests', {
    'retry-after': String(retryAfterSeconds)
  });
}

async function enforceRateLimit(
  store: Store,
  key: string,
  limit: number,
  windowMs: number,
  now: Date
): Promise<void> {
  const result = await store.hit(key, limit, windowMs, now);
  if (!result.allowed) {
    throw tooManyRequests(result.retryAfterSeconds);
  }
}

function invalidCode(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', INVALID_CODE_MESSAGE);
}

/** Short pseudonymous reference of an email for the logs: a prefix of its email key. */
function emailRef(key: string): string {
  return key.slice(0, 12);
}

/** Logs why a login step was refused, with the pseudonymous email reference only. */
function logRefusal(request: FastifyRequest, key: string, step: string, reason: string): void {
  request.log.info({ emailRef: emailRef(key), step, reason }, 'login step refused');
}

/**
 * Registers the login and session endpoints under the plugin prefix.
 *
 * `request-code` and `verify-code` are public: the BFF calls them for the browser and forwards
 * the browser IP in `x-client-ip`. Every verification failure answers the same 401, so callers
 * cannot tell an unknown email from a wrong or expired code.
 *
 * `request-code` issues a code of `OTP_CODE_DIGITS` digits that lives `OTP_TTL_SECONDS` and allows
 * `OTP_MAX_ATTEMPTS` verifications. It is emailed only to active members that are not blocked and
 * to emails with a pending invite; any other email gets the same answer and no email. The
 * challenge keeps an HMAC verifier bound to its id and email, never the code, and replaces the
 * previous challenge of the email once the new code was sent: a failed send keeps the previous
 * code valid and does not count. The send happens before the answer, so its duration is visible
 * to the caller. The code is never returned or logged.
 *
 * Limits, the same for every email, known or not:
 * - per email, the codes issued since its last login set the wait before the next one (see
 *   `nextCodeAt`), counted from the previous code, so refused requests do not extend it;
 * - per email and client IP, `OTP_SENDS_PER_EMAIL_HOUR` and `OTP_SENDS_PER_EMAIL_DAY` codes;
 * - per client IP, `OTP_REQUESTS_PER_IP` requests and `OTP_VERIFICATIONS_PER_IP` verifications
 *   in 15 minutes.
 * A refusal answers 429 with `retry-after`. A login clears the limits of the email and the IP it
 * came from. Refusals are logged with a prefix of the email key, never the email.
 *
 * With `DEMO_LOGIN_ENABLED`, an email of `DEMO_LOGIN_EMAILS` that is an active member gets a
 * challenge verified against `DEMO_ACCESS_CODE` instead, and no email.
 *
 * Verifying a code proves that the person owns the email, which is when an invited account is
 * activated. Every response carries `Cache-Control: private, no-store`.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Configuration, store, signing and login code keys, clock and email service.
 */
export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { env, store, keys, loginKeys, clock, email: emails } = options;
  const demoEmails = new Set(env.DEMO_LOGIN_ENABLED ? env.DEMO_LOGIN_EMAILS : []);
  const demoCodeMatches =
    env.DEMO_LOGIN_ENABLED && env.DEMO_ACCESS_CODE !== null
      ? createCodeMatcher(env.DEMO_ACCESS_CODE)
      : null;
  const signedIn = requireRoles(['admin', 'viewer']);

  const matches = (challenge: Challenge, email: string, code: string): boolean => {
    if (challenge.kind === 'access_code') {
      return demoCodeMatches !== null && demoEmails.has(email) && demoCodeMatches(code);
    }
    return codeMatches(loginKeys, challenge, email, code, env.OTP_CODE_DIGITS);
  };

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });

  app.post<{ Body: { email: string; locale?: EmailLocale } }>(
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
      const origin = originKey(loginKeys, clientIp(request));
      await enforceRateLimit(
        store,
        requestCounterKey(origin),
        env.OTP_REQUESTS_PER_IP,
        IP_WINDOW_MS,
        now
      );
      const key = emailKey(loginKeys, email);
      const stored = await store.loginThrottle(throttleKey(key));
      const live = liveThrottle(stored, now);
      const next = nextCodeAt(live, env);
      if (next !== null && next.getTime() > now.getTime()) {
        logRefusal(request, key, 'request', 'wait');
        throw tooManyRequests(secondsUntil(next, now));
      }
      const sends = sendCounterKeys(key, origin);
      await enforceRateLimit(
        store,
        sends.hour,
        env.OTP_SENDS_PER_EMAIL_HOUR,
        SEND_HOUR_WINDOW_MS,
        now
      );
      await enforceRateLimit(
        store,
        sends.day,
        env.OTP_SENDS_PER_EMAIL_DAY,
        SEND_DAY_WINDOW_MS,
        now
      );
      const reserved = await store.reserveLoginThrottle(throttleKey(key), stored?.version ?? null, {
        issued: (live?.issued ?? 0) + 1,
        lastIssuedAt: now,
        forgetAt: new Date(now.getTime() + THROTTLE_FORGET_MS)
      });
      if (reserved === null) {
        // Another request for the email took this slot first.
        logRefusal(request, key, 'request', 'concurrent');
        throw tooManyRequests(env.OTP_RESEND_COOLDOWN_SECONDS);
      }

      const challengeId = randomUUID();
      const expiresAt = new Date(now.getTime() + env.OTP_TTL_SECONDS * SECOND_MS);
      const opened = {
        id: challengeId,
        emailKey: key,
        createdAt: now,
        expiresAt,
        consumedAt: null,
        revokedAt: null,
        attempts: 0,
        maxAttempts: env.OTP_MAX_ATTEMPTS
      };
      const member = await store.findActiveUserByEmail(email);
      reply.status(202);

      if (demoEmails.has(email)) {
        if (member !== null && member.blockedAt === null) {
          await store.issueChallenge({
            ...opened,
            userId: member.id,
            kind: 'access_code',
            codeDigest: null,
            keyVersion: null
          });
        }
        return {
          challengeId,
          expiresAt: expiresAt.toISOString(),
          delivery: 'access_code',
          codeLength: null
        };
      }

      const eligible =
        member !== null ? member.blockedAt === null : await store.hasPendingInvite(email, now);
      if (eligible) {
        const code = generateLoginCode(env.OTP_CODE_DIGITS);
        const outcome = await emails.sendLoginCode({
          email,
          challengeId,
          code,
          locale: request.body.locale ?? 'en',
          expiresInMinutes: Math.ceil(env.OTP_TTL_SECONDS / 60)
        });
        if (outcome.state === 'failed') {
          // The previous challenge, if any, stays the open one, and the failed code does not count.
          await store.restoreLoginThrottle(throttleKey(key), reserved, stored);
          request.log.warn(
            {
              emailRef: emailRef(key),
              challengeId,
              failure: outcome.failure,
              attempts: outcome.attempts
            },
            'login code email not delivered'
          );
        } else {
          await store.issueChallenge({
            ...opened,
            userId: member?.id ?? null,
            kind: 'otp',
            codeDigest: codeVerifier(loginKeys, challengeId, email, code),
            keyVersion: loginKeys.codeKeyVersion
          });
        }
      }
      return {
        challengeId,
        expiresAt: expiresAt.toISOString(),
        delivery: 'email',
        codeLength: env.OTP_CODE_DIGITS
      };
    }
  );

  app.post<{ Body: { challengeId: string; email: string; code: string } }>(
    '/verify-code',
    {
      schema: {
        operationId: 'verifyLoginCode',
        summary: 'Exchange a challenge and its code for a session token',
        tags: ['auth'],
        body: verifyCodeBody,
        response: { 200: verifyCodeResponse, ...errorResponsesFor([400, 401, 429]) }
      }
    },
    async (request) => {
      const now = clock();
      const origin = originKey(loginKeys, clientIp(request));
      await enforceRateLimit(
        store,
        verifyCounterKey(origin),
        env.OTP_VERIFICATIONS_PER_IP,
        IP_WINDOW_MS,
        now
      );
      const email = normalizeEmail(request.body.email);
      const key = emailKey(loginKeys, email);
      const challenge = await store.recordChallengeAttempt(key, request.body.challengeId, now);
      const member = await store.findActiveUserByEmail(email);

      let reason: string | null = null;
      if (challenge === null) {
        reason = 'no_open_challenge';
      } else if (!matches(challenge, email, request.body.code)) {
        reason =
          challenge.attempts >= challenge.maxAttempts ? 'wrong_code_last_attempt' : 'wrong_code';
      } else if (!(await store.consumeChallenge(key, challenge.id, now))) {
        reason = 'already_used';
      } else if (member?.blockedAt != null) {
        reason = 'blocked';
      } else if (challenge.userId !== null && member?.id !== challenge.userId) {
        reason = 'member_changed';
      }
      const activated = reason === null ? await store.activateMember(email, now) : null;
      if (reason === null && activated === null) {
        reason = 'not_a_member';
      }
      if (reason !== null || activated === null) {
        logRefusal(request, key, 'verify', reason ?? 'not_a_member');
        // Only failures against existing members are recorded, so the log holds no unknown emails.
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

      await store.clearLoginLimits([
        throttleKey(key),
        ...Object.values(sendCounterKeys(key, origin))
      ]);
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
      const expiresAt = new Date(now.getTime() + env.SESSION_TTL_MINUTES * 60 * SECOND_MS);
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
