import { type Collection, type Db, MongoClient, MongoServerError } from 'mongodb';
import type {
  ChainInfo,
  DailyPrice,
  HourlyFacts,
  IngestCheckpoints,
  IngestedTransaction,
  IngestedUser,
  IngestRepository,
  LiveAggregates,
  NetworkWallets,
  RunSnapshot,
  StoredAggregates,
  TokenInfo,
  UserActivity,
  UserSignup,
  WalletObservation
} from '../ingest/types.js';
import type { IngestRunStatus } from '../metrics/types.js';
import { connectOrClose } from './connect-retry.js';

/**
 * Collections of the ingestion in the analytics database. Copies are keyed by the B2C id and
 * aggregates by a build stamp; every read is by `_id`, by that stamp over collections that are
 * replaced as a whole, or a full read of a small collection (one snapshot per run, one observation
 * per wallet), so none needs an index besides the default one.
 */
export const INGEST_COLLECTIONS = {
  state: 'ingest_state',
  transactions: 'b2c_transactions',
  users: 'b2c_users',
  tokens: 'b2c_tokens',
  networks: 'b2c_networks',
  prices: 'token_prices',
  hourly: 'agg_hourly',
  activity: 'agg_user_activity',
  signups: 'agg_user_signups',
  snapshots: 'ingest_snapshots',
  walletObservations: 'wallet_first_seen'
} as const;

const CHECKPOINTS_ID = 'checkpoints';
const LOCK_ID = 'lock';
const AGGREGATES_ID = 'aggregates';
const DUPLICATE_KEY = 11000;

interface StateDoc {
  _id: string;
  transactionsLastId?: string | null;
  pricesLastDay?: string | null;
  walletsTrackingSince?: Date | null;
  owner?: string | null;
  until?: Date | null;
  builtAt?: Date | null;
  run?: IngestRunStatus | null;
  wallets?: NetworkWallets[];
}

type TransactionDoc = Omit<IngestedTransaction, 'id'> & { _id: string };
type UserDoc = Omit<IngestedUser, 'id'> & { _id: string; seenAt: Date };
type TokenDoc = TokenInfo & { _id: string };
type NetworkDoc = ChainInfo & { _id: string };
type PriceDoc = DailyPrice & { _id: string };
type SnapshotDoc = RunSnapshot & { _id: string };
type ObservationDoc = WalletObservation & { _id: string };
type Stamped<T> = T & { _id: string; builtAt: Date };

/** Connection settings of {@link MongoIngestRepository.connect}. */
export interface MongoIngestRepositoryOptions {
  uri: string;
  dbName: string;
}

function strip<T extends { _id: string; builtAt?: Date }>(doc: T): Omit<T, '_id' | 'builtAt'> {
  const { _id, builtAt, ...rest } = doc;
  return rest;
}

/**
 * {@link IngestRepository} on the analytics database.
 *
 * The lock is a document of `ingest_state` taken with a conditional upsert, so two runs racing
 * for it get one winner and one duplicate-key error. Aggregates are written with a build stamp,
 * the previous build is deleted, and only then `builtAt` moves to the new stamp; readers load the
 * stamp `builtAt` names, so they never mix two builds.
 */
