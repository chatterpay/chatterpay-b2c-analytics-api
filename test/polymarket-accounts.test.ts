import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/principal.js';
import { loadEnv } from '../src/config/env.js';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import type { IngestedUser, PolymarketAccountRecord } from '../src/ingest/types.js';
import { DEFAULT_NETWORKS, setNetworks } from '../src/metrics/catalog.js';
import { resetFactsCaches } from '../src/metrics/facts.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { setLiveSource } from '../src/metrics/sources.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { FakeReader, MemoryIngestRepository, transaction } from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 0,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

type User = IngestedUser & { polymarket?: PolymarketAccountRecord | null };

function user(id: string, polymarket: PolymarketAccountRecord | null | undefined): User {
  return {
    id,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    wallets: [{ chainId: '84532', address: `0x${id}` }],
    ...(polymarket === undefined ? {} : { polymarket })
  };
}

/**
 * One account created in the month range, one in the previous period, one without a creation
 * date, one with an address that is not an EVM address, one user without an account.
 */
const USERS: User[] = [
  user('a', {
    validAddress: true,
    address: '0x1111111111111111111111111111111111111111',
    createdAt: new Date('2026-10-20T12:30:00.000Z')
  }),
  user('b', {
    validAddress: true,
    address: '0x1111111111111111111111111111111111111111',
    createdAt: new Date('2026-09-10T08:00:00.000Z')
  }),
  user('c', {
    validAddress: true,
    address: '0x1111111111111111111111111111111111111111',
    createdAt: null
  }),
  user('d', {
    validAddress: false,
    address: null,
    createdAt: new Date('2026-10-21T00:00:00.000Z')
  }),
  user('e', null)
];

async function viewer(request: { headers: Record<string, unknown> }): Promise<Principal | null> {
  return request.headers['x-test-role'] === 'viewer' ? { userId: 'u-test', role: 'viewer' } : null;
}

async function ingest(users: User[]) {
  const repository = new MemoryIngestRepository();
  const report = await runIngestion({
    reader: new FakeReader([transaction(1, { from: '0xa', amount: 10, fee: 0.1 })], users),
    repository,
    prices: null,
    balances: null,
    masterWallets: [],
    clock: () => NOW,
    options: OPTIONS,
    owner: 'polymarket-test'
  });
  await refreshLiveMetrics(repository, null);
  return { repository, report };
}

afterEach(() => {
  setLiveSource(null);
  setNetworks(DEFAULT_NETWORKS);
  resetFactsCaches();
});

describe('Polymarket accounts in the ingestion', () => {
  it('counts valid, undated and invalid accounts and keeps no address', async () => {
    const { repository, report } = await ingest(USERS);

    expect(report.sources.users.polymarketAccounts).toBe(3);
    const [snapshot] = repository.snapshotCopies.values();
    expect(snapshot?.polymarket).toEqual({
      accounts: 3,
      invalid: 1,
      undated: 1,
      createdPerHour: [
        { hour: Math.floor(Date.parse('2026-09-10T08:00:00.000Z') / 3_600_000), accounts: 1 },
        { hour: Math.floor(Date.parse('2026-10-20T12:00:00.000Z') / 3_600_000), accounts: 1 }
      ]
    });
    expect(repository.userCopies.every((copy) => !('polymarket' in copy))).toBe(true);
  });

  it('counts a user with several wallets once', async () => {
    const owner: User = {
      ...user('f', {
        validAddress: true,
        address: '0x1111111111111111111111111111111111111111',
        createdAt: new Date('2026-10-20T12:30:00.000Z')
      }),
      wallets: [
        { chainId: '84532', address: '0xf1' },
        { chainId: '534351', address: '0xf2' }
      ]
    };

    const { report } = await ingest([owner]);

    expect(report.sources.users.polymarketAccounts).toBe(1);
  });
});

describe('Polymarket accounts block', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(env, {
      authenticate: viewer,
      clock: () => NOW,
      store: new MemoryStore()
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function revenue(query = '') {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/metrics/revenue${query}`,
      headers: { 'x-test-role': 'viewer' }
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('serves the accounts of the last run for every network filter, apart from volume', async () => {
    await ingest(USERS);

    const all = await revenue();
    expect(all.polymarketAccounts).toEqual({
      source: 'live',
      availability: 'partial',
      reason: 'undated_accounts',
      asOf: NOW.toISOString(),
      scope: 'all_networks',
      accounts: 3,
      invalidAccounts: 1,
      undatedAccounts: 1,
      newAccounts: { value: 1, previous: 1, changeRatio: '0.0000' }
    });
    expect((await revenue('?network=base-sepolia')).polymarketAccounts).toEqual(
      all.polymarketAccounts
    );
    expect(all.polymarketVolume).toMatchObject({
      availability: 'unavailable',
      reason: 'not_configured',
      valueUsd: null
    });
    const polymarketFees = all.feesByProduct.items.find(
      (item: { product: string }) => item.product === 'polymarket'
    );
    expect(polymarketFees).toMatchObject({ availability: 'unavailable', feesUsd: null });
    expect(all.tiles.volumeUsd.value).toBe('10.00');
    expect(JSON.stringify(all)).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('is available when every account has a creation date', async () => {
    await ingest(USERS.filter((item) => item.id !== 'c'));

    const block = buildRevenue('all', 'year', NOW).polymarketAccounts;
    expect(block).toMatchObject({
      availability: 'available',
      reason: null,
      accounts: 2,
      undatedAccounts: 0,
      newAccounts: { value: 2 }
    });
  });

  it('is unavailable for a run stored before the accounts were counted', async () => {
    const { repository } = await ingest(USERS);
    for (const [key, snapshot] of repository.snapshotCopies) {
      const { polymarket: _counts, ...rest } = snapshot;
      repository.snapshotCopies.set(key, rest);
    }
    await refreshLiveMetrics(repository, null);

    expect((await revenue()).polymarketAccounts).toEqual({
      source: 'live',
      availability: 'unavailable',
      reason: 'no_snapshot',
      asOf: null,
      scope: 'all_networks',
      accounts: null,
      invalidAccounts: 0,
      undatedAccounts: 0,
      newAccounts: null
    });
  });

  it('is unavailable with synthetic data rather than inventing accounts', async () => {
    expect((await revenue()).polymarketAccounts).toMatchObject({
      source: 'mock',
      availability: 'unavailable',
      accounts: null
    });
  });
});
