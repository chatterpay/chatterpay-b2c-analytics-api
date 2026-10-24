import { describe, expect, it } from 'vitest';
import { allocateInteger } from '../src/metrics/allocate.js';
import { centsToUsd, changeRatio } from '../src/metrics/format.js';
import { buildOverview } from '../src/metrics/overview.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import type { MetricsRange } from '../src/metrics/types.js';
import { buildUsers } from '../src/metrics/users.js';

const NOW = new Date('2026-10-24T15:30:00.000Z');
const RANGES: MetricsRange[] = ['today', 'week', 'month', 'year', 'ytd', 'all'];

function cents(usd: string): number {
  const [whole = '0', fraction = '0'] = usd.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function sumCents(values: readonly string[]): number {
  return values.reduce((sum, value) => sum + cents(value), 0);
}

describe('allocateInteger', () => {
  it('splits exactly and deterministically', () => {
    expect(allocateInteger(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateInteger(0, [0, 0])).toEqual([0, 0]);
    expect(allocateInteger(1001, [45, 30, 18, 7]).reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it('rejects invalid input', () => {
    expect(() => allocateInteger(1.5, [1])).toThrowError();
    expect(() => allocateInteger(5, [0, 0])).toThrowError();
  });
});

describe('format', () => {
  it('formats cents', () => {
    expect(centsToUsd(0)).toBe('0.00');
    expect(centsToUsd(5)).toBe('0.05');
    expect(centsToUsd(123_456)).toBe('1234.56');
  });

  it('computes change ratios with division-by-zero rules', () => {
    expect(changeRatio(150, 100)).toBe('0.5000');
    expect(changeRatio(50, 100)).toBe('-0.5000');
    expect(changeRatio(1, 3)).toBe('-0.6667');
    expect(changeRatio(10, 0)).toBeNull();
    expect(changeRatio(10, null)).toBeNull();
  });
});

describe.each(RANGES)('overview %s', (range) => {
  const overview = buildOverview('all', range, NOW);

  it('tiles equal the network breakdown and the series', () => {
    expect(cents(overview.tiles.volumeUsd.value)).toBe(
      sumCents(overview.byNetwork.map((item) => item.volumeUsd))
    );
    expect(cents(overview.tiles.volumeUsd.value)).toBe(
      sumCents(overview.series.map((point) => point.volumeUsd))
    );
    expect(overview.tiles.transactions.value).toBe(
      overview.series.reduce((sum, point) => sum + point.transactions, 0)
    );
    expect(overview.tiles.newUsers.value).toBe(
      overview.byNetwork.reduce((sum, item) => sum + item.newUsers, 0)
    );
    for (const point of overview.series) {
      expect(cents(point.volumeUsd)).toBe(sumCents(point.byNetwork.map((item) => item.volumeUsd)));
    }
  });

  it('series buckets are contiguous and end at the current hour', () => {
    expect(overview.series[0]?.start).toBe(overview.meta.period.start);
    expect(overview.series.at(-1)?.end).toBe('2026-10-24T16:00:00.000Z');
    overview.series.slice(1).forEach((point, index) => {
      expect(point.start).toBe(overview.series[index]?.end);
    });
  });

  it('a single network matches its share of all networks', () => {
    const base = buildOverview('base-sepolia', range, NOW);
    expect(base.byNetwork).toHaveLength(1);
    expect(base.byNetwork[0]).toEqual(
      overview.byNetwork.find((item) => item.network === 'base-sepolia')
    );
  });

  it('is deterministic', () => {
    expect(buildOverview('all', range, NOW)).toEqual(overview);
  });
});

describe('overview comparisons', () => {
  it('has no previous period for all', () => {
    const overview = buildOverview('all', 'all', NOW);
    expect(overview.meta.previousPeriod).toBeNull();
    expect(overview.tiles.volumeUsd.previous).toBeNull();
    expect(overview.tiles.volumeUsd.changeRatio).toBeNull();
  });

  it('compares today with the same hours of yesterday', () => {
    expect(buildOverview('all', 'today', NOW).meta.previousPeriod).toEqual({
      start: '2026-10-23T00:00:00.000Z',
      end: '2026-10-23T16:00:00.000Z'
    });
  });

  it('later hours of the same day never decrease the totals', () => {
    const morning = buildOverview('all', 'today', new Date('2026-10-24T08:10:00.000Z'));
    const evening = buildOverview('all', 'today', new Date('2026-10-24T21:10:00.000Z'));
    expect(cents(evening.tiles.volumeUsd.value)).toBeGreaterThan(
      cents(morning.tiles.volumeUsd.value)
    );
  });

  it('has no activity before the dataset start', () => {
    const early = buildOverview('all', 'week', new Date('2024-06-01T12:00:00.000Z'));
    expect(early.tiles.volumeUsd.value).toBe('0.00');
    expect(early.tiles.activeUsers.value).toBe(0);
  });
});

describe.each(RANGES)('revenue %s', (range) => {
  const revenue = buildRevenue('all', range, NOW);
  const overview = buildOverview('all', range, NOW);

  it('fees add up across kinds, networks, assets and series', () => {
    const fees = cents(revenue.tiles.feesUsd.value);
    expect(fees).toBe(
      cents(revenue.tiles.transferFeesUsd.value) + cents(revenue.tiles.swapFeesUsd.value)
    );
    expect(fees).toBe(sumCents(revenue.byNetwork.map((item) => item.feesUsd)));
    expect(fees).toBe(sumCents(revenue.byAsset.map((item) => item.feesUsd)));
    expect(fees).toBe(sumCents(revenue.series.map((point) => point.feesUsd)));
  });

  it('matches the overview figures', () => {
    expect(revenue.tiles.feesUsd).toEqual(overview.tiles.feesUsd);
    expect(revenue.tiles.volumeUsd).toEqual(overview.tiles.volumeUsd);
    expect(sumCents(revenue.byAsset.map((item) => item.volumeUsd))).toBe(
      cents(overview.tiles.volumeUsd.value)
    );
  });
});

describe('revenue on cardano', () => {
  it('has no swap fees', () => {
    const revenue = buildRevenue('cardano-preprod', 'year', NOW);
    expect(revenue.tiles.swapFeesUsd.value).toBe('0.00');
    expect(revenue.byAsset.map((item) => item.asset).sort()).toEqual(['ADA', 'USDCx']);
  });
});

describe.each(['daily', 'monthly', 'yearly'] as const)('users %s', (granularity) => {
  const users = buildUsers('all', granularity, NOW);

  it('series points equal the sum of their networks', () => {
    for (const point of users.series) {
      expect(point.activeUsers).toBe(
        point.byNetwork.reduce((sum, item) => sum + item.activeUsers, 0)
      );
      expect(point.newUsers).toBe(point.byNetwork.reduce((sum, item) => sum + item.newUsers, 0));
    }
  });

  it('active users never exceed total users', () => {
    for (const item of users.byNetwork) {
      expect(item.activeUsers).toBeLessThanOrEqual(item.totalUsers);
    }
    expect(users.tiles.yearlyActiveUsers.value).toBeLessThanOrEqual(users.tiles.totalUsers.value);
  });

  it('retention is non-increasing and bounded by the cohort', () => {
    expect(users.retention).toHaveLength(6);
    expect(users.retention.at(-1)?.cohort).toBe('2026-09');
    for (const cohort of users.retention) {
      let previous = cohort.size;
      for (const retained of cohort.retained) {
        expect(retained).toBeLessThanOrEqual(previous);
        previous = retained;
      }
    }
  });
});

describe('users series spans', () => {
  it('daily covers 30 days, monthly 12 months, yearly since the dataset start', () => {
    expect(buildUsers('all', 'daily', NOW).series).toHaveLength(30);
    expect(buildUsers('all', 'monthly', NOW).series).toHaveLength(12);
    expect(buildUsers('all', 'yearly', NOW).series.map((point) => point.start)).toEqual([
      '2025-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    ]);
  });

  it('total users equals the new users since the start', () => {
    const users = buildUsers('all', 'yearly', NOW);
    expect(users.tiles.totalUsers.value).toBe(
      users.series.reduce((sum, point) => sum + point.newUsers, 0)
    );
  });
});
