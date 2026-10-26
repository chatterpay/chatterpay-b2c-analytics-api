import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRoles } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { listNetworks, NETWORK_ID_PATTERN, type NetworkDefinition } from '../metrics/catalog.js';
import { hiddenAssets, listTokens, TOKEN_ID_PATTERN } from '../metrics/tokens.js';
import type {
  NetworkVisibility,
  NetworkVisibilityResult,
  Store,
  TokenVisibilityResult
} from '../store/types.js';
import { readVisibility } from './network-scope.js';
import { arrayOf, errorResponsesFor, object } from './schemas.js';

/** Options of the admin routes. */
export interface AdminRoutesOptions {
  store: Store;
  clock: () => Date;
}

/** Token of a network of the admin list, with its own preference and its effective state. */
export interface AdminTokenBody {
  id: string;
  symbol: string;
  address: string;
  native: boolean;
  stable: boolean;
  b2cEnabled: boolean | null;
  sourcePresent: boolean;
  analyticsEnabled: boolean;
  effectiveEnabled: boolean;
}

/** Network of the admin list: its catalog fields, its analytics visibility and its tokens. */
export interface AdminNetworkBody {
  id: string;
  chainId: string;
  label: string;
  family: NetworkDefinition['family'];
  analyticsEnabled: boolean;
  b2cEnabled: boolean | null;
  sourcePresent: boolean;
  tokens: AdminTokenBody[];
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
      },
      tokens: arrayOf(
        object({
          id: {
            type: 'string',
            pattern: TOKEN_ID_PATTERN,
            description:
              'chainId:address in lower case, chainId:native for the native coin, chainId:symbol:SYMBOL without an address.'
          },
          symbol: { type: 'string' },
          address: { type: 'string', description: 'Public contract address; empty without one.' },
          native: { type: 'boolean' },
          stable: { type: 'boolean' },
          b2cEnabled: {
            type: ['boolean', 'null'],
            description:
              'enabled of the B2C token document. Informative only; null when the document has no such field.'
          },
          sourcePresent: {
            type: 'boolean',
            description:
              'false for a token the B2C database no longer lists, kept for its history and its preference.'
          },
          analyticsEnabled: {
            type: 'boolean',
            description: 'Preference of the token itself; hiding its network does not change it.'
          },
          effectiveEnabled: {
            type: 'boolean',
            description:
              'Whether the statistics include the token: false when it or its network is hidden. A hidden token stays included while another token of the network with the same symbol is shown, because their operations are recorded by symbol.'
          }
        })
      )
    })
  )
});

const chainParams = object({ chainId: { type: 'string', pattern: CHAIN_ID_PATTERN } });
const tokenParams = object({
  tokenId: { type: 'string', pattern: TOKEN_ID_PATTERN, maxLength: 160 }
});

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
  const disabledTokens = new Set(policy.disabledTokenIds);
  const excluded = hiddenAssets(policy.disabledTokenIds, catalog);
  return {
    revision: policy.revision,
    updatedAt: policy.updatedAt?.toISOString() ?? null,
    networks: catalog.map((network) => {
      const visible = !hidden.has(network.chainId);
      return {
        id: network.id,
        chainId: network.chainId,
        label: network.label,
        family: network.family,
        analyticsEnabled: visible,
        b2cEnabled: network.b2cEnabled,
        sourcePresent: network.sourcePresent,
        tokens: listTokens([network]).map((token) => ({
          id: token.id,
          symbol: token.symbol,
          address: token.address,
          native: token.native,
          stable: token.stable,
          b2cEnabled: token.b2cEnabled,
          sourcePresent: token.sourcePresent,
          analyticsEnabled: !disabledTokens.has(token.id),
          effectiveEnabled:
            visible && !(excluded.get(network.id)?.has(token.symbol.toUpperCase()) ?? false)
        }))
      };
    })
  };
}

/**
 * Registers the administration endpoints under the plugin prefix. Admin only.
 *
 * `GET /networks` lists every network of the catalog, hidden ones included, with its analytics
 * visibility. `PATCH /networks/:chainId` shows or hides one network in the statistics with a
 * compare-and-set on the policy revision: a stale revision answers 409 `CONFIG_CONFLICT`, and
 * hiding the last visible network answers 409 `LAST_ENABLED_NETWORK`. `PATCH /tokens/:tokenId`
 * shows or hides one token of the catalog with a compare-and-set on the same revision; a token of a
 * hidden network keeps its own preference, which applies again when the network is shown. The
 * policy lives in the analytics database only; it never writes the B2C database and never changes
 * what the ingestion copies or the balances it reads. Every change, refused ones included, goes to
 * the activity log.
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

  app.patch<{
    Params: { tokenId: string };
    Body: { analyticsEnabled: boolean; expectedRevision: number };
  }>(
    '/tokens/:tokenId',
    {
      schema: {
        operationId: 'changeAdminTokenVisibility',
        summary: 'Show or hide a token in the statistics; its network keeps its own visibility',
        tags: ['admin'],
        params: tokenParams,
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
      const token = listTokens(catalog).find((item) => item.id === request.params.tokenId);
      if (token === undefined) {
        throw new ApiError(404, 'NOT_FOUND', 'Token not found');
      }
      const network = catalog.find((item) => item.id === token.network);
      const { analyticsEnabled, expectedRevision } = request.body;
      let result: TokenVisibilityResult;
      try {
        result = await store.changeTokenVisibility(
          { tokenId: token.id, analyticsEnabled, expectedRevision, actorId: actor },
          now
        );
      } catch (error) {
        request.log.warn({ err: error }, 'token visibility change failed');
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Network settings are unavailable');
      }
      if (result.kind !== 'ok' || result.changed) {
        await store.appendActivity({
          at: now,
          actorId: actor,
          action: analyticsEnabled ? 'token_shown' : 'token_hidden',
          target: `${token.symbol} on ${network?.label ?? token.network} (${token.id})`,
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
      return bodyOf(catalog, result.visibility);
    }
  );
}
