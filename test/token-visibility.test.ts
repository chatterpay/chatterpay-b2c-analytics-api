import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/principal.js';
import { loadEnv } from '../src/config/env.js';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import type { ChainInfo, IngestedUser, RunSnapshot, TokenInfo } from '../src/ingest/types.js';
import { DEFAULT_NETWORKS, listNetworks, setNetworks } from '../src/metrics/catalog.js';
import { resetFactsCaches } from '../src/metrics/facts.js';
import { aggregateActivity, liveSourceFrom } from '../src/metrics/live.js';
import { buildOverview } from '../src/metrics/overview.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { liveSnapshots } from '../src/metrics/snapshot-source.js';
import { setLiveSource } from '../src/metrics/sources.js';
import { scopeFacts } from '../src/metrics/token-scope.js';
import { hiddenAssets, listTokens, setTokens, tokenIdOf } from '../src/metrics/tokens.js';
import { toNetworkDefinitions } from '../src/store/b2c-networks.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { planTokenVisibilityChange } from '../src/store/network-visibility.js';
import type { Store } from '../src/store/types.js';
import {
  CHAINS,
  FakeReader,
  MemoryIngestRepository,
  TOKEN_ADDRESSES,
  TOKENS,
  transaction
} from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const SCROLL_CHAIN = '534352';
const SCROLL_USDC = '0x5555555555555555555555555555555555555555';
const SCROLL_USDT = '0x6666666666666666666666666666666666666666';
const BASE_USDT_ID = `84532:${TOKEN_ADDRESSES.USDT}`;
const SCROLL_USDT_ID = `${SCROLL_CHAIN}:${SCROLL_USDT}`;

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 0,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

const B2C_DOCUMENTS = [
  { name: 'Base Sepolia', family: 'evm', chainId: 84532, enabled: true },
  { name: 'Cardano Preprod', family: 'cardano', chainId: 900000000001, enabled: true },
  { name: 'Scroll', family: 'evm', chainId: 534352, enabled: false }
];

const SCROLL: ChainInfo = {
  chainId: SCROLL_CHAIN,
  network: 'scroll',
  name: 'Scroll',
  family: 'evm',
  explorer: 'https://scrollscan.com',
  contracts: {}
};
const SCROLL_TOKENS: TokenInfo[] = [
  { chainId: SCROLL_CHAIN, symbol: 'USDC', stable: true, address: SCROLL_USDC, decimals: 6 },
  { chainId: SCROLL_CHAIN, symbol: 'USDT', stable: true, address: SCROLL_USDT, decimals: 6 }
];

const USERS: IngestedUser[] = [
  {
    id: 'user-base',
    createdAt: new Date('2026-10-10T10:00:00.000Z'),
    wallets: [{ chainId: '84532', address: '0xBase' }]
  },
  {
    id: 'user-scroll',
    createdAt: new Date('2026-10-11T10:00:00.000Z'),
    wallets: [{ chainId: SCROLL_CHAIN, address: '0xScroll' }]
  }
];

/** USDC and USDT on Base Sepolia and on Scroll, each a token of its own. */
function activity() {
  return [
    transaction(1, { from: '0xBase', token: 'USDC', amount: 10, fee: 0.1 }),
    transaction(2, { from: '0xBase', token: 'USDT', amount: 20, fee: 0.2 }),
    transaction(3, { from: '0xScroll', chainId: SCROLL_CHAIN, token: 'USDT', amount: 300, fee: 3 }),
    transaction(4, { from: '0xScroll', chainId: SCROLL_CHAIN, token: 'USDC', amount: 400, fee: 4 })
  ];
}

async function headerAuthenticator(request: {
  headers: Record<string, unknown>;
}): Promise<Principal | null> {
  const role = request.headers['x-test-role'];
  if (role === 'admin' || role === 'viewer') {
    return { userId: 'admin-0001', role };
  }
  return null;
}

async function appWith(store: Store): Promise<FastifyInstance> {
  const app = await buildApp(env, { authenticate: headerAuthenticator, clock: () => NOW, store });
  await app.ready();
  return app;
}

