import type { Role } from '../auth/principal.js';
import type { DeliveryState, EmailFailure, EmailLocale } from '../email/types.js';

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
  /**
   * When an admin blocked the member; `null` while not blocked. A blocked member stays `active`, so
   * it keeps its email and nobody else can be invited with it, but it cannot request or verify a
   * login code and its sessions are rejected. Only an admin lifts it.
   */
  blockedAt: Date | null;
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

/**
 * Login challenge opened by `request-code`. It holds neither the code nor the email in clear: the
 * code is reduced to an HMAC verifier and the email to its pseudonymous key, by which the store
 * keeps one challenge per email.
 */
export interface Challenge {
  /** Public id the client sends back with the code. */
  id: string;
  /** Pseudonymous key of the normalized email (see `emailKey`). */
  emailKey: string;
  /** Member the code was issued for; `null` when the email only has a pending invite. */
  userId: string | null;
  /** `otp`: code sent by email; `access_code`: shared code of a demo account. */
  kind: 'otp' | 'access_code';
  /** HMAC verifier of the code (see `codeVerifier`); `null` for `access_code`. */
  codeDigest: string | null;
  /** Fingerprint of the key behind `codeDigest`; `null` for `access_code`. */
  keyVersion: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Set when the member is blocked or removed while the challenge is open. */
  revokedAt: Date | null;
  attempts: number;
  maxAttempts: number;
}

/**
 * Codes issued for one email since its last login, which set the wait before the next one. It is
 * keyed by the pseudonymous email key and forgotten at `forgetAt`.
 */
export interface LoginThrottle {
  issued: number;
  lastIssuedAt: Date;
  forgetAt: Date;
  /** Grows on every write; the compare-and-set of {@link Store.reserveLoginThrottle} reads it. */
  version: number;
}

/**
 * Invite status; `expired` is derived on read from `expiresAt`. A pending invite is stored as
 * `simulated` whatever its delivery: persisted invites and the unique pending index use that
 * value. The delivery itself is in {@link Invite.delivery}.
 */
export type InviteStatus = 'created' | 'simulated' | 'accepted' | 'revoked' | 'expired';

/** Delivery of the last send of an invite (creation or resend). */
export interface InviteDelivery {
  /**
   * `pending` from the store write until the send ends; then `simulated` when no email was sent,
   * `sent` when the provider accepted it and `failed` otherwise. An invite left `pending` lost its
   * send (the instance stopped); a resend sends it again.
   */
  state: DeliveryState | 'pending';
  /** Requests made to the provider for the last send. */
  attempts: number;
  /** End of the last send; `null` while none ended. */
  lastAttemptAt: Date | null;
  /** Id of the message at the provider; `null` unless `sent` or `simulated`. */
  messageId: string | null;
  failure: EmailFailure | null;
}

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
  /** Language of the invitation email; `en` for invites stored before it was recorded. */
  locale: EmailLocale;
  /**
   * Delivery of the last send. Invites stored before emails were sent read as `simulated`, with
   * `lastSentAt` as the end of the send.
   */
  delivery: InviteDelivery;
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
  | 'member_blocked'
  | 'member_unblocked'
  | 'login_lockout_cleared'
  | 'network_hidden'
  | 'network_shown'
  | 'token_hidden'
  | 'token_shown';

/**
 * Browser of the request behind an activity event, as the BFF forwards it. Personal data: it is
 * shown until `expiresAt` and then removed from the event, which stays in the log.
 */
export interface ActivityClient {
  /** Browser IP forwarded by the BFF; `null` when not forwarded. */
  ip: string | null;
  /** `User-Agent` of the browser; `null` when not sent. */
  userAgent: string | null;
  /** `Accept-Language` of the browser; `null` when not sent. */
  language: string | null;
  /** `Sec-CH-UA-Platform`; `null` when the browser does not send client hints. */
  platform: string | null;
  /** `Sec-CH-UA-Mobile`; `null` when the browser does not send client hints. */
  mobile: boolean | null;
  /** `Sec-CH-UA`, the brand list with major versions; `null` without client hints. */
  brands: string | null;
  expiresAt: Date;
}

