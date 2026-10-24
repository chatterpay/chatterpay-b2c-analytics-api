import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Resolves the end-user IP used by the login rate limits.
 *
 * The BFF forwards the browser IP in `x-client-ip`; Cloud Run admits only the BFF, so the header
 * is trusted when it is an IPv4 or IPv6 literal. Otherwise the socket address is used.
 *
 * @param request - Incoming request.
 * @returns The client IP.
 */
export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-client-ip'];
  if (typeof forwarded === 'string' && forwarded.length <= 45 && isIP(forwarded) !== 0) {
    return forwarded;
  }
  return request.ip;
}
