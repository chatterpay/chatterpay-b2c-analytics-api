import type {
  CallBudget,
  PolygonBlock,
  PolygonFillReader,
  PolymarketAccountRecord,
  PolymarketFill
} from './types.js';

/**
 * Polymarket CTF Exchange and Neg Risk CTF Exchange on Polygon, the CLOB V2 contracts the
 * ChatterPay backend signs its orders against.
 */
export const POLYMARKET_EXCHANGES = [
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xe2222d279d744050d28e00520010520000310F59'
] as const;

/**
 * Topic of `OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker,
 * uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee,
 * bytes32 builder, bytes32 metadata)` of the CLOB V2 exchanges.
 */
export const ORDER_FILLED_TOPIC =
  '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';

/**
 * First instant the CLOB V2 exchanges took orders. ChatterPay orders were always signed for them,
 * so no fill of a ChatterPay account is older; it bounds the first read when an account has no
 * creation date.
 */
export const POLYMARKET_V2_SINCE: Date = new Date('2026-04-28T00:00:00Z');

/** Blocks per `eth_getLogs` request; public Polygon nodes refuse wider ranges. */
export const POLYGON_LOG_RANGE = 10_000;
/** Makers per request; Polygon nodes accept up to 1000 topics in one position. */
export const MAKERS_PER_REQUEST = 500;
/** Blocks left below the latest one, about three minutes, so a reorganized block is never read. */
export const POLYGON_CONFIRMATIONS = 128;

const REQUEST_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;
const SIDE_BUY = 0n;
const SIDE_SELL = 1n;
/** Data words of the event: side, tokenId, makerAmountFilled, takerAmountFilled, fee, builder, metadata. */
const DATA_WORDS = 7;

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<Response>;

interface RpcLog {
  data?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
  blockNumber?: unknown;
  blockTimestamp?: unknown;
  removed?: unknown;
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

function hexQuantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error('Malformed quantity');
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Malformed quantity');
  }
  return parsed;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function micro(value: bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Malformed amount');
  }
  return parsed;
}

/**
 * Decodes the data of an `OrderFilled` event: a buy pays `makerAmountFilled` pUSD for shares, a
 * sell gives shares for `takerAmountFilled` pUSD; the fee is in pUSD. A `builder` other than zero is
 * a builder code on the order.
 *
 * @param data - Hex data of the event.
 * @returns The side, the pUSD of the fill and the fee, in millionths, and the builder code flag.
 * @throws {Error} When the data is malformed or the side unknown.
 */
export function decodeOrderFilled(
  data: string
): Pick<PolymarketFill, 'side' | 'collateralMicro' | 'feeMicro' | 'attributed'> {
  const words = /^0x(?:[0-9a-fA-F]{64})+$/.test(data) ? data.slice(2).match(/.{64}/g) : null;
  if (words === null || words.length < DATA_WORDS) {
    throw new Error('Malformed OrderFilled data');
  }
  const [side, , makerAmount, takerAmount, fee, builder] = words.map((word) => BigInt(`0x${word}`));
  if (side !== SIDE_BUY && side !== SIDE_SELL) {
    throw new Error('Unknown OrderFilled side');
  }
  return {
    side: side === SIDE_BUY ? 'buy' : 'sell',
    collateralMicro: micro((side === SIDE_BUY ? makerAmount : takerAmount) ?? 0n),
    feeMicro: micro(fee ?? 0n),
    attributed: (builder ?? 0n) !== 0n
  };
}

/**
 * {@link PolygonFillReader} over the JSON-RPC of a Polygon node: `eth_getLogs` filtered by the
 * exchanges, the `OrderFilled` topic and the makers. Each request takes one unit of the budget and
 * has a timeout; a failed request answers `null`. A log without `blockTimestamp` takes one
 * `eth_getBlockByNumber` per block. Error messages are never kept, since they can carry the
 * endpoint URL and its key.
 *
 * @param url - Polygon RPC endpoint.
 * @param fetchImpl - Fetch implementation; the global `fetch` by default, replaced by tests.
 * @param clock - Current epoch milliseconds, compared with the budget deadline.
 * @returns The reader.
 */
