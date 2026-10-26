import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import { failedRunEvent, ingestRunEvent } from '../src/ingest/run-event.js';
import type {
  DailyPrice,
  IngestedTransaction,
  IngestedUser,
  RunSnapshot,
  SnapshotNetwork
} from '../src/ingest/types.js';
import type { NetworkId } from '../src/metrics/catalog.js';
import { aggregateActivity, liveSourceFrom } from '../src/metrics/live.js';
import { buildOverview } from '../src/metrics/overview.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { liveSnapshots } from '../src/metrics/snapshot-source.js';
import { setLiveSource } from '../src/metrics/sources.js';
import type { IngestRunStatus, UsdValuation } from '../src/metrics/types.js';
import { buildUsers } from '../src/metrics/users.js';
import {
  CHAINS,
  ENDPOINTS,
  FakeBalanceReader,
  FakeReader,
  MemoryIngestRepository,
  RecordingBalanceReader,
  TOKEN_ADDRESSES,
  TOKENS,
  transaction
} from './ingest-fakes.js';

const CHAIN_MAP = new Map(CHAINS.map((chain) => [chain.chainId, chain.network]));
const NOW = new Date('2026-10-24T15:30:00.000Z');
const ROUTER = '0xRouter';
const SCROLL_CHAIN = '534352';

const USERS: IngestedUser[] = [
  {
    id: 'u1',
    createdAt: new Date('2026-09-15T08:30:00.000Z'),
    wallets: [{ chainId: '84532', address: '0xUser1' }]
  },
  {
    id: 'u2',
    createdAt: new Date('2026-10-01T09:10:00.000Z'),
    wallets: [{ chainId: '84532', address: '0xUser2' }]
  }
];

/** The two rows the backend writes for one swap: user to router, then router to user. */
function swapLegs(
  first: number,
  fields: {
    hash: string;
    user?: string;
    sell?: [string, number, number];
    buy?: [string, number];
    at?: string;
    status?: [string, string];
    chainId?: string;
  }
): [IngestedTransaction, IngestedTransaction] {
  const user = fields.user ?? '0xUser1';
  const [sellToken, sellAmount, fee] = fields.sell ?? ['USDC', 10, 0.08];
  const [buyToken, buyAmount] = fields.buy ?? ['WETH', 0.004];
  const at = new Date(fields.at ?? '2026-10-12T11:05:00.000Z');
  const [inStatus, outStatus] = fields.status ?? ['completed', 'completed'];
  const chainId = fields.chainId ?? '84532';
  return [
    transaction(first, {
      type: 'swap',
      hash: fields.hash,
      from: user,
      to: ROUTER,
      token: sellToken,
      amount: sellAmount,
      fee,
      date: at,
      status: inStatus,
      chainId
    }),
    transaction(first + 1, {
      type: 'swap',
      hash: fields.hash,
      from: ROUTER,
      to: user,
      token: buyToken,
      amount: buyAmount,
      fee: 0,
      date: new Date(at.getTime() + 20),
      status: outStatus,
      chainId
    })
  ];
}

function aggregate(
  rows: readonly IngestedTransaction[],
  options: {
    prices?: DailyPrice[];
    valuation?: UsdValuation;
    users?: IngestedUser[];
    chains?: ReadonlyMap<string, NetworkId>;
  } = {}
) {
  return aggregateActivity({
    transactions: rows,
    users: options.users ?? USERS,
    tokens: TOKENS,
    chains: options.chains ?? CHAIN_MAP,
    prices: options.prices ?? [],
    ...(options.valuation === undefined ? {} : { valuation: options.valuation })
  });
}

function runStatus(valuation: UsdValuation = 'market'): IngestRunStatus {
  return {
    status: 'completed',
    finishedAt: NOW.toISOString(),
    sources: { transactions: 'complete', prices: 'complete', balances: 'complete' },
    valuation
  };
}

function install(
  rows: readonly IngestedTransaction[],
  options: {
    prices?: DailyPrice[];
    valuation?: UsdValuation;
    users?: IngestedUser[];
    snapshots?: RunSnapshot[];
  } = {}
): void {
  const { aggregates } = aggregate(rows, options);
  const run = runStatus(options.valuation);
  setLiveSource(liveSourceFrom(aggregates, new Date('2026-09-01T00:00:00.000Z')), NOW, {
    snapshots: liveSnapshots(options.snapshots ?? [], run.sources.balances),
    ingest: run
  });
}

afterEach(() => {
  setLiveSource(null);
});

