import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IngestedUser } from '../src/ingest/types.js';
import { dayNumberFromIso, dayWindow } from '../src/metrics/calendar.js';
import { aggregateActivity, liveSourceFrom } from '../src/metrics/live.js';
import { buildOverview } from '../src/metrics/overview.js';
import { impliedSwapPrices, PriceBook } from '../src/metrics/pricing.js';
import { setLiveSource } from '../src/metrics/sources.js';
import { buildUsers } from '../src/metrics/users.js';
import { CHAINS, TOKENS, transaction } from './ingest-fakes.js';

const CHAIN_MAP = new Map(CHAINS.map((chain) => [chain.chainId, chain.network]));
const DAY = dayNumberFromIso('2026-10-12');
const ROUTER = '0xRouter';

const USERS: IngestedUser[] = [
  {
    id: 'u1',
    createdAt: new Date('2026-09-15T08:30:00.000Z'),
    wallets: [
      { chainId: '84532', address: '0xuser1' },
      { chainId: '900000000001', address: 'addr_test1u1' }
    ]
  },
  {
    id: 'u2',
    createdAt: new Date('2026-10-12T09:10:00.000Z'),
    wallets: [{ chainId: '84532', address: '0xUser2' }]
  },
  { id: 'u3', createdAt: null, wallets: [{ chainId: '84532', address: '0xUser3' }] }
];

const ROWS = [
  // Transfer with the symbol in lower case, as some rows store it.
  transaction(1, { token: 'usdt', amount: 100, fee: 0.080082 }),
  // WETH -> USDT swap: two rows with the same hash; the stable leg gives the value.
  transaction(2, {
    type: 'swap',
    hash: '0xswapA',
    from: '0xUser1',
    to: ROUTER,
    token: 'WETH',
    amount: 0.001,
    fee: 0.00003,
    date: new Date('2026-10-12T10:20:00.000Z')
  }),
  transaction(3, {
    type: 'swap',
    hash: '0xswapA',
    from: ROUTER,
    to: '0xUser1',
    token: 'USDT',
    amount: 2.5,
    fee: 0,
    date: new Date('2026-10-12T10:20:00.020Z')
  }),
  // USDC -> WETH swap by another user, an hour later.
  transaction(4, {
    type: 'swap',
    hash: '0xswapB',
    from: '0xuser2',
    to: ROUTER,
    token: 'USDC',
    amount: 10,
    fee: 0.08,
    date: new Date('2026-10-12T11:05:00.000Z')
  }),
  transaction(5, {
    type: 'swap',
    hash: '0xswapB',
    from: ROUTER,
    to: '0xuser2',
    token: 'WETH',
    amount: 0.004,
    fee: 0,
    date: new Date('2026-10-12T11:05:00.010Z')
  }),
  // WETH transfer valued at the price implied by the swaps of the day.
  transaction(6, {
    token: 'WETH',
    amount: 0.002,
    fee: 0.0001,
    from: '0xUser2',
    date: new Date('2026-10-12T12:00:00.000Z')
  }),
  // Not counted: failed, deposit, chain outside the catalog.
  transaction(7, { status: 'failed' }),
  transaction(8, { type: 'deposit', fee: 0 }),
  transaction(9, { chainId: '137' }),
  // Sender that is not a known user still counts as an active address.
  transaction(10, { from: '0xStranger', amount: 5, date: new Date('2026-10-13T00:30:00.000Z') })
];

function build() {
  return aggregateActivity({
    transactions: ROWS,
    users: USERS,
    tokens: TOKENS,
    chains: CHAIN_MAP,
    prices: []
  });
}

