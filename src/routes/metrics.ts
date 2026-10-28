import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRoles } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { NETWORK_ID_PATTERN, type NetworkFilter, type NetworkId } from '../metrics/catalog.js';
import { buildOverview } from '../metrics/overview.js';
import { buildRevenue } from '../metrics/revenue.js';
import type { HiddenAssets } from '../metrics/token-scope.js';
import type { MetricsRange, UsersGranularity } from '../metrics/types.js';
import { buildUsers } from '../metrics/users.js';
import type { Store } from '../store/types.js';
import { type StatisticsScope, statisticsScope } from './network-scope.js';
import { arrayOf, errorResponses, object } from './schemas.js';

/** Options of the metrics routes. */
export interface MetricsRoutesOptions {
  /** Source of the current instant; injected by tests. */
  clock: () => Date;
  /** Store of the network visibility policy, read once per request. */
  store: Store;
}

/** Visible networks and hidden tokens of each request, resolved once by the pre-handler. */
const scopes = new WeakMap<FastifyRequest, StatisticsScope>();

function scopeOf(request: FastifyRequest): StatisticsScope {
  const scope = scopes.get(request);
  if (scope === undefined) {
    throw new Error('Network scope not resolved');
  }
  return scope;
}

function visibleIds(request: FastifyRequest): readonly NetworkId[] {
  return scopeOf(request).networks.map((network) => network.id);
}

function hiddenOf(request: FastifyRequest): HiddenAssets {
  return scopeOf(request).hidden;
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
    'not_read',
    'not_valued',
    'native_not_covered',
    'undated_users',
    'undated_accounts',
    null
  ]
} as const;
const valuedMoneyMetric = object({
  value: nullableDecimal,
  previous: nullableDecimal,
  changeRatio: nullableDecimal,
  availability,
  reason
});
const networkReadReason = {
  type: ['string', 'null'],
  enum: [
    'b2c_disabled',
    'collection_off',
    'source_absent',
    'no_endpoint',
    'unsupported_provider',
    'rpc_failed',
    'budget_exhausted',
    'deadline_reached',
    'read_incomplete',
    null
  ]
} as const;
const product = { type: 'string', enum: ['transfer', 'swap', 'polymarket'] } as const;
const retentionMonth = { type: 'integer', enum: [1, 3, 6] } as const;
const count = { type: 'integer', minimum: 0 } as const;

const ingestRunStatus = object({
  status: { type: 'string', enum: ['completed', 'partial'] },
  finishedAt: instant,
  // `polymarket` is optional: runs stored before the Polymarket fills were read have none.
  sources: {
    type: 'object',
    additionalProperties: false,
    required: ['transactions', 'prices', 'balances'],
    properties: {
      transactions: { type: 'string', enum: ['complete', 'partial'] },
      prices: { type: 'string', enum: ['complete', 'failed', 'skipped', 'disabled'] },
      balances: { type: 'string', enum: ['complete', 'partial', 'failed', 'disabled'] },
      polymarket: { type: 'string', enum: ['complete', 'partial', 'failed', 'disabled'] }
    }
  },
  valuation: { type: 'string', enum: ['market', 'none'] }
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
        unpricedAssets: arrayOf(object({ network, asset: { type: 'string' } })),
        nativeNotCovered: arrayOf(network)
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
      tvlUsd: nullableDecimal,
      share: nullableRatio,
      status: { type: 'string', enum: ['complete', 'partial', 'failed', 'unsupported'] },
      reason: networkReadReason,
      lastSuccessAt: nullableInstant
    })
  ),
  lastComplete: { anyOf: [object({ asOf: instant, valueUsd: decimal }), { type: 'null' }] }
});

const topTokensBlock = block({
  items: arrayOf(
    object({
      asset: { type: 'string' },
      amount,
      valueUsd: nullableDecimal,
      share: nullableRatio,
      networks: arrayOf(object({ network, amount, valueUsd: nullableDecimal }))
    })
  ),
  totalUsd: nullableDecimal
});

const tradedTokensBlock = block({
  items: arrayOf(
    object({ network, asset: { type: 'string' }, operations: count, volumeUsd: nullableDecimal })
  )
});

