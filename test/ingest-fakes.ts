import type {
  B2cActivityReader,
  ChainInfo,
  DailyPrice,
  IngestCheckpoints,
  IngestedTransaction,
  IngestedUser,
  IngestRepository,
  LiveAggregates,
  PriceProvider,
  StoredAggregates,
  TokenInfo,
  TransactionCursor
} from '../src/ingest/types.js';

/** Builds an ObjectId-like hex id whose order follows `n`. */
export function hexId(n: number): string {
  return n.toString(16).padStart(24, '0');
}

/** Builds a B2C transaction row with defaults. */
export function transaction(
  n: number,
  fields: Partial<IngestedTransaction> = {}
): IngestedTransaction {
  return {
    id: hexId(n),
    hash: `0xhash${n}`,
    from: '0xUser1',
    to: '0xOther',
    type: 'transfer',
    status: 'completed',
    date: new Date('2026-10-12T10:00:00.000Z'),
    amount: 10,
    fee: 0.08,
    token: 'USDC',
    chainId: '84532',
    ...fields
  };
}

/** Tokens of Base Sepolia and Cardano Preprod, as in the B2C `tokens` collection. */
export const TOKENS: TokenInfo[] = [
  { chainId: '84532', symbol: 'USDC', stable: true },
  { chainId: '84532', symbol: 'USDT', stable: true },
  { chainId: '84532', symbol: 'WETH', stable: false },
  { chainId: '84532', symbol: 'WBTC', stable: false },
  { chainId: '900000000001', symbol: 'ADA', stable: false },
  { chainId: '900000000001', symbol: 'USDCx', stable: true }
];

/** Networks of the catalog with their chain ids. */
export const CHAINS: ChainInfo[] = [
  {
    chainId: '84532',
    network: 'base-sepolia',
    name: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org',
    contracts: { paymasterAddress: '0xPaymaster' }
  },
  {
    chainId: '900000000001',
    network: 'cardano-preprod',
    name: 'Cardano Preprod',
    explorer: 'https://preprod.cardanoscan.io/transaction/',
    contracts: {}
  }
];

/** B2C reader over arrays; counts the transaction reads. */
export class FakeReader implements B2cActivityReader {
  transactionReads = 0;

  constructor(
    public rows: IngestedTransaction[],
    public userList: IngestedUser[] = [],
    public tokenList: TokenInfo[] = TOKENS,
    public chainList: ChainInfo[] = CHAINS
  ) {}

  async transactions(cursor: TransactionCursor, limit: number): Promise<IngestedTransaction[]> {
    this.transactionReads += 1;
    const sinceSeconds = cursor.since === null ? null : Math.floor(cursor.since.getTime() / 1000);
    return [...this.rows]
      .sort((left, right) => left.id.localeCompare(right.id))
      .filter(
        (row) =>
          (cursor.afterId === null || row.id > cursor.afterId) &&
          (cursor.untilId === null || row.id <= cursor.untilId) &&
          (sinceSeconds === null || Math.floor(row.date.getTime() / 1000) >= sinceSeconds)
      )
      .slice(0, limit);
  }

  async users(): Promise<IngestedUser[]> {
    return this.userList;
  }

  async tokens(): Promise<TokenInfo[]> {
    return this.tokenList;
  }

  async chains(): Promise<ChainInfo[]> {
    return this.chainList;
  }
}

/** In-memory {@link IngestRepository}. */
export class MemoryIngestRepository implements IngestRepository {
  checkpoints: IngestCheckpoints = { transactionsLastId: null, pricesLastDay: null };
  lock: { owner: string; until: Date } | null = null;
  readonly copies = new Map<string, IngestedTransaction>();
  userCopies: IngestedUser[] = [];
  tokenCopies: TokenInfo[] = [];
  chainCopies: ChainInfo[] = [];
  readonly priceCopies = new Map<string, DailyPrice>();
  stored: StoredAggregates | null = null;

  async readCheckpoints(): Promise<IngestCheckpoints> {
    return { ...this.checkpoints };
  }

  async saveCheckpoints(patch: Partial<IngestCheckpoints>): Promise<void> {
    this.checkpoints = { ...this.checkpoints, ...patch };
  }

  async acquireLock(owner: string, now: Date, ttlMs: number): Promise<boolean> {
    if (this.lock !== null && this.lock.until.getTime() > now.getTime()) {
      return false;
    }
    this.lock = { owner, until: new Date(now.getTime() + ttlMs) };
    return true;
  }

  async releaseLock(owner: string): Promise<void> {
    if (this.lock?.owner === owner) {
      this.lock = null;
    }
  }

  async upsertTransactions(items: readonly IngestedTransaction[]): Promise<void> {
    for (const item of items) {
      this.copies.set(item.id, { ...item });
    }
  }

  async replaceUsers(items: readonly IngestedUser[]): Promise<void> {
    this.userCopies = [...items];
  }

  async replaceCatalog(tokens: readonly TokenInfo[], chains: readonly ChainInfo[]): Promise<void> {
    this.tokenCopies = [...tokens];
    this.chainCopies = [...chains];
  }

  async savePrices(items: readonly DailyPrice[]): Promise<void> {
    for (const item of items) {
      this.priceCopies.set(`${item.symbol}|${item.day}|${item.source}`, item);
    }
  }

  async transactions(): Promise<IngestedTransaction[]> {
    return [...this.copies.values()];
  }

  async users(): Promise<IngestedUser[]> {
    return this.userCopies;
  }

  async tokens(): Promise<TokenInfo[]> {
    return this.tokenCopies;
  }

  async chains(): Promise<ChainInfo[]> {
    return this.chainCopies;
  }

  async prices(): Promise<DailyPrice[]> {
    return [...this.priceCopies.values()];
  }

  async saveAggregates(aggregates: LiveAggregates, builtAt: Date): Promise<void> {
    this.stored = { ...aggregates, builtAt };
  }

  async aggregatesBuiltAt(): Promise<Date | null> {
    return this.stored?.builtAt ?? null;
  }

  async loadAggregates(): Promise<StoredAggregates | null> {
    return this.stored;
  }
}

/** Price provider that records its calls. */
export class FakePriceProvider implements PriceProvider {
  readonly name = 'fake';
  calls = 0;

  constructor(
    private readonly prices: Record<string, number>,
    private readonly fail = false
  ) {}

  async current(symbols: readonly string[]): Promise<Record<string, number>> {
    this.calls += 1;
    if (this.fail) {
      throw new Error('provider down');
    }
    return Object.fromEntries(
      symbols.flatMap((symbol) => {
        const price = this.prices[symbol];
        return price === undefined ? [] : [[symbol, price]];
      })
    );
  }
}
