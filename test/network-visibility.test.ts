import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/principal.js';
import { loadEnv } from '../src/config/env.js';
import { rpcBalanceReader } from '../src/ingest/balance-reader.js';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import type { BalanceReader, ChainInfo, IngestedUser, TokenInfo } from '../src/ingest/types.js';
import { DEFAULT_NETWORKS, listNetworks, setNetworks } from '../src/metrics/catalog.js';
import { resetFactsCaches } from '../src/metrics/facts.js';
import { buildOverview } from '../src/metrics/overview.js';
import { setLiveSource } from '../src/metrics/sources.js';
import { mergeCatalog, toNetworkDefinitions } from '../src/store/b2c-networks.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { planVisibilityChange } from '../src/store/network-visibility.js';
import type { Store } from '../src/store/types.js';
import {
  CHAINS,
  ENDPOINTS,
  FakeReader,
  hexId,
  MemoryIngestRepository,
  TOKEN_ADDRESSES,
  TOKENS,
  transaction
} from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const SCROLL_CHAIN = '534352';
const SCROLL_USDC = '0x5555555555555555555555555555555555555555';

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 0,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

/** Scroll as the B2C database lists it once ChatterPay moved its EVM operations to Base. */
const SCROLL_DOCUMENT = { name: 'Scroll', family: 'evm', chainId: 534352, enabled: false };
const B2C_DOCUMENTS = [
  { name: 'Base Sepolia', family: 'evm', chainId: 84532, enabled: true },
  { name: 'Cardano Preprod', family: 'cardano', chainId: 900000000001, enabled: true },
  SCROLL_DOCUMENT
];

const SCROLL: ChainInfo = {
  chainId: SCROLL_CHAIN,
  network: 'scroll',
  name: 'Scroll',
  family: 'evm',
  explorer: 'https://scrollscan.com',
  contracts: {}
};
const SCROLL_TOKEN: TokenInfo = {
  chainId: SCROLL_CHAIN,
  symbol: 'USDC',
  stable: true,
  address: SCROLL_USDC,
  decimals: 6
};

/** Users: one on Base and Scroll, one on Scroll only, one on Base only. */
const USERS: Array<IngestedUser & { country: string }> = [
  {
    id: 'user-both',
    createdAt: new Date('2026-10-10T10:00:00.000Z'),
    country: 'AR',
    wallets: [
      { chainId: '84532', address: '0xBoth' },
      { chainId: SCROLL_CHAIN, address: '0xBothScroll' }
    ]
  },
  {
    id: 'user-scroll',
    createdAt: new Date('2026-10-11T10:00:00.000Z'),
    country: 'MX',
    wallets: [{ chainId: SCROLL_CHAIN, address: '0xScrollOnly' }]
  },
  {
    id: 'user-base',
    createdAt: new Date('2026-10-12T10:00:00.000Z'),
    country: 'AR',
    wallets: [{ chainId: '84532', address: '0xBaseOnly' }]
  }
];

function activity() {
  return [
    transaction(1, { from: '0xBoth', amount: 10, fee: 0.1 }),
    transaction(2, { from: '0xBaseOnly', amount: 20, fee: 0.2 }),
    transaction(3, { from: '0xBothScroll', chainId: SCROLL_CHAIN, amount: 300, fee: 3 }),
    transaction(4, { from: '0xScrollOnly', chainId: SCROLL_CHAIN, amount: 400, fee: 4 })
  ];
}

// Test-only authenticator: `x-test-role` stands in for a session and `x-test-user` for its member.
async function headerAuthenticator(request: {
  headers: Record<string, unknown>;
}): Promise<Principal | null> {
  const role = request.headers['x-test-role'];
  const user = request.headers['x-test-user'];
  if (role === 'admin' || role === 'viewer') {
    return { userId: typeof user === 'string' ? user : 'admin-0001', role };
  }
  return null;
}

async function appWith(store: Store): Promise<FastifyInstance> {
  const app = await buildApp(env, { authenticate: headerAuthenticator, clock: () => NOW, store });
  await app.ready();
  return app;
}

function ingest(reader: FakeReader, repository: MemoryIngestRepository, balances?: BalanceReader) {
  return runIngestion({
    reader,
    repository,
    prices: null,
    balances: balances ?? null,
    masterWallets: [],
    clock: () => NOW,
    options: balances === undefined ? OPTIONS : { ...OPTIONS, maxBalanceCallsPerRun: 10 },
    owner: 'visibility-test'
  });
}

async function get(app: FastifyInstance, url: string, role: 'admin' | 'viewer' = 'viewer') {
  return app.inject({ method: 'GET', url, headers: { 'x-test-role': role } });
}