describe('swap pairing', () => {
  it('counts a swap with its two legs completed once, valued on its stable input', () => {
    const { stats, aggregates } = aggregate(swapLegs(1, { hash: '0xswap' }));

    expect(stats).toMatchObject({ swaps: 1, transfers: 0, unverifiedSwaps: 0 });
    const hour = aggregates.hourly.find((item) => item.swaps > 0);
    // The fee is on the input leg: 0.08 USDC.
    expect(hour?.swapVolume).toEqual({ USDC: 1000 });
    expect(hour?.swapFees).toEqual({ USDC: 8 });
  });

  it('leaves out a swap whose output leg is still pending', () => {
    const { stats } = aggregate(swapLegs(1, { hash: '0xswap', status: ['completed', 'pending'] }));

    expect(stats).toMatchObject({ swaps: 0, transfers: 0, unverifiedSwaps: 1 });
  });

  it('counts a single leg as unverified, never as a transfer', () => {
    const [input] = swapLegs(1, { hash: '0xswap' });

    const { stats, aggregates } = aggregate([input]);

    expect(stats).toMatchObject({ swaps: 0, transfers: 0, unverifiedSwaps: 1 });
    expect(aggregates.hourly.every((item) => item.swaps === 0 && item.transfers === 0)).toBe(true);
  });

  it('counts nothing for a swap without any completed row', () => {
    const { stats } = aggregate(swapLegs(1, { hash: '0xswap', status: ['failed', 'failed'] }));

    expect(stats).toMatchObject({ swaps: 0, unverifiedSwaps: 0 });
  });

  it('reads a retransmitted leg as one leg, and its completed copy as the leg', () => {
    const [input, output] = swapLegs(1, { hash: '0xswap' });
    const pendingCopy = { ...output, id: transaction(9).id, status: 'pending' };
    const retransmitted = { ...input, id: transaction(10).id };

    const { stats, aggregates } = aggregate([input, output, pendingCopy, retransmitted]);

    expect(stats).toMatchObject({ swaps: 1, unverifiedSwaps: 0 });
    expect(aggregates.hourly.find((item) => item.swaps > 0)?.swapVolume).toEqual({ USDC: 1000 });
  });

  it('takes the leg sent by the user as the input whatever the order of the rows', () => {
    const [input, output] = swapLegs(1, { hash: '0xswap' });
    // The router row comes first in id and in time.
    const early = { ...output, id: transaction(1).id, date: new Date(input.date.getTime() - 50) };
    const late = { ...input, id: transaction(2).id };

    const { aggregates } = aggregate([late, early]);

    expect(aggregates.hourly.find((item) => item.swaps > 0)?.swapFees).toEqual({ USDC: 8 });
    expect(aggregates.activity.map((item) => item.user)).toEqual(['u1']);
  });

  it('keeps apart swaps of several wallets in one transaction and the same hash on two chains', () => {
    const chains = new Map([...CHAIN_MAP, [SCROLL_CHAIN, 'scroll' as const]]);
    const rows = [
      ...swapLegs(1, { hash: '0xbundle', user: '0xUser1' }),
      ...swapLegs(3, { hash: '0xbundle', user: '0xUser2', at: '2026-10-12T11:05:00.000Z' }),
      ...swapLegs(5, { hash: '0xbundle', chainId: SCROLL_CHAIN, at: '2026-10-13T08:00:00.000Z' })
    ];

    const { stats, aggregates } = aggregate(rows, { chains });

    expect(stats).toMatchObject({ swaps: 3, unverifiedSwaps: 0 });
    const withSwaps = aggregates.hourly.filter((item) => item.swaps > 0);
    expect(withSwaps.map((item) => [item.network, item.swaps])).toEqual([
      ['base-sepolia', 2],
      ['scroll', 1]
    ]);
  });

  it('does not pair rows without hash', () => {
    const { stats } = aggregate(swapLegs(1, { hash: '' }));

    expect(stats).toMatchObject({ swaps: 0, unverifiedSwaps: 2 });
  });

  it('builds the same aggregates from the rows in any order', () => {
    const rows = [
      ...swapLegs(1, { hash: '0xa' }),
      ...swapLegs(3, { hash: '0xb', user: '0xUser2', status: ['completed', 'pending'] }),
      ...swapLegs(5, { hash: '0xc', at: '2026-10-14T09:00:00.000Z' }),
      transaction(7, { token: 'USDT', amount: 5 }),
      transaction(8, { token: 'WBTC', amount: 0.001 })
    ];

    expect(aggregate([...rows].reverse())).toEqual(aggregate(rows));
  });
});

