import { afterEach, describe, expect, it } from 'vitest';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import type {
  CallBudget,
  IngestedUser,
  PolygonBlock,
  PolygonFillReader,
  PolymarketAccountRecord,
  PolymarketFill
} from '../src/ingest/types.js';
import { DEFAULT_NETWORKS, setNetworks } from '../src/metrics/catalog.js';
import { resetFactsCaches } from '../src/metrics/facts.js';
import { buildOverview } from '../src/metrics/overview.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { setLiveSource } from '../src/metrics/sources.js';
import { FakeReader, MemoryIngestRepository, transaction } from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const HOUR_MS = 3_600_000;
/** Block `n` is mined two seconds after block `n - 1`; the head is one hour before the run. */
const GENESIS_MS = Date.parse('2026-10-20T00:00:00.000Z');
const HEAD = (NOW.getTime() - HOUR_MS - GENESIS_MS) / 2000;
const MAKER = '0x1111111111111111111111111111111111111111';

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 0,
  maxPolymarketCallsPerRun: 100,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

function blockTime(number: number): Date {
  return new Date(GENESIS_MS + number * 2000);
}

function fill(id: string, block: number, fields: Partial<PolymarketFill> = {}): PolymarketFill {
  return {
    id,
    hour: Math.floor(blockTime(block).getTime() / HOUR_MS),
    side: 'buy',
    collateralMicro: 0,
    feeMicro: 0,
    attributed: false,
    ...fields
  };
}

/** Fills of one maker by block; each method takes one request of the budget. */
class FakePolygon implements PolygonFillReader {
  requests = 0;

  constructor(private readonly chain: ReadonlyArray<{ block: number; fill: PolymarketFill }>) {}

  private take(budget: CallBudget): boolean {
    if (budget.remaining <= 0) {
      return false;
    }
    budget.remaining -= 1;
    budget.used += 1;
    this.requests += 1;
    return true;
  }

  async head(budget: CallBudget) {
    return this.take(budget) ? { number: HEAD, at: blockTime(HEAD) } : null;
  }

  async block(number: number, budget: CallBudget) {
    return this.take(budget) ? { number, at: blockTime(number) } : null;
  }

  async blockAt(at: Date, head: PolygonBlock, budget: CallBudget) {
    if (!this.take(budget) || at.getTime() > head.at.getTime()) {
      return null;
    }
    const number = Math.max(0, Math.ceil((at.getTime() - GENESIS_MS) / 2000));
    return { number, at: blockTime(number) };
  }

  async fills(makers: readonly string[], from: number, to: number, budget: CallBudget) {
    if (!this.take(budget)) {
      return null;
    }
    return makers.includes(MAKER)
      ? this.chain.filter((item) => item.block >= from && item.block <= to).map((item) => item.fill)
      : [];
  }
}

const POLYMARKET: PolymarketAccountRecord = {
  validAddress: true,
  address: MAKER,
  createdAt: new Date('2026-10-20T00:00:00.000Z')
};

const USERS: Array<IngestedUser & { polymarket?: PolymarketAccountRecord | null }> = [
  {
    id: 'a',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    wallets: [{ chainId: '84532', address: '0xa' }],
    polymarket: POLYMARKET
  }
];

/** A buy of 5 pUSD, a sell of 2.5 pUSD with a Polymarket fee, both before the head. */
const CHAIN = [
  { block: 5_000, fill: fill('0xt1:1', 5_000, { collateralMicro: 5_000_000 }) },
  {
    block: 90_000,
    fill: fill('0xt2:4', 90_000, { side: 'sell', collateralMicro: 2_500_000, feeMicro: 50_000 })
  }
];

async function ingest(polygon: PolygonFillReader, options: Partial<IngestionOptions> = {}) {
  const repository = new MemoryIngestRepository();
  const report = await runIngestion({
    reader: new FakeReader([transaction(1, { from: '0xa', amount: 10, fee: 0.1 })], USERS),
    repository,
    prices: null,
    balances: null,
    polygon,
    masterWallets: [],
    clock: () => NOW,
    options: { ...OPTIONS, ...options },
    owner: 'polymarket-volume-test'
  });
  await refreshLiveMetrics(repository, null);
  return { repository, report };
}

afterEach(() => {
  setLiveSource(null);
  setNetworks(DEFAULT_NETWORKS);
  resetFactsCaches();
});

