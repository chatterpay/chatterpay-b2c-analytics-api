import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

/** Smallest valid production environment; test-only values, never real secrets. */
const PRODUCTION = {
  NODE_ENV: 'production',
  JWT_PRIVATE_KEY: generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString(),
  MONGO_URI: 'mongodb://127.0.0.1:27017',
  B2C_MONGO_URI: 'mongodb://127.0.0.1:27017/chatterpay-dev',
  OTP_HMAC_SECRET: 'a'.repeat(64),
  OTP_EMAIL_HMAC_SECRET: 'b'.repeat(64),
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_only',
  EMAIL_FROM: 'no-reply@example.com',
  SITE_URL: 'https://analytics.example.com'
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe(4001);
  });

  it('treats empty values as unset', () => {
    expect(loadEnv({ NODE_ENV: '', PORT: '' }).PORT).toBe(4001);
  });

  it('coerces numeric values', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('names invalid variables without echoing their values', () => {
    expect(() => loadEnv({ PORT: 'not-a-port-secret-value' })).toThrowError(/PORT/);
    expect(() => loadEnv({ PORT: 'not-a-port-secret-value' })).not.toThrowError(
      /not-a-port-secret-value/
    );
  });

  it('applies the auth defaults', () => {
    const env = loadEnv({});

    expect(env.DEMO_ACCESS_CODE).toBeNull();
    expect(env.JWT_PRIVATE_KEY).toBeNull();
    expect(env.JWT_KEY_ID).toBe('dev');
    expect(env.JWT_ISSUER).toBe('chatterpay-analytics-api');
    expect(env.JWT_AUDIENCE).toBe('chatterpay-analytics-site');
    expect(env.SESSION_TTL_MINUTES).toBe(120);
    expect(env.OTP_TTL_SECONDS).toBe(300);
    expect(env.MONGO_URI).toBeNull();
    expect(env.MONGO_DB_NAME).toBe('chatterpay-analytics-dev');
    expect(env.B2C_MONGO_DB_NAME).toBe('chatterpay-dev');
    expect(env.B2C_MONGO_URI).toBeNull();
  });

  it('accepts MongoDB connection strings and safe database names only', () => {
    expect(loadEnv({ MONGO_URI: 'mongodb+srv://cluster.example.net' }).MONGO_URI).toBe(
      'mongodb+srv://cluster.example.net'
    );
    expect(() => loadEnv({ MONGO_URI: 'https://cluster.example.net' })).toThrowError(
      /^Invalid environment variables: MONGO_URI$/
    );
    expect(() => loadEnv({ MONGO_DB_NAME: 'analytics.dev' })).toThrowError(/MONGO_DB_NAME/);
  });

  it('accepts an Ed25519 PKCS8 key with escaped newlines and rejects other keys', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

    const escaped = pem.replace(/\n/g, '\\n');

    expect(escaped).not.toContain('\n');
    expect(loadEnv({ JWT_PRIVATE_KEY: escaped }).JWT_PRIVATE_KEY).toBe(pem);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() =>
      loadEnv({ JWT_PRIVATE_KEY: rsa.export({ format: 'pem', type: 'pkcs8' }).toString() })
    ).toThrowError(/JWT_PRIVATE_KEY/);
  });

  it('rejects short access codes and out-of-range TTLs', () => {
    expect(() => loadEnv({ DEMO_ACCESS_CODE: 'short' })).toThrowError(/DEMO_ACCESS_CODE/);
    expect(() => loadEnv({ SESSION_TTL_MINUTES: '4' })).toThrowError(/SESSION_TTL_MINUTES/);
    expect(() => loadEnv({ OTP_TTL_SECONDS: '601' })).toThrowError(/OTP_TTL_SECONDS/);
  });

  it('requires Resend, the login code keys, the signing key and both MongoDB connections in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrowError(
      /^Invalid environment variables: EMAIL_PROVIDER, OTP_HMAC_SECRET, OTP_EMAIL_HMAC_SECRET, JWT_PRIVATE_KEY, MONGO_URI, B2C_MONGO_URI$/
    );
  });

  it('keeps the demo login off and the simulated emails by default', () => {
    const env = loadEnv({});

    expect(env.DEMO_LOGIN_ENABLED).toBe(false);
    expect(env.DEMO_LOGIN_EMAILS).toEqual([]);
    expect(env.EMAIL_PROVIDER).toBe('simulated');
    expect(env.RESEND_API_KEY).toBeNull();
    expect(env.EMAIL_FROM).toBeNull();
    expect(env.SITE_URL).toBeNull();
  });

  it('requires the key, the sender and the site URL to send through Resend', () => {
    expect(() => loadEnv({ EMAIL_PROVIDER: 'resend' })).toThrow(
      'Invalid environment variables: RESEND_API_KEY, EMAIL_FROM, SITE_URL'
    );
    const env = loadEnv({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_only',
      EMAIL_FROM: 'ChatterPay Analytics <no-reply@example.com>',
      SITE_URL: 'https://analytics.example.com/'
    });
    expect(env.SITE_URL).toBe('https://analytics.example.com');
    expect(loadEnv({ EMAIL_FROM: 'no-reply@example.com' }).EMAIL_FROM).toBe('no-reply@example.com');
    for (const sender of ['ChatterPay', 'ChatterPay <no-reply>', 'a@b.c\r\nBcc: x@y.z']) {
      expect(() => loadEnv({ EMAIL_FROM: sender })).toThrow(
        'Invalid environment variables: EMAIL_FROM'
      );
    }
  });

  it('logs in by email in production only through Resend and over HTTPS links', () => {
    expect(() => loadEnv({ ...PRODUCTION, EMAIL_PROVIDER: 'simulated' })).toThrow(
      'Invalid environment variables: EMAIL_PROVIDER'
    );
    // The email login needs no shared access code.
    expect(loadEnv(PRODUCTION).DEMO_ACCESS_CODE).toBeNull();
    expect(() => loadEnv({ ...PRODUCTION, SITE_URL: 'http://analytics.example.com' })).toThrow(
      'Invalid environment variables: SITE_URL'
    );
  });

  it('applies the login code defaults and validates their limits', () => {
    const env = loadEnv({});

    expect(env.OTP_CODE_DIGITS).toBe(8);
    expect(env.OTP_MAX_ATTEMPTS).toBe(5);
    expect(env.OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(env.OTP_LOCKOUT_STEPS_SECONDS).toEqual([0, 300, 900]);
    expect(env.OTP_MAX_LOCKOUT_SECONDS).toBe(900);
    expect(env.OTP_SENDS_PER_EMAIL_HOUR).toBe(5);
    expect(env.OTP_SENDS_PER_EMAIL_DAY).toBe(10);
    expect(env.OTP_HMAC_SECRET).toBeNull();
    expect(loadEnv({ OTP_LOCKOUT_STEPS_SECONDS: '0, 120,600' }).OTP_LOCKOUT_STEPS_SECONDS).toEqual([
      0, 120, 600
    ]);
    for (const [name, value] of [
      ['OTP_CODE_DIGITS', '6'],
      ['OTP_MAX_LOCKOUT_SECONDS', '901'],
      ['OTP_LOCKOUT_STEPS_SECONDS', '0,abc'],
      ['OTP_LOCKOUT_STEPS_SECONDS', '0,1200']
    ] as const) {
      expect(() => loadEnv({ [name]: value })).toThrow(`Invalid environment variables: ${name}`);
    }
    expect(() => loadEnv({ OTP_SENDS_PER_EMAIL_HOUR: '20' })).toThrow(
      'Invalid environment variables: OTP_SENDS_PER_EMAIL_DAY'
    );
  });

  it('accepts login code keys of 256 bits that differ from each other', () => {
    expect(loadEnv({ OTP_HMAC_SECRET: 'a'.repeat(64) }).OTP_HMAC_SECRET).toBe('a'.repeat(64));
    expect(() => loadEnv({ OTP_HMAC_SECRET: 'a'.repeat(32) })).toThrow(
      'Invalid environment variables: OTP_HMAC_SECRET'
    );
    expect(() =>
      loadEnv({
        OTP_HMAC_SECRET: 'a'.repeat(64),
        OTP_EMAIL_HMAC_SECRET: Buffer.from('a'.repeat(64), 'hex').toString('base64')
      })
    ).toThrow('Invalid environment variables: OTP_EMAIL_HMAC_SECRET');
  });

  it('allows the demo login only with its code and demo accounts', () => {
    const demo = {
      DEMO_LOGIN_ENABLED: 'true',
      DEMO_ACCESS_CODE: 'test-only-access-code-0001',
      DEMO_LOGIN_EMAILS: ' Admin@Demo.Example.com ,viewer@demo.example.com'
    };
    expect(loadEnv(demo).DEMO_LOGIN_EMAILS).toEqual([
      'admin@demo.example.com',
      'viewer@demo.example.com'
    ]);
    expect(() => loadEnv({ ...demo, DEMO_ACCESS_CODE: '' })).toThrow(
      'Invalid environment variables: DEMO_ACCESS_CODE'
    );
    expect(() => loadEnv({ ...demo, DEMO_LOGIN_EMAILS: '' })).toThrow(
      'Invalid environment variables: DEMO_LOGIN_EMAILS'
    );
    // A real mailbox cannot be a demo account.
    expect(() => loadEnv({ ...demo, DEMO_LOGIN_EMAILS: 'someone@example.com' })).toThrow(
      'Invalid environment variables: DEMO_LOGIN_EMAILS'
    );

    expect(loadEnv({ ...PRODUCTION, ...demo }).DEMO_LOGIN_ENABLED).toBe(true);
    // The demo variables without the flag keep the demo login off.
    expect(
      loadEnv({ ...PRODUCTION, ...demo, DEMO_LOGIN_ENABLED: 'false' }).DEMO_LOGIN_ENABLED
    ).toBe(false);
  });

  it('applies the ingestion defaults', () => {
    const env = loadEnv({});

    expect(env.INGEST_SCHEDULER_SA_EMAIL).toBeNull();
    expect(env.INGEST_OIDC_AUDIENCE).toBeNull();
    expect(env.INGEST_DEV_TRIGGER).toBe(false);
    expect(env.INGEST_BATCH_SIZE).toBe(1000);
    expect(env.INGEST_MAX_TRANSACTIONS_PER_RUN).toBe(50_000);
    expect(env.INGEST_REVISIT_HOURS).toBe(72);
    expect(env.INGEST_MAX_RUN_SECONDS).toBe(480);
    expect(env.PRICES_PROVIDER).toBe('none');
    expect(env.PRICES_MAX_CALLS_PER_RUN).toBe(1);
    expect(env.METRICS_REFRESH_SECONDS).toBe(300);
  });

  it('applies the balance snapshot defaults', () => {
    const env = loadEnv({});

    expect(env.BALANCES_PROVIDER).toBe('none');
    expect(env.BALANCES_MAX_CALLS_PER_RUN).toBe(100);
    expect(env.MASTER_WALLETS).toEqual([]);
  });

  it('reads the Polymarket fills only through an HTTPS Polygon endpoint', () => {
    const env = loadEnv({});
    expect(env.POLYMARKET_POLYGON_RPC_URL).toBeNull();
    expect(env.POLYMARKET_MAX_CALLS_PER_RUN).toBe(500);

    const url = 'https://polygon.example/rpc';
    expect(loadEnv({ POLYMARKET_POLYGON_RPC_URL: url }).POLYMARKET_POLYGON_RPC_URL).toBe(url);
    expect(() => loadEnv({ POLYMARKET_POLYGON_RPC_URL: 'http://polygon.example/rpc' })).toThrow(
      'Invalid environment variables: POLYMARKET_POLYGON_RPC_URL'
    );
    expect(() => loadEnv({ POLYMARKET_MAX_CALLS_PER_RUN: '2001' })).toThrow(
      'Invalid environment variables: POLYMARKET_MAX_CALLS_PER_RUN'
    );
  });

  it('accepts public master wallet addresses only, without echoing rejected values', () => {
    const signer = '0x9999999999999999999999999999999999999999';
    const cardano = `addr_test1${'q'.repeat(50)}`;
    const wallets = loadEnv({
      MASTER_WALLETS: JSON.stringify([
        { network: 'base-sepolia', address: signer, role: 'Backend signer' },
        { network: 'cardano-preprod', address: cardano, role: 'Cardano sponsor' }
      ])
    }).MASTER_WALLETS;
    expect(wallets.map((wallet) => wallet.address)).toEqual([signer, cardano]);

    const privateKey = `0x${'ab'.repeat(32)}`;
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access';
    for (const address of [privateKey, seed]) {
      const raw = JSON.stringify([{ network: 'base-sepolia', address, role: 'Signer' }]);
      expect(() => loadEnv({ MASTER_WALLETS: raw })).toThrowError(/MASTER_WALLETS/);
      expect(() => loadEnv({ MASTER_WALLETS: raw })).not.toThrowError(address);
    }
    expect(() => loadEnv({ MASTER_WALLETS: 'not json' })).toThrowError(/MASTER_WALLETS/);
    const extraField = JSON.stringify([
      { network: 'base-sepolia', address: signer, role: 'Signer', privateKey }
    ]);
    expect(() => loadEnv({ MASTER_WALLETS: extraField })).toThrowError(/MASTER_WALLETS/);
  });

  it('requires the scheduler account and its audience together', () => {
    expect(() =>
      loadEnv({ INGEST_SCHEDULER_SA_EMAIL: 'scheduler@p.iam.gserviceaccount.com' })
    ).toThrowError(/INGEST_OIDC_AUDIENCE/);
    expect(
      loadEnv({
        INGEST_SCHEDULER_SA_EMAIL: 'scheduler@p.iam.gserviceaccount.com',
        INGEST_OIDC_AUDIENCE: 'https://api.example'
      }).INGEST_OIDC_AUDIENCE
    ).toBe('https://api.example');
  });

  it('refuses the development ingestion trigger in production', () => {
    expect(loadEnv({ INGEST_DEV_TRIGGER: 'true' }).INGEST_DEV_TRIGGER).toBe(true);
    expect(() => loadEnv({ NODE_ENV: 'production', INGEST_DEV_TRIGGER: 'true' })).toThrowError(
      /INGEST_DEV_TRIGGER/
    );
  });
});
