import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

/** Validated runtime configuration of the API process. */
export interface AppEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  BODY_LIMIT_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
  /** Shared demo login code; `null` disables code verification (503). */
  DEMO_ACCESS_CODE: string | null;
  /** PEM PKCS8 Ed25519 key that signs session JWTs; `null` outside production only. */
  JWT_PRIVATE_KEY: string | null;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  SESSION_TTL_MINUTES: number;
  CHALLENGE_TTL_MINUTES: number;
  /** MongoDB connection string; `null` uses the in-memory store, outside production only. */
  MONGO_URI: string | null;
  MONGO_DB_NAME: string;
}

/**
 * Normalizes an email for storage and comparison: trimmed and lowercase.
 *
 * @param email - Raw email.
 * @returns The normalized email.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEd25519PrivateKey(pem: string): boolean {
  try {
    return createPrivateKey({ key: pem, format: 'pem' }).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

const envSchema: z.ZodType<AppEnv> = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(16_384),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    DEMO_ACCESS_CODE: z.string().min(12).max(64).nullable().default(null),
    // Secret managers and .env files often carry the PEM on one line with literal `\n` escapes.
    JWT_PRIVATE_KEY: z
      .string()
      .transform((value) => value.replace(/\\n/g, '\n'))
      .refine(isEd25519PrivateKey)
      .nullable()
      .default(null),
    JWT_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .default('dev'),
    JWT_ISSUER: z.string().min(1).default('chatterpay-analytics-api'),
    JWT_AUDIENCE: z.string().min(1).default('chatterpay-analytics-site'),
    SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
    CHALLENGE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    MONGO_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//)
      .nullable()
      .default(null),
    MONGO_DB_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,63}$/)
      .default('chatterpay_analytics_dev')
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }
    for (const name of ['DEMO_ACCESS_CODE', 'JWT_PRIVATE_KEY', 'MONGO_URI'] as const) {
      if (env[name] === null) {
        context.addIssue({ code: 'custom', path: [name], message: 'Required in production' });
      }
    }
  });

/**
 * Parses and validates the process environment.
 *
 * Fails fast at startup so a misconfigured revision never starts serving requests.
 * The error lists the offending variable names only, never their values. Empty values count as
 * unset, so a `.env` copied from `.env.example` falls back to the defaults. Production requires
 * `DEMO_ACCESS_CODE`, `JWT_PRIVATE_KEY` and `MONGO_URI`.
 *
 * @param source - Environment map to read, `process.env` by default.
 * @returns The validated configuration with defaults applied.
 * @throws {Error} When a variable is present but invalid, or required and missing.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid environment variables: ${names.join(', ')}`);
  }
  return result.data;
}