async function toggle(
  app: FastifyInstance,
  chainId: string,
  analyticsEnabled: boolean,
  expectedRevision: number,
  user = 'admin-0001'
) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/admin/networks/${chainId}`,
    headers: { 'x-test-role': 'admin', 'x-test-user': user },
    payload: { analyticsEnabled, expectedRevision }
  });
}

function networksOf(body: { byNetwork: Array<{ network: string }> }): string[] {
  return body.byNetwork.map((item) => item.network);
}

afterEach(() => {
  setLiveSource(null);
  setNetworks(DEFAULT_NETWORKS);
  resetFactsCaches();
});

describe('network visibility with Scroll history', () => {
  let store: MemoryStore;
  let app: FastifyInstance;
  let reader: FakeReader;
  let repository: MemoryIngestRepository;

  beforeEach(async () => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    reader = new FakeReader(activity(), USERS, [...TOKENS, SCROLL_TOKEN], [...CHAINS, SCROLL]);
    repository = new MemoryIngestRepository();
    await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);
    store = new MemoryStore();
    app = await appWith(store);
  });

  afterEach(async () => {
    await app.close();
  });

  it('imports and shows Scroll while B2C has it disabled and no admin hid it', async () => {
    const networks = (await get(app, '/v1/metrics/networks')).json().networks;
    const overview = (await get(app, '/v1/metrics/overview')).json();
    const admin = (await get(app, '/v1/admin/networks', 'admin')).json();

    expect(repository.chainCopies.map((chain) => chain.network)).toContain('scroll');
    expect(networks).toContainEqual({ id: 'scroll', label: 'Scroll', family: 'evm' });
    expect(overview.meta.dataStatus).toBe('live');
    expect(
      overview.byNetwork.find((item: { network: string }) => item.network === 'scroll')
    ).toMatchObject({ volumeUsd: '700.00', transactions: 2, feesUsd: '7.00' });
    expect(admin.revision).toBe(0);
    expect(admin.networks.find((item: { id: string }) => item.id === 'scroll')).toMatchObject({
      id: 'scroll',
      chainId: SCROLL_CHAIN,
      label: 'Scroll',
      family: 'evm',
      analyticsEnabled: true,
      b2cEnabled: false,
      sourcePresent: true
    });
  });

  it('leaves a hidden Scroll out of every view and refuses it by id', async () => {
    const hidden = await toggle(app, SCROLL_CHAIN, false, 0);
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().revision).toBe(1);

    const networks = (await get(app, '/v1/metrics/networks')).json().networks;
    const overview = (await get(app, '/v1/metrics/overview')).json();
    const users = (await get(app, '/v1/metrics/users')).json();
    const revenue = (await get(app, '/v1/metrics/revenue')).json();

    expect(networks.map((item: { id: string }) => item.id)).toEqual([
      'base-sepolia',
      'cardano-preprod'
    ]);
    for (const body of [overview, users, revenue]) {
      expect(networksOf(body)).not.toContain('scroll');
      expect(JSON.stringify(body.series)).not.toContain('scroll');
      expect(body.meta.dataStatus).toBe('live');
    }
    expect(overview.tiles.volumeUsd.value).toBe('30.00');
    expect(overview.tiles.transactions.value).toBe(2);
    expect(overview.tiles.activeUsers.value).toBe(2);
    expect(overview.tiles.newUsers.value).toBe(2);
    expect(overview.topCountries).toMatchObject({ totalUsers: 2, availability: 'available' });
    expect(users.tiles.totalUsers.value).toBe(2);
    expect(users.tiles.monthlyActiveUsers.value).toBe(2);
    expect(JSON.stringify(users.newWallets.byNetwork)).not.toContain('scroll');
    expect(revenue.tiles.feesUsd.value).toBe('0.30');
    expect(revenue.byAsset.map((item: { network: string }) => item.network)).not.toContain(
      'scroll'
    );

    for (const view of ['overview', 'users', 'revenue']) {
      const direct = await get(app, `/v1/metrics/${view}?network=scroll`);
      const unknown = await get(app, `/v1/metrics/${view}?network=polygon`);
      expect(direct.statusCode).toBe(400);
      expect(direct.json()).toMatchObject({ code: 'BAD_REQUEST', message: 'Unknown network' });
      expect(direct.json().message).toBe(unknown.json().message);
      expect(direct.body).not.toContain('volumeUsd');
    }
  });

  it('shows Scroll again without a new ingestion', async () => {
    const before = await Promise.all(
      ['overview', 'users', 'revenue'].map(
        async (view) => (await get(app, `/v1/metrics/${view}`)).body
      )
    );
    const reads = reader.transactionReads;

    expect((await toggle(app, SCROLL_CHAIN, false, 0)).statusCode).toBe(200);
    expect((await toggle(app, SCROLL_CHAIN, true, 1)).statusCode).toBe(200);
    const after = await Promise.all(
      ['overview', 'users', 'revenue'].map(
        async (view) => (await get(app, `/v1/metrics/${view}`)).body
      )
    );

    expect(after).toEqual(before);
    expect(reader.transactionReads).toBe(reads);
    expect((await get(app, '/v1/metrics/overview?network=scroll')).statusCode).toBe(200);
  });

  it('keeps copying Scroll rows and moving the checkpoint while Scroll is hidden', async () => {
    expect((await toggle(app, SCROLL_CHAIN, false, 0)).statusCode).toBe(200);
    reader.rows.push(
      transaction(5, { from: '0xScrollOnly', chainId: SCROLL_CHAIN, amount: 50, fee: 0.5 }),
      transaction(6, { from: '0xBaseOnly', amount: 5, fee: 0.05 })
    );

    const report = await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);

    expect(report.status).toBe('completed');
    expect(report.sources.transactions).toMatchObject({ read: 2, lastId: hexId(6) });
    expect(repository.copies.size).toBe(6);
    expect(
      [...repository.copies.values()].filter((row) => row.chainId === SCROLL_CHAIN)
    ).toHaveLength(3);
    expect(repository.checkpoints.transactionsLastId).toBe(hexId(6));
    expect(report.aggregates?.outsideCatalog).toBe(0);
    expect(
      buildOverview('scroll', 'month', NOW).byNetwork.find((item) => item.network === 'scroll')
    ).toMatchObject({ transactions: 3, volumeUsd: '750.00' });
  });

  it('retains the Scroll catalog, fees and chain id after B2C drops it', async () => {
    reader.chainList = [...CHAINS];
    reader.tokenList = [...TOKENS];

    const report = await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);
    setNetworks(
      mergeCatalog(
        toNetworkDefinitions(B2C_DOCUMENTS.filter((item) => item !== SCROLL_DOCUMENT)),
        await repository.chains()
      )
    );

    expect(report.sources.catalog).toMatchObject({ retainedNetworks: 1, retainedTokens: 1 });
    expect(report.aggregates?.outsideCatalog).toBe(0);
    expect(await repository.chains()).toContainEqual(SCROLL);
    expect(await repository.tokens()).toContainEqual(SCROLL_TOKEN);
    expect(listNetworks().find((network) => network.id === 'scroll')).toEqual({
      id: 'scroll',
      label: 'Scroll',
      family: 'evm',
      chainId: SCROLL_CHAIN,
      b2cEnabled: null,
      sourcePresent: false
    });
    const revenue = (await get(app, '/v1/metrics/revenue?network=scroll')).json();
    expect(revenue.tiles.feesUsd.value).toBe('7.00');

    expect((await toggle(app, SCROLL_CHAIN, false, 0)).statusCode).toBe(200);
    expect(networksOf((await get(app, '/v1/metrics/revenue')).json())).not.toContain('scroll');
    expect((await toggle(app, SCROLL_CHAIN, true, 1)).statusCode).toBe(200);
    expect(networksOf((await get(app, '/v1/metrics/revenue')).json())).toContain('scroll');
  });

  it('drops a network the B2C database removed when no copied row used it', async () => {
    const unused: ChainInfo = { ...SCROLL, chainId: '59144', network: 'linea', name: 'Linea' };
    reader.chainList = [...CHAINS, SCROLL, unused];
    await ingest(reader, repository);
    reader.chainList = [...CHAINS, SCROLL];

    const report = await ingest(reader, repository);

    expect(report.sources.catalog.retainedNetworks).toBe(0);
    expect((await repository.chains()).map((chain) => chain.network)).not.toContain('linea');
  });

  it('lets one of two concurrent admins hide one of the last two visible networks', async () => {
    expect((await toggle(app, '900000000001', false, 0)).statusCode).toBe(200);

    const [first, second] = await Promise.all([
      toggle(app, '84532', false, 1, 'admin-a'),
      toggle(app, SCROLL_CHAIN, false, 1, 'admin-b')
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    const loser = first.statusCode === 409 ? first : second;
    const loserChain = loser === first ? '84532' : SCROLL_CHAIN;

    expect(statuses).toEqual([200, 409]);
    expect(loser.json().code).toBe('CONFIG_CONFLICT');
    const retry = await toggle(app, loserChain, false, 2);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().code).toBe('LAST_ENABLED_NETWORK');
    expect((await get(app, '/v1/metrics/networks')).json().networks).toHaveLength(1);
    const events = await store.listActivity(10);
    expect(events.filter((event) => event.outcome === 'failure')).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'network_hidden',
      target: expect.stringMatching(/\((84532|534352)\)$/)
    });
  });

  it('applies the CAS and the last-visible rule in the store for concurrent calls', async () => {
    const catalogChainIds = ['1', '2'];
    const results = await Promise.all([
      store.changeNetworkVisibility(
        {
          chainId: '1',
          analyticsEnabled: false,
          expectedRevision: 0,
          catalogChainIds,
          actorId: 'a'
        },
        NOW
      ),
      store.changeNetworkVisibility(
        {
          chainId: '2',
          analyticsEnabled: false,
          expectedRevision: 0,
          catalogChainIds,
          actorId: 'b'
        },
        NOW
      )
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'ok']);
    expect((await store.networkVisibility()).disabledChainIds).toHaveLength(1);
    expect(
      planVisibilityChange(
        {
          disabledChainIds: ['1'],
          disabledTokenIds: [],
          revision: 1,
          updatedAt: NOW,
          updatedBy: 'a'
        },
        {
          chainId: '2',
          analyticsEnabled: false,
          expectedRevision: 1,
          catalogChainIds,
          actorId: 'b'
        },
        NOW
      )
    ).toMatchObject({ kind: 'done', result: { kind: 'last_enabled' } });
  });

  it('answers 401, 403, 400, 404 and 409 on the admin endpoints', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/networks' });
    const viewerList = await get(app, '/v1/admin/networks');
    const viewerPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/networks/${SCROLL_CHAIN}`,
      headers: { 'x-test-role': 'viewer' },
      payload: { analyticsEnabled: false, expectedRevision: 0 }
    });
    const invalid = await Promise.all(
      [
        { analyticsEnabled: false },
        { analyticsEnabled: 'no', expectedRevision: 0 },
        { analyticsEnabled: false, expectedRevision: -1 },
        { analyticsEnabled: false, expectedRevision: 0, network: 'scroll' }
      ].map((payload) =>
        app.inject({
          method: 'PATCH',
          url: `/v1/admin/networks/${SCROLL_CHAIN}`,
          headers: { 'x-test-role': 'admin' },
          payload
        })
      )
    );
    const badChain = await toggle(app, 'scroll', false, 0);
    const unknownChain = await toggle(app, '1', false, 0);
    const stale = await toggle(app, SCROLL_CHAIN, false, 5);

    expect(anonymous.statusCode).toBe(401);
    expect(viewerList.statusCode).toBe(403);
    expect(viewerPatch.statusCode).toBe(403);
    expect(invalid.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    expect(badChain.statusCode).toBe(400);
    expect(unknownChain.statusCode).toBe(404);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('CONFIG_CONFLICT');
    expect((await store.networkVisibility()).revision).toBe(0);
    expect(viewerList.headers['cache-control']).toBe('private, no-store');
  });

  it('serves the same networks from every instance right after a change', async () => {
    const other = await appWith(store);
    try {
      expect((await toggle(app, SCROLL_CHAIN, false, 0)).statusCode).toBe(200);

      const ids = (await get(other, '/v1/metrics/networks'))
        .json()
        .networks.map((item: { id: string }) => item.id);
      expect(ids).not.toContain('scroll');
      expect(networksOf((await get(other, '/v1/metrics/users')).json())).not.toContain('scroll');
      expect((await get(other, '/v1/metrics/users?network=scroll')).statusCode).toBe(400);
    } finally {
      await other.close();
    }
  });
});

