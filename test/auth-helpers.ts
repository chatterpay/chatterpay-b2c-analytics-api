import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { type CryptoKey, exportPKCS8, generateKeyPair } from 'jose';
import { buildApp } from '../src/app.js';
import { type AppEnv, loadEnv } from '../src/config/env.js';
import { MemoryStore } from '../src/store/memory-store.js';

/** Test-only access code; never a real secret. */
export const ACCESS_CODE = 'test-only-access-code-0001';
export const ADMIN_EMAIL = 'admin@example.com';
export const SECOND_ADMIN_EMAIL = 'second-admin@example.com';
export const VIEWER_EMAIL = 'viewer@example.com';
export const START = new Date('2026-10-24T15:30:00.000Z');

/** Application under test with its store, signing key and controllable clock. */
export interface Harness {
  app: FastifyInstance;
  store: MemoryStore;
  env: AppEnv;
  privateKey: CryptoKey;
  /** Every response seen through {@link Harness.call}, to search for leaked secrets. */
  bodies: string[];
  now(): Date;
  advance(ms: number): void;
  call(options: CallOptions): Promise<LightMyRequestResponse>;
}

/** Request options of {@link Harness.call}. */
export interface CallOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  token?: string;
  payload?: Record<string, unknown>;
  ip?: string;
}

/**
 * Builds an app with a fixed environment, a key generated for the test and an in-memory store.
 *
 * @param overrides - Extra environment values.
 * @returns The harness.
 */
export async function createHarness(overrides: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DEMO_ACCESS_CODE: ACCESS_CODE,
    JWT_PRIVATE_KEY: await exportPKCS8(privateKey),
    JWT_KEY_ID: 'test-key',
    BOOTSTRAP_ADMIN_EMAILS: ` ${ADMIN_EMAIL.toUpperCase()} ,${SECOND_ADMIN_EMAIL}`,
    BOOTSTRAP_VIEWER_EMAILS: VIEWER_EMAIL,
    ...overrides
  });
  let current = START;
  const store = new MemoryStore();
  const app = await buildApp(env, { store, clock: () => current });
  await app.ready();
  const bodies: string[] = [];

  return {
    app,
    store,
    env,
    privateKey,
    bodies,
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    call: async (options) => {
      const headers: Record<string, string> = { 'x-client-ip': options.ip ?? '203.0.113.10' };
      if (options.token !== undefined) {
        headers.authorization = `Bearer ${options.token}`;
      }
      const response = await app.inject({
        method: options.method,
        url: options.url,
        headers,
        ...(options.payload === undefined ? {} : { payload: options.payload })
      });
      bodies.push(response.body);
      return response;
    }
  };
}

/**
 * Opens a challenge for the email.
 *
 * @param harness - App under test.
 * @param email - Email to log in with.
 * @returns The challenge id.
 */
export async function requestCode(harness: Harness, email: string): Promise<string> {
  const response = await harness.call({
    method: 'POST',
    url: '/v1/auth/request-code',
    payload: { email }
  });
  if (response.statusCode !== 202) {
    throw new Error(`request-code answered ${response.statusCode}`);
  }
  return response.json().challengeId;
}

/**
 * Runs the full login flow with the test access code.
 *
 * @param harness - App under test.
 * @param email - Member email.
 * @returns The session token.
 */
export async function login(harness: Harness, email: string): Promise<string> {
  const challengeId = await requestCode(harness, email);
  const response = await harness.call({
    method: 'POST',
    url: '/v1/auth/verify-code',
    payload: { challengeId, email, code: ACCESS_CODE }
  });
  if (response.statusCode !== 200) {
    throw new Error(`verify-code answered ${response.statusCode}`);
  }
  return response.json().token;
}

/**
 * Finds the id of an active member by email through the admin API.
 *
 * @param harness - App under test.
 * @param adminToken - Admin session token.
 * @param email - Member email.
 * @returns The member id.
 */
export async function memberId(
  harness: Harness,
  adminToken: string,
  email: string
): Promise<string> {
  const response = await harness.call({
    method: 'GET',
    url: '/v1/team/members',
    token: adminToken
  });
  const member = (response.json().items as { id: string; email: string }[]).find(
    (item) => item.email === email
  );
  if (member === undefined) {
    throw new Error('member not found');
  }
  return member.id;
}
