import { describe, expect, it } from 'vitest';
import {
  decodeAggregate3,
  encodeAggregate3,
  isBlockfrost,
  KOIOS_BATCH_SIZE,
  MULTICALL_BATCH_SIZE,
  MULTICALL3_ADDRESS,
  rpcBalanceReader
} from '../src/ingest/balance-reader.js';
import type { CallBudget, EvmBalanceQuery } from '../src/ingest/types.js';

const HOLDER = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x1111111111111111111111111111111111111111';
const NOW = 1_000_000;

function w(value: number | bigint): string {
  return value.toString(16).padStart(64, '0');
}

/** ABI encoding of the `(bool success, bytes returnData)[]` result of `aggregate3`. */
function aggregateResult(entries: ReadonlyArray<{ success: boolean; value: bigint | null }>) {
  const tuples = entries.map((entry) => {
    const data = entry.value === null ? '' : w(entry.value);
    return w(entry.success ? 1 : 0) + w(0x40) + w(data.length / 2) + data;
  });
  const offsets: string[] = [];
  let offset = entries.length * 32;
  for (const tuple of tuples) {
    offsets.push(w(offset));
    offset += tuple.length / 2;
  }
  return `0x${w(0x20)}${w(entries.length)}${offsets.join('')}${tuples.join('')}`;
}

function budget(remaining: number, deadline = NOW + 60_000): CallBudget {
  return { remaining, deadline, used: 0, failed: 0 };
}

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { params?: Array<{ data?: string }>; _addresses?: string[] };
}

/** Fetch fake: `answer` receives each request in order and returns status and JSON body. */
function fakeFetch(answer: (sent: Sent, index: number) => { status: number; json: unknown }) {
  const sent: Sent[] = [];
  const impl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => {
    const request = {
      url,
      method: init.method,
      headers: init.headers,
      body: (init.body === undefined ? {} : JSON.parse(init.body)) as Sent['body']
    };
    sent.push(request);
    const { status, json } = answer(request, sent.length - 1);
    return new Response(JSON.stringify(json), { status });
  };
  return { sent, impl };
}

/** Number of calls in an `aggregate3` call data. */
function callCount(data: string): number {
  return Number.parseInt(data.slice(10 + 64, 10 + 128), 16);
}

describe('aggregate3 encoding', () => {
  it('encodes one call with allowFailure as the ABI tuple array', () => {
    const callData = `70a08231${w(BigInt(HOLDER))}`;

    expect(encodeAggregate3([{ target: TOKEN, callData }])).toBe(
      `0x82ad56cb${w(0x20)}${w(1)}${w(0x20)}${w(BigInt(TOKEN))}${w(1)}${w(0x60)}${w(36)}${callData.padEnd(128, '0')}`
    );
  });

  it('decodes successes, failures and empty return data', () => {
    const result = aggregateResult([
      { success: true, value: 1234n },
      { success: false, value: null },
      { success: true, value: 0n }
    ]);

    expect(decodeAggregate3(result)).toEqual([
      { success: true, data: w(1234n) },
      { success: false, data: '' },
      { success: true, data: w(0n) }
    ]);
  });

  it('rejects malformed results', () => {
    expect(() => decodeAggregate3('0x1234')).toThrowError(/Malformed/);
    expect(() => decodeAggregate3(`0x${w(0x20)}${w(5)}`)).toThrowError(/Malformed/);
    expect(() => decodeAggregate3(`0x${'zz'.repeat(64)}`)).toThrowError(/Malformed/);
  });
});

