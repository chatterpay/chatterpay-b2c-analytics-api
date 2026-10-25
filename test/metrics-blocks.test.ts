import { afterEach, describe, expect, it } from 'vitest';
import type { IngestedUser, RunSnapshot, WalletObservation } from '../src/ingest/types.js';
import { aggregateActivity, liveSourceFrom } from '../src/metrics/live.js';
import { buildOverview } from '../src/metrics/overview.js';
import { activityTotals, buildAverageFee } from '../src/metrics/products.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { liveSnapshots } from '../src/metrics/snapshot-source.js';
import { setLiveSource } from '../src/metrics/sources.js';
import type { IngestRunStatus } from '../src/metrics/types.js';
import { buildUsers } from '../src/metrics/users.js';
import { CHAINS, TOKENS, transaction } from './ingest-fakes.js';

const NOW = new Date('2026-10-24T15:30:00.000Z');
const CHAIN_MAP = new Map(CHAINS.map((chain) => [chain.chainId, chain.network]));

function cents(usd: string | null): number {
  const [whole = '0', fraction = '0'] = (usd ?? '0').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

describe('synthetic blocks', () => {
  it('TVL, top tokens and the network breakdown come from the same snapshot', () => {
    const { tvl, topTokens } = buildOverview('all', 'month', NOW);

    expect(tvl).toMatchObject({ source: 'mock', availability: 'available', asOf: null });
    expect(tvl.value).not.toBeNull();
    const total = cents(tvl.value?.value ?? null);
    expect(tvl.byNetwork.reduce((sum, item) => sum + cents(item.tvlUsd), 0)).toBe(total);
    expect(cents(topTokens.totalUsd)).toBe(total);
    expect(tvl.series.at(-1)?.tvlUsd).toBe(tvl.value?.value);
  });

  it('volume by product adds up to the volume tile without counting a swap twice', () => {
    const overview = buildOverview('all', 'month', NOW);
    const revenue = buildRevenue('all', 'month', NOW);
    const products = overview.volumeByProduct.items;

    const counted = products.filter((item) => item.product !== 'polymarket');
    expect(counted.reduce((sum, item) => sum + cents(item.volumeUsd), 0)).toBe(
      cents(overview.tiles.volumeUsd.value)
    );
    expect(counted.reduce((sum, item) => sum + (item.transactions ?? 0), 0)).toBe(
      overview.tiles.transactions.value
    );
    expect(products.find((item) => item.product === 'polymarket')).toMatchObject({
      availability: 'unavailable',
      reason: 'not_recorded',
      volumeUsd: null
    });
    expect(revenue.tiles.swapVolumeUsd.value).toBe(
      products.find((item) => item.product === 'swap')?.volumeUsd
    );
  });

  it('fees by product add up to the fee tile and the average fee divides it', () => {
    const revenue = buildRevenue('all', 'month', NOW);
    const fees = revenue.feesByProduct.items.filter((item) => item.product !== 'polymarket');

    expect(fees.reduce((sum, item) => sum + cents(item.feesUsd), 0)).toBe(
      cents(revenue.tiles.feesUsd.value)
    );
    expect(revenue.avgFeePerTransaction.availability).toBe('available');
    const average = Number(revenue.avgFeePerTransaction.valueUsd);
    const expected =
      cents(revenue.tiles.feesUsd.value) / 100 / revenue.avgFeePerTransaction.transactions;
    expect(Math.abs(average - expected)).toBeLessThan(0.0001);
    expect(revenue.polymarketVolume).toMatchObject({ availability: 'unavailable', valueUsd: null });
  });

  it('marks synthetic master wallets with addresses that are not real signers', () => {
    const { masterWallets } = buildRevenue('all', 'month', NOW);

    expect(masterWallets.items.length).toBeGreaterThan(0);
    for (const wallet of masterWallets.items) {
      expect(wallet.role).toBe('Synthetic signer');
      expect(wallet.explorerUrl).toBeNull();
    }
  });

  it('counts countries once per user with Unknown as a category', () => {
    const { topCountries } = buildOverview('all', 'month', NOW);

    expect(topCountries.method).toBe('phone_prefix');
    expect(topCountries.items.reduce((sum, item) => sum + item.users, 0)).toBe(
      topCountries.totalUsers
    );
    expect(topCountries.items.some((item) => item.country === 'Unknown')).toBe(true);
  });

  it('counts a cohort for month N only when it has N complete months', () => {
    const { retentionSummary } = buildUsers('all', 'monthly', NOW);

    expect(retentionSummary.cohorts).toHaveLength(12);
    expect(retentionSummary.months.map((month) => [month.month, month.eligibleCohorts])).toEqual([
      [1, 11],
      [3, 9],
      [6, 6]
    ]);
    const newest = retentionSummary.cohorts.at(-1);
    expect(newest?.retained.map((item) => item.users)).toEqual([null, null, null]);
    const second = retentionSummary.cohorts.at(-2);
    expect(second?.retained.map((item) => item.users === null)).toEqual([false, true, true]);
    const oldest = retentionSummary.cohorts[0];
    expect(oldest?.retained.every((item) => item.users !== null)).toBe(true);
    for (const month of retentionSummary.months) {
      expect(month.retainedUsers).toBeLessThanOrEqual(month.cohortUsers);
    }
  });

  it('new wallets have complete coverage in the synthetic model', () => {
    const { newWallets } = buildUsers('all', 'monthly', NOW);

    expect(newWallets).toMatchObject({
      source: 'mock',
      availability: 'available',
      definition: 'first_verifiable_appearance'
    });
    expect(newWallets.coverage.verifiedWallets).toBe(newWallets.coverage.wallets);
  });
});

describe('average fee', () => {
  it('is unavailable without operations', () => {
    const empty = activityTotals([]);

    expect(buildAverageFee(empty, null)).toMatchObject({
      availability: 'unavailable',
      reason: 'no_transactions',
      valueUsd: null,
      transactions: 0
    });
  });
});

describe('live blocks', () => {
  const RUN: IngestRunStatus = {
    status: 'completed',
    finishedAt: NOW.toISOString(),
    sources: { transactions: 'complete', prices: 'complete', balances: 'partial' }
  };
  const USERS: IngestedUser[] = [
    {
      id: 'u1',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      wallets: [{ chainId: '84532', address: '0xUser1' }]
    },
    {
      id: 'u2',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      wallets: [{ chainId: '84532', address: '0xUser2' }]
    }
  ];
  const ROWS = [transaction(1, { from: '0xUser1', date: new Date('2026-10-20T10:00:00.000Z') })];

  function snapshot(fields: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
      takenAt: new Date('2026-10-24T03:00:00.000Z'),
      balances: {
        networks: [
          { network: 'base-sepolia', status: 'complete', wallets: 2, walletsRead: 2 },
          { network: 'cardano-preprod', status: 'partial', wallets: 2, walletsRead: 1 }
        ],
        holdings: [
          { network: 'base-sepolia', asset: 'USDC', amount: '10.0', valueCents: 1000 },
          { network: 'cardano-preprod', asset: 'ADA', amount: '4.0', valueCents: 200 }
        ],
        masterWallets: []
      },
      countries: [
        { network: null, country: 'AR', users: 2 },
        { network: 'base-sepolia', country: 'AR', users: 2 }
      ],
      ...fields
    };
  }

  function install(
    snapshots: RunSnapshot[],
    observations: WalletObservation[] = [],
    run: IngestRunStatus = RUN
  ) {
    const { aggregates } = aggregateActivity({
      transactions: ROWS,
      users: USERS,
      tokens: TOKENS,
      chains: CHAIN_MAP,
      prices: [],
      observations
    });
    setLiveSource(liveSourceFrom(aggregates, new Date('2026-10-01T00:00:00.000Z')), NOW, {
      snapshots: liveSnapshots(snapshots, run.sources.balances),
      ingest: run
    });
  }

  afterEach(() => {
    setLiveSource(null);
  });

  it('answers unavailable before the first snapshot and never estimates', () => {
    install([]);
    const overview = buildOverview('all', 'month', NOW);
    const revenue = buildRevenue('all', 'month', NOW);

    expect(overview.tvl).toMatchObject({
      source: 'live',
      availability: 'unavailable',
      reason: 'no_snapshot',
      value: null,
      firstSnapshotAt: null
    });
    expect(overview.tvl.series.every((point) => point.tvlUsd === null)).toBe(true);
    expect(overview.topCountries.availability).toBe('unavailable');
    expect(revenue.masterWallets.availability).toBe('unavailable');
    expect(overview.meta.ingest).toEqual(RUN);
  });

  it('marks TVL partial when a network was not read completely', () => {
    install([snapshot()]);

    const all = buildOverview('all', 'month', NOW).tvl;
    expect(all).toMatchObject({ availability: 'partial', reason: 'partial_coverage' });
    expect(all.value?.value).toBe('12.00');
    expect(all.coverage).toEqual({ wallets: 4, walletsRead: 3, unpricedAssets: [] });

    const base = buildOverview('base-sepolia', 'month', NOW).tvl;
    expect(base).toMatchObject({ availability: 'available', reason: null });
    expect(base.value?.value).toBe('10.00');
  });

  it('marks TVL partial and lists the assets without price', () => {
    install([
      snapshot({
        balances: {
          networks: [{ network: 'base-sepolia', status: 'complete', wallets: 2, walletsRead: 2 }],
          holdings: [
            { network: 'base-sepolia', asset: 'USDC', amount: '10.0', valueCents: 1000 },
            { network: 'base-sepolia', asset: 'WBTC', amount: '0.1', valueCents: null }
          ],
          masterWallets: []
        }
      })
    ]);

    const { tvl, topTokens } = buildOverview('base-sepolia', 'month', NOW);
    expect(tvl).toMatchObject({ availability: 'partial', reason: 'unpriced_assets' });
    expect(tvl.coverage?.unpricedAssets).toEqual([{ network: 'base-sepolia', asset: 'WBTC' }]);
    expect(topTokens.items.find((item) => item.asset === 'WBTC')).toMatchObject({
      valueUsd: null,
      share: null
    });
  });

  it('reads the countries of the last run, with or without balances', () => {
    install([snapshot({ balances: null })]);

    const { topCountries, tvl } = buildOverview('all', 'month', NOW);
    expect(topCountries).toMatchObject({ availability: 'available', totalUsers: 2 });
    expect(topCountries.items).toEqual([{ country: 'AR', users: 2, share: '1.0000' }]);
    expect(tvl.availability).toBe('unavailable');
  });

  it('counts only wallets with a verifiable first appearance', () => {
    install([]);
    const partial = buildUsers('base-sepolia', 'monthly', NOW).newWallets;

    expect(partial).toMatchObject({ availability: 'partial', reason: 'unverified_wallets' });
    expect(partial.coverage).toEqual({ wallets: 2, verifiedWallets: 1 });

    install(
      [],
      [
        {
          chainId: '84532',
          address: '0xuser2',
          firstObservedAt: new Date('2026-10-22T03:00:00.000Z'),
          bounded: true
        }
      ]
    );
    const complete = buildUsers('base-sepolia', 'monthly', NOW).newWallets;
    expect(complete).toMatchObject({ availability: 'available', reason: null });
    expect(complete.coverage).toEqual({ wallets: 2, verifiedWallets: 2 });
    expect(complete.tile.value).toBe(2);
  });

  it('marks new wallets unavailable while no wallet is recorded', () => {
    install([]);

    expect(buildUsers('cardano-preprod', 'monthly', NOW).newWallets).toMatchObject({
      availability: 'unavailable',
      reason: 'not_recorded',
      coverage: { wallets: 0, verifiedWallets: 0 }
    });
  });

  it('does not take an unbounded first observation as an appearance', () => {
    install(
      [],
      [
        {
          chainId: '84532',
          address: '0xuser2',
          firstObservedAt: new Date('2026-10-01T00:00:00.000Z'),
          bounded: false
        }
      ]
    );

    expect(buildUsers('base-sepolia', 'monthly', NOW).newWallets.coverage).toEqual({
      wallets: 2,
      verifiedWallets: 1
    });
  });
});
