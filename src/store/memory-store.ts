import { randomUUID } from 'node:crypto';
import type { Role } from '../auth/principal.js';
import {
  INITIAL_VISIBILITY,
  planTokenVisibilityChange,
  planVisibilityChange
} from './network-visibility.js';
import type {
  ActivatedMember,
  ActivityCursor,
  ActivityEvent,
  Challenge,
  CreateInviteResult,
  Invite,
  InviteCounts,
  InviteCursor,
  InviteDelivery,
  InviteTransitionResult,
  InviteView,
  LoginThrottle,
  MemberMutationResult,
  NetworkVisibility,
  NetworkVisibilityChange,
  NetworkVisibilityResult,
  NewInvite,
  RateLimitResult,
  Session,
  Store,
  TokenVisibilityChange,
  TokenVisibilityResult,
  User
} from './types.js';

/** Delivery of an invite whose send has not ended. */
const PENDING_DELIVERY: InviteDelivery = {
  state: 'pending',
  attempts: 0,
  lastAttemptAt: null,
  messageId: null,
  failure: null
};

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

/** Order of {@link Store.listInvites}: newest `createdAt` first, then the greater id first. */
function newestInviteFirst(a: Invite, b: Invite): number {
  const byInstant = b.createdAt.getTime() - a.createdAt.getTime();
  if (byInstant !== 0) {
    return byInstant;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

/** Whether `invite` comes after the cursor invite in the order of {@link newestInviteFirst}. */
function isAfterInvite(invite: Invite, after: InviteCursor): boolean {
  const instant = invite.createdAt.getTime();
  const cursor = after.createdAt.getTime();
  return instant < cursor || (instant === cursor && invite.id < after.id);
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
 * and not shared between instances: it fits tests and local runs without MongoDB only.
 */
export class MemoryStore implements Store {
  readonly kind: 'memory' = 'memory';
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  /** By email key: one challenge per email. */
  private readonly challenges = new Map<string, Challenge>();
  private readonly throttles = new Map<string, LoginThrottle>();
  private readonly invites = new Map<string, Invite>();
  private readonly activity: ActivityEvent[] = [];
  private readonly counters = new Map<string, Counter>();
  private visibility: NetworkVisibility = INITIAL_VISIBILITY;

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

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
    if (user === undefined || user.status !== 'active' || user.blockedAt !== null) {
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
    if (
      user.role === 'admin' &&
      role !== 'admin' &&
      user.blockedAt === null &&
      this.activeAdminCount() <= 1
    ) {
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
    if (user.role === 'admin' && user.blockedAt === null && this.activeAdminCount() <= 1) {
      return { kind: 'last_admin' };
    }
    user.status = 'removed';
    this.revokeSessionsOf(userId, now);
    return { kind: 'ok', user: { ...user } };
  }

  async setBlocked(userId: string, blocked: boolean, now: Date): Promise<MemberMutationResult> {
    const user = this.users.get(userId);
    if (user === undefined || user.status !== 'active') {
      return { kind: 'not_found' };
    }
    if (!blocked) {
      user.blockedAt = null;
      return { kind: 'ok', user: { ...user } };
    }
    if (user.blockedAt === null) {
      if (user.role === 'admin' && this.activeAdminCount() <= 1) {
        return { kind: 'last_admin' };
      }
      user.blockedAt = now;
    }
    this.revokeSessionsOf(userId, now);
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

  async issueChallenge(challenge: Challenge): Promise<void> {
    this.challenges.set(challenge.emailKey, { ...challenge });
  }

  async recordChallengeAttempt(emailKey: string, id: string, now: Date): Promise<Challenge | null> {
    const challenge = this.challenges.get(emailKey);
    if (
      challenge === undefined ||
      challenge.id !== id ||
      challenge.consumedAt !== null ||
      challenge.revokedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attempts >= challenge.maxAttempts
    ) {
      return null;
    }
    challenge.attempts += 1;
    return { ...challenge };
  }

  async consumeChallenge(emailKey: string, id: string, now: Date): Promise<boolean> {
    const challenge = this.challenges.get(emailKey);
    if (
      challenge === undefined ||
      challenge.id !== id ||
      challenge.consumedAt !== null ||
      challenge.revokedAt !== null
    ) {
      return false;
    }
    challenge.consumedAt = now;
    return true;
  }

  async revokeChallenge(emailKey: string, now: Date): Promise<void> {
    const challenge = this.challenges.get(emailKey);
    if (challenge !== undefined && challenge.consumedAt === null && challenge.revokedAt === null) {
      challenge.revokedAt = now;
    }
  }

  async loginThrottle(key: string): Promise<LoginThrottle | null> {
    const throttle = this.throttles.get(key);
    return throttle === undefined ? null : { ...throttle };
  }

  async loginThrottles(keys: readonly string[]): Promise<Map<string, LoginThrottle>> {
    const found = new Map<string, LoginThrottle>();
    for (const key of keys) {
      const throttle = this.throttles.get(key);
      if (throttle !== undefined) {
        found.set(key, { ...throttle });
      }
    }
    return found;
  }

  async reserveLoginThrottle(
    key: string,
    expectedVersion: number | null,
    next: Pick<LoginThrottle, 'issued' | 'lastIssuedAt' | 'forgetAt'>
  ): Promise<LoginThrottle | null> {
    const current = this.throttles.get(key);
    if ((current?.version ?? null) !== expectedVersion) {
      return null;
    }
    const written: LoginThrottle = { ...next, version: (current?.version ?? 0) + 1 };
    this.throttles.set(key, written);
    return { ...written };
  }

  async restoreLoginThrottle(
    key: string,
    reserved: LoginThrottle,
    previous: LoginThrottle | null
  ): Promise<void> {
    if (this.throttles.get(key)?.version !== reserved.version) {
      return;
    }
    if (previous === null) {
      this.throttles.delete(key);
      return;
    }
    this.throttles.set(key, { ...previous, version: reserved.version + 1 });
  }

  async clearLoginLimits(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.throttles.delete(key);
      this.counters.delete(key);
    }
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
      mutationId: input.mutationId,
      locale: input.locale,
      delivery: PENDING_DELIVERY
    };
    this.invites.set(invite.id, invite);
    return { kind: 'created', invite: { ...invite } };
  }

  async listInvites(
    view: InviteView,
    limit: number,
    now: Date,
    after?: InviteCursor
  ): Promise<Invite[]> {
    // Same order and tie-break as the MongoDB store, so both page alike.
    return [...this.invites.values()]
      .filter((invite) => isPending(invite, now) === (view === 'pending'))
      .filter((invite) => after === undefined || isAfterInvite(invite, after))
      .sort(newestInviteFirst)
      .slice(0, limit)
      .map((invite) => readInvite(invite, now));
  }

  async countInvites(now: Date): Promise<InviteCounts> {
    const pending = [...this.invites.values()].filter((invite) => isPending(invite, now)).length;
    return { pending, history: this.invites.size - pending };
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
    invite.delivery = PENDING_DELIVERY;
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

  async recordInviteDelivery(
    id: string,
    delivery: InviteDelivery,
    now: Date
  ): Promise<Invite | null> {
    const invite = this.invites.get(id);
    if (invite === undefined) {
      return null;
    }
    invite.delivery = { ...delivery };
    return readInvite(invite, now);
  }

  async hasPendingInvite(email: string, now: Date): Promise<boolean> {
    return this.pendingInviteByEmail(email, now) !== undefined;
  }

  async appendActivity(event: Omit<ActivityEvent, 'id'>): Promise<ActivityEvent> {
    const stored: ActivityEvent = { id: randomUUID(), ...event };
    this.activity.push(stored);
    return { ...stored };
  }

  async lastActivityOf(userIds: readonly string[]): Promise<Map<string, Date>> {
    const wanted = new Set(userIds);
    const last = new Map<string, Date>();
    for (const event of this.activity) {
      if (event.actorId === null || !wanted.has(event.actorId)) {
        continue;
      }
      const known = last.get(event.actorId);
      if (known === undefined || event.at.getTime() > known.getTime()) {
        last.set(event.actorId, event.at);
      }
    }
    return last;
  }

  async listActivity(limit: number, after?: ActivityCursor): Promise<ActivityEvent[]> {
    // Reversed first so the stable sort keeps the latest insertion first among equal instants.
    const ordered = [...this.activity].reverse().sort((a, b) => b.at.getTime() - a.at.getTime());
    let start = 0;
    if (after !== undefined) {
      // Events are never deleted, so the cursor event is found by id; an unknown id falls back to
      // the events strictly older than its instant.
      const index = ordered.findIndex((event) => event.id === after.id);
      start =
        index >= 0
          ? index + 1
          : ordered.findIndex((event) => event.at.getTime() < after.at.getTime());
      if (start < 0) {
        return [];
      }
    }
    return ordered.slice(start, start + limit).map((event) => ({ ...event }));
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

  async networkVisibility(): Promise<NetworkVisibility> {
    return this.visibilityCopy();
  }

  async changeNetworkVisibility(
    change: NetworkVisibilityChange,
    now: Date
  ): Promise<NetworkVisibilityResult> {
    const plan = planVisibilityChange(this.visibilityCopy(), change, now);
    if (plan.kind === 'done') {
      return plan.result;
    }
    this.visibility = plan.next;
    return { kind: 'ok', visibility: this.visibilityCopy(), changed: true };
  }

  async changeTokenVisibility(
    change: TokenVisibilityChange,
    now: Date
  ): Promise<TokenVisibilityResult> {
    const plan = planTokenVisibilityChange(this.visibilityCopy(), change, now);
    if (plan.kind === 'done') {
      return plan.result;
    }
    this.visibility = plan.next;
    return { kind: 'ok', visibility: this.visibilityCopy(), changed: true };
  }

  private visibilityCopy(): NetworkVisibility {
    return {
      ...this.visibility,
      disabledChainIds: [...this.visibility.disabledChainIds],
      disabledTokenIds: [...this.visibility.disabledTokenIds]
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

  /** Active admins that are not blocked. */
  private activeAdminCount(): number {
    let count = 0;
    for (const user of this.users.values()) {
      if (user.status === 'active' && user.role === 'admin' && user.blockedAt === null) {
        count += 1;
      }
    }
    return count;
  }

  private insertUser(email: string, role: Role, now: Date): User {
    const user: User = {
      id: randomUUID(),
      email,
      name: null,
      role,
      status: 'active',
      blockedAt: null,
      createdAt: now,
      lastLoginAt: null
    };
    this.users.set(user.id, user);
    return user;
  }

  private revokeSessionsOf(userId: string, now: Date): void {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = now;
      }
    }
  }
}