describe('re-ingestion', () => {
  const OPTIONS: IngestionOptions = {
    batchSize: 2,
    maxTransactionsPerRun: 1000,
    revisitHours: 72,
    maxProviderCallsPerRun: 0,
    maxBalanceCallsPerRun: 0,
    maxRunMs: 60_000,
    lockTtlMs: 120_000
  };

  it('rebuilds the same aggregates when the same rows are copied again', async () => {
    const rows = [
      ...swapLegs(1, { hash: '0xa', at: '2026-10-23T11:00:00.000Z' }),
      ...swapLegs(3, {
        hash: '0xb',
        at: '2026-10-23T12:00:00.000Z',
        status: ['completed', 'pending']
      }),
      transaction(5, { date: new Date('2026-10-23T13:00:00.000Z') })
    ];
    const reader = new FakeReader(rows, USERS);
    const repository = new MemoryIngestRepository();
    const ingest = (at: Date) =>
      runIngestion({
        reader,
        repository,
        prices: null,
        balances: null,
        masterWallets: [],
        clock: () => at,
        options: OPTIONS,
        owner: 'test-run'
      });

    await ingest(new Date('2026-10-24T03:00:00.000Z'));
    const first = repository.stored;
    // The revisit window reads the recent rows again; nothing changed in B2C.
    await ingest(new Date('2026-10-24T04:00:00.000Z'));

    expect(repository.stored?.hourly).toEqual(first?.hourly);
    expect(repository.stored?.activity).toEqual(first?.activity);
    expect(repository.stored?.signups).toEqual(first?.signups);
  });
});

describe('operations without USD value', () => {
  it('answers the money tiles as a partial subtotal when some operations have no price', () => {
    install([
      transaction(1, { token: 'USDC', amount: 10, fee: 0.1, date: new Date('2026-10-20T10:00Z') }),
      transaction(2, { token: 'WBTC', amount: 0.001, fee: 0, date: new Date('2026-10-20T11:00Z') })
    ]);

    const overview = buildOverview('all', 'month', NOW);

    expect(overview.tiles.volumeUsd).toMatchObject({
      value: '10.00',
      availability: 'partial',
      reason: 'unpriced_assets'
    });
    // The WBTC fee is zero: measured, so the fees are complete.
    expect(overview.tiles.feesUsd).toMatchObject({ value: '0.10', availability: 'available' });
    expect(overview.tiles.transactions.value).toBe(2);
    expect(overview.valuation).toMatchObject({
      availability: 'partial',
      operations: 2,
      unpricedVolume: 1,
      unpricedFees: 0,
      unpricedAssets: [
        { network: 'base-sepolia', asset: 'WBTC', unpricedVolume: 1, unpricedFees: 0 }
      ]
    });
  });

  it('answers unavailable with no value when no operation has a price', () => {
    install([transaction(1, { token: 'WBTC', amount: 0.001, fee: 0.00001 })], {
      prices: [{ symbol: 'WBTC', day: '2026-10-12', usd: 0, source: 'provider' }]
    });

    const revenue = buildRevenue('all', 'month', new Date('2026-10-13T00:00:00.000Z'));

    // A price of zero is no price.
    expect(revenue.tiles.volumeUsd).toMatchObject({
      value: null,
      changeRatio: null,
      availability: 'unavailable',
      reason: 'unpriced_assets'
    });
    expect(revenue.tiles.feesUsd.value).toBeNull();
    expect(revenue.byAsset).toEqual([
      { network: 'base-sepolia', asset: 'WBTC', volumeUsd: null, feesUsd: null }
    ]);
  });

  it('values a stable token without any price and keeps its figures complete', () => {
    install([transaction(1, { token: 'usdt', amount: 4, fee: 0.04 })]);

    const overview = buildOverview('all', 'month', new Date('2026-10-13T00:00:00.000Z'));

    expect(overview.tiles.volumeUsd).toMatchObject({ value: '4.00', availability: 'available' });
    expect(overview.valuation.unpricedAssets).toEqual([]);
  });

  it('leaves out an unpriced fee while the amount has a value', () => {
    // WBTC -> USDC without input amount: the swap gives no WBTC price for the fee.
    const rows = swapLegs(1, {
      hash: '0xswap',
      sell: ['WBTC', 0, 0.00001],
      buy: ['USDC', 5]
    });
    const { stats, aggregates } = aggregate(rows);

    expect(stats).toMatchObject({ swaps: 1, unpriced: 0, unpricedFees: 1 });
    const hour = aggregates.hourly.find((item) => item.swaps > 0);
    expect(hour?.swapVolume).toEqual({ WBTC: 500 });
    expect(hour?.swapFees).toEqual({});
    expect(hour?.unpriced?.swapFees).toEqual({ WBTC: 1 });
  });

  it('gives no previous value nor change when the previous period was not fully valued', () => {
    install([
      transaction(1, { token: 'WBTC', amount: 0.001, fee: 0, date: new Date('2026-10-05T10:00Z') }),
      transaction(2, { token: 'USDC', amount: 10, fee: 0, date: new Date('2026-10-12T10:00Z') })
    ]);

    const tile = buildOverview('all', 'week', new Date('2026-10-13T00:00:00.000Z')).tiles.volumeUsd;

    expect(tile).toMatchObject({ value: '10.00', availability: 'available', previous: null });
    expect(tile.changeRatio).toBeNull();
  });
});