describe('rpcBalanceReader.evm', () => {
  const queries = (count: number): EvmBalanceQuery[] =>
    Array.from({ length: count }, (_, index) => ({
      holder: HOLDER,
      token: index % 2 === 0 ? TOKEN : null
    }));

  it('sends one eth_call to Multicall3 per batch and reads the balances', async () => {
    const fetch = fakeFetch(({ body }) => {
      const count = callCount(body.params?.[0]?.data ?? '');
      return {
        status: 200,
        json: {
          result: aggregateResult(
            Array.from({ length: count }, (_, index) => ({
              success: true,
              value: BigInt(index + 1)
            }))
          )
        }
      };
    });
    const reader = rpcBalanceReader(fetch.impl, () => NOW);
    const spent = budget(10);

    const results = await reader.evm('https://rpc.test', queries(MULTICALL_BATCH_SIZE + 3), spent);

    expect(fetch.sent).toHaveLength(2);
    expect(fetch.sent[0]?.body.params?.[0]).toMatchObject({ to: MULTICALL3_ADDRESS });
    expect(results).toHaveLength(MULTICALL_BATCH_SIZE + 3);
    expect(results[0]).toBe(1n);
    expect(results[MULTICALL_BATCH_SIZE]).toBe(1n);
    expect(results.at(-1)).toBe(3n);
    expect(spent).toMatchObject({ remaining: 8, used: 2, failed: 0 });
  });

  it('leaves a failed batch unread and keeps the other batches', async () => {
    const fetch = fakeFetch((request, index) =>
      index === 0
        ? { status: 500, json: { error: 'boom' } }
        : {
            status: 200,
            json: {
              result: aggregateResult(
                Array.from({ length: callCount(request.body.params?.[0]?.data ?? '') }, () => ({
                  success: true,
                  value: 7n
                }))
              )
            }
          }
    );
    const spent = budget(10);

    const results = await rpcBalanceReader(fetch.impl, () => NOW).evm(
      'https://rpc.test',
      queries(MULTICALL_BATCH_SIZE + 1),
      spent
    );

    expect(results.slice(0, MULTICALL_BATCH_SIZE).every((value) => value === null)).toBe(true);
    expect(results.at(-1)).toBe(7n);
    expect(spent).toMatchObject({ used: 2, failed: 1 });
  });

  it('leaves a reverted call unread', async () => {
    const fetch = fakeFetch(() => ({
      status: 200,
      json: {
        result: aggregateResult([
          { success: false, value: null },
          { success: true, value: 5n }
        ])
      }
    }));

    const results = await rpcBalanceReader(fetch.impl, () => NOW).evm(
      'https://rpc.test',
      queries(2),
      budget(1)
    );

    expect(results).toEqual([null, 5n]);
  });

  it('stops at the call budget and at the deadline', async () => {
    const fetch = fakeFetch(() => ({ status: 200, json: { result: aggregateResult([]) } }));
    const reader = rpcBalanceReader(fetch.impl, () => NOW);

    const noBudget = budget(0);
    expect(await reader.evm('https://rpc.test', queries(2), noBudget)).toEqual([null, null]);
    const late = budget(5, NOW);
    expect(await reader.evm('https://rpc.test', queries(2), late)).toEqual([null, null]);

    expect(fetch.sent).toHaveLength(0);
    expect(noBudget.used + late.used).toBe(0);
  });
});