function ingest(reader: FakeReader, repository: MemoryIngestRepository) {
  return runIngestion({
    reader,
    repository,
    prices: null,
    balances: null,
    masterWallets: [],
    clock: () => NOW,
    options: OPTIONS,
    owner: 'token-test'
  });
}

/** Token copies as the server loads them: retained ones carry `sourcePresent: false`. */
async function loadTokens(repository: MemoryIngestRepository): Promise<void> {
  setTokens(
    (await repository.tokens()).map((token) => ({
      ...token,
      sourcePresent: !repository.retained.tokens.has(`${token.chainId}|${token.symbol}`)
    }))
  );
}

async function get(app: FastifyInstance, url: string, role: 'admin' | 'viewer' = 'viewer') {
  return app.inject({ method: 'GET', url, headers: { 'x-test-role': role } });
}

async function patch(
  app: FastifyInstance,
  url: string,
  analyticsEnabled: boolean,
  expectedRevision: number,
  role: 'admin' | 'viewer' | null = 'admin'
) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: role === null ? {} : { 'x-test-role': role },
    payload: { analyticsEnabled, expectedRevision }
  });
}

function toggleToken(app: FastifyInstance, tokenId: string, enabled: boolean, revision: number) {
  return patch(app, `/v1/admin/tokens/${encodeURIComponent(tokenId)}`, enabled, revision);
}

function toggleNetwork(app: FastifyInstance, chainId: string, enabled: boolean, revision: number) {
  return patch(app, `/v1/admin/networks/${chainId}`, enabled, revision);
}

interface AdminToken {
  id: string;
  symbol: string;
  analyticsEnabled: boolean;
  effectiveEnabled: boolean;
  sourcePresent: boolean;
}

function tokensOf(body: { networks: Array<{ id: string; tokens: AdminToken[] }> }, id: string) {
  return body.networks.find((network) => network.id === id)?.tokens ?? [];
}

interface NetworkRow {
  network: string;
  volumeUsd?: string | null;
  transactions?: number;
  tvlUsd?: string | null;
}

function rowOf(rows: readonly NetworkRow[], network: string): NetworkRow | undefined {
  return rows.find((row) => row.network === network);
}

afterEach(() => {
  setLiveSource(null);
  setNetworks(DEFAULT_NETWORKS);
  setTokens(null);
  resetFactsCaches();
});

describe('token ids', () => {
  it('keys a token by chain id and address, the native coin as native', () => {
    const upper = '0xABCDEFabcdef0000000000000000000000000001';
    expect(tokenIdOf({ chainId: '8453', symbol: 'USDC', address: upper })).toBe(
      `8453:${upper.toLowerCase()}`
    );
    expect(
      tokenIdOf({
        chainId: '8453',
        symbol: 'ETH',
        address: '0x0000000000000000000000000000000000000000'
      })
    ).toBe('8453:native');
    expect(
      tokenIdOf({
        chainId: '8453',
        symbol: 'ETH',
        address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
      })
    ).toBe('8453:native');
    expect(tokenIdOf({ chainId: '900000000001', symbol: 'ADA', address: 'cardano:lovelace' })).toBe(
      '900000000001:native'
    );
    expect(
      tokenIdOf({ chainId: '900000000001', symbol: 'USDCx', address: `${'A'.repeat(56)}55` })
    ).toBe(`900000000001:${'a'.repeat(56)}55`);
    expect(tokenIdOf({ chainId: '8453', symbol: 'usd+', address: '' })).toBe('8453:symbol:USD_');
  });

  it('tells USDT on Base apart from USDT on Scroll', () => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    setTokens([...TOKENS, ...SCROLL_TOKENS]);

    const usdt = listTokens().filter((token) => token.symbol === 'USDT');
    expect(usdt.map((token) => token.id)).toEqual([BASE_USDT_ID, SCROLL_USDT_ID]);
    expect(hiddenAssets([BASE_USDT_ID], listNetworks())).toEqual(
      new Map([['base-sepolia', new Set(['USDT'])]])
    );
  });

  it('hides a symbol only when every token of the network with it is hidden', () => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    const bridged = '0x7777777777777777777777777777777777777777';
    setTokens([
      ...TOKENS,
      { chainId: '84532', symbol: 'usdt', stable: true, address: bridged, decimals: 6 }
    ]);

    expect(hiddenAssets([BASE_USDT_ID], listNetworks()).size).toBe(0);
    expect(hiddenAssets([BASE_USDT_ID, `84532:${bridged}`], listNetworks())).toEqual(
      new Map([['base-sepolia', new Set(['USDT'])]])
    );
  });

  it('leaves the counts as they are for facts without counts per asset', () => {
    const facts = {
      newUsers: 1,
      newWallets: 1,
      activeUserDays: 0,
      transfers: 3,
      swaps: 0,
      transferVolume: { USDC: 100, USDT: 200 },
      swapVolume: {},
      transferFees: { USDC: 1, USDT: 2 },
      swapFees: {},
      unpriced: { transferVolume: { WETH: 1 }, swapVolume: {}, transferFees: {}, swapFees: {} }
    };
    const scoped = scopeFacts(facts, new Set(['USDT', 'WETH']));

    expect(scoped).toMatchObject({
      newUsers: 1,
      transfers: 3,
      transferVolume: { USDC: 100 },
      transferFees: { USDC: 1 },
      unpriced: { transferVolume: {} }
    });
    expect(
      scopeFacts(
        { ...facts, transfersByAsset: { USDC: 1, USDT: 2 }, swapsByAsset: {} },
        new Set(['USDT'])
      ).transfers
    ).toBe(1);
  });
});