describe('price identity', () => {
  // Prices are keyed by symbol and day, without network: these tests pin that identity, so a
  // change to it is deliberate. Within one deployment a symbol stands for one asset.
  it('values a symbol on one network with the price a swap implied on another network', () => {
    const chains = new Map<string, NetworkId>([...CHAIN_MAP, [SCROLL_CHAIN, 'scroll']]);
    const rows = [
      // 10 USDC for 0.004 WETH on Base Sepolia implies 2500 USD per WETH that day.
      ...swapLegs(1, { hash: '0xswap', at: '2026-10-12T11:05:00.000Z' }),
      transaction(3, {
        token: 'WETH',
        amount: 1,
        fee: 0,
        chainId: SCROLL_CHAIN,
        date: new Date('2026-10-12T12:00:00.000Z')
      })
    ];

    const { aggregates } = aggregate(rows, { chains });

    const scroll = aggregates.hourly.find((item) => item.network === 'scroll');
    expect(scroll?.transferVolume).toEqual({ WETH: 250_000 });
  });

  it('values the same symbol on two networks of a snapshot with one price', async () => {
    const { takeBalanceSnapshot } = await import('../src/ingest/snapshot.js');
    const scrollWeth = '0x5555555555555555555555555555555555555555';
    const reader = new FakeBalanceReader({
      [`0xuser1|${TOKEN_ADDRESSES.WETH}`]: 1_000_000_000_000_000_000n,
      [`0xscroll1|${scrollWeth}`]: 1_000_000_000_000_000_000n
    });

    const { snapshot } = await takeBalanceSnapshot({
      reader,
      endpoints: [
        ...ENDPOINTS.slice(0, 1),
        { chainId: SCROLL_CHAIN, family: 'evm', url: 'https://rpc.scroll.test' }
      ],
      chains: [
        ...CHAINS.slice(0, 1),
        {
          chainId: SCROLL_CHAIN,
          network: 'scroll',
          name: 'Scroll',
          family: 'evm',
          explorer: 'https://scrollscan.com',
          contracts: {}
        }
      ],
      tokens: [
        ...TOKENS,
        { chainId: SCROLL_CHAIN, symbol: 'WETH', stable: false, address: scrollWeth, decimals: 18 }
      ],
      users: [
        ...USERS,
        { id: 'u3', createdAt: null, wallets: [{ chainId: SCROLL_CHAIN, address: '0xScroll1' }] }
      ],
      masterWallets: [],
      prices: new Map([['WETH', 3000]]),
      b2cEnabled: new Map([
        ['84532', true],
        [SCROLL_CHAIN, true]
      ]),
      budget: { remaining: 10, deadline: Number.MAX_SAFE_INTEGER, used: 0, failed: 0 },
      takenAt: NOW
    });

    expect(snapshot.holdings).toEqual([
      { network: 'base-sepolia', asset: 'WETH', amount: '1.0', valueCents: 300_000 },
      { network: 'scroll', asset: 'WETH', amount: '1.0', valueCents: 300_000 }
    ]);
  });
});

