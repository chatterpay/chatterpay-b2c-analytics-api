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
});
