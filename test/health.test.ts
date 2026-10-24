import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('infrastructure probes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['/healthz', '/readyz'])('%s answers ok without caching', async (url) => {
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('answers unknown routes with the typed error body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
      headers: { 'x-request-id': 'test-request-0001' }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: 'test-request-0001'
    });
  });

  it('replaces request ids that do not match the safe pattern', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': '<script>alert(1)</script>' }
    });

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('sends hardening headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