describe('USD valuation of a deployment', () => {
  const rows = [transaction(1, { token: 'WBTC', amount: 1, fee: 0.0001 })];
  const prices: DailyPrice[] = [
    { symbol: 'WBTC', day: '2026-10-12', usd: 100_000, source: 'provider' }
  ];
  const holdingsSnapshot = (valuation: UsdValuation): RunSnapshot => ({
    takenAt: new Date('2026-10-24T03:00:00.000Z'),
    balances: {
      networks: [
        {
          network: 'base-sepolia',
          status: 'complete',
          wallets: 2,
          walletsRead: 2,
          native: 'included'
        }
      ],
      holdings: [
        {
          network: 'base-sepolia',
          asset: 'WBTC',
          amount: '8320.0',
          valueCents: valuation === 'none' ? null : 83_200_000_000
        }
      ],
      masterWallets: [],
      valuation
    },
    countries: []
  });

  it('values nothing under `none`: no testnet balance becomes market dollars', () => {
    install(rows, { prices, valuation: 'none', snapshots: [holdingsSnapshot('none')] });

    const overview = buildOverview('all', 'month', NOW);

    expect(overview.meta.ingest?.valuation).toBe('none');
    expect(overview.tiles.volumeUsd).toMatchObject({
      value: null,
      availability: 'unavailable',
      reason: 'not_valued'
    });
    expect(overview.tvl).toMatchObject({
      value: null,
      availability: 'unavailable',
      reason: 'not_valued'
    });
    expect(overview.topTokens).toMatchObject({ totalUsd: null, reason: 'not_valued' });
    expect(overview.topTokens.items.map((item) => item.amount)).toEqual(['8320.0']);
    expect(overview.tiles.transactions.value).toBe(1);
    // A point with operations and no value is null; a point without operations is a measured zero.
    expect(overview.byNetwork.map((item) => [item.network, item.volumeUsd])).toEqual([
      ['base-sepolia', null],
      ['cardano-preprod', '0.00']
    ]);
    const points = overview.series.filter((point) => point.transactions > 0);
    expect(points.map((point) => point.volumeUsd)).toEqual([null]);
    expect(overview.series.some((point) => point.volumeUsd === '0.00')).toBe(true);
    const revenue = buildRevenue('all', 'month', NOW);
    expect(revenue.byNetwork[0]).toMatchObject({ feesUsd: null, volumeUsd: null });
  });

  it('keeps the market valuation of the other deployments', () => {
    install(rows, { prices, snapshots: [holdingsSnapshot('market')] });

    const overview = buildOverview('base-sepolia', 'month', NOW);

    expect(overview.tiles.volumeUsd).toMatchObject({
      value: '100000.00',
      availability: 'available'
    });
    expect(overview.tvl).toMatchObject({
      availability: 'available',
      value: { value: '832000000.00' }
    });
  });

  it('reads the valuation from the environment, market by default', () => {
    expect(loadEnv({ NODE_ENV: 'test' }).USD_VALUATION).toBe('market');
    expect(loadEnv({ NODE_ENV: 'test', USD_VALUATION: 'none' }).USD_VALUATION).toBe('none');
    expect(() => loadEnv({ NODE_ENV: 'test', USD_VALUATION: 'testnet' })).toThrowError();
  });
});

