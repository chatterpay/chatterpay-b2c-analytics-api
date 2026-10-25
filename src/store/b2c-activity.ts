import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { type Db, type Filter, type Document as MongoDocument, ObjectId } from 'mongodb';
import type {
  B2cActivityReader,
  B2cUserRecord,
  ChainEndpoint,
  ChainInfo,
  IngestedTransaction,
  TokenInfo,
  TransactionCursor
} from '../ingest/types.js';
import { chainIdText, familyOf, networkSlug, toNetworkDefinitions } from './b2c-networks.js';

/** Fields of a B2C `transactions` row that the ingestion copies. */
const TRANSACTION_PROJECTION = {
  trx_hash: 1,
  wallet_from: 1,
  wallet_to: 1,
  type: 1,
  status: 1,
  date: 1,
  amount: 1,
  fee: 1,
  token: 1,
  chain_id: 1
} as const;

/**
 * Fields of a B2C `users` document that the ingestion reads. The phone number is read only to
 * derive the country of its calling code and is dropped right after; nothing else that identifies
 * a person is read.
 */
const USER_PROJECTION = {
  creationDate: 1,
  phone_number: 1,
  'wallets.chain_id': 1,
  'wallets.wallet_proxy': 1
} as const;

/** Country category of a phone number without a single country. */
export const UNKNOWN_COUNTRY = 'Unknown';

/**
 * Country of the calling code of a phone number. B2C numbers are stored as digits in international
 * format, mostly without the leading `+`.
 *
 * @param phone - Phone number as stored.
 * @returns ISO 3166-1 alpha-2 code, or {@link UNKNOWN_COUNTRY} when the number gives no single
 *   country (shared calling codes without a matching range, or an unparsable number).
 */
export function countryOfPhone(phone: unknown): string {
  if (typeof phone !== 'string') {
    return UNKNOWN_COUNTRY;
  }
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 6) {
    return UNKNOWN_COUNTRY;
  }
  return parsePhoneNumberFromString(`+${digits}`)?.country ?? UNKNOWN_COUNTRY;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function amountOf(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isFinite(number) ? number : 0;
}

/**
 * Maps a B2C `transactions` document to its ingested copy.
 *
 * @param document - Raw document.
 * @returns The copy; `null` when it has no ObjectId or no date.
 */
export function toIngestedTransaction(document: MongoDocument): IngestedTransaction | null {
  const id = document._id;
  const date = document.date;
  if (!(id instanceof ObjectId) || !(date instanceof Date)) {
    return null;
  }
  return {
    id: id.toHexString(),
    hash: text(document.trx_hash),
    from: text(document.wallet_from),
    to: text(document.wallet_to),
    type: text(document.type),
    status: text(document.status),
    date,
    amount: amountOf(document.amount),
    fee: amountOf(document.fee),
    token: text(document.token),
    chainId: chainIdText(document.chain_id)
  };
}

/**
 * Maps a B2C `users` document to its ingested record.
 *
 * @param document - Document with the fields of the user projection.
 * @returns The record: id, signup date, wallets and the country of the phone number, never the
 *   number itself.
 */
export function toIngestedUser(document: MongoDocument): B2cUserRecord {
  const wallets: unknown = document.wallets;
  return {
    id: String(document._id),
    createdAt: document.creationDate instanceof Date ? document.creationDate : null,
    country: countryOfPhone(document.phone_number),
    wallets: Array.isArray(wallets)
      ? wallets
          .map((wallet: MongoDocument) => ({
            chainId: chainIdText(wallet.chain_id),
            address: text(wallet.wallet_proxy)
          }))
          .filter((wallet) => wallet.chainId !== '' && wallet.address !== '')
      : []
  };
}

/**
 * Read-only access to the B2C `transactions`, `users`, `tokens` and `blockchains` collections.
 * Transactions are read by `_id` ranges, which the default index serves.
 */
export class MongoB2cActivityReader implements B2cActivityReader {
  /**
   * @param db - B2C database.
   */
  constructor(private readonly db: Db) {}

  async transactions(cursor: TransactionCursor, limit: number): Promise<IngestedTransaction[]> {
    const range: { $gt?: ObjectId; $gte?: ObjectId; $lte?: ObjectId } = {};
    const after = cursor.afterId === null ? null : new ObjectId(cursor.afterId);
    // An ObjectId starts with its creation second, so the lowest id of an instant bounds the rows
    // inserted from then on. The stricter of the two lower bounds applies.
    const since =
      cursor.since === null
        ? null
        : ObjectId.createFromTime(Math.floor(cursor.since.getTime() / 1000));
    if (since !== null && (after === null || since.toHexString() > after.toHexString())) {
      range.$gte = since;
    } else if (after !== null) {
      range.$gt = after;
    }
    if (cursor.untilId !== null) {
      range.$lte = new ObjectId(cursor.untilId);
    }
    const filter: Filter<MongoDocument> = Object.keys(range).length === 0 ? {} : { _id: range };
    const documents = await this.db
      .collection('transactions')
      .find(filter, { projection: TRANSACTION_PROJECTION })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return documents
      .map(toIngestedTransaction)
      .filter((item): item is IngestedTransaction => item !== null);
  }

