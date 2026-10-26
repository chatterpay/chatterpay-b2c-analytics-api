import { randomUUID } from 'node:crypto';
import { type Db, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import { MongoB2cActivityReader } from '../src/store/b2c-activity.js';
import { MongoIngestRepository } from '../src/store/ingest-store.js';
import { createRequiredIndexes } from '../src/store/mongo-schema.js';
import { MongoStore } from '../src/store/mongo-store.js';

/** Only a MongoDB server on this machine is accepted, as in the other integration suites. */
const MONGO_TEST_URI = process.env.MONGO_TEST_URI ?? '';
const LOCAL_HOST = /^mongodb:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

const BASE_USDT = '0x2222222222222222222222222222222222222222';
const SCROLL_USDT = '0x6666666666666666666666666666666666666666';
const BASE_USDT_ID = `84532:${BASE_USDT}`;
const SCROLL_USDT_ID = `534352:${SCROLL_USDT}`;
const POLYGON_ADDRESS = '0x9999999999999999999999999999999999999999';
const CREDENTIALS = 'encrypted-credentials-of-the-test';
const RUN_AT = new Date('2026-10-24T03:00:00.000Z');

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 0,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

/** Synthetic B2C documents: USDT on Base Sepolia and on Scroll, one user with Polymarket. */
async function seedB2c(db: Db): Promise<void> {
  await db.collection('blockchains').insertMany([
    { name: 'Base Sepolia', chainId: 84532, enabled: true },
    { name: 'Scroll', chainId: 534352, enabled: false }
  ]);
  await db.collection('tokens').insertMany([
    { chain_id: 84532, symbol: 'USDT', type: 'stable', address: BASE_USDT, decimals: 6 },
    { chain_id: 534352, symbol: 'USDT', type: 'stable', address: SCROLL_USDT, decimals: 6 }
  ]);
  await db.collection('users').insertMany([
    {
      creationDate: new Date('2026-10-10T10:00:00.000Z'),
      phone_number: '5491122334455',
      wallets: [{ chain_id: 84532, wallet_proxy: '0xBase' }],
      polymarket_account: {
        polygon_address: POLYGON_ADDRESS,
        created_at: new Date('2026-10-20T10:00:00.000Z'),
        api_credentials_encrypted: CREDENTIALS
      }
    }
  ]);
  await db.collection('transactions').insertOne({
    _id: new ObjectId(),
    trx_hash: '0xhash-token-policy',
    wallet_from: '0xBase',
    wallet_to: '0xOther',
    type: 'transfer',
    status: 'completed',
    date: new Date('2026-10-15T10:00:00.000Z'),
    amount: 20,
    fee: 0.2,
    token: 'USDT',
    chain_id: 84532
  });
}

describe.skipIf(MONGO_TEST_URI === '')('token policy and Polymarket accounts on MongoDB', () => {
  const suffix = randomUUID();
  const b2cName = `b2c-it-${suffix}`;
  const analyticsName = `analytics-it-${suffix}`;
  let client: MongoClient;
  let repository: MongoIngestRepository;
  let store: MongoStore;

  beforeAll(async () => {
    if (!LOCAL_HOST.test(MONGO_TEST_URI)) {
      throw new Error('MONGO_TEST_URI must point to a MongoDB server on this machine');
    }
    client = new MongoClient(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    await seedB2c(client.db(b2cName));
    await createRequiredIndexes(client.db(analyticsName));
    repository = await MongoIngestRepository.connect({
      uri: MONGO_TEST_URI,
      dbName: analyticsName
    });
    store = await MongoStore.connect({ uri: MONGO_TEST_URI, dbName: analyticsName });
  });

  afterAll(async () => {
    await store?.close();
    await repository?.close();
    if (client !== undefined) {
      await client.db(b2cName).dropDatabase();
      await client.db(analyticsName).dropDatabase();
      await client.close();
    }
  });

  function run(at: Date) {
    return runIngestion({
      reader: new MongoB2cActivityReader(client.db(b2cName)),
      repository,
      prices: null,
      balances: null,
      masterWallets: [],
      clock: () => at,
      options: OPTIONS,
      owner: `it-${randomUUID()}`
    });
  }

  it('counts the Polymarket account without copying its address or credentials', async () => {
    const report = await run(RUN_AT);

    expect(report.sources.users.polymarketAccounts).toBe(1);
    const analytics = client.db(analyticsName);
    for (const { name } of await analytics.listCollections().toArray()) {
      const documents = JSON.stringify(await analytics.collection(name).find({}).toArray());
      expect(documents).not.toContain(CREDENTIALS);
      expect(documents.toLowerCase()).not.toContain(POLYGON_ADDRESS);
    }
    const [snapshot] = await analytics.collection('ingest_snapshots').find({}).toArray();
    expect(snapshot?.polymarket).toMatchObject({ accounts: 1, invalid: 0, undated: 0 });
  });

  it('keeps token and network preferences apart, refuses stale revisions and survives a run', async () => {
    const hidden = await store.changeTokenVisibility(
      { tokenId: BASE_USDT_ID, analyticsEnabled: false, expectedRevision: 0, actorId: 'admin-0' },
      RUN_AT
    );
    expect(hidden).toMatchObject({ kind: 'ok', changed: true });

    const concurrent = await Promise.all([
      store.changeTokenVisibility(
        { tokenId: SCROLL_USDT_ID, analyticsEnabled: false, expectedRevision: 1, actorId: 'a' },
        RUN_AT
      ),
      store.changeNetworkVisibility(
        {
          chainId: '534352',
          analyticsEnabled: false,
          expectedRevision: 1,
          catalogChainIds: ['84532', '534352'],
          actorId: 'b'
        },
        RUN_AT
      )
    ]);
    expect(concurrent.map((result) => result.kind).sort()).toEqual(['conflict', 'ok']);

    const before = await store.networkVisibility();
    expect(before.revision).toBe(2);
    expect(before.disabledTokenIds).toContain(BASE_USDT_ID);

    await run(new Date(RUN_AT.getTime() + 3_600_000));

    expect(await store.networkVisibility()).toEqual(before);
    expect(await repository.networkSettings()).toEqual({
      hiddenChainIds: before.disabledChainIds,
      uncollectedChainIds: []
    });
    const tokens = await repository.tokens();
    expect(tokens.map((token) => `${token.chainId}:${token.address}`).sort()).toEqual([
      SCROLL_USDT_ID,
      BASE_USDT_ID
    ]);
  });
});