/** Activity log entry. Never carries codes or tokens. */
export interface ActivityEvent {
  id: string;
  at: Date;
  actorId: string | null;
  action: ActivityAction;
  /**
   * Email the action applies to, the network as `Label (chainId)` or the token as
   * `SYMBOL on Label (tokenId)`; `null` when none.
   */
  target: string | null;
  outcome: 'success' | 'failure';
  /** Browser of the request; `null` when the event has none or its data expired. */
  client: ActivityClient | null;
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
  locale: EmailLocale;
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
  /**
   * Hidden token ids (`chainId:address`, see `tokenIdOf`), sorted; they may include tokens no
   * longer in the catalog. Independent of `disabledChainIds`: hiding a network writes nothing here,
   * so showing it again brings back the preferences of its tokens.
   */
  disabledTokenIds: string[];
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

/** Input of {@link Store.changeTokenVisibility}. */
export interface TokenVisibilityChange {
  tokenId: string;
  analyticsEnabled: boolean;
  /** Revision the admin saw; any other current revision is a conflict. */
  expectedRevision: number;
  actorId: string;
}

/** Outcome of a visibility change; every kind carries the policy as it stands after the call. */
export type NetworkVisibilityResult =
  | { kind: 'ok'; visibility: NetworkVisibility; changed: boolean }
  | { kind: 'conflict'; visibility: NetworkVisibility }
  | { kind: 'last_enabled'; visibility: NetworkVisibility };

/** Outcome of a token visibility change; tokens have no last-visible rule. */
export type TokenVisibilityResult = Exclude<NetworkVisibilityResult, { kind: 'last_enabled' }>;

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
 * changes, removal and blocking, challenge attempts and consumption, throttle reservations, invite
 * acceptance, network visibility changes) are atomic: two concurrent calls never both pass the
 * check. The last-admin rule counts active admins that are not blocked. Read methods report
 * invites past `expiresAt` as `expired`. Every method takes the current instant explicitly so
 * callers control the clock.
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
  /**
   * Blocks an active member and revokes all its sessions, or lifts the block; sessions revoked by
   * the block stay revoked. Blocking the last unblocked active admin is `last_admin`. Repeating the
   * current state answers `ok`.
   */
  setBlocked(userId: string, blocked: boolean, now: Date): Promise<MemberMutationResult>;

  createSession(session: Omit<Session, 'revokedAt'>): Promise<Session>;
  findSession(jti: string): Promise<Session | null>;
  revokeSession(jti: string, now: Date): Promise<void>;

  /** Stores the challenge as the only one of its email, replacing the previous one. */
  issueChallenge(challenge: Challenge): Promise<void>;
  /**
   * Counts one verification attempt. Returns the challenge when it is the current one of the email,
   * has the id, is neither consumed, revoked nor expired, and had fewer than its `maxAttempts`
   * attempts before this one; `null` otherwise.
   */
  recordChallengeAttempt(emailKey: string, id: string, now: Date): Promise<Challenge | null>;
  /** Marks the challenge consumed; `false` when it was consumed, replaced or revoked meanwhile. */
  consumeChallenge(emailKey: string, id: string, now: Date): Promise<boolean>;
  /** Revokes the open challenge of the email, if any. */
  revokeChallenge(emailKey: string, now: Date): Promise<void>;

  /** Throttle state of the key, even when past `forgetAt`; `null` when none is stored. */
  loginThrottle(key: string): Promise<LoginThrottle | null>;
  /** Throttle states of several keys; keys without one are absent. */
  loginThrottles(keys: readonly string[]): Promise<Map<string, LoginThrottle>>;
  /**
   * Writes the next throttle state if the stored one still has `expectedVersion` (`null`: none is
   * stored). Of two concurrent calls on the same version one wins.
   *
   * @returns The written state; `null` when another write came first.
   */
  reserveLoginThrottle(
    key: string,
    expectedVersion: number | null,
    next: Pick<LoginThrottle, 'issued' | 'lastIssuedAt' | 'forgetAt'>
  ): Promise<LoginThrottle | null>;
  /**
   * Puts back the state a reservation replaced, if nothing wrote after it: `previous` `null`
   * deletes the state.
   */
  restoreLoginThrottle(
    key: string,
    reserved: LoginThrottle,
    previous: LoginThrottle | null
  ): Promise<void>;
  /** Deletes the throttle state and the rate limit counters of the keys. */
  clearLoginLimits(keys: readonly string[]): Promise<void>;

  /**
   * Creates a `simulated` invite with `lastSentAt = now` and a `pending` delivery. A known `mutationId` replays its invite
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
  /** Counts a new send of a pending invite and resets its delivery to `pending`. */
  resendInvite(id: string, now: Date): Promise<InviteTransitionResult>;
  /**
   * Records how the last send of an invite ended, whatever the invite status is now.
   *
   * @returns The invite with the delivery; `null` when it does not exist.
   */
  recordInviteDelivery(id: string, delivery: InviteDelivery, now: Date): Promise<Invite | null>;
  /** Whether the email has an invite that is still pending at `now`. */
  hasPendingInvite(email: string, now: Date): Promise<boolean>;
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
   * Removes the browser data of the events whose data expired at `now`; the events stay.
   *
   * @param now - Current instant.
   * @returns How many events lost their browser data.
   */
  purgeActivityClients(now: Date): Promise<number>;
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
  /**
   * Shows or hides a token, as a compare-and-set on the same revision as the networks: `conflict`
   * when the current revision is not `expectedRevision`. Setting the state a token already has
   * answers `ok` with `changed: false` and keeps the revision.
   */
  changeTokenVisibility(change: TokenVisibilityChange, now: Date): Promise<TokenVisibilityResult>;
}
