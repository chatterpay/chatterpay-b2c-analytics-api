import { randomUUID } from 'node:crypto';
import { type Collection, type Db, MongoClient, MongoServerError, ObjectId } from 'mongodb';
import type { Role } from '../auth/principal.js';
import { assertIndexes, COLLECTIONS } from './mongo-schema.js';
import type {
  ActivatedMember,
  ActivityEvent,
  Challenge,
  CreateInviteResult,
  Invite,
  InviteTransitionResult,
  MemberMutationResult,
  NewInvite,
  RateLimitResult,
  Session,
  Store,
  User
} from './types.js';

type UserDoc = Omit<User, 'id'> & { _id: string };
type SessionDoc = Omit<Session, 'jti'> & { _id: string };
type ChallengeDoc = Omit<Challenge, 'id'> & { _id: string };
type InviteDoc = Omit<Invite, 'id'> & { _id: string };
type ActivityDoc = Omit<ActivityEvent, 'id'> & { _id: ObjectId };
interface CounterDoc {
  _id: string;
  count: number;
  resetAt: Date;
}

const DUPLICATE_KEY = 11000;
const PENDING = 'simulated';

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY;
}

function toUser({ _id, ...rest }: UserDoc): User {
  return { id: _id, ...rest };
}

function toSession({ _id, ...rest }: SessionDoc): Session {
  return { jti: _id, ...rest };
}

function toChallenge({ _id, ...rest }: ChallengeDoc): Challenge {
  return { id: _id, ...rest };
}

function toInvite({ _id, ...rest }: InviteDoc, now: Date): Invite {
  const expired = rest.status === PENDING && rest.expiresAt.getTime() <= now.getTime();
  return { id: _id, ...rest, status: expired ? 'expired' : rest.status };
}

function toActivity({ _id, ...rest }: ActivityDoc): ActivityEvent {
  return { id: _id.toHexString(), ...rest };
}

/** Connection settings of {@link MongoStore.connect}. */
export interface MongoStoreOptions {
  uri: string;
  dbName: string;
}

/**
 * {@link Store} backed by MongoDB, shared by every instance of the service.
 *
 * Invariants hold without multi-document transactions, so a standalone server works too:
 * - one active member and one pending invite per email, and one invite per `mutationId`, come
 *   from unique indexes; a duplicate-key error is read as the conflict or the replay it means;
 * - challenge attempts, consumption and invite transitions are single conditional updates;
 * - the last active admin is protected by applying the change and undoing it when no active admin
 *   remains. Two concurrent changes that would each remove the last admin can both be undone; the
 *   team never ends without an admin.
 */
