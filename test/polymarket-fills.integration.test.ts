import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PolymarketFill } from '../src/ingest/types.js';
import { aggregatePolymarket } from '../src/metrics/live.js';
import { INGEST_COLLECTIONS, MongoIngestRepository } from '../src/store/ingest-store.js';

/**
 * MongoDB server of the integration suites. Only a server on this machine is accepted: the suite
 * creates a throwaway database with a unique name and drops it.
 */
const MONGO_TEST_URI = process.env.MONGO_TEST_URI ?? '';
const LOCAL_HOST = /^mongodb:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

const BUILT_AT = new Date('2026-10-24T03:00:00.000Z');
const FROM = new Date('2026-10-01T00:00:00.000Z');
const THROUGH = new Date('2026-10-24T02:00:00.000Z');

function fill(id: string, hour: number, collateralMicro: number): PolymarketFill {
  return { id, hour, side: 'buy', collateralMicro, feeMicro: 0, attributed: false };
}

describe.skipIf(MONGO_TEST_URI === '')('Polymarket fills on MongoDB', () => {
  const dbName = `analytics-it-${randomUUID()}`;
  let client: MongoClient;
  let repository: MongoIngestRepository;

  beforeAll(async () => {
    if (!LOCAL_HOST.test(MONGO_TEST_URI)) {
      throw new Error('MONGO_TEST_URI must point to a MongoDB server on this machine');
    }
    client = new MongoClient(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    repository = await MongoIngestRepository.connect({ uri: MONGO_TEST_URI, dbName });
  });

  afterAll(async () => {
    await repository?.close();
    if (client !== undefined) {
      await client.db(dbName).dropDatabase();
      await client.close();
    }
  });

  it('keys the fills by transaction and log, so a repeated read replaces them', async () => {
    await repository.upsertPolymarketFills([
      fill('0xa:1', 10, 1_000_000),
      fill('0xb:2', 11, 2_000_000)
    ]);
    await repository.upsertPolymarketFills([fill('0xa:1', 10, 1_000_000)]);
    await repository.upsertPolymarketFills([]);

    const stored = await repository.polymarketFills();
    expect(stored.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      fill('0xa:1', 10, 1_000_000),
      fill('0xb:2', 11, 2_000_000)
    ]);
    const raw = await client.db(dbName).collection(INGEST_COLLECTIONS.polymarketFills).findOne({});
    expect(Object.keys(raw ?? {}).sort()).toEqual([
      '_id',
      'attributed',
      'collateralMicro',
      'feeMicro',
      'hour',
      'side'
    ]);
  });

  it('keeps the read checkpoints and the coverage of the build', async () => {
    await repository.saveCheckpoints({
      polymarketNextBlock: 123_456,
      polymarketFrom: FROM,
      polymarketThrough: THROUGH
    });
    expect(await repository.readCheckpoints()).toMatchObject({
      polymarketNextBlock: 123_456,
      polymarketFrom: FROM,
      polymarketThrough: THROUGH
    });

    const polymarket = aggregatePolymarket(await repository.polymarketFills(), {
      from: FROM,
      through: THROUGH,
      caughtUp: true
    });
    await repository.saveAggregates(
      { hourly: [], activity: [], signups: [], wallets: [], polymarket },
      BUILT_AT,
      {
        status: 'completed',
        finishedAt: BUILT_AT.toISOString(),
        sources: {
          transactions: 'complete',
          prices: 'disabled',
          balances: 'disabled',
          polymarket: 'complete'
        },
        valuation: 'market'
      }
    );

    const loaded = await repository.loadAggregates();
    expect(loaded?.polymarket).toEqual({
      hours: [
        { hour: 10, fills: 1, buyMicro: 1_000_000, sellMicro: 0, feeMicro: 0, attributed: 0 },
        { hour: 11, fills: 1, buyMicro: 2_000_000, sellMicro: 0, feeMicro: 0, attributed: 0 }
      ],
      coverage: { from: FROM, through: THROUGH, caughtUp: true }
    });
    expect(loaded?.run?.sources.polymarket).toBe('complete');
  });
});
