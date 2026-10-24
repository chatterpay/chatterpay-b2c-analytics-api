import type { FastifyInstance } from 'fastify';
import { requireRoles } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import {
  isKnownNetwork,
  listNetworks,
  NETWORK_ID_PATTERN,
  type NetworkFilter
} from '../metrics/catalog.js';
import { buildOverview } from '../metrics/overview.js';
import { buildRevenue } from '../metrics/revenue.js';
import type { MetricsRange, UsersGranularity } from '../metrics/types.js';
import { buildUsers } from '../metrics/users.js';
import { arrayOf, errorResponses, object } from './schemas.js';

/** Options of the metrics routes. */
export interface MetricsRoutesOptions {
  /** Source of the current instant; injected by tests. */
  clock: () => Date;
}

const RANGE_ENUM = ['today', 'week', 'month', 'year', 'ytd', 'all'];
const GRANULARITY_ENUM = ['daily', 'monthly', 'yearly'];

const decimal = { type: 'string', pattern: '^-?\\d+\\.\\d+$' } as const;
const nullableDecimal = { type: ['string', 'null'], pattern: '^-?\\d+\\.\\d+$' } as const;
const instant = { type: 'string', format: 'date-time' } as const;
const network = { type: 'string', pattern: NETWORK_ID_PATTERN, maxLength: 64 } as const;
// `all` or a network id; whether the id is in the catalog is checked by the handlers.
const networkFilter = {
  type: 'string',
  pattern: `^all$|${NETWORK_ID_PATTERN}`,
  maxLength: 64
} as const;

const period = object({ start: instant, end: instant });
const countMetric = object({
  value: { type: 'integer', minimum: 0 },
  previous: { type: ['integer', 'null'], minimum: 0 },
  changeRatio: nullableDecimal
});
const moneyMetric = object({
  value: decimal,
  previous: nullableDecimal,
  changeRatio: nullableDecimal
});

function meta(extra: Record<string, unknown>): Record<string, unknown> {
  return object({
    datasetVersion: { type: 'string' },
    dataStatus: { type: 'string', enum: ['mock'] },
    generatedAt: instant,
    currency: { type: 'string', enum: ['USD'] },
    network: networkFilter,
    ...extra,
    period,
    previousPeriod: { anyOf: [period, { type: 'null' }] },
    bucket: { type: 'string', enum: ['hour', 'day', 'month', 'year'] }
  });
}

const rangeQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    network: { ...networkFilter, default: 'all' },
    range: { type: 'string', enum: RANGE_ENUM, default: 'month' }
  }
} as const;

const usersQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    network: { ...networkFilter, default: 'all' },
    granularity: { type: 'string', enum: GRANULARITY_ENUM, default: 'daily' }
  }
} as const;

const overviewResponse = object({
  meta: meta({ range: { type: 'string', enum: RANGE_ENUM } }),
  tiles: object({
    volumeUsd: moneyMetric,
    transactions: countMetric,
    feesUsd: moneyMetric,
    activeUsers: countMetric,
    newUsers: countMetric
  }),
  series: arrayOf(
    object({
      start: instant,
      end: instant,
      volumeUsd: decimal,
      transactions: { type: 'integer' },
      byNetwork: arrayOf(object({ network, volumeUsd: decimal, transactions: { type: 'integer' } }))
    })
  ),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      volumeUsd: decimal,
      transactions: { type: 'integer' },
      feesUsd: decimal,
      activeUsers: { type: 'integer' },
      newUsers: { type: 'integer' }
    })
  )
});

const usersResponse = object({
  meta: meta({ granularity: { type: 'string', enum: GRANULARITY_ENUM } }),
  tiles: object({
    dailyActiveUsers: countMetric,
    monthlyActiveUsers: countMetric,
    yearlyActiveUsers: countMetric,
    newUsers: countMetric,
    totalUsers: countMetric
  }),
  series: arrayOf(
    object({
      start: instant,
      end: instant,
      activeUsers: { type: 'integer' },
      newUsers: { type: 'integer' },
      byNetwork: arrayOf(
        object({ network, activeUsers: { type: 'integer' }, newUsers: { type: 'integer' } })
      )
    })
  ),
  retention: arrayOf(
    object({
      cohort: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
      size: { type: 'integer' },
      retained: arrayOf({ type: 'integer' })
    })
  ),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      activeUsers: { type: 'integer' },
      totalUsers: { type: 'integer' }
    })
  )
});

