import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { emailKey, loadLoginCodeKeys } from '../src/auth/login-code.js';
import type { EmailAttempt, EmailMessage, EmailProvider } from '../src/email/types.js';
import {
  ACCESS_CODE,
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  OTP_EMAIL_HMAC_SECRET,
  OTP_HMAC_SECRET,
  requestCode,
  sentCode,
  VIEWER_EMAIL
} from './auth-helpers.js';

const INVITEE = 'invitee@example.com';
const MINUTE_MS = 60 * 1000;

/** Provider that records the messages and answers with the current `next` attempt. */
class ControlledProvider implements EmailProvider {
  readonly name = 'resend' as const;
  readonly calls: EmailMessage[] = [];
  next: EmailAttempt = { kind: 'sent', messageId: 'msg-1' };

  async send(message: EmailMessage): Promise<EmailAttempt> {
    this.calls.push(message);
    return this.next;
  }
}

const UNAVAILABLE: EmailAttempt = {
  kind: 'failed',
  failure: 'unavailable',
  retryable: true,
  retryAfterMs: null
};

/** A code of the right shape that differs from `code`. */
function otherCode(code: string): string {
  return code.replace(/^./, (digit) => String((Number(digit) + 1) % 10));
}

function codeOf(harness: Harness, email: string): string {
  const code = sentCode(harness, email);
  if (code === undefined) {
    throw new Error('no login code email');
  }
  return code;
}

