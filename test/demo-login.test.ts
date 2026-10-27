import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_CODE,
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  memberId,
  START,
  sentCode
} from './auth-helpers.js';

const DEMO_EMAIL = 'admin@demo.example.com';
const DEMO_ENV = { DEMO_LOGIN_ENABLED: 'true', DEMO_LOGIN_EMAILS: DEMO_EMAIL };

describe('demo login', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.app.close();
  });

  async function ask(email: string) {
    return harness.call({ method: 'POST', url: '/v1/auth/request-code', payload: { email } });
  }

  async function verify(challengeId: string, email: string, code: string) {
    return harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email, code }
    });
  }

  it('signs a demo account in with the access code and sends no email', async () => {
    harness = await createHarness(DEMO_ENV);
    await harness.store.ensureUser(DEMO_EMAIL, 'admin', START);

    const asked = await ask(DEMO_EMAIL);

    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toMatchObject({ delivery: 'access_code', codeLength: null });
    expect(harness.outbox).toHaveLength(0);
    const verified = await verify(asked.json().challengeId, DEMO_EMAIL, ACCESS_CODE);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ user: { email: DEMO_EMAIL } });
  });

  it('keeps the emailed code for any email outside the demo list', async () => {
    harness = await createHarness(DEMO_ENV);
    await harness.store.ensureUser(DEMO_EMAIL, 'admin', START);

    const asked = await ask(ADMIN_EMAIL);

    expect(asked.json()).toMatchObject({ delivery: 'email', codeLength: 8 });
    expect(sentCode(harness, ADMIN_EMAIL)).toMatch(/^\d{8}$/);
    expect((await verify(asked.json().challengeId, ADMIN_EMAIL, ACCESS_CODE)).statusCode).toBe(401);
  });

  it('refuses a demo account that an admin blocked', async () => {
    harness = await createHarness(DEMO_ENV);
    await harness.store.ensureUser(DEMO_EMAIL, 'viewer', START);
    const adminToken = await login(harness, ADMIN_EMAIL);
    const id = await memberId(harness, adminToken, DEMO_EMAIL);
    await harness.call({
      method: 'POST',
      url: `/v1/team/members/${id}/block`,
      token: adminToken
    });

    const asked = await ask(DEMO_EMAIL);

    expect(asked.statusCode).toBe(202);
    expect((await verify(asked.json().challengeId, DEMO_EMAIL, ACCESS_CODE)).statusCode).toBe(401);
  });

  it('answers an unknown demo email like any other, without a usable challenge', async () => {
    harness = await createHarness(DEMO_ENV);

    const asked = await ask(DEMO_EMAIL);

    expect(asked.statusCode).toBe(202);
    expect((await verify(asked.json().challengeId, DEMO_EMAIL, ACCESS_CODE)).statusCode).toBe(401);
  });

  it('emails a code to a demo address when the flag is off', async () => {
    harness = await createHarness({ DEMO_LOGIN_EMAILS: DEMO_EMAIL });
    await harness.store.ensureUser(DEMO_EMAIL, 'admin', START);

    const asked = await ask(DEMO_EMAIL);

    expect(asked.json()).toMatchObject({ delivery: 'email', codeLength: 8 });
    expect(sentCode(harness, DEMO_EMAIL)).toMatch(/^\d{8}$/);
    expect((await verify(asked.json().challengeId, DEMO_EMAIL, ACCESS_CODE)).statusCode).toBe(401);
  });
});
