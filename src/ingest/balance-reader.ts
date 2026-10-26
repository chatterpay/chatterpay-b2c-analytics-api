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
/**
 * Failed requests in a row after which the reads of one endpoint stop for the run. A node that is
 * down or too slow then takes at most this many requests of the budget and this many timeouts of
 * the run time, and the networks read after it keep their share of both.
 */
export const MAX_CONSECUTIVE_FAILURES = 2;

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<Response>;

/**
 * Whether a Cardano endpoint is Blockfrost. The host decides, as in the B2C backend: a Koios root
 * that carries `blockfrost` in its path or query is still Koios.
 *
 * @param url - Provider root.
 * @returns `true` for a host under `blockfrost.io`.
 */
export function isBlockfrost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'blockfrost.io' || host.endsWith('.blockfrost.io');
  } catch {
    return false;
  }
}

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

/** Body of Blockfrost `/addresses/{address}`: the sum of the unspent outputs of the address. */
interface BlockfrostAddress {
  amount?: Array<{ unit?: unknown; quantity?: unknown }> | null;
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
 * {@link BalanceReader} over HTTPS: Multicall3 `aggregate3` through `eth_call` on EVM networks,
 * and on Cardano networks the Koios `address_utxos` endpoint or, with a project key, Blockfrost
 * `/addresses/{address}`, one request per address. Each HTTP request takes one unit of the budget
 * and has a timeout; a failed request leaves its queries unread instead of failing the run, and
 * {@link MAX_CONSECUTIVE_FAILURES} failures in a row leave the rest of the call unread. Error
 * messages are never kept, because they can carry the endpoint URL and its key.
 *
 * @param fetchImpl - Fetch implementation; the global `fetch` by default, replaced by tests.
 * @param clock - Current epoch milliseconds, compared with the budget deadline.
 * @param blockfrostKey - Blockfrost project id, sent in the `project_id` header; `null` leaves
 *   Blockfrost endpoints unsupported, since Blockfrost answers no request without one.
 * @returns The reader.
 */
export function rpcBalanceReader(
  fetchImpl: Fetch = fetch,
  clock: () => number = Date.now,
  blockfrostKey: string | null = null
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

  /**
   * Holdings of each address from Blockfrost. An address the chain has never seen answers 404 and
   * holds nothing; any other failure leaves the address unread.
   */
  const blockfrost = async (
    base: string,
    key: string,
    addresses: readonly string[],
    budget: CallBudget
  ): Promise<Map<string, CardanoHoldings>> => {
    const holdings = new Map<string, CardanoHoldings>();
    let failures = 0;
    for (const address of addresses) {
      if (failures >= MAX_CONSECUTIVE_FAILURES || !take(budget, clock())) {
        break;
      }
      try {
        const response = await fetchImpl(`${base}/addresses/${encodeURIComponent(address)}`, {
          method: 'GET',
          headers: { accept: 'application/json', project_id: key },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const entry: CardanoHoldings = { lovelace: 0n, assets: new Map() };
        if (response.status !== 404) {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const body = (await response.json()) as BlockfrostAddress;
          if (!Array.isArray(body?.amount)) {
            throw new Error('Blockfrost result shape');
          }
          for (const amount of body.amount) {
            const unit = String(amount.unit ?? '').toLowerCase();
            const quantity = bigintOf(amount.quantity);
            if (unit === 'lovelace') {
              entry.lovelace += quantity;
            } else if (unit !== '') {
              entry.assets.set(unit, (entry.assets.get(unit) ?? 0n) + quantity);
            }
          }
        }
        holdings.set(address, entry);
        failures = 0;
      } catch {
        budget.failed += 1;
        failures += 1;
      }
    }
    return holdings;
  };

  return {
    async evm(url, queries, budget) {
      const results: Array<bigint | null> = queries.map(() => null);
      let failures = 0;
      for (let start = 0; start < queries.length; start += MULTICALL_BATCH_SIZE) {
        if (failures >= MAX_CONSECUTIVE_FAILURES || !take(budget, clock())) {
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
          failures = 0;
        } catch {
          budget.failed += 1;
          failures += 1;
        }
      }
      return results;
    },

    async cardano(url, addresses, budget) {
      const base = url.replace(/\/+$/, '');
      if (isBlockfrost(base)) {
        return blockfrostKey === null
          ? new Map()
          : blockfrost(base, blockfrostKey, addresses, budget);
      }
      const holdings = new Map<string, CardanoHoldings>();
      let failures = 0;
      for (let start = 0; start < addresses.length; start += KOIOS_BATCH_SIZE) {
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          break;
        }
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
          failures = 0;
        } catch {
          budget.failed += 1;
          failures += 1;
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
      return !isBlockfrost(url) || blockfrostKey !== null;
    }
  };
}