const networksResponse = object({
  networks: arrayOf(
    object({
      id: network,
      label: { type: 'string' },
      family: { type: 'string', enum: ['evm', 'cardano'] }
    })
  )
});

const revenueResponse = object({
  meta: meta({ range: { type: 'string', enum: RANGE_ENUM } }),
  tiles: object({
    feesUsd: moneyMetric,
    transferFeesUsd: moneyMetric,
    swapFeesUsd: moneyMetric,
    volumeUsd: moneyMetric
  }),
  series: arrayOf(
    object({
      start: instant,
      end: instant,
      feesUsd: decimal,
      transferFeesUsd: decimal,
      swapFeesUsd: decimal
    })
  ),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      feesUsd: decimal,
      transferFeesUsd: decimal,
      swapFeesUsd: decimal,
      volumeUsd: decimal
    })
  ),
  byAsset: arrayOf(
    object({ network, asset: { type: 'string' }, volumeUsd: decimal, feesUsd: decimal })
  )
});

/**
 * Registers the mock metrics endpoints under the plugin prefix.
 *
 * Every route requires an `admin` or `viewer` session, answers `Cache-Control: private, no-store`
 * and `X-Data-Status: mock`. Unknown query parameters, values outside the enums and networks
 * outside the catalog answer 400.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Clock used to anchor the dataset.
 */
export async function metricsRoutes(
  app: FastifyInstance,
  options: MetricsRoutesOptions
): Promise<void> {
  app.addHook('onRequest', requireRoles(['admin', 'viewer']));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    reply.header('x-data-status', 'mock');
  });
  app.addHook<{ Querystring: { network?: string } }>('preHandler', async (request) => {
    const requested = request.query.network;
    if (requested !== undefined && !isKnownNetwork(requested)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Unknown network');
    }
  });

  app.get(
    '/networks',
    {
      schema: {
        operationId: 'getMetricsNetworks',
        summary: 'Networks of the environment, from the ChatterPay B2C database',
        tags: ['metrics'],
        response: { 200: networksResponse, ...errorResponses }
      }
    },
    async () => ({ networks: listNetworks() })
  );

  app.get<{ Querystring: { network: NetworkFilter; range: MetricsRange } }>(
    '/overview',
    {
      schema: {
        operationId: 'getOverviewMetrics',
        summary: 'Overview dataset: volume, transactions, fees and users by network',
        tags: ['metrics'],
        querystring: rangeQuery,
        response: { 200: overviewResponse, ...errorResponses }
      }
    },
    async (request) => buildOverview(request.query.network, request.query.range, options.clock())
  );

  app.get<{ Querystring: { network: NetworkFilter; granularity: UsersGranularity } }>(
    '/users',
    {
      schema: {
        operationId: 'getUsersMetrics',
        summary: 'Users dataset: active users, new users, retention cohorts',
        tags: ['metrics'],
        querystring: usersQuery,
        response: { 200: usersResponse, ...errorResponses }
      }
    },
    async (request) => buildUsers(request.query.network, request.query.granularity, options.clock())
  );

  app.get<{ Querystring: { network: NetworkFilter; range: MetricsRange } }>(
    '/revenue',
    {
      schema: {
        operationId: 'getRevenueMetrics',
        summary: 'Revenue dataset: synthetic fees and volume by network and asset',
        tags: ['metrics'],
        querystring: rangeQuery,
        response: { 200: revenueResponse, ...errorResponses }
      }
    },
    async (request) => buildRevenue(request.query.network, request.query.range, options.clock())
  );
}
