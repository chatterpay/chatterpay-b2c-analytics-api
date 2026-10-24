import { z } from 'zod';

/** Validated runtime configuration of the API process. */
export interface AppEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  BODY_LIMIT_BYTES: number;
  REQUEST_TIMEOUT_MS: number;
}

const envSchema: z.ZodType<AppEnv> = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(16_384),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000)
});

/**
 * Parses and validates the process environment.
 *
 * Fails fast at startup so a misconfigured revision never starts serving requests.
 * The error lists the offending variable names only, never their values. Empty values count as
 * unset, so a `.env` copied from `.env.example` falls back to the defaults.
 *
 * @param source - Environment map to read, `process.env` by default.
 * @returns The validated configuration with defaults applied.
 * @throws {Error} When a variable is present but invalid.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${names.join(', ')}`);
  }
  return result.data;
}
