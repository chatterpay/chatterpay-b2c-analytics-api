import type { Role } from '../auth/principal.js';

/** Lifecycle of a member account. Removed users keep their record for the activity log. */
export type UserStatus = 'active' | 'removed';

/** Analytics member. */
export interface User {
  id: string;
  /** Normalized (trimmed, lowercase) email. */
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** Server-side record of an issued session JWT, keyed by its `jti`. */
export interface Session {
  jti: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Login challenge opened by `request-code`. It never stores the code. */
export interface Challenge {
  id: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
}

/** Invite status; `expired` is derived on read from `expiresAt`. */
export type InviteStatus = 'created' | 'simulated' | 'accepted' | 'revoked' | 'expired';

/** Invitation of an email to join with a role. */
export interface Invite {
  id: string;
  email: string;
  role: Role;
  status: InviteStatus;
  createdAt: Date;
  expiresAt: Date;
  /** Id of the admin that created the invite. */
  createdBy: string;
  resendCount: number;
  lastSentAt: Date | null;
  /** Client-generated id that makes invite creation idempotent. */
  mutationId: string;
}

/** Actions recorded in the activity log. */
export type ActivityAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'invite_created'
  | 'invite_resent'
  | 'invite_revoked'
  | 'invite_accepted'
  | 'role_changed'
  | 'member_removed';

/** Activity log entry. Never carries codes or tokens. */
export interface ActivityEvent {
  id: string;
  at: Date;
  actorId: string | null;
  action: ActivityAction;
  /** Email the action applies to, when any. */
  target: string | null;
  outcome: 'success' | 'failure';
}

/** Result of a rate limit counter hit. */
export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

/** Input of {@link Store.createInvite}. */
export interface NewInvite {
  email: string;
  role: Role;
  createdBy: string;
  mutationId: string;
  expiresAt: Date;
}

/** Outcome of an invite creation. */
export type CreateInviteResult =
  | { kind: 'created'; invite: Invite }
  | { kind: 'replayed'; invite: Invite }
  | { kind: 'conflict' };

/** Outcome of an invite transition. */
export type InviteTransitionResult =
  | { kind: 'ok'; invite: Invite }
  | { kind: 'not_found' }
  | { kind: 'not_pending' };

/** Outcome of a member mutation that must keep at least one active admin. */
export type MemberMutationResult =
  | { kind: 'ok'; user: User }
  | { kind: 'not_found' }
  | { kind: 'last_admin' };

/** Member resolved at login, with the invite accepted on the way when there was one. */
export interface ActivatedMember {
  user: User;
  acceptedInvite: Invite | null;
}

/**
 * Persistence of users, sessions, challenges, invites, activity and rate limit counters.
 *
 * Methods that check an invariant and write (invite creation, invite transitions, member role
 * changes and removal, challenge attempts and consumption, invite acceptance) are atomic: two
 * concurrent calls never both pass the check. Read methods report invites past `expiresAt` as
 * `expired`. Every method takes the current instant explicitly so callers control the clock.
 */
export interface Store {
  /** Backend kind; the in-memory store is limited to a single instance. */
  readonly kind: 'memory';

  /** Creates the active user unless one with that email exists; returns the active user. */
  ensureUser(email: string, role: User['role'], now: Date): Promise<User>;
  findUserById(id: string): Promise<User | null>;
  findActiveUserByEmail(email: string): Promise<User | null>;
  /** Active users sorted by email. */
  listActiveUsers(): Promise<User[]>;
  /**
   * Returns the active user of the email or, when there is none and a pending invite exists,
   * creates the user with the invite role and marks the invite accepted. `null` otherwise.
   */
  activateMember(email: string, now: Date): Promise<ActivatedMember | null>;
  recordLogin(userId: string, now: Date): Promise<User | null>;
  changeRole(userId: string, role: User['role']): Promise<MemberMutationResult>;
  /** Marks the user removed and revokes all its sessions. */
  removeUser(userId: string, now: Date): Promise<MemberMutationResult>;

  createSession(session: Omit<Session, 'revokedAt'>): Promise<Session>;
  findSession(jti: string): Promise<Session | null>;
  revokeSession(jti: string, now: Date): Promise<void>;

  createChallenge(email: string, now: Date, expiresAt: Date): Promise<Challenge>;
  /**
   * Counts one verification attempt. Returns the challenge when it exists, is neither consumed
   * nor expired and had fewer than `maxAttempts` attempts before this one; `null` otherwise.
   */
  recordChallengeAttempt(id: string, maxAttempts: number, now: Date): Promise<Challenge | null>;
  /** Marks the challenge consumed; `false` when it was already consumed or does not exist. */
  consumeChallenge(id: string, now: Date): Promise<boolean>;

  /**
   * Creates a `simulated` invite with `lastSentAt = now`. A known `mutationId` replays its invite
   * (conflict when the payload differs); an active member or a pending invite of the email is a
   * conflict.
   */
  createInvite(input: NewInvite, now: Date): Promise<CreateInviteResult>;
  /** Invites, newest first. */
  listInvites(now: Date): Promise<Invite[]>;
  resendInvite(id: string, now: Date): Promise<InviteTransitionResult>;
  revokeInvite(id: string, now: Date): Promise<InviteTransitionResult>;

  appendActivity(event: Omit<ActivityEvent, 'id'>): Promise<ActivityEvent>;
  /** Most recent events first. */
  listActivity(limit: number): Promise<ActivityEvent[]>;

  /** Fixed-window counter: counts one hit on `key` and reports whether it is within `limit`. */
  hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitResult>;
}
