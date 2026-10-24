import { randomUUID } from 'node:crypto';
import type { Role } from '../auth/principal.js';
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

/** Counters kept before expired windows are swept. */
const RATE_LIMIT_SWEEP_THRESHOLD = 10_000;

interface Counter {
  count: number;
  resetAt: number;
}

function isPending(invite: Invite, now: Date): boolean {
  return (
    (invite.status === 'created' || invite.status === 'simulated') &&
    invite.expiresAt.getTime() > now.getTime()
  );
}

function readInvite(invite: Invite, now: Date): Invite {
  const expired =
    (invite.status === 'created' || invite.status === 'simulated') &&
    invite.expiresAt.getTime() <= now.getTime();
  return { ...invite, status: expired ? 'expired' : invite.status };
}

/**
 * {@link Store} kept in process memory.
 *
 * Every method does its checks and writes synchronously before the returned promise settles, so
 * concurrent requests of one process cannot interleave inside a method. State is lost on restart
 * and not shared between instances: it fits local runs, tests and single-instance demos only.
 */
export class MemoryStore implements Store {
  readonly kind: 'memory' = 'memory';
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly invites = new Map<string, Invite>();
  private readonly activity: ActivityEvent[] = [];
  private readonly counters = new Map<string, Counter>();

  async ensureUser(email: string, role: Role, now: Date): Promise<User> {
    const existing = this.activeUserByEmail(email);
    if (existing !== undefined) {
      return { ...existing };
    }
    return { ...this.insertUser(email, role, now) };
  }

