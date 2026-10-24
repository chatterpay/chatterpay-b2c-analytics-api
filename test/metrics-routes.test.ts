import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/principal.js';
import { loadEnv } from '../src/config/env.js';

const NOW = new Date('2026-10-24T15:30:00.000Z');
const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

// Test-only authenticator: the `x-test-role` header stands in for a session.
async function headerAuthenticator(request: {
  headers: Record<string, unknown>;
}): Promise<Principal | null> {
  const role = request.headers['x-test-role'];
  if (role === 'admin' || role === 'viewer' || role === 'guest') {
    return { userId: 'user-test-0001', role: role as Principal['role'] };
  }
  return null;
}

describe('metrics routes', () => {
  let app: FastifyInstance;
  let anonymous: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(env, { authenticate: headerAuthenticator, clock: () => NOW });
    anonymous = await buildApp(env, { clock: () => NOW });
    await Promise.all([app.ready(), anonymous.ready()]);
  });

  afterAll(async () => {
    await Promise.all([app.close(), anonymous.close()]);
  });

  it.each(['overview', 'users', 'revenue'])(
    '%s answers the mock dataset to viewers',
    async (view) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/metrics/${view}`,
        headers: { 'x-test-role': 'viewer' }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-data-status']).toBe('mock');
      const body = response.json();
      expect(body.meta.dataStatus).toBe('mock');
      expect(body.meta.network).toBe('all');
      expect(body.meta.generatedAt).toBe(NOW.toISOString());
    }
  );

  it('applies the query filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/metrics/overview?network=cardano-preprod&range=week',
      headers: { 'x-test-role': 'admin' }
    });

    const body = response.json();
    expect(body.meta.range).toBe('week');
    expect(body.byNetwork.map((item: { network: string }) => item.network)).toEqual([
      'cardano-preprod'
    ]);
    expect(body.series).toHaveLength(7);
  });

  it('answers users by month when the granularity is omitted', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/metrics/users',
      headers: { 'x-test-role': 'viewer' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.granularity).toBe('monthly');
  });

  it.each([
    '/v1/metrics/overview?network=polygon',
    '/v1/metrics/overview?range=daily',
    '/v1/metrics/overview?granularity=daily',
    '/v1/metrics/users?range=month',
    '/v1/metrics/revenue?network[$ne]=base'
  ])('rejects %s with a typed 400', async (url) => {
    const response = await app.inject({ method: 'GET', url, headers: { 'x-test-role': 'viewer' } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers 401 without a session, before validating the query', async () => {
    const response = await anonymous.inject({
      method: 'GET',
      url: '/v1/metrics/overview?network=polygon'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(response.body).not.toContain('volumeUsd');
  });

  it('answers 403 to roles outside admin and viewer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/metrics/revenue',
      headers: { 'x-test-role': 'guest' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