describe('network visibility failures', () => {
  it('answers 503 without data when the policy cannot be read', async () => {
    const store = new MemoryStore();
    store.networkVisibility = async () => {
      throw new Error('connection lost');
    };
    const app = await appWith(store);
    try {
      for (const url of [
        '/v1/metrics/networks',
        '/v1/metrics/overview',
        '/v1/metrics/users',
        '/v1/metrics/revenue',
        '/v1/admin/networks'
      ]) {
        const response = await get(app, url, 'admin');
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
        expect(response.body).not.toMatch(/volumeUsd|activeUsers|feesUsd|networks/);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps the copies and the live dataset when a B2C read fails', async () => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    const reader = new FakeReader(
      activity(),
      USERS,
      [...TOKENS, SCROLL_TOKEN],
      [...CHAINS, SCROLL]
    );
    const repository = new MemoryIngestRepository();
    await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);
    const builtAt = repository.stored?.builtAt;
    reader.chains = async () => {
      throw new Error('B2C unreachable');
    };

    await expect(ingest(reader, repository)).rejects.toThrow('B2C unreachable');

    expect(await repository.chains()).toContainEqual(SCROLL);
    expect(repository.copies.size).toBe(4);
    expect(repository.stored?.builtAt).toEqual(builtAt);
    expect(repository.lock).toBeNull();
    const overview = buildOverview('all', 'month', NOW);
    expect(overview.meta.dataStatus).toBe('live');
    expect(overview.byNetwork.find((item) => item.network === 'scroll')?.transactions).toBe(2);
  });

  it('reports the Scroll balances as unread when its RPC is unreachable', async () => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    const tokens: TokenInfo[] = [
      {
        chainId: '84532',
        symbol: 'USDC',
        stable: true,
        address: TOKEN_ADDRESSES.USDC,
        decimals: 6
      },
      SCROLL_TOKEN
    ];
    const scrollRpc = 'https://rpc.scroll.test/key-in-path';
    const reader = new FakeReader(
      activity(),
      USERS,
      tokens,
      [CHAINS[0] as ChainInfo, SCROLL],
      [
        ENDPOINTS[0] as (typeof ENDPOINTS)[number],
        { chainId: SCROLL_CHAIN, family: 'evm', url: scrollRpc }
      ]
    );
    const repository = new MemoryIngestRepository();
    // Base answers one USDC per wallet; the Scroll endpoint is unreachable.
    const balances = rpcBalanceReader(
      async (url, init) => {
        if (url === scrollRpc) {
          throw new TypeError('fetch failed');
        }
        const data =
          (JSON.parse(init.body) as { params: Array<{ data: string }> }).params[0]?.data ?? '';
        const calls = Number.parseInt(data.slice(10 + 64, 10 + 128), 16);
        const word = (value: number) => value.toString(16).padStart(64, '0');
        const tuples = Array.from(
          { length: calls },
          () => word(1) + word(0x40) + word(32) + word(1_000_000)
        );
        const offsets = tuples.map((_, index) =>
          word(calls * 32 + (index * (tuples[0]?.length ?? 0)) / 2)
        );
        const result = `0x${word(0x20)}${word(calls)}${offsets.join('')}${tuples.join('')}`;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      },
      () => NOW.getTime()
    );

    const report = await ingest(reader, repository, balances);
    await refreshLiveMetrics(repository, null);

    expect(report.status).toBe('completed');
    expect(report.sources.balances.status).toBe('partial');
    expect(report.sources.balances.failedCalls).toBeGreaterThan(0);
    expect(report.sources.balances.networks).toMatchObject([
      {
        network: 'base-sepolia',
        status: 'complete',
        wallets: 2,
        walletsRead: 2,
        failedCalls: 0,
        reason: null,
        takenAt: NOW.toISOString()
      },
      {
        network: 'scroll',
        status: 'failed',
        wallets: 2,
        walletsRead: 0,
        attempted: true,
        endpointPresent: true,
        reason: 'rpc_failed',
        lastSuccessAt: null,
        takenAt: NOW.toISOString()
      }
    ]);
    const [base, scrollRead] = report.sources.balances.networks;
    expect((base?.calls ?? 0) + (scrollRead?.calls ?? 0)).toBe(report.sources.balances.calls);
    expect(scrollRead?.failedCalls).toBe(report.sources.balances.failedCalls);
    const all = buildOverview('all', 'month', NOW).tvl;
    const scroll = buildOverview('scroll', 'month', NOW).tvl;
    expect(all).toMatchObject({
      source: 'live',
      availability: 'partial',
      reason: 'partial_coverage'
    });
    // Nothing of Scroll was read: no value, never a zero.
    expect(scroll).toMatchObject({
      source: 'live',
      availability: 'unavailable',
      reason: 'not_read',
      value: null
    });
    expect(scroll.byNetwork).toEqual([
      {
        network: 'scroll',
        label: 'Scroll',
        tvlUsd: null,
        share: null,
        status: 'failed',
        reason: 'rpc_failed',
        lastSuccessAt: null
      }
    ]);
    // The Base Sepolia token list of the fixture has no native coin, so its wallets were read
    // without it: a subtotal, never `available`.
    expect(buildOverview('all', 'month', NOW, ['base-sepolia']).tvl).toMatchObject({
      availability: 'partial',
      reason: 'native_not_covered',
      value: { value: '2.00' }
    });
  });
});
