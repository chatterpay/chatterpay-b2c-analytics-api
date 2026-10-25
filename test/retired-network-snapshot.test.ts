import { afterEach, describe, expect, it } from 'vitest';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { type IngestionOptions, runIngestion } from '../src/ingest/run.js';
import {
  type MasterWalletConfig,
  type SnapshotInput,
  takeBalanceSnapshot
} from '../src/ingest/snapshot.js';
import type {
  BalanceReader,
  CallBudget,
  ChainEndpoint,
  ChainInfo,
  IngestedUser,
  TokenInfo
} from '../src/ingest/types.js';
import { DEFAULT_NETWORKS, setNetworks } from '../src/metrics/catalog.js';
import { resetFactsCaches } from '../src/metrics/facts.js';
import { buildOverview } from '../src/metrics/overview.js';
import { buildRevenue } from '../src/metrics/revenue.js';
import { setLiveSource } from '../src/metrics/sources.js';
import { mergeCatalog, toNetworkDefinitions } from '../src/store/b2c-networks.js';
import { planVisibilityChange } from '../src/store/network-visibility.js';
import {
  CHAINS,
  ENDPOINTS,
  FakeReader,
  MemoryIngestRepository,
  RecordingBalanceReader,
  TOKENS,
  transaction
} from './ingest-fakes.js';

const BASE_CHAIN = '84532';
const SCROLL_CHAIN = '534352';
const SCROLL_USDC = '0x5555555555555555555555555555555555555555';
const BASE_RPC = 'https://rpc.base-sepolia.test/key-in-path';
const SCROLL_RPC = 'https://rpc.scroll.test/key-in-path';
const SIGNER = '0x9999999999999999999999999999999999999999';
const DAY_ONE = new Date('2026-10-20T03:00:00.000Z');
const DAY_TWO = new Date('2026-10-24T03:00:00.000Z');

const BASE: ChainInfo = CHAINS[0] as ChainInfo;
const SCROLL: ChainInfo = {
  chainId: SCROLL_CHAIN,
  network: 'scroll',
  name: 'Scroll',
  family: 'evm',
  explorer: 'https://scrollscan.com',
  contracts: {}
};
const BASE_ENDPOINT: ChainEndpoint = ENDPOINTS[0] as ChainEndpoint;
const SCROLL_ENDPOINT: ChainEndpoint = { chainId: SCROLL_CHAIN, family: 'evm', url: SCROLL_RPC };
const SCROLL_TOKEN: TokenInfo = {
  chainId: SCROLL_CHAIN,
  symbol: 'USDC',
  stable: true,
  address: SCROLL_USDC,
  decimals: 6
};
const BASE_USDC: TokenInfo = TOKENS[0] as TokenInfo;

