import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAttempt, EmailMessage, EmailProvider } from '../src/email/types.js';
import {
  ACCESS_CODE,
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  requestCode
} from './auth-helpers.js';

const INVITEE = 'invitee@example.com';

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

/**
 * Code of the last login email sent to the address.
 *
 * @param outbox - Messages sent.
 * @param email - Recipient.
 * @returns The six digits.
 */
function lastCode(outbox: EmailMessage[], email: string): string {
  const message = outbox.filter((item) => item.to === email).at(-1);
  const code = /\b(\d{6})\b/.exec(message?.text ?? '')?.[1];
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

  async function loginByEmail(email: string): Promise<string> {
    const challengeId = await requestCode(harness, email);
    const response = await verify(challengeId, email, lastCode(harness.outbox, email));
    return response.json().token;
  }

  it('emails a one-time code to a member, in the asked language, and signs in with it', async () => {
    harness = await createHarness({ LOGIN_CODE_DELIVERY: 'email' });
    const response = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL, locale: 'es' }
    });
    expect(response.statusCode).toBe(202);
    const { challengeId } = response.json();

    expect(harness.outbox).toHaveLength(1);
    const message = harness.outbox[0];
    expect(message?.to).toBe(ADMIN_EMAIL);
    expect(message?.idempotencyKey).toBe(`login-code/${challengeId}`);
    expect(message?.subject).toMatch(/^\d{6} es tu código de ChatterPay Analytics$/);
    const code = lastCode(harness.outbox, ADMIN_EMAIL);
    expect(harness.bodies.join('\n')).not.toContain(code);

    // The shared access code no longer opens a session.
    expect((await verify(challengeId, ADMIN_EMAIL, ACCESS_CODE)).statusCode).toBe(401);
    const verified = await verify(challengeId, ADMIN_EMAIL, code);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user.email).toBe(ADMIN_EMAIL);
    // One use only.
    expect((await verify(challengeId, ADMIN_EMAIL, code)).statusCode).toBe(401);
  });

  it('answers the same to an unknown email and emails nothing', async () => {
    harness = await createHarness({ LOGIN_CODE_DELIVERY: 'email' });
    const response = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: 'nobody@example.com' }
    });

    expect(response.statusCode).toBe(202);
    expect(Object.keys(response.json()).sort()).toEqual(['challengeId', 'expiresAt']);
    expect(harness.outbox).toEqual([]);
  });

  it('accepts a code only on the challenge it was sent for', async () => {
    harness = await createHarness({ LOGIN_CODE_DELIVERY: 'email' });
    const first = await requestCode(harness, ADMIN_EMAIL);
    const firstCode = lastCode(harness.outbox, ADMIN_EMAIL);
    const second = await requestCode(harness, ADMIN_EMAIL);
    const secondCode = lastCode(harness.outbox, ADMIN_EMAIL);
    // Two draws can repeat; the test needs two different codes.
    if (firstCode === secondCode) {
      return;
    }

    expect((await verify(second, ADMIN_EMAIL, firstCode)).statusCode).toBe(401);
    expect((await verify(first, ADMIN_EMAIL, firstCode)).statusCode).toBe(200);
  });

  it('activates an invited account only once its email confirms the code', async () => {
    harness = await createHarness({ LOGIN_CODE_DELIVERY: 'email' });
    const adminToken = await loginByEmail(ADMIN_EMAIL);
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

    expect((await verify(challengeId, INVITEE, '000000')).statusCode).toBe(401);
    expect(await harness.store.findActiveUserByEmail(INVITEE)).toBeNull();

    const verified = await verify(challengeId, INVITEE, lastCode(harness.outbox, INVITEE));
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user).toMatchObject({ email: INVITEE, role: 'viewer' });
    const actions = (await harness.store.listActivity(10)).map((event) => event.action);
    expect(actions).toContain('invite_accepted');
  });

  it('answers 202 when the code email could not be delivered', async () => {
    const provider = new ControlledProvider();
    provider.next = UNAVAILABLE;
    harness = await createHarness({ LOGIN_CODE_DELIVERY: 'email' }, provider);

    const response = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: ADMIN_EMAIL }
    });

    expect(response.statusCode).toBe(202);
    expect(provider.calls).toHaveLength(3);
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
    expect(harness.outbox).toHaveLength(1);
    expect(harness.outbox[0]).toMatchObject({
      to: INVITEE,
      subject: 'Te invitaron a ChatterPay Analytics',
      idempotencyKey: `invite/${body.id}/0`
    });
    expect(harness.outbox[0]?.text).toContain('http://localhost:4000/login');

    // A replay of the same submit answers the invite without a second email.
    const replay = await invite(adminToken, mutationId, 'es');
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(body.id);
    expect(harness.outbox).toHaveLength(1);
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
    expect(harness.outbox.map((message) => message.idempotencyKey)).toEqual([
      `invite/${id}/0`,
      `invite/${id}/1`
    ]);
    expect(harness.outbox[0]?.subject).toBe('You are invited to ChatterPay Analytics');
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
    expect(provider.calls.map((message) => message.idempotencyKey)).toEqual([
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
    expect(harness.outbox).toHaveLength(1);
  });
});
