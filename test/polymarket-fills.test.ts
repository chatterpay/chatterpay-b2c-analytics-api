import { describe, expect, it } from 'vitest';
import {
  collectPolymarketFills,
  decodeOrderFilled,
  MAKERS_PER_REQUEST,
  ORDER_FILLED_TOPIC,
  POLYGON_CONFIRMATIONS,
  POLYMARKET_EXCHANGES,
  POLYMARKET_V2_SINCE,
  polygonFillReader
} from '../src/ingest/polymarket-fills.js';
import type {
  CallBudget,
  PolygonBlock,
  PolygonFillReader,
  PolymarketAccountRecord,
  PolymarketFill
} from '../src/ingest/types.js';

const MAKER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
/** Block `n` of the fake chains is mined two seconds after block `n - 1`. */
const GENESIS_MS = Date.parse('2026-10-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;

function blockTime(number: number): Date {
  return new Date(GENESIS_MS + number * 2000);
}

function word(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

/** Data of an `OrderFilled` event. */
function orderData(input: {
  side: 0 | 1 | 2;
  makerAmount: number;
  takerAmount: number;
  fee?: number;
  builder?: bigint;
}): string {
  return `0x${[
    word(input.side),
    word(123n),
    word(input.makerAmount),
    word(input.takerAmount),
    word(input.fee ?? 0),
    word(input.builder ?? 0n),
    word(0n)
  ].join('')}`;
}

function budget(remaining = 100, deadline = Number.POSITIVE_INFINITY): CallBudget {
  return { remaining, deadline, used: 0, failed: 0 };
}

function account(address: string | null, createdAt: Date | null): PolymarketAccountRecord {
  return { validAddress: address !== null, address, createdAt };
}

describe('OrderFilled data', () => {
  it('takes the pUSD paid of a buy and the pUSD received of a sell', () => {
    expect(
      decodeOrderFilled(
        orderData({ side: 0, makerAmount: 5_000_000, takerAmount: 10_000_000, fee: 25_000 })
      )
    ).toEqual({ side: 'buy', collateralMicro: 5_000_000, feeMicro: 25_000, attributed: false });
    expect(
      decodeOrderFilled(orderData({ side: 1, makerAmount: 10_000_000, takerAmount: 4_500_000 }))
    ).toEqual({ side: 'sell', collateralMicro: 4_500_000, feeMicro: 0, attributed: false });
  });

  it('flags an order with a builder code', () => {
    expect(
      decodeOrderFilled(orderData({ side: 0, makerAmount: 1, takerAmount: 2, builder: 7n }))
        .attributed
    ).toBe(true);
  });

  it('rejects short data and an unknown side', () => {
    expect(() => decodeOrderFilled(`0x${word(0n)}`)).toThrow('Malformed');
    expect(() => decodeOrderFilled('0x1234')).toThrow('Malformed');
    expect(() => decodeOrderFilled(orderData({ side: 2, makerAmount: 1, takerAmount: 2 }))).toThrow(
      'Unknown'
    );
  });
});

interface RpcRequest {
  method: string;
  params: unknown[];
}

/** JSON-RPC node of a fake chain whose latest block is `latest`. */
function fakeNode(
  latest: number,
  logs: (filter: Record<string, unknown>) => unknown[] | Response = () => []
) {
  const requests: RpcRequest[] = [];
  const fetchImpl = async (_url: string, init: { body: string }): Promise<Response> => {
    const request = JSON.parse(init.body) as RpcRequest;
    requests.push(request);
    const answer = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (request.method === 'eth_blockNumber') {
      return answer(`0x${latest.toString(16)}`);
    }
    if (request.method === 'eth_getBlockByNumber') {
      const number = Number.parseInt(String(request.params[0]), 16);
      return answer(
        number > latest
          ? null
          : {
              number: `0x${number.toString(16)}`,
              timestamp: `0x${(blockTime(number).getTime() / 1000).toString(16)}`
            }
      );
    }
    const result = logs(request.params[0] as Record<string, unknown>);
    return result instanceof Response ? result : answer(result);
  };
  return { requests, fetchImpl };
}

function log(block: number, index: number, data: string, extra: Record<string, unknown> = {}) {
  return {
    transactionHash: `0x${'AB'.repeat(31)}${index.toString(16).padStart(2, '0')}`,
    logIndex: `0x${index.toString(16)}`,
    blockNumber: `0x${block.toString(16)}`,
    blockTimestamp: `0x${(blockTime(block).getTime() / 1000).toString(16)}`,
    data,
    ...extra
  };
}

describe('Polygon fill reader', () => {
  it('reads the head below the confirmations and finds the block of an instant', async () => {
    const node = fakeNode(1_000_000);
    const reader = polygonFillReader('https://polygon.example', node.fetchImpl);
    const spent = budget();

    const head = await reader.head(spent);
    expect(head).toEqual({
      number: 1_000_000 - POLYGON_CONFIRMATIONS,
      at: blockTime(1_000_000 - POLYGON_CONFIRMATIONS)
    });
    const found = await reader.blockAt(
      new Date(blockTime(400_000).getTime() - 1000),
      head as PolygonBlock,
      spent
    );
    expect(found).toEqual({ number: 400_000, at: blockTime(400_000) });
    expect(spent.used).toBe(node.requests.length);
    expect(spent.used).toBeLessThan(25);
    expect(await reader.blockAt(blockTime(2_000_000), head as PolygonBlock, spent)).toBeNull();
  });

  it('filters the logs by exchange, event and maker and decodes the fills', async () => {
    const node = fakeNode(1_000_000, () => [
      log(
        500,
        1,
        orderData({ side: 0, makerAmount: 2_000_000, takerAmount: 4_000_000, fee: 10_000 })
      ),
      log(500, 2, orderData({ side: 1, makerAmount: 3_000_000, takerAmount: 1_500_000 }), {
        removed: true
      }),
      log(501, 3, orderData({ side: 1, makerAmount: 3_000_000, takerAmount: 1_500_000 }), {
        blockTimestamp: undefined
      })
    ]);
    const reader = polygonFillReader('https://polygon.example', node.fetchImpl);
    const spent = budget();

    const fills = await reader.fills([MAKER, OTHER], 100, 10_099, spent);

    expect(node.requests[0]).toMatchObject({
      method: 'eth_getLogs',
      params: [
        {
          address: [...POLYMARKET_EXCHANGES],
          fromBlock: '0x64',
          toBlock: '0x2773',
          topics: [
            ORDER_FILLED_TOPIC,
            null,
            [`0x${'0'.repeat(24)}${MAKER.slice(2)}`, `0x${'0'.repeat(24)}${OTHER.slice(2)}`]
          ]
        }
      ]
    });
    expect(fills).toEqual([
      {
        id: `0x${'ab'.repeat(31)}01:1`,
        hour: Math.floor(blockTime(500).getTime() / HOUR_MS),
        side: 'buy',
        collateralMicro: 2_000_000,
        feeMicro: 10_000,
        attributed: false
      },
      {
        id: `0x${'ab'.repeat(31)}03:3`,
        hour: Math.floor(blockTime(501).getTime() / HOUR_MS),
        side: 'sell',
        collateralMicro: 1_500_000,
        feeMicro: 0,
        attributed: false
      }
    ]);
    // The log without a timestamp took one block read.
    expect(spent.used).toBe(2);
  });

  it('answers null on a failed request and sends nothing without budget', async () => {
    const node = fakeNode(1_000_000, () => new Response('{}', { status: 503 }));
    const reader = polygonFillReader('https://polygon.example', node.fetchImpl);
    const spent = budget(1);

    expect(await reader.fills([MAKER], 1, 2, spent)).toBeNull();
    expect(spent).toMatchObject({ used: 1, failed: 1, remaining: 0 });
    expect(await reader.fills([MAKER], 1, 2, spent)).toBeNull();
    expect(node.requests).toHaveLength(1);

    const late = budget(10, 0);
    expect(await reader.head(late)).toBeNull();
    expect(late.used).toBe(0);
  });

  it('answers null on an RPC error', async () => {
    const node = fakeNode(
      1_000_000,
      () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit' } })
        )
    );
    const reader = polygonFillReader('https://polygon.example', node.fetchImpl);
    const spent = budget();

    expect(await reader.fills([MAKER], 1, 2, spent)).toBeNull();
    expect(spent.failed).toBe(1);
  });
});

/** Fills per block of a fake chain, by maker; each method takes one request of the budget. */
class FakePolygon implements PolygonFillReader {
  readonly requests: Array<{ makers: readonly string[]; from: number; to: number }> = [];

  constructor(
    private readonly headNumber: number,
    private readonly chain: ReadonlyArray<{
      maker: string;
      block: number;
      fill: PolymarketFill;
    }> = [],
    private readonly failRanges: ReadonlySet<number> = new Set()
  ) {}

  private take(spent: CallBudget): boolean {
    if (spent.remaining <= 0) {
      return false;
    }
    spent.remaining -= 1;
    spent.used += 1;
    return true;
  }

  async head(spent: CallBudget) {
    return this.take(spent) ? { number: this.headNumber, at: blockTime(this.headNumber) } : null;
  }

  async block(number: number, spent: CallBudget) {
    return this.take(spent) ? { number, at: blockTime(number) } : null;
  }

  async blockAt(at: Date, head: PolygonBlock, spent: CallBudget) {
    if (!this.take(spent) || at.getTime() > head.at.getTime()) {
      return null;
    }
    const number = Math.max(0, Math.ceil((at.getTime() - GENESIS_MS) / 2000));
    return { number, at: blockTime(number) };
  }

  async fills(makers: readonly string[], from: number, to: number, spent: CallBudget) {
    if (!this.take(spent)) {
      return null;
    }
    this.requests.push({ makers, from, to });
    if (this.failRanges.has(from)) {
      spent.failed += 1;
      return null;
    }
    return this.chain
      .filter((item) => makers.includes(item.maker) && item.block >= from && item.block <= to)
      .map((item) => item.fill);
  }
}

function fill(id: string, block: number, collateralMicro: number): PolymarketFill {
  return {
    id,
    hour: Math.floor(blockTime(block).getTime() / HOUR_MS),
    side: 'buy',
    collateralMicro,
    feeMicro: 0,
    attributed: false
  };
}

describe('Polymarket fill collection', () => {
  it('starts at the block of the earliest account and reads up to the head in ranges', async () => {
    const polygon = new FakePolygon(60_000, [
      { maker: MAKER, block: 30_000, fill: fill('a:1', 30_000, 1_000_000) },
      { maker: OTHER, block: 59_999, fill: fill('b:1', 59_999, 2_000_000) },
      { maker: MAKER, block: 20_000, fill: fill('early:1', 20_000, 9_000_000) }
    ]);

    const result = await collectPolymarketFills({
      reader: polygon,
      accounts: [
        account(MAKER, blockTime(25_000)),
        account(OTHER, blockTime(40_000)),
        account(null, null)
      ],
      nextBlock: null,
      from: null,
      through: null,
      budget: budget()
    });

    expect(result).toEqual({
      status: 'complete',
      fills: [fill('a:1', 30_000, 1_000_000), fill('b:1', 59_999, 2_000_000)],
      nextBlock: 60_001,
      from: blockTime(25_000),
      through: blockTime(60_000)
    });
    expect(polygon.requests.map((request) => [request.from, request.to])).toEqual([
      [25_000, 34_999],
      [35_000, 44_999],
      [45_000, 54_999],
      [55_000, 60_000]
    ]);
    expect(polygon.requests[0]?.makers).toEqual([MAKER, OTHER]);
  });

  it('starts at the CLOB V2 exchanges when an account has no creation date', async () => {
    // The fake chain starts after the CLOB V2 exchanges, so their start is its first block.
    expect(POLYMARKET_V2_SINCE.getTime()).toBeLessThan(GENESIS_MS);
    const polygon = new FakePolygon(100);
    const result = await collectPolymarketFills({
      reader: polygon,
      accounts: [account(MAKER, blockTime(50)), account(OTHER, null)],
      nextBlock: null,
      from: null,
      through: null,
      budget: budget()
    });

    expect(result).toMatchObject({ status: 'complete', from: blockTime(0), nextBlock: 101 });
  });

  it('splits the makers in groups and moves the checkpoint only past whole ranges', async () => {
    const makers = Array.from(
      { length: MAKERS_PER_REQUEST + 1 },
      (_, index) => `0x${index.toString(16).padStart(40, '0')}`
    );
    const polygon = new FakePolygon(40_000, [], new Set([20_000]));

    const result = await collectPolymarketFills({
      reader: polygon,
      accounts: makers.map((maker) => account(maker, blockTime(5))),
      nextBlock: 10_000,
      from: blockTime(10_000),
      through: blockTime(9_999),
      budget: budget()
    });

    expect(result).toMatchObject({
      status: 'partial',
      nextBlock: 20_000,
      from: blockTime(10_000),
      through: blockTime(19_999)
    });
    expect(polygon.requests.map((request) => [request.from, request.makers.length])).toEqual([
      [10_000, MAKERS_PER_REQUEST],
      [10_000, 1],
      [20_000, MAKERS_PER_REQUEST]
    ]);
  });

  it('keeps one request of the budget to date the last block read', async () => {
    const polygon = new FakePolygon(60_000);
    // Head, three ranges and the closing block read.
    const spent = budget(5);

    const result = await collectPolymarketFills({
      reader: polygon,
      accounts: [account(MAKER, blockTime(1))],
      nextBlock: 1,
      from: blockTime(1),
      through: blockTime(0),
      budget: spent
    });

    expect(result).toMatchObject({
      status: 'partial',
      nextBlock: 30_001,
      through: blockTime(30_000)
    });
    expect(spent.remaining).toBe(0);
  });

  it('keeps the checkpoints when the head cannot be read or no range was read', async () => {
    const checkpoints = { nextBlock: 10, from: blockTime(10), through: blockTime(9) };
    const accounts = [account(MAKER, blockTime(1))];

    expect(
      await collectPolymarketFills({
        reader: new FakePolygon(100),
        accounts,
        ...checkpoints,
        budget: budget(0)
      })
    ).toEqual({ status: 'failed', fills: [], ...checkpoints });
    expect(
      await collectPolymarketFills({
        reader: new FakePolygon(100, [], new Set([10])),
        accounts,
        ...checkpoints,
        budget: budget()
      })
    ).toEqual({ status: 'failed', fills: [], ...checkpoints });
  });

  it('moves past the head without any request when no account holds an address', async () => {
    const polygon = new FakePolygon(5_000);

    const result = await collectPolymarketFills({
      reader: polygon,
      accounts: [account(null, blockTime(1))],
      nextBlock: null,
      from: null,
      through: null,
      budget: budget()
    });

    expect(result).toEqual({
      status: 'complete',
      fills: [],
      nextBlock: 5_001,
      from: blockTime(5_000),
      through: blockTime(5_000)
    });
    expect(polygon.requests).toEqual([]);
  });
});
