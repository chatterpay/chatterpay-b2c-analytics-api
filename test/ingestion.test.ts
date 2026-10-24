import { describe, expect, it } from 'vitest';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import { setLiveSource, sourceFor } from '../src/metrics/sources.js';
import {
  FakePriceProvider,
  FakeReader,
  hexId,
  MemoryIngestRepository,
  transaction
} from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const OPTIONS: IngestionOptions = {
  batchSize: 2,
  maxTransactionsPerRun: 1000,
  revisitHours: 72,
  maxProviderCallsPerRun: 1,
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
    expect(report.sources.catalog).toEqual({ tokens: 6, networks: 2 });
    expect(repository.chainCopies[0]?.contracts).toEqual({ paymasterAddress: '0xPaymaster' });
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