describe('PriceBook', () => {
  it('prefers provider prices and falls back to the closest earlier, then later, day', () => {
    const book = new PriceBook([
      { symbol: 'WETH', day: '2026-10-10', usd: 2000, source: 'swap' },
      { symbol: 'WETH', day: '2026-10-10', usd: 2100, source: 'provider' },
      { symbol: 'WETH', day: '2026-10-20', usd: 3000, source: 'swap' }
    ]);

    expect(book.usd('WETH', dayNumberFromIso('2026-10-10'))).toBe(2100);
    expect(book.usd('WETH', dayNumberFromIso('2026-10-15'))).toBe(2100);
    expect(book.usd('WETH', dayNumberFromIso('2026-10-25'))).toBe(3000);
    expect(book.usd('WETH', dayNumberFromIso('2026-10-01'))).toBe(2100);
    expect(book.usd('WBTC', DAY)).toBeNull();
  });

  it('weights implied prices by volume within a day', () => {
    expect(
      impliedSwapPrices([
        { day: '2026-10-12', symbol: 'WETH', amount: 1, stableAmount: 2000 },
        { day: '2026-10-12', symbol: 'WETH', amount: 3, stableAmount: 7000 }
      ])
    ).toEqual([{ symbol: 'WETH', day: '2026-10-12', usd: 2250, source: 'swap' }]);
  });
});

describe('aggregateActivity', () => {
  it('counts completed transfers and one swap per hash, on catalog chains only', () => {
    const { stats } = build();

    expect(stats).toEqual({
      transfers: 3,
      swaps: 2,
      unpriced: 0,
      unpricedFees: 0,
      unverifiedSwaps: 0,
      outsideCatalog: 1,
      deposits: 0,
      unpricedDeposits: 0,
      users: 3,
      undatedUsers: 1,
      // Four wallets; the two that sent a completed operation have a verifiable first appearance.
      wallets: 4,
      verifiedWallets: 2
    });
  });

  it('values swaps on the stable leg and transfers with the implied price', () => {
    const source = liveSourceFrom(build().aggregates);
    const facts = source.facts('base-sepolia', dayWindow(DAY, DAY));

    expect(facts.transfers).toBe(2);
    expect(facts.swaps).toBe(2);
    expect(facts.transferVolume).toEqual({ USDT: 10_000, WETH: 500 });
    expect(facts.transferFees).toEqual({ USDT: 8, WETH: 25 });
    // WETH -> USDT: 2.50 USD, fee 0.00003 WETH at 2500 USD; USDC -> WETH: 10 USD, fee 0.08.
    expect(facts.swapVolume).toEqual({ WETH: 250, USDC: 1000 });
    expect(facts.swapFees).toEqual({ WETH: 8, USDC: 8 });
    expect(facts.newUsers).toBe(1);
  });

  it('counts the operations per asset, a swap under its input asset', () => {
    const source = liveSourceFrom(build().aggregates);
    const facts = source.facts('base-sepolia', dayWindow(DAY, DAY));

    expect(facts.transfersByAsset).toEqual({ USDT: 1, WETH: 1 });
    expect(facts.swapsByAsset).toEqual({ WETH: 1, USDC: 1 });
    expect(source.countsByAsset()).toBe(true);
  });

  it('cuts windows by hour', () => {
    const source = liveSourceFrom(build().aggregates);
    const tenOClock = { start: { day: DAY, hour: 10 }, end: { day: DAY, hour: 10 } };

    expect(source.facts('base-sepolia', tenOClock).transfers).toBe(1);
    expect(source.facts('base-sepolia', tenOClock).swaps).toBe(1);
    expect(source.facts('cardano-preprod', tenOClock).transfers).toBe(0);
  });

  it('counts distinct active users per window', () => {
    const source = liveSourceFrom(build().aggregates);

    expect(source.activeUsers('base-sepolia', dayWindow(DAY, DAY))).toBe(2);
    expect(source.activeUsers('base-sepolia', dayWindow(DAY, DAY + 1))).toBe(3);
    expect(source.activeUsers('cardano-preprod', dayWindow(DAY, DAY + 1))).toBe(0);
  });

  it('counts total users with undated users from the start', () => {
    const source = liveSourceFrom(build().aggregates);

    expect(source.totalUsersAt('base-sepolia', { day: DAY, hour: 8 })).toBe(2);
    expect(source.totalUsersAt('base-sepolia', { day: DAY, hour: 9 })).toBe(3);
    expect(source.totalUsersAt('cardano-preprod', { day: DAY, hour: 9 })).toBe(1);
  });

  it('retains a cohort by its activity in the following months', () => {
    const source = liveSourceFrom(build().aggregates);
    const september = dayNumberFromIso('2026-09-01');

    expect(source.retained('base-sepolia', september, 1, 2)).toEqual([1, 0]);
    expect(source.retained('cardano-preprod', september, 1, 1)).toEqual([0]);
  });

  it('counts operations without any price as unpriced and gives them no value', () => {
    const { aggregates, stats } = aggregateActivity({
      transactions: [transaction(1, { token: 'WBTC', amount: 0.001, fee: 0.00001 })],
      users: USERS,
      tokens: TOKENS,
      chains: CHAIN_MAP,
      prices: []
    });

    expect(stats.unpriced).toBe(1);
    expect(stats.unpricedFees).toBe(1);
    const hour = aggregates.hourly.find((item) => item.transfers > 0);
    expect(hour?.transferVolume).toEqual({});
    expect(hour?.transferFees).toEqual({});
    expect(hour?.unpriced).toEqual({
      transferVolume: { WBTC: 1 },
      swapVolume: {},
      transferFees: { WBTC: 1 },
      swapFees: {}
    });
  });

  it('uses provider prices when no swap implies one', () => {
    const { aggregates } = aggregateActivity({
      transactions: [transaction(1, { token: 'WBTC', amount: 0.001, fee: 0.00001 })],
      users: USERS,
      tokens: TOKENS,
      chains: CHAIN_MAP,
      prices: [{ symbol: 'WBTC', day: '2026-10-24', usd: 100_000, source: 'provider' }]
    });

    expect(aggregates.hourly.find((item) => item.transfers > 0)?.transferVolume).toEqual({
      WBTC: 10_000
    });
    expect(aggregates.hourly.find((item) => item.transfers > 0)?.transferFees).toEqual({
      WBTC: 100
    });
  });

  it('gives the same aggregates for the same input', () => {
    expect(build().aggregates).toEqual(build().aggregates);
  });
});