export function polygonFillReader(
  url: string,
  fetchImpl: Fetch = fetch,
  clock: () => number = Date.now
): PolygonFillReader {
  const rpc = async (method: string, params: unknown[], budget: CallBudget): Promise<unknown> => {
    if (!take(budget, clock())) {
      throw new Error('Budget spent');
    }
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const answer = (await response.json()) as { result?: unknown; error?: unknown };
      if (answer?.error !== undefined || answer?.result === undefined) {
        throw new Error('RPC error');
      }
      return answer.result;
    } catch (error) {
      budget.failed += 1;
      throw error;
    }
  };

  const block = async (number: number, budget: CallBudget): Promise<PolygonBlock | null> => {
    try {
      const result = (await rpc('eth_getBlockByNumber', [hex(number), false], budget)) as {
        number?: unknown;
        timestamp?: unknown;
      } | null;
      if (result === null) {
        return null;
      }
      return {
        number: hexQuantity(result.number),
        at: new Date(hexQuantity(result.timestamp) * 1000)
      };
    } catch {
      return null;
    }
  };

  return {
    async head(budget) {
      try {
        const latest = hexQuantity(await rpc('eth_blockNumber', [], budget));
        return await block(Math.max(0, latest - POLYGON_CONFIRMATIONS), budget);
      } catch {
        return null;
      }
    },

    block,

    async blockAt(at, head, budget) {
      if (head.at.getTime() < at.getTime()) {
        return null;
      }
      // Binary search for the first block at or after `at`: about 27 requests over Polygon. `found`
      // is always the block `high`, the lowest one known to be at or after `at`.
      let low = 0;
      let high = head.number;
      let found: PolygonBlock = head;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const probe = await block(middle, budget);
        if (probe === null) {
          return null;
        }
        if (probe.at.getTime() >= at.getTime()) {
          found = probe;
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      return found;
    },

    async fills(makers, fromBlock, toBlock, budget) {
      try {
        const logs = (await rpc(
          'eth_getLogs',
          [
            {
              address: [...POLYMARKET_EXCHANGES],
              fromBlock: hex(fromBlock),
              toBlock: hex(toBlock),
              topics: [ORDER_FILLED_TOPIC, null, makers.map(topicOf)]
            }
          ],
          budget
        )) as RpcLog[];
        if (!Array.isArray(logs)) {
          return null;
        }
        const times = new Map<number, number>();
        const fills: PolymarketFill[] = [];
        for (const log of logs) {
          if (log.removed === true) {
            continue;
          }
          const number = hexQuantity(log.blockNumber);
          let seconds =
            log.blockTimestamp === undefined ? times.get(number) : hexQuantity(log.blockTimestamp);
          if (seconds === undefined) {
            const read = await block(number, budget);
            if (read === null) {
              return null;
            }
            seconds = read.at.getTime() / 1000;
          }
          times.set(number, seconds);
          if (typeof log.transactionHash !== 'string' || typeof log.data !== 'string') {
            return null;
          }
          fills.push({
            id: `${log.transactionHash.toLowerCase()}:${hexQuantity(log.logIndex)}`,
            hour: Math.floor((seconds * 1000) / HOUR_MS),
            ...decodeOrderFilled(log.data)
          });
        }
        return fills;
      } catch {
        return null;
      }
    }
  };
}

/** Result of {@link collectPolymarketFills}. */
export interface FillCollection {
  /**
   * `complete`: the blocks up to the confirmed head were read. `partial`: some were read and the
   * budget, the deadline or a failed request stopped the rest. `failed`: none was read.
   */
  status: 'complete' | 'partial' | 'failed';
  fills: PolymarketFill[];
  /** Checkpoint after the run. */
  nextBlock: number | null;
  from: Date | null;
  through: Date | null;
}

