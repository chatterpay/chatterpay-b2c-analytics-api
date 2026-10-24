import type { FastifyInstance, FastifyReply } from 'fastify';
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

function withStatus<T extends { meta: { dataStatus: string } }>(reply: FastifyReply, body: T): T {
  reply.header('x-data-status', body.meta.dataStatus);
  return body;
}
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

const nullableInstant = { anyOf: [instant, { type: 'null' }] } as const;
const nullableRatio = { type: ['string', 'null'], pattern: '^\\d+\\.\\d{4}$' } as const;
const amount = { type: 'string', pattern: '^\\d+(\\.\\d+)?$' } as const;
const availability = { type: 'string', enum: ['available', 'partial', 'unavailable'] } as const;
const reason = {
  type: ['string', 'null'],
  enum: [
    'no_snapshot',
    'snapshots_disabled',
    'partial_coverage',
    'unpriced_assets',
    'unverified_wallets',
    'not_recorded',
    'no_transactions',
    'no_eligible_cohort',
    'not_configured',
    null
  ]
} as const;
const product = { type: 'string', enum: ['transfer', 'swap', 'polymarket'] } as const;
const retentionMonth = { type: 'integer', enum: [1, 3, 6] } as const;
const count = { type: 'integer', minimum: 0 } as const;

const ingestRunStatus = object({
  status: { type: 'string', enum: ['completed', 'partial'] },
  finishedAt: instant,
  sources: object({
    transactions: { type: 'string', enum: ['complete', 'partial'] },
    prices: { type: 'string', enum: ['complete', 'failed', 'skipped', 'disabled'] },
    balances: { type: 'string', enum: ['complete', 'partial', 'failed', 'disabled'] }
  })
});

/** Builds the schema of a block: origin, availability, reason and freshness, then its fields. */
function block(properties: Record<string, unknown>): Record<string, unknown> {
  return object({
    source: { type: 'string', enum: ['mock', 'live'] },
    availability,
    reason,
    asOf: nullableInstant,
    ...properties
  });
}

const tvlBlock = block({
  value: { anyOf: [moneyMetric, { type: 'null' }] },
  firstSnapshotAt: nullableInstant,
  coverage: {
    anyOf: [
      object({
        wallets: count,
        walletsRead: count,
        unpricedAssets: arrayOf(object({ network, asset: { type: 'string' } }))
      }),
      { type: 'null' }
    ]
  },
  series: arrayOf(
    object({ start: instant, end: instant, tvlUsd: nullableDecimal, asOf: nullableInstant })
  ),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      tvlUsd: decimal,
      share: nullableRatio,
      status: { type: 'string', enum: ['complete', 'partial', 'failed', 'unsupported'] }
    })
  )
});

const topTokensBlock = block({
  items: arrayOf(
    object({ asset: { type: 'string' }, amount, valueUsd: nullableDecimal, share: nullableRatio })
  ),
  totalUsd: nullableDecimal
});

const topCountriesBlock = block({
  method: { type: 'string', enum: ['phone_prefix'] },
  items: arrayOf(
    object({
      country: { type: 'string', pattern: '^([A-Z]{2}|Unknown)$' },
      users: count,
      share: nullableRatio
    })
  ),
  totalUsers: count
});

const volumeByProductBlock = block({
  items: arrayOf(
    object({
      product,
      availability,
      reason,
      volumeUsd: nullableDecimal,
      transactions: { type: ['integer', 'null'], minimum: 0 },
      share: nullableRatio
    })
  )
});

const feesByProductBlock = block({
  items: arrayOf(
    object({ product, availability, reason, feesUsd: nullableDecimal, share: nullableRatio })
  )
});

const averageFeeBlock = block({
  valueUsd: nullableDecimal,
  previousUsd: nullableDecimal,
  changeRatio: nullableDecimal,
  transactions: count,
  previousTransactions: { type: ['integer', 'null'], minimum: 0 }
});

const polymarketVolumeBlock = block({ valueUsd: nullableDecimal });

const masterWalletsBlock = block({
  items: arrayOf(
    object({
      network,
      label: { type: 'string' },
      role: { type: 'string' },
      address: { type: 'string' },
      explorerUrl: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['complete', 'failed', 'unsupported'] },
      balances: arrayOf(object({ asset: { type: 'string' }, amount, valueUsd: nullableDecimal })),
      valueUsd: nullableDecimal,
      share: nullableRatio
    })
  ),
  totalUsd: nullableDecimal
});