describe('activity beyond sending', () => {
  const at = (hour: number) => new Date(`2026-10-14T${String(hour).padStart(2, '0')}:10:00.000Z`);
  const day = dayNumberFromIso('2026-10-14');

  function activeAt(rows: Parameters<typeof transaction>[1][]) {
    const source = liveSourceFrom(
      aggregateActivity({
        transactions: rows.map((fields, index) => transaction(100 + index, fields)),
        users: USERS,
        tokens: TOKENS,
        chains: CHAIN_MAP,
        prices: []
      }).aggregates
    );
    return source.activeUsers('base-sepolia', dayWindow(day, day));
  }

  it('makes the recipient of a completed transfer active, and not of a failed one', () => {
    expect(activeAt([{ from: '0xUser1', to: '0xUSER3', date: at(9) }])).toBe(2);
    expect(activeAt([{ from: '0xUser1', to: '0xUser3', status: 'failed', date: at(9) }])).toBe(0);
  });

  it('makes the recipient of a completed deposit active', () => {
    expect(activeAt([{ type: 'deposit', from: '0xOutside', to: '0xUser2', date: at(9) }])).toBe(1);
    expect(
      activeAt([
        { type: 'deposit', from: '0xOutside', to: '0xUser2', status: 'pending', date: at(9) }
      ])
    ).toBe(0);
  });

  it('makes a user active by an accepted Polymarket row on the network of the wallet it names', () => {
    const order = { type: 'polymarket_buy', from: '0xUser3', to: 'polymarket', chainId: '137' };
    expect(activeAt([{ ...order, date: at(9) }])).toBe(1);
    expect(activeAt([{ ...order, status: 'cancelled', date: at(9) }])).toBe(1);
    expect(
      activeAt([
        { type: 'polymarket_claim', from: 'polymarket', to: '0xUser2', chainId: '137', date: at(9) }
      ])
    ).toBe(1);
    for (const status of ['submitted', 'in_progress', 'failed']) {
      expect(activeAt([{ ...order, status, date: at(9) }])).toBe(0);
    }
  });
});