/** Users: one on Base and Scroll, one on Scroll only, one on Base only. */
const USERS: Array<IngestedUser & { country: string }> = [
  {
    id: 'user-both',
    createdAt: new Date('2026-10-10T10:00:00.000Z'),
    country: 'AR',
    wallets: [
      { chainId: BASE_CHAIN, address: '0xBoth' },
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
    wallets: [{ chainId: BASE_CHAIN, address: '0xBaseOnly' }]
  }
];

const SCROLL_SIGNER: MasterWalletConfig = {
  network: 'scroll',
  address: SIGNER,
  role: 'Backend signer'
};

function budget(): CallBudget {
  return { remaining: 50, deadline: Number.MAX_SAFE_INTEGER, used: 0, failed: 0 };
}

function snapshotInput(
  reader: RecordingBalanceReader,
  overrides: Partial<SnapshotInput> = {}
): SnapshotInput {
  return {
    reader,
    endpoints: [BASE_ENDPOINT, SCROLL_ENDPOINT],
    chains: [BASE, SCROLL],
    tokens: [BASE_USDC, SCROLL_TOKEN],
    users: USERS,
    masterWallets: [SCROLL_SIGNER],
    prices: new Map(),
    b2cEnabled: new Map([
      [BASE_CHAIN, true],
      [SCROLL_CHAIN, true]
    ]),
    budget: budget(),
    ...overrides
  };
}

describe('balance snapshot of networks disabled in B2C', () => {
  it('reads an enabled network through its endpoint', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot } = await takeBalanceSnapshot(snapshotInput(reader));

    expect(reader.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toEqual({
      network: 'scroll',
      status: 'complete',
      wallets: 2,
      walletsRead: 2,
      calls: 1,
      failedCalls: 0,
      b2cEnabled: true,
      reason: null
    });
    expect(snapshot.masterWallets).toMatchObject([{ network: 'scroll', status: 'complete' }]);
  });

  it('sends no request for a network disabled in B2C that keeps its endpoint', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot, status } = await takeBalanceSnapshot(
      snapshotInput(reader, {
        b2cEnabled: new Map([
          [BASE_CHAIN, true],
          [SCROLL_CHAIN, false]
        ])
      })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(reader.calls.flatMap((call) => call.holders)).not.toContain(SIGNER);
    expect(networks.find((row) => row.network === 'scroll')).toEqual({
      network: 'scroll',
      status: 'unsupported',
      wallets: 2,
      walletsRead: 0,
      calls: 0,
      failedCalls: 0,
      b2cEnabled: false,
      reason: 'b2c_disabled'
    });
    expect(snapshot.holdings.map((holding) => holding.network)).toEqual(['base-sepolia']);
    expect(snapshot.masterWallets).toMatchObject([
      { network: 'scroll', status: 'unsupported', balances: [] }
    ]);
    expect(status).toBe('partial');
  });

  it('sends no request for a network disabled in B2C without endpoint', async () => {
    const reader = new RecordingBalanceReader();

    const { networks } = await takeBalanceSnapshot(
      snapshotInput(reader, {
        endpoints: [BASE_ENDPOINT],
        b2cEnabled: new Map([
          [BASE_CHAIN, true],
          [SCROLL_CHAIN, false]
        ])
      })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      calls: 0,
      b2cEnabled: false,
      reason: 'b2c_disabled'
    });
  });

  it('sends no request for a network the B2C database no longer lists', async () => {
    const reader = new RecordingBalanceReader();

    // The endpoint list is stale on purpose: absence from the B2C list wins over it.
    const { networks } = await takeBalanceSnapshot(
      snapshotInput(reader, { b2cEnabled: new Map([[BASE_CHAIN, true]]) })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      wallets: 2,
      walletsRead: 0,
      calls: 0,
      b2cEnabled: null,
      reason: 'source_absent'
    });
  });

  it('reads a network whose B2C document has no boolean enabled, and flags it', async () => {
    const reader = new RecordingBalanceReader();
    const unknown = new Map<string, boolean | null>([
      [BASE_CHAIN, true],
      [SCROLL_CHAIN, null]
    ]);

    const read = await takeBalanceSnapshot(snapshotInput(reader, { b2cEnabled: unknown }));
    const withoutEndpoint = await takeBalanceSnapshot(
      snapshotInput(new RecordingBalanceReader(), {
        b2cEnabled: unknown,
        endpoints: [BASE_ENDPOINT]
      })
    );

    expect(reader.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(read.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      b2cEnabled: null,
      reason: null
    });
    expect(withoutEndpoint.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      calls: 0,
      b2cEnabled: null,
      reason: 'no_endpoint'
    });
  });

  it('reports a disabled network without user wallets as complete and still skips its signer', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot } = await takeBalanceSnapshot(
      snapshotInput(reader, {
        users: USERS.filter((user) => user.id === 'user-base'),
        b2cEnabled: new Map([
          [BASE_CHAIN, true],
          [SCROLL_CHAIN, false]
        ])
      })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      wallets: 0,
      calls: 0,
      reason: 'b2c_disabled'
    });
    expect(snapshot.masterWallets).toMatchObject([{ status: 'unsupported' }]);
  });

  it('splits the calls per network across enabled, disabled and dropped networks', async () => {
    const reader = new RecordingBalanceReader();
    const cardano = CHAINS[1] as ChainInfo;
    const input = snapshotInput(reader, {
      chains: [BASE, cardano, SCROLL],
      endpoints: [...ENDPOINTS, SCROLL_ENDPOINT],
      users: [
        ...USERS,
        { id: 'user-ada', createdAt: null, wallets: [{ chainId: cardano.chainId, address: 'a1' }] }
      ],
      b2cEnabled: new Map([
        [BASE_CHAIN, true],
        [SCROLL_CHAIN, false]
      ])
    });

    const { networks } = await takeBalanceSnapshot(input);

    // Cardano is absent from the B2C status map: a network the B2C database dropped.
    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(networks.map((row) => [row.network, row.status, row.calls, row.reason])).toEqual([
      ['base-sepolia', 'complete', 1, null],
      ['cardano-preprod', 'unsupported', 0, 'source_absent'],
      ['scroll', 'unsupported', 0, 'b2c_disabled']
    ]);
    expect(networks.reduce((sum, row) => sum + row.calls, 0)).toBe(input.budget.used);
  });
});

