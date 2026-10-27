import type { NetworkVisibility, Session, Store, User } from './types.js';

/** Options of {@link withReadCache}. */
export interface ReadCacheOptions {
  /** Lifetime of a cached read, in milliseconds. */
  ttlMs: number;
  /** Current time in milliseconds; `Date.now` by default. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Wraps a store so the reads every authenticated request makes come from memory for `ttlMs`: the
 * session by its id, the user by its id and the network visibility policy. Each of them is a
 * database round trip, and an API request makes three before it answers.
 *
 * A change made through the wrapped store drops the entries it affects on this instance at once:
 * a revoked session, a changed role, a removed member with all its sessions, a login, an
 * activation and any visibility change. A read that was in flight during such a change is
 * returned but not cached. A change made by another instance reaches this one when the entry
 * expires, so a session revoked or a member removed elsewhere keeps its access here for up to
 * `ttlMs`. Missing sessions and users are not cached.
 *
 * @param store - Store to wrap.
 * @param options - Lifetime of an entry and clock.
 * @returns The store with the cached reads.
 */
export function withReadCache(store: Store, options: ReadCacheOptions): Store {
  const { ttlMs } = options;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Entry<Session>>();
  const users = new Map<string, Entry<User>>();
  let policy: Entry<NetworkVisibility> | null = null;
  // Incremented by every invalidation; a read stores its result only when it did not change.
  let generation = 0;

  const fresh = <T>(entry: Entry<T> | null | undefined): entry is Entry<T> =>
    entry !== null && entry !== undefined && entry.expiresAt > now();

  /**
   * Reads through a map: a fresh entry, or the store, whose non-null answer is kept.
   *
   * @param map - Entries by key.
   * @param key - Key to read.
   * @param read - Store read for a missing or expired entry.
   * @returns The value, or `null` when the store has none.
   */
  async function cached<T>(
    map: Map<string, Entry<T>>,
    key: string,
    read: () => Promise<T | null>
  ): Promise<T | null> {
    const entry = map.get(key);
    if (fresh(entry)) {
      return entry.value;
    }
    const started = generation;
    const value = await read();
    if (value !== null && started === generation) {
      map.set(key, { value, expiresAt: now() + ttlMs });
    } else {
      map.delete(key);
    }
    return value;
  }

  const forgetUser = (userId: string): void => {
    generation += 1;
    users.delete(userId);
    for (const [jti, entry] of sessions) {
      if (entry.value.userId === userId) {
        sessions.delete(jti);
      }
    }
  };

  const forgetPolicy = (): void => {
    generation += 1;
    policy = null;
  };

  const overrides: Partial<Store> = {
    findSession: (jti) => cached(sessions, jti, () => store.findSession(jti)),
    findUserById: (id) => cached(users, id, () => store.findUserById(id)),
    async networkVisibility() {
      if (fresh(policy)) {
        return policy.value;
      }
      const started = generation;
      const value = await store.networkVisibility();
      if (started === generation) {
        policy = { value, expiresAt: now() + ttlMs };
      }
      return value;
    },
    async revokeSession(jti, at) {
      const forget = (): void => {
        generation += 1;
        sessions.delete(jti);
      };
      forget();
      try {
        await store.revokeSession(jti, at);
      } finally {
        forget();
      }
    },
    async changeRole(userId, role) {
      forgetUser(userId);
      try {
        return await store.changeRole(userId, role);
      } finally {
        forgetUser(userId);
      }
    },
    async removeUser(userId, at) {
      forgetUser(userId);
      try {
        return await store.removeUser(userId, at);
      } finally {
        forgetUser(userId);
      }
    },
    async recordLogin(userId, at) {
      try {
        return await store.recordLogin(userId, at);
      } finally {
        forgetUser(userId);
      }
    },
    async activateMember(email, at) {
      try {
        return await store.activateMember(email, at);
      } finally {
        generation += 1;
        users.clear();
      }
    },
    async ensureUser(email, role, at) {
      try {
        return await store.ensureUser(email, role, at);
      } finally {
        generation += 1;
        users.clear();
      }
    },
    async changeNetworkVisibility(change, at) {
      try {
        return await store.changeNetworkVisibility(change, at);
      } finally {
        forgetPolicy();
      }
    },
    async changeTokenVisibility(change, at) {
      try {
        return await store.changeTokenVisibility(change, at);
      } finally {
        forgetPolicy();
      }
    }
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof Store];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
