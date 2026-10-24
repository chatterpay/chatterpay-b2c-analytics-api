import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_CODE,
  ADMIN_EMAIL,
  createHarness,
  type Harness,
  login,
  memberId,
  requestCode,
  SECOND_ADMIN_EMAIL,
  VIEWER_EMAIL
} from './auth-helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('team routes', () => {
  let harness: Harness;
  let adminToken: string;

  beforeEach(async () => {
    harness = await createHarness();
    adminToken = await login(harness, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function invite(email: string, role: 'admin' | 'viewer', mutationId = randomUUID()) {
    return harness.call({
      method: 'POST',
      url: '/v1/team/invites',
      token: adminToken,
      payload: { email, role, mutationId }
    });
  }

  it('lists active members sorted by email', async () => {
    const response = await harness.call({
      method: 'GET',
      url: '/v1/team/members',
      token: adminToken
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const items = response.json().items as { email: string; role: string; lastLoginAt: unknown }[];
    expect(items.map((item) => [item.email, item.role])).toEqual([
      [ADMIN_EMAIL, 'admin'],
      [SECOND_ADMIN_EMAIL, 'admin'],
      [VIEWER_EMAIL, 'viewer']
    ]);
    expect(items[0]?.lastLoginAt).toBe(harness.now().toISOString());
    expect(items[1]?.lastLoginAt).toBeNull();
  });

  it('creates invites idempotently by mutationId with simulated delivery', async () => {
    const mutationId = randomUUID();
    const created = await invite('New.Member@example.com', 'viewer', mutationId);

    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('private, no-store');
    const body = created.json();
    expect(body).toMatchObject({
      email: 'new.member@example.com',
      role: 'viewer',
      status: 'simulated',
      resendCount: 0,
      lastSentAt: harness.now().toISOString(),
      createdBy: ADMIN_EMAIL,
      expiresAt: new Date(harness.now().getTime() + 7 * DAY_MS).toISOString()
    });
    expect(body).not.toHaveProperty('mutationId');

    const replayed = await invite('new.member@example.com', 'viewer', mutationId);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(body);

    const changedPayload = await invite('new.member@example.com', 'admin', mutationId);
    expect(changedPayload.statusCode).toBe(409);

    const list = await harness.call({ method: 'GET', url: '/v1/team/invites', token: adminToken });
    expect(list.json().items).toEqual([body]);
  });

  it('answers 409 to invites for members or emails with a pending invite', async () => {
    expect((await invite('pending@example.com', 'viewer')).statusCode).toBe(201);

    for (const email of [VIEWER_EMAIL, 'pending@example.com', 'PENDING@example.com']) {
      const response = await invite(email, 'admin');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('resends and revokes pending invites only', async () => {
    const id = (await invite('pending@example.com', 'viewer')).json().id;
    harness.advance(60_000);

    const resent = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${id}/resend`,
      token: adminToken
    });
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toMatchObject({
      status: 'simulated',
      resendCount: 1,
      lastSentAt: harness.now().toISOString()
    });

    const revoked = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${id}/revoke`,
      token: adminToken
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'revoked', resendCount: 1 });

    for (const action of ['resend', 'revoke']) {
      const response = await harness.call({
        method: 'POST',
        url: `/v1/team/invites/${id}/${action}`,
        token: adminToken
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'CONFLICT' });
    }

    const unknown = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${UNKNOWN_ID}/resend`,
      token: adminToken
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' });

    const malformed = await harness.call({
      method: 'POST',
      url: '/v1/team/invites/not-a-uuid/revoke',
      token: adminToken
    });
    expect(malformed.statusCode).toBe(400);

    // A revoked invite no longer blocks a new one.
    expect((await invite('pending@example.com', 'admin')).statusCode).toBe(201);
  });

  it('reports invites past seven days as expired and does not accept them', async () => {
    const id = (await invite('late@example.com', 'viewer')).json().id;
    harness.advance(7 * DAY_MS);
    // The admin session from beforeEach has expired by now.
    adminToken = await login(harness, ADMIN_EMAIL);

    const list = await harness.call({ method: 'GET', url: '/v1/team/invites', token: adminToken });
    expect(list.json().items[0]).toMatchObject({ id, status: 'expired' });

    const resend = await harness.call({
      method: 'POST',
      url: `/v1/team/invites/${id}/resend`,
      token: adminToken
    });
    expect(resend.statusCode).toBe(409);

    const challengeId = await requestCode(harness, 'late@example.com');
    const verified = await harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email: 'late@example.com', code: ACCESS_CODE }
    });
    expect(verified.statusCode).toBe(401);
  });

  it('accepts the invite on first login with the invite role', async () => {
    const created = (await invite('invited@example.com', 'viewer')).json();

    const challengeId = await requestCode(harness, 'invited@example.com');
    const verified = await harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId, email: 'invited@example.com', code: ACCESS_CODE }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user).toMatchObject({ email: 'invited@example.com', role: 'viewer' });

    const invites = await harness.call({
      method: 'GET',
      url: '/v1/team/invites',
      token: adminToken
    });
    expect(invites.json().items[0]).toMatchObject({ id: created.id, status: 'accepted' });

    const viewerTeam = await harness.call({
      method: 'GET',
      url: '/v1/team/members',
      token: verified.json().token
    });
    expect(viewerTeam.statusCode).toBe(403);

    const activity = await harness.call({
      method: 'GET',
      url: '/v1/team/activity?limit=3',
      token: adminToken
    });
    expect(activity.json().items).toEqual([
      expect.objectContaining({ action: 'login', actor: 'invited@example.com' }),
      expect.objectContaining({
        action: 'invite_accepted',
        actor: 'invited@example.com',
        target: 'invited@example.com'
      }),
      expect.objectContaining({
        action: 'invite_created',
        actor: ADMIN_EMAIL,
        target: 'invited@example.com',
        outcome: 'success'
      })
    ]);
  });

  it('applies a role change to the next request without a new login', async () => {
    const secondToken = await login(harness, SECOND_ADMIN_EMAIL);
    const adminId = await memberId(harness, adminToken, ADMIN_EMAIL);

    const changed = await harness.call({
      method: 'PATCH',
      url: `/v1/team/members/${adminId}`,
      token: secondToken,
      payload: { role: 'viewer' }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ id: adminId, role: 'viewer' });

    const team = await harness.call({ method: 'GET', url: '/v1/team/members', token: adminToken });
    expect(team.statusCode).toBe(403);
    const me = await harness.call({ method: 'GET', url: '/v1/auth/me', token: adminToken });
    expect(me.json().user.role).toBe('viewer');
    const metrics = await harness.call({
      method: 'GET',
      url: '/v1/metrics/users',
      token: adminToken
    });
    expect(metrics.statusCode).toBe(200);
  });

  it('removes a member and rejects its token', async () => {
    const viewerToken = await login(harness, VIEWER_EMAIL);
    const viewerId = await memberId(harness, adminToken, VIEWER_EMAIL);

    const removed = await harness.call({
      method: 'DELETE',
      url: `/v1/team/members/${viewerId}`,
      token: adminToken
    });
    expect(removed.statusCode).toBe(204);
    expect(removed.headers['cache-control']).toBe('private, no-store');

    expect(
      (await harness.call({ method: 'GET', url: '/v1/auth/me', token: viewerToken })).statusCode
    ).toBe(401);
    const session = await harness.store.findSession(String(decodeJwt(viewerToken).jti));
    expect(session?.revokedAt).toEqual(harness.now());

    const again = await harness.call({
      method: 'DELETE',
      url: `/v1/team/members/${viewerId}`,
      token: adminToken
    });
    expect(again.statusCode).toBe(404);

    const relogin = await requestCode(harness, VIEWER_EMAIL);
    const verified = await harness.call({
      method: 'POST',
      url: '/v1/auth/verify-code',
      payload: { challengeId: relogin, email: VIEWER_EMAIL, code: ACCESS_CODE }
    });
    expect(verified.statusCode).toBe(401);

    const members = await harness.call({
      method: 'GET',
      url: '/v1/team/members',
      token: adminToken
    });
    expect(members.json().items.map((item: { email: string }) => item.email)).not.toContain(
      VIEWER_EMAIL
    );
  });

  it('never leaves the team without an active admin', async () => {
    const secondToken = await login(harness, SECOND_ADMIN_EMAIL);
    const adminId = await memberId(harness, adminToken, ADMIN_EMAIL);
    const secondId = await memberId(harness, adminToken, SECOND_ADMIN_EMAIL);

    expect(
      (
        await harness.call({
          method: 'DELETE',
          url: `/v1/team/members/${secondId}`,
          token: adminToken
        })
      ).statusCode
    ).toBe(204);
    expect(
      (await harness.call({ method: 'GET', url: '/v1/auth/me', token: secondToken })).statusCode
    ).toBe(401);

    const demote = await harness.call({
      method: 'PATCH',
      url: `/v1/team/members/${adminId}`,
      token: adminToken,
      payload: { role: 'viewer' }
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json()).toMatchObject({ code: 'CONFLICT' });

    const remove = await harness.call({
      method: 'DELETE',
      url: `/v1/team/members/${adminId}`,
      token: adminToken
    });
    expect(remove.statusCode).toBe(409);

    const keep = await harness.call({
      method: 'PATCH',
      url: `/v1/team/members/${adminId}`,
      token: adminToken,
      payload: { role: 'admin' }
    });
    expect(keep.statusCode).toBe(200);

    const unknown = await harness.call({
      method: 'PATCH',
      url: `/v1/team/members/${UNKNOWN_ID}`,
      token: adminToken,
      payload: { role: 'viewer' }
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('keeps one admin under concurrent demotions', async () => {
    const adminId = await memberId(harness, adminToken, ADMIN_EMAIL);
    const secondId = await memberId(harness, adminToken, SECOND_ADMIN_EMAIL);

    const results = await Promise.all([
      harness.store.changeRole(adminId, 'viewer'),
      harness.store.changeRole(secondId, 'viewer')
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(['last_admin', 'ok']);
  });

  it('returns activity newest first within the limit', async () => {
    await invite('one@example.com', 'viewer');
    await invite('two@example.com', 'viewer');

    const response = await harness.call({
      method: 'GET',
      url: '/v1/team/activity?limit=2',
      token: adminToken
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { target: string | null }) => item.target)).toEqual([
      'two@example.com',
      'one@example.com'
    ]);

    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'since=1']) {
      const invalid = await harness.call({
        method: 'GET',
        url: `/v1/team/activity?${query}`,
        token: adminToken
      });
      expect(invalid.statusCode).toBe(400);
    }
  });

  it.each([
    [
      'POST',
      '/v1/team/invites',
      { email: 'x@example.com', role: 'viewer', mutationId: randomUUID(), extra: true }
    ],
    [
      'POST',
      '/v1/team/invites',
      { email: 'x@example.com', role: 'owner', mutationId: randomUUID() }
    ],
    [
      'POST',
      '/v1/team/invites',
      { email: 'x@example.com', role: 'viewer', mutationId: 'not-a-uuid' }
    ],
    ['PATCH', `/v1/team/members/${UNKNOWN_ID}`, { role: 'viewer', status: 'removed' }],
    ['PATCH', `/v1/team/members/${UNKNOWN_ID}`, {}]
  ] as const)('rejects invalid body on %s %s with 400', async (method, url, payload) => {
    const response = await harness.call({ method, url, token: adminToken, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  describe('as viewer', () => {
    let viewerToken: string;

    beforeEach(async () => {
      viewerToken = await login(harness, VIEWER_EMAIL);
    });

    it.each([
      ['GET', '/v1/team/members', undefined],
      ['GET', '/v1/team/invites', undefined],
      ['GET', '/v1/team/activity', undefined],
      [
        'POST',
        '/v1/team/invites',
        { email: 'x@example.com', role: 'admin', mutationId: UNKNOWN_ID }
      ],
      ['POST', `/v1/team/invites/${UNKNOWN_ID}/resend`, undefined],
      ['POST', `/v1/team/invites/${UNKNOWN_ID}/revoke`, undefined],
      ['PATCH', `/v1/team/members/${UNKNOWN_ID}`, { role: 'admin' }],
      ['DELETE', `/v1/team/members/${UNKNOWN_ID}`, undefined]
    ] as const)('answers 403 to %s %s', async (method, url, payload) => {
      const response = await harness.call({
        method,
        url,
        token: viewerToken,
        ...(payload === undefined ? {} : { payload })
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('answers 401 to team routes without a session', async () => {
      const response = await harness.call({ method: 'GET', url: '/v1/team/members' });
      expect(response.statusCode).toBe(401);
    });
  });
});
