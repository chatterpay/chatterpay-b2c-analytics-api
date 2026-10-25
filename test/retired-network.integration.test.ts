import { randomUUID } from 'node:crypto';
import { type Db, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import { MongoB2cActivityReader } from '../src/store/b2c-activity.js';
import { MongoIngestRepository } from '../src/store/ingest-store.js';
import { createRequiredIndexes } from '../src/store/mongo-schema.js';
import { MongoStore } from '../src/store/mongo-store.js';
import { RecordingBalanceReader } from './ingest-fakes.js';

/**
 * MongoDB server of the integration suites, as in the route suites. Only a server on this machine
 * is accepted: the suite creates two throwaway databases with unique names and drops them, and it
 * must never reach a shared server.
 */
const MONGO_TEST_URI = process.env.MONGO_TEST_URI ?? '';
const LOCAL_HOST = /^mongodb:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

const BASE_RPC = 'https://rpc.base-sepolia.test/key-in-path';
const SCROLL_RPC = 'https://rpc.scroll.test/key-in-path';
const BASE_USDC = '0x1111111111111111111111111111111111111111';
const SCROLL_USDC = '0x5555555555555555555555555555555555555555';
const RUNS = [
  new Date('2026-10-20T03:00:00.000Z'),
  new Date('2026-10-21T03:00:00.000Z'),
  new Date('2026-10-22T03:00:00.000Z')
];

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 10,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

/** Synthetic B2C documents: Base enabled, Scroll disabled for new operations, both with an RPC. */
async function seedB2c(db: Db): Promise<void> {
  await db.collection('blockchains').insertMany([
    {
      name: 'Base Sepolia',
      chainId: 84532,
      enabled: true,
      rpc: BASE_RPC,
      explorer: 'https://sepolia.basescan.org'
    },
    {
      name: 'Scroll',
      chainId: 534352,
      enabled: false,
      rpc: SCROLL_RPC,
      explorer: 'https://scrollscan.com'
    }
  ]);
  await db.collection('tokens').insertMany([
    { chain_id: 84532, symbol: 'USDC', type: 'stable', address: BASE_USDC, decimals: 6 },
    { chain_id: 534352, symbol: 'USDC', type: 'stable', address: SCROLL_USDC, decimals: 6 }
  ]);
  await db.collection('users').insertMany([
    {
      creationDate: new Date('2026-10-10T10:00:00.000Z'),
      phone_number: '5491122334455',
      wallets: [
        { chain_id: 84532, wallet_proxy: '0xBoth' },
        { chain_id: 534352, wallet_proxy: '0xBothScroll' }
      ]
    },
    {
      creationDate: new Date('2026-10-11T10:00:00.000Z'),
      phone_number: '525512345678',
      wallets: [{ chain_id: 534352, wallet_proxy: '0xScrollOnly' }]
    }
  ]);
  const row = (from: string, chainId: number, amount: number) => ({
    _id: new ObjectId(),
    trx_hash: `0x${randomUUID().replace(/-/g, '')}`,
    wallet_from: from,
    wallet_to: '0xOther',
    type: 'transfer',
    status: 'completed',
    date: new Date('2026-10-15T10:00:00.000Z'),
    amount,
    fee: amount / 100,
    token: 'USDC',
    chain_id: chainId
  });
  await db
    .collection('transactions')
    .insertMany([
      row('0xBoth', 84532, 10),
      row('0xBothScroll', 534352, 300),
      row('0xScrollOnly', 534352, 400)
    ]);
}

describe.skipIf(MONGO_TEST_URI === '')('retired network ingestion on MongoDB', () => {
  const suffix = randomUUID();
  const b2cName = `b2c-it-${suffix}`;
  const analyticsName = `analytics-it-${suffix}`;
  let client: MongoClient;
  let repository: MongoIngestRepository;
  let reader: MongoB2cActivityReader;

  beforeAll(async () => {
    if (!LOCAL_HOST.test(MONGO_TEST_URI)) {
      throw new Error('MONGO_TEST_URI must point to a MongoDB server on this machine');
    }
    client = new MongoClient(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    await seedB2c(client.db(b2cName));
    reader = new MongoB2cActivityReader(client.db(b2cName));
    repository = await MongoIngestRepository.connect({
      uri: MONGO_TEST_URI,
      dbName: analyticsName
    });
  });

  afterAll(async () => {
    await repository?.close();
    if (client !== undefined) {
      await client.db(b2cName).dropDatabase();
      await client.db(analyticsName).dropDatabase();
      await client.close();
    }
  });

  async function run(at: Date) {
    const balances = new RecordingBalanceReader();
    const report = await runIngestion({
      reader,
      repository,
      prices: null,
      balances,
      masterWallets: [],
      clock: () => at,
      options: OPTIONS,
      owner: `it-${at.toISOString()}`
    });
    return { report, urls: balances.urls() };
  }

  it('skips, reads again and retains Scroll while its history stays', async () => {
    const b2c = client.db(b2cName);

    // Disabled in B2C: activity and countries copied, no request to the Scroll RPC.
    const disabled = await run(RUNS[0] as Date);
    expect(disabled.urls).toEqual([BASE_RPC]);
    expect(disabled.report.sources.transactions.read).toBe(3);
    expect(disabled.report.sources.users.countedInCountries).toBe(2);
    expect(
      disabled.report.sources.balances.networks.find((row) => row.network === 'scroll')
    ).toMatchObject({ status: 'unsupported', calls: 0, b2cEnabled: false, reason: 'b2c_disabled' });

    // Enabled again: the next run reads it.
    await b2c.collection('blockchains').updateOne({ chainId: 534352 }, { $set: { enabled: true } });
    const enabled = await run(RUNS[1] as Date);
    expect(enabled.urls).toEqual([BASE_RPC, SCROLL_RPC]);

    // Dropped from B2C: the copy is retained for its rows and gets a row without any request.
    await b2c.collection('blockchains').deleteOne({ chainId: 534352 });
    const dropped = await run(RUNS[2] as Date);
    expect(dropped.urls).toEqual([BASE_RPC]);
    expect(dropped.report.sources.catalog.retainedNetworks).toBe(1);
    expect(
      dropped.report.sources.balances.networks.find((row) => row.network === 'scroll')
    ).toMatchObject({ status: 'unsupported', calls: 0, b2cEnabled: null, reason: 'source_absent' });

    const stored = await repository.loadAggregates();
    const scrollRows = (stored?.snapshots ?? []).map((snapshot) => [
      snapshot.takenAt.toISOString(),
      snapshot.balances?.networks.find((row) => row.network === 'scroll')?.reason
    ]);
    expect(scrollRows).toEqual([
      [RUNS[0]?.toISOString(), 'b2c_disabled'],
      [RUNS[1]?.toISOString(), null],
      [RUNS[2]?.toISOString(), 'source_absent']
    ]);
    expect(
      (await repository.transactions()).filter((row) => row.chainId === '534352')
    ).toHaveLength(2);
  });

  it('lets one of two concurrent admins change the visibility on MongoDB', async () => {
    await createRequiredIndexes(client.db(analyticsName));
    const store = await MongoStore.connect({ uri: MONGO_TEST_URI, dbName: analyticsName });
    try {
      const catalogChainIds = ['84532', '534352'];
      const results = await Promise.all(
        catalogChainIds.map((chainId, index) =>
          store.changeNetworkVisibility(
            {
              chainId,
              analyticsEnabled: false,
              expectedRevision: 0,
              catalogChainIds,
              actorId: `admin-${index}`
            },
            RUNS[0] as Date
          )
        )
      );

      expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'ok']);
      const visibility = await store.networkVisibility();
      expect(visibility).toMatchObject({ revision: 1 });
      expect(visibility.disabledChainIds).toHaveLength(1);
      const last = await store.changeNetworkVisibility(
        {
          chainId: catalogChainIds.find((id) => !visibility.disabledChainIds.includes(id)) ?? '',
          analyticsEnabled: false,
          expectedRevision: 1,
          catalogChainIds,
          actorId: 'admin-0'
        },
        RUNS[0] as Date
      );
      expect(last.kind).toBe('last_enabled');
    } finally {
      await store.close();
    }
  });
});