const OPTIONS: IngestionOptions = {
  batchSize: 50,
  maxTransactionsPerRun: 1000,
  revisitHours: 0,
  maxProviderCallsPerRun: 0,
  maxBalanceCallsPerRun: 10,
  maxRunMs: 60_000,
  lockTtlMs: 120_000
};

function activity() {
  return [
    transaction(1, { from: '0xBoth', amount: 10, fee: 0.1 }),
    transaction(2, { from: '0xBaseOnly', amount: 20, fee: 0.2 }),
    transaction(3, { from: '0xBothScroll', chainId: SCROLL_CHAIN, amount: 300, fee: 3 }),
    transaction(4, { from: '0xScrollOnly', chainId: SCROLL_CHAIN, amount: 400, fee: 4 })
  ];
}

function b2cReader(scrollEnabled: boolean | null): FakeReader {
  const reader = new FakeReader(
    activity(),
    USERS,
    [BASE_USDC, SCROLL_TOKEN],
    [BASE, SCROLL],
    [BASE_ENDPOINT, SCROLL_ENDPOINT]
  );
  reader.enabledByChain = new Map([
    [BASE_CHAIN, true],
    [SCROLL_CHAIN, scrollEnabled]
  ]);
  return reader;
}

async function ingestAt(
  now: Date,
  reader: FakeReader,
  repository: MemoryIngestRepository,
  balances: BalanceReader
) {
  const report = await runIngestion({
    reader,
    repository,
    prices: null,
    balances,
    masterWallets: [SCROLL_SIGNER],
    clock: () => now,
    options: OPTIONS,
    owner: `retired-${now.toISOString()}`
  });
  await refreshLiveMetrics(repository, null);
  return report;
}

function catalogWith(scrollEnabled: boolean | null): void {
  setNetworks(
    toNetworkDefinitions([
      { name: 'Base Sepolia', family: 'evm', chainId: 84532, enabled: true },
      { name: 'Scroll', family: 'evm', chainId: 534352, enabled: scrollEnabled ?? undefined }
    ])
  );
  resetFactsCaches();
}

afterEach(() => {
  setLiveSource(null);
  setNetworks(DEFAULT_NETWORKS);
  resetFactsCaches();
});

