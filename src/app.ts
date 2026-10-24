import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppEnv } from './config/env.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { healthRoutes } from './routes/health.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Builds the Fastify application without binding a port, so tests can use `inject`.
 *
 * The incoming `x-request-id` is reused only when it matches a safe pattern; otherwise a UUID is
 * generated. Logs redact credentials and session headers.
 *
 * @param env - Validated configuration.
 * @returns The configured, not yet listening, application.
 */
export async function buildApp(env: AppEnv): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-serverless-authorization"]',
          'req.headers.cookie'
        ],
        censor: '[redacted]'
      }
    },
    bodyLimit: env.BODY_LIMIT_BYTES,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
    // Disabled so Fastify does not adopt the raw header; genReqId validates it instead.
    requestIdHeader: false,
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    return503OnClosing: true
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] }
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);
  await app.register(healthRoutes);

  return app;
}