  async findUserById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user === undefined ? null : { ...user };
  }

  async findActiveUserByEmail(email: string): Promise<User | null> {
    const user = this.activeUserByEmail(email);
    return user === undefined ? null : { ...user };
  }

  async listActiveUsers(): Promise<User[]> {
    return [...this.users.values()]
      .filter((user) => user.status === 'active')
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((user) => ({ ...user }));
  }

  async activateMember(email: string, now: Date): Promise<ActivatedMember | null> {
    const existing = this.activeUserByEmail(email);
    if (existing !== undefined) {
      return { user: { ...existing }, acceptedInvite: null };
    }
    const invite = this.pendingInviteByEmail(email, now);
    if (invite === undefined) {
      return null;
    }
    const user = this.insertUser(email, invite.role, now);
    invite.status = 'accepted';
    return { user: { ...user }, acceptedInvite: { ...invite } };
  }

  async recordLogin(userId: string, now: Date): Promise<User | null> {
    const user = this.users.get(userId);
    if (user === undefined || user.status !== 'active') {
      return null;
    }
    user.lastLoginAt = now;
    return { ...user };
  }

  async changeRole(userId: string, role: Role): Promise<MemberMutationResult> {
    const user = this.users.get(userId);
    if (user === undefined || user.status !== 'active') {
      return { kind: 'not_found' };
    }
    if (user.role === 'admin' && role !== 'admin' && this.activeAdminCount() <= 1) {
      return { kind: 'last_admin' };
    }
    user.role = role;
    return { kind: 'ok', user: { ...user } };
  }

  async removeUser(userId: string, now: Date): Promise<MemberMutationResult> {
    const user = this.users.get(userId);
    if (user === undefined || user.status !== 'active') {
      return { kind: 'not_found' };
    }
    if (user.role === 'admin' && this.activeAdminCount() <= 1) {
      return { kind: 'last_admin' };
    }
    user.status = 'removed';
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = now;
      }
    }
    return { kind: 'ok', user: { ...user } };
  }

  async createSession(input: Omit<Session, 'revokedAt'>): Promise<Session> {
    const session: Session = { ...input, revokedAt: null };
    this.sessions.set(session.jti, session);
    return { ...session };
  }

  async findSession(jti: string): Promise<Session | null> {
    const session = this.sessions.get(jti);
    return session === undefined ? null : { ...session };
  }

  async revokeSession(jti: string, now: Date): Promise<void> {
    const session = this.sessions.get(jti);
    if (session !== undefined && session.revokedAt === null) {
      session.revokedAt = now;
    }
  }

  async createChallenge(email: string, now: Date, expiresAt: Date): Promise<Challenge> {
    const challenge: Challenge = {
      id: randomUUID(),
      email,
      createdAt: now,
      expiresAt,
      attempts: 0,
      consumedAt: null
    };
    this.challenges.set(challenge.id, challenge);
    return { ...challenge };
  }

  async recordChallengeAttempt(
    id: string,
    maxAttempts: number,
    now: Date
  ): Promise<Challenge | null> {
    const challenge = this.challenges.get(id);
    if (challenge === undefined || challenge.consumedAt !== null) {
      return null;
    }
    if (challenge.expiresAt.getTime() <= now.getTime() || challenge.attempts >= maxAttempts) {
      return null;
    }
    challenge.attempts += 1;
    return { ...challenge };
  }

  async consumeChallenge(id: string, now: Date): Promise<boolean> {
    const challenge = this.challenges.get(id);
    if (challenge === undefined || challenge.consumedAt !== null) {
      return false;
    }
    challenge.consumedAt = now;
    return true;
  }

  async createInvite(input: NewInvite, now: Date): Promise<CreateInviteResult> {
    const replay = [...this.invites.values()].find(
      (invite) => invite.mutationId === input.mutationId
    );
    if (replay !== undefined) {
      return replay.email === input.email && replay.role === input.role
        ? { kind: 'replayed', invite: readInvite(replay, now) }
        : { kind: 'conflict' };
    }
    if (
      this.activeUserByEmail(input.email) !== undefined ||
      this.pendingInviteByEmail(input.email, now) !== undefined
    ) {
      return { kind: 'conflict' };
    }
    const invite: Invite = {
      id: randomUUID(),
      email: input.email,
      role: input.role,
      status: 'simulated',
      createdAt: now,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      resendCount: 0,
      lastSentAt: now,
      mutationId: input.mutationId
    };
    this.invites.set(invite.id, invite);
    return { kind: 'created', invite: { ...invite } };
  }

  async listInvites(now: Date): Promise<Invite[]> {
    // Map iteration follows insertion order, which breaks ties between invites of one instant.
    return [...this.invites.values()]
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((invite) => readInvite(invite, now));
  }

  async resendInvite(id: string, now: Date): Promise<InviteTransitionResult> {
    const invite = this.invites.get(id);
    if (invite === undefined) {
      return { kind: 'not_found' };
    }
    if (!isPending(invite, now)) {
      return { kind: 'not_pending' };
    }
    invite.resendCount += 1;
    invite.lastSentAt = now;
    invite.status = 'simulated';
    return { kind: 'ok', invite: { ...invite } };
  }

  async revokeInvite(id: string, now: Date): Promise<InviteTransitionResult> {
    const invite = this.invites.get(id);
    if (invite === undefined) {
      return { kind: 'not_found' };
    }
    if (!isPending(invite, now)) {
      return { kind: 'not_pending' };
    }
    invite.status = 'revoked';
    return { kind: 'ok', invite: { ...invite } };
  }

  async appendActivity(event: Omit<ActivityEvent, 'id'>): Promise<ActivityEvent> {
    const stored: ActivityEvent = { id: randomUUID(), ...event };
    this.activity.push(stored);
    return { ...stored };
  }

  async listActivity(limit: number): Promise<ActivityEvent[]> {
    // Reversed first so the stable sort keeps the latest insertion first among equal instants.
    return [...this.activity]
      .reverse()
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitResult> {
    const instant = now.getTime();
    if (this.counters.size >= RATE_LIMIT_SWEEP_THRESHOLD) {
      for (const [counterKey, counter] of this.counters) {
        if (counter.resetAt <= instant) {
          this.counters.delete(counterKey);
        }
      }
    }
    let counter = this.counters.get(key);
    if (counter === undefined || counter.resetAt <= instant) {
      counter = { count: 0, resetAt: instant + windowMs };
      this.counters.set(key, counter);
    }
    counter.count += 1;
    if (counter.count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - instant) / 1000))
    };
  }

  private activeUserByEmail(email: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.status === 'active' && user.email === email) {
        return user;
      }
    }
    return undefined;
  }

  private pendingInviteByEmail(email: string, now: Date): Invite | undefined {
    for (const invite of this.invites.values()) {
      if (invite.email === email && isPending(invite, now)) {
        return invite;
      }
    }
    return undefined;
  }

  private activeAdminCount(): number {
    let count = 0;
    for (const user of this.users.values()) {
      if (user.status === 'active' && user.role === 'admin') {
        count += 1;
      }
    }
    return count;
  }

  private insertUser(email: string, role: Role, now: Date): User {
    const user: User = {
      id: randomUUID(),
      email,
      role,
      status: 'active',
      createdAt: now,
      lastLoginAt: null
    };
    this.users.set(user.id, user);
    return user;
  }
}
