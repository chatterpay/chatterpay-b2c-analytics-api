import type { BalanceReader, CallBudget, CardanoHoldings, EvmBalanceQuery } from './types.js';

/** Multicall3, deployed at the same address on the EVM networks ChatterPay runs on. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** `aggregate3((address,bool,bytes)[])`. */
const AGGREGATE3_SELECTOR = '82ad56cb';
/** `balanceOf(address)` of ERC-20. */
const BALANCE_OF_SELECTOR = '70a08231';
/** `getEthBalance(address)` of Multicall3: the native balance of an address. */
const GET_ETH_BALANCE_SELECTOR = '4d2301cc';

/** Balance queries per `eth_call`; keeps the call data near 40 KB and the gas far below the caps. */
export const MULTICALL_BATCH_SIZE = 200;
/** Addresses per Koios request. */
export const KOIOS_BATCH_SIZE = 50;
/** Rows Koios returns per page at most. */
const KOIOS_PAGE_SIZE = 1000;
/** Pages read per Koios batch at most, so a provider that keeps answering full pages stops. */
const KOIOS_MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 15_000;

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<Response>;

function word(hex: string): string {
  return hex.padStart(64, '0');
}

function uintWord(value: number): string {
  return word(value.toString(16));
}

function addressWord(address: string): string {
  return word(address.slice(2).toLowerCase());
}

/** A call of an `aggregate3` batch; `callData` is hex without `0x`. */
export interface MulticallCall {
  target: string;
  callData: string;
}

/**
 * Encodes the call data of `aggregate3` with `allowFailure` set on every call, so one failing
 * token does not fail the batch.
 *
 * @param calls - Calls of the batch.
 * @returns Hex call data with `0x`.
 */
export function encodeAggregate3(calls: readonly MulticallCall[]): string {
  const tuples = calls.map((call) => {
    const length = call.callData.length / 2;
    const padded = call.callData.padEnd(Math.ceil(length / 32) * 64, '0');
    return addressWord(call.target) + uintWord(1) + uintWord(0x60) + uintWord(length) + padded;
  });
  const offsets: string[] = [];
  let offset = calls.length * 32;
  for (const tuple of tuples) {
    offsets.push(uintWord(offset));
    offset += tuple.length / 2;
  }
  return `0x${AGGREGATE3_SELECTOR}${uintWord(0x20)}${uintWord(calls.length)}${offsets.join('')}${tuples.join('')}`;
}

/**
 * Decodes the `(bool success, bytes returnData)[]` result of `aggregate3`.
 *
 * @param result - Hex result of the `eth_call`.
 * @returns One entry per call, `returnData` as hex without `0x`.
 * @throws {Error} When the result is malformed.
 */
export function decodeAggregate3(result: string): Array<{ success: boolean; data: string }> {
  const hex = result.startsWith('0x') ? result.slice(2) : result;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 128) {
    throw new Error('Malformed aggregate3 result');
  }
  const readWord = (byte: number): string => {
    const text = hex.slice(byte * 2, byte * 2 + 64);
    if (text.length !== 64) {
      throw new Error('Malformed aggregate3 result');
    }
    return text;
  };
  const readNumber = (byte: number): number => {
    const value = BigInt(`0x${readWord(byte)}`);
    if (value > BigInt(hex.length)) {
      throw new Error('Malformed aggregate3 result');
    }
    return Number(value);
  };
  const arrayStart = readNumber(0);
  const count = readNumber(arrayStart);
  const base = arrayStart + 32;
  const entries: Array<{ success: boolean; data: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const tuple = base + readNumber(base + index * 32);
    const success = BigInt(`0x${readWord(tuple)}`) !== 0n;
    const bytesAt = tuple + readNumber(tuple + 32);
    const length = readNumber(bytesAt);
    const data = hex.slice((bytesAt + 32) * 2, (bytesAt + 32 + length) * 2);
    if (data.length !== length * 2) {
      throw new Error('Malformed aggregate3 result');
    }
    entries.push({ success, data });
  }
  return entries;
}

function callOf(query: EvmBalanceQuery): MulticallCall {
  return query.token === null
    ? { target: MULTICALL3_ADDRESS, callData: GET_ETH_BALANCE_SELECTOR + addressWord(query.holder) }
    : { target: query.token, callData: BALANCE_OF_SELECTOR + addressWord(query.holder) };
}

