import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Role, requireRoles } from '../auth/principal.js';
import { normalizeEmail } from '../config/env.js';
import type { EmailService } from '../email/service.js';
import type { EmailLocale } from '../email/types.js';
import { ApiError } from '../errors/api-error.js';
import type {
  ActivityCursor,
  Invite,
  InviteCursor,
  InviteDelivery,
  InviteTransitionResult,
  InviteView,
  MemberMutationResult,
  Store,
  User
} from '../store/types.js';
import {
  activityEventSchema,
  emailLocaleSchema,
  emailSchema,
  idParamsSchema,
  inviteSchema,
  memberSchema,
  roleSchema,
  teamMemberSchema,
  toActivityEventBody,
  toInviteBody,
  toMemberBody,
  toTeamMemberBody
} from './representations.js';
import { arrayOf, errorResponsesFor, object } from './schemas.js';

/** Options of the team routes. */
export interface TeamRoutesOptions {
  store: Store;
  clock: () => Date;
  email: EmailService;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const membersResponse = object({ items: arrayOf(teamMemberSchema) });
const nextCursorSchema = {
  type: ['string', 'null'],
  description: 'Cursor of the next page, for the `cursor` parameter; `null` on the last page.'
};
const invitesResponse = object({
  items: arrayOf(inviteSchema),
  nextCursor: nextCursorSchema,
  counts: {
    ...object({
      pending: { type: 'integer', minimum: 0 },
      history: { type: 'integer', minimum: 0 }
    }),
    description: 'Invites of each view at the time of the request, whatever page was asked.'
  }
});
const activityResponse = object({
  items: arrayOf(activityEventSchema),
  nextCursor: nextCursorSchema
});

/** Largest activity or invite page; the default page is smaller. */
const PAGE_MAX_LIMIT = 100;

const cursorParameter = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9_-]+$',
  description: 'Opaque `nextCursor` of the previous page; omitted for the first page.'
} as const;

const activityQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX_LIMIT, default: 50 },
    cursor: cursorParameter
  }
} as const;

const invitesQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    view: {
      type: 'string',
      enum: ['pending', 'history'],
      default: 'pending',
      description:
        '`pending`: invites that can still be resent, revoked or accepted. `history`: accepted, revoked and expired invites.'
    },
    limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX_LIMIT, default: 25 },
    cursor: {
      ...cursorParameter,
      description:
        'Opaque `nextCursor` of the previous page of the same view; omitted for the first page.'
    }
  }
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Ids of activity events: ObjectId hex in MongoDB, UUID in the memory store. */
const EVENT_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Cursor of the page that follows an item: its instant and id, base64url encoded. Clients treat it
 * as opaque and send it back unchanged.
 */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * Reads a cursor of {@link encodeCursor}; 400 naming `list` when it does not hold an instant and an
 * id of the expected shape.
 */
