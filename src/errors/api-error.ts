/** Stable machine-readable error codes exposed in the `code` field of error responses. */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** Body of every non-2xx response, as declared in `openapi/openapi.yaml`. */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
}

/**
 * Error raised by route handlers to produce a typed error response.
 *
 * The message is returned to the caller, so it must never carry secrets, codes or PII.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly headers: Readonly<Record<string, string>>;

  /**
   * @param statusCode - HTTP status of the response.
   * @param code - Stable error code for clients.
   * @param message - Caller-safe description.
   * @param headers - Response headers to add, such as `retry-after`.
   */
  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    headers: Readonly<Record<string, string>> = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * Maps an HTTP status to the error code used when the error did not come from {@link ApiError}.
 *
 * @param statusCode - HTTP status of the response.
 * @returns The matching error code; 5xx and unknown statuses map to `INTERNAL_ERROR`.
 */
export function codeForStatus(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}
