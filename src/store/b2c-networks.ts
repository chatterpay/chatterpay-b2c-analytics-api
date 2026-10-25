import { MongoClient } from 'mongodb';
import type { ChainInfo } from '../ingest/types.js';
import type { NetworkDefinition, NetworkFamily } from '../metrics/catalog.js';
import { MongoB2cActivityReader } from './b2c-activity.js';
import { connectOrClose } from './connect-retry.js';

/** Options of {@link B2cNetworkSource.connect}. */
export interface B2cNetworkSourceOptions {
  uri: string;
  dbName: string;
}

interface BlockchainDocument {
  name?: unknown;
  family?: unknown;
  chainId?: unknown;
  enabled?: unknown;
}

/**
 * Chain id of a B2C document as a decimal string. Chain ids are int32, int64 (`Long`) or double
 * depending on who wrote the document.
 *
 * @param value - Raw `chainId` or `chain_id`.
 * @returns The decimal string; empty when the value is not a number.
 */
export function chainIdText(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return '';
}

/**
 * Family of a B2C `blockchains` document. EVM documents may omit `family`.
 *
 * @param value - Raw `family`.
 * @returns The family; `null` for families the catalog does not carry.
 */
export function familyOf(value: unknown): NetworkFamily | null {
  if (value === undefined || value === 'evm') {
    return 'evm';
  }
  return value === 'cardano' ? 'cardano' : null;
}

/**
 * Database named in the path of a MongoDB connection string.
 *
 * @param uri - Connection string, such as `mongodb+srv://user:pass@host/chatterpay-dev?w=majority`.
 * @returns The database name; `null` when the path is empty.
 */
export function databaseFromUri(uri: string): string | null {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]*\/([^?]*)/.exec(uri);
  const name = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
  return name === '' ? null : name;
}

/**
 * Slug of a network name, used as its id in the API and in the site URLs.
 *
 * @param name - Name in the `blockchains` collection, such as `Base Sepolia`.
 * @returns The slug, such as `base-sepolia`; empty when the name has no letters or digits.
 */
export function networkSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Maps the `blockchains` documents to catalog networks, sorted by name.
 *
 * EVM documents may omit `family`. Documents of other families are skipped, because the synthetic
 * dataset has no template for them, and so are documents without a usable name or chain id and
 * repeated slugs or chain ids. `enabled` is carried as information only: a network disabled for
 * new B2C operations keeps its history in the analytics.
 *
 * @param documents - Documents with `name`, `family`, `chainId` and `enabled`.
 * @returns The networks of the catalog.
 */
export function toNetworkDefinitions(
  documents: readonly BlockchainDocument[]
): NetworkDefinition[] {
  const seen = new Set<string>();
  const seenChains = new Set<string>();
  const definitions: NetworkDefinition[] = [];
  for (const document of documents) {
    if (typeof document.name !== 'string') {
      continue;
    }
    const family = familyOf(document.family);
    const label = document.name.trim();
    const id = networkSlug(label);
    const chainId = chainIdText(document.chainId);
    if (
      family === null ||
      id === '' ||
      id === 'all' ||
      !/^\d+$/.test(chainId) ||
      seen.has(id) ||
      seenChains.has(chainId)
    ) {
      continue;
    }
    seen.add(id);
    seenChains.add(chainId);
    definitions.push({
      id,
      label,
      family,
      chainId,
      b2cEnabled: typeof document.enabled === 'boolean' ? document.enabled : null,
      sourcePresent: true
    });
  }
  return sortByLabel(definitions);
}

function sortByLabel(definitions: NetworkDefinition[]): NetworkDefinition[] {
  return definitions.sort((left, right) => left.label.localeCompare(right.label, 'en'));
}

/**
 * Catalog of the analytics: the networks of the B2C database plus the networks the analytics
 * database retains for their history after the B2C database dropped them. A retained network keeps
 * the id, label and family of its last copy, so its activity stays reachable without the B2C
 * document.
 *
 * @param source - Networks read from the B2C `blockchains` collection.
 * @param retained - Network copies of the analytics database (`b2c_networks`).
 * @returns The networks, sorted by name.
 */
export function mergeCatalog(
  source: readonly NetworkDefinition[],
  retained: readonly ChainInfo[]
): NetworkDefinition[] {
  const ids = new Set(source.map((network) => network.id));
  const chainIds = new Set(source.map((network) => network.chainId));
  const merged = [...source];
  for (const chain of retained) {
    const label = chain.name.trim();
    if (
      ids.has(chain.network) ||
      chainIds.has(chain.chainId) ||
      !/^\d+$/.test(chain.chainId) ||
      label === ''
    ) {
      continue;
    }
    ids.add(chain.network);
    chainIds.add(chain.chainId);
    merged.push({
      id: chain.network,
      label,
      family: chain.family,
      chainId: chain.chainId,
      b2cEnabled: null,
      sourcePresent: false
    });
  }
  return sortByLabel(merged);
}

/**
 * Read-only access to the `blockchains` collection of the ChatterPay B2C database, the source of
 * the networks that the metrics endpoints offer. Only `name`, `family`, `chainId` and `enabled`
 * are read here, from every document whatever its `enabled`;
 * {@link B2cNetworkSource.activity} reads the collections the ingestion copies.
 */
export class B2cNetworkSource {
  private constructor(
    private readonly client: MongoClient,
    private readonly dbName: string
  ) {}

  /**
   * Connects to the B2C database.
   *
   * @param options - Connection string and database name.
   * @returns The connected source.
   */
  static async connect(options: B2cNetworkSourceOptions): Promise<B2cNetworkSource> {
    const client = new MongoClient(options.uri, {
      serverSelectionTimeoutMS: 10_000,
      appName: 'chatterpay-analytics-api',
      readPreference: 'secondaryPreferred'
    });
    await connectOrClose(client);
    return new B2cNetworkSource(client, options.dbName);
  }

  /**
   * Reads the networks of the B2C database.
   *
   * @returns The catalog networks, sorted by name.
   */
  async load(): Promise<NetworkDefinition[]> {
    const documents = await this.client
      .db(this.dbName)
      .collection<BlockchainDocument>('blockchains')
      .find({}, { projection: { _id: 0, name: 1, family: 1, chainId: 1, enabled: 1 } })
      .toArray();
    return toNetworkDefinitions(documents);
  }

  /**
   * Reader of the B2C activity collections over the same connection.
   *
   * @returns The reader.
   */
  activity(): MongoB2cActivityReader {
    return new MongoB2cActivityReader(this.client.db(this.dbName));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