describe('external deposits', () => {
  const day = dayNumberFromIso('2026-10-14');
  const date = new Date('2026-10-14T09:00:00.000Z');

  function deposits(rows: Parameters<typeof transaction>[1][], prices = []) {
    const { aggregates, stats } = aggregateActivity({
      transactions: rows.map((fields, index) => transaction(200 + index, { date, ...fields })),
      users: USERS,
      tokens: TOKENS,
      chains: CHAIN_MAP,
      prices
    });
    return {
      stats,
      facts: liveSourceFrom(aggregates).facts('base-sepolia', dayWindow(day, day))
    };
  }

  it('values deposits from outside wallets apart from the volume', () => {
    const { facts, stats } = deposits([
      { type: 'deposit', from: '0xOutside', to: '0xUser2', token: 'USDC', amount: 50, fee: 0 },
      { type: 'deposit', from: '0xOutside', to: '0xUser1', token: 'WBTC', amount: 0.001, fee: 0 }
    ]);

    expect(facts.deposits).toEqual({
      volume: { USDC: 5000 },
      unpriced: { WBTC: 1 },
      count: { USDC: 1, WBTC: 1 }
    });
    expect(facts.transferVolume).toEqual({});
    expect(stats).toMatchObject({ deposits: 2, unpricedDeposits: 1 });
  });

  it('leaves out deposits sent by a user wallet, sharing a transfer hash or to a stranger', () => {
    const { facts, stats } = deposits([
      { type: 'deposit', from: '0xUser1', to: '0xUser2', fee: 0 },
      { hash: '0xshared', from: '0xUser1', to: '0xOther' },
      { type: 'deposit', hash: '0xSHARED', from: '0xOutside', to: '0xUser2', fee: 0 },
      { type: 'deposit', from: '0xOutside', to: '0xNobody', fee: 0 }
    ]);

    expect(facts.deposits?.count ?? {}).toEqual({});
    expect(stats.deposits).toBe(0);
  });

  it('has no deposits for a build stored before they were recorded', () => {
    const { aggregates } = aggregateActivity({
      transactions: [transaction(300, { date })],
      users: USERS,
      tokens: TOKENS,
      chains: CHAIN_MAP,
      prices: []
    });
    const older = {
      ...aggregates,
      hourly: aggregates.hourly.map(({ deposits: _omitted, ...hour }) => hour)
    };

    expect(
      liveSourceFrom(older).facts('base-sepolia', dayWindow(day, day)).deposits
    ).toBeUndefined();
    expect(
      liveSourceFrom(older).facts('base-sepolia', dayWindow(day + 5, day + 5)).deposits
    ).toBeUndefined();
  });
});