describe('login with a code sent by email', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.app.close();
  });

  async function verify(challengeId: string, email: string, code: string) {
    return harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email, code }
    });
  }

  it('emails an eight-digit code in the asked language and signs in with it once', async () => {
    harness = await createHarness({ OTP_TTL_SECONDS: '300' });
    const response = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL, locale: 'es' }
    });
    expect(response.statusCode).toBe(202);
    const { challengeId, expiresAt, delivery, codeLength } = response.json();
    expect({ delivery, codeLength }).toEqual({ delivery: 'email', codeLength: 8 });
    expect(expiresAt).toBe(new Date(harness.now().getTime() + 5 * MINUTE_MS).toISOString());

    expect(harness.outbox).toHaveLength(1);
    const message = harness.outbox[0];
    expect(message?.to).toBe(ADMIN_EMAIL);
    expect(message?.idempotencyKey).toBe(`login-code/${challengeId}`);
    expect(message?.subject).toBe('Tu código para ingresar a ChatterPay Analytics');
    expect(message?.text).toContain('5');
    const code = codeOf(harness, ADMIN_EMAIL);
    expect(harness.bodies.join('\n')).not.toContain(code);

    // The shared demo code opens no session for an account outside the demo login.
    expect((await verify(challengeId, ADMIN_EMAIL, ACCESS_CODE)).statusCode).toBe(401);
    const verified = await verify(challengeId, ADMIN_EMAIL, code);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user.email).toBe(ADMIN_EMAIL);
    expect((await verify(challengeId, ADMIN_EMAIL, code)).statusCode).toBe(401);
  });

  it('answers the same to an unknown email and emails nothing', async () => {
    harness = await createHarness();
    const known = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: VIEWER_EMAIL }
    });
    const unknown = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: 'nobody@example.com' }
    });

    expect(unknown.statusCode).toBe(202);
    const { challengeId: _known, expiresAt: _knownAt, ...knownRest } = known.json();
    const { challengeId: _unknown, expiresAt: _unknownAt, ...unknownRest } = unknown.json();
    expect(unknownRest).toEqual(knownRest);
    expect(harness.outbox.map((item) => item.to)).toEqual([VIEWER_EMAIL]);
  });

  it('keeps no code nor email in clear in the stored challenge', async () => {
    harness = await createHarness();
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const code = codeOf(harness, ADMIN_EMAIL);
    const keys = loadLoginCodeKeys({ OTP_HMAC_SECRET, OTP_EMAIL_HMAC_SECRET });
    const key = emailKey(keys, ADMIN_EMAIL);

    const challenge = await harness.store.recordChallengeAttempt(key, challengeId, harness.now());
    expect(challenge).toMatchObject({ id: challengeId, kind: 'otp', emailKey: key, attempts: 1 });
    const stored = JSON.stringify(challenge);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(ADMIN_EMAIL);
    expect(challenge?.codeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong, expired, reused or superseded code, another email and another challenge', async () => {
    harness = await createHarness();
    const first = await requestCode(harness, ADMIN_EMAIL);
    const firstCode = codeOf(harness, ADMIN_EMAIL);

    expect((await verify(first, ADMIN_EMAIL, otherCode(firstCode))).statusCode).toBe(401);
    expect((await verify(first, VIEWER_EMAIL, firstCode)).statusCode).toBe(401);
    expect((await verify(randomUUID(), ADMIN_EMAIL, firstCode)).statusCode).toBe(401);

    harness.advance(MINUTE_MS);
    const second = await requestCode(harness, ADMIN_EMAIL);
    const secondCode = codeOf(harness, ADMIN_EMAIL);
    // The new challenge replaces the first: its code and its id no longer verify.
    expect((await verify(first, ADMIN_EMAIL, firstCode)).statusCode).toBe(401);
    // Two draws repeat once in a hundred million; only different codes tell the challenges apart.
    if (firstCode !== secondCode) {
      expect((await verify(second, ADMIN_EMAIL, firstCode)).statusCode).toBe(401);
    }

    harness.advance(5 * MINUTE_MS);
    expect((await verify(second, ADMIN_EMAIL, secondCode)).statusCode).toBe(401);
  });

  it('spends the challenge after five attempts, the right code included', async () => {
    harness = await createHarness();
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const code = codeOf(harness, ADMIN_EMAIL);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await verify(challengeId, ADMIN_EMAIL, otherCode(code))).statusCode).toBe(401);
    }

    expect((await verify(challengeId, ADMIN_EMAIL, code)).statusCode).toBe(401);
  });

  it('lets only one of two concurrent verifications consume the code', async () => {
    harness = await createHarness();
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const code = codeOf(harness, ADMIN_EMAIL);

    const results = await Promise.all([
      verify(challengeId, ADMIN_EMAIL, code),
      verify(challengeId, ADMIN_EMAIL, code)
    ]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
  });

  it('does not verify a code once the login code key changed', async () => {
    harness = await createHarness();
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const code = codeOf(harness, ADMIN_EMAIL);
    const rotated = await createHarness({ OTP_HMAC_SECRET: 'c'.repeat(64) });
    // The challenge moves to an app with another code key, as after a rotation.
    const keys = loadLoginCodeKeys({ OTP_HMAC_SECRET, OTP_EMAIL_HMAC_SECRET });
    const challenge = await harness.store.recordChallengeAttempt(
      emailKey(keys, ADMIN_EMAIL),
      challengeId,
      harness.now()
    );
    if (challenge === null) {
      throw new Error('no challenge');
    }
    await rotated.store.issueChallenge({ ...challenge, attempts: 0 });

    const response = await rotated.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email: ADMIN_EMAIL, code }
    });
    expect(response.statusCode).toBe(401);
    await rotated.app.close();
  });

  it('activates an invited account only once its email confirms the code', async () => {
    harness = await createHarness();
    const adminToken = await login(harness, ADMIN_EMAIL);
    const created = await harness.call({
      method: 'POST',
      url: '/v1/team/invites',
      token: adminToken,
      payload: { email: INVITEE, role: 'viewer', mutationId: randomUUID(), locale: 'br' }
    });
    expect(created.statusCode).toBe(201);

    const challengeId = await requestCode(harness, INVITEE);
    expect(harness.outbox.filter((message) => message.to === INVITEE)).toHaveLength(2);
    expect(await harness.store.findActiveUserByEmail(INVITEE)).toBeNull();

    const code = codeOf(harness, INVITEE);
    expect((await verify(challengeId, INVITEE, otherCode(code))).statusCode).toBe(401);
    expect(await harness.store.findActiveUserByEmail(INVITEE)).toBeNull();

    const verified = await verify(challengeId, INVITEE, code);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user).toMatchObject({ email: INVITEE, role: 'viewer' });
    const actions = (await harness.store.listActivity(10)).map((event) => event.action);
    expect(actions).toContain('invite_accepted');
  });

  it('keeps the previous code valid and lets the person ask again when the email fails', async () => {
    const provider = new ControlledProvider();
    harness = await createHarness({}, provider);
    const first = await requestCode(harness, ADMIN_EMAIL);
    const firstCode = codeOf(harness, ADMIN_EMAIL);
    harness.advance(MINUTE_MS);
    provider.next = UNAVAILABLE;
    const calls = provider.calls.length;

    const failed = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL }
    });

    expect(failed.statusCode).toBe(202);
    expect(provider.calls.length - calls).toBe(3);
    provider.next = { kind: 'sent', messageId: 'msg-2' };
    // The failed code did not count: no penalty step, only the cooldown since the first code.
    expect(
      (
        await harness.call({
          method: 'POST',
          url: '/v1/auth/request-code',
          payload: { email: ADMIN_EMAIL }
        })
      ).statusCode
    ).toBe(202);
    // The first code stayed the open one until this new code was sent.
    expect((await verify(first, ADMIN_EMAIL, firstCode)).statusCode).toBe(401);
  });

  it('logs neither the code nor the email', async () => {
    const provider = new ControlledProvider();
    harness = await createHarness({ LOG_LEVEL: 'info' }, provider);
    const challengeId = await requestCode(harness, ADMIN_EMAIL);
    const code = codeOf(harness, ADMIN_EMAIL);
    await verify(challengeId, ADMIN_EMAIL, otherCode(code));
    await verify(challengeId, ADMIN_EMAIL, code);
    await requestCode(harness, 'nobody@example.com');
    await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: 'nobody@example.com' }
    });
    provider.next = UNAVAILABLE;
    await requestCode(harness, VIEWER_EMAIL);

    const logged = harness.logs.join('');
    expect(logged).toContain('login step refused');
    expect(logged).toContain('login code email not delivered');
    for (const secret of [code, otherCode(code), codeOf(harness, VIEWER_EMAIL)]) {
      expect(logged).not.toContain(secret);
    }
    for (const email of [ADMIN_EMAIL, VIEWER_EMAIL, 'nobody@example.com']) {
      expect(logged).not.toContain(email);
    }
  });
});