/** Takes one request from the budget; `false` when it is spent or the deadline passed. */
function take(budget: CallBudget, now: number): boolean {
  if (budget.remaining <= 0 || now >= budget.deadline) {
    return false;
  }
  budget.remaining -= 1;
  budget.used += 1;
  return true;
}

interface KoiosUtxo {
  address?: unknown;
  value?: unknown;
  is_spent?: unknown;
  asset_list?: Array<{ policy_id?: unknown; asset_name?: unknown; quantity?: unknown }> | null;
}

function bigintOf(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error('Malformed amount');
}

/**
 * {@link BalanceReader} over HTTPS: Multicall3 `aggregate3` through `eth_call` on EVM networks, and
 * the Koios `address_utxos` endpoint on Cardano networks. Each HTTP request takes one unit of the
 * budget and has a timeout; a failed request leaves its queries unread instead of failing the run.
 * Error messages are never kept, because they can carry the endpoint URL and its key.
 *
 * @param fetchImpl - Fetch implementation; the global `fetch` by default, replaced by tests.
 * @param clock - Current epoch milliseconds, compared with the budget deadline.
 * @returns The reader.
 */
export function rpcBalanceReader(
  fetchImpl: Fetch = fetch,
  clock: () => number = Date.now
): BalanceReader {
  const post = async (url: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  };

  return {
    async evm(url, queries, budget) {
      const results: Array<bigint | null> = queries.map(() => null);
      for (let start = 0; start < queries.length; start += MULTICALL_BATCH_SIZE) {
        if (!take(budget, clock())) {
          break;
        }
        const batch = queries.slice(start, start + MULTICALL_BATCH_SIZE);
        try {
          const answer = (await post(url, {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [
              { to: MULTICALL3_ADDRESS, data: encodeAggregate3(batch.map(callOf)) },
              'latest'
            ]
          })) as { result?: unknown };
          if (typeof answer?.result !== 'string') {
            throw new Error('RPC error');
          }
          const entries = decodeAggregate3(answer.result);
          if (entries.length !== batch.length) {
            throw new Error('RPC result size');
          }
          entries.forEach((entry, index) => {
            if (entry.success && entry.data.length >= 64) {
              results[start + index] = BigInt(`0x${entry.data.slice(0, 64)}`);
            }
          });
        } catch {
          budget.failed += 1;
        }
      }
      return results;
    },

    async cardano(url, addresses, budget) {
      const holdings = new Map<string, CardanoHoldings>();
      const base = url.replace(/\/+$/, '');
      for (let start = 0; start < addresses.length; start += KOIOS_BATCH_SIZE) {
        const batch = addresses.slice(start, start + KOIOS_BATCH_SIZE);
        const read = new Map<string, CardanoHoldings>(
          batch.map((address) => [address, { lovelace: 0n, assets: new Map() }])
        );
        let complete = false;
        try {
          for (let page = 0; page < KOIOS_MAX_PAGES; page += 1) {
            if (!take(budget, clock())) {
              break;
            }
            const rows = await post(
              `${base}/address_utxos?offset=${page * KOIOS_PAGE_SIZE}&limit=${KOIOS_PAGE_SIZE}`,
              { _addresses: batch, _extended: true }
            );
            if (!Array.isArray(rows)) {
              throw new Error('Koios result shape');
            }
            for (const row of rows as KoiosUtxo[]) {
              const entry = typeof row.address === 'string' ? read.get(row.address) : undefined;
              if (entry === undefined || row.is_spent === true) {
                continue;
              }
              entry.lovelace += bigintOf(row.value);
              for (const asset of row.asset_list ?? []) {
                const unit =
                  `${String(asset.policy_id ?? '')}${String(asset.asset_name ?? '')}`.toLowerCase();
                entry.assets.set(unit, (entry.assets.get(unit) ?? 0n) + bigintOf(asset.quantity));
              }
            }
            if (rows.length < KOIOS_PAGE_SIZE) {
              complete = true;
              break;
            }
          }
        } catch {
          budget.failed += 1;
        }
        // A batch is kept only when every page was read; a cut batch would understate balances.
        if (complete) {
          for (const [address, entry] of read) {
            holdings.set(address, entry);
          }
        }
      }
      return holdings;
    },

    supportsCardano(url) {
      // Blockfrost needs a project key and one request per address; only Koios is read.
      return !/blockfrost/i.test(url);
    }
  };
}
