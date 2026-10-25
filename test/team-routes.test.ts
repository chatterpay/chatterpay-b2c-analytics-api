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

  it('lists the name and the last audited activity apart from the last login', async () => {
    const loggedInAt = harness.now().toISOString();
    harness.advance(60_000);
    await invite('later@example.com', 'viewer');

    const response = await harness.call({
      method: 'GET',
      url: '/v1/team/members',
      token: adminToken
    });

    const items = response.json().items as Array<{
      email: string;
      name: string | null;
      lastLoginAt: string | null;
      lastActivityAt: string | null;
    }>;
    expect(items.find((item) => item.email === ADMIN_EMAIL)).toMatchObject({
      name: null,
      lastLoginAt: loggedInAt,
      lastActivityAt: harness.now().toISOString()
    });
    expect(items.find((item) => item.email === VIEWER_EMAIL)).toMatchObject({
      name: null,
      lastActivityAt: null
    });
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
    expect(list.json()).toEqual({
      items: [body],
      nextCursor: null,
      counts: { pending: 1, history: 0 }
    });
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

    const pending = await harness.call({
      method: 'GET',
      url: '/v1/team/invites?view=pending',
      token: adminToken
    });
    expect(pending.json()).toMatchObject({ items: [], counts: { pending: 0, history: 1 } });
    const history = await harness.call({
      method: 'GET',
      url: '/v1/team/invites?view=history',
      token: adminToken
    });
    expect(history.json().items).toEqual([expect.objectContaining({ id, status: 'expired' })]);

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
      url: '/v1/team/invites?view=history',
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

  it('rejects a change of the own role or the own removal, and still acts on others', async () => {
    const adminId = await memberId(harness, adminToken, ADMIN_EMAIL);
    const viewerId = await memberId(harness, adminToken, VIEWER_EMAIL);
    const secondId = await memberId(harness, adminToken, SECOND_ADMIN_EMAIL);

    // The rule applies whatever role is asked, including the current one.
    for (const role of ['viewer', 'admin'] as const) {
      const own = await harness.call({
        method: 'PATCH',
        url: `/v1/team/members/${adminId}`,
        token: adminToken,
        payload: { role }
      });
      expect(own.statusCode).toBe(403);
      expect(own.headers['cache-control']).toBe('private, no-store');
      expect(own.json()).toMatchObject({ code: 'CANNOT_CHANGE_OWN_ROLE' });
    }

    const self = await harness.call({
      method: 'DELETE',
      url: `/v1/team/members/${adminId}`,
      token: adminToken
    });
    expect(self.statusCode).toBe(403);
    expect(self.json()).toMatchObject({ code: 'CANNOT_REMOVE_SELF' });

    const members = await harness.call({
      method: 'GET',
      url: '/v1/team/members',
      token: adminToken
    });
    expect(members.json().items).toContainEqual(
      expect.objectContaining({ id: adminId, role: 'admin' })
    );
    const activity = await harness.call({
      method: 'GET',
      url: '/v1/team/activity',
      token: adminToken
    });
    expect(
      activity.json().items.filter((item: { action: string }) => item.action !== 'login')
    ).toEqual([]);

    const promoted = await harness.call({
      method: 'PATCH',
      url: `/v1/team/members/${viewerId}`,
      token: adminToken,
      payload: { role: 'admin' }
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ id: viewerId, role: 'admin' });

    const removed = await harness.call({
      method: 'DELETE',
      url: `/v1/team/members/${secondId}`,
      token: adminToken
    });
    expect(removed.statusCode).toBe(204);
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

    // The routes refuse acting on oneself first, so the store check is exercised directly: only
    // two admins acting on each other at the same time reach it through the API.
    expect(await harness.store.changeRole(adminId, 'viewer')).toEqual({ kind: 'last_admin' });
    expect(await harness.store.removeUser(adminId, harness.now())).toEqual({ kind: 'last_admin' });
    expect(await harness.store.changeRole(adminId, 'admin')).toMatchObject({ kind: 'ok' });

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

    // At most one demotion wins; the MongoDB store may undo both, never neither.
    const kinds = results.map((result) => result.kind);
    expect(kinds.filter((kind) => kind === 'ok').length).toBeLessThanOrEqual(1);
    expect(kinds).toContain('last_admin');
    const admins = (await harness.store.listActiveUsers()).filter((user) => user.role === 'admin');
    expect(admins.length).toBeGreaterThanOrEqual(1);
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

  it('pages the activity by cursor in a stable order without repeats or gaps', async () => {
    // The harness clock stands still, so every event shares one instant and the order rests on the
    // tie-break alone.
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await invite(`${name}@example.com`, 'viewer');
    }
    const all = await harness.call({
      method: 'GET',
      url: '/v1/team/activity?limit=100',
      token: adminToken
    });
    const allIds = (all.json().items as { id: string }[]).map((item) => item.id);
    expect(all.json().nextCursor).toBeNull();
    expect(allIds).toHaveLength(6);

    const pagedIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
      const page = await harness.call({
        method: 'GET',
        url: `/v1/team/activity?${query}`,
        token: adminToken
      });
      expect(page.statusCode).toBe(200);
      const body = page.json() as { items: { id: string }[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      pagedIds.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages += 1;
      if (pages === 1) {
        // Events stored after the first page are newer than the cursor: later pages skip them
        // instead of shifting by one.
        harness.advance(1000);
        await invite('later@example.com', 'viewer');
      }
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(pagedIds).toEqual(allIds);
  });

  it('rejects an activity cursor that does not hold an instant and an event id', async () => {
    const forged = [
      'not a cursor',
      Buffer.from('garbage', 'utf8').toString('base64url'),
      Buffer.from(`${harness.now().toISOString()}|../../x`, 'utf8').toString('base64url'),
      Buffer.from(`not-a-date|${UNKNOWN_ID}`, 'utf8').toString('base64url'),
      'x'.repeat(201)
    ];
    for (const cursor of forged) {
      const response = await harness.call({
        method: 'GET',
        url: `/v1/team/activity?cursor=${encodeURIComponent(cursor)}`,
        token: adminToken
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  describe('invite pages', () => {
    type InvitePage = {
      items: { id: string; status: string; createdAt: string }[];
      nextCursor: string | null;
      counts: { pending: number; history: number };
    };

    async function seedInvites(count: number, prefix: string): Promise<string[]> {
      const createdBy = (await harness.store.findActiveUserByEmail(ADMIN_EMAIL))?.id ?? '';
      const ids: string[] = [];
      for (const index of Array.from({ length: count }, (_, position) => position)) {
        const result = await harness.store.createInvite(
          {
            email: `${prefix}-${index}@example.com`,
            role: 'viewer',
            createdBy,
            mutationId: randomUUID(),
            expiresAt: new Date(harness.now().getTime() + 7 * DAY_MS)
          },
          harness.now()
        );
        if (result.kind === 'conflict') {
          throw new Error('seed invite conflict');
        }
        ids.push(result.invite.id);
        // Pairs share one instant, so the order also rests on the id tie-break.
        if (index % 2 === 1) {
          harness.advance(1000);
        }
      }
      return ids;
    }

    async function page(query: string): Promise<InvitePage> {
      const response = await harness.call({
        method: 'GET',
        url: `/v1/team/invites?${query}`,
        token: adminToken
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      return response.json() as InvitePage;
    }

    /** Reads every page of a view; `onPage` runs after each page, before the next one. */
    async function readAll(
      view: 'pending' | 'history',
      limit: number,
      onPage: (index: number) => Promise<void> = async () => {}
    ): Promise<{ ids: string[]; sizes: number[] }> {
      const ids: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const query: string =
          cursor === null
            ? `view=${view}&limit=${limit}`
            : `view=${view}&limit=${limit}&cursor=${cursor}`;
        const body = await page(query);
        ids.push(...body.items.map((item) => item.id));
        sizes.push(body.items.length);
        cursor = body.nextCursor;
        await onPage(sizes.length);
      } while (cursor !== null && sizes.length < 50);
      return { ids, sizes };
    }

    it('answers empty views without a next page when there are no invites', async () => {
      for (const view of ['pending', 'history']) {
        expect(await page(`view=${view}`)).toEqual({
          items: [],
          nextCursor: null,
          counts: { pending: 0, history: 0 }
        });
      }
    });

    it('lists a single pending invite on one page', async () => {
      const [id] = await seedInvites(1, 'single');
      const pending = await page('view=pending&limit=1');
      expect(pending.items.map((item) => item.id)).toEqual([id]);
      expect(pending.nextCursor).toBeNull();
      expect(pending.counts).toEqual({ pending: 1, history: 0 });
      expect((await page('view=history')).items).toEqual([]);
    });

    it('pages 104 invites by view without repeats, gaps or empty pages', async () => {
      const expiring = await seedInvites(20, 'expiring');
      harness.advance(7 * DAY_MS + 60_000);
      adminToken = await login(harness, ADMIN_EMAIL);
      const open = await seedInvites(84, 'open');
      const revoked = open.filter((_, index) => index % 6 === 0);
      for (const id of revoked) {
        expect((await harness.store.revokeInvite(id, harness.now())).kind).toBe('ok');
      }

      const pending = await readAll('pending', 25);
      const history = await readAll('history', 25);
      const pendingSet = new Set(open.filter((id) => !revoked.includes(id)));
      expect(pending.sizes).toEqual([25, 25, 20]);
      expect(history.sizes).toEqual([25, 9]);
      expect(new Set(pending.ids)).toEqual(pendingSet);
      expect(new Set(history.ids)).toEqual(new Set([...expiring, ...revoked]));
      expect(new Set([...pending.ids, ...history.ids]).size).toBe(104);

      // The pages follow the order of one page that holds the whole view.
      expect((await page('view=pending&limit=100')).items.map((item) => item.id)).toEqual(
        pending.ids
      );
      const first = await page('view=history&limit=100');
      expect(first.items.map((item) => item.id)).toEqual(history.ids);
      expect(first.counts).toEqual({ pending: 70, history: 34 });
      expect(new Set(first.items.map((item) => item.status))).toEqual(
        new Set(['expired', 'revoked'])
      );

      // A view that ends on a full page answers no further cursor instead of an empty page.
      expect((await readAll('pending', 10)).sizes).toEqual([10, 10, 10, 10, 10, 10, 10]);
    });

    it('keeps the remaining pages when invites are created between pages', async () => {
      await seedInvites(9, 'stable');
      const before = (await page('view=pending&limit=100')).items.map((item) => item.id);

      const paged = await readAll('pending', 4, async (index) => {
        if (index === 1) {
          // Newer invites sort before the cursor, so later pages neither shift nor repeat.
          harness.advance(1000);
          await seedInvites(3, 'later');
        }
      });

      expect(paged.ids).toEqual(before);
      expect(paged.sizes).toEqual([4, 4, 1]);
      expect((await page('view=pending&limit=100')).counts).toEqual({ pending: 12, history: 0 });
    });

    it('rejects a view, limit or cursor outside the invite contract', async () => {
      const activityCursor = Buffer.from(
        `${harness.now().toISOString()}|0123456789abcdef01234567`,
        'utf8'
      ).toString('base64url');
      const queries = [
        'view=all',
        'view=pending&limit=0',
        'view=history&limit=101',
        'limit=abc',
        'status=revoked',
        'cursor=not%20a%20cursor',
        `cursor=${Buffer.from('garbage', 'utf8').toString('base64url')}`,
        `cursor=${Buffer.from(`not-a-date|${UNKNOWN_ID}`, 'utf8').toString('base64url')}`,
        `cursor=${Buffer.from(`${harness.now().toISOString()}|${UNKNOWN_ID}|x`, 'utf8').toString('base64url')}`,
        // An activity cursor carries an ObjectId, never an invite id.
        `view=history&cursor=${activityCursor}`,
        `cursor=${'x'.repeat(201)}`
      ];
      for (const query of queries) {
        const response = await harness.call({
          method: 'GET',
          url: `/v1/team/invites?${query}`,
          token: adminToken
        });
        expect(response.statusCode, query).toBe(400);
        expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
      }
    });

    it('accepts a well-formed cursor of an unknown invite as a position', async () => {
      await seedInvites(2, 'position');
      harness.advance(1000);
      const future = Buffer.from(`${harness.now().toISOString()}|${UNKNOWN_ID}`, 'utf8').toString(
        'base64url'
      );
      expect((await page(`view=pending&cursor=${future}`)).items).toHaveLength(2);
    });
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
      ['GET', '/v1/team/invites?view=history&limit=1', undefined],
      [
        'GET',
        `/v1/team/invites?view=pending&cursor=${Buffer.from(`2026-01-01T00:00:00.000Z|${UNKNOWN_ID}`).toString('base64url')}`,
        undefined
      ],
      ['GET', '/v1/team/activity', undefined],
      [
        'GET',
        `/v1/team/activity?limit=1&cursor=${Buffer.from(`2026-01-01T00:00:00.000Z|${UNKNOWN_ID}`).toString('base64url')}`,
        undefined
      ],
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
