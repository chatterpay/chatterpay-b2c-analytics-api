import { MongoClient } from 'mongodb';
import type { NetworkDefinition, NetworkFamily } from '../metrics/catalog.js';

/** Options of {@link B2cNetworkSource.connect}. */
export interface B2cNetworkSourceOptions {
  uri: string;
  dbName: string;
}

interface BlockchainDocument {
  name?: unknown;
  family?: unknown;
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
 * dataset has no template for them, and so are documents without a usable name and repeated slugs.
 *
 * @param documents - Documents with `name` and `family`.
 * @returns The networks of the catalog.
 */
export function toNetworkDefinitions(
  documents: readonly BlockchainDocument[]
): NetworkDefinition[] {
  const seen = new Set<string>();
  const definitions: NetworkDefinition[] = [];
  for (const document of documents) {
    if (typeof document.name !== 'string') {
      continue;
    }
    const family: NetworkFamily | null =
      document.family === undefined || document.family === 'evm'
        ? 'evm'
        : document.family === 'cardano'
          ? 'cardano'
          : null;
    const label = document.name.trim();
    const id = networkSlug(label);
    if (family === null || id === '' || id === 'all' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    definitions.push({ id, label, family });
  }
  return definitions.sort((left, right) => left.label.localeCompare(right.label, 'en'));
}

/**
 * Read-only access to the `blockchains` collection of the ChatterPay B2C database, the source of
 * the networks that the metrics endpoints offer. Only `name` and `family` are read.
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
      serverSelectionTimeoutMS: 5000,
      appName: 'chatterpay-analytics-api',
      readPreference: 'secondaryPreferred'
    });
    await client.connect();
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
      .find({}, { projection: { _id: 0, name: 1, family: 1 } })
      .toArray();
    return toNetworkDefinitions(documents);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