function decodeCursor(cursor: string, idPattern: RegExp, list: string): { at: Date; id: string } {
  const [instant = '', id = '', ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const at = new Date(instant);
  if (
    rest.length > 0 ||
    !idPattern.test(id) ||
    Number.isNaN(at.getTime()) ||
    at.toISOString() !== instant
  ) {
    throw new ApiError(400, 'BAD_REQUEST', `Invalid ${list} cursor`);
  }
  return { at, id };
}

function decodeActivityCursor(cursor: string): ActivityCursor {
  return decodeCursor(cursor, EVENT_ID, 'activity');
}

/** Invite ids are UUIDs in both stores. */
function decodeInviteCursor(cursor: string): InviteCursor {
  const { at, id } = decodeCursor(cursor, UUID, 'invite');
  return { createdAt: at, id };
}

const createInviteRequired = {
  email: emailSchema,
  role: roleSchema,
  mutationId: { type: 'string', format: 'uuid' }
};
const createInviteBody = {
  ...object(createInviteRequired),
  properties: { ...createInviteRequired, locale: emailLocaleSchema }
};

const changeRoleBody = object({ role: roleSchema });

function actorId(request: FastifyRequest): string {
  if (request.principal === null) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return request.principal.userId;
}

function inviteOrThrow(result: InviteTransitionResult): Invite {
  if (result.kind === 'not_found') {
    throw new ApiError(404, 'NOT_FOUND', 'Invite not found');
  }
  if (result.kind === 'not_pending') {
    throw new ApiError(409, 'CONFLICT', 'Invite is not pending');
  }
  return result.invite;
}

/**
 * Emails the invite and records how the send ended. A failed send keeps the invite pending, so
 * the admin can resend it.
 *
 * @param request - Request, for the log.
 * @param options - Store, clock and email service.
 * @param invite - Invite after its creation or resend was stored.
 * @returns The invite with its delivery.
 */
async function sendInvite(
  request: FastifyRequest,
  { store, clock, email }: TeamRoutesOptions,
  invite: Invite
): Promise<Invite> {
  const outcome = await email.sendInvite(invite);
  const now = clock();
  const delivery: InviteDelivery = {
    state: outcome.state,
    attempts: outcome.attempts,
    lastAttemptAt: now,
    messageId: outcome.messageId,
    failure: outcome.failure
  };
  if (outcome.state === 'failed') {
    request.log.warn(
      { inviteId: invite.id, failure: outcome.failure, attempts: outcome.attempts },
      'invite email not delivered'
    );
  }
  return (await store.recordInviteDelivery(invite.id, delivery, now)) ?? { ...invite, delivery };
}

function memberOrThrow(result: MemberMutationResult): User {
  if (result.kind === 'not_found') {
    throw new ApiError(404, 'NOT_FOUND', 'Member not found');
  }
  if (result.kind === 'last_admin') {
    throw new ApiError(409, 'CONFLICT', 'At least one active admin is required');
  }
  return result.user;
}

/**
 * Registers the team management endpoints under the plugin prefix. Admin only.
 *
 * Creating or resending an invite emails it through the email service and records the outcome in
 * `delivery`: `simulated` while `EMAIL_PROVIDER` is `simulated`, which sends nothing. A failed
 * send still answers with the stored invite, which stays pending. Pending invites carry status
 * `simulated` whatever their delivery. Accepting an invite happens at login, once the invited
 * email verifies its code. An admin cannot change their own role or remove themselves (403
 * `CANNOT_CHANGE_OWN_ROLE`, `CANNOT_REMOVE_SELF`), whatever role the request asks for. Since the
 * caller stays an admin, the store's last-admin check (409) only answers when two admins demote or
 * remove each other at the same time.
 * Every response carries `Cache-Control: private, no-store`.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Store and clock.
 */
export async function teamRoutes(app: FastifyInstance, options: TeamRoutesOptions): Promise<void> {
  const { store, clock } = options;

  app.addHook('onRequest', requireRoles(['admin']));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });

  app.get(
    '/members',
    {
      schema: {
        operationId: 'listTeamMembers',
        summary: 'Active members sorted by email',
        tags: ['team'],
        response: { 200: membersResponse, ...errorResponsesFor([401, 403]) }
      }
    },
    async () => {
      const users = await store.listActiveUsers();
      const last = await store.lastActivityOf(users.map((user) => user.id));
      return { items: users.map((user) => toTeamMemberBody(user, last.get(user.id) ?? null)) };
    }
  );

  app.get<{ Querystring: { view: InviteView; limit: number; cursor?: string } }>(
    '/invites',
    {
      schema: {
        operationId: 'listTeamInvites',
        summary:
          'Invites of one view, newest first, one page per cursor, with the count of each view',
        tags: ['team'],
        querystring: invitesQuery,
        response: { 200: invitesResponse, ...errorResponsesFor([400, 401, 403]) }
      }
    },
    async (request) => {
      const { view, limit, cursor } = request.query;
      const after = cursor === undefined ? undefined : decodeInviteCursor(cursor);
      const now = clock();
      // One invite past the page tells whether another page exists without counting the rest.
      const [invites, counts] = await Promise.all([
        store.listInvites(view, limit + 1, now, after),
        store.countInvites(now)
      ]);
      const page = invites.slice(0, limit);
      const last = page.at(-1);
      return {
        items: await Promise.all(page.map((invite) => toInviteBody(store, invite))),
        nextCursor:
          invites.length > limit && last !== undefined
            ? encodeCursor(last.createdAt, last.id)
            : null,
        counts
      };
    }
  );

  app.get<{ Querystring: { limit: number; cursor?: string } }>(
    '/activity',
    {
      schema: {
        operationId: 'listTeamActivity',
        summary: 'Login and team management events, newest first, one page per cursor',
        tags: ['team'],
        querystring: activityQuery,
        response: { 200: activityResponse, ...errorResponsesFor([400, 401, 403]) }
      }
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const after = cursor === undefined ? undefined : decodeActivityCursor(cursor);
      // One event past the page tells whether another page exists without a count query.
      const events = await store.listActivity(limit + 1, after);
      const page = events.slice(0, limit);
      const last = page.at(-1);
      return {
        items: await Promise.all(page.map((event) => toActivityEventBody(store, event))),
        nextCursor:
          events.length > limit && last !== undefined ? encodeCursor(last.at, last.id) : null
      };
    }
  );

  app.post<{ Body: { email: string; role: Role; mutationId: string; locale?: EmailLocale } }>(
    '/invites',
    {
      schema: {
        operationId: 'createTeamInvite',
        summary: 'Invite an email with a role and email the invitation, idempotent by mutationId',
        tags: ['team'],
        body: createInviteBody,
        response: { 201: inviteSchema, ...errorResponsesFor([400, 401, 403, 409]) }
      }
    },
    async (request, reply) => {
      const now = clock();
      const createdBy = actorId(request);
      const email = normalizeEmail(request.body.email);
      const result = await store.createInvite(
        {
          email,
          role: request.body.role,
          createdBy,
          mutationId: request.body.mutationId,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          locale: request.body.locale ?? 'en'
        },
        now
      );
      if (result.kind === 'conflict') {
        throw new ApiError(409, 'CONFLICT', 'Email is already a member or has a pending invite');
      }
      // A replay answers the stored invite without a second email.
      let invite = result.invite;
      if (result.kind === 'created') {
        await store.appendActivity({
          at: now,
          actorId: createdBy,
          action: 'invite_created',
          target: email,
          outcome: 'success'
        });
        invite = await sendInvite(request, options, invite);
      }
      reply.status(201);
      return toInviteBody(store, invite);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/invites/:id/resend',
    {
      schema: {
        operationId: 'resendTeamInvite',
        summary: 'Email a pending invite again',
        tags: ['team'],
        params: idParamsSchema,
        response: { 200: inviteSchema, ...errorResponsesFor([400, 401, 403, 404, 409]) }
      }
    },
    async (request) => {
      const now = clock();
      const invite = inviteOrThrow(await store.resendInvite(request.params.id, now));
      await store.appendActivity({
        at: now,
        actorId: actorId(request),
        action: 'invite_resent',
        target: invite.email,
        outcome: 'success'
      });
      return toInviteBody(store, await sendInvite(request, options, invite));
    }
  );

  app.post<{ Params: { id: string } }>(
    '/invites/:id/revoke',
    {
      schema: {
        operationId: 'revokeTeamInvite',
        summary: 'Revoke a pending invite',
        tags: ['team'],
        params: idParamsSchema,
        response: { 200: inviteSchema, ...errorResponsesFor([400, 401, 403, 404, 409]) }
      }
    },
    async (request) => {
      const now = clock();
      const invite = inviteOrThrow(await store.revokeInvite(request.params.id, now));
      await store.appendActivity({
        at: now,
        actorId: actorId(request),
        action: 'invite_revoked',
        target: invite.email,
        outcome: 'success'
      });
      return toInviteBody(store, invite);
    }
  );

  app.patch<{ Params: { id: string }; Body: { role: Role } }>(
    '/members/:id',
    {
      schema: {
        operationId: 'changeTeamMemberRole',
        summary: 'Change the role of another active member; keeps at least one active admin',
        tags: ['team'],
        params: idParamsSchema,
        body: changeRoleBody,
        response: { 200: memberSchema, ...errorResponsesFor([400, 401, 403, 404, 409]) }
      }
    },
    async (request) => {
      const actor = actorId(request);
      if (request.params.id === actor) {
        throw new ApiError(403, 'CANNOT_CHANGE_OWN_ROLE', 'Members cannot change their own role');
      }
      const user = memberOrThrow(await store.changeRole(request.params.id, request.body.role));
      await store.appendActivity({
        at: clock(),
        actorId: actor,
        action: 'role_changed',
        target: user.email,
        outcome: 'success'
      });
      return toMemberBody(user);
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/members/:id',
    {
      schema: {
        operationId: 'removeTeamMember',
        summary:
          'Remove another active member and revoke its sessions; keeps at least one active admin',
        tags: ['team'],
        params: idParamsSchema,
        response: {
          204: { type: 'null', description: 'Member removed' },
          ...errorResponsesFor([400, 401, 403, 404, 409])
        }
      }
    },
    async (request, reply) => {
      const now = clock();
      const actor = actorId(request);
      if (request.params.id === actor) {
        throw new ApiError(403, 'CANNOT_REMOVE_SELF', 'Members cannot remove themselves');
      }
      const user = memberOrThrow(await store.removeUser(request.params.id, now));
      await store.appendActivity({
        at: now,
        actorId: actor,
        action: 'member_removed',
        target: user.email,
        outcome: 'success'
      });
      return reply.status(204).send();
    }
  );
}
