import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { ActivityClient } from '../store/types.js';

/** Life of the browser data of an activity event. */
export const ACTIVITY_CLIENT_TTL_MS: number = 60 * 24 * 60 * 60 * 1000;

function forwardedIp(request: FastifyRequest): string | null {
  const forwarded = request.headers['x-client-ip'];
  return typeof forwarded === 'string' && forwarded.length <= 45 && isIP(forwarded) !== 0
    ? forwarded
    : null;
}

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
  return forwardedIp(request) ?? request.ip;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A forwarded header as plain text: control characters removed, cut to `maxLength`. */
function forwardedText(request: FastifyRequest, name: string, maxLength: number): string | null {
  const value = request.headers[name];
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(CONTROL_CHARACTERS, '').trim().slice(0, maxLength);
  return text.length > 0 ? text : null;
}

/**
 * Browser data of a request for the activity log, from the headers the BFF forwards:
 * `x-client-ip`, `x-client-user-agent`, `x-client-language` and the client hints
 * `x-client-platform`, `x-client-mobile` and `x-client-brands`. They are trusted like `x-client-ip`,
 * since Cloud Run admits only the BFF. The data expires {@link ACTIVITY_CLIENT_TTL_MS} after the
 * event.
 *
 * @param request - Request behind the event.
 * @param at - Instant of the event.
 * @returns The browser data; `null` when the request forwards none.
 */
export function activityClient(request: FastifyRequest, at: Date): ActivityClient | null {
  const mobile = forwardedText(request, 'x-client-mobile', 4);
  const client = {
    ip: forwardedIp(request),
    userAgent: forwardedText(request, 'x-client-user-agent', 512),
    language: forwardedText(request, 'x-client-language', 128),
    platform: forwardedText(request, 'x-client-platform', 64),
    mobile: mobile === '?1' ? true : mobile === '?0' ? false : null,
    brands: forwardedText(request, 'x-client-brands', 256)
  };
  if (Object.values(client).every((value) => value === null)) {
    return null;
  }
  return { ...client, expiresAt: new Date(at.getTime() + ACTIVITY_CLIENT_TTL_MS) };
}

/**
 * Instant and browser data of an activity event.
 *
 * @param request - Request behind the event.
 * @param at - Instant of the event.
 * @returns The fields to spread into the event.
 */
export function activityAt(
  request: FastifyRequest,
  at: Date
): { at: Date; client: ActivityClient | null } {
  return { at, client: activityClient(request, at) };
}
