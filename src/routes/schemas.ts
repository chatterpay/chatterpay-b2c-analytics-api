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
        'CANNOT_CHANGE_OWN_ROLE',
        'CANNOT_REMOVE_SELF',
        'CANNOT_BLOCK_SELF',
        'NOT_FOUND',
        'CONFLICT',
        'CONFIG_CONFLICT',
        'LAST_ENABLED_NETWORK',
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
 * Builds the error part of a route `response` map for the given statuses.
 *
 * @param statuses - HTTP statuses the route can answer with the shared error body.
 * @returns Map from status to a reference to the shared error schema.
 */
export function errorResponsesFor(statuses: readonly number[]): Record<string, { $ref: string }> {
  return Object.fromEntries(statuses.map((status) => [String(status), errorRef]));
}

/**
 * Builds a closed object schema whose properties are all required.
 *
 * @param properties - Property schemas.
 * @returns JSON Schema of the object.
 */
export function object(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  };
}

/**
 * Builds an array schema.
 *
 * @param items - Schema of each item.
 * @returns JSON Schema of the array.
 */
export function arrayOf(items: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', items };
}

/**
 * Adds the shared schemas to the instance. Must run before routes that reference them.
 *
 * @param app - Root Fastify instance.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema(apiErrorSchema);
}
