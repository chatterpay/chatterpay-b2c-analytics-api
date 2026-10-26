import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CONSECUTIVE_FAILURES, rpcBalanceReader } from '../src/ingest/balance-reader.js';
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
import {
  CHAINS,
  ENDPOINTS,
  FakeBalanceReader,
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
/** Native coin of an EVM network as a B2C token document with a placeholder address. */
function nativeOf(chainId: string): TokenInfo {
  return {
    chainId,
    symbol: 'ETH',
    stable: false,
    address: '0x0000000000000000000000000000000000000000',
    decimals: 18
  };
}

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

/** Scroll signer without `nativeSymbol`: it names no native coin for the user wallets. */
const SCROLL_SIGNER: MasterWalletConfig = {
  network: 'scroll',
  address: SIGNER,
  role: 'Backend signer'
};

function budget(remaining = 50): CallBudget {
  return { remaining, deadline: Number.MAX_SAFE_INTEGER, used: 0, failed: 0 };
}

function snapshotInput(
  reader: BalanceReader,
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
    takenAt: DAY_TWO,
    now: () => DAY_TWO.getTime(),
    ...overrides
  };
}

const B2C_DISABLED = new Map([
  [BASE_CHAIN, true],
  [SCROLL_CHAIN, false]
]);

/** Answer of a node to an `aggregate3` request: a balance of 1_000_000 for every call. */
function multicallAnswer(body: string): Response {
  const data = (JSON.parse(body) as { params: Array<{ data: string }> }).params[0]?.data ?? '';
  const calls = Number.parseInt(data.slice(10 + 64, 10 + 128), 16);
  const word = (value: number): string => value.toString(16).padStart(64, '0');
  const tuple = word(1) + word(0x40) + word(32) + word(1_000_000);
  const offsets = Array.from({ length: calls }, (_, index) =>
    word(calls * 32 + (index * tuple.length) / 2)
  );
  const result = `0x${word(0x20)}${word(calls)}${offsets.join('')}${tuple.repeat(calls)}`;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

/** Scroll users enough for three `aggregate3` batches of one token each. */
const MANY_SCROLL_USERS: IngestedUser[] = Array.from({ length: 450 }, (_, index) => ({
  id: `scroll-${index}`,
  createdAt: null,
  wallets: [{ chainId: SCROLL_CHAIN, address: `0x${(index + 1).toString(16).padStart(40, '0')}` }]
}));

describe('balance snapshot of networks disabled in B2C', () => {
  it('reads a network B2C keeps enabled through its endpoint', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot } = await takeBalanceSnapshot(snapshotInput(reader));

    expect(reader.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    // The Scroll signer states no `nativeSymbol`: the user wallets are not assumed to hold ETH.
    expect(networks.find((row) => row.network === 'scroll')).toEqual({
      network: 'scroll',
      chainId: SCROLL_CHAIN,
      status: 'complete',
      wallets: 2,
      walletsRead: 2,
      calls: 1,
      failedCalls: 0,
      b2cEnabled: true,
      collectBalances: true,
      attempted: true,
      endpointPresent: true,
      reason: null,
      native: 'not_listed',
      lastSuccessAt: DAY_TWO,
      startedAt: DAY_TWO.toISOString(),
      finishedAt: DAY_TWO.toISOString(),
      durationMs: 0,
      unpricedAssets: 0
    });
    expect(snapshot.masterWallets).toMatchObject([{ network: 'scroll', status: 'complete' }]);
    // The stored row leaves the report-only fields out.
    expect(Object.keys(snapshot.networks[1] ?? {}).sort()).toEqual([
      'attempted',
      'b2cEnabled',
      'calls',
      'collectBalances',
      'failedCalls',
      'lastSuccessAt',
      'native',
      'network',
      'reason',
      'status',
      'wallets',
      'walletsRead'
    ]);
  });

  it('reads a network disabled in B2C through its endpoint and records b2cEnabled only', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot, status } = await takeBalanceSnapshot(
      snapshotInput(reader, { b2cEnabled: B2C_DISABLED })
    );

    expect(reader.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(reader.calls.flatMap((call) => call.holders)).toContain(SIGNER);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      wallets: 2,
      walletsRead: 2,
      calls: 1,
      b2cEnabled: false,
      collectBalances: true,
      attempted: true,
      reason: null,
      lastSuccessAt: DAY_TWO
    });
    expect(snapshot.holdings.map((holding) => holding.network)).toEqual(['base-sepolia', 'scroll']);
    expect(snapshot.masterWallets).toMatchObject([{ network: 'scroll', status: 'complete' }]);
    expect(status).toBe('complete');
  });

  it('reads the native coin of a disabled network only when verifiable metadata names it', async () => {
    const listed = await takeBalanceSnapshot(
      snapshotInput(new RecordingBalanceReader(), {
        tokens: [BASE_USDC, SCROLL_TOKEN, nativeOf(SCROLL_CHAIN)],
        b2cEnabled: B2C_DISABLED
      })
    );
    const unnamed = await takeBalanceSnapshot(
      snapshotInput(new RecordingBalanceReader(), { b2cEnabled: B2C_DISABLED })
    );
    const named = await takeBalanceSnapshot(
      snapshotInput(new RecordingBalanceReader(), {
        masterWallets: [{ ...SCROLL_SIGNER, nativeSymbol: 'ETH' }],
        b2cEnabled: B2C_DISABLED
      })
    );
    const none = await takeBalanceSnapshot(
      snapshotInput(new RecordingBalanceReader(), { masterWallets: [], b2cEnabled: B2C_DISABLED })
    );

    const scrollOf = (result: typeof listed) =>
      result.networks.find((row) => row.network === 'scroll');
    expect(scrollOf(listed)).toMatchObject({ status: 'complete', native: 'included' });
    expect(scrollOf(named)).toMatchObject({ status: 'complete', native: 'included' });
    expect(scrollOf(unnamed)).toMatchObject({ status: 'complete', native: 'not_listed' });
    expect(scrollOf(none)).toMatchObject({ status: 'complete', native: 'not_listed' });
    // The signer itself keeps its own native reading whatever names the coin of the users.
    expect(unnamed.snapshot.masterWallets).toMatchObject([{ status: 'complete' }]);
  });

  it('gives a network disabled in B2C without endpoint no reading, with no_endpoint', async () => {
    const reader = new RecordingBalanceReader();

    const { networks } = await takeBalanceSnapshot(
      snapshotInput(reader, { endpoints: [BASE_ENDPOINT], b2cEnabled: B2C_DISABLED })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      calls: 0,
      b2cEnabled: false,
      collectBalances: true,
      attempted: false,
      endpointPresent: false,
      reason: 'no_endpoint',
      lastSuccessAt: null
    });
  });

  it('sends no request for a network the B2C database no longer lists', async () => {
    const reader = new RecordingBalanceReader();

    // The endpoint list is stale on purpose: absence from the B2C list wins over it.
    const { networks } = await takeBalanceSnapshot(
      snapshotInput(reader, {
        b2cEnabled: new Map([[BASE_CHAIN, true]]),
        lastSuccess: new Map([['scroll', DAY_ONE]])
      })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      wallets: 2,
      walletsRead: 0,
      calls: 0,
      b2cEnabled: null,
      attempted: false,
      endpointPresent: false,
      reason: 'source_absent',
      lastSuccessAt: DAY_ONE
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

  it('reads the signer of a network disabled in B2C without user wallets', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot } = await takeBalanceSnapshot(
      snapshotInput(reader, {
        users: USERS.filter((user) => user.id === 'user-base'),
        b2cEnabled: B2C_DISABLED
      })
    );

    expect(reader.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      wallets: 0,
      calls: 1,
      reason: null
    });
    expect(snapshot.masterWallets).toMatchObject([{ status: 'complete' }]);
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
      b2cEnabled: B2C_DISABLED
    });

    const { networks } = await takeBalanceSnapshot(input);

    // Cardano is absent from the B2C status map: a network the B2C database dropped.
    expect(reader.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(networks.map((row) => [row.network, row.status, row.calls, row.reason])).toEqual([
      ['base-sepolia', 'complete', 1, null],
      ['cardano-preprod', 'unsupported', 0, 'source_absent'],
      ['scroll', 'complete', 1, null]
    ]);
    expect(networks.reduce((sum, row) => sum + row.calls, 0)).toBe(input.budget.used);
  });
});

