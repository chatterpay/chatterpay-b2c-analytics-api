import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { createJwtAuthenticator } from './auth/jwt-authenticator.js';
import type { Authenticator } from './auth/principal.js';
import { loadSigningKeys } from './auth/session-token.js';
import type { AppEnv } from './config/env.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { type IngestionHandle, ingestRoutes } from './routes/ingest.js';
import { metricsRoutes } from './routes/metrics.js';
import { registerSharedSchemas } from './routes/schemas.js';
import { teamRoutes } from './routes/team.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/types.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Dependencies that tests replace. */
export interface AppOptions {
  /** Resolves the session principal; the session JWT authenticator by default. */
  authenticate?: Authenticator;
  /** Source of the current instant for sessions, challenges, invites and the mock datasets. */
  clock?: () => Date;
  /** Persistence; a new in-memory store by default, refused in production. */
  store?: Store;
  /** Ingestion behind `POST /v1/internal/ingest`; `null` by default, which answers 503. */
  ingestion?: IngestionHandle | null;
}

/**
 * Builds the Fastify application without binding a port, so tests can use `inject`.
 *
 * The incoming `x-request-id` is reused only when it matches a safe pattern; otherwise a UUID is
 * generated. Logs redact credentials and session headers. Query strings and bodies with unknown
 * properties are rejected instead of stripped. Members live in the store; the first admin of a
 * new database is inserted by an operator.
 *
 * @param env - Validated configuration.
 * @param options - Replaceable dependencies.
 * @returns The configured, not yet listening, application.
 * @throws {Error} When the in-memory store is used in production.
 */
export async function buildApp(env: AppEnv, options: AppOptions = {}): Promise<FastifyInstance> {
  const clock = options.clock ?? ((): Date => new Date());
  const store = options.store ?? new MemoryStore();
  if (store.kind === 'memory' && env.NODE_ENV === 'production') {
    throw new Error('Production requires the MongoDB store');
  }
  const keys = loadSigningKeys(env);
  const authenticate = options.authenticate ?? createJwtAuthenticator({ env, keys, store, clock });

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-serverless-authorization"]',
          'req.headers.cookie',
          'req.headers["x-client-ip"]'
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

  if (store.kind === 'memory') {
    app.log.warn('using the in-memory store: MONGO_URI is unset, data is lost on restart');
  }
  if (keys.ephemeral) {
    app.log.warn('JWT_PRIVATE_KEY is unset: using an ephemeral key, sessions end on restart');
  }

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ChatterPay Analytics API',
        version: '0.1.0',
        description:
          'Private API behind the ChatterPay Analytics site BFF. Cloud Run only admits callers with an IAM identity token of the site or the scheduler service account, whose audience is the API domain. Metrics come from the aggregates of the analytics database, which the scheduler refreshes through the ingestion endpoint; meta.dataStatus tells live, mixed and mock values apart.'
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
  await app.register(healthRoutes, { store });
  await app.register(authRoutes, { prefix: '/v1/auth', env, store, keys, clock });
  await app.register(teamRoutes, { prefix: '/v1/team', store, clock });
  await app.register(metricsRoutes, { prefix: '/v1/metrics', clock, store });
  await app.register(adminRoutes, { prefix: '/v1/admin', store, clock });
  await app.register(ingestRoutes, {
    prefix: '/v1/internal',
    ingestion: options.ingestion ?? null
  });

  return app;
}
