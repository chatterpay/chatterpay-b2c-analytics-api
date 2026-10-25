import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRoles } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { listNetworks, NETWORK_ID_PATTERN, type NetworkDefinition } from '../metrics/catalog.js';
import type { NetworkVisibility, NetworkVisibilityResult, Store } from '../store/types.js';
import { readVisibility } from './network-scope.js';
import { arrayOf, errorResponsesFor, object } from './schemas.js';

/** Options of the admin routes. */
export interface AdminRoutesOptions {
  store: Store;
  clock: () => Date;
}

/** Network of the admin list: its catalog fields and its analytics visibility. */
export interface AdminNetworkBody {
  id: string;
  chainId: string;
  label: string;
  family: NetworkDefinition['family'];
  analyticsEnabled: boolean;
  b2cEnabled: boolean | null;
  sourcePresent: boolean;
}

/** Body of the admin networks endpoints. */
export interface AdminNetworksBody {
  revision: number;
  updatedAt: string | null;
  networks: AdminNetworkBody[];
}

const CHAIN_ID_PATTERN = '^[0-9]{1,30}$';

const adminNetworksResponse = object({
  revision: {
    type: 'integer',
    minimum: 0,
    description: 'Revision of the visibility policy; send it back as expectedRevision.'
  },
  updatedAt: { type: ['string', 'null'], format: 'date-time' },
  networks: arrayOf(
    object({
      id: { type: 'string', pattern: NETWORK_ID_PATTERN, maxLength: 64 },
      chainId: { type: 'string', pattern: CHAIN_ID_PATTERN },
      label: { type: 'string' },
      family: { type: 'string', enum: ['evm', 'cardano'] },
      analyticsEnabled: {
        type: 'boolean',
        description: 'Whether the statistics of the analytics include the network.'
      },
      b2cEnabled: {
        type: ['boolean', 'null'],
        description:
          'enabled of the B2C document: whether B2C accepts new operations on the network. Informative only; null when the document has no such field or B2C no longer lists the network.'
      },
      sourcePresent: {
        type: 'boolean',
        description:
          'false for a network the B2C database no longer lists, kept by the analytics for its history.'
      }
    })
  )
});

const chainParams = object({ chainId: { type: 'string', pattern: CHAIN_ID_PATTERN } });

const changeBody = object({
  analyticsEnabled: { type: 'boolean' },
  expectedRevision: { type: 'integer', minimum: 0 }
});

function actorId(request: FastifyRequest): string {
  if (request.principal === null) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return request.principal.userId;
}

function bodyOf(
  catalog: readonly NetworkDefinition[],
  policy: NetworkVisibility
): AdminNetworksBody {
  const hidden = new Set(policy.disabledChainIds);
  return {
    revision: policy.revision,
    updatedAt: policy.updatedAt?.toISOString() ?? null,
    networks: catalog.map((network) => ({
      id: network.id,
      chainId: network.chainId,
      label: network.label,
      family: network.family,
      analyticsEnabled: !hidden.has(network.chainId),
      b2cEnabled: network.b2cEnabled,
      sourcePresent: network.sourcePresent
    }))
  };
}

/**
 * Registers the administration endpoints under the plugin prefix. Admin only.
 *
 * `GET /networks` lists every network of the catalog, hidden ones included, with its analytics
 * visibility. `PATCH /networks/:chainId` shows or hides one network in the statistics with a
 * compare-and-set on the policy revision: a stale revision answers 409 `CONFIG_CONFLICT`, and
 * hiding the last visible network answers 409 `LAST_ENABLED_NETWORK`. The policy lives in the
 * analytics database only; it never writes the B2C database and never changes what the ingestion
 * copies. Every change, refused ones included, goes to the activity log.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Store and clock.
 */
export async function adminRoutes(
  app: FastifyInstance,
  options: AdminRoutesOptions
): Promise<void> {
  const { store, clock } = options;

  app.addHook('onRequest', requireRoles(['admin']));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });

  app.get(
    '/networks',
    {
      schema: {
        operationId: 'listAdminNetworks',
        summary: 'Every network of the catalog with its analytics visibility',
        tags: ['admin'],
        response: { 200: adminNetworksResponse, ...errorResponsesFor([401, 403, 503]) }
      }
    },
    async (request) => bodyOf(listNetworks(), await readVisibility(store, request))
  );

  app.patch<{
    Params: { chainId: string };
    Body: { analyticsEnabled: boolean; expectedRevision: number };
  }>(
    '/networks/:chainId',
    {
      schema: {
        operationId: 'changeAdminNetworkVisibility',
        summary: 'Show or hide a network in the statistics; keeps at least one network visible',
        tags: ['admin'],
        params: chainParams,
        body: changeBody,
        response: {
          200: adminNetworksResponse,
          ...errorResponsesFor([400, 401, 403, 404, 409, 503])
        }
      }
    },
    async (request) => {
      const now = clock();
      const actor = actorId(request);
      const catalog = listNetworks();
      const network = catalog.find((item) => item.chainId === request.params.chainId);
      if (network === undefined) {
        throw new ApiError(404, 'NOT_FOUND', 'Network not found');
      }
      const { analyticsEnabled, expectedRevision } = request.body;
      let result: NetworkVisibilityResult;
      try {
        result = await store.changeNetworkVisibility(
          {
            chainId: network.chainId,
            analyticsEnabled,
            expectedRevision,
            catalogChainIds: catalog.map((item) => item.chainId),
            actorId: actor
          },
          now
        );
      } catch (error) {
        request.log.warn({ err: error }, 'network visibility change failed');
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Network settings are unavailable');
      }
      if (result.kind !== 'ok' || result.changed) {
        await store.appendActivity({
          at: now,
          actorId: actor,
          action: analyticsEnabled ? 'network_shown' : 'network_hidden',
          target: `${network.label} (${network.chainId})`,
          outcome: result.kind === 'ok' ? 'success' : 'failure'
        });
      }
      if (result.kind === 'conflict') {
        throw new ApiError(
          409,
          'CONFIG_CONFLICT',
          'The network settings changed; reload them and try again'
        );
      }
      if (result.kind === 'last_enabled') {
        throw new ApiError(409, 'LAST_ENABLED_NETWORK', 'At least one network must stay visible');
      }
      return bodyOf(catalog, result.visibility);
    }
  );
}