describe('Polymarket executed volume', () => {
  it('reads the fills in the run and stores them without any address', async () => {
    const { repository, report } = await ingest(new FakePolygon(CHAIN));

    expect(report.sources.polymarket).toEqual({
      status: 'complete',
      calls: report.sources.polymarket.calls,
      failedCalls: 0,
      accounts: 1,
      fills: 2,
      from: blockTime(0).toISOString(),
      through: blockTime(HEAD).toISOString()
    });
    expect(report.sources.polymarket.calls).toBeGreaterThan(0);
    expect(repository.checkpoints).toMatchObject({
      polymarketNextBlock: HEAD + 1,
      polymarketFrom: blockTime(0),
      polymarketThrough: blockTime(HEAD)
    });
    expect([...repository.fillCopies.values()]).toEqual(CHAIN.map((item) => item.fill));
    expect(JSON.stringify([...repository.fillCopies.values()])).not.toContain(MAKER.slice(2));
    expect(repository.stored?.run?.sources.polymarket).toBe('complete');
  });

  it('serves the volume over every network and outside the total volume', async () => {
    await ingest(new FakePolygon(CHAIN));

    const revenue = buildRevenue('all', 'month', NOW);
    expect(revenue.polymarketVolume).toEqual({
      source: 'live',
      availability: 'available',
      reason: null,
      asOf: NOW.toISOString(),
      scope: 'all_networks',
      valueUsd: '7.50',
      fills: 2,
      readThrough: blockTime(HEAD).toISOString()
    });
    expect(buildRevenue('base-sepolia', 'month', NOW).polymarketVolume).toEqual(
      revenue.polymarketVolume
    );
    expect(revenue.feesByProduct.items.find((item) => item.product === 'polymarket')).toEqual({
      product: 'polymarket',
      availability: 'available',
      reason: null,
      feesUsd: '0.00',
      share: '0.0000'
    });

    const overview = buildOverview('all', 'month', NOW);
    expect(overview.tiles.volumeUsd.value).toBe('10.00');
    expect(overview.volumeByProduct.availability).toBe('available');
    expect(overview.volumeByProduct.items).toEqual([
      expect.objectContaining({ product: 'transfer', volumeUsd: '10.00', share: '0.5714' }),
      expect.objectContaining({ product: 'swap', volumeUsd: '0.00', share: '0.0000' }),
      {
        product: 'polymarket',
        availability: 'available',
        reason: null,
        volumeUsd: '7.50',
        transactions: 2,
        share: '0.4286'
      }
    ]);
  });

  it('leaves Polymarket out of the products of a single network', async () => {
    await ingest(new FakePolygon(CHAIN));

    const overview = buildOverview('base-sepolia', 'month', NOW);
    expect(overview.volumeByProduct.items.map((item) => item.product)).toEqual([
      'transfer',
      'swap'
    ]);
    expect(overview.volumeByProduct.items[0]?.share).toBe('1.0000');
    expect(
      buildRevenue('base-sepolia', 'month', NOW).feesByProduct.items.map((item) => item.product)
    ).toEqual(['transfer', 'swap']);
  });

  it('counts each fill once over several runs', async () => {
    const polygon = new FakePolygon(CHAIN);
    const { repository } = await ingest(polygon);
    await runIngestion({
      reader: new FakeReader([], USERS),
      repository,
      prices: null,
      balances: null,
      polygon,
      masterWallets: [],
      clock: () => NOW,
      options: OPTIONS,
      owner: 'polymarket-volume-test'
    });
    await refreshLiveMetrics(repository, null);

    expect(buildRevenue('all', 'month', NOW).polymarketVolume.valueUsd).toBe('7.50');
  });

  it('withholds the Polymarket fee of a range with a builder code', async () => {
    await ingest(
      new FakePolygon([
        ...CHAIN,
        {
          block: 20_000,
          fill: fill('0xt3:2', 20_000, { collateralMicro: 1_000_000, attributed: true })
        }
      ])
    );

    const revenue = buildRevenue('all', 'month', NOW);
    expect(revenue.polymarketVolume.valueUsd).toBe('8.50');
    expect(revenue.feesByProduct.items.find((item) => item.product === 'polymarket')).toEqual({
      product: 'polymarket',
      availability: 'unavailable',
      reason: 'not_recorded',
      feesUsd: null,
      share: null
    });
  });

  it('is partial while the reads have not reached the head', async () => {
    // Head, start block, the first range and the block that dates its end.
    await ingest(new FakePolygon(CHAIN), { maxPolymarketCallsPerRun: 4 });

    const month = buildRevenue('all', 'month', NOW).polymarketVolume;
    expect(month).toMatchObject({
      availability: 'partial',
      reason: 'partial_coverage',
      valueUsd: '5.00',
      fills: 1,
      readThrough: blockTime(9_999).toISOString()
    });
    expect(buildRevenue('all', 'today', NOW).polymarketVolume).toMatchObject({
      availability: 'unavailable',
      reason: 'partial_coverage',
      valueUsd: null
    });
  });

  it('is not configured without a Polygon endpoint', async () => {
    const { report } = await ingest(null as unknown as PolygonFillReader);

    expect(report.sources.polymarket.status).toBe('disabled');
    expect(buildRevenue('all', 'month', NOW).polymarketVolume).toMatchObject({
      availability: 'unavailable',
      reason: 'not_configured',
      readThrough: null
    });
    expect(buildOverview('all', 'month', NOW).volumeByProduct).toMatchObject({
      availability: 'partial',
      reason: 'not_configured'
    });
  });
});