export class MongoStore implements Store {
  readonly kind: 'mongo' = 'mongo';
  private readonly users: Collection<UserDoc>;
  private readonly sessions: Collection<SessionDoc>;
  private readonly challenges: Collection<ChallengeDoc>;
  private readonly invites: Collection<InviteDoc>;
  private readonly activity: Collection<ActivityDoc>;
  private readonly counters: Collection<CounterDoc>;

  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db
  ) {
    this.users = db.collection<UserDoc>(COLLECTIONS.users);
    this.sessions = db.collection<SessionDoc>(COLLECTIONS.sessions);
    this.challenges = db.collection<ChallengeDoc>(COLLECTIONS.challenges);
    this.invites = db.collection<InviteDoc>(COLLECTIONS.invites);
    this.activity = db.collection<ActivityDoc>(COLLECTIONS.activity);
    this.counters = db.collection<CounterDoc>(COLLECTIONS.rateLimits);
  }

  /**
   * Connects and checks the required indexes.
   *
   * @param options - Connection string and database name.
   * @returns The connected store.
   * @throws {Error} When the server is unreachable or an index is missing.
   */
  static async connect(options: MongoStoreOptions): Promise<MongoStore> {
    const client = new MongoClient(options.uri, {
      serverSelectionTimeoutMS: 5000,
      appName: 'chatterpay-analytics-api'
    });
    await client.connect();
    try {
      const db = client.db(options.dbName);
      await assertIndexes(db);
      return new MongoStore(client, db);
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ensureUser(email: string, role: Role, now: Date): Promise<User> {
    const existing = await this.users.findOne({ email, status: 'active' });
    if (existing !== null) {
      return toUser(existing);
    }
    try {
      return await this.insertUser(email, role, now);
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      const winner = await this.users.findOne({ email, status: 'active' });
      if (winner === null) {
        throw error;
      }
      return toUser(winner);
    }
  }

  async findUserById(id: string): Promise<User | null> {
    const user = await this.users.findOne({ _id: id });
    return user === null ? null : toUser(user);
  }

  async findActiveUserByEmail(email: string): Promise<User | null> {
    const user = await this.users.findOne({ email, status: 'active' });
    return user === null ? null : toUser(user);
  }

  async listActiveUsers(): Promise<User[]> {
    const users = await this.users.find({ status: 'active' }).sort({ email: 1 }).toArray();
    return users.map(toUser);
  }

  async activateMember(email: string, now: Date): Promise<ActivatedMember | null> {
    const existing = await this.users.findOne({ email, status: 'active' });
    if (existing !== null) {
      return { user: toUser(existing), acceptedInvite: null };
    }
    // Claiming the invite first makes it the single winner between concurrent logins.
    const invite = await this.invites.findOneAndUpdate(
      { email, status: PENDING, expiresAt: { $gt: now } },
      { $set: { status: 'accepted' } },
      { returnDocument: 'after' }
    );
    if (invite === null) {
      return null;
    }
    try {
      const user = await this.insertUser(email, invite.role, now);
      return { user, acceptedInvite: toInvite(invite, now) };
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      const winner = await this.users.findOne({ email, status: 'active' });
      return winner === null ? null : { user: toUser(winner), acceptedInvite: null };
    }
  }

  async recordLogin(userId: string, now: Date): Promise<User | null> {
    const user = await this.users.findOneAndUpdate(
      { _id: userId, status: 'active' },
      { $set: { lastLoginAt: now } },
      { returnDocument: 'after' }
    );
    return user === null ? null : toUser(user);
  }

  async changeRole(userId: string, role: Role): Promise<MemberMutationResult> {
    const before = await this.users.findOneAndUpdate(
      { _id: userId, status: 'active' },
      { $set: { role } },
      { returnDocument: 'before' }
    );
    if (before === null) {
      return { kind: 'not_found' };
    }
    if (before.role === 'admin' && role !== 'admin' && !(await this.hasActiveAdmin())) {
      await this.users.updateOne({ _id: userId, role }, { $set: { role: 'admin' } });
      return { kind: 'last_admin' };
    }
    return { kind: 'ok', user: toUser({ ...before, role }) };
  }

  async removeUser(userId: string, now: Date): Promise<MemberMutationResult> {
    const before = await this.users.findOneAndUpdate(
      { _id: userId, status: 'active' },
      { $set: { status: 'removed' } },
      { returnDocument: 'before' }
    );
    if (before === null) {
      return { kind: 'not_found' };
    }
    if (before.role === 'admin' && !(await this.hasActiveAdmin())) {
      await this.users.updateOne(
        { _id: userId, status: 'removed' },
        { $set: { status: 'active' } }
      );
      return { kind: 'last_admin' };
    }
    await this.sessions.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } });
    return { kind: 'ok', user: toUser({ ...before, status: 'removed' }) };
  }

  async createSession(input: Omit<Session, 'revokedAt'>): Promise<Session> {
    const { jti, ...rest } = input;
    const doc: SessionDoc = { _id: jti, ...rest, revokedAt: null };
    await this.sessions.insertOne(doc);
    return toSession(doc);
  }

  async findSession(jti: string): Promise<Session | null> {
    const session = await this.sessions.findOne({ _id: jti });
    return session === null ? null : toSession(session);
  }

  async revokeSession(jti: string, now: Date): Promise<void> {
    await this.sessions.updateOne({ _id: jti, revokedAt: null }, { $set: { revokedAt: now } });
  }

  async createChallenge(email: string, now: Date, expiresAt: Date): Promise<Challenge> {
    const doc: ChallengeDoc = {
      _id: randomUUID(),
      email,
      createdAt: now,
      expiresAt,
      attempts: 0,
      consumedAt: null
    };
    await this.challenges.insertOne(doc);
    return toChallenge(doc);
  }

  async recordChallengeAttempt(
    id: string,
    maxAttempts: number,
    now: Date
  ): Promise<Challenge | null> {
    const challenge = await this.challenges.findOneAndUpdate(
      { _id: id, consumedAt: null, expiresAt: { $gt: now }, attempts: { $lt: maxAttempts } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' }
    );
    return challenge === null ? null : toChallenge(challenge);
  }

  async consumeChallenge(id: string, now: Date): Promise<boolean> {
    const result = await this.challenges.updateOne(
      { _id: id, consumedAt: null },
      { $set: { consumedAt: now } }
    );
    return result.modifiedCount === 1;
  }

  async createInvite(input: NewInvite, now: Date): Promise<CreateInviteResult> {
    const replay = await this.replayOf(input, now);
    if (replay !== null) {
      return replay;
    }
    if ((await this.users.findOne({ email: input.email, status: 'active' })) !== null) {
      return { kind: 'conflict' };
    }
    // Frees the unique pending slot of the email when its invite already expired.
    await this.invites.updateMany(
      { email: input.email, status: PENDING, expiresAt: { $lte: now } },
      { $set: { status: 'expired' } }
    );
    const doc: InviteDoc = {
      _id: randomUUID(),
      email: input.email,
      role: input.role,
      status: PENDING,
      createdAt: now,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      resendCount: 0,
      lastSentAt: now,
      mutationId: input.mutationId
    };
    try {
      await this.invites.insertOne(doc);
      return { kind: 'created', invite: toInvite(doc, now) };
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      return (await this.replayOf(input, now)) ?? { kind: 'conflict' };
    }
  }

  async listInvites(now: Date): Promise<Invite[]> {
    const invites = await this.invites.find({}).sort({ createdAt: -1 }).toArray();
    return invites.map((invite) => toInvite(invite, now));
  }

  async resendInvite(id: string, now: Date): Promise<InviteTransitionResult> {
    return this.transition(id, now, { $inc: { resendCount: 1 }, $set: { lastSentAt: now } });
  }

  async revokeInvite(id: string, now: Date): Promise<InviteTransitionResult> {
    return this.transition(id, now, { $set: { status: 'revoked' } });
  }

  async appendActivity(event: Omit<ActivityEvent, 'id'>): Promise<ActivityEvent> {
    const doc: ActivityDoc = { _id: new ObjectId(), ...event };
    await this.activity.insertOne(doc);
    return toActivity(doc);
  }

  async listActivity(limit: number): Promise<ActivityEvent[]> {
    const events = await this.activity.find({}).sort({ at: -1, _id: -1 }).limit(limit).toArray();
    return events.map(toActivity);
  }

  async hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitResult> {
    const resetAt = new Date(now.getTime() + windowMs);
    // Both fields read the stored values, so the window restarts and the count resets together.
    const expired = { $lte: [{ $ifNull: ['$resetAt', new Date(0)] }, now] };
    const counter = await this.counters.findOneAndUpdate(
      { _id: key },
      [
        {
          $set: {
            count: { $cond: [expired, 1, { $add: ['$count', 1] }] },
            resetAt: { $cond: [expired, resetAt, '$resetAt'] }
          }
        }
      ],
      { upsert: true, returnDocument: 'after' }
    );
    if (counter === null || counter.count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt.getTime() - now.getTime()) / 1000))
    };
  }

  private async insertUser(email: string, role: Role, now: Date): Promise<User> {
    const doc: UserDoc = {
      _id: randomUUID(),
      email,
      role,
      status: 'active',
      createdAt: now,
      lastLoginAt: null
    };
    await this.users.insertOne(doc);
    return toUser(doc);
  }

  private async hasActiveAdmin(): Promise<boolean> {
    return (await this.users.countDocuments({ status: 'active', role: 'admin' }, { limit: 1 })) > 0;
  }

  private async replayOf(input: NewInvite, now: Date): Promise<CreateInviteResult | null> {
    const replay = await this.invites.findOne({ mutationId: input.mutationId });
    if (replay === null) {
      return null;
    }
    return replay.email === input.email && replay.role === input.role
      ? { kind: 'replayed', invite: toInvite(replay, now) }
      : { kind: 'conflict' };
  }

  private async transition(
    id: string,
    now: Date,
    update: Record<string, unknown>
  ): Promise<InviteTransitionResult> {
    const invite = await this.invites.findOneAndUpdate(
      { _id: id, status: PENDING, expiresAt: { $gt: now } },
      update,
      { returnDocument: 'after' }
    );
    if (invite !== null) {
      return { kind: 'ok', invite: toInvite(invite, now) };
    }
    const exists = (await this.invites.countDocuments({ _id: id }, { limit: 1 })) > 0;
    return exists ? { kind: 'not_pending' } : { kind: 'not_found' };
  }
}