const tokenScope = object({
  hidden: arrayOf(object({ network, asset: { type: 'string' } })),
  operationCounts: {
    type: 'string',
    enum: ['filtered', 'unfiltered'],
    description:
      'unfiltered when the build behind the transaction counts has no count per asset, so they still include the operations of hidden tokens.'
  }
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

const polymarketVolumeBlock = block({
  scope: {
    type: 'string',
    enum: ['all_networks'],
    description: 'Fills are read on Polygon for every account; the network filter does not apply.'
  },
  valueUsd: nullableDecimal,
  fills: { type: ['integer', 'null'], minimum: 0 },
  readThrough: nullableInstant,
  lastFillAt: {
    ...nullableInstant,
    description:
      'Start of the UTC hour of the last fill up to the end of the range, inside it or before it; null when no fill was read up to then.'
  }
});

const polymarketAccountsBlock = block({
  scope: {
    type: 'string',
    enum: ['all_networks'],
    description: 'Polymarket accounts are Polygon wallets; the network filter does not apply.'
  },
  accounts: { type: ['integer', 'null'], minimum: 0 },
  invalidAccounts: count,
  undatedAccounts: count,
  newAccounts: { anyOf: [countMetric, { type: 'null' }] }
});

const valuationBlock = block({
  operations: count,
  unpricedVolume: count,
  unpricedFees: count,
  unpricedAssets: arrayOf(
    object({ network, asset: { type: 'string' }, unpricedVolume: count, unpricedFees: count })
  )
});

const signupsBlock = block({ users: count, undatedUsers: count });

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
  meta: meta({ range: { type: 'string', enum: RANGE_ENUM }, tokenScope }),
  tiles: object({
    volumeUsd: valuedMoneyMetric,
    transactions: countMetric,
    feesUsd: valuedMoneyMetric,
    activeUsers: countMetric,
    newUsers: countMetric
  }),
  series: arrayOf(
    object({
      start: instant,
      end: instant,
      volumeUsd: nullableDecimal,
      transactions: { type: 'integer' },
      byNetwork: arrayOf(
        object({ network, volumeUsd: nullableDecimal, transactions: { type: 'integer' } })
      )
    })
  ),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      volumeUsd: nullableDecimal,
      transactions: { type: 'integer' },
      feesUsd: nullableDecimal,
      activeUsers: { type: 'integer' },
      newUsers: { type: 'integer' }
    })
  ),
  valuation: valuationBlock,
  tvl: tvlBlock,
  topTokens: topTokensBlock,
  tradedTokens: tradedTokensBlock,
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
  retentionSummary: retentionSummaryBlock,
  signups: signupsBlock
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
  meta: meta({ range: { type: 'string', enum: RANGE_ENUM }, tokenScope }),
  tiles: object({
    feesUsd: valuedMoneyMetric,
    transferFeesUsd: valuedMoneyMetric,
    swapFeesUsd: valuedMoneyMetric,
    volumeUsd: valuedMoneyMetric,
    swapVolumeUsd: valuedMoneyMetric
  }),
  series: arrayOf(
    object({
      start: instant,
      end: instant,
      feesUsd: nullableDecimal,
      transferFeesUsd: nullableDecimal,
      swapFeesUsd: nullableDecimal
    })
  ),
  byNetwork: arrayOf(
    object({
      network,
      label: { type: 'string' },
      feesUsd: nullableDecimal,
      transferFeesUsd: nullableDecimal,
      swapFeesUsd: nullableDecimal,
      volumeUsd: nullableDecimal
    })
  ),
  byAsset: arrayOf(
    object({
      network,
      asset: { type: 'string' },
      volumeUsd: nullableDecimal,
      feesUsd: nullableDecimal
    })
  ),
  valuation: valuationBlock,
  avgFeePerTransaction: averageFeeBlock,
  polymarketVolume: polymarketVolumeBlock,
  polymarketAccounts: polymarketAccountsBlock,
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
 * Networks an admin hid (see `/v1/admin/networks`) are left out of `/networks`, of `network=all`
 * (tiles, series, breakdowns, comparisons with the previous period and cohorts) and answer 400 as
 * unknown networks when requested by id. The policy is read from the analytics database on every
 * request; when it cannot be read the routes answer 503 instead of serving networks that may be
 * hidden. Tokens an admin hid (`/v1/admin/tokens`) leave the money figures, the token blocks and,
 * when the build counts operations per asset, the transaction counts of Overview and Revenue
 * (`meta.tokenScope`); Users has no token figure.
 *
 * @param app - Fastify instance (encapsulated by the prefix).
 * @param options - Clock used to anchor the dataset and store of the visibility policy.
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
    // One read of the policy per request, so every block of a response uses the same networks.
    const scope = await statisticsScope(options.store, request);
    const visible = scope.networks;
    const requested = request.query.network;
    // A hidden network answers exactly like an unknown one, so its data cannot be requested.
    if (
      requested !== undefined &&
      requested !== 'all' &&
      !visible.some((network) => network.id === requested)
    ) {
      throw new ApiError(400, 'BAD_REQUEST', 'Unknown network');
    }
    scopes.set(request, scope);
  });

  app.get(
    '/networks',
    {
      schema: {
        operationId: 'getMetricsNetworks',
        summary: 'Networks the statistics show: the catalog without the hidden networks',
        tags: ['metrics'],
        response: { 200: networksResponse, ...errorResponses }
      }
    },
    async (request) => ({
      networks: scopeOf(request).networks.map(({ id, label, family }) => ({ id, label, family }))
    })
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
      withStatus(
        reply,
        buildOverview(
          request.query.network,
          request.query.range,
          options.clock(),
          visibleIds(request),
          hiddenOf(request)
        )
      )
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
        buildUsers(
          request.query.network,
          request.query.granularity,
          options.clock(),
          visibleIds(request)
        )
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
      withStatus(
        reply,
        buildRevenue(
          request.query.network,
          request.query.range,
          options.clock(),
          visibleIds(request),
          hiddenOf(request)
        )
      )
  );
}