describe('balance collection policy of the analytics', () => {
  it('skips a network B2C keeps enabled when the analytics settings stop its reads', async () => {
    const reader = new RecordingBalanceReader();

    const { networks, snapshot, status } = await takeBalanceSnapshot(
      snapshotInput(reader, { uncollected: new Set([SCROLL_CHAIN]) })
    );

    expect(reader.urls()).toEqual([BASE_RPC]);
    expect(reader.calls.flatMap((call) => call.holders)).not.toContain(SIGNER);
    expect(networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      wallets: 2,
      walletsRead: 0,
      calls: 0,
      failedCalls: 0,
      b2cEnabled: true,
      collectBalances: false,
      attempted: false,
      endpointPresent: true,
      reason: 'collection_off',
      lastSuccessAt: null
    });
    expect(snapshot.holdings.map((holding) => holding.network)).toEqual(['base-sepolia']);
    expect(snapshot.masterWallets).toMatchObject([{ network: 'scroll', status: 'unsupported' }]);
    expect(status).toBe('partial');
  });

  it('applies the same policy to any network, whatever its chain id', async () => {
    const reader = new RecordingBalanceReader();

    const { networks } = await takeBalanceSnapshot(
      snapshotInput(reader, { uncollected: new Set([BASE_CHAIN]), b2cEnabled: B2C_DISABLED })
    );

    expect(reader.urls()).toEqual([SCROLL_RPC]);
    expect(networks.map((row) => [row.network, row.reason, row.collectBalances])).toEqual([
      ['base-sepolia', 'collection_off', false],
      ['scroll', null, true]
    ]);
  });

  it('stops calling a failing node and reads the next networks within the budget', async () => {
    const urls: string[] = [];
    const reader = rpcBalanceReader(
      async (url, init) => {
        urls.push(url);
        if (url === SCROLL_RPC) {
          throw new TypeError('fetch failed');
        }
        return multicallAnswer(init.body);
      },
      () => DAY_TWO.getTime()
    );
    const input = snapshotInput(reader, {
      chains: [SCROLL, BASE],
      users: [...USERS, ...MANY_SCROLL_USERS],
      masterWallets: [],
      budget: budget(MAX_CONSECUTIVE_FAILURES + 1)
    });

    const { networks, status } = await takeBalanceSnapshot(input);

    // Three batches were due on Scroll; the reader stops after the failures in a row.
    expect(urls.filter((url) => url === SCROLL_RPC)).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(networks.map((row) => [row.network, row.status, row.calls, row.reason])).toEqual([
      ['scroll', 'failed', MAX_CONSECUTIVE_FAILURES, 'rpc_failed'],
      ['base-sepolia', 'complete', 1, null]
    ]);
    expect(networks[0]).toMatchObject({ attempted: true, walletsRead: 0, failedCalls: 2 });
    expect(input.budget.used).toBe(MAX_CONSECUTIVE_FAILURES + 1);
    expect(status).toBe('partial');
  });

  it('keeps the run time of the next networks when a slow node times out', async () => {
    let clock = DAY_TWO.getTime();
    const reader = rpcBalanceReader(
      async (url, init) => {
        if (url === SCROLL_RPC) {
          // A request that ends at the reader timeout.
          clock += 15_000;
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }
        return multicallAnswer(init.body);
      },
      () => clock
    );
    const input = snapshotInput(reader, {
      chains: [SCROLL, BASE],
      users: [...USERS, ...MANY_SCROLL_USERS],
      masterWallets: [],
      budget: { ...budget(), deadline: DAY_TWO.getTime() + 40_000 },
      now: () => clock
    });

    const { networks } = await takeBalanceSnapshot(input);

    expect(networks[0]).toMatchObject({
      network: 'scroll',
      status: 'failed',
      reason: 'rpc_failed',
      durationMs: 30_000
    });
    expect(networks[1]).toMatchObject({ network: 'base-sepolia', status: 'complete' });
  });

  it('names the spent budget and the passed deadline of the networks left unread', async () => {
    const spent = await takeBalanceSnapshot(
      snapshotInput(new FakeBalanceReader({}), { masterWallets: [], budget: budget(1) })
    );
    let clock = DAY_TWO.getTime();
    const inner = new FakeBalanceReader({});
    // The first network takes the run past its deadline; the reader then sends nothing.
    const slow: BalanceReader = {
      evm: async (url, queries, callBudget) => {
        if (clock >= callBudget.deadline) {
          return queries.map(() => null);
        }
        const values = await inner.evm(url, queries, callBudget);
        clock += 5_000;
        return values;
      },
      cardano: (url, addresses, callBudget) => inner.cardano(url, addresses, callBudget),
      supportsCardano: () => true
    };
    const late = await takeBalanceSnapshot(
      snapshotInput(slow, {
        masterWallets: [],
        budget: { ...budget(), deadline: DAY_TWO.getTime() + 1_000 },
        now: () => clock
      })
    );

    expect(spent.networks.map((row) => [row.network, row.status, row.calls, row.reason])).toEqual([
      ['base-sepolia', 'complete', 1, null],
      ['scroll', 'failed', 0, 'budget_exhausted']
    ]);
    expect(late.networks.map((row) => [row.network, row.status, row.reason])).toEqual([
      ['base-sepolia', 'complete', null],
      ['scroll', 'failed', 'deadline_reached']
    ]);
    expect(late.networks[1]).toMatchObject({ attempted: true, calls: 0 });
  });

  it('keeps the native coin of the user wallets apart from the master wallet balance', async () => {
    const reader = new FakeBalanceReader({
      [`0xbothscroll|${SCROLL_USDC}`]: 1_000_000n,
      [`0xscrollonly|${SCROLL_USDC}`]: 1_000_000n,
      '0xbothscroll|native': 1_000_000_000_000_000_000n,
      [`${SIGNER}|native`]: 5_000_000_000_000_000_000n
    });

    const { snapshot } = await takeBalanceSnapshot(
      snapshotInput(reader, {
        chains: [SCROLL],
        endpoints: [SCROLL_ENDPOINT],
        masterWallets: [{ ...SCROLL_SIGNER, nativeSymbol: 'ETH' }],
        prices: new Map([['ETH', 3000]])
      })
    );

    // Each user wallet is read with its own address; the signer balance is never added to them.
    expect(snapshot.holdings).toEqual([
      { network: 'scroll', asset: 'USDC', amount: '2.0', valueCents: 200 },
      { network: 'scroll', asset: 'ETH', amount: '1.0', valueCents: 300_000 }
    ]);
    expect(snapshot.masterWallets[0]?.balances).toEqual([
      { asset: 'ETH', amount: '5.0', valueCents: 1_500_000 }
    ]);
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

function b2cReader(scrollEnabled: boolean | null, scrollNative = true): FakeReader {
  const reader = new FakeReader(
    activity(),
    USERS,
    [
      BASE_USDC,
      nativeOf(BASE_CHAIN),
      SCROLL_TOKEN,
      ...(scrollNative ? [nativeOf(SCROLL_CHAIN)] : [])
    ],
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
  balances: BalanceReader,
  masterWallets: MasterWalletConfig[] = [SCROLL_SIGNER]
) {
  const report = await runIngestion({
    reader,
    repository,
    prices: null,
    balances,
    masterWallets,
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
  it('reads Scroll disabled in B2C through its RPC and keeps copying its activity', async () => {
    catalogWith(false);
    const reader = b2cReader(false);
    const repository = new MemoryIngestRepository();
    const balances = new RecordingBalanceReader();

    const report = await ingestAt(DAY_TWO, reader, repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(report.sources.transactions.read).toBe(4);
    expect(report.sources.users.countedInCountries).toBe(3);
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toEqual({
      network: 'scroll',
      chainId: SCROLL_CHAIN,
      status: 'complete',
      wallets: 2,
      walletsRead: 2,
      calls: 1,
      failedCalls: 0,
      b2cEnabled: false,
      analyticsVisible: true,
      collectBalances: true,
      attempted: true,
      endpointPresent: true,
      reason: null,
      native: 'included',
      unpricedAssets: 0,
      startedAt: DAY_TWO.toISOString(),
      finishedAt: DAY_TWO.toISOString(),
      durationMs: 0,
      takenAt: DAY_TWO.toISOString(),
      lastSuccessAt: DAY_TWO.toISOString()
    });
    const scroll = buildOverview('scroll', 'month', DAY_TWO);
    expect(scroll.byNetwork).toMatchObject([
      { network: 'scroll', volumeUsd: '700.00', transactions: 2 }
    ]);
    expect(scroll.topCountries).toMatchObject({ availability: 'available', totalUsers: 2 });
    expect(scroll.tvl).toMatchObject({ availability: 'available', value: { value: '2.00' } });
    expect(scroll.tvl.byNetwork).toMatchObject([
      { network: 'scroll', status: 'complete', reason: null, lastSuccessAt: DAY_TWO.toISOString() }
    ]);
  });

  it('keeps a token disabled in B2C in the catalog copy and in the snapshots', async () => {
    catalogWith(false);
    const repository = new MemoryIngestRepository();
    await ingestAt(DAY_ONE, b2cReader(false), repository, new RecordingBalanceReader());
    repository.settings.uncollectedChainIds = [SCROLL_CHAIN];
    await ingestAt(DAY_TWO, b2cReader(false), repository, new RecordingBalanceReader());

    // The B2C token list is read whatever its `enabled`; the Scroll USDC stays copied.
    expect(repository.tokenCopies).toContainEqual(SCROLL_TOKEN);
    expect(repository.snapshotCopies.get(DAY_ONE.getTime())?.balances?.holdings).toContainEqual({
      network: 'scroll',
      asset: 'USDC',
      amount: '2.0',
      valueCents: 200
    });
  });

  it('answers Scroll balances as not read when the settings stop its reads, and All as partial', async () => {
    catalogWith(false);
    const repository = new MemoryIngestRepository();
    repository.settings.uncollectedChainIds = [SCROLL_CHAIN];
    const balances = new RecordingBalanceReader();
    const report = await ingestAt(DAY_TWO, b2cReader(false), repository, balances);

    const scroll = buildOverview('scroll', 'month', DAY_TWO);
    const all = buildOverview('all', 'month', DAY_TWO);
    const revenue = buildRevenue('scroll', 'month', DAY_TWO);

    expect(balances.urls()).toEqual([BASE_RPC]);
    expect(report.status).toBe('completed');
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'unsupported',
      calls: 0,
      collectBalances: false,
      attempted: false,
      endpointPresent: true,
      reason: 'collection_off'
    });
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
        reason: 'collection_off',
        lastSuccessAt: null
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
      value: { value: '2.00', previous: null, changeRatio: null },
      coverage: { wallets: 4, walletsRead: 2 },
      lastComplete: null
    });
    expect(all.tvl.byNetwork.map((row) => [row.network, row.tvlUsd])).toEqual([
      ['base-sepolia', '2.00'],
      ['scroll', null]
    ]);
    expect(all.topTokens).toMatchObject({
      availability: 'partial',
      totalUsd: '2.00',
      items: [{ asset: 'USDC', valueUsd: '2.00', share: '1.0000' }]
    });
  });

  it('keeps the other subtotal and the last Scroll reading when its RPC is down', async () => {
    const repository = new MemoryIngestRepository();
    catalogWith(false);
    await ingestAt(DAY_ONE, b2cReader(false), repository, new RecordingBalanceReader());
    const balances = new RecordingBalanceReader(new Set([SCROLL_RPC]));
    const report = await ingestAt(DAY_TWO, b2cReader(false), repository, balances);

    const all = buildOverview('all', 'month', DAY_TWO).tvl;
    const scroll = buildOverview('scroll', 'month', DAY_TWO).tvl;

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(report.status).toBe('completed');
    expect(report.sources.balances.status).toBe('partial');
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'failed',
      walletsRead: 0,
      calls: 1,
      failedCalls: 1,
      attempted: true,
      reason: 'rpc_failed',
      lastSuccessAt: DAY_ONE.toISOString()
    });
    expect(repository.snapshotCopies.size).toBe(2);
    const first = repository.snapshotCopies.get(DAY_ONE.getTime());
    expect(first?.balances?.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      walletsRead: 2
    });
    expect(all).toMatchObject({
      availability: 'partial',
      reason: 'partial_coverage',
      value: { value: '2.00', previous: null, changeRatio: null }
    });
    expect(all.byNetwork.find((row) => row.network === 'scroll')).toMatchObject({
      tvlUsd: null,
      status: 'failed',
      reason: 'rpc_failed',
      lastSuccessAt: DAY_ONE.toISOString()
    });
    expect(scroll).toMatchObject({ availability: 'unavailable', reason: 'not_read', value: null });
    expect(scroll.asOf).toBe(DAY_TWO.toISOString());
    expect(scroll.series.filter((point) => point.tvlUsd !== null)).toEqual([
      expect.objectContaining({ tvlUsd: '2.00', asOf: DAY_ONE.toISOString() })
    ]);
    expect(scroll.lastComplete).toEqual({ asOf: DAY_ONE.toISOString(), valueUsd: '2.00' });
  });

  it('serves no dated history for Scroll when no earlier reading of it was complete', async () => {
    const repository = new MemoryIngestRepository();
    catalogWith(false);
    // Without the native coin in its list nor a signer, the Scroll reading is a subtotal.
    await ingestAt(DAY_ONE, b2cReader(false, false), repository, new RecordingBalanceReader(), []);
    repository.settings.uncollectedChainIds = [SCROLL_CHAIN];
    const balances = new RecordingBalanceReader();
    await ingestAt(DAY_TWO, b2cReader(false, false), repository, balances, []);

    const scroll = buildOverview('scroll', 'month', DAY_TWO).tvl;

    expect(balances.urls()).toEqual([BASE_RPC]);
    expect(repository.snapshotCopies.get(DAY_ONE.getTime())?.balances?.networks).toContainEqual(
      expect.objectContaining({ network: 'scroll', status: 'complete', native: 'not_listed' })
    );
    expect(scroll).toMatchObject({
      availability: 'unavailable',
      reason: 'not_read',
      value: null,
      lastComplete: null
    });
    // Every wallet was read on the first day: an observation, though not a complete valuation.
    expect(scroll.byNetwork).toMatchObject([
      { network: 'scroll', reason: 'collection_off', lastSuccessAt: DAY_ONE.toISOString() }
    ]);
  });

  it('compares All networks only between complete snapshots', async () => {
    const repository = new MemoryIngestRepository();
    const yesterday = new Date('2026-10-23T03:00:00.000Z');
    catalogWith(false);
    await ingestAt(yesterday, b2cReader(false), repository, new RecordingBalanceReader());
    const down = new RecordingBalanceReader(new Set([SCROLL_RPC]));
    await ingestAt(DAY_TWO, b2cReader(false), repository, down);

    const now = new Date('2026-10-24T12:00:00.000Z');
    const all = buildOverview('all', 'today', now).tvl;
    const base = buildOverview('base-sepolia', 'today', now).tvl;
    const scroll = buildOverview('scroll', 'today', now).tvl;

    // The previous day read Scroll as well: a change against it would compare a total with a
    // subtotal of fewer networks.
    expect(all).toMatchObject({
      availability: 'partial',
      value: { value: '2.00', previous: null, changeRatio: null }
    });
    expect(base).toMatchObject({
      availability: 'available',
      value: { value: '2.00', previous: '2.00', changeRatio: '0.0000' }
    });
    // The earlier Scroll reading is history: no current value and no change against it.
    expect(scroll).toMatchObject({ availability: 'unavailable', value: null });
  });

  it('reads Scroll again once the settings collect it, without losing the earlier runs', async () => {
    const repository = new MemoryIngestRepository();
    catalogWith(false);
    repository.settings.uncollectedChainIds = [SCROLL_CHAIN];
    await ingestAt(DAY_ONE, b2cReader(false), repository, new RecordingBalanceReader());
    repository.settings.uncollectedChainIds = [];
    const balances = new RecordingBalanceReader();
    const report = await ingestAt(DAY_TWO, b2cReader(false), repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC]);
    expect(report.sources.balances.networks.find((row) => row.network === 'scroll')).toMatchObject({
      status: 'complete',
      b2cEnabled: false,
      collectBalances: true,
      reason: null
    });
    expect(repository.snapshotCopies.size).toBe(2);
    expect(buildOverview('scroll', 'month', DAY_TWO).tvl).toMatchObject({
      availability: 'available',
      value: { value: '2.00' }
    });
  });

  it('keeps reading Scroll while hidden and serves its snapshots again once shown', async () => {
    catalogWith(false);
    const repository = new MemoryIngestRepository();
    repository.settings.hiddenChainIds = [SCROLL_CHAIN];
    const balances = new RecordingBalanceReader();

    await ingestAt(DAY_ONE, b2cReader(false), repository, balances);
    const report = await ingestAt(DAY_TWO, b2cReader(false), repository, balances);

    expect(balances.urls()).toEqual([BASE_RPC, SCROLL_RPC, BASE_RPC, SCROLL_RPC]);
    expect(
      report.sources.balances.networks.map((row) => [row.network, row.analyticsVisible])
    ).toEqual([
      ['base-sepolia', true],
      ['scroll', false]
    ]);
    expect(buildOverview('all', 'month', DAY_TWO, ['base-sepolia']).tvl).toMatchObject({
      availability: 'available',
      value: { value: '2.00' }
    });
    // Shown again: both runs of the hidden period are there, nothing was deleted.
    repository.settings.hiddenChainIds = [];
    const scroll = buildOverview('scroll', 'month', DAY_TWO).tvl;
    expect(scroll).toMatchObject({ availability: 'available', value: { value: '2.00' } });
    expect(
      scroll.series.filter((point) => point.tvlUsd !== null).map((point) => point.asOf)
    ).toEqual([DAY_ONE.toISOString(), DAY_TWO.toISOString()]);
  });

  it('shows All networks complete once the uncollected Scroll is hidden, and partial when shown', async () => {
    catalogWith(false);
    const repository = new MemoryIngestRepository();
    repository.settings.uncollectedChainIds = [SCROLL_CHAIN];
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

  it('keeps the activity and history of a network B2C drops, without a current reading', async () => {
    catalogWith(true);
    const repository = new MemoryIngestRepository();
    await ingestAt(DAY_ONE, b2cReader(true), repository, new RecordingBalanceReader());
    // B2C drops Scroll; the analytics database retains it because copied rows use it.
    const dropped = new FakeReader(activity(), USERS, [BASE_USDC], [BASE], [BASE_ENDPOINT]);
    setNetworks(mergeCatalog(toNetworkDefinitions([]), repository.chainCopies));
    resetFactsCaches();
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
      attempted: false,
      endpointPresent: false,
      reason: 'source_absent',
      lastSuccessAt: DAY_ONE.toISOString()
    });
    const scroll = buildOverview('scroll', 'month', DAY_TWO);
    expect(scroll.byNetwork).toMatchObject([
      { network: 'scroll', volumeUsd: '700.00', transactions: 2 }
    ]);
    expect(scroll.tvl).toMatchObject({
      availability: 'unavailable',
      reason: 'not_read',
      value: null,
      lastComplete: { asOf: DAY_ONE.toISOString(), valueUsd: '2.00' }
    });
    expect(repository.snapshotCopies.size).toBe(2);
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
