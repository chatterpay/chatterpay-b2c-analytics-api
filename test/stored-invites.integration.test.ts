import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequiredIndexes } from '../src/store/mongo-schema.js';
import { MongoStore } from '../src/store/mongo-store.js';

/** Only a MongoDB server on this machine is accepted, as in the other integration suites. */
const MONGO_TEST_URI = process.env.MONGO_TEST_URI ?? '';
const LOCAL_HOST = /^mongodb:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

const NOW = new Date('2026-10-27T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(MONGO_TEST_URI === '')('invites, challenges and members stored before', () => {
  const dbName = `analytics-it-${randomUUID()}`;
  let client: MongoClient;
  let store: MongoStore;

  beforeAll(async () => {
    if (!LOCAL_HOST.test(MONGO_TEST_URI)) {
      throw new Error('MONGO_TEST_URI must point to a MongoDB server on this machine');
    }
    client = new MongoClient(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    await createRequiredIndexes(client.db(dbName));
    store = await MongoStore.connect({ uri: MONGO_TEST_URI, dbName });
  });

  afterAll(async () => {
    await store?.close();
    if (client !== undefined) {
      await client.db(dbName).dropDatabase();
      await client.close();
    }
  });

  it('reads an invite without locale or delivery as an English simulated send', async () => {
    const lastSentAt = new Date(NOW.getTime() - DAY_MS);
    await client
      .db(dbName)
      .collection('invites')
      .insertOne({
        _id: 'legacy-invite' as never,
        email: 'legacy@example.com',
        role: 'viewer',
        status: 'simulated',
        createdAt: lastSentAt,
        expiresAt: new Date(NOW.getTime() + DAY_MS),
        createdBy: 'admin-id',
        resendCount: 0,
        lastSentAt,
        mutationId: randomUUID()
      });

    const [invite] = await store.listInvites('pending', 10, NOW);

    expect(invite).toMatchObject({
      id: 'legacy-invite',
      status: 'simulated',
      locale: 'en',
      delivery: { state: 'simulated', attempts: 0, lastAttemptAt: lastSentAt, failure: null }
    });
    expect(await store.hasPendingInvite('legacy@example.com', NOW)).toBe(true);

    // The pending index still holds one invite per email, and a resend records its delivery.
    const conflict = await store.createInvite(
      {
        email: 'legacy@example.com',
        role: 'viewer',
        createdBy: 'admin-id',
        mutationId: randomUUID(),
        expiresAt: new Date(NOW.getTime() + DAY_MS),
        locale: 'es'
      },
      NOW
    );
    expect(conflict.kind).toBe('conflict');
    const resent = await store.resendInvite('legacy-invite', NOW);
    expect(resent).toMatchObject({ kind: 'ok', invite: { delivery: { state: 'pending' } } });
    const recorded = await store.recordInviteDelivery(
      'legacy-invite',
      { state: 'sent', attempts: 1, lastAttemptAt: NOW, messageId: 'msg-1', failure: null },
      NOW
    );
    expect(recorded?.delivery).toMatchObject({ state: 'sent', messageId: 'msg-1' });
  });

  it('never matches a challenge stored with a random id and the email in clear', async () => {
    await client
      .db(dbName)
      .collection('login_challenges')
      .insertOne({
        _id: 'legacy-challenge' as never,
        email: 'legacy@example.com',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
        attempts: 0,
        consumedAt: null
      });

    expect(
      await store.recordChallengeAttempt('legacy-challenge', 'legacy-challenge', NOW)
    ).toBeNull();
    expect(await store.consumeChallenge('legacy-challenge', 'legacy-challenge', NOW)).toBe(false);
  });

  it('reads a member without blockedAt as not blocked, and blocks it', async () => {
    await client
      .db(dbName)
      .collection('users')
      .insertMany([
        {
          _id: 'legacy-admin' as never,
          email: 'legacy-admin@example.com',
          role: 'admin',
          status: 'active',
          createdAt: NOW,
          lastLoginAt: null
        },
        {
          _id: 'legacy-viewer' as never,
          email: 'legacy-viewer@example.com',
          role: 'viewer',
          status: 'active',
          createdAt: NOW,
          lastLoginAt: null
        }
      ]);

    expect((await store.findUserById('legacy-viewer'))?.blockedAt).toBeNull();
    const blocked = await store.setBlocked('legacy-viewer', true, NOW);
    expect(blocked).toMatchObject({ kind: 'ok', user: { blockedAt: NOW } });
    expect(await store.recordLogin('legacy-viewer', NOW)).toBeNull();
    expect(await store.setBlocked('legacy-viewer', false, NOW)).toMatchObject({
      kind: 'ok',
      user: { blockedAt: null }
    });
  });

  it('lets one of two concurrent throttle reservations and consumptions win', async () => {
    const next = { issued: 1, lastIssuedAt: NOW, forgetAt: new Date(NOW.getTime() + DAY_MS) };
    const reservations = await Promise.all([
      store.reserveLoginThrottle('login:email:race', null, next),
      store.reserveLoginThrottle('login:email:race', null, next)
    ]);
    expect(reservations.filter((reservation) => reservation !== null)).toHaveLength(1);

    await store.issueChallenge({
      id: 'challenge-race',
      emailKey: 'race-key',
      userId: null,
      kind: 'otp',
      codeDigest: 'ab'.repeat(32),
      keyVersion: 'test',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: null,
      revokedAt: null,
      attempts: 0,
      maxAttempts: 5
    });
    const consumed = await Promise.all([
      store.consumeChallenge('race-key', 'challenge-race', NOW),
      store.consumeChallenge('race-key', 'challenge-race', NOW)
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
  });
});
