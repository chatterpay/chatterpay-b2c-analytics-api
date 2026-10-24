import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

/** Google keys that sign the ID tokens of service accounts. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** Decides whether a request comes from the caller allowed to run the ingestion. */
export type IngestCallerVerifier = (request: FastifyRequest) => Promise<boolean>;

/** Options of {@link googleServiceAccountVerifier}. */
export interface GoogleServiceAccountVerifierOptions {
  /** `aud` the token must carry: the audience configured on the Cloud Scheduler job. */
  audience: string;
  /** Email of the only service account admitted. */
  serviceAccountEmail: string;
  /** Key source; Google's remote JWKS by default, replaced by tests. */
  keys?: JWTVerifyGetKey;
}

/**
 * Verifier of the Google-signed OIDC ID token that Cloud Scheduler sends as
 * `Authorization: Bearer`.
 *
 * Cloud Run IAM already refuses callers without the invoker role, but the site service account
 * has that role too, so the API verifies the token itself: Google signature, issuer, audience,
 * `email` equal to the scheduler service account and `email_verified`. The site sends its own
 * identity in `X-Serverless-Authorization` and a session JWT in `Authorization`, which fails the
 * Google signature check, so neither the BFF nor a session can pass.
 *
 * @param options - Audience, service account and key source.
 * @returns The verifier.
 */
export function googleServiceAccountVerifier(
  options: GoogleServiceAccountVerifierOptions
): IngestCallerVerifier {
  const keys = options.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const expected = options.serviceAccountEmail.trim().toLowerCase();
  return async (request) => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? BEARER_PATTERN.exec(header)?.[1] : undefined;
    if (token === undefined) {
      return false;
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: GOOGLE_ISSUERS,
        audience: options.audience,
        algorithms: ['RS256']
      });
      return (
        typeof payload.email === 'string' &&
        payload.email.toLowerCase() === expected &&
        payload.email_verified === true
      );
    } catch {
      return false;
    }
  };
}
