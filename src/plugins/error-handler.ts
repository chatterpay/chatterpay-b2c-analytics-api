import type { FastifyError, FastifyInstance } from 'fastify';
import { ApiError, type ApiErrorBody, codeForStatus } from '../errors/api-error.js';

const INTERNAL_MESSAGE = 'Unexpected error';

/**
 * Installs the error and not-found handlers that shape every failure as {@link ApiErrorBody}.
 *
 * Server errors are logged with their stack and answered with a generic message, so stack traces
 * and internal details never reach the caller.
 *
 * @param app - Fastify instance to configure.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        code: error.code,
        message: error.message,
        requestId: request.id
      };
      return reply.status(error.statusCode).headers(error.headers).send(body);
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ statusCode, errCode: error.code }, 'request rejected');
    }

    const body: ApiErrorBody = {
      code: error.validation ? 'BAD_REQUEST' : codeForStatus(statusCode),
      message: statusCode >= 500 ? INTERNAL_MESSAGE : error.message,
      requestId: request.id
    };
    return reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: request.id
    };
    return reply.status(404).send(body);
  });
}
