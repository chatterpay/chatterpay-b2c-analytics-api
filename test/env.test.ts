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
    expect(env.BOOTSTRAP_ADMIN_EMAILS).toEqual([]);
    expect(env.ALLOW_IN_MEMORY_STORE).toBe(false);
  });

  it('normalizes the bootstrap email lists', () => {
    const env = loadEnv({ BOOTSTRAP_ADMIN_EMAILS: ' One@Example.com,,two@example.com ' });

    expect(env.BOOTSTRAP_ADMIN_EMAILS).toEqual(['one@example.com', 'two@example.com']);
    expect(() => loadEnv({ BOOTSTRAP_VIEWER_EMAILS: 'not-an-email' })).toThrowError(
      /^Invalid environment variables: BOOTSTRAP_VIEWER_EMAILS$/
    );
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
    expect(() => loadEnv({ ALLOW_IN_MEMORY_STORE: 'yes' })).toThrowError(/ALLOW_IN_MEMORY_STORE/);
  });

  it('requires the access code and the signing key in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrowError(
      /^Invalid environment variables: DEMO_ACCESS_CODE, JWT_PRIVATE_KEY$/
    );
  });
});