describe('rpcBalanceReader.cardano', () => {
  const ADDRESS = 'addr_test1qpaaa';
  const UNIT_POLICY = 'b'.repeat(56);

  function utxo(address: string, lovelace: string, assets: Array<[string, string]> = []) {
    return {
      address,
      value: lovelace,
      is_spent: false,
      asset_list: assets.map(([name, quantity]) => ({
        policy_id: UNIT_POLICY,
        asset_name: name,
        quantity
      }))
    };
  }

  it('sums the unspent outputs of every page per address', async () => {
    const fetch = fakeFetch((_request, index) => ({
      status: 200,
      json:
        index === 0
          ? Array.from({ length: 1000 }, () => utxo(ADDRESS, '1000000', [['5553', '2']]))
          : [utxo(ADDRESS, '500000'), { ...utxo(ADDRESS, '9'), is_spent: true }]
    }));
    const spent = budget(5);

    const holdings = await rpcBalanceReader(fetch.impl, () => NOW).cardano(
      'https://koios.test/api/v1/',
      [ADDRESS],
      spent
    );

    expect(fetch.sent.map((request) => request.url)).toEqual([
      'https://koios.test/api/v1/address_utxos?offset=0&limit=1000',
      'https://koios.test/api/v1/address_utxos?offset=1000&limit=1000'
    ]);
    expect(fetch.sent[0]?.body._addresses).toEqual([ADDRESS]);
    expect(holdings.get(ADDRESS)?.lovelace).toBe(1_000_500_000n);
    expect(holdings.get(ADDRESS)?.assets.get(`${UNIT_POLICY}5553`)).toBe(2000n);
    expect(spent.used).toBe(2);
  });

  it('drops a batch whose pages were not all read', async () => {
    const fetch = fakeFetch(() => ({
      status: 200,
      json: Array.from({ length: 1000 }, () => utxo(ADDRESS, '1'))
    }));
    const spent = budget(1);

    const holdings = await rpcBalanceReader(fetch.impl, () => NOW).cardano(
      'https://koios.test/api/v1',
      [ADDRESS],
      spent
    );

    expect(holdings.size).toBe(0);
    expect(spent.used).toBe(1);
  });

  it('keeps the batches that answered when another fails', async () => {
    const addresses = Array.from({ length: KOIOS_BATCH_SIZE + 1 }, (_, index) => `addr_${index}`);
    const fetch = fakeFetch((_request, index) =>
      index === 0
        ? { status: 429, json: [] }
        : { status: 200, json: [utxo(`addr_${KOIOS_BATCH_SIZE}`, '42')] }
    );
    const spent = budget(5);

    const holdings = await rpcBalanceReader(fetch.impl, () => NOW).cardano(
      'https://koios.test/api/v1',
      addresses,
      spent
    );

    expect([...holdings.keys()]).toEqual([`addr_${KOIOS_BATCH_SIZE}`]);
    expect(holdings.get(`addr_${KOIOS_BATCH_SIZE}`)?.lovelace).toBe(42n);
    expect(spent).toMatchObject({ used: 2, failed: 1 });
  });

  it('reads Blockfrost only with a project key, telling the provider by its host', () => {
    const withoutKey = rpcBalanceReader();
    const withKey = rpcBalanceReader(fetch, Date.now, 'project-key');

    expect(withoutKey.supportsCardano('https://preprod.koios.rest/api/v1')).toBe(true);
    expect(withoutKey.supportsCardano('https://cardano-preprod.blockfrost.io/api/v0')).toBe(false);
    expect(withKey.supportsCardano('https://cardano-preprod.blockfrost.io/api/v0')).toBe(true);
    expect(isBlockfrost('https://koios.test/api/v1?via=blockfrost')).toBe(false);
  });

  it('reads each address from Blockfrost with the project key, an unseen address as empty', async () => {
    const fetch = fakeFetch((request) =>
      request.url.endsWith('/addr_new')
        ? { status: 404, json: { status_code: 404 } }
        : {
            status: 200,
            json: {
              amount: [
                { unit: 'lovelace', quantity: '2500000' },
                { unit: `${UNIT_POLICY}5553`, quantity: '7' }
              ]
            }
          }
    );
    const spent = budget(5);

    const holdings = await rpcBalanceReader(fetch.impl, () => NOW, 'project-key').cardano(
      'https://cardano-preprod.blockfrost.io/api/v0/',
      [ADDRESS, 'addr_new'],
      spent
    );

    expect(fetch.sent.map((request) => [request.method, request.url])).toEqual([
      ['GET', `https://cardano-preprod.blockfrost.io/api/v0/addresses/${ADDRESS}`],
      ['GET', 'https://cardano-preprod.blockfrost.io/api/v0/addresses/addr_new']
    ]);
    expect(fetch.sent[0]?.headers.project_id).toBe('project-key');
    expect(holdings.get(ADDRESS)?.lovelace).toBe(2_500_000n);
    expect(holdings.get(ADDRESS)?.assets.get(`${UNIT_POLICY}5553`)).toBe(7n);
    expect(holdings.get('addr_new')).toEqual({ lovelace: 0n, assets: new Map() });
    expect(spent).toMatchObject({ used: 2, failed: 0 });
  });

  it('leaves Blockfrost addresses unread after two failures in a row and without a key', async () => {
    const fetch = fakeFetch(() => ({ status: 403, json: {} }));
    const spent = budget(5);

    const failed = await rpcBalanceReader(fetch.impl, () => NOW, 'bad-key').cardano(
      'https://cardano-preprod.blockfrost.io/api/v0',
      [ADDRESS, 'addr_b', 'addr_c'],
      spent
    );
    const keyless = await rpcBalanceReader(fetch.impl, () => NOW).cardano(
      'https://cardano-preprod.blockfrost.io/api/v0',
      [ADDRESS],
      spent
    );

    expect(failed.size).toBe(0);
    expect(keyless.size).toBe(0);
    expect(fetch.sent).toHaveLength(2);
    expect(spent).toMatchObject({ used: 2, failed: 2 });
  });
});
