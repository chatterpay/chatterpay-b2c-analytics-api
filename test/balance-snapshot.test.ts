import { describe, expect, it } from 'vitest';
import { type SnapshotInput, takeBalanceSnapshot } from '../src/ingest/snapshot.js';
import type { CallBudget, IngestedUser } from '../src/ingest/types.js';
import {
  CHAINS,
  ENDPOINTS,
  FakeBalanceReader,
  TOKEN_ADDRESSES,
  TOKENS,
  USDCX_UNIT
} from './ingest-fakes.js';

const USERS: IngestedUser[] = [
  {
    id: 'u1',
    createdAt: null,
    wallets: [
      { chainId: '84532', address: '0xUserA' },
      { chainId: '900000000001', address: 'addr_test1a' }
    ]
  },
  { id: 'u2', createdAt: null, wallets: [{ chainId: '84532', address: '0xuserb' }] },
  // Same wallet as u1 in another case: read once.
  { id: 'u3', createdAt: null, wallets: [{ chainId: '84532', address: '0xUSERA' }] }
];

const SIGNER = '0x9999999999999999999999999999999999999999';

const EVM_BALANCES: Record<string, bigint> = {
  [`0xusera|${TOKEN_ADDRESSES.USDC}`]: 2_500_000n,
  [`0xuserb|${TOKEN_ADDRESSES.USDC}`]: 500_000n,
  [`0xusera|${TOKEN_ADDRESSES.WETH}`]: 1_000_000_000_000_000n,
  [`0xuserb|${TOKEN_ADDRESSES.WBTC}`]: 10_000n,
  [`${SIGNER}|native`]: 2_000_000_000_000_000_000n,
  [`${SIGNER}|${TOKEN_ADDRESSES.USDC}`]: 1_000_000n
};

const CARDANO_BALANCES = {
  addr_test1a: { lovelace: 3_000_000n, assets: new Map([[USDCX_UNIT, 1_000_000n]]) }
};

function budget(remaining = 50): CallBudget {
  return { remaining, deadline: Number.MAX_SAFE_INTEGER, used: 0, failed: 0 };
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    reader: new FakeBalanceReader(EVM_BALANCES, CARDANO_BALANCES),
    endpoints: ENDPOINTS,
    chains: CHAINS,
    tokens: TOKENS,
    users: USERS,
    masterWallets: [],
    prices: new Map([
      ['WETH', 2500],
      ['ADA', 0.5],
      ['ETH', 3000]
    ]),
    b2cEnabled: new Map(CHAINS.map((chain) => [chain.chainId, true])),
    budget: budget(),
    ...overrides
  };
}