export class MongoIngestRepository implements IngestRepository {
  private readonly state: Collection<StateDoc>;

  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db
  ) {
    this.state = db.collection<StateDoc>(INGEST_COLLECTIONS.state);
  }

  /**
   * Connects to the analytics database.
   *
   * @param options - Connection string and database name.
   * @returns The connected repository.
   */
  static async connect(options: MongoIngestRepositoryOptions): Promise<MongoIngestRepository> {
    const client = new MongoClient(options.uri, {
      serverSelectionTimeoutMS: 10_000,
      appName: 'chatterpay-analytics-api'
    });
    await connectOrClose(client);
    return new MongoIngestRepository(client, client.db(options.dbName));
  }

  private collection<T extends { _id: string }>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  async readCheckpoints(): Promise<IngestCheckpoints> {
    const doc = await this.state.findOne({ _id: CHECKPOINTS_ID });
    return {
      transactionsLastId: doc?.transactionsLastId ?? null,
      pricesLastDay: doc?.pricesLastDay ?? null,
      walletsTrackingSince: doc?.walletsTrackingSince ?? null
    };
  }

  async saveCheckpoints(patch: Partial<IngestCheckpoints>): Promise<void> {
    await this.state.updateOne({ _id: CHECKPOINTS_ID }, { $set: patch }, { upsert: true });
  }

  async acquireLock(owner: string, now: Date, ttlMs: number): Promise<boolean> {
    try {
      const result = await this.state.findOneAndUpdate(
        {
          _id: LOCK_ID,
          $or: [{ until: null }, { until: { $exists: false } }, { until: { $lte: now } }]
        },
        { $set: { owner, until: new Date(now.getTime() + ttlMs) } },
        { upsert: true, returnDocument: 'after' }
      );
      return result?.owner === owner;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
        return false;
      }
      throw error;
    }
  }

  async releaseLock(owner: string): Promise<void> {
    await this.state.updateOne({ _id: LOCK_ID, owner }, { $set: { owner: null, until: null } });
  }

  async upsertTransactions(items: readonly IngestedTransaction[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.collection<TransactionDoc>(INGEST_COLLECTIONS.transactions).bulkWrite(
      items.map(({ id, ...rest }) => ({
        replaceOne: { filter: { _id: id }, replacement: rest, upsert: true }
      })),
      { ordered: false }
    );
  }

  async replaceUsers(items: readonly IngestedUser[], now: Date): Promise<void> {
    const users = this.collection<UserDoc>(INGEST_COLLECTIONS.users);
    if (items.length > 0) {
      await users.bulkWrite(
        // Fields are picked one by one, so nothing else a caller passes is ever stored.
        items.map(({ id, createdAt, wallets }) => ({
          replaceOne: {
            filter: { _id: id },
            replacement: {
              createdAt,
              wallets: wallets.map(({ chainId, address }) => ({ chainId, address })),
              seenAt: now
            },
            upsert: true
          }
        })),
        { ordered: false }
      );
    }
    // Users deleted in the B2C database were not stamped by this run.
    await users.deleteMany({ seenAt: { $ne: now } });
  }

  async replaceCatalog(tokens: readonly TokenInfo[], chains: readonly ChainInfo[]): Promise<void> {
    const tokenDocs = this.collection<TokenDoc>(INGEST_COLLECTIONS.tokens);
    const networkDocs = this.collection<NetworkDoc>(INGEST_COLLECTIONS.networks);
    const tokenIds = tokens.map((token) => `${token.chainId}|${token.symbol}`);
    const networkIds = chains.map((chain) => chain.chainId);
    if (tokens.length > 0) {
      await tokenDocs.bulkWrite(
        tokens.map((token, index) => ({
          replaceOne: { filter: { _id: tokenIds[index] ?? '' }, replacement: token, upsert: true }
        })),
        { ordered: false }
      );
    }
    if (chains.length > 0) {
      await networkDocs.bulkWrite(
        chains.map((chain) => ({
          replaceOne: { filter: { _id: chain.chainId }, replacement: chain, upsert: true }
        })),
        { ordered: false }
      );
    }
    await tokenDocs.deleteMany({ _id: { $nin: tokenIds } });
    await networkDocs.deleteMany({ _id: { $nin: networkIds } });
  }

  async savePrices(items: readonly DailyPrice[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.collection<PriceDoc>(INGEST_COLLECTIONS.prices).bulkWrite(
      items.map((item) => ({
        replaceOne: {
          filter: { _id: `${item.symbol}|${item.day}|${item.source}` },
          replacement: item,
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  async transactions(): Promise<IngestedTransaction[]> {
    const docs = await this.collection<TransactionDoc>(INGEST_COLLECTIONS.transactions)
      .find({})
      .toArray();
    return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
  }

  async users(): Promise<IngestedUser[]> {
    const docs = await this.collection<UserDoc>(INGEST_COLLECTIONS.users).find({}).toArray();
    return docs.map(({ _id, createdAt, wallets }) => ({ id: _id, createdAt, wallets }));
  }

  async tokens(): Promise<TokenInfo[]> {
    const docs = await this.collection<TokenDoc>(INGEST_COLLECTIONS.tokens).find({}).toArray();
    return docs.map(({ chainId, symbol, stable, address, decimals }) => ({
      chainId,
      symbol,
      stable,
      // Copies written before these fields were read have neither.
      address: address ?? '',
      decimals: decimals ?? null
    }));
  }

  async chains(): Promise<ChainInfo[]> {
    const docs = await this.collection<NetworkDoc>(INGEST_COLLECTIONS.networks).find({}).toArray();
    return docs.map(({ chainId, network, name, explorer, contracts }) => ({
      chainId,
      network,
      name,
      explorer,
      contracts
    }));
  }

  async prices(): Promise<DailyPrice[]> {
    const docs = await this.collection<PriceDoc>(INGEST_COLLECTIONS.prices).find({}).toArray();
    return docs.map(({ symbol, day, usd, source }) => ({ symbol, day, usd, source }));
  }

  async saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    await this.collection<SnapshotDoc>(INGEST_COLLECTIONS.snapshots).replaceOne(
      { _id: String(snapshot.takenAt.getTime()) },
      snapshot,
      { upsert: true }
    );
  }

  async walletObservations(): Promise<WalletObservation[]> {
    const docs = await this.collection<ObservationDoc>(INGEST_COLLECTIONS.walletObservations)
      .find({})
      .toArray();
    return docs.map(({ chainId, address, firstObservedAt, bounded }) => ({
      chainId,
      address,
      firstObservedAt,
      bounded
    }));
  }

  async addWalletObservations(items: readonly WalletObservation[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    // `$setOnInsert` keeps the first observation of a wallet when a retried run sees it again.
    await this.collection<ObservationDoc>(INGEST_COLLECTIONS.walletObservations).bulkWrite(
      items.map((item) => ({
        updateOne: {
          filter: { _id: `${item.chainId}|${item.address}` },
          update: { $setOnInsert: item },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  async saveAggregates(
    aggregates: LiveAggregates,
    builtAt: Date,
    run: IngestRunStatus
  ): Promise<void> {
    const write = async <T>(name: string, items: readonly T[], key: (item: T) => string) => {
      const collection = this.collection<Stamped<T>>(name);
      const stamp = builtAt.getTime();
      if (items.length > 0) {
        await collection.insertMany(
          items.map((item) => ({ ...item, _id: `${stamp}|${key(item)}`, builtAt }) as never),
          { ordered: false }
        );
      }
      return collection;
    };
    const written = [
      await write<HourlyFacts>(
        INGEST_COLLECTIONS.hourly,
        aggregates.hourly,
        (item) => `${item.network}|${item.hour}`
      ),
      await write<UserActivity>(
        INGEST_COLLECTIONS.activity,
        aggregates.activity,
        (item) => `${item.network}|${item.user}`
      ),
      await write<UserSignup>(
        INGEST_COLLECTIONS.signups,
        aggregates.signups,
        (item) => `${item.network}|${item.user}`
      )
    ];
    await this.state.updateOne(
      { _id: AGGREGATES_ID },
      { $set: { builtAt, run, wallets: aggregates.wallets } },
      { upsert: true }
    );
    for (const collection of written) {
      await collection.deleteMany({ builtAt: { $ne: builtAt } });
    }
  }

  async aggregatesBuiltAt(): Promise<Date | null> {
    return (await this.state.findOne({ _id: AGGREGATES_ID }))?.builtAt ?? null;
  }

  async loadAggregates(): Promise<StoredAggregates | null> {
    const state = await this.state.findOne({ _id: AGGREGATES_ID });
    const builtAt = state?.builtAt ?? null;
    if (builtAt === null) {
      return null;
    }
    const checkpoints = await this.readCheckpoints();
    // A run that stored its snapshot and stopped before building belongs to no build yet.
    const snapshots = (
      await this.collection<SnapshotDoc>(INGEST_COLLECTIONS.snapshots).find({}).toArray()
    )
      .map(({ _id, ...rest }) => rest)
      .filter((snapshot) => snapshot.takenAt.getTime() <= builtAt.getTime())
      .sort((left, right) => left.takenAt.getTime() - right.takenAt.getTime());
    const read = async <T>(name: string): Promise<T[]> =>
      (await this.collection<Stamped<T>>(name).find({ builtAt }).toArray()).map(
        (doc) => strip(doc) as T
      );
    return {
      builtAt,
      run: state?.run ?? null,
      walletsTrackingSince: checkpoints.walletsTrackingSince,
      snapshots,
      hourly: await read<HourlyFacts>(INGEST_COLLECTIONS.hourly),
      activity: await read<UserActivity>(INGEST_COLLECTIONS.activity),
      signups: await read<UserSignup>(INGEST_COLLECTIONS.signups),
      wallets: state?.wallets ?? []
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