describe('native coin coverage of the TVL', () => {
  function snapshotWith(networks: SnapshotNetwork[]): RunSnapshot {
    return {
      takenAt: new Date('2026-10-24T03:00:00.000Z'),
      balances: {
        networks,
        holdings: [{ network: 'base-sepolia', asset: 'USDC', amount: '10.0', valueCents: 1000 }],
        masterWallets: []
      },
      countries: []
    };
  }
  const base = (native?: SnapshotNetwork['native']): SnapshotNetwork => ({
    network: 'base-sepolia',
    status: 'complete',
    wallets: 2,
    walletsRead: 2,
    ...(native === undefined ? {} : { native })
  });

  it('answers a subtotal when the catalog lists no native coin for a read network', () => {
    install([], { snapshots: [snapshotWith([base('not_listed')])] });

    const tvl = buildOverview('base-sepolia', 'month', NOW).tvl;

    expect(tvl).toMatchObject({
      availability: 'partial',
      reason: 'native_not_covered',
      value: { value: '10.00' }
    });
    expect(tvl.coverage?.nativeNotCovered).toEqual(['base-sepolia']);
  });

  it('treats an EVM snapshot taken before the coverage was recorded as not covered', () => {
    install([], { snapshots: [snapshotWith([base()])] });

    expect(buildOverview('base-sepolia', 'month', NOW).tvl).toMatchObject({
      availability: 'partial',
      reason: 'native_not_covered'
    });
  });

  it('answers available when the native coin was read, even at zero', () => {
    install([], { snapshots: [snapshotWith([base('included')])] });

    expect(buildOverview('base-sepolia', 'month', NOW).tvl).toMatchObject({
      availability: 'available',
      reason: null
    });
  });

  it('reports a network not read as not read, not as a missing native coin', () => {
    install([], {
      snapshots: [
        snapshotWith([
          {
            network: 'base-sepolia',
            status: 'unsupported',
            wallets: 2,
            walletsRead: 0,
            reason: 'b2c_disabled',
            native: 'not_listed'
          }
        ])
      ]
    });

    const tvl = buildOverview('base-sepolia', 'month', NOW).tvl;

    expect(tvl).toMatchObject({ availability: 'unavailable', reason: 'not_read' });
    expect(tvl.coverage?.nativeNotCovered).toEqual([]);
  });

  it('reads the native coin of a user wallet that is also a master wallet once per role', async () => {
    const { takeBalanceSnapshot } = await import('../src/ingest/snapshot.js');
    const reader = new FakeBalanceReader({
      [`0xuser1|${TOKEN_ADDRESSES.USDC}`]: 1_000_000n,
      '0xuser1|native': 1_000_000_000_000_000_000n
    });

    const { snapshot } = await takeBalanceSnapshot({
      reader,
      endpoints: ENDPOINTS.slice(0, 1),
      chains: CHAINS.slice(0, 1),
      tokens: [
        ...TOKENS,
        {
          chainId: '84532',
          symbol: 'ETH',
          stable: false,
          address: '0x0000000000000000000000000000000000000000',
          decimals: 18
        }
      ],
      users: USERS,
      masterWallets: [{ network: 'base-sepolia', address: '0xUser1', role: 'Backend signer' }],
      prices: new Map([['ETH', 3000]]),
      b2cEnabled: new Map([['84532', true]]),
      budget: { remaining: 10, deadline: Number.MAX_SAFE_INTEGER, used: 0, failed: 0 },
      takenAt: NOW
    });

    expect(snapshot.holdings).toEqual([
      { network: 'base-sepolia', asset: 'USDC', amount: '1.0', valueCents: 100 },
      { network: 'base-sepolia', asset: 'ETH', amount: '1.0', valueCents: 300_000 }
    ]);
    expect(snapshot.masterWallets[0]?.balances).toEqual([
      { asset: 'USDC', amount: '1.0', valueCents: 100 },
      { asset: 'ETH', amount: '1.0', valueCents: 300_000 }
    ]);
  });

  describe('named by a master wallet when the B2C list lacks it', () => {
    const SIGNER = '0x9999999999999999999999999999999999999999';

    async function snapshotOf(
      reader: FakeBalanceReader,
      overrides: { signer?: string; enabled?: boolean; named?: boolean } = {}
    ) {
      const { takeBalanceSnapshot } = await import('../src/ingest/snapshot.js');
      const budget = { remaining: 10, deadline: Number.MAX_SAFE_INTEGER, used: 0, failed: 0 };
      const result = await takeBalanceSnapshot({
        reader,
        endpoints: ENDPOINTS.slice(0, 1),
        chains: CHAINS.slice(0, 1),
        tokens: TOKENS,
        users: USERS,
        masterWallets: [
          {
            network: 'base-sepolia',
            address: overrides.signer ?? SIGNER,
            role: 'Backend signer',
            ...(overrides.named === false ? {} : { nativeSymbol: 'ETH' })
          }
        ],
        prices: new Map([['ETH', 3000]]),
        b2cEnabled: new Map([['84532', overrides.enabled ?? true]]),
        budget,
        takenAt: NOW
      });
      return { ...result, budget };
    }

    it('reads the native coin of every user wallet and values it at the price of the day', async () => {
      const reader = new FakeBalanceReader({
        [`0xuser1|${TOKEN_ADDRESSES.USDC}`]: 1_000_000n,
        '0xuser1|native': 500_000_000_000_000_000n,
        [`${SIGNER}|native`]: 2_000_000_000_000_000_000n
      });

      const { snapshot, networks, budget } = await snapshotOf(reader);

      expect(networks[0]).toMatchObject({ status: 'complete', native: 'included', calls: 1 });
      expect(budget.used).toBe(1);
      expect(snapshot.holdings).toEqual([
        { network: 'base-sepolia', asset: 'USDC', amount: '1.0', valueCents: 100 },
        { network: 'base-sepolia', asset: 'ETH', amount: '0.5', valueCents: 150_000 }
      ]);
      expect(snapshot.masterWallets[0]?.balances).toEqual([
        { asset: 'ETH', amount: '2.0', valueCents: 600_000 }
      ]);
    });

    it('reports the native coin as included at zero and answers the TVL available', async () => {
      const reader = new FakeBalanceReader({ [`0xuser1|${TOKEN_ADDRESSES.USDC}`]: 1_000_000n });

      const { snapshot, networks } = await snapshotOf(reader);
      install([], {
        snapshots: [
          { takenAt: new Date('2026-10-24T03:00:00.000Z'), balances: snapshot, countries: [] }
        ]
      });

      expect(networks[0]).toMatchObject({ native: 'included' });
      expect(snapshot.holdings.map((holding) => holding.asset)).toEqual(['USDC']);
      expect(buildOverview('base-sepolia', 'month', NOW).tvl).toMatchObject({
        availability: 'available',
        value: { value: '1.00' },
        coverage: { nativeNotCovered: [] }
      });
    });

    it('reads a master wallet that is also a user wallet once, native coin included', async () => {
      const reader = new FakeBalanceReader({
        '0xuser1|native': 1_000_000_000_000_000_000n
      });
      const queried: string[] = [];
      const evm = reader.evm.bind(reader);
      reader.evm = async (url, queries, budget) => {
        queried.push(...queries.map((query) => `${query.holder}|${query.token ?? 'native'}`));
        return evm(url, queries, budget);
      };

      const { snapshot } = await snapshotOf(reader, { signer: '0xUser1' });

      expect(queried.filter((key) => key === '0xuser1|native')).toHaveLength(1);
      expect(new Set(queried).size).toBe(queried.length);
      expect(snapshot.holdings).toContainEqual({
        network: 'base-sepolia',
        asset: 'ETH',
        amount: '1.0',
        valueCents: 300_000
      });
      expect(snapshot.masterWallets[0]?.balances).toEqual([
        { asset: 'ETH', amount: '1.0', valueCents: 300_000 }
      ]);
    });

    it('leaves a wallet whose request failed out of the totals and the coverage', async () => {
      const reader = new FakeBalanceReader(
        { '0xuser1|native': 1_000_000_000_000_000_000n },
        {},
        new Set(['0xuser2'])
      );

      const { snapshot, networks } = await snapshotOf(reader);

      expect(networks[0]).toMatchObject({
        status: 'partial',
        wallets: 2,
        walletsRead: 1,
        reason: 'read_incomplete',
        native: 'included'
      });
      expect(snapshot.holdings).toEqual([
        { network: 'base-sepolia', asset: 'ETH', amount: '1.0', valueCents: 300_000 }
      ]);
    });

    it('reads the network, native coin included, once B2C disables it', async () => {
      const reader = new FakeBalanceReader({ '0xuser1|native': 1_000_000_000_000_000_000n });

      const { snapshot, networks, budget } = await snapshotOf(reader, { enabled: false });

      expect(reader.requests).toBe(1);
      expect(budget.used).toBe(1);
      expect(networks[0]).toMatchObject({
        status: 'complete',
        calls: 1,
        b2cEnabled: false,
        reason: null,
        native: 'included'
      });
      expect(snapshot.holdings).toEqual([
        { network: 'base-sepolia', asset: 'ETH', amount: '1.0', valueCents: 300_000 }
      ]);
    });

    it('reads no native coin of the user wallets when the master wallet states no symbol', async () => {
      const reader = new FakeBalanceReader({
        '0xuser1|native': 1_000_000_000_000_000_000n,
        [`${SIGNER}|native`]: 2_000_000_000_000_000_000n
      });
      const queried: string[] = [];
      const evm = reader.evm.bind(reader);
      reader.evm = async (url, queries, budget) => {
        queried.push(...queries.map((query) => `${query.holder}|${query.token ?? 'native'}`));
        return evm(url, queries, budget);
      };

      const { snapshot, networks } = await snapshotOf(reader, { named: false });

      // An EVM network is not assumed to use ETH: the users are read without a native coin.
      expect(networks[0]).toMatchObject({ status: 'complete', native: 'not_listed' });
      expect(queried).not.toContain('0xuser1|native');
      expect(snapshot.holdings.some((holding) => holding.asset === 'ETH')).toBe(false);
      // The master wallet keeps its own balance, under the default symbol of its configuration.
      expect(snapshot.masterWallets[0]?.balances).toEqual([
        { asset: 'ETH', amount: '2.0', valueCents: 600_000 }
      ]);
    });
  });
});

