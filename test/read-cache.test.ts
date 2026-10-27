import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/store/memory-store.js';
import { withReadCache } from '../src/store/read-cache.js';
import type { Session } from '../src/store/types.js';

const START = new Date('2026-10-27T12:00:00.000Z');
const TTL_MS = 30_000;

async function setup() {
  const inner = new MemoryStore();
  const admin = await inner.ensureUser('admin@example.com', 'admin', START);
  const viewer = await inner.ensureUser('viewer@example.com', 'admin', START);
  const session = await inner.createSession({
    jti: 'session-1',
    userId: viewer.id,
    createdAt: START,
    expiresAt: new Date(START.getTime() + 3_600_000)
  });
  let clock = START.getTime();
  const store = withReadCache(inner, { ttlMs: TTL_MS, now: () => clock });
  const reads = {
    session: vi.spyOn(inner, 'findSession'),
    user: vi.spyOn(inner, 'findUserById'),
    policy: vi.spyOn(inner, 'networkVisibility')
  };
  return {
    inner,
    store,
    admin,
    viewer,
    session,
    reads,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

describe('withReadCache', () => {
  it('reads the session, user and policy once per lifetime', async () => {
    const { store, viewer, reads, advance } = await setup();

    for (let i = 0; i < 3; i += 1) {
      await store.findSession('session-1');
      await store.findUserById(viewer.id);
      await store.networkVisibility();
    }
    expect([reads.session, reads.user, reads.policy].map((spy) => spy.mock.calls.length)).toEqual([
      1, 1, 1
    ]);

    advance(TTL_MS);
    await store.findSession('session-1');
    await store.findUserById(viewer.id);
    await store.networkVisibility();
    expect([reads.session, reads.user, reads.policy].map((spy) => spy.mock.calls.length)).toEqual([
      2, 2, 2
    ]);
  });

  it('does not cache a missing session or user', async () => {
    const { store, reads } = await setup();

    expect(await store.findSession('unknown')).toBeNull();
    expect(await store.findSession('unknown')).toBeNull();
    expect(await store.findUserById('unknown')).toBeNull();
    expect(await store.findUserById('unknown')).toBeNull();
    expect(reads.session).toHaveBeenCalledTimes(2);
    expect(reads.user).toHaveBeenCalledTimes(2);
  });

  it('serves a session revoked on this instance as revoked at once', async () => {
    const { store } = await setup();
    await store.findSession('session-1');

    await store.revokeSession('session-1', START);

    expect((await store.findSession('session-1'))?.revokedAt).toEqual(START);
  });

  it('serves a role change and a removal on this instance at once', async () => {
    const { store, viewer } = await setup();
    await store.findUserById(viewer.id);
    await store.findSession('session-1');

    expect(await store.changeRole(viewer.id, 'viewer')).toMatchObject({ kind: 'ok' });
    expect((await store.findUserById(viewer.id))?.role).toBe('viewer');

    expect(await store.removeUser(viewer.id, START)).toMatchObject({ kind: 'ok' });
    expect((await store.findUserById(viewer.id))?.status).not.toBe('active');
    expect((await store.findSession('session-1'))?.revokedAt).not.toBeNull();
  });

  it('serves a visibility change on this instance at once', async () => {
    const { store, admin } = await setup();
    const before = await store.networkVisibility();

    const result = await store.changeNetworkVisibility(
      {
        chainId: '8453',
        analyticsEnabled: false,
        expectedRevision: before.revision,
        catalogChainIds: ['8453', '534352'],
        actorId: admin.id
      },
      START
    );

    expect(result).toMatchObject({ kind: 'ok' });
    expect((await store.networkVisibility()).disabledChainIds).toEqual(['8453']);
  });

  it('keeps out of the cache a read that was in flight during a revocation', async () => {
    const { inner, store, session, reads } = await setup();
    let release: (value: Session) => void = () => undefined;
    reads.session.mockImplementationOnce(
      () =>
        new Promise<Session>((resolve) => {
          release = resolve;
        })
    );

    const inFlight = store.findSession('session-1');
    await store.revokeSession('session-1', START);
    release(session);

    expect((await inFlight)?.revokedAt).toBeNull();
    expect((await store.findSession('session-1'))?.revokedAt).toEqual(START);
    expect((await inner.findSession('session-1'))?.revokedAt).toEqual(START);
  });

  it('passes every other call to the wrapped store', async () => {
    const { store } = await setup();

    expect(await store.ping()).toBe(true);
    expect((await store.findActiveUserByEmail('admin@example.com'))?.role).toBe('admin');
  });
});
