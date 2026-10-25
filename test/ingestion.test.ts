import { describe, expect, it } from 'vitest';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import type { MasterWalletConfig } from '../src/ingest/snapshot.js';
import { buildOverview } from '../src/metrics/overview.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { setLiveSource, sourceFor } from '../src/metrics/sources.js';
import { buildUsers } from '../src/metrics/users.js';
import {
  FakeBalanceReader,
  FakePriceProvider,
  FakeReader,
  hexId,
  MemoryIngestRepository,
  TOKEN_ADDRESSES,
  transaction
} from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const OPTIONS: IngestionOptions = {
  batchSize: 2,
  maxTransactionsPerRun: 1000,
  revisitHours: 72,
  maxProviderCallsPerRun: 1,
  maxBalanceCallsPerRun: 0,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => transaction(index + 1));
}

function run(
  reader: FakeReader,
  repository: MemoryIngestRepository,
  overrides: Partial<IngestionOptions> = {},
  prices: FakePriceProvider | null = null,
  clock: () => Date = () => NOW
) {
  return runIngestion({
    reader,
    repository,
    prices,
    balances: null,
    masterWallets: [],
    clock,
    options: { ...OPTIONS, ...overrides },
    owner: 'test-run'
  });
}

describe('runIngestion', () => {
  it('copies new rows in batches and saves the checkpoint', async () => {
    const reader = new FakeReader(rows(5));
    const repository = new MemoryIngestRepository();

    const report = await run(reader, repository);

    expect(report.status).toBe('completed');
    expect(report.sources.transactions).toEqual({ read: 5, revisited: 0, lastId: hexId(5) });
    expect(repository.copies.size).toBe(5);
    expect(repository.checkpoints.transactionsLastId).toBe(hexId(5));
    expect(repository.lock).toBeNull();
    expect(report.aggregates?.transfers).toBe(5);
    expect(repository.stored?.builtAt).toEqual(NOW);
  });

  it('stops at the row budget and resumes from the checkpoint', async () => {
    const reader = new FakeReader(rows(5));
    const repository = new MemoryIngestRepository();

    const first = await run(reader, repository, { maxTransactionsPerRun: 3 });
    const second = await run(reader, repository, { maxTransactionsPerRun: 3 });

    expect(first.status).toBe('partial');
    expect(first.sources.transactions.read).toBe(3);
    expect(second.sources.transactions.read).toBe(2);
    expect(repository.copies.size).toBe(5);
  });

  it('stops starting batches at the deadline', async () => {
    const reader = new FakeReader(rows(5));
    const repository = new MemoryIngestRepository();
    let tick = 0;
    const clock = () => new Date(NOW.getTime() + 40_000 * tick++);

    const report = await run(reader, repository, {}, null, clock);

    expect(report.status).toBe('partial');
    expect(report.sources.transactions.read).toBeLessThan(5);
    expect(repository.checkpoints.transactionsLastId).toBe(report.sources.transactions.lastId);
  });

  it('does not duplicate rows when the same day runs again', async () => {
    const reader = new FakeReader(rows(4));
    const repository = new MemoryIngestRepository();

    await run(reader, repository);
    const again = await run(reader, repository);

    expect(again.sources.transactions.read).toBe(0);
    expect(repository.copies.size).toBe(4);
    expect(again.aggregates?.transfers).toBe(4);
  });

  it('picks up status changes of recent rows', async () => {
    const pending = transaction(1, {
      type: 'transfer',
      status: 'in_progress',
      date: new Date('2026-10-23T20:00:00.000Z')
    });
    const reader = new FakeReader([pending]);
    const repository = new MemoryIngestRepository();
    await run(reader, repository);
    reader.rows = [{ ...pending, status: 'completed' }];

    const report = await run(reader, repository);

    expect(report.sources.transactions.revisited).toBe(1);
    expect(repository.copies.get(hexId(1))?.status).toBe('completed');
    expect(report.aggregates?.transfers).toBe(1);
  });

  it('does nothing while another run holds the lock', async () => {
    const reader = new FakeReader(rows(2));
    const repository = new MemoryIngestRepository();
    await repository.acquireLock('other', NOW, 60_000);

    const report = await run(reader, repository);

    expect(report.status).toBe('locked');
    expect(reader.transactionReads).toBe(0);
    expect(repository.lock?.owner).toBe('other');
  });

  it('asks the price provider once per day for the non-stable tokens', async () => {
    const reader = new FakeReader(rows(1));
    const repository = new MemoryIngestRepository();
    const provider = new FakePriceProvider({ WETH: 2500, WBTC: 100_000, ADA: 0.5 });

    const first = await run(reader, repository, {}, provider);
    const second = await run(reader, repository, {}, provider);

    expect(provider.calls).toBe(1);
    expect(first.sources.prices).toEqual({ provider: 'fake', calls: 1, prices: 3, failed: false });
    expect(second.sources.prices.calls).toBe(0);
    expect(repository.priceCopies.get('WETH|2026-10-24|provider')?.usd).toBe(2500);
  });

  it('records a provider failure and does not retry it the same day', async () => {
    const reader = new FakeReader(rows(1));
    const repository = new MemoryIngestRepository();
    const provider = new FakePriceProvider({}, true);

    const first = await run(reader, repository, {}, provider);
    await run(reader, repository, {}, provider);

    expect(first.status).toBe('completed');
    expect(first.sources.prices.failed).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('copies users and the catalog', async () => {
    const reader = new FakeReader(rows(1), [
      { id: 'u1', createdAt: NOW, wallets: [{ chainId: '84532', address: '0xUser1' }] }
    ]);
    const repository = new MemoryIngestRepository();

    const report = await run(reader, repository);

    expect(report.sources.users.read).toBe(1);
    expect(report.sources.catalog).toEqual({
      tokens: 6,
      networks: 2,
      retainedTokens: 0,
      retainedNetworks: 0
    });
    expect(repository.chainCopies[0]?.contracts).toEqual({ paymasterAddress: '0xPaymaster' });
  });
});

describe('runIngestion snapshots', () => {
  const SIGNER = '0x9999999999999999999999999999999999999999';
  const MASTERS: MasterWalletConfig[] = [
    { network: 'base-sepolia', address: SIGNER, role: 'Backend signer' }
  ];
  const USERS = [
    {
      id: 'u1',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      wallets: [{ chainId: '84532', address: '0xUser1' }],
      country: 'AR'
    },
    {
      id: 'u2',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      wallets: [
        { chainId: '84532', address: '0xUser2' },
        { chainId: '900000000001', address: 'addr_test1u2' }
      ],
      country: 'MX'
    },
    // A wallet outside the catalog: observed, not counted in countries.
    { id: 'u3', createdAt: null, wallets: [{ chainId: '137', address: '0xUser3' }] }
  ];
  const BALANCES = new FakeBalanceReader({
    [`0xuser1|${TOKEN_ADDRESSES.USDC}`]: 4_000_000n,
    [`0xuser2|${TOKEN_ADDRESSES.WETH}`]: 2_000_000_000_000_000n,
    [`${SIGNER}|native`]: 1_000_000_000_000_000_000n
  });

  function runWith(
    reader: FakeReader,
    repository: MemoryIngestRepository,
    overrides: {
      balances?: FakeBalanceReader | null;
      prices?: FakePriceProvider | null;
      clock?: () => Date;
    } = {}
  ) {
    return runIngestion({
      reader,
      repository,
      prices: overrides.prices ?? null,
      balances: overrides.balances === undefined ? BALANCES : overrides.balances,
      masterWallets: MASTERS,
      clock: overrides.clock ?? (() => NOW),
      options: { ...OPTIONS, maxBalanceCallsPerRun: 10 },
      owner: 'test-run'
    });
  }

  it('counts users per country without storing the country', async () => {
    const reader = new FakeReader(rows(1), USERS);
    const repository = new MemoryIngestRepository();

    const report = await runWith(reader, repository);

    expect(report.sources.users.countedInCountries).toBe(2);
    expect(repository.userCopies.every((user) => !('country' in user))).toBe(true);
    const snapshot = repository.snapshotCopies.get(NOW.getTime());
    expect(snapshot?.countries).toEqual(
      expect.arrayContaining([
        { network: null, country: 'AR', users: 1 },
        { network: null, country: 'MX', users: 1 },
        { network: 'base-sepolia', country: 'MX', users: 1 },
        { network: 'cardano-preprod', country: 'MX', users: 1 }
      ])
    );
    expect(snapshot?.countries).toHaveLength(5);
  });

  it('observes wallets once and bounds the first appearance after the first run', async () => {
    const reader = new FakeReader(rows(1), USERS.slice(0, 1));
    const repository = new MemoryIngestRepository();

    const first = await runWith(reader, repository);
    reader.userList = USERS;
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await runWith(reader, repository, { clock: () => later });

    expect(first.sources.users.newWallets).toBe(1);
    expect(second.sources.users.newWallets).toBe(3);
    expect(repository.checkpoints.walletsTrackingSince).toEqual(NOW);
    expect(repository.observations.get('84532|0xuser1')).toEqual({
      chainId: '84532',
      address: '0xuser1',
      firstObservedAt: NOW,
      bounded: false
    });
    expect(repository.observations.get('900000000001|addr_test1u2')).toMatchObject({
      firstObservedAt: later,
      bounded: true
    });
  });

  it('saves a balance snapshot per run and its status', async () => {
    const reader = new FakeReader(rows(1), USERS);
    const repository = new MemoryIngestRepository();
    const prices = new FakePriceProvider({ WETH: 2500, ETH: 3000, ADA: 0.5, WBTC: 60_000 });

    const report = await runWith(reader, repository, { prices });

    expect(prices.lastSymbols).toEqual(['WETH', 'WBTC', 'ADA', 'ETH']);
    expect(report.sources.balances).toMatchObject({
      status: 'complete',
      failedCalls: 0,
      masterWallets: 1
    });
    expect(report.sources.balances.calls).toBeGreaterThan(0);
    const balances = repository.snapshotCopies.get(NOW.getTime())?.balances;
    expect(balances?.holdings).toEqual([
      { network: 'base-sepolia', asset: 'USDC', amount: '4.0', valueCents: 400 },
      { network: 'base-sepolia', asset: 'WETH', amount: '0.002', valueCents: 500 }
    ]);
    expect(balances?.masterWallets[0]?.balances).toEqual([
      { asset: 'ETH', amount: '1.0', valueCents: 300_000 }
    ]);
    expect(repository.stored?.run).toEqual({
      status: 'completed',
      finishedAt: NOW.toISOString(),
      sources: { transactions: 'complete', prices: 'complete', balances: 'complete' }
    });
  });

  it('keeps the country counts and marks balances disabled without a reader', async () => {
    const reader = new FakeReader(rows(1), USERS);
    const repository = new MemoryIngestRepository();

    const report = await runWith(reader, repository, { balances: null });

    expect(report.sources.balances).toEqual({
      status: 'disabled',
      calls: 0,
      failedCalls: 0,
      networks: [],
      masterWallets: 0
    });
    const snapshot = repository.snapshotCopies.get(NOW.getTime());
    expect(snapshot?.balances).toBeNull();
    expect(snapshot?.countries.length).toBeGreaterThan(0);
    expect(repository.stored?.run?.sources).toEqual({
      transactions: 'complete',
      prices: 'disabled',
      balances: 'disabled'
    });
  });

  it('serves the snapshot blocks once the build is loaded', async () => {
    const reader = new FakeReader(rows(1), USERS);
    const repository = new MemoryIngestRepository();
    const prices = new FakePriceProvider({ WETH: 2500, ETH: 3000 });
    await runWith(reader, repository, { prices });
    try {
      await refreshLiveMetrics(repository, null);
      const overview = buildOverview('all', 'month', NOW);
      const revenue = buildRevenue('all', 'month', NOW);
      const users = buildUsers('all', 'monthly', NOW);

      expect(overview.meta.ingest?.sources.balances).toBe('complete');
      expect(overview.tvl).toMatchObject({
        source: 'live',
        asOf: NOW.toISOString(),
        firstSnapshotAt: NOW.toISOString()
      });
      expect(overview.tvl.value?.value).toBe('9.00');
      expect(overview.topTokens.items.map((item) => [item.asset, item.valueUsd])).toEqual([
        ['WETH', '5.00'],
        ['USDC', '4.00']
      ]);
      expect(overview.topCountries.items.map((item) => [item.country, item.users])).toEqual([
        ['AR', 1],
        ['MX', 1]
      ]);
      expect(revenue.masterWallets.items[0]).toMatchObject({
        address: SIGNER,
        role: 'Backend signer',
        valueUsd: '3000.00'
      });
      expect(revenue.polymarketVolume).toMatchObject({
        availability: 'unavailable',
        reason: 'not_recorded'
      });
      expect(users.newWallets).toMatchObject({
        source: 'live',
        definition: 'first_verifiable_appearance',
        trackingSince: NOW.toISOString()
      });
    } finally {
      setLiveSource(null);
    }
  });

  it('answers unavailable for the snapshot blocks of a build without balances', async () => {
    const repository = new MemoryIngestRepository();
    await runWith(new FakeReader(rows(1), USERS), repository, { balances: null });
    try {
      await refreshLiveMetrics(repository, null);
      const overview = buildOverview('all', 'month', NOW);

      expect(overview.tvl).toMatchObject({
        source: 'live',
        availability: 'unavailable',
        reason: 'snapshots_disabled',
        value: null
      });
      expect(overview.topTokens).toMatchObject({ availability: 'unavailable', totalUsd: null });
      expect(overview.topCountries.availability).toBe('available');
    } finally {
      setLiveSource(null);
    }
  });
});

describe('refreshLiveMetrics', () => {
  it('loads a newer build and keeps the loaded one otherwise', async () => {
    const repository = new MemoryIngestRepository();
    try {
      expect(await refreshLiveMetrics(repository, null)).toBeNull();
      expect(sourceFor('activity').kind).toBe('mock');

      await run(new FakeReader(rows(1)), repository);
      const loaded = await refreshLiveMetrics(repository, null);

      expect(loaded).toEqual(NOW);
      expect(sourceFor('activity').kind).toBe('live');
      expect(await refreshLiveMetrics(repository, loaded)).toBe(loaded);
    } finally {
      setLiveSource(null);
    }
  });
});