describe('invitation emails', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.app.close();
  });

  async function invite(token: string, mutationId = randomUUID(), locale?: string) {
    return harness.call({
      method: 'POST',
      url: '/v1/team/invites',
      token,
      payload: { email: INVITEE, role: 'viewer', mutationId, ...(locale ? { locale } : {}) }
    });
  }

  function invitations(): EmailMessage[] {
    return harness.outbox.filter((message) => message.to === INVITEE);
  }

  it('emails a new invite in its language and records the simulated delivery', async () => {
    harness = await createHarness();
    const adminToken = await login(harness, ADMIN_EMAIL);
    const mutationId = randomUUID();

    const response = await invite(adminToken, mutationId, 'es');

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('simulated');
    expect(body.delivery).toEqual({
      state: 'simulated',
      attempts: 1,
      lastAttemptAt: harness.now().toISOString(),
      failure: null
    });
    expect(invitations()).toHaveLength(1);
    expect(invitations()[0]).toMatchObject({
      to: INVITEE,
      subject: 'Te invitaron a ChatterPay Analytics',
      idempotencyKey: `invite/${body.id}/0`
    });
    expect(invitations()[0]?.text).toContain('http://localhost:4000/login');

    // A replay of the same submit answers the invite without a second email.
    const replay = await invite(adminToken, mutationId, 'es');
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(body.id);
    expect(invitations()).toHaveLength(1);
  });

  it('emails a resent invite with a new idempotency key', async () => {
    harness = await createHarness();
    const adminToken = await login(harness, ADMIN_EMAIL);
    const { id } = (await invite(adminToken)).json();

    const resent = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${id}/resend`,
      token: adminToken
    });

    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toMatchObject({ resendCount: 1, delivery: { state: 'simulated' } });
    expect(invitations().map((message) => message.idempotencyKey)).toEqual([
      `invite/${id}/0`,
      `invite/${id}/1`
    ]);
    expect(invitations()[0]?.subject).toBe('You are invited to ChatterPay Analytics');
  });

  it('keeps an invite pending when its email fails, and sends it on resend', async () => {
    const provider = new ControlledProvider();
    harness = await createHarness({}, provider);
    const adminToken = await login(harness, ADMIN_EMAIL);
    provider.next = UNAVAILABLE;

    const created = await invite(adminToken);

    expect(created.statusCode).toBe(201);
    const { id, status, delivery } = created.json();
    expect(status).toBe('simulated');
    expect(delivery).toMatchObject({ state: 'failed', attempts: 3, failure: 'unavailable' });
    const pending = await harness.call({
      method: 'GET',
      url: '/v1/team/invites?view=pending',
      token: adminToken
    });
    expect(pending.json().items.map((item: { id: string }) => item.id)).toEqual([id]);

    provider.next = { kind: 'sent', messageId: 'msg-2' };
    const resent = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${id}/resend`,
      token: adminToken
    });
    expect(resent.json().delivery).toMatchObject({ state: 'sent', attempts: 1, failure: null });
    expect(invitations().map((message) => message.idempotencyKey)).toEqual([
      `invite/${id}/0`,
      `invite/${id}/0`,
      `invite/${id}/0`,
      `invite/${id}/1`
    ]);
  });

  it('does not email a revoked invite', async () => {
    harness = await createHarness();
    const adminToken = await login(harness, ADMIN_EMAIL);
    const { id } = (await invite(adminToken)).json();

    const revoked = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${id}/revoke`,
      token: adminToken
    });

    expect(revoked.json()).toMatchObject({ status: 'revoked', delivery: { state: 'simulated' } });
    expect(invitations()).toHaveLength(1);
  });
});