/** Inputs of {@link collectPolymarketFills}. */
export interface FillCollectionInput {
  reader: PolygonFillReader;
  /** Polymarket accounts of the B2C users at the run. */
  accounts: readonly PolymarketAccountRecord[];
  /** Checkpoints of the earlier runs. */
  nextBlock: number | null;
  from: Date | null;
  through: Date | null;
  budget: CallBudget;
}

/**
 * Instant before which no account of the run can have filled an order: the earliest creation
 * date, or the start of the CLOB V2 exchanges when an account has none.
 */
function earliestFill(accounts: readonly PolymarketAccountRecord[]): Date {
  let earliest: Date | null = null;
  for (const account of accounts) {
    if (account.createdAt === null) {
      return POLYMARKET_V2_SINCE;
    }
    if (earliest === null || account.createdAt.getTime() < earliest.getTime()) {
      earliest = account.createdAt;
    }
  }
  return earliest === null || earliest.getTime() < POLYMARKET_V2_SINCE.getTime()
    ? POLYMARKET_V2_SINCE
    : earliest;
}

/**
 * Reads the fills of the orders of the B2C Polymarket accounts from the checkpoint up to the
 * confirmed head, in ranges of {@link POLYGON_LOG_RANGE} blocks and groups of
 * {@link MAKERS_PER_REQUEST} makers. A range moves the checkpoint only when every group of it was
 * read, so a stopped run never leaves a hole. The first run starts at the block of the earliest
 * account; later runs read the accounts of their own time over the new blocks, which covers an
 * account created after the previous run. An account whose `polygon_address` was replaced keeps
 * the fills already read; fills of an address no account holds any more are not read.
 *
 * @param input - Reader, accounts, checkpoints and budget.
 * @returns The fills read, the new checkpoint and the blocks covered.
 */
export async function collectPolymarketFills(input: FillCollectionInput): Promise<FillCollection> {
  const { reader, budget } = input;
  const readable = input.accounts.filter((account) => account.address !== null);
  const makers = [...new Set(readable.map((account) => account.address as string))].sort();
  const unchanged: FillCollection = {
    status: 'failed',
    fills: [],
    nextBlock: input.nextBlock,
    from: input.from,
    through: input.through
  };
  const head = await reader.head(budget);
  if (head === null) {
    return unchanged;
  }
  let from = input.from;
  let next = input.nextBlock;
  if (next === null) {
    const first =
      makers.length === 0 ? head : await reader.blockAt(earliestFill(readable), head, budget);
    if (first === null) {
      return unchanged;
    }
    next = first.number;
    from = first.at;
  }
  if (next > head.number) {
    return {
      status: 'complete',
      fills: [],
      nextBlock: next,
      from,
      through: input.through ?? head.at
    };
  }
  if (makers.length === 0) {
    // Without accounts no block holds a fill to read.
    return { status: 'complete', fills: [], nextBlock: head.number + 1, from, through: head.at };
  }

  const fills: PolymarketFill[] = [];
  const start = next;
  const groups = Math.ceil(makers.length / MAKERS_PER_REQUEST);
  let stopped = false;
  while (next <= head.number && !stopped) {
    // A range starts only with one request left after its groups, for the block that dates the
    // end of the coverage when the run stops before the head.
    if (budget.remaining <= groups) {
      break;
    }
    const to = Math.min(next + POLYGON_LOG_RANGE - 1, head.number);
    const range: PolymarketFill[] = [];
    for (let index = 0; index < makers.length; index += MAKERS_PER_REQUEST) {
      const read = await reader.fills(
        makers.slice(index, index + MAKERS_PER_REQUEST),
        next,
        to,
        budget
      );
      if (read === null) {
        stopped = true;
        break;
      }
      range.push(...read);
    }
    if (!stopped) {
      fills.push(...range);
      next = to + 1;
    }
  }
  if (next > head.number) {
    return { status: 'complete', fills, nextBlock: next, from, through: head.at };
  }
  if (next === start) {
    return { ...unchanged, from, nextBlock: next };
  }
  // The instant of the last block read; without it the coverage keeps its previous end.
  const last = await reader.block(next - 1, budget);
  return { status: 'partial', fills, nextBlock: next, from, through: last?.at ?? input.through };
}
