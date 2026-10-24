import type {
  B2cActivityReader,
  B2cUserRecord,
  BalanceReader,
  CallBudget,
  CardanoHoldings,
  ChainEndpoint,
  ChainInfo,
  DailyPrice,
  EvmBalanceQuery,
  IngestCheckpoints,
  IngestedTransaction,
  IngestedUser,
  IngestRepository,
  LiveAggregates,
  PriceProvider,
  RunSnapshot,
  StoredAggregates,
  TokenInfo,
  TransactionCursor,
  WalletObservation
} from '../src/ingest/types.js';
import type { IngestRunStatus } from '../src/metrics/types.js';

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

/** Contract addresses of the synthetic Base Sepolia tokens. */
export const TOKEN_ADDRESSES = {
  USDC: '0x1111111111111111111111111111111111111111',
  USDT: '0x2222222222222222222222222222222222222222',
  WETH: '0x3333333333333333333333333333333333333333',
  WBTC: '0x4444444444444444444444444444444444444444'
} as const;

/** Policy id and asset name of the synthetic USDCx on Cardano Preprod. */
export const USDCX_UNIT = `${'a'.repeat(56)}5553444378`;

/** Tokens of Base Sepolia and Cardano Preprod, as in the B2C `tokens` collection. */
export const TOKENS: TokenInfo[] = [
  { chainId: '84532', symbol: 'USDC', stable: true, address: TOKEN_ADDRESSES.USDC, decimals: 6 },
  { chainId: '84532', symbol: 'USDT', stable: true, address: TOKEN_ADDRESSES.USDT, decimals: 6 },
  { chainId: '84532', symbol: 'WETH', stable: false, address: TOKEN_ADDRESSES.WETH, decimals: 18 },
  { chainId: '84532', symbol: 'WBTC', stable: false, address: TOKEN_ADDRESSES.WBTC, decimals: 8 },
  {
    chainId: '900000000001',
    symbol: 'ADA',
    stable: false,
    address: 'cardano:lovelace',
    decimals: 6
  },
  { chainId: '900000000001', symbol: 'USDCx', stable: true, address: USDCX_UNIT, decimals: 6 }
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

/** Balance endpoints of {@link CHAINS}; the hosts are never contacted. */
export const ENDPOINTS: ChainEndpoint[] = [
  { chainId: '84532', family: 'evm', url: 'https://rpc.base-sepolia.test/key-in-path' },
  { chainId: '900000000001', family: 'cardano', url: 'https://preprod.koios.test/api/v1' }
];

/** B2C reader over arrays; counts the transaction reads. */
export class FakeReader implements B2cActivityReader {
  transactionReads = 0;

  constructor(
    public rows: IngestedTransaction[],
    public userList: Array<IngestedUser & { country?: string }> = [],
    public tokenList: TokenInfo[] = TOKENS,
    public chainList: ChainInfo[] = CHAINS,
    public endpointList: ChainEndpoint[] = ENDPOINTS
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

  async users(): Promise<B2cUserRecord[]> {
    return this.userList.map((user) => ({ ...user, country: user.country ?? 'Unknown' }));
  }

  async tokens(): Promise<TokenInfo[]> {
    return this.tokenList;
  }

  async chains(): Promise<ChainInfo[]> {
    return this.chainList;
  }

  async endpoints(): Promise<ChainEndpoint[]> {
    return this.endpointList;
  }
}

/** In-memory {@link IngestRepository}. */
export class MemoryIngestRepository implements IngestRepository {
  checkpoints: IngestCheckpoints = {
    transactionsLastId: null,
    pricesLastDay: null,
    walletsTrackingSince: null
  };
  lock: { owner: string; until: Date } | null = null;
  readonly copies = new Map<string, IngestedTransaction>();
  userCopies: IngestedUser[] = [];
  tokenCopies: TokenInfo[] = [];
  chainCopies: ChainInfo[] = [];
  readonly priceCopies = new Map<string, DailyPrice>();
  readonly snapshotCopies = new Map<number, RunSnapshot>();
  readonly observations = new Map<string, WalletObservation>();
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
    this.userCopies = items.map((item) => ({ ...item }));
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

  async saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    this.snapshotCopies.set(snapshot.takenAt.getTime(), snapshot);
  }

  async walletObservations(): Promise<WalletObservation[]> {
    return [...this.observations.values()];
  }

  async addWalletObservations(items: readonly WalletObservation[]): Promise<void> {
    for (const item of items) {
      const key = `${item.chainId}|${item.address}`;
      if (!this.observations.has(key)) {
        this.observations.set(key, { ...item });
      }
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

  async saveAggregates(
    aggregates: LiveAggregates,
    builtAt: Date,
    run: IngestRunStatus
  ): Promise<void> {
    this.stored = {
      ...aggregates,
      builtAt,
      run,
      walletsTrackingSince: this.checkpoints.walletsTrackingSince,
      snapshots: []
    };
  }

  async aggregatesBuiltAt(): Promise<Date | null> {
    return this.stored?.builtAt ?? null;
  }

  async loadAggregates(): Promise<StoredAggregates | null> {
    if (this.stored === null) {
      return null;
    }
    const builtAt = this.stored.builtAt.getTime();
    return {
      ...this.stored,
      walletsTrackingSince: this.checkpoints.walletsTrackingSince,
      snapshots: [...this.snapshotCopies.values()]
        .filter((snapshot) => snapshot.takenAt.getTime() <= builtAt)
        .sort((left, right) => left.takenAt.getTime() - right.takenAt.getTime())
    };
  }
}

/** Price provider that records its calls. */
export class FakePriceProvider implements PriceProvider {
  readonly name = 'fake';
  calls = 0;
  lastSymbols: string[] = [];

  constructor(
    private readonly prices: Record<string, number>,
    private readonly fail = false
  ) {}

  async current(symbols: readonly string[]): Promise<Record<string, number>> {
    this.calls += 1;
    this.lastSymbols = [...symbols];
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

/**
 * Balance reader over fixed balances. EVM balances are keyed `holder|token` (`native` for the coin),
 * holders and tokens in lower case; one request per `batchSize` queries; `failHolders` are left
 * unread.
 */
export class FakeBalanceReader implements BalanceReader {
  requests = 0;

  constructor(
    private readonly evmBalances: Record<string, bigint>,
    private readonly cardanoBalances: Record<string, CardanoHoldings> = {},
    private readonly failHolders: ReadonlySet<string> = new Set(),
    private readonly batchSize = 200
  ) {}

  async evm(
    _url: string,
    queries: readonly EvmBalanceQuery[],
    budget: CallBudget
  ): Promise<Array<bigint | null>> {
    const results: Array<bigint | null> = queries.map(() => null);
    for (let start = 0; start < queries.length; start += this.batchSize) {
      if (budget.remaining <= 0) {
        break;
      }
      budget.remaining -= 1;
      budget.used += 1;
      this.requests += 1;
      const end = Math.min(queries.length, start + this.batchSize);
      for (let index = start; index < end; index += 1) {
        const query = queries[index];
        if (query === undefined || this.failHolders.has(query.holder)) {
          continue;
        }
        results[index] =
          this.evmBalances[`${query.holder}|${query.token?.toLowerCase() ?? 'native'}`] ?? 0n;
      }
    }
    return results;
  }

  async cardano(
    _url: string,
    addresses: readonly string[],
    budget: CallBudget
  ): Promise<Map<string, CardanoHoldings>> {
    const result = new Map<string, CardanoHoldings>();
    if (budget.remaining <= 0) {
      return result;
    }
    budget.remaining -= 1;
    budget.used += 1;
    this.requests += 1;
    for (const address of addresses) {
      if (!this.failHolders.has(address)) {
        result.set(address, this.cardanoBalances[address] ?? { lovelace: 0n, assets: new Map() });
      }
    }
    return result;
  }

  supportsCardano(url: string): boolean {
    return !url.includes('blockfrost');
  }
}
