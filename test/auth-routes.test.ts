import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { SimulatedEmailProvider } from '../src/email/simulated-provider.js';
import { MemoryStore } from '../src/store/memory-store.js';
import {
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  OTP_EMAIL_HMAC_SECRET,
  OTP_HMAC_SECRET,
  requestCode,
  SECOND_ADMIN_EMAIL,
  START,
  sentCode,
  VIEWER_EMAIL
} from './auth-helpers.js';

const MINUTE_MS = 60 * 1000;

/** A code of the right shape that differs from `code`. */
function otherCode(code: string): string {
  return code.replace(/^./, (digit) => String((Number(digit) + 1) % 10));
}

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
    const code = sentCode(harness, ADMIN_EMAIL) ?? '';
    expect(code).toMatch(/^\d{8}$/);
    const response = await verify({ challengeId, email: 'ADMIN@example.com', code });

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
    const adminCode = sentCode(harness, ADMIN_EMAIL) ?? '';
    failures.push(
      await verify({ challengeId: wrongCode, email: ADMIN_EMAIL, code: otherCode(adminCode) })
    );

    const unknownEmail = await requestCode(harness, 'nobody@example.com');
    failures.push(
      await verify({ challengeId: unknownEmail, email: 'nobody@example.com', code: '12345678' })
    );

    // The viewer's code, sent back with the viewer's challenge under another email.
    const mismatch = await requestCode(harness, VIEWER_EMAIL);
    const viewerCode = sentCode(harness, VIEWER_EMAIL) ?? '';
    failures.push(await verify({ challengeId: mismatch, email: ADMIN_EMAIL, code: viewerCode }));

    failures.push(
      await verify({
        challengeId: '00000000-0000-4000-8000-000000000000',
        email: ADMIN_EMAIL,
        code: adminCode
      })
    );

    // Used once by its own email, then refused.
    expect(
      (await verify({ challengeId: mismatch, email: VIEWER_EMAIL, code: viewerCode })).statusCode
    ).toBe(200);
    failures.push(await verify({ challengeId: mismatch, email: VIEWER_EMAIL, code: viewerCode }));

    const expired = await requestCode(harness, SECOND_ADMIN_EMAIL);
    harness.advance(5 * MINUTE_MS);
    failures.push(
      await verify({
        challengeId: expired,
        email: SECOND_ADMIN_EMAIL,
        code: sentCode(harness, SECOND_ADMIN_EMAIL) ?? ''
      })
    );

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

    const response = await verify({
      challengeId,
      email: ADMIN_EMAIL,
      code: sentCode(harness, ADMIN_EMAIL) ?? ''
    });
    expect(response.statusCode).toBe(401);
  });

  it('rate limits request-code per IP with Retry-After', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      const response = await harness.call({
        method: 'POST',
        url: '/v1/auth/request-code',
        payload: { email: `user${index}@example.com` },
        ip: '2001:db8::1'
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status === 202)).toHaveLength(30);
    const refused = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL },
      ip: '2001:db8::1'
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(refused.headers['retry-after'])).toBe(15 * 60);
    expect(refused.headers['cache-control']).toBe('private, no-store');

    harness.advance(15 * MINUTE_MS);
    expect(await requestCode(harness, ADMIN_EMAIL)).toEqual(expect.any(String));
  });

  it('rate limits verify-code per IP', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      const response = await verify(
        { challengeId: 'unknown', email: ADMIN_EMAIL, code: 'wrong-code-123' },
        '192.0.2.44'
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses[60]).toBe(429);

    const otherIp = await verify(
      { challengeId: 'unknown', email: ADMIN_EMAIL, code: 'wrong-code-123' },
      '192.0.2.45'
    );
    expect(otherIp.statusCode).toBe(401);
  });

  it('falls back to the socket IP when x-client-ip is not an IP literal', async () => {
    for (let index = 0; index < 30; index += 1) {
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
    ['/v1/auth/verify-code', { challengeId: 'x', email: ADMIN_EMAIL, code: '12345678', extra: 1 }],
    ['/v1/auth/verify-code', { challengeId: 'x', email: ADMIN_EMAIL, code: '12345' }],
    ['/v1/auth/verify-code', { challengeId: 'x'.repeat(65), email: ADMIN_EMAIL, code: '12345678' }]
  ])('rejects invalid body on %s with 400', async (url, payload) => {
    const response = await harness.call({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('never returns or records the code or the token', async () => {
    const adminToken = await login(harness, ADMIN_EMAIL);
    const challengeId = await requestCode(harness, VIEWER_EMAIL);
    await verify({ challengeId, email: VIEWER_EMAIL, code: 'wrong-code-123' });
    // A second code for the email waits for the cooldown.
    harness.advance(MINUTE_MS);
    const viewerToken = await login(harness, VIEWER_EMAIL);
    await harness.call({ method: 'POST', url: '/v1/auth/logout', token: viewerToken });
    const codes = harness.outbox.map((message) => sentCode(harness, message.to) ?? '');

    const activity = await harness.call({
      method: 'GET',
      url: '/v1/team/activity',
      token: adminToken
    });
    const actions = (activity.json().items as { action: string }[]).map((item) => item.action);
    expect(actions).toEqual(['logout', 'login', 'login_failed', 'login']);

    for (const body of harness.bodies) {
      for (const code of codes) {
        expect(body).not.toContain(code);
      }
      expect(body).not.toContain('wrong-code-123');
    }
    const stored = JSON.stringify(await harness.store.listActivity(100));
    for (const secret of [...codes, 'wrong-code-123', adminToken, viewerToken]) {
      expect(activity.body).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  it('does not record failures of unknown emails', async () => {
    const challengeId = await requestCode(harness, 'nobody@example.com');
    await verify({ challengeId, email: 'nobody@example.com', code: '12345678' });

    expect(await harness.store.listActivity(100)).toEqual([]);
  });
});

describe('auth configuration', () => {
  it('works with the ephemeral signing and login code keys generated at startup', async () => {
    const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const store = new MemoryStore();
    await store.ensureUser(ADMIN_EMAIL, 'admin', START);
    const provider = new SimulatedEmailProvider();
    const app = await buildApp(env, { store, clock: () => START, emailProvider: provider });
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL }
    });
    const code = provider.outbox.at(-1)?.text.match(/\b(\d{8})\b/)?.[1] ?? '';
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId: challenge.json().challengeId, email: ADMIN_EMAIL, code }
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

  it('refuses the in-memory store in production', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const production = loadEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      OTP_HMAC_SECRET,
      OTP_EMAIL_HMAC_SECRET,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_only',
      EMAIL_FROM: 'Analytics <no-reply@example.com>',
      SITE_URL: 'https://analytics.example.com',
      JWT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      MONGO_URI: 'mongodb://127.0.0.1:27017',
      B2C_MONGO_URI: 'mongodb://127.0.0.1:27017/chatterpay-dev'
    });

    await expect(buildApp(production)).rejects.toThrowError(/MongoDB store/);
  });
});