describe('token policy on the snapshots', () => {
  const holdings: RunSnapshot = {
    takenAt: new Date('2026-10-24T02:00:00.000Z'),
    balances: {
      networks: [
        {
          network: 'base-sepolia',
          status: 'complete',
          wallets: 1,
          walletsRead: 1,
          native: 'included'
        },
        { network: 'scroll', status: 'complete', wallets: 1, walletsRead: 1, native: 'included' }
      ],
      holdings: [
        { network: 'base-sepolia', asset: 'USDT', amount: '5.0', valueCents: 500 },
        { network: 'base-sepolia', asset: 'USDC', amount: '1.0', valueCents: 100 },
        { network: 'scroll', asset: 'USDT', amount: '7.0', valueCents: 700 },
        { network: 'scroll', asset: 'WETH', amount: '0.5', valueCents: null }
      ],
      masterWallets: [
        {
          network: 'base-sepolia',
          role: 'Backend signer',
          address: '0x000000000000000000000000000000000000c0de',
          explorerUrl: null,
          status: 'complete',
          balances: [
            { asset: 'USDT', amount: '2.0', valueCents: 200 },
            { asset: 'USDC', amount: '3.0', valueCents: 300 }
          ]
        }
      ]
    },
    countries: []
  };

  beforeEach(() => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    setTokens([...TOKENS, ...SCROLL_TOKENS]);
    const { aggregates } = aggregateActivity({
      transactions: activity(),
      users: USERS,
      tokens: [...TOKENS, ...SCROLL_TOKENS],
      chains: new Map([...CHAINS, SCROLL].map((chain) => [chain.chainId, chain.network])),
      prices: []
    });
    setLiveSource(liveSourceFrom(aggregates), NOW, {
      snapshots: liveSnapshots([holdings], 'complete')
    });
  });

  it('leaves hidden tokens out of TVL, Top Tokens and master wallets', () => {
    const hidden = hiddenAssets([BASE_USDT_ID], listNetworks());

    const all = buildOverview('all', 'month', NOW, undefined, hidden);
    expect(all.tvl.value?.value).toBe('8.00');
    expect(rowOf(all.tvl.byNetwork, 'base-sepolia')?.tvlUsd).toBe('1.00');
    const usdt = all.topTokens.items.find((item) => item.asset === 'USDT');
    expect(usdt).toMatchObject({
      amount: '7.0',
      valueUsd: '7.00',
      networks: [{ network: 'scroll', amount: '7.0', valueUsd: '7.00' }]
    });
    expect(all.topTokens.items.find((item) => item.asset === 'WETH')).toMatchObject({
      amount: '0.5',
      valueUsd: null,
      networks: [{ network: 'scroll', amount: '0.5', valueUsd: null }]
    });
    const wallets = buildRevenue('all', 'month', NOW, undefined, hidden).masterWallets;
    expect(wallets.items[0]?.balances.map((balance) => balance.asset)).toEqual(['USDC']);
    expect(wallets.totalUsd).toBe('3.00');

    const unscoped = buildOverview('all', 'month', NOW);
    expect(unscoped.tvl.value?.value).toBe('13.00');
    expect(unscoped.topTokens.items.find((item) => item.asset === 'USDT')?.networks).toEqual([
      { network: 'base-sepolia', amount: '5.0', valueUsd: '5.00' },
      { network: 'scroll', amount: '7.0', valueUsd: '7.00' }
    ]);
  });
});