describe('takeBalanceSnapshot', () => {
  it('sums the user wallets per network and asset at the prices of the day', async () => {
    const { snapshot, status } = await takeBalanceSnapshot(input());

    // The status covers the reads; an asset without price is left to the holdings figures.
    expect(status).toBe('complete');
    // The Base Sepolia token list has no native coin; ADA is always read on Cardano.
    expect(snapshot.networks).toEqual([
      {
        network: 'base-sepolia',
        status: 'complete',
        wallets: 2,
        walletsRead: 2,
        calls: 1,
        failedCalls: 0,
        b2cEnabled: true,
        reason: null,
        native: 'not_listed'
      },
      {
        network: 'cardano-preprod',
        status: 'complete',
        wallets: 1,
        walletsRead: 1,
        calls: 1,
        failedCalls: 0,
        b2cEnabled: true,
        reason: null,
        native: 'included'
      }
    ]);
    expect(snapshot.holdings).toEqual([
      { network: 'base-sepolia', asset: 'USDC', amount: '3.0', valueCents: 300 },
      { network: 'base-sepolia', asset: 'WETH', amount: '0.001', valueCents: 250 },
      { network: 'base-sepolia', asset: 'WBTC', amount: '0.0001', valueCents: null },
      { network: 'cardano-preprod', asset: 'ADA', amount: '3.0', valueCents: 150 },
      { network: 'cardano-preprod', asset: 'USDCx', amount: '1.0', valueCents: 100 }
    ]);
  });

  it('leaves a wallet out of the totals when one of its balances was not read', async () => {
    const reader = new FakeBalanceReader(EVM_BALANCES, CARDANO_BALANCES, new Set(['0xuserb']));

    const { snapshot, status } = await takeBalanceSnapshot(input({ reader }));

    expect(status).toBe('partial');
    expect(snapshot.networks[0]).toEqual({
      network: 'base-sepolia',
      status: 'partial',
      wallets: 2,
      walletsRead: 1,
      calls: 1,
      failedCalls: 0,
      b2cEnabled: true,
      reason: 'read_incomplete',
      native: 'not_listed'
    });
    expect(snapshot.holdings.find((holding) => holding.asset === 'USDC')?.valueCents).toBe(250);
    expect(snapshot.holdings.some((holding) => holding.asset === 'WBTC')).toBe(false);
  });

  it('marks a network without endpoint or with Blockfrost as unsupported', async () => {
    const { snapshot, status } = await takeBalanceSnapshot(
      input({
        endpoints: [
          { chainId: '900000000001', family: 'cardano', url: 'https://x.blockfrost.io/api/v0' }
        ]
      })
    );

    expect(snapshot.networks.map((row) => [row.network, row.status, row.walletsRead])).toEqual([
      ['base-sepolia', 'unsupported', 0],
      ['cardano-preprod', 'unsupported', 0]
    ]);
    expect(snapshot.holdings).toEqual([]);
    expect(status).toBe('failed');
  });

  it('fails the networks the call budget did not reach', async () => {
    const { snapshot, status } = await takeBalanceSnapshot(input({ budget: budget(0) }));

    expect(snapshot.networks.every((row) => row.status === 'failed')).toBe(true);
    expect(status).toBe('failed');
  });

  it('reads a placeholder contract as the native coin and skips tokens without decimals', async () => {
    const reader = new FakeBalanceReader({
      ...EVM_BALANCES,
      '0xusera|native': 500_000_000_000_000_000n
    });
    const { snapshot } = await takeBalanceSnapshot(
      input({
        reader,
        chains: CHAINS.slice(0, 1),
        tokens: [
          ...TOKENS.filter((token) => token.symbol === 'USDC'),
          {
            chainId: '84532',
            symbol: 'ETH',
            stable: false,
            address: '0x0000000000000000000000000000000000000000',
            decimals: 18
          },
          {
            chainId: '84532',
            symbol: 'USDT',
            stable: true,
            address: TOKEN_ADDRESSES.USDT,
            decimals: null
          }
        ]
      })
    );

    expect(snapshot.holdings).toEqual([
      { network: 'base-sepolia', asset: 'USDC', amount: '3.0', valueCents: 300 },
      { network: 'base-sepolia', asset: 'ETH', amount: '0.5', valueCents: 150_000 }
    ]);
    expect(snapshot.networks[0]?.native).toBe('included');
  });

  it('reports the native coin as included when the user holds none of it', async () => {
    const { snapshot } = await takeBalanceSnapshot(
      input({
        chains: CHAINS.slice(0, 1),
        tokens: [
          ...TOKENS,
          {
            chainId: '84532',
            symbol: 'ETH',
            stable: false,
            address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
            decimals: 18
          }
        ]
      })
    );

    // Read and zero: a measured zero, not a missing figure.
    expect(snapshot.networks[0]?.native).toBe('included');
    expect(snapshot.holdings.some((holding) => holding.asset === 'ETH')).toBe(false);
  });

  it('values nothing under the `none` valuation and keeps the amounts', async () => {
    const { snapshot } = await takeBalanceSnapshot(input({ valuation: 'none' }));

    expect(snapshot.valuation).toBe('none');
    expect(snapshot.holdings.map((holding) => holding.valueCents)).toEqual([
      null,
      null,
      null,
      null,
      null
    ]);
    expect(snapshot.holdings.map((holding) => holding.amount)).toEqual([
      '3.0',
      '0.001',
      '0.0001',
      '3.0',
      '1.0'
    ]);
  });

  it('reads master wallets with the native coin and links them to the explorer', async () => {
    const { snapshot } = await takeBalanceSnapshot(
      input({
        masterWallets: [
          { network: 'base-sepolia', address: SIGNER, role: 'Backend signer' },
          { network: 'cardano-preprod', address: 'addr_test1a', role: 'Cardano sponsor' }
        ]
      })
    );

    expect(snapshot.masterWallets).toEqual([
      {
        network: 'base-sepolia',
        role: 'Backend signer',
        address: SIGNER,
        explorerUrl: `https://sepolia.basescan.org/address/${SIGNER}`,
        status: 'complete',
        balances: [
          { asset: 'USDC', amount: '1.0', valueCents: 100 },
          { asset: 'ETH', amount: '2.0', valueCents: 600_000 }
        ]
      },
      {
        network: 'cardano-preprod',
        role: 'Cardano sponsor',
        address: 'addr_test1a',
        explorerUrl: 'https://preprod.cardanoscan.io/address/addr_test1a',
        status: 'complete',
        balances: [
          { asset: 'ADA', amount: '3.0', valueCents: 150 },
          { asset: 'USDCx', amount: '1.0', valueCents: 100 }
        ]
      }
    ]);
    // Master wallets are not user wallets: the user totals do not change.
    expect(snapshot.networks[0]?.wallets).toBe(2);
  });

  it('marks master wallets of unread or unsupported networks', async () => {
    const reader = new FakeBalanceReader(EVM_BALANCES, {}, new Set([SIGNER]));
    const { snapshot } = await takeBalanceSnapshot(
      input({
        reader,
        endpoints: ENDPOINTS.slice(0, 1),
        masterWallets: [
          { network: 'base-sepolia', address: SIGNER, role: 'Backend signer' },
          { network: 'cardano-preprod', address: 'addr_test1sponsor', role: 'Cardano sponsor' }
        ]
      })
    );

    expect(snapshot.masterWallets.map((wallet) => [wallet.status, wallet.balances])).toEqual([
      ['failed', []],
      ['unsupported', []]
    ]);
  });
});
