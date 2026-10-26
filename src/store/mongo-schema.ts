import type { Db, IndexSpecification } from 'mongodb';

/** Collection names of the analytics database. */
export const COLLECTIONS = {
  users: 'users',
  sessions: 'sessions',
  challenges: 'login_challenges',
  invites: 'invites',
  activity: 'activity',
  rateLimits: 'rate_limits',
  /**
   * Settings of the analytics, one document per setting keyed by `_id` (`network_visibility`).
   * Reads and compare-and-set writes go by `_id`, so the collection needs no index of its own.
   */
  settings: 'analytics_settings'
} as const;

/**
 * `_id` of the settings document of the networks: the hidden chain ids, the revision of the
 * visibility policy and, written by an operator, `uncollectedChainIds`, the chain ids whose
 * balances the ingestion does not read. Visibility changes `$set` their own fields only, so they
 * keep `uncollectedChainIds`; an operator write bumps `revision`, so it conflicts with a
 * concurrent visibility change instead of being lost.
 */
export const NETWORK_SETTINGS_ID = 'network_visibility';

/** Index the store relies on: invariants (unique) and expiry (TTL). */
export interface RequiredIndex {
  collection: string;
  name: string;
  key: IndexSpecification;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

/**
 * Indexes the API needs. The API does not create them: they are created once per database by an
 * operator, and {@link assertIndexes} refuses to start without them, because the unique indexes
 * are what keeps two concurrent requests from both passing an invariant check.
 */
export const REQUIRED_INDEXES: readonly RequiredIndex[] = [
  {
    // One active member per email; removed members keep their record for the activity log.
    collection: COLLECTIONS.users,
    name: 'email_active_unique',
    key: { email: 1 },
    unique: true,
    partialFilterExpression: { status: 'active' }
  },
  { collection: COLLECTIONS.users, name: 'status_role', key: { status: 1, role: 1 } },
  { collection: COLLECTIONS.sessions, name: 'user_id', key: { userId: 1 } },
  {
    collection: COLLECTIONS.sessions,
    name: 'expires_at_ttl',
    key: { expiresAt: 1 },
    expireAfterSeconds: 0
  },
  {
    collection: COLLECTIONS.challenges,
    name: 'expires_at_ttl',
    key: { expiresAt: 1 },
    expireAfterSeconds: 0
  },
  {
    // One pending invite per email. Pending invites are stored as `simulated`; expired ones are
    // moved to `expired` before a new invite for the email is created.
    collection: COLLECTIONS.invites,
    name: 'email_pending_unique',
    key: { email: 1 },
    unique: true,
    partialFilterExpression: { status: 'simulated' }
  },
  {
    collection: COLLECTIONS.invites,
    name: 'mutation_id_unique',
    key: { mutationId: 1 },
    unique: true
  },
  { collection: COLLECTIONS.invites, name: 'created_at', key: { createdAt: -1 } },
  { collection: COLLECTIONS.activity, name: 'at', key: { at: -1, _id: -1 } },
  {
    collection: COLLECTIONS.rateLimits,
    name: 'reset_at_ttl',
    key: { resetAt: 1 },
    expireAfterSeconds: 0
  }
];

/**
 * Checks that every required index exists, by name, in its collection.
 *
 * @param db - Analytics database.
 * @returns The missing indexes as `collection.name`; empty when all exist.
 */
export async function missingIndexes(db: Db): Promise<string[]> {
  const existing = new Map<string, Set<string>>();
  const collections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name)
  );
  for (const name of new Set(REQUIRED_INDEXES.map((index) => index.collection))) {
    const indexes = collections.has(name) ? await db.collection(name).indexes() : [];
    existing.set(name, new Set(indexes.map((index) => String(index.name))));
  }
  return REQUIRED_INDEXES.filter((index) => !existing.get(index.collection)?.has(index.name)).map(
    (index) => `${index.collection}.${index.name}`
  );
}

/**
 * Refuses to run against a database without the required indexes.
 *
 * @param db - Analytics database.
 * @throws {Error} Naming the missing indexes.
 */
export async function assertIndexes(db: Db): Promise<void> {
  const missing = await missingIndexes(db);
  if (missing.length > 0) {
    throw new Error(`Missing MongoDB indexes: ${missing.join(', ')}`);
  }
}

/**
 * Creates the required indexes. Used by the integration tests on their throwaway database; the
 * API never calls it.
 *
 * @param db - Database to prepare.
 */
export async function createRequiredIndexes(db: Db): Promise<void> {
  for (const index of REQUIRED_INDEXES) {
    await db.collection(index.collection).createIndex(index.key, {
      name: index.name,
      ...(index.unique === undefined ? {} : { unique: index.unique }),
      ...(index.expireAfterSeconds === undefined
        ? {}
        : { expireAfterSeconds: index.expireAfterSeconds }),
      ...(index.partialFilterExpression === undefined
        ? {}
        : { partialFilterExpression: index.partialFilterExpression })
    });
  }
}
