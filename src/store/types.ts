import type { Role } from '../auth/principal.js';

/** Lifecycle of a member account. Removed users keep their record for the activity log. */
export type UserStatus = 'active' | 'removed';

/** Analytics member. */
export interface User {
  id: string;
  /** Normalized (trimmed, lowercase) email. */
  email: string;
  /**
   * Name of the person, as an operator recorded it in the member document; `null` when none was
   * recorded. The API never derives it from the email.
   */
  name: string | null;
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
  | 'member_removed'
  | 'network_hidden'
  | 'network_shown';

/** Activity log entry. Never carries codes or tokens. */
export interface ActivityEvent {
  id: string;
  at: Date;
  actorId: string | null;
  action: ActivityAction;
  /** Email the action applies to, or the network as `Label (chainId)`; `null` when none. */
  target: string | null;
  outcome: 'success' | 'failure';
}

/**
 * Position in the activity log: the last event of a page. The next page starts right after it in
 * the order of {@link Store.listActivity}.
 */
export interface ActivityCursor {
  at: Date;
  id: string;
}

/**
 * Lists of the Invites view: `pending` holds the invites that can still be resent, revoked or
 * accepted; `history` holds the accepted, revoked and expired ones.
 */
export type InviteView = 'pending' | 'history';

/**
 * Position in an invite list: the last invite of a page. The next page starts right after it in
 * the order of {@link Store.listInvites}.
 */
export interface InviteCursor {
  createdAt: Date;
  id: string;
}

/** Invites per view at one instant. */
export interface InviteCounts {
  pending: number;
  history: number;
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

/**
 * Analytics visibility of the networks: the chain ids an admin hid from the statistics. A chain id
 * absent from the list is visible. It never changes what the ingestion copies, and it is
 * independent from the B2C `enabled` flags.
 */
export interface NetworkVisibility {
  /** Hidden chain ids, sorted; they may include chain ids no longer in the catalog. */
  disabledChainIds: string[];
  /** Grows by one on every change; 0 while the policy was never changed. */
  revision: number;
  updatedAt: Date | null;
  /** User id of the admin behind the last change. */
  updatedBy: string | null;
}

/** Input of {@link Store.changeNetworkVisibility}. */
export interface NetworkVisibilityChange {
  chainId: string;
  analyticsEnabled: boolean;
  /** Revision the admin saw; any other current revision is a conflict. */
  expectedRevision: number;
  /** Chain ids of the catalog, at least one of which must stay visible. */
  catalogChainIds: readonly string[];
  actorId: string;
}

/** Outcome of a visibility change; every kind carries the policy as it stands after the call. */
export type NetworkVisibilityResult =
  | { kind: 'ok'; visibility: NetworkVisibility; changed: boolean }
  | { kind: 'conflict'; visibility: NetworkVisibility }
  | { kind: 'last_enabled'; visibility: NetworkVisibility };

/** Member resolved at login, with the invite accepted on the way when there was one. */
export interface ActivatedMember {
  user: User;
  acceptedInvite: Invite | null;
}

/**
 * Persistence of users, sessions, challenges, invites, activity, rate limit counters and the
 * analytics visibility of the networks.
 *
 * Methods that check an invariant and write (invite creation, invite transitions, member role
 * changes and removal, challenge attempts and consumption, invite acceptance, network visibility
 * changes) are atomic: two concurrent calls never both pass the check. Read methods report invites past `expiresAt` as
 * `expired`. Every method takes the current instant explicitly so callers control the clock.
 */
export interface Store {
  /** Backend kind; the in-memory store is limited to tests and local runs without MongoDB. */
  readonly kind: 'memory' | 'mongo';

  /** Reports whether the backend answers; used by the readiness probe. */
  ping(): Promise<boolean>;
  /** Releases the connection. */
  close(): Promise<void>;

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
  /**
   * Invites of one view, newest first by `createdAt`, ties broken by the greater id first. The
   * order is stable, so pages read with `after` neither repeat nor skip invites that were stored
   * before the first page; an invite that moves between views (revoked, accepted or expired) is
   * listed in the view it has when its page is read.
   *
   * @param view - `pending` or `history`, decided at `now`.
   * @param limit - Maximum number of invites.
   * @param now - Instant that decides which invites are expired.
   * @param after - Last invite of the previous page; omitted for the first page.
   */
  listInvites(view: InviteView, limit: number, now: Date, after?: InviteCursor): Promise<Invite[]>;
  /** Number of invites of each view at `now`. */
  countInvites(now: Date): Promise<InviteCounts>;
  resendInvite(id: string, now: Date): Promise<InviteTransitionResult>;
  revokeInvite(id: string, now: Date): Promise<InviteTransitionResult>;

  appendActivity(event: Omit<ActivityEvent, 'id'>): Promise<ActivityEvent>;
  /**
   * Most recent events first, ties on `at` broken by the most recently stored first. The order is
   * stable, so pages read with `after` neither repeat nor skip events that were stored before the
   * first page.
   *
   * @param limit - Maximum number of events.
   * @param after - Last event of the previous page; omitted for the first page.
   */
  listActivity(limit: number, after?: ActivityCursor): Promise<ActivityEvent[]>;
  /**
   * Instant of the last event each user acted in, of any action and outcome.
   *
   * @returns Map from user id to that instant; users without events are absent.
   */
  lastActivityOf(userIds: readonly string[]): Promise<Map<string, Date>>;

  /** Fixed-window counter: counts one hit on `key` and reports whether it is within `limit`. */
  hit(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitResult>;

  /** Current visibility policy; revision 0 and nothing hidden before the first change. */
  networkVisibility(): Promise<NetworkVisibility>;
  /**
   * Shows or hides a network, as a compare-and-set on the revision: `conflict` when the current
   * revision is not `expectedRevision`, `last_enabled` when no chain id of `catalogChainIds` would
   * stay visible. Setting the state a network already has answers `ok` with `changed: false` and
   * keeps the revision.
   */
  changeNetworkVisibility(
    change: NetworkVisibilityChange,
    now: Date
  ): Promise<NetworkVisibilityResult>;
}
