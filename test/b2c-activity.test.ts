import { type Db, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { COINGECKO_SIMPLE_PRICE_URL, coingeckoPriceProvider } from '../src/ingest/coingecko.js';
import {
  countryOfPhone,
  MongoB2cActivityReader,
  toIngestedTransaction,
  toIngestedUser,
  UNKNOWN_COUNTRY
} from '../src/store/b2c-activity.js';

describe('B2C activity mapping', () => {
  it('copies a transaction with a Long chain id', () => {
    const id = new ObjectId();
    const date = new Date('2026-10-12T00:34:19.701Z');

    expect(
      toIngestedTransaction({
        _id: id,
        trx_hash: '0xabc',
        wallet_from: 'addr_test1a',
        wallet_to: 'addr_test1b',
        type: 'transfer',
        status: 'completed',
        date,
        amount: 12.5,
        fee: 0.1,
        token: 'ADA',
        chain_id: Long.fromString('900000000001')
      })
    ).toEqual({
      id: id.toHexString(),
      hash: '0xabc',
      from: 'addr_test1a',
      to: 'addr_test1b',
      type: 'transfer',
      status: 'completed',
      date,
      amount: 12.5,
      fee: 0.1,
      token: 'ADA',
      chainId: '900000000001'
    });
  });

  it('skips a transaction without a date', () => {
    expect(toIngestedTransaction({ _id: new ObjectId(), type: 'transfer' })).toBeNull();
  });

  it('copies the id, signup date and wallets of a user, and only the country of its phone', () => {
    const id = new ObjectId();

    expect(
      toIngestedUser({
        _id: id,
        creationDate: new Date('2026-10-11T23:41:07.615Z'),
        phone_number: '5491151234567',
        wallets: [
          { chain_id: 84532, wallet_proxy: '0x12b4' },
          { chain_id: Long.fromString('900000000001'), wallet_proxy: 'addr_test1q' },
          { chain_id: 84532 }
        ]
      })
    ).toEqual({
      id: id.toHexString(),
      createdAt: new Date('2026-10-11T23:41:07.615Z'),
      country: 'AR',
      wallets: [
        { chainId: '84532', address: '0x12b4' },
        { chainId: '900000000001', address: 'addr_test1q' }
      ]
    });
    expect(toIngestedUser({ _id: id }).createdAt).toBeNull();
  });

  it('estimates the country from the calling code, or Unknown', () => {
    expect(countryOfPhone('5491151234567')).toBe('AR');
    expect(countryOfPhone('+52 1 55 1234 5678')).toBe('MX');
    expect(countryOfPhone('14165551234')).toBe('CA');
    expect(countryOfPhone('12025550123')).toBe('US');
    expect(countryOfPhone('5511987654321')).toBe('BR');
    expect(countryOfPhone('999123456789')).toBe(UNKNOWN_COUNTRY);
    expect(countryOfPhone('123')).toBe(UNKNOWN_COUNTRY);
    expect(countryOfPhone(undefined)).toBe(UNKNOWN_COUNTRY);
  });
});

/** Database fake that serves fixed documents per collection and records the filters it got. */
function fakeDb(collections: Record<string, Record<string, unknown>[]>) {
  const filters: Array<{ collection: string; filter: unknown }> = [];
  const db = {
    collection: (name: string) => ({
      find: (filter: unknown) => {
        filters.push({ collection: name, filter });
        return { toArray: async () => collections[name] ?? [] };
      }
    })
  };
  return { db: db as unknown as Db, filters };
}

describe('B2C catalog reads', () => {
  it('reads networks and tokens disabled for new B2C operations', async () => {
    const { db, filters } = fakeDb({
      blockchains: [
        { name: 'Base', chainId: 8453, enabled: true, explorer: 'https://basescan.org' },
        {
          name: 'Scroll',
          chainId: 534352,
          enabled: false,
          explorer: 'https://scrollscan.com',
          contracts: { factoryAddress: '0xFactory' }
        }
      ],
      tokens: [
        { chain_id: 534352, symbol: 'USDC', type: 'stable', enabled: false, decimals: 6 },
        { chain_id: 8453, symbol: 'USDC', type: 'stable', enabled: true, decimals: 6 }
      ]
    });
    const reader = new MongoB2cActivityReader(db);

    const chains = await reader.chains();
    const tokens = await reader.tokens();

    expect(chains).toContainEqual({
      chainId: '534352',
      network: 'scroll',
      name: 'Scroll',
      family: 'evm',
      explorer: 'https://scrollscan.com',
      contracts: { factoryAddress: '0xFactory' }
    });
    expect(tokens.map((token) => token.chainId)).toEqual(['534352', '8453']);
    expect(filters.every((item) => JSON.stringify(item.filter) === '{}')).toBe(true);
  });

  it('reads the B2C enabled of each network, null without a boolean', async () => {
    const { db } = fakeDb({
      blockchains: [
        { name: 'Base', chainId: 8453, enabled: true },
        { name: 'Scroll', chainId: 534352, enabled: false },
        { name: 'Arbitrum Sepolia', chainId: 421614 },
        { name: 'Optimism', chainId: 10, enabled: 'yes' },
        { name: 'Solana', family: 'solana', chainId: 101, enabled: true }
      ]
    });

    const enabled = await new MongoB2cActivityReader(db).b2cEnabled();

    expect([...enabled.entries()].sort()).toEqual([
      ['10', null],
      ['421614', null],
      ['534352', false],
      ['8453', true]
    ]);
  });
});

describe('CoinGecko provider', () => {
  it('requests every known symbol in one call', async () => {
    const urls: string[] = [];
    const provider = coingeckoPriceProvider(async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ ethereum: { usd: 2500 }, bitcoin: { usd: 100000 } }));
    });

    expect(await provider.current(['WETH', 'WBTC', 'UNKNOWN'])).toEqual({
      WETH: 2500,
      WBTC: 100000
    });
    expect(urls).toEqual([
      `${COINGECKO_SIMPLE_PRICE_URL}?ids=bitcoin%2Cethereum&vs_currencies=usd`
    ]);
  });

  it('sends nothing without known symbols and fails on an error status', async () => {
    let calls = 0;
    const provider = coingeckoPriceProvider(async () => {
      calls += 1;
      return new Response('', { status: 429 });
    });

    expect(await provider.current(['UNKNOWN'])).toEqual({});
    expect(calls).toBe(0);
    await expect(provider.current(['ADA'])).rejects.toThrowError(/429/);
  });
});
