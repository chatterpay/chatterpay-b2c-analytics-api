import type { ActivityEvent, Invite, Store, User } from '../store/types.js';
import { object } from './schemas.js';

/** Member as exposed by the API. */
export interface MemberBody {
  id: string;
  email: string;
  /** Name recorded for the member; `null` when none was recorded. */
  name: string | null;
  role: User['role'];
  status: 'active';
  createdAt: string;
  lastLoginAt: string | null;
}

/** Member as listed by the team endpoint, with its last audited activity. */
export interface TeamMemberBody extends MemberBody {
  /** Last event of the activity log the member acted in, logins included; `null` when none. */
  lastActivityAt: string | null;
}

/** Invite as exposed by the API; `createdBy` is the email of the creator. */
export interface InviteBody {
  id: string;
  email: string;
  role: Invite['role'];
  status: Invite['status'];
  createdAt: string;
  expiresAt: string;
  resendCount: number;
  lastSentAt: string | null;
  createdBy: string;
}

/**
 * Activity event as exposed by the API; `actor` is an email, `target` an email, a network or a
 * token.
 */
export interface ActivityEventBody {
  id: string;
  at: string;
  actor: string | null;
  action: ActivityEvent['action'];
  target: string | null;
  outcome: ActivityEvent['outcome'];
}

const ROLE_ENUM = ['admin', 'viewer'];
const instant = { type: 'string', format: 'date-time' } as const;
const nullableInstant = { type: ['string', 'null'], format: 'date-time' } as const;

/** Schema of a request email. */
export const emailSchema: Record<string, unknown> = {
  type: 'string',
  format: 'email',
  maxLength: 254
};

/** Schema of a role. */
export const roleSchema: Record<string, unknown> = { type: 'string', enum: ROLE_ENUM };

/** Schema of a path parameter `id` holding a UUID. */
export const idParamsSchema: Record<string, unknown> = object({
  id: { type: 'string', format: 'uuid' }
});

const memberProperties = {
  id: { type: 'string' },
  email: { type: 'string' },
  name: {
    type: ['string', 'null'],
    description: 'Name recorded for the member by an operator; null when none. Never derived.'
  },
  role: roleSchema,
  status: { type: 'string', enum: ['active'] },
  createdAt: instant,
  lastLoginAt: nullableInstant
};

/** Response schema of a {@link MemberBody}. */
export const memberSchema: Record<string, unknown> = object(memberProperties);

/** Response schema of a {@link TeamMemberBody}. */
export const teamMemberSchema: Record<string, unknown> = object({
  ...memberProperties,
  lastActivityAt: {
    ...nullableInstant,
    description:
      'Last event of the activity log the member acted in, of any action; distinct from lastLoginAt.'
  }
});

/** Response schema of an {@link InviteBody}. */
export const inviteSchema: Record<string, unknown> = object({
  id: { type: 'string' },
  email: { type: 'string' },
  role: roleSchema,
  status: { type: 'string', enum: ['created', 'simulated', 'accepted', 'revoked', 'expired'] },
  createdAt: instant,
  expiresAt: instant,
  resendCount: { type: 'integer', minimum: 0 },
  lastSentAt: nullableInstant,
  createdBy: { type: 'string', description: 'Email of the admin that created the invite.' }
});

/** Response schema of an {@link ActivityEventBody}. */
export const activityEventSchema: Record<string, unknown> = object({
  id: { type: 'string' },
  at: instant,
  actor: { type: ['string', 'null'], description: 'Email of the member that acted.' },
  action: {
    type: 'string',
    enum: [
      'login',
      'login_failed',
      'logout',
      'invite_created',
      'invite_resent',
      'invite_revoked',
      'invite_accepted',
      'role_changed',
      'member_removed',
      'network_hidden',
      'network_shown',
      'token_hidden',
      'token_shown'
    ]
  },
  target: {
    type: ['string', 'null'],
    description:
      'Email the action applies to, the network as "Label (chainId)" or the token as "SYMBOL on Label (tokenId)".'
  },
  outcome: { type: 'string', enum: ['success', 'failure'] }
});

/**
 * Maps an active user to its API body.
 *
 * @param user - Active user.
 * @returns The member body.
 */
export function toMemberBody(user: User): MemberBody {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: 'active',
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString()
  };
}

/**
 * Maps an active user and its last activity to the team list body.
 *
 * @param user - Active user.
 * @param lastActivityAt - Last event the user acted in; `null` when none.
 * @returns The team member body.
 */
export function toTeamMemberBody(user: User, lastActivityAt: Date | null): TeamMemberBody {
  return {
    ...toMemberBody(user),
    lastActivityAt: lastActivityAt === null ? null : lastActivityAt.toISOString()
  };
}

async function emailOf(store: Store, userId: string | null): Promise<string | null> {
  if (userId === null) {
    return null;
  }
  return (await store.findUserById(userId))?.email ?? null;
}

/**
 * Maps an invite to its API body, resolving the creator email.
 *
 * @param store - Store to resolve the creator.
 * @param invite - Invite with its read status.
 * @returns The invite body.
 */
export async function toInviteBody(store: Store, invite: Invite): Promise<InviteBody> {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    resendCount: invite.resendCount,
    lastSentAt: invite.lastSentAt === null ? null : invite.lastSentAt.toISOString(),
    // Users are never deleted, so the creator always resolves.
    createdBy: (await emailOf(store, invite.createdBy)) ?? ''
  };
}

/**
 * Maps an activity event to its API body, resolving the actor email.
 *
 * @param store - Store to resolve the actor.
 * @param event - Stored event.
 * @returns The event body.
 */
export async function toActivityEventBody(
  store: Store,
  event: ActivityEvent
): Promise<ActivityEventBody> {
  return {
    id: event.id,
    at: event.at.toISOString(),
    actor: await emailOf(store, event.actorId),
    action: event.action,
    target: event.target,
    outcome: event.outcome
  };
}
