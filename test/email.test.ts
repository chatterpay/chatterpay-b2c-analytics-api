import { describe, expect, it } from 'vitest';
import {
  codeMatches,
  codeVerifier,
  decodeKeyMaterial,
  emailKey,
  encodeFields,
  generateLoginCode,
  loadLoginCodeKeys,
  originKey
} from '../src/auth/login-code.js';
import { deliver } from '../src/email/delivery.js';
import { ResendEmailProvider } from '../src/email/resend-provider.js';
import { SimulatedEmailProvider } from '../src/email/simulated-provider.js';
import { renderInviteEmail, renderLoginCodeEmail } from '../src/email/templates.js';
import type { EmailAttempt, EmailMessage, EmailProvider } from '../src/email/types.js';

const MESSAGE: EmailMessage = {
  to: 'invitee@example.com',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
  idempotencyKey: 'invite/1/0',
  tags: [{ name: 'category', value: 'invite' }]
};

const POLICY = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 };

/** Provider that answers the scripted attempts in order. */
function scripted(
  name: EmailProvider['name'],
  attempts: EmailAttempt[]
): EmailProvider & {
  calls: EmailMessage[];
} {
  const calls: EmailMessage[] = [];
  return {
    name,
    calls,
    send: async (message) => {
      calls.push(message);
      const next = attempts.shift();
      if (next === undefined) {
        throw new Error('unexpected attempt');
      }
      return next;
    }
  };
}

const failure = (
  kind: 'rejected' | 'rate_limited' | 'unavailable' | 'network',
  retryAfterMs: number | null = null
): EmailAttempt => ({
  kind: 'failed',
  failure: kind,
  retryable: kind !== 'rejected',
  retryAfterMs
});

/** Fake `fetch` that answers the given responses in order and records the requests. */
function fakeFetch(responses: (Response | Error)[]): typeof fetch & {
  requests: { url: string; init: RequestInit }[];
} {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('unexpected request');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch & { requests: { url: string; init: RequestInit }[] };
  fn.requests = requests;
  return fn;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });

describe('email templates', () => {
  const expiresAt = new Date('2026-11-03T15:30:00.000Z');

  it.each([
    ['en', 'You are invited to ChatterPay Analytics', 'Viewer', 'Sign in'],
    ['es', 'Te invitaron a ChatterPay Analytics', 'Lector', 'Ingresar'],
    ['br', 'Você foi convidado para o ChatterPay Analytics', 'Leitor', 'Entrar']
  ] as const)('renders the %s invitation', (locale, subject, role, action) => {
    const email = renderInviteEmail({
      locale,
      role: 'viewer',
      loginUrl: 'https://analytics.example.com/login',
      expiresAt
    });

    expect(email.subject).toBe(subject);
    expect(email.text).toContain(role);
    expect(email.text).toContain(`${action}: https://analytics.example.com/login`);
    expect(email.text).toContain('2026');
    expect(email.html).toContain('href="https://analytics.example.com/login"');
    expect(email.html).toContain(`lang="${{ en: 'en-US', es: 'es-AR', br: 'pt-BR' }[locale]}"`);
  });

  it.each([
    ['en', '042137 is your ChatterPay Analytics code', '10 minutes'],
    ['es', '042137 es tu código de ChatterPay Analytics', '10 minutos'],
    ['br', '042137 é o seu código do ChatterPay Analytics', '10 minutos']
  ] as const)('renders the %s login code', (locale, subject, minutes) => {
    const email = renderLoginCodeEmail({ locale, code: '042137', expiresInMinutes: 10 });

    expect(email.subject).toBe(subject);
    expect(email.text).toContain('042137');
    expect(email.text).toContain(minutes);
    expect(email.html).toContain('042137');
  });

  it('escapes the values it puts in the HTML', () => {
    const email = renderInviteEmail({
      locale: 'en',
      role: 'admin',
      loginUrl: 'https://example.com/login?a=1&b="<x>"',
      expiresAt
    });

    expect(email.html).toContain(
      'href="https://example.com/login?a=1&amp;b=&quot;&lt;x&gt;&quot;"'
    );
    expect(email.html).not.toContain('"<x>"');
  });
});

const KEYS = loadLoginCodeKeys({
  OTP_HMAC_SECRET: 'a'.repeat(64),
  OTP_EMAIL_HMAC_SECRET: 'b'.repeat(64)
});
const CHALLENGE_ID = '7f1d3c2a-0b4e-4c55-9a77-1d2e3f405162';

/** Challenge fields the verifier reads, as stored for `code`. */
function storedFor(code: string, keys = KEYS, email = 'member@example.com') {
  return {
    id: CHALLENGE_ID,
    keyVersion: keys.codeKeyVersion,
    codeDigest: codeVerifier(keys, CHALLENGE_ID, email, code)
  };
}