describe('TVL series', () => {
  it('gives a bucket whose held assets all lack a price no value instead of zero', () => {
    const network: SnapshotNetwork = {
      network: 'base-sepolia',
      status: 'complete',
      wallets: 1,
      walletsRead: 1,
      native: 'included'
    };
    install([], {
      snapshots: [
        {
          takenAt: new Date('2026-10-22T03:00:00.000Z'),
          balances: {
            networks: [network],
            holdings: [{ network: 'base-sepolia', asset: 'WETH', amount: '1.0', valueCents: null }],
            masterWallets: []
          },
          countries: []
        },
        {
          takenAt: new Date('2026-10-24T03:00:00.000Z'),
          balances: {
            networks: [network],
            holdings: [{ network: 'base-sepolia', asset: 'USDC', amount: '5.0', valueCents: 500 }],
            masterWallets: []
          },
          countries: []
        }
      ]
    });

    const series = buildOverview('base-sepolia', 'week', NOW).tvl.series;

    expect(series.filter((point) => point.asOf !== null).map((point) => point.tvlUsd)).toEqual([
      null,
      '5.00'
    ]);
  });
});

describe('users without signup date', () => {
  const undated: IngestedUser[] = [
    ...USERS,
    { id: 'u3', createdAt: null, wallets: [{ chainId: '84532', address: '0xUser3' }] }
  ];

  it('counts them in the total, in no signup window, and marks the signup figures partial', () => {
    install([], { users: undated });

    const users = buildUsers('all', 'monthly', NOW);

    expect(users.tiles.totalUsers.value).toBe(3);
    expect(users.signups).toMatchObject({
      availability: 'partial',
      reason: 'undated_users',
      users: 3,
      undatedUsers: 1
    });
    expect(aggregate([], { users: undated }).stats.undatedUsers).toBe(1);
  });

  it('marks the signup figures available when every user has a date', () => {
    install([]);

    expect(buildUsers('all', 'monthly', NOW).signups).toMatchObject({
      availability: 'available',
      reason: null,
      undatedUsers: 0
    });
  });
});

