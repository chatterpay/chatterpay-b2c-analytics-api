import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { type CryptoKey, exportPKCS8, generateKeyPair } from 'jose';
import { MongoClient } from 'mongodb';
import { buildApp } from '../src/app.js';
import { type AppEnv, loadEnv } from '../src/config/env.js';
import { SimulatedEmailProvider } from '../src/email/simulated-provider.js';
import type { EmailMessage, EmailProvider } from '../src/email/types.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { createRequiredIndexes } from '../src/store/mongo-schema.js';
import { MongoStore } from '../src/store/mongo-store.js';
import type { Store } from '../src/store/types.js';

/** Test-only demo access code; never a real secret. */
export const ACCESS_CODE = 'test-only-access-code-0001';
/** Test-only login code keys, 256 bits each; never real secrets. */
export const OTP_HMAC_SECRET = 'a'.repeat(64);
export const OTP_EMAIL_HMAC_SECRET = 'b'.repeat(64);
export const ADMIN_EMAIL = 'admin@example.com';
export const SECOND_ADMIN_EMAIL = 'second-admin@example.com';
export const VIEWER_EMAIL = 'viewer@example.com';
export const START = new Date('2026-10-24T15:30:00.000Z');

/** Application under test with its store, signing key and controllable clock. */
export interface Harness {
  app: FastifyInstance;
  store: Store;
  env: AppEnv;
  privateKey: CryptoKey;
  /** Every response seen through {@link Harness.call}, to search for leaked secrets. */
  bodies: string[];
  /** Every message handed to the email provider, each retry included. */
  outbox: EmailMessage[];
  /** Log lines of the app, written only when `LOG_LEVEL` is not `silent`. */
  logs: string[];
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
  /** Extra headers, such as the browser data the BFF forwards. */
  headers?: Record<string, string>;
}

/**
 * MongoDB server for the route suites. When set, each harness runs on its own throwaway database,
 * created with the required indexes and dropped when the app closes.
 */
const MONGO_TEST_URI = process.env.MONGO_TEST_URI ?? '';

async function createStore(): Promise<{ store: Store; dispose: () => Promise<void> }> {
  if (MONGO_TEST_URI === '') {
    return { store: new MemoryStore(), dispose: async () => {} };
  }
  const dbName = `analytics-test-${randomUUID()}`;
  const admin = new MongoClient(MONGO_TEST_URI);
  await admin.connect();
  await createRequiredIndexes(admin.db(dbName));
  const store = await MongoStore.connect({ uri: MONGO_TEST_URI, dbName });
  return {
    store,
    dispose: async () => {
      await store.close();
      await admin.db(dbName).dropDatabase();
      await admin.close();
    }
  };
}

/**
 * Builds an app with a fixed environment, a key generated for the test and a store: in memory, or
 * MongoDB when `MONGO_TEST_URI` is set.
 *
 * @param overrides - Extra environment values.
 * @param emailProvider - Email provider; a simulated one by default. Every message it gets lands in
 *   `outbox`, and retries between its attempts do not wait.
 * @returns The harness.
 */
export async function createHarness(
  overrides: NodeJS.ProcessEnv = {},
  emailProvider?: EmailProvider
): Promise<Harness> {
  const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DEMO_ACCESS_CODE: ACCESS_CODE,
    OTP_HMAC_SECRET,
    OTP_EMAIL_HMAC_SECRET,
    JWT_PRIVATE_KEY: await exportPKCS8(privateKey),
    JWT_KEY_ID: 'test-key',
    // The shortest code life, so the wait before another code is the one minute cooldown and the
    // penalty steps; the tests of the wait until the open code expires set the default life.
    OTP_TTL_SECONDS: '60',
    ...overrides
  });
  let current = START;
  const { store, dispose } = await createStore();
  // Members that an operator would insert in a new database.
  await store.ensureUser(ADMIN_EMAIL, 'admin', START);
  await store.ensureUser(SECOND_ADMIN_EMAIL, 'admin', START);
  await store.ensureUser(VIEWER_EMAIL, 'viewer', START);
  const provider = emailProvider ?? new SimulatedEmailProvider();
  const outbox: EmailMessage[] = [];
  const recording: EmailProvider = {
    name: provider.name,
    send: (message) => {
      outbox.push(message);
      return provider.send(message);
    }
  };
  const logs: string[] = [];
  const app = await buildApp(env, {
    store,
    clock: () => current,
    emailProvider: recording,
    emailSleep: async () => {},
    logStream: { write: (line) => logs.push(line) }
  });
  app.addHook('onClose', dispose);
  await app.ready();
  const bodies: string[] = [];

  return {
    app,
    store,
    env,
    privateKey,
    bodies,
    outbox,
    logs,
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    call: async (options) => {
      const headers: Record<string, string> = {
        'x-client-ip': options.ip ?? '203.0.113.10',
        ...options.headers
      };
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
 * Login code of the last email handed to the provider for the address.
 *
 * @param harness - App under test.
 * @param email - Recipient.
 * @returns The code; `undefined` when no code was sent to the address.
 */
export function sentCode(harness: Harness, email: string): string | undefined {
  const message = harness.outbox.filter((item) => item.to === email).at(-1);
  return message?.text.match(/\b(\d{8,10})\b/)?.[1];
}

/**
 * Runs the full login flow with the code emailed to the member.
 *
 * @param harness - App under test, whose provider accepts the login email.
 * @param email - Member email.
 * @returns The session token.
 */
export async function login(harness: Harness, email: string): Promise<string> {
  const challengeId = await requestCode(harness, email);
  const response = await harness.call({
    method: 'POST',
    url: '/v1/auth/verify-code',
    payload: { challengeId, email, code: sentCode(harness, email) ?? '' }
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