describe('ingestion of a network disabled in B2C', () => {
  it('keeps copying Scroll activity and countries without any request to its RPC', async () => {
    catalogWith(false);
    const reader = b2cReader(false);
    const repository = new MemoryIngestRepository();
    const balances = new RecordingBalanceReader();

    const report = await ingestAt(DAY_TWO, reader, repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC]);
    expect(report.sources.transactions.read).toBe(4);
    expect(report.sources.users.countedInCountries).toBe(3);
    expect(report.sources.balances.networks).toEqual([
      {
        network: 'base-sepolia',
        status: 'complete',
        wallets: 2,
        walletsRead: 2,
        calls: 1,
        failedCalls: 0,
        b2cEnabled: true,
        reason: null,
        takenAt: DAY_TWO.toISOString()
      },
      {
        network: 'scroll',
        status: 'unsupported',
        wallets: 2,
        walletsRead: 0,
        calls: 0,
        failedCalls: 0,
        b2cEnabled: false,
        reason: 'b2c_disabled',
        takenAt: DAY_TWO.toISOString()
      }
    ]);
    const scroll = buildOverview('scroll', 'month', DAY_TWO);
    expect(scroll.byNetwork).toMatchObject([
      { network: 'scroll', volumeUsd: '700.00', transactions: 2 }
    ]);
    expect(scroll.topCountries).toMatchObject({
      availability: 'available',
      totalUsers: 2
    });
  });

  it('answers Scroll balances as not read instead of zero, and All networks as partial', async () => {
    catalogWith(false);
    const repository = new MemoryIngestRepository();
    await ingestAt(DAY_TWO, b2cReader(false), repository, new RecordingBalanceReader());

    const scroll = buildOverview('scroll', 'month', DAY_TWO);
    const all = buildOverview('all', 'month', DAY_TWO);
    const revenue = buildRevenue('scroll', 'month', DAY_TWO);

    expect(scroll.tvl).toMatchObject({
      availability: 'unavailable',
      reason: 'not_read',
      value: null,
      asOf: DAY_TWO.toISOString(),
      coverage: { wallets: 2, walletsRead: 0 }
    });
    expect(scroll.tvl.byNetwork).toEqual([
      {
        network: 'scroll',
        label: 'Scroll',
        tvlUsd: null,
        share: null,
        status: 'unsupported',
        reason: 'b2c_disabled'
      }
    ]);
    expect(scroll.tvl.series.every((point) => point.tvlUsd === null)).toBe(true);
    expect(scroll.topTokens).toMatchObject({
      availability: 'unavailable',
      reason: 'not_read',
      items: [],
      totalUsd: null
    });
    expect(revenue.masterWallets).toMatchObject({
      availability: 'unavailable',
      reason: 'not_read',
      totalUsd: null,
      items: [{ network: 'scroll', status: 'unsupported', valueUsd: null }]
    });
    expect(all.tvl).toMatchObject({
      availability: 'partial',
      reason: 'partial_coverage',
      value: { value: '2.00' },
      coverage: { wallets: 4, walletsRead: 2 }
    });
    expect(all.tvl.byNetwork.map((row) => [row.network, row.tvlUsd])).toEqual([
      ['base-sepolia', '2.00'],
      ['scroll', null]
    ]);
  });

  it('keeps the last Scroll reading in its own snapshot and never serves it as current', async () => {
    const repository = new MemoryIngestRepository();
    catalogWith(true);
    await ingestAt(DAY_ONE, b2cReader(true), repository, new RecordingBalanceReader());
    catalogWith(false);
    const balances = new RecordingBalanceReader();
    await ingestAt(DAY_TWO, b2cReader(false), repository, balances);

    const scroll = buildOverview('scroll', 'month', DAY_TWO).tvl;

    expect(balances.urls()).toEqual([BASE_RPC]);
    expect(repository.snapshotCopies.size).toBe(2);
    const first = repository.snapshotCopies.get(DAY_ONE.getTime());
    expect(first?.balances?.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      walletsRead: 2
    });
    expect(scroll).toMatchObject({ availability: 'unavailable', reason: 'not_read', value: null });
    const observed = scroll.series.filter((point) => point.tvlUsd !== null);
    expect(observed).toEqual([
      expect.objectContaining({ tvlUsd: '2.00', asOf: DAY_ONE.toISOString() })
    ]);
  });

  it('reads Scroll again once B2C enables it, without losing the earlier runs', async () => {
    const repository = new MemoryIngestRepository();
    catalogWith(false);
    await ingestAt(DAY_ONE, b2cReader(false), repository, new RecordingBalanceReader());
    catalogWith(true);
    const balances = new RecordingBalanceReader();
    const report = await ingestAt(DAY_TWO, b2cReader(true), repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      b2cEnabled: true,
      reason: null
    });
    expect(repository.snapshotCopies.size).toBe(2);
    expect(buildOverview('scroll', 'month', DAY_TWO).tvl).toMatchObject({
      availability: 'available',
      value: { value: '2.00' }
    });
  });

  it('reads Scroll hidden in the analytics while B2C keeps it enabled', async () => {
    catalogWith(true);
    const catalog = toNetworkDefinitions([
      { name: 'Base Sepolia', family: 'evm', chainId: 84532, enabled: true },
      { name: 'Scroll', family: 'evm', chainId: 534352, enabled: true }
    ]);
    const plan = planVisibilityChange(
      { disabledChainIds: [], revision: 0, updatedAt: null, updatedBy: null },
      {
        chainId: SCROLL_CHAIN,
        analyticsEnabled: false,
        expectedRevision: 0,
        actorId: 'admin-0001',
        catalogChainIds: catalog.map((network) => network.chainId)
      },
      DAY_TWO
    );
    expect(plan.kind).toBe('write');
    const repository = new MemoryIngestRepository();
    const balances = new RecordingBalanceReader();

    // The ingestion takes no visibility input: hiding Scroll changes nothing it does.
    await ingestAt(DAY_TWO, b2cReader(true), repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(buildOverview('all', 'month', DAY_TWO, ['base-sepolia']).tvl).toMatchObject({
      availability: 'available',
      value: { value: '2.00' }
    });
  });

  it('shows All networks complete once the disabled Scroll is hidden, and partial again when shown', async () => {
    catalogWith(false);
    const repository = new MemoryIngestRepository();
    await ingestAt(DAY_TWO, b2cReader(false), repository, new RecordingBalanceReader());

    expect(buildOverview('all', 'month', DAY_TWO, ['base-sepolia']).tvl).toMatchObject({
      availability: 'available',
      reason: null,
      value: { value: '2.00' }
    });
    expect(buildOverview('all', 'month', DAY_TWO, ['base-sepolia', 'scroll']).tvl).toMatchObject({
      availability: 'partial',
      reason: 'partial_coverage'
    });
  });

  it('reads Scroll when its B2C document has no boolean enabled', async () => {
    catalogWith(null);
    const repository = new MemoryIngestRepository();
    const balances = new RecordingBalanceReader();

    const report = await ingestAt(DAY_TWO, b2cReader(null), repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      b2cEnabled: null,
      reason: null
    });
  });

  it('gives a retained network a row without any request once B2C drops it', async () => {
    catalogWith(true);
    const repository = new MemoryIngestRepository();
    await ingestAt(DAY_ONE, b2cReader(true), repository, new RecordingBalanceReader());
    // B2C drops Scroll; the analytics database retains it because copied rows use it.
    const dropped = new FakeReader(activity(), USERS, [BASE_USDC], [BASE], [BASE_ENDPOINT]);
    setNetworks(mergeCatalog(toNetworkDefinitions([]), repository.chainCopies));
    const balances = new RecordingBalanceReader();

    const report = await ingestAt(DAY_TWO, dropped, repository, balances);

    expect(report.sources.catalog.retainedNetworks).toBe(1);
    expect(balances.urls()).toEqual([BASE_RPC]);
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      wallets: 2,
      walletsRead: 0,
      calls: 0,
      b2cEnabled: null,
      reason: 'source_absent'
    });
  });

  it('keeps counting the users of a retained network per country', async () => {
    catalogWith(true);
    const repository = new MemoryIngestRepository();
    await ingestAt(DAY_ONE, b2cReader(true), repository, new RecordingBalanceReader());
    const dropped = new FakeReader(activity(), USERS, [BASE_USDC], [BASE], [BASE_ENDPOINT]);
    setNetworks(mergeCatalog(toNetworkDefinitions([]), repository.chainCopies));
    resetFactsCaches();

    const report = await ingestAt(DAY_TWO, dropped, repository, new RecordingBalanceReader());

    // Every user still has a wallet on a catalog network, Scroll included.
    expect(report.sources.users.countedInCountries).toBe(3);
    expect(buildOverview('scroll', 'month', DAY_TWO).topCountries).toMatchObject({
      availability: 'available',
      asOf: DAY_TWO.toISOString(),
      totalUsers: 2,
      items: [
        { country: 'AR', users: 1 },
        { country: 'MX', users: 1 }
      ]
    });
  });
});