describe('users across networks', () => {
  const NETWORKS = ['base-sepolia', 'cardano-preprod'] as const;
  // u1 also sends on Cardano the same day it sends on Base.
  const CARDANO_TRANSFER = transaction(11, {
    chainId: '900000000001',
    from: 'addr_test1u1',
    token: 'USDCx',
    date: new Date('2026-10-12T14:00:00.000Z')
  });

  function source() {
    return liveSourceFrom(
      aggregateActivity({
        transactions: [...ROWS, CARDANO_TRANSFER],
        users: USERS,
        tokens: TOKENS,
        chains: CHAIN_MAP,
        prices: []
      }).aggregates
    );
  }

  it('counts a user active on two networks once in the union and once on each network', () => {
    const live = source();
    const day = dayWindow(DAY, DAY);

    expect(live.activeUsers('base-sepolia', day)).toBe(2);
    expect(live.activeUsers('cardano-preprod', day)).toBe(1);
    expect(live.activeUsersAcross(NETWORKS, day)).toBe(2);
    expect(live.activeUsersAcross(['cardano-preprod'], day)).toBe(1);
  });

  it('counts a user with wallets on two networks once in new and total users', () => {
    const live = source();
    const september = dayWindow(dayNumberFromIso('2026-09-01'), dayNumberFromIso('2026-09-30'));
    const nineOClock = { day: DAY, hour: 9 };

    expect(live.facts('base-sepolia', september).newUsers).toBe(1);
    expect(live.facts('cardano-preprod', september).newUsers).toBe(1);
    expect(live.newUsersAcross(NETWORKS, september)).toBe(1);
    expect(live.totalUsersAt('base-sepolia', nineOClock)).toBe(3);
    expect(live.totalUsersAt('cardano-preprod', nineOClock)).toBe(1);
    expect(live.totalUsersAcross(NETWORKS, nineOClock)).toBe(3);
    expect(live.totalUsersAcross(NETWORKS, { day: DAY, hour: 8 })).toBe(2);
  });

  it('builds a cohort of distinct users retained by activity on any network', () => {
    const live = source();
    const september = dayNumberFromIso('2026-09-01');

    expect(live.cohortAcross(NETWORKS, september, 2)).toEqual({ size: 1, retained: [1, 0] });
    expect(live.cohortAcross(['cardano-preprod'], september, 1)).toEqual({
      size: 1,
      retained: [1]
    });
  });

  describe('responses', () => {
    const NOW = new Date('2026-10-13T12:00:00.000Z');

    beforeAll(() => {
      setLiveSource(source(), NOW);
    });

    afterAll(() => {
      setLiveSource(null);
    });

    it('Users tiles and series count people once while byNetwork counts per network', () => {
      const users = buildUsers('all', 'monthly', NOW);

      expect(users.tiles.monthlyActiveUsers.value).toBe(3);
      expect(users.byNetwork.reduce((sum, item) => sum + item.activeUsers, 0)).toBe(4);
      expect(users.tiles.totalUsers.value).toBe(3);
      expect(users.byNetwork.reduce((sum, item) => sum + item.totalUsers, 0)).toBe(4);
      const october = users.series.find((point) => point.start === '2026-10-01T00:00:00.000Z');
      expect(october?.activeUsers).toBe(3);
      expect(october?.byNetwork.reduce((sum, item) => sum + item.activeUsers, 0)).toBe(4);
      const september = users.series.find((point) => point.start === '2026-09-01T00:00:00.000Z');
      expect(september?.newUsers).toBe(1);
      expect(september?.byNetwork.reduce((sum, item) => sum + item.newUsers, 0)).toBe(2);
      expect(users.retention.find((cohort) => cohort.cohort === '2026-09')).toEqual({
        cohort: '2026-09',
        size: 1,
        retained: []
      });
    });

    it('Overview user tiles count people once', () => {
      const overview = buildOverview('all', 'month', NOW);

      expect(overview.tiles.activeUsers.value).toBe(3);
      expect(overview.byNetwork.reduce((sum, item) => sum + item.activeUsers, 0)).toBe(4);
      expect(overview.tiles.newUsers.value).toBe(2);
      expect(overview.byNetwork.reduce((sum, item) => sum + item.newUsers, 0)).toBe(3);
    });

    it('a single network keeps its own counts', () => {
      const users = buildUsers('cardano-preprod', 'monthly', NOW);

      expect(users.tiles.monthlyActiveUsers.value).toBe(1);
      expect(users.tiles.totalUsers.value).toBe(1);
    });
  });
});