describe('ingestion run event', () => {
  it('carries counters, statuses and durations, and no address, URL or phone', async () => {
    const reader = new FakeReader(
      [transaction(1, { date: new Date('2026-10-23T10:00:00.000Z') })],
      USERS
    );
    const repository = new MemoryIngestRepository();
    const report = await runIngestion({
      reader,
      repository,
      prices: null,
      balances: new FakeBalanceReader({ [`0xuser1|${TOKEN_ADDRESSES.USDC}`]: 1_000_000n }),
      masterWallets: [{ network: 'base-sepolia', address: '0xMaster', role: 'Backend signer' }],
      clock: () => new Date('2026-10-24T03:00:00.000Z'),
      options: {
        batchSize: 10,
        maxTransactionsPerRun: 100,
        revisitHours: 0,
        maxProviderCallsPerRun: 0,
        maxBalanceCallsPerRun: 10,
        maxRunMs: 60_000,
        lockTtlMs: 120_000
      },
      owner: 'test-run'
    });
    await refreshLiveMetrics(repository, null);

    const event = ingestRunEvent(report, 7);
    const text = JSON.stringify(event);

    expect(event).toMatchObject({
      event: 'ingest_run',
      runId: report.runId,
      status: 'completed',
      valuation: 'market',
      error: null
    });
    expect(Object.keys(event.phasesMs ?? {}).sort()).toEqual([
      'aggregateRebuild',
      'catalogUsers',
      'copyTransactions',
      'persist',
      'prices',
      'readback',
      'revisit',
      'snapshot'
    ]);
    expect(event.phasesMs?.readback).toBe(7);
    expect(event.balances?.networks.map((row) => [row.network, row.status])).toContainEqual([
      'base-sepolia',
      'complete'
    ]);
    expect(text).not.toMatch(/0x|addr_|https?:|rpc|\+549/i);
  });

  it('reports each network with its policy, read and coverage, and no endpoint or address', async () => {
    const at = new Date('2026-10-24T03:00:00.000Z');
    const users: IngestedUser[] = [
      ...USERS,
      {
        id: 'u3',
        createdAt: null,
        wallets: [{ chainId: '900000000001', address: 'addr_test1qpuserwallet' }]
      }
    ];
    const repository = new MemoryIngestRepository();
    repository.settings = { hiddenChainIds: ['84532'], uncollectedChainIds: ['900000000001'] };
    const report = await runIngestion({
      reader: new FakeReader([], users),
      repository,
      prices: null,
      // The Base Sepolia node answers nothing.
      balances: new RecordingBalanceReader(new Set([ENDPOINTS[0]?.url ?? ''])),
      masterWallets: [],
      clock: () => at,
      options: {
        batchSize: 10,
        maxTransactionsPerRun: 100,
        revisitHours: 0,
        maxProviderCallsPerRun: 0,
        maxBalanceCallsPerRun: 10,
        maxRunMs: 60_000,
        lockTtlMs: 120_000
      },
      owner: 'test-run'
    });

    const event = ingestRunEvent(report, null);
    const shared = {
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      durationMs: 0,
      takenAt: at.toISOString(),
      lastSuccessAt: null,
      unpricedAssets: 0
    };

    expect(event.status).toBe('completed');
    expect(event.balances).toMatchObject({ status: 'failed', calls: 1, failedCalls: 1 });
    expect(event.balances?.networks).toEqual([
      {
        network: 'base-sepolia',
        chainId: '84532',
        status: 'failed',
        reason: 'rpc_failed',
        b2cEnabled: true,
        analyticsVisible: false,
        collectBalances: true,
        endpointPresent: true,
        attempted: true,
        wallets: 2,
        walletsRead: 0,
        calls: 1,
        failedCalls: 1,
        native: 'not_listed',
        ...shared
      },
      {
        network: 'cardano-preprod',
        chainId: '900000000001',
        status: 'unsupported',
        reason: 'collection_off',
        b2cEnabled: true,
        analyticsVisible: true,
        collectBalances: false,
        endpointPresent: true,
        attempted: false,
        wallets: 1,
        walletsRead: 0,
        calls: 0,
        failedCalls: 0,
        native: 'included',
        ...shared
      }
    ]);
    expect(JSON.stringify(event)).not.toMatch(/0x|addr_|https?:|key-in-path|koios|\+549/i);
  });

  it('records only the class of the error of a failed run', () => {
    const event = failedRunEvent(
      'run-1',
      new Date('2026-10-24T03:00:00.000Z'),
      5,
      new TypeError('fetch failed for https://rpc.example/key-in-path')
    );

    expect(event).toMatchObject({ status: 'failed', error: 'TypeError', durationMs: 5 });
    expect(JSON.stringify(event)).not.toMatch(/https?:|key-in-path/);
  });
});
