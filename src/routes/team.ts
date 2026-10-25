import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Role, requireRoles } from '../auth/principal.js';
import { normalizeEmail } from '../config/env.js';
import { ApiError } from '../errors/api-error.js';
import type {
  ActivityCursor,
  ActivityEvent,
  Invite,
  InviteTransitionResult,
  MemberMutationResult,
  Store,
  User
} from '../store/types.js';
import {
  activityEventSchema,
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
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const membersResponse = object({ items: arrayOf(teamMemberSchema) });
const invitesResponse = object({ items: arrayOf(inviteSchema) });
const activityResponse = object({
  items: arrayOf(activityEventSchema),
  nextCursor: {
    type: ['string', 'null'],
    description: 'Cursor of the next page, for the `cursor` parameter; `null` on the last page.'
  }
});

/** Largest activity page; the default page is smaller. */
const ACTIVITY_MAX_LIMIT = 100;

const activityQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: ACTIVITY_MAX_LIMIT, default: 50 },
    cursor: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'Opaque `nextCursor` of the previous page; omitted for the first page.'
    }
  }
} as const;

/** Ids of activity events: ObjectId hex in MongoDB, UUID in the memory store. */
const EVENT_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Cursor of the page that follows `event`: its instant and id, base64url encoded. Clients treat it
 * as opaque and send it back unchanged.
 */
function encodeActivityCursor(event: ActivityEvent): string {
  return Buffer.from(`${event.at.toISOString()}|${event.id}`, 'utf8').toString('base64url');
}

/** Reads a cursor of {@link encodeActivityCursor}; 400 when it does not hold an instant and an id. */
function decodeActivityCursor(cursor: string): ActivityCursor {
  const [instant = '', id = '', ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const at = new Date(instant);
  if (
    rest.length > 0 ||
    !EVENT_ID.test(id) ||
    Number.isNaN(at.getTime()) ||
    at.toISOString() !== instant
  ) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid activity cursor');
  }
  return { at, id };
}

const createInviteBody = object({
  email: emailSchema,
  role: roleSchema,
  mutationId: { type: 'string', format: 'uuid' }
});

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
 * Invite delivery is simulated: no email is sent and created or resent invites carry status
 * `simulated`. An admin cannot change their own role or remove themselves (403
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

  app.get(
    '/invites',
    {
      schema: {
        operationId: 'listTeamInvites',
        summary: 'Invites, newest first',
        tags: ['team'],
        response: { 200: invitesResponse, ...errorResponsesFor([401, 403]) }
      }
    },
    async () => {
      const invites = await store.listInvites(clock());
      return { items: await Promise.all(invites.map((invite) => toInviteBody(store, invite))) };
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
        nextCursor: events.length > limit && last !== undefined ? encodeActivityCursor(last) : null
      };
    }
  );

  app.post<{ Body: { email: string; role: Role; mutationId: string } }>(
    '/invites',
    {
      schema: {
        operationId: 'createTeamInvite',
        summary: 'Invite an email with a role; delivery is simulated, idempotent by mutationId',
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
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS)
        },
        now
      );
      if (result.kind === 'conflict') {
        throw new ApiError(409, 'CONFLICT', 'Email is already a member or has a pending invite');
      }
      if (result.kind === 'created') {
        await store.appendActivity({
          at: now,
          actorId: createdBy,
          action: 'invite_created',
          target: email,
          outcome: 'success'
        });
      }
      reply.status(201);
      return toInviteBody(store, result.invite);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/invites/:id/resend',
    {
      schema: {
        operationId: 'resendTeamInvite',
        summary: 'Simulate a new delivery of a pending invite',
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
      return toInviteBody(store, invite);
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
