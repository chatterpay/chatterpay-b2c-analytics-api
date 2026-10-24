import { describe, expect, it } from 'vitest';
import {
  type ConnectAttempt,
  categorizeConnectError,
  connectWithRetry,
  redactUris
} from '../src/store/connect-retry.js';

function selectionError(servers: Record<string, unknown>): Error {
  const error = new Error('Server selection timed out after 10000 ms');
  error.name = 'MongoServerSelectionError';
  Object.assign(error, { reason: { servers: new Map(Object.entries(servers)) } });
  return error;
}

function nodeError(fields: { name?: string; code?: string | number; message: string }): Error {
  return Object.assign(new Error(fields.message), fields);
}

/** Clock and sleep that advance together, so the retries run without real waits. */
function fakeTime(start = 0) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    sleeps
  };
}

describe('connection error categories', () => {
  it.each([
    [nodeError({ name: 'MongoServerError', code: 18, message: 'Authentication failed.' }), 'auth'],
    [
      nodeError({
        name: 'MongoServerError',
        code: 8000,
        message: 'bad auth : authentication failed'
      }),
      'auth'
    ],
    [nodeError({ code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: 'wrong version number' }), 'tls'],
    [
      nodeError({ code: 'ENOTFOUND', message: 'querySrv ENOTFOUND _mongodb._tcp.x.mongodb.net' }),
      'dns'
    ],
    [
      nodeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.1:27017' }),
      'refused'
    ],
    [nodeError({ name: 'MongoNetworkTimeoutError', message: 'connection timed out' }), 'timeout'],
    [new Error('something else'), 'other'],
    ['not an error', 'other']
  ])('classifies %s as %s', (error, category) => {
    expect(categorizeConnectError(error).category).toBe(category);
  });

  it('reports every node of a server selection error and keeps the most specific category', () => {
    const error = selectionError({
      'shard-00-00.example.mongodb.net:27017': {
        error: nodeError({ name: 'MongoNetworkTimeoutError', message: 'connection timed out' })
      },
      'shard-00-01.example.mongodb.net:27017': {
        error: nodeError({ name: 'MongoServerError', code: 18, message: 'Authentication failed.' })
      },
      'shard-00-02.example.mongodb.net:27017': {}
    });

    expect(categorizeConnectError(error)).toEqual({
      category: 'auth',
      hosts: {
        'shard-00-00.example.mongodb.net:27017': 'timeout',
        'shard-00-01.example.mongodb.net:27017': 'auth',
        'shard-00-02.example.mongodb.net:27017': 'timeout'
      }
    });
  });

  it('removes connection strings from messages', () => {
    expect(redactUris('failed mongodb+srv://user:secret@cluster.example.net/?w=majority now')).toBe(
      'failed <uri> now'
    );
  });
});

describe('connection retries', () => {
  it('retries with growing delays until a connection succeeds', async () => {
    const time = fakeTime();
    const attempts: ConnectAttempt[] = [];
    let calls = 0;

    const value = await connectWithRetry({
      database: 'analytics',
      connect: async () => {
        calls += 1;
        time.advance(100);
        if (calls < 3) {
          throw selectionError({ 'node:27017': {} });
        }
        return 'client';
      },
      deadline: 120_000,
      log: (attempt) => attempts.push(attempt),
      now: time.now,
      sleep: time.sleep
    });

    expect(value).toBe('client');
    expect(time.sleeps).toEqual([2000, 4000]);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.outcome, attempt.category])).toEqual(
      [
        [1, 'failed', 'timeout'],
        [2, 'failed', 'timeout'],
        [3, 'connected', undefined]
      ]
    );
    expect(attempts[0]).toMatchObject({
      database: 'analytics',
      durationMs: 100,
      hosts: { 'node:27017': 'timeout' }
    });
  });

  it('stops at the deadline and throws the last error', async () => {
    const time = fakeTime();
    const attempts: ConnectAttempt[] = [];

    await expect(
      connectWithRetry({
        database: 'b2c',
        connect: async () => {
          time.advance(10_000);
          throw selectionError({ 'node:27017': {} });
        },
        deadline: 120_000,
        log: (attempt) => attempts.push(attempt),
        now: time.now,
        sleep: time.sleep
      })
    ).rejects.toThrow('Server selection timed out');

    expect(time.sleeps).toEqual([2000, 4000, 8000, 15_000, 15_000, 15_000]);
    // The last attempt starts before the deadline; none starts after it.
    expect(time.now() - 10_000).toBeLessThan(120_000);
    expect(attempts.every((attempt) => attempt.outcome === 'failed')).toBe(true);
  });

  it('does not retry rejected credentials', async () => {
    const time = fakeTime();
    let calls = 0;

    await expect(
      connectWithRetry({
        database: 'analytics',
        connect: async () => {
          calls += 1;
          throw nodeError({
            name: 'MongoServerError',
            code: 18,
            message: 'Authentication failed.'
          });
        },
        deadline: 120_000,
        log: () => undefined,
        now: time.now,
        sleep: time.sleep
      })
    ).rejects.toThrow('Authentication failed.');

    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });
});