  async users(): Promise<B2cUserRecord[]> {
    const documents = await this.db
      .collection('users')
      .find({}, { projection: USER_PROJECTION })
      .toArray();
    return documents.map(toIngestedUser);
  }

  async tokens(): Promise<TokenInfo[]> {
    // Every token whatever its `enabled`: a token closed to new operations still values history.
    const documents = await this.db
      .collection('tokens')
      .find(
        {},
        { projection: { _id: 0, chain_id: 1, symbol: 1, type: 1, address: 1, decimals: 1 } }
      )
      .toArray();
    return documents
      .map((document) => ({
        chainId: chainIdText(document.chain_id),
        symbol: text(document.symbol),
        stable: document.type === 'stable',
        address: text(document.address),
        decimals:
          typeof document.decimals === 'number' &&
          Number.isInteger(document.decimals) &&
          document.decimals >= 0 &&
          document.decimals <= 36
            ? document.decimals
            : null
      }))
      .filter((token) => token.chainId !== '' && token.symbol !== '');
  }

  async chains(): Promise<ChainInfo[]> {
    const documents = await this.db
      .collection('blockchains')
      .find(
        {},
        { projection: { _id: 0, name: 1, family: 1, chainId: 1, explorer: 1, contracts: 1 } }
      )
      .toArray();
    // Only networks the catalog accepts, so a chain maps to an id the metrics endpoints serve.
    // `enabled` is not read: a network closed to new B2C operations keeps its history.
    const accepted = new Set(
      toNetworkDefinitions(
        documents.map((document) => ({
          name: document.name,
          family: document.family,
          chainId: document.chainId
        }))
      ).map((network) => network.id)
    );
    const chains = new Map<string, ChainInfo>();
    for (const document of documents) {
      const name = text(document.name).trim();
      const network = networkSlug(name);
      const chainId = chainIdText(document.chainId);
      const family = familyOf(document.family);
      if (!accepted.has(network) || family === null || chainId === '' || chains.has(chainId)) {
        continue;
      }
      const contracts: Record<string, string> = {};
      const raw: unknown = document.contracts;
      if (typeof raw === 'object' && raw !== null) {
        for (const [role, address] of Object.entries(raw)) {
          if (typeof address === 'string' && address !== '') {
            contracts[role] = address;
          }
        }
      }
      chains.set(chainId, {
        chainId,
        network,
        name,
        family,
        explorer: text(document.explorer),
        contracts
      });
    }
    return [...chains.values()];
  }

  /**
   * Balance endpoints of the catalog networks: `rpc` of EVM networks and `providerUrl` of Cardano
   * ones. The URLs can carry a provider key, so they are only kept in memory for the run.
   */
  async endpoints(): Promise<ChainEndpoint[]> {
    const [chains, documents] = await Promise.all([
      this.chains(),
      this.db
        .collection('blockchains')
        .find({}, { projection: { _id: 0, family: 1, chainId: 1, rpc: 1, providerUrl: 1 } })
        .toArray()
    ]);
    const accepted = new Set(chains.map((chain) => chain.chainId));
    const endpoints = new Map<string, ChainEndpoint>();
    for (const document of documents) {
      const chainId = chainIdText(document.chainId);
      if (!accepted.has(chainId) || endpoints.has(chainId)) {
        continue;
      }
      const family = document.family === 'cardano' ? 'cardano' : 'evm';
      const url = text(family === 'cardano' ? document.providerUrl : document.rpc).trim();
      if (/^https:\/\//.test(url)) {
        endpoints.set(chainId, { chainId, family, url });
      }
    }
    return [...endpoints.values()];
  }

  /**
   * B2C `enabled` of the catalog networks, read on every run so the balance snapshot follows a
   * network closed to new B2C operations without a deploy.
   */
  async b2cEnabled(): Promise<Map<string, boolean | null>> {
    const documents = await this.db
      .collection('blockchains')
      .find({}, { projection: { _id: 0, name: 1, family: 1, chainId: 1, enabled: 1 } })
      .toArray();
    return new Map(
      toNetworkDefinitions(
        documents.map((document) => ({
          name: document.name,
          family: document.family,
          chainId: document.chainId,
          enabled: document.enabled
        }))
      ).map((network) => [network.chainId, network.b2cEnabled])
    );
  }
}
