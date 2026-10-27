import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

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
    expect(env.CHALLENGE_TTL_MINUTES).toBe(10);
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
    expect(() => loadEnv({ CHALLENGE_TTL_MINUTES: '61' })).toThrowError(/CHALLENGE_TTL_MINUTES/);
  });

  it('requires the access code, the signing key and both MongoDB connections in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrowError(
      /^Invalid environment variables: DEMO_ACCESS_CODE, JWT_PRIVATE_KEY, MONGO_URI, B2C_MONGO_URI$/
    );
  });

  it('keeps the shared access code and the simulated emails by default', () => {
    const env = loadEnv({});

    expect(env.LOGIN_CODE_DELIVERY).toBe('access_code');
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
    const { privateKey } = generateKeyPairSync('ed25519');
    const production = {
      NODE_ENV: 'production',
      JWT_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      MONGO_URI: 'mongodb://127.0.0.1:27017',
      B2C_MONGO_URI: 'mongodb://127.0.0.1:27017/chatterpay-dev',
      LOGIN_CODE_DELIVERY: 'email'
    };
    expect(() => loadEnv(production)).toThrow('Invalid environment variables: EMAIL_PROVIDER');

    const resend = {
      ...production,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_only',
      EMAIL_FROM: 'no-reply@example.com'
    };
    // The email login needs no shared access code.
    expect(
      loadEnv({ ...resend, SITE_URL: 'https://analytics.example.com' }).DEMO_ACCESS_CODE
    ).toBeNull();
    expect(() => loadEnv({ ...resend, SITE_URL: 'http://analytics.example.com' })).toThrow(
      'Invalid environment variables: SITE_URL'
    );
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
