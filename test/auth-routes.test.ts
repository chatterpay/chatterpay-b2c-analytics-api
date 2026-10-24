import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { MemoryStore } from '../src/store/memory-store.js';
import {
  ACCESS_CODE,
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  requestCode,
  START,
  VIEWER_EMAIL
} from './auth-helpers.js';

const MINUTE_MS = 60 * 1000;

function base64url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('auth routes', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function verify(payload: Record<string, unknown>, ip?: string) {
    return harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload,
      ...(ip === undefined ? {} : { ip })
    });
  }

  async function me(token: string) {
    return harness.call({ method: 'GET', url: '/v1/auth/me', token });
  }

  it('logs in and the token opens /me and the metrics', async () => {
    const challengeResponse = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ` ${ADMIN_EMAIL.toUpperCase()}` }
    });
    // Leading spaces fail the email format, so the API normalizes only valid input.
    expect(challengeResponse.statusCode).toBe(400);

    const challengeId = await requestCode(harness, 'Admin@Example.com');
    const response = await verify({ challengeId, email: 'ADMIN@example.com', code: ACCESS_CODE });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json();
    expect(body.user).toMatchObject({ email: ADMIN_EMAIL, role: 'admin', status: 'active' });
    expect(body.user.lastLoginAt).toBe(harness.now().toISOString());
    expect(body.expiresAt).toBe(new Date(harness.now().getTime() + 120 * MINUTE_MS).toISOString());

    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({
      iss: 'chatterpay-analytics-api',
      aud: 'chatterpay-analytics-site',
      sub: body.user.id,
      role: 'admin'
    });

    const meResponse = await me(body.token);
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.headers['cache-control']).toBe('private, no-store');
    expect(meResponse.json()).toEqual({ user: body.user, session: { expiresAt: body.expiresAt } });

    const metrics = await harness.call({
      method: 'GET',
      url: '/v1/metrics/overview',
      token: body.token
    });
    expect(metrics.statusCode).toBe(200);
  });

  it('answers request-code with the same shape for unknown emails', async () => {
    const known = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL }
    });
    const unknown = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: 'nobody@example.com' }
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(Object.keys(unknown.json())).toEqual(Object.keys(known.json()));
    expect(unknown.headers['cache-control']).toBe('private, no-store');
  });

  it('answers the same 401 to every verification failure', async () => {
    const failures = [];

    const wrongCode = await requestCode(harness, ADMIN_EMAIL);
    failures.push(
      await verify({ challengeId: wrongCode, email: ADMIN_EMAIL, code: 'wrong-code-123' })
    );

    const unknownEmail = await requestCode(harness, 'nobody@example.com');
    failures.push(
      await verify({ challengeId: unknownEmail, email: 'nobody@example.com', code: ACCESS_CODE })
    );

    const mismatch = await requestCode(harness, VIEWER_EMAIL);
    failures.push(await verify({ challengeId: mismatch, email: ADMIN_EMAIL, code: ACCESS_CODE }));

    failures.push(
      await verify({
        challengeId: '00000000-0000-4000-8000-000000000000',
        email: ADMIN_EMAIL,
        code: ACCESS_CODE
      })
    );

    const expired = await requestCode(harness, ADMIN_EMAIL);
    harness.advance(10 * MINUTE_MS);
    failures.push(await verify({ challengeId: expired, email: ADMIN_EMAIL, code: ACCESS_CODE }));

    const consumed = await requestCode(harness, ADMIN_EMAIL);
    expect(
      (await verify({ challengeId: consumed, email: ADMIN_EMAIL, code: ACCESS_CODE })).statusCode
    ).toBe(200);
    failures.push(await verify({ challengeId: consumed, email: ADMIN_EMAIL, code: ACCESS_CODE }));

    for (const failure of failures) {
      expect(failure.statusCode).toBe(401);
      expect(failure.json()).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired code'
      });
    }
  });

  it('kills a challenge after five attempts', async () => {
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await verify({
        challengeId,
        email: ADMIN_EMAIL,
        code: `wrong-code-${attempt}`
      });
      expect(response.statusCode).toBe(401);
    }

    const response = await verify({ challengeId, email: ADMIN_EMAIL, code: ACCESS_CODE });
    expect(response.statusCode).toBe(401);
  });

  it('rate limits request-code per email and per IP with Retry-After', async () => {
    for (let index = 0; index < 5; index += 1) {
      await requestCode(harness, ADMIN_EMAIL);
    }
    const perEmail = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL },
      ip: '198.51.100.7'
    });
    expect(perEmail.statusCode).toBe(429);
    expect(perEmail.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(perEmail.headers['retry-after'])).toBe(15 * 60);
    expect(perEmail.headers['cache-control']).toBe('private, no-store');

    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await harness.call({
        method: 'POST',
        url: '/v1/auth/request-code',
        payload: { email: `user${index}@example.com` },
        ip: '2001:db8::1'
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status === 202)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);

    harness.advance(15 * MINUTE_MS);
    expect(await requestCode(harness, ADMIN_EMAIL)).toEqual(expect.any(String));
  });

  it('rate limits verify-code per IP', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      const response = await verify(
        { challengeId: 'unknown', email: ADMIN_EMAIL, code: 'wrong-code-123' },
        '192.0.2.44'
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses[30]).toBe(429);

    const otherIp = await verify(
      { challengeId: 'unknown', email: ADMIN_EMAIL, code: 'wrong-code-123' },
      '192.0.2.45'
    );
    expect(otherIp.statusCode).toBe(401);
  });

  it('falls back to the socket IP when x-client-ip is not an IP literal', async () => {
    for (let index = 0; index < 20; index += 1) {
      const response = await harness.call({
        method: 'POST',
        url: '/v1/auth/request-code',
        payload: { email: `user${index}@example.com` },
        ip: `not-an-ip-${index}`
      });
      expect(response.statusCode).toBe(202);
    }
    const response = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: 'last@example.com' },
      ip: 'still-not-an-ip'
    });
    expect(response.statusCode).toBe(429);
  });

  it('rejects forged, expired, wrong-audience, wrong-algorithm and unsigned tokens', async () => {
    const token = await login(harness, ADMIN_EMAIL);
    const claims = decodeJwt(token);
    const nowSeconds = Math.floor(harness.now().getTime() / 1000);
    const base = (): SignJWT =>
      new SignJWT({ role: 'admin' })
        .setIssuer('chatterpay-analytics-api')
        .setAudience('chatterpay-analytics-site')
        .setSubject(String(claims.sub))
        .setJti(String(claims.jti))
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 600);

    const { privateKey: otherKey } = await generateKeyPair('EdDSA');
    const forged = await base()
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
      .sign(otherKey);
    const expired = await base()
      .setIssuedAt(nowSeconds - 7200)
      .setExpirationTime(nowSeconds - 60)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
      .sign(harness.privateKey);
    const wrongAudience = await base()
      .setAudience('another-site')
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
      .sign(harness.privateKey);
    const wrongIssuer = await base()
      .setIssuer('another-issuer')
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
      .sign(harness.privateKey);
    const hmac = await base()
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!'));
    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
      ...claims,
      iat: nowSeconds,
      exp: nowSeconds + 600
    })}.`;
    const { publicKey } = generateKeyPairSync('ed25519');
    const publicKeyAsSecret = await base()
      .setProtectedHeader({ alg: 'HS256' })
      .sign(publicKey.export({ format: 'der', type: 'spki' }));

    expect((await me(token)).statusCode).toBe(200);
    for (const rejected of [
      forged,
      expired,
      wrongAudience,
      wrongIssuer,
      hmac,
      unsigned,
      publicKeyAsSecret,
      `${token}x`,
      'not-a-jwt'
    ]) {
      const response = await me(rejected);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('expires the session with the clock', async () => {
    const token = await login(harness, ADMIN_EMAIL);
    harness.advance(119 * MINUTE_MS);
    expect((await me(token)).statusCode).toBe(200);
    harness.advance(MINUTE_MS);
    expect((await me(token)).statusCode).toBe(401);
  });

  it('revokes the session on logout', async () => {
    const token = await login(harness, VIEWER_EMAIL);
    const otherToken = await login(harness, VIEWER_EMAIL);

    const response = await harness.call({ method: 'POST', url: '/v1/auth/logout', token });
    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('private, no-store');

    expect((await me(token)).statusCode).toBe(401);
    expect((await harness.call({ method: 'POST', url: '/v1/auth/logout', token })).statusCode).toBe(
      401
    );
    expect((await me(otherToken)).statusCode).toBe(200);
  });

  it('answers 401 to /me and logout without a session', async () => {
    expect((await harness.call({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
    expect((await harness.call({ method: 'POST', url: '/v1/auth/logout' })).statusCode).toBe(401);
  });

  it.each([
    ['/v1/auth/request-code', { email: ADMIN_EMAIL, role: 'admin' }],
    ['/v1/auth/request-code', { email: 'not-an-email' }],
    ['/v1/auth/request-code', { email: { $ne: null } }],
    ['/v1/auth/verify-code', { challengeId: 'x', email: ADMIN_EMAIL, code: ACCESS_CODE, extra: 1 }],
    ['/v1/auth/verify-code', { challengeId: 'x', email: ADMIN_EMAIL, code: '12345' }],
    ['/v1/auth/verify-code', { challengeId: 'x'.repeat(65), email: ADMIN_EMAIL, code: ACCESS_CODE }]
  ])('rejects invalid body on %s with 400', async (url, payload) => {
    const response = await harness.call({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('never returns or records the code or the token', async () => {
    const adminToken = await login(harness, ADMIN_EMAIL);
    const challengeId = await requestCode(harness, VIEWER_EMAIL);
    await verify({ challengeId, email: VIEWER_EMAIL, code: 'wrong-code-123' });
    const viewerToken = await login(harness, VIEWER_EMAIL);
    await harness.call({ method: 'POST', url: '/v1/auth/logout', token: viewerToken });

    const activity = await harness.call({
      method: 'GET',
      url: '/v1/team/activity',
      token: adminToken
    });
    const actions = (activity.json().items as { action: string }[]).map((item) => item.action);
    expect(actions).toEqual(['logout', 'login', 'login_failed', 'login']);

    for (const body of harness.bodies) {
      expect(body).not.toContain(ACCESS_CODE);
      expect(body).not.toContain('wrong-code-123');
    }
    const stored = JSON.stringify(await harness.store.listActivity(100));
    for (const secret of [ACCESS_CODE, 'wrong-code-123', adminToken, viewerToken]) {
      expect(activity.body).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  it('does not record failures of unknown emails', async () => {
    const challengeId = await requestCode(harness, 'nobody@example.com');
    await verify({ challengeId, email: 'nobody@example.com', code: ACCESS_CODE });

    expect(await harness.store.listActivity(100)).toEqual([]);
  });
});

describe('auth configuration', () => {
  it('answers 503 on verify-code without DEMO_ACCESS_CODE', async () => {
    const harness = await createHarness({ DEMO_ACCESS_CODE: '' });
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const response = await harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email: ADMIN_EMAIL, code: ACCESS_CODE }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await harness.app.close();
  });

  it('works with the ephemeral key generated at startup', async () => {
    const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DEMO_ACCESS_CODE: ACCESS_CODE });
    const store = new MemoryStore();
    await store.ensureUser(ADMIN_EMAIL, 'admin', START);
    const app = await buildApp(env, { store, clock: () => START });
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL }
    });
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId: challenge.json().challengeId, email: ADMIN_EMAIL, code: ACCESS_CODE }
    });
    expect(verified.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${verified.json().token}` }
    });
    expect(me.statusCode).toBe(200);
    expect(decodeJwt(verified.json().token).jti).toEqual(expect.any(String));
    await app.close();
  });

  it('refuses the in-memory store in production unless allowed', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const production = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      DEMO_ACCESS_CODE: ACCESS_CODE,
      JWT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    };

    await expect(buildApp(loadEnv(production))).rejects.toThrowError(/ALLOW_IN_MEMORY_STORE/);

    const app = await buildApp(loadEnv({ ...production, ALLOW_IN_MEMORY_STORE: 'true' }));
    await app.ready();
    await app.close();
  });
});
