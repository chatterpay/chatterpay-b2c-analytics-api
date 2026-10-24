import type { FastifyInstance } from 'fastify';

/** Body of `/healthz` and `/readyz`. */
export interface HealthBody {
  status: 'ok';
}

const healthResponseSchema = {
  200: {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'] } }
  }
} as const;

/**
 * Registers the infrastructure probes.
 *
 * Both answer without internal details. `/readyz` gains its dependency checks (MongoDB) when the
 * persistence layer is added; until then it matches liveness.
 *
 * @param app - Fastify instance to register the routes on.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
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
        summary: 'Readiness probe',
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
}
