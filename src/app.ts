import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Authenticator, denyAllAuthenticator } from './auth/principal.js';
import type { AppEnv } from './config/env.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { registerSharedSchemas } from './routes/schemas.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Dependencies that tests replace. */
export interface AppOptions {
  /** Resolves the session principal; every request is anonymous by default. */
  authenticate?: Authenticator;
  /** Source of the current instant for the mock datasets. */
  clock?: () => Date;
}

/**
 * Builds the Fastify application without binding a port, so tests can use `inject`.
 *
 * The incoming `x-request-id` is reused only when it matches a safe pattern; otherwise a UUID is
 * generated. Logs redact credentials and session headers. Query strings with unknown parameters
 * are rejected instead of stripped.
 *
 * @param env - Validated configuration.
 * @param options - Replaceable dependencies.
 * @returns The configured, not yet listening, application.
 */
export async function buildApp(env: AppEnv, options: AppOptions = {}): Promise<FastifyInstance> {
  const authenticate = options.authenticate ?? denyAllAuthenticator;
  const clock = options.clock ?? ((): Date => new Date());

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
    return503OnClosing: true,
    ajv: { customOptions: { removeAdditional: false } }
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ChatterPay Analytics API',
        version: '0.1.0',
        description:
          'Private API behind the ChatterPay Analytics site BFF. Cloud Run only admits callers with an IAM identity token of the site service account. Every metric is synthetic and carries dataStatus "mock".'
      },
      servers: [{ url: 'http://127.0.0.1:4001', description: 'Local development' }]
    },
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) =>
        typeof json.$id === 'string' ? json.$id : `def-${index}`
    }
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

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    request.principal = await authenticate(request);
  });

  registerErrorHandling(app);
  registerSharedSchemas(app);
  await app.register(healthRoutes);
  await app.register(metricsRoutes, { prefix: '/v1/metrics', clock });

  return app;
}