const newWalletsBlock = block({
  definition: { type: 'string', enum: ['first_verifiable_appearance'] },
  trackingSince: nullableInstant,
  tile: countMetric,
  series: arrayOf(object({ start: instant, end: instant, newWallets: count })),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      newWallets: count,
      wallets: count,
      verifiedWallets: count
    })
  ),
  coverage: object({ wallets: count, verifiedWallets: count })
});

const retentionSummaryBlock = block({
  months: arrayOf(
    object({
      month: retentionMonth,
      availability,
      reason,
      eligibleCohorts: count,
      cohortUsers: count,
      retainedUsers: count,
      rate: nullableRatio
    })
  ),
  cohorts: arrayOf(
    object({
      cohort: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
      size: count,
      retained: arrayOf(
        object({ month: retentionMonth, users: { type: ['integer', 'null'], minimum: 0 } })
      )
    })
  )
});

function meta(extra: Record<string, unknown>): Record<string, unknown> {
  return object({
    datasetVersion: { type: 'string' },
    dataStatus: { type: 'string', enum: ['mock', 'mixed', 'live'] },
    lastUpdatedAt: { anyOf: [instant, { type: 'null' }] },
    ingest: { anyOf: [ingestRunStatus, { type: 'null' }] },
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
    granularity: { type: 'string', enum: GRANULARITY_ENUM, default: 'monthly' }
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
  ),
  tvl: tvlBlock,
  topTokens: topTokensBlock,
  topCountries: topCountriesBlock,
  volumeByProduct: volumeByProductBlock
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
  ),
  newWallets: newWalletsBlock,
  retentionSummary: retentionSummaryBlock
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
    volumeUsd: moneyMetric,
    swapVolumeUsd: moneyMetric
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
  ),
  avgFeePerTransaction: averageFeeBlock,
  polymarketVolume: polymarketVolumeBlock,
  feesByProduct: feesByProductBlock,
  masterWallets: masterWalletsBlock
});

/**
 * Registers the metrics endpoints under the plugin prefix.
 *
 * Every route requires an `admin` or `viewer` session and answers `Cache-Control: private,
 * no-store`. Live values come from the aggregates and run snapshots of the analytics database,
 * loaded in memory; no handler reads the B2C database, a chain or a provider. Every block added to
 * a dataset carries `source`, `availability`, `reason` and `asOf`, and `meta.ingest` carries the
 * per-source status of the run behind the live values. `X-Data-Status` repeats `meta.dataStatus`
 * (`mock`, `mixed` or `live`); `/networks`, which has no meta, answers `mock`. Unknown query
 * parameters, values outside the enums and networks outside the catalog answer 400.
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
    if (!reply.hasHeader('x-data-status')) {
      reply.header('x-data-status', 'mock');
    }
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
        summary: 'Overview dataset: volume, fees, users, TVL, top tokens, countries and products',
        tags: ['metrics'],
        querystring: rangeQuery,
        response: { 200: overviewResponse, ...errorResponses }
      }
    },
    async (request, reply) =>
      withStatus(reply, buildOverview(request.query.network, request.query.range, options.clock()))
  );

  app.get<{ Querystring: { network: NetworkFilter; granularity: UsersGranularity } }>(
    '/users',
    {
      schema: {
        operationId: 'getUsersMetrics',
        summary: 'Users dataset: active users, new users and wallets, retention cohorts',
        tags: ['metrics'],
        querystring: usersQuery,
        response: { 200: usersResponse, ...errorResponses }
      }
    },
    async (request, reply) =>
      withStatus(
        reply,
        buildUsers(request.query.network, request.query.granularity, options.clock())
      )
  );

  app.get<{ Querystring: { network: NetworkFilter; range: MetricsRange } }>(
    '/revenue',
    {
      schema: {
        operationId: 'getRevenueMetrics',
        summary: 'Revenue dataset: fees and volume by network, asset and product; master wallets',
        tags: ['metrics'],
        querystring: rangeQuery,
        response: { 200: revenueResponse, ...errorResponses }
      }
    },
    async (request, reply) =>
      withStatus(reply, buildRevenue(request.query.network, request.query.range, options.clock()))
  );
}
