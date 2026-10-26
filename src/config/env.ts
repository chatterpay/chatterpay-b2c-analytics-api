import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import type { MasterWalletConfig } from '../ingest/snapshot.js';
import { NETWORK_ID_PATTERN } from '../metrics/catalog.js';
import type { UsdValuation } from '../metrics/types.js';

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
  /**
   * Connection string of the ChatterPay B2C database, the source of the networks, with the database
   * in its path. Required in production; outside production `null` reuses `MONGO_URI`.
   */
  B2C_MONGO_URI: string | null;
  /** B2C database used when `B2C_MONGO_URI` has no database in its path. */
  B2C_MONGO_DB_NAME: string;
  /**
   * Service account whose Google ID token may call `POST /v1/internal/ingest` (the Cloud Scheduler
   * job identity); `null` leaves the endpoint closed unless `INGEST_DEV_TRIGGER` is on.
   */
  INGEST_SCHEDULER_SA_EMAIL: string | null;
  /** `aud` of that token, as set on the scheduler job; required with the service account. */
  INGEST_OIDC_AUDIENCE: string | null;
  /** Opens the ingestion endpoint to any caller; refused in production. */
  INGEST_DEV_TRIGGER: boolean;
  /** B2C transaction rows per batch. */
  INGEST_BATCH_SIZE: number;
  /** Ceiling on B2C transaction rows read in one run. */
  INGEST_MAX_TRANSACTIONS_PER_RUN: number;
  /** Rows inserted this many hours before a run are read again for status changes. */
  INGEST_REVISIT_HOURS: number;
  /** A run starts no new batch after this many seconds; below the Cloud Run request timeout. */
  INGEST_MAX_RUN_SECONDS: number;
  /** Price provider of the daily snapshot; `none` values non-stable tokens from swaps only. */
  PRICES_PROVIDER: 'none' | 'coingecko';
  /** Ceiling on price provider requests per run. */
  PRICES_MAX_CALLS_PER_RUN: number;
  /**
   * Reader of the balance snapshots; `rpc` reads through the `rpc` (EVM) and `providerUrl` (Koios
   * or Blockfrost, Cardano) of each network in the B2C `blockchains` collection, `none` takes no snapshot.
   */
  BALANCES_PROVIDER: 'none' | 'rpc';
  /** Ceiling on balance requests (`eth_call` batches, Koios pages, Blockfrost addresses) per run. */
  BALANCES_MAX_CALLS_PER_RUN: number;
  /**
   * Blockfrost project id, the variable the B2C backend uses for the same provider. Without it a
   * Cardano network whose `providerUrl` is Blockfrost is not read (`unsupported_provider`).
   */
  CARDANO_PROVIDER_API_KEY: string | null;
  /** Public addresses of the signers whose balances the snapshots read. */
  MASTER_WALLETS: MasterWalletConfig[];
  /**
   * USD valuation of balances and operations. `market`: stable tokens at 1 USD and the provider
   * and swap prices of the symbol. `none`: the deployment reads test networks whose assets have no
   * market value, so no USD figure is computed; amounts and counts are kept. It is set per
   * deployment, not inferred from network names or symbols.
   */
  USD_VALUATION: UsdValuation;
  /** Seconds between checks for a newer aggregate build made by another instance. */
  METRICS_REFRESH_SECONDS: number;
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

/**
 * Public address of an EVM account or a Cardano address. A private key, a seed phrase or an
 * extended key does not match either shape, so signing material is refused instead of stored.
 */
const PUBLIC_ADDRESS = /^(0x[0-9a-fA-F]{40}|addr(_test)?1[02-9ac-hj-np-z]{20,200})$/;

const masterWalletSchema = z
  .object({
    network: z.string().regex(new RegExp(NETWORK_ID_PATTERN)).max(64),
    address: z.string().regex(PUBLIC_ADDRESS),
    role: z.string().trim().min(1).max(64),
    nativeSymbol: z
      .string()
      .regex(/^[A-Za-z0-9.]{1,12}$/)
      .optional()
  })
  .strict();

const masterWalletsSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: 'custom', message: 'Not JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.array(masterWalletSchema).max(20));

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
      .default('chatterpay-analytics-dev'),
    B2C_MONGO_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//)
      .nullable()
      .default(null),
    B2C_MONGO_DB_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,63}$/)
      .default('chatterpay-dev'),
    INGEST_SCHEDULER_SA_EMAIL: z.email().nullable().default(null),
    INGEST_OIDC_AUDIENCE: z.string().min(1).max(512).nullable().default(null),
    INGEST_DEV_TRIGGER: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    INGEST_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(1000),
    INGEST_MAX_TRANSACTIONS_PER_RUN: z.coerce
      .number()
      .int()
      .min(1000)
      .max(1_000_000)
      .default(50_000),
    INGEST_REVISIT_HOURS: z.coerce.number().int().min(0).max(720).default(72),
    INGEST_MAX_RUN_SECONDS: z.coerce.number().int().min(30).max(3000).default(480),
    PRICES_PROVIDER: z.enum(['none', 'coingecko']).default('none'),
    PRICES_MAX_CALLS_PER_RUN: z.coerce.number().int().min(0).max(5).default(1),
    BALANCES_PROVIDER: z.enum(['none', 'rpc']).default('none'),
    BALANCES_MAX_CALLS_PER_RUN: z.coerce.number().int().min(0).max(2000).default(100),
    CARDANO_PROVIDER_API_KEY: z.string().trim().min(1).max(256).nullable().default(null),
    MASTER_WALLETS: masterWalletsSchema.default([]),
    USD_VALUATION: z.enum(['market', 'none']).default('market'),
    METRICS_REFRESH_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300)
  })
  .superRefine((env, context) => {
    if ((env.INGEST_SCHEDULER_SA_EMAIL === null) !== (env.INGEST_OIDC_AUDIENCE === null)) {
      context.addIssue({
        code: 'custom',
        path: ['INGEST_OIDC_AUDIENCE'],
        message: 'Set together with INGEST_SCHEDULER_SA_EMAIL'
      });
    }
    if (env.NODE_ENV !== 'production') {
      return;
    }
    if (env.INGEST_DEV_TRIGGER) {
      context.addIssue({ code: 'custom', path: ['INGEST_DEV_TRIGGER'], message: 'Not allowed' });
    }
    for (const name of [
      'DEMO_ACCESS_CODE',
      'JWT_PRIVATE_KEY',
      'MONGO_URI',
      'B2C_MONGO_URI'
    ] as const) {
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
