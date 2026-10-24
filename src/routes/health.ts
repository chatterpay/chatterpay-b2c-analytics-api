import type { FastifyInstance } from 'fastify';
import type { Store } from '../store/types.js';

/** Body of `/healthz` and `/readyz`. */
export interface HealthBody {
  status: 'ok' | 'unavailable';
}

const healthBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['ok', 'unavailable'] } }
} as const;

const healthResponseSchema = { 200: healthBodySchema } as const;
const readinessResponseSchema = { 200: healthBodySchema, 503: healthBodySchema } as const;

/**
 * Registers the infrastructure probes.
 *
 * Both answer without internal details. `/healthz` reports the process only; `/readyz` also checks
 * the store and answers 503 when it does not respond.
 *
 * @param app - Fastify instance to register the routes on.
 * @param options - Store checked by the readiness probe.
 */
export async function healthRoutes(app: FastifyInstance, options: { store: Store }): Promise<void> {
  app.get(
    '/healthz',
    {
      schema: {
        operationId: 'getHealth',
        summary: 'Liveness probe',
        tags: ['infrastructure'],
        response: healthResponseSchema
      }
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      const body: HealthBody = { status: 'ok' };
      return body;
    }
  );

  app.get(
    '/readyz',
    {
      schema: {
        operationId: 'getReadiness',
        summary: 'Readiness probe: the process and the store answer',
        tags: ['infrastructure'],
        response: readinessResponseSchema
      }
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      const ready = await options.store.ping();
      reply.status(ready ? 200 : 503);
      const body: HealthBody = { status: ready ? 'ok' : 'unavailable' };
      return body;
    }
  );
}