describe('login codes', () => {
  it('draws eight digits from the CSPRNG, leading zeros kept', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateLoginCode(8);
      expect(code).toMatch(/^\d{8}$/);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(190);
  });

  it('stores an HMAC verifier from which the code cannot be read back', () => {
    const stored = storedFor('04213799');

    expect(stored.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.codeDigest).not.toContain('04213799');
    expect(JSON.stringify(stored)).not.toContain('04213799');
  });

  it('matches only the code, the challenge and the email it was issued for', () => {
    const stored = storedFor('04213799');
    const email = 'member@example.com';

    expect(codeMatches(KEYS, stored, email, '04213799', 8)).toBe(true);
    expect(codeMatches(KEYS, stored, email, ' 04213799 ', 8)).toBe(true);
    expect(codeMatches(KEYS, stored, email, '04213798', 8)).toBe(false);
    expect(codeMatches(KEYS, stored, 'other@example.com', '04213799', 8)).toBe(false);
    expect(codeMatches(KEYS, { ...stored, id: 'another-challenge' }, email, '04213799', 8)).toBe(
      false
    );
  });

  it('refuses malformed codes and verifiers without throwing', () => {
    const stored = storedFor('04213799');
    const email = 'member@example.com';

    expect(codeMatches(KEYS, stored, email, '0421379', 8)).toBe(false);
    expect(codeMatches(KEYS, stored, email, '0421379a', 8)).toBe(false);
    expect(codeMatches(KEYS, stored, email, `${'9'.repeat(63)}`, 8)).toBe(false);
    expect(codeMatches(KEYS, { ...stored, codeDigest: null }, email, '04213799', 8)).toBe(false);
    expect(codeMatches(KEYS, { ...stored, codeDigest: 'zz' }, email, '04213799', 8)).toBe(false);
    expect(
      codeMatches(KEYS, { ...stored, codeDigest: 'ab'.repeat(20) }, email, '04213799', 8)
    ).toBe(false);
  });

  it('does not verify with another key or another key version', () => {
    const other = loadLoginCodeKeys({
      OTP_HMAC_SECRET: 'c'.repeat(64),
      OTP_EMAIL_HMAC_SECRET: 'b'.repeat(64)
    });
    const stored = storedFor('04213799');

    expect(other.codeKeyVersion).not.toBe(KEYS.codeKeyVersion);
    expect(codeMatches(other, stored, 'member@example.com', '04213799', 8)).toBe(false);
    // The digest of the other key under the version of this one still fails: the key differs.
    expect(
      codeMatches(
        other,
        { ...stored, keyVersion: other.codeKeyVersion },
        'member@example.com',
        '04213799',
        8
      )
    ).toBe(false);
  });

  it('derives the email and IP identifiers from their own key and context', () => {
    const otherIdentity = loadLoginCodeKeys({
      OTP_HMAC_SECRET: 'a'.repeat(64),
      OTP_EMAIL_HMAC_SECRET: 'd'.repeat(64)
    });

    expect(emailKey(KEYS, 'member@example.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(emailKey(KEYS, 'member@example.com')).toBe(emailKey(KEYS, 'member@example.com'));
    expect(emailKey(KEYS, 'member@example.com')).not.toContain('member');
    expect(emailKey(otherIdentity, 'member@example.com')).not.toBe(
      emailKey(KEYS, 'member@example.com')
    );
    expect(originKey(KEYS, '203.0.113.10')).not.toBe(emailKey(KEYS, '203.0.113.10'));
  });

  it('encodes fields with their lengths, so different lists never collide', () => {
    expect(encodeFields(['ab', 'c'])).not.toEqual(encodeFields(['a', 'bc']));
    expect(encodeFields(['a:b'])).not.toEqual(encodeFields(['a', 'b']));
  });

  it('accepts only keys of at least 256 bits in hex or base64', () => {
    expect(decodeKeyMaterial('a'.repeat(64))?.length).toBe(32);
    expect(decodeKeyMaterial(Buffer.alloc(32, 7).toString('base64'))?.length).toBe(32);
    expect(decodeKeyMaterial(Buffer.alloc(32, 7).toString('base64url'))?.length).toBe(32);
    expect(decodeKeyMaterial('a'.repeat(62))).toBeNull();
    expect(decodeKeyMaterial('short')).toBeNull();
    expect(decodeKeyMaterial('not base64 at all!')).toBeNull();
  });

  it('generates keys for the process when the variables are unset', () => {
    const keys = loadLoginCodeKeys({ OTP_HMAC_SECRET: null, OTP_EMAIL_HMAC_SECRET: null });

    expect(keys.ephemeral).toBe(true);
    expect(keys.code.length).toBe(32);
    expect(keys.code.equals(keys.identity)).toBe(false);
    expect(KEYS.ephemeral).toBe(false);
  });
});

describe('delivery with retries', () => {
  it('reports a simulated delivery when the provider sends nothing', async () => {
    const provider = new SimulatedEmailProvider();

    const outcome = await deliver(provider, MESSAGE, POLICY, async () => {});

    expect(outcome).toMatchObject({ state: 'simulated', attempts: 1, failure: null });
    expect(provider.outbox).toEqual([MESSAGE]);
  });

  it('retries network errors, rate limits and server errors with backoff and the same key', async () => {
    const provider = scripted('resend', [
      failure('network'),
      failure('unavailable'),
      { kind: 'sent', messageId: 'msg-1' }
    ]);
    const waits: number[] = [];

    const outcome = await deliver(provider, MESSAGE, POLICY, async (ms) => {
      waits.push(ms);
    });

    expect(outcome).toEqual({ state: 'sent', attempts: 3, messageId: 'msg-1', failure: null });
    expect(waits).toEqual([500, 1000]);
    expect(provider.calls.map((call) => call.idempotencyKey)).toEqual([
      'invite/1/0',
      'invite/1/0',
      'invite/1/0'
    ]);
  });

  it('waits what retry-after asks', async () => {
    const provider = scripted('resend', [
      failure('rate_limited', 2000),
      { kind: 'sent', messageId: 'msg-1' }
    ]);
    const waits: number[] = [];

    await deliver(provider, MESSAGE, POLICY, async (ms) => {
      waits.push(ms);
    });

    expect(waits).toEqual([2000]);
  });

  it('gives up when retry-after is longer than the policy allows', async () => {
    const provider = scripted('resend', [failure('rate_limited', 60_000)]);

    const outcome = await deliver(provider, MESSAGE, POLICY, async () => {});

    expect(outcome).toEqual({
      state: 'failed',
      attempts: 1,
      messageId: null,
      failure: 'rate_limited'
    });
  });

  it('does not retry a rejection', async () => {
    const provider = scripted('resend', [failure('rejected')]);

    const outcome = await deliver(provider, MESSAGE, POLICY, async () => {});

    expect(outcome).toMatchObject({ state: 'failed', attempts: 1, failure: 'rejected' });
  });

  it('stops after the last attempt', async () => {
    const provider = scripted('resend', [
      failure('unavailable'),
      failure('unavailable'),
      failure('unavailable')
    ]);

    const outcome = await deliver(provider, MESSAGE, POLICY, async () => {});

    expect(outcome).toMatchObject({ state: 'failed', attempts: 3, failure: 'unavailable' });
  });
});

describe('Resend provider', () => {
  it('posts the message with the key, the sender and the idempotency key', async () => {
    const fetch = fakeFetch([json(200, { id: 'msg-1' })]);
    const provider = new ResendEmailProvider({
      apiKey: 're_test_only',
      from: 'ChatterPay <no-reply@example.com>',
      fetch
    });

    const attempt = await provider.send(MESSAGE);

    expect(attempt).toEqual({ kind: 'sent', messageId: 'msg-1' });
    const [request] = fetch.requests;
    expect(request?.url).toBe('https://api.resend.com/emails');
    expect(request?.init.method).toBe('POST');
    expect(request?.init.headers).toMatchObject({
      authorization: 'Bearer re_test_only',
      'idempotency-key': 'invite/1/0'
    });
    expect(JSON.parse(String(request?.init.body))).toEqual({
      from: 'ChatterPay <no-reply@example.com>',
      to: ['invitee@example.com'],
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
      tags: [{ name: 'category', value: 'invite' }]
    });
  });

  it.each([
    [
      'a rate limit',
      json(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '2' }),
      'rate_limited',
      true,
      2000
    ],
    ['a server error', json(500, { name: 'internal_server_error' }), 'unavailable', true, null],
    [
      'a key still in use',
      json(409, { name: 'concurrent_idempotent_requests' }),
      'unavailable',
      true,
      null
    ],
    [
      'a key reused with another payload',
      json(409, { name: 'invalid_idempotent_request' }),
      'rejected',
      false,
      null
    ],
    ['an unverified domain', json(403, { name: 'validation_error' }), 'rejected', false, null],
    ['an invalid message', json(422, { name: 'validation_error' }), 'rejected', false, null]
  ] as const)('classifies %s', async (_case, response, kind, retryable, retryAfterMs) => {
    const provider = new ResendEmailProvider({
      apiKey: 're_test_only',
      from: 'no-reply@example.com',
      fetch: fakeFetch([response])
    });

    expect(await provider.send(MESSAGE)).toEqual({
      kind: 'failed',
      failure: kind,
      retryable,
      retryAfterMs
    });
  });

  it('classifies a request that never got an answer as a network failure', async () => {
    const provider = new ResendEmailProvider({
      apiKey: 're_test_only',
      from: 'no-reply@example.com',
      fetch: fakeFetch([new TypeError('fetch failed')])
    });

    expect(await provider.send(MESSAGE)).toEqual({
      kind: 'failed',
      failure: 'network',
      retryable: true,
      retryAfterMs: null
    });
  });
});

describe('simulated provider', () => {
  it('keeps the last hundred messages', async () => {
    const provider = new SimulatedEmailProvider();
    for (let i = 0; i < 105; i += 1) {
      await provider.send({ ...MESSAGE, idempotencyKey: `key-${i}` });
    }

    expect(provider.outbox).toHaveLength(100);
    expect(provider.outbox[0]?.idempotencyKey).toBe('key-5');
  });
});
