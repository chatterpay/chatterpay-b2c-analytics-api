import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory-store.js';
import {
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  memberId,
  requestCode,
  SECOND_ADMIN_EMAIL,
  START,
  sentCode,
  VIEWER_EMAIL
} from './auth-helpers.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe('member block', () => {
  let harness: Harness;
  let adminToken: string;

  beforeEach(async () => {
    harness = await createHarness();
    adminToken = await login(harness, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function operate(id: string, operation: string, token = adminToken) {
    return harness.call({ method: 'POST', url: `/v1/team/members/${id}/${operation}`, token });
  }

  async function me(token: string) {
    return harness.call({ method: 'GET', url: '/v1/auth/me', token });
  }

  async function verify(challengeId: string, email: string, code: string) {
    return harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email, code }
    });
  }

  async function members() {
    const response = await harness.call({
      method: 'GET',
      url: '/v1/team/members',
      token: adminToken
    });
    return response.json().items as {
      email: string;
      status: string;
      blockedAt: string | null;
      loginLockedUntil: string | null;
    }[];
  }

  it('revokes the sessions and the open code of a blocked member and refuses new ones', async () => {
    const viewerToken = await login(harness, VIEWER_EMAIL);
    const id = await memberId(harness, adminToken, VIEWER_EMAIL);
    harness.advance(MINUTE_MS);
    const openChallenge = await requestCode(harness, VIEWER_EMAIL);
    const openCode = sentCode(harness, VIEWER_EMAIL) ?? '';

    const blocked = await operate(id, 'block');

    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({
      email: VIEWER_EMAIL,
      status: 'blocked',
      blockedAt: harness.now().toISOString()
    });
    expect((await me(viewerToken)).statusCode).toBe(401);
    const session = await harness.store.findSession(String(decodeJwt(viewerToken).jti));
    expect(session?.revokedAt).toEqual(harness.now());
    expect((await verify(openChallenge, VIEWER_EMAIL, openCode)).statusCode).toBe(401);

    harness.advance(MINUTE_MS);
    const sent = harness.outbox.length;
    const challengeId = await requestCode(harness, VIEWER_EMAIL);
    expect(harness.outbox).toHaveLength(sent);
    expect((await verify(challengeId, VIEWER_EMAIL, openCode)).statusCode).toBe(401);

    expect((await members()).find((member) => member.email === VIEWER_EMAIL)).toMatchObject({
      status: 'blocked'
    });
    const actions = (await harness.store.listActivity(5)).map((event) => event.action);
    expect(actions).toContain('member_blocked');
  });

  it('keeps the block after the automatic limits expire, until an admin unblocks', async () => {
    const id = await memberId(harness, adminToken, VIEWER_EMAIL);
    const viewerToken = await login(harness, VIEWER_EMAIL);
    await operate(id, 'block');

    harness.advance(2 * DAY_MS);
    adminToken = await login(harness, ADMIN_EMAIL);
    const sent = harness.outbox.length;
    await requestCode(harness, VIEWER_EMAIL);
    expect(harness.outbox).toHaveLength(sent);
    expect((await members()).find((member) => member.email === VIEWER_EMAIL)?.status).toBe(
      'blocked'
    );

    const unblocked = await operate(id, 'unblock');
    expect(unblocked.statusCode).toBe(200);
    expect(unblocked.json()).toMatchObject({ status: 'active', blockedAt: null });
    // Unblocking opens no session and brings back neither the old session nor an old code.
    expect((await me(viewerToken)).statusCode).toBe(401);
    // The request made while blocked counted like any other, so the cooldown applies.
    harness.advance(MINUTE_MS);
    const newToken = await login(harness, VIEWER_EMAIL);
    expect((await me(newToken)).statusCode).toBe(200);
    const actions = (await harness.store.listActivity(10)).map((event) => event.action);
    expect(actions).toContain('member_unblocked');
  });

  it('refuses to block oneself, and refuses every member operation to a viewer', async () => {
    const adminId = await memberId(harness, adminToken, ADMIN_EMAIL);
    const viewerId = await memberId(harness, adminToken, VIEWER_EMAIL);
    const viewerToken = await login(harness, VIEWER_EMAIL);

    const self = await operate(adminId, 'block');
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ code: 'CANNOT_BLOCK_SELF' });

    for (const operation of ['block', 'unblock', 'unlock-login']) {
      expect((await operate(adminId, operation, viewerToken)).statusCode).toBe(403);
    }
    expect((await operate(viewerId, 'block', viewerToken)).statusCode).toBe(403);
    expect((await operate(randomUUID(), 'block')).statusCode).toBe(404);
  });

  it('lets a blocked admin hold no admin power and still counts the team as having one', async () => {
    const secondId = await memberId(harness, adminToken, SECOND_ADMIN_EMAIL);
    const secondToken = await login(harness, SECOND_ADMIN_EMAIL);
    await operate(secondId, 'block');

    expect(
      (await harness.call({ method: 'GET', url: '/v1/team/members', token: secondToken }))
        .statusCode
    ).toBe(401);
    // The email stays taken: a blocked member cannot come back through a new invite.
    const invite = await harness.call({
      method: 'POST',
      url: '/v1/team/invites',
      token: adminToken,
      payload: { email: SECOND_ADMIN_EMAIL, role: 'admin', mutationId: randomUUID() }
    });
    expect(invite.statusCode).toBe(409);
  });

  it('shows the automatic login lockout, which an admin can lift', async () => {
    const id = await memberId(harness, adminToken, VIEWER_EMAIL);
    await requestCode(harness, VIEWER_EMAIL);
    harness.advance(MINUTE_MS);
    await requestCode(harness, VIEWER_EMAIL);
    const lockedUntil = new Date(harness.now().getTime() + 5 * MINUTE_MS).toISOString();

    const listed = (await members()).find((member) => member.email === VIEWER_EMAIL);
    expect(listed).toMatchObject({ status: 'active', loginLockedUntil: lockedUntil });
    const refused = await harness.call({
      method: 'POST',
      url: '/v1/auth/request-code',
      payload: { email: VIEWER_EMAIL }
    });
    expect(refused.statusCode).toBe(429);

    const unlocked = await operate(id, 'unlock-login');
    expect(unlocked.statusCode).toBe(204);
    expect((await members()).find((member) => member.email === VIEWER_EMAIL)).toMatchObject({
      loginLockedUntil: null
    });
    expect(await requestCode(harness, VIEWER_EMAIL)).toEqual(expect.any(String));
    const actions = (await harness.store.listActivity(5)).map((event) => event.action);
    expect(actions).toContain('login_lockout_cleared');
  });

  it('revokes the open code of a removed member, who cannot sign in again', async () => {
    const id = await memberId(harness, adminToken, VIEWER_EMAIL);
    const challengeId = await requestCode(harness, VIEWER_EMAIL);
    const code = sentCode(harness, VIEWER_EMAIL) ?? '';

    expect(
      (
        await harness.call({
          method: 'DELETE',
          url: `/v1/team/members/${id}`,
          token: adminToken
        })
      ).statusCode
    ).toBe(204);

    expect((await verify(challengeId, VIEWER_EMAIL, code)).statusCode).toBe(401);
    expect((await operate(id, 'block')).statusCode).toBe(404);
  });
});

describe('last admin with blocked members', () => {
  it('counts only unblocked admins when blocking, demoting or removing', async () => {
    const store = new MemoryStore();
    const first = await store.ensureUser('first@example.com', 'admin', START);
    const second = await store.ensureUser('second@example.com', 'admin', START);

    expect(await store.setBlocked(second.id, true, START)).toMatchObject({ kind: 'ok' });
    expect(await store.setBlocked(first.id, true, START)).toEqual({ kind: 'last_admin' });
    expect(await store.changeRole(first.id, 'viewer')).toEqual({ kind: 'last_admin' });
    expect(await store.removeUser(first.id, START)).toEqual({ kind: 'last_admin' });
    // The blocked admin can still be demoted or removed: the unblocked one remains.
    expect(await store.changeRole(second.id, 'viewer')).toMatchObject({ kind: 'ok' });
  });
});