describe('token visibility endpoints', () => {
  let store: MemoryStore;
  let app: FastifyInstance;
  let reader: FakeReader;
  let repository: MemoryIngestRepository;

  beforeEach(async () => {
    setNetworks(toNetworkDefinitions(B2C_DOCUMENTS));
    reader = new FakeReader(activity(), USERS, [...TOKENS, ...SCROLL_TOKENS], [...CHAINS, SCROLL]);
    repository = new MemoryIngestRepository();
    await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);
    await loadTokens(repository);
    store = new MemoryStore();
    app = await appWith(store);
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists every network with its tokens, each under its chain id and address', async () => {
    const admin = (await get(app, '/v1/admin/networks', 'admin')).json();

    expect(tokensOf(admin, 'base-sepolia').map((token) => token.id)).toEqual([
      `84532:${TOKEN_ADDRESSES.USDC}`,
      BASE_USDT_ID,
      `84532:${TOKEN_ADDRESSES.WBTC}`,
      `84532:${TOKEN_ADDRESSES.WETH}`
    ]);
    expect(tokensOf(admin, 'cardano-preprod')[0]).toMatchObject({
      id: '900000000001:native',
      symbol: 'ADA'
    });
    expect(tokensOf(admin, 'scroll').find((token) => token.symbol === 'USDT')).toMatchObject({
      id: SCROLL_USDT_ID,
      analyticsEnabled: true,
      effectiveEnabled: true,
      sourcePresent: true
    });
  });

  it('hides USDT of Base only, before anything is added', async () => {
    const usersBefore = (await get(app, '/v1/metrics/users')).body;

    const response = await toggleToken(app, BASE_USDT_ID, false, 0);
    expect(response.statusCode).toBe(200);
    expect(response.json().revision).toBe(1);

    const overview = (await get(app, '/v1/metrics/overview')).json();
    const revenue = (await get(app, '/v1/metrics/revenue')).json();
    expect(overview.meta.tokenScope).toEqual({
      hidden: [{ network: 'base-sepolia', asset: 'USDT' }],
      operationCounts: 'filtered'
    });
    expect(rowOf(overview.byNetwork, 'base-sepolia')).toMatchObject({
      volumeUsd: '10.00',
      transactions: 1,
      feesUsd: '0.10'
    });
    expect(rowOf(overview.byNetwork, 'scroll')).toMatchObject({
      volumeUsd: '700.00',
      transactions: 2,
      feesUsd: '7.00'
    });
    expect(overview.tiles.volumeUsd.value).toBe('710.00');
    expect(overview.tiles.transactions.value).toBe(3);
    expect(overview.tradedTokens.items).toEqual([
      { network: 'base-sepolia', asset: 'USDC', operations: 1, volumeUsd: '10.00' },
      { network: 'scroll', asset: 'USDC', operations: 1, volumeUsd: '400.00' },
      { network: 'scroll', asset: 'USDT', operations: 1, volumeUsd: '300.00' }
    ]);
    expect(revenue.meta.tokenScope.hidden).toEqual([{ network: 'base-sepolia', asset: 'USDT' }]);
    expect(revenue.tiles.feesUsd.value).toBe('7.10');
    expect(
      revenue.byAsset.map(
        (row: { network: string; asset: string }) => `${row.network}/${row.asset}`
      )
    ).not.toContain('base-sepolia/USDT');
    expect(revenue.avgFeePerTransaction.transactions).toBe(3);
    // Users, signups and wallets have no token.
    expect((await get(app, '/v1/metrics/users')).body).toEqual(usersBefore);
  });

  it('hides the tokens of a hidden network without writing them and restores them with it', async () => {
    expect((await toggleToken(app, BASE_USDT_ID, false, 0)).statusCode).toBe(200);
    expect((await toggleNetwork(app, SCROLL_CHAIN, false, 1)).statusCode).toBe(200);

    const hidden = (await get(app, '/v1/admin/networks', 'admin')).json();
    expect(tokensOf(hidden, 'scroll').every((token) => token.analyticsEnabled)).toBe(true);
    expect(tokensOf(hidden, 'scroll').some((token) => token.effectiveEnabled)).toBe(false);
    expect((await store.networkVisibility()).disabledTokenIds).toEqual([BASE_USDT_ID]);

    expect((await toggleNetwork(app, SCROLL_CHAIN, true, 2)).statusCode).toBe(200);
    const shown = (await get(app, '/v1/admin/networks', 'admin')).json();
    expect(tokensOf(shown, 'scroll').every((token) => token.effectiveEnabled)).toBe(true);
    expect(
      tokensOf(shown, 'base-sepolia').find((token) => token.id === BASE_USDT_ID)
    ).toMatchObject({ analyticsEnabled: false, effectiveEnabled: false });
    const overview = (await get(app, '/v1/metrics/overview')).json();
    expect(overview.meta.tokenScope.hidden).toEqual([{ network: 'base-sepolia', asset: 'USDT' }]);
    expect(rowOf(overview.byNetwork, 'scroll')?.volumeUsd).toBe('700.00');
  });

  it('keeps one network visible whatever the tokens', async () => {
    let revision = 0;
    for (const token of tokensOf(
      (await get(app, '/v1/admin/networks', 'admin')).json(),
      'base-sepolia'
    )) {
      expect((await toggleToken(app, token.id, false, revision)).statusCode).toBe(200);
      revision += 1;
    }
    expect((await toggleNetwork(app, '900000000001', false, revision)).statusCode).toBe(200);
    expect((await toggleNetwork(app, SCROLL_CHAIN, false, revision + 1)).statusCode).toBe(200);

    const last = await toggleNetwork(app, '84532', false, revision + 2);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ code: 'LAST_ENABLED_NETWORK' });
    const overview = (await get(app, '/v1/metrics/overview')).json();
    expect(overview.byNetwork.map((row: { network: string }) => row.network)).toEqual([
      'base-sepolia'
    ]);
    expect(overview.tiles.volumeUsd.value).toBe('0.00');
    expect(overview.tiles.transactions.value).toBe(0);
  });

  it('refuses a stale revision with 409 and lets one of two concurrent changes in', async () => {
    const [first, second] = await Promise.all([
      toggleToken(app, BASE_USDT_ID, false, 0),
      toggleToken(app, SCROLL_USDT_ID, false, 0)
    ]);
    expect([first?.statusCode, second?.statusCode].sort()).toEqual([200, 409]);
    const conflict = [first, second].find((response) => response?.statusCode === 409);
    expect(conflict?.json()).toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect((await store.networkVisibility()).disabledTokenIds).toHaveLength(1);

    const stale = await toggleToken(app, BASE_USDT_ID, true, 0);
    expect(stale.statusCode).toBe(409);
    const activity = await store.listActivity(10);
    expect(activity.map((event) => [event.action, event.outcome])).toContainEqual([
      'token_shown',
      'failure'
    ]);
  });

  it('answers 401, 403, 400 and 404 on the token endpoint', async () => {
    const url = `/v1/admin/tokens/${encodeURIComponent(BASE_USDT_ID)}`;
    expect((await patch(app, url, false, 0, null)).statusCode).toBe(401);
    expect((await patch(app, url, false, 0, 'viewer')).statusCode).toBe(403);
    expect((await patch(app, '/v1/admin/tokens/not-a-token', false, 0)).statusCode).toBe(400);
    expect(
      (
        await patch(
          app,
          `/v1/admin/tokens/${encodeURIComponent('84532:0x9999999999999999999999999999999999999999')}`,
          false,
          0
        )
      ).statusCode
    ).toBe(404);
    expect((await store.networkVisibility()).revision).toBe(0);
  });

  it('keeps a token B2C stopped listing, with its history and its preference', async () => {
    expect((await toggleToken(app, SCROLL_USDT_ID, false, 0)).statusCode).toBe(200);
    reader.tokenList = [...TOKENS, ...SCROLL_TOKENS.filter((token) => token.symbol !== 'USDT')];

    await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);
    await loadTokens(repository);

    const admin = (await get(app, '/v1/admin/networks', 'admin')).json();
    expect(tokensOf(admin, 'scroll').find((token) => token.id === SCROLL_USDT_ID)).toMatchObject({
      sourcePresent: false,
      analyticsEnabled: false
    });
    expect((await toggleToken(app, SCROLL_USDT_ID, true, 1)).statusCode).toBe(200);
    const overview = (await get(app, '/v1/metrics/overview?network=scroll')).json();
    expect(overview.tiles.volumeUsd.value).toBe('700.00');
  });

  it('keeps the policy across a new ingestion run', async () => {
    expect((await toggleToken(app, BASE_USDT_ID, false, 0)).statusCode).toBe(200);
    const before = await store.networkVisibility();

    await ingest(reader, repository);
    await refreshLiveMetrics(repository, null);
    await loadTokens(repository);

    expect(await store.networkVisibility()).toEqual(before);
    const overview = (await get(app, '/v1/metrics/overview')).json();
    expect(rowOf(overview.byNetwork, 'base-sepolia')?.volumeUsd).toBe('10.00');
  });

  it('answers 503 and keeps the toggles when the store fails', async () => {
    expect((await toggleToken(app, BASE_USDT_ID, false, 0)).statusCode).toBe(200);
    const failing = store.changeTokenVisibility.bind(store);
    store.changeTokenVisibility = async () => {
      throw new Error('connection lost');
    };

    const response = await toggleToken(app, SCROLL_USDT_ID, false, 1);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    store.changeTokenVisibility = failing;
    expect((await store.networkVisibility()).disabledTokenIds).toEqual([BASE_USDT_ID]);
    const admin = (await get(app, '/v1/admin/networks', 'admin')).json();
    expect(tokensOf(admin, 'scroll').every((token) => token.analyticsEnabled)).toBe(true);
  });

  it('says the counts include hidden tokens for a build without counts per asset', async () => {
    const stored = repository.stored;
    if (stored === null) {
      throw new Error('no build');
    }
    stored.hourly = stored.hourly.map(({ transfersByAsset, swapsByAsset, ...rest }) => rest);
    await refreshLiveMetrics(repository, null);
    expect((await toggleToken(app, BASE_USDT_ID, false, 0)).statusCode).toBe(200);

    const overview = (await get(app, '/v1/metrics/overview')).json();
    expect(overview.meta.tokenScope.operationCounts).toBe('unfiltered');
    expect(rowOf(overview.byNetwork, 'base-sepolia')).toMatchObject({
      volumeUsd: '10.00',
      transactions: 2
    });
    expect(overview.tradedTokens).toMatchObject({
      availability: 'unavailable',
      reason: 'not_recorded',
      items: []
    });
  });

  it('plans a token change without touching the network ids', () => {
    const plan = planTokenVisibilityChange(
      {
        disabledChainIds: [SCROLL_CHAIN],
        disabledTokenIds: [],
        revision: 4,
        updatedAt: NOW,
        updatedBy: 'a'
      },
      { tokenId: SCROLL_USDT_ID, analyticsEnabled: false, expectedRevision: 4, actorId: 'b' },
      NOW
    );
    expect(plan).toEqual({
      kind: 'write',
      next: {
        disabledChainIds: [SCROLL_CHAIN],
        disabledTokenIds: [SCROLL_USDT_ID],
        revision: 5,
        updatedAt: NOW,
        updatedBy: 'b'
      }
    });
  });
});
