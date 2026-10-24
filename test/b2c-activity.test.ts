import { Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { COINGECKO_SIMPLE_PRICE_URL, coingeckoPriceProvider } from '../src/ingest/coingecko.js';
import { toIngestedTransaction, toIngestedUser } from '../src/store/b2c-activity.js';

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

  it('copies the id, signup date and wallets of a user only', () => {
    const id = new ObjectId();

    expect(
      toIngestedUser({
        _id: id,
        creationDate: new Date('2026-10-11T23:41:07.615Z'),
        wallets: [
          { chain_id: 84532, wallet_proxy: '0x12b4' },
          { chain_id: Long.fromString('900000000001'), wallet_proxy: 'addr_test1q' },
          { chain_id: 84532 }
        ]
      })
    ).toEqual({
      id: id.toHexString(),
      createdAt: new Date('2026-10-11T23:41:07.615Z'),
      wallets: [
        { chainId: '84532', address: '0x12b4' },
        { chainId: '900000000001', address: 'addr_test1q' }
      ]
    });
    expect(toIngestedUser({ _id: id }).createdAt).toBeNull();
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
