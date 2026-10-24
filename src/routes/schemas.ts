import type { FastifyInstance } from 'fastify';

/** `$id` of the shared error body schema. */
export const API_ERROR_SCHEMA_ID = 'ApiError';

const apiErrorSchema = {
  $id: API_ERROR_SCHEMA_ID,
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'requestId'],
  properties: {
    code: {
      type: 'string',
      enum: [
        'BAD_REQUEST',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'NOT_FOUND',
        'PAYLOAD_TOO_LARGE',
        'RATE_LIMITED',
        'SERVICE_UNAVAILABLE',
        'INTERNAL_ERROR'
      ]
    },
    message: {
      type: 'string',
      description: 'Caller-safe description; never contains secrets, codes or PII.'
    },
    requestId: { type: 'string' }
  }
};

const errorRef = { $ref: `${API_ERROR_SCHEMA_ID}#` };

/** Error responses shared by protected routes, for the `response` map of a route schema. */
export const errorResponses: Record<string, { $ref: string }> = {
  400: errorRef,
  401: errorRef,
  403: errorRef,
  429: errorRef,
  503: errorRef
};

/**
 * Adds the shared schemas to the instance. Must run before routes that reference them.
 *
 * @param app - Root Fastify instance.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema(apiErrorSchema);
}
