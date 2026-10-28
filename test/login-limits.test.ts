import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  requestCode,
  sentCode,
  VIEWER_EMAIL
} from './auth-helpers.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

describe('login code limits', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.app.close();
  });

  async function ask(email: string, ip?: string) {
    return harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email },
      ...(ip === undefined ? {} : { ip })
    });
  }

  function retryAfter(response: { headers: Record<string, unknown> }): number {
    return Number(response.headers['retry-after']);
  }

  it('sends no new code until the open one expired, even after the cooldown', async () => {
    harness = await createHarness({ OTP_TTL_SECONDS: '300' });
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const code = sentCode(harness, ADMIN_EMAIL) ?? '';

    harness.advance(MINUTE_MS);
    const early = await ask(ADMIN_EMAIL);
    expect(early.statusCode).toBe(429);
    expect(retryAfter(early)).toBe(4 * 60);
    expect(harness.outbox).toHaveLength(1);

    harness.advance(4 * MINUTE_MS);
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);
    expect(
      (
        await harness.call({
          method: 'POST',
          url: '/v1/auth/verify-code',
          payload: { challengeId, email: ADMIN_EMAIL, code }
        })
      ).statusCode
    ).toBe(401);
  });

  it('lets a demo account ask again after the cooldown, before its challenge expires', async () => {
    const demo = 'admin@demo.example.com';
    harness = await createHarness({
      OTP_TTL_SECONDS: '300',
      DEMO_LOGIN_ENABLED: 'true',
      DEMO_LOGIN_EMAILS: demo
    });
    await harness.store.ensureUser(demo, 'admin', harness.now());
    expect((await ask(demo)).statusCode).toBe(202);

    harness.advance(30 * SECOND_MS);
    expect(retryAfter(await ask(demo))).toBe(30);
    harness.advance(30 * SECOND_MS);
    expect((await ask(demo)).statusCode).toBe(202);
  });

  it('waits the cooldown between two codes for the same email', async () => {
    harness = await createHarness();
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);

    harness.advance(30 * SECOND_MS);
    const early = await ask(ADMIN_EMAIL);
    expect(early.statusCode).toBe(429);
    expect(early.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(retryAfter(early)).toBe(30);

    harness.advance(30 * SECOND_MS);
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);
  });

  it('grows the wait from none to 5 and 15 minutes, never above 15', async () => {
    harness = await createHarness();
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);
    harness.advance(MINUTE_MS);
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);

    const third = await ask(ADMIN_EMAIL);
    expect(third.statusCode).toBe(429);
    expect(retryAfter(third)).toBe(5 * 60);
    harness.advance(5 * MINUTE_MS);
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);

    const fourth = await ask(ADMIN_EMAIL);
    expect(retryAfter(fourth)).toBe(15 * 60);
    harness.advance(15 * MINUTE_MS);
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);

    const fifth = await ask(ADMIN_EMAIL);
    expect(retryAfter(fifth)).toBe(15 * 60);
  });

  it('does not extend a wait with the requests refused during it', async () => {
    harness = await createHarness();
    await ask(ADMIN_EMAIL);
    harness.advance(MINUTE_MS);
    await ask(ADMIN_EMAIL);

    const waits: number[] = [];
    for (const step of [10, 90, 100, 99]) {
      harness.advance(step * SECOND_MS);
      const refused = await ask(ADMIN_EMAIL);
      expect(refused.statusCode).toBe(429);
      waits.push(retryAfter(refused));
    }
    expect(waits).toEqual([290, 200, 100, 1]);

    harness.advance(SECOND_MS);
    expect((await ask(ADMIN_EMAIL)).statusCode).toBe(202);
  });

  it('clears the wait of the email after a login', async () => {
    harness = await createHarness();
    await ask(VIEWER_EMAIL);
    harness.advance(MINUTE_MS);
    await ask(VIEWER_EMAIL);
    expect((await ask(VIEWER_EMAIL)).statusCode).toBe(429);
    harness.advance(5 * MINUTE_MS);

    await login(harness, VIEWER_EMAIL);

    expect((await ask(VIEWER_EMAIL)).statusCode).toBe(202);
  });

  it('caps the codes per email and client IP by hour and by day', async () => {
    harness = await createHarness({ OTP_LOCKOUT_STEPS_SECONDS: '0', OTP_SENDS_PER_EMAIL_DAY: '7' });
    const sameIp = '198.51.100.20';
    for (let index = 0; index < 5; index += 1) {
      expect((await ask(ADMIN_EMAIL, sameIp)).statusCode).toBe(202);
      harness.advance(MINUTE_MS);
    }
    const hourly = await ask(ADMIN_EMAIL, sameIp);
    expect(hourly.statusCode).toBe(429);
    expect(retryAfter(hourly)).toBe(55 * 60);

    // Another IP asking for the same email is counted apart, so it cannot use up this quota.
    expect((await ask(ADMIN_EMAIL, '198.51.100.21')).statusCode).toBe(202);

    // The hourly window restarted; two more codes reach the daily cap of seven.
    harness.advance(55 * MINUTE_MS);
    for (let index = 0; index < 2; index += 1) {
      expect((await ask(ADMIN_EMAIL, sameIp)).statusCode).toBe(202);
      harness.advance(MINUTE_MS);
    }
    const daily = await ask(ADMIN_EMAIL, sameIp);
    expect(daily.statusCode).toBe(429);
    expect(retryAfter(daily)).toBe((24 * 60 - 62) * 60);
    harness.advance(24 * 60 * MINUTE_MS);
    expect((await ask(ADMIN_EMAIL, sameIp)).statusCode).toBe(202);
  });

  it('applies the same limits to unknown emails', async () => {
    harness = await createHarness();
    const known: number[] = [];
    const unknown: number[] = [];
    for (const wait of [0, MINUTE_MS, 0]) {
      harness.advance(wait);
      const member = await ask(VIEWER_EMAIL);
      const stranger = await ask('nobody@example.com');
      known.push(member.statusCode, retryAfter(member) || 0);
      unknown.push(stranger.statusCode, retryAfter(stranger) || 0);
    }

    expect(unknown).toEqual(known);
    expect(known).toEqual([202, 0, 202, 0, 429, 300]);
  });

  it('issues one code when two requests for the email arrive together', async () => {
    harness = await createHarness();

    const responses = await Promise.all([ask(ADMIN_EMAIL), ask(ADMIN_EMAIL)]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 429]);
    expect(harness.outbox).toHaveLength(1);
  });

  it('never leaves a code request locked for more than 15 minutes', async () => {
    harness = await createHarness();
    for (let round = 0; round < 8; round += 1) {
      const response = await ask(ADMIN_EMAIL);
      if (response.statusCode === 429) {
        expect(retryAfter(response)).toBeLessThanOrEqual(15 * 60);
        harness.advance(retryAfter(response) * SECOND_MS);
      } else {
        expect(sentCode(harness, ADMIN_EMAIL)).toMatch(/^\d{8}$/);
      }
    }
  });

  it('checks the per-IP limit before touching the email limits', async () => {
    harness = await createHarness({ OTP_REQUESTS_PER_IP: '2' });
    await ask('one@example.com', '203.0.113.50');
    await ask('two@example.com', '203.0.113.50');

    const refused = await ask(ADMIN_EMAIL, '203.0.113.50');

    expect(refused.statusCode).toBe(429);
    expect(harness.outbox).toHaveLength(0);
    // The refused request did not start the cooldown of the email.
    expect((await ask(ADMIN_EMAIL, '203.0.113.51')).statusCode).toBe(202);
    expect(await requestCode(harness, 'three@example.com')).toEqual(expect.any(String));
  });
});
