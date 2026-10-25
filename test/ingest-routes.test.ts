import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/principal.js';
import {
  googleServiceAccountVerifier,
  type IngestCallerVerifier
} from '../src/auth/scheduler-identity.js';
import { loadEnv } from '../src/config/env.js';
import type { IngestionReport } from '../src/ingest/run.js';
import { aggregateActivity, liveSourceFrom } from '../src/metrics/live.js';
import { setLiveSource } from '../src/metrics/sources.js';
import type { IngestionHandle } from '../src/routes/ingest.js';
import { CHAINS, TOKENS, transaction } from './ingest-fakes.js';

const NOW = new Date('2026-10-24T15:30:00.000Z');
const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const AUDIENCE = 'https://analytics-api.example.run.app';
const SCHEDULER = 'analytics-scheduler@project.iam.gserviceaccount.com';

const REPORT: IngestionReport = {
  runId: 'run-1',
  status: 'completed',
  startedAt: NOW.toISOString(),
  durationMs: 12,
  valuation: 'market',
  phasesMs: {
    copyTransactions: 3,
    revisit: 1,
    catalogUsers: 2,
    prices: 0,
    snapshot: 0,
    aggregateRebuild: 4,
    persist: 2
  },
  sources: {
    transactions: { read: 3, revisited: 0, lastId: '000000000000000000000003' },
    users: { read: 2, newWallets: 2, countedInCountries: 2 },
    catalog: { tokens: 6, networks: 2, retainedTokens: 0, retainedNetworks: 0 },
    prices: { provider: null, calls: 0, prices: 0, failed: false },
    balances: { status: 'disabled', calls: 0, failedCalls: 0, networks: [], masterWallets: 0 }
  },
  aggregates: {
    transfers: 3,
    swaps: 0,
    unpriced: 0,
    unpricedFees: 0,
    unverifiedSwaps: 0,
    outsideCatalog: 0,
    users: 2,
    undatedUsers: 0,
    wallets: 2,
    verifiedWallets: 1,
    builtAt: NOW.toISOString()
  }
};

async function viewer(request: { headers: Record<string, unknown> }): Promise<Principal | null> {
  return request.headers['x-test-role'] === 'viewer' ? { userId: 'u-test', role: 'viewer' } : null;
}

function handle(overrides: Partial<IngestionHandle> = {}): IngestionHandle & { runs: number } {
  const state = {
    runs: 0,
    run: async () => {
      state.runs += 1;
      return REPORT;
    },
    verifyCaller: null as IngestCallerVerifier | null,
    devTrigger: false,
    ...overrides
  };
  return state;
}

async function appWith(ingestion: IngestionHandle | null): Promise<FastifyInstance> {
  const app = await buildApp(env, { authenticate: viewer, clock: () => NOW, ingestion });
  await app.ready();
  return app;
}

describe('scheduler identity', () => {
  let sign: (claims: Record<string, unknown>) => Promise<string>;
  let verify: IngestCallerVerifier;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    verify = googleServiceAccountVerifier({
      audience: AUDIENCE,
      serviceAccountEmail: SCHEDULER,
      keys: createLocalJWKSet({ keys: [jwk] })
    });
    sign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  const request = (token: string) =>
    ({
      headers: { authorization: `Bearer ${token}` }
    }) as unknown as Parameters<IngestCallerVerifier>[0];

  it('admits the scheduler service account', async () => {
    const token = await sign({ aud: AUDIENCE, email: SCHEDULER, email_verified: true });
    expect(await verify(request(token))).toBe(true);
  });

  it.each([
    [
      'another account',
      { aud: AUDIENCE, email: 'site@p.iam.gserviceaccount.com', email_verified: true }
    ],
    ['another audience', { aud: 'https://other.example', email: SCHEDULER, email_verified: true }],
    ['an unverified email', { aud: AUDIENCE, email: SCHEDULER, email_verified: false }]
  ])('refuses %s', async (_label, claims) => {
    expect(await verify(request(await sign(claims)))).toBe(false);
  });

  it('refuses a missing or malformed header', async () => {
    expect(await verify({ headers: {} } as unknown as Parameters<IngestCallerVerifier>[0])).toBe(
      false
    );
    expect(await verify(request('not-a-jwt'))).toBe(false);
  });
});

describe('POST /v1/internal/ingest', () => {
  it('answers 503 without ingestion or without an admitted caller', async () => {
    for (const ingestion of [null, handle()]) {
      const app = await appWith(ingestion);
      const response = await app.inject({ method: 'POST', url: '/v1/internal/ingest' });
      expect(response.statusCode).toBe(503);
      await app.close();
    }
  });

  it('refuses sessions and unverified callers', async () => {
    const ingestion = handle({ verifyCaller: async () => false });
    const app = await appWith(ingestion);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/internal/ingest',
      headers: { 'x-test-role': 'viewer' }
    });

    expect(response.statusCode).toBe(401);
    expect(ingestion.runs).toBe(0);
    await app.close();
  });

  it('runs for a verified caller and returns the summary', async () => {
    const ingestion = handle({ verifyCaller: async () => true });
    const app = await appWith(ingestion);

    const response = await app.inject({ method: 'POST', url: '/v1/internal/ingest' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(REPORT);
    expect(ingestion.runs).toBe(1);
    await app.close();
  });

  it('runs for anyone with the development trigger', async () => {
    const ingestion = handle({ devTrigger: true });
    const app = await appWith(ingestion);

    const response = await app.inject({ method: 'POST', url: '/v1/internal/ingest' });

    expect(response.statusCode).toBe(200);
    expect(ingestion.runs).toBe(1);
    await app.close();
  });
});

describe('metrics with live aggregates', () => {
  afterEach(() => {
    setLiveSource(null);
  });

  it.each(['overview', 'users', 'revenue'])(
    '%s reports live data and its update time',
    async (view) => {
      const { aggregates } = aggregateActivity({
        transactions: [transaction(1, { date: new Date('2026-10-24T10:00:00.000Z') })],
        users: [],
        tokens: TOKENS,
        chains: new Map(CHAINS.map((chain) => [chain.chainId, chain.network])),
        prices: []
      });
      const builtAt = new Date('2026-10-24T03:00:00.000Z');
      setLiveSource(liveSourceFrom(aggregates), builtAt);
      const app = await appWith(null);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/metrics/${view}`,
        headers: { 'x-test-role': 'viewer' }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-data-status']).toBe('live');
      const body = response.json();
      expect(body.meta.dataStatus).toBe('live');
      expect(body.meta.datasetVersion).toBe('live-v3');
      expect(body.meta.lastUpdatedAt).toBe(builtAt.toISOString());
      if (view === 'overview') {
        expect(body.tiles.transactions.value).toBe(1);
        expect(body.tiles.volumeUsd.value).toBe('10.00');
      }
      await app.close();
    }
  );
});
