import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, createHarness, type Harness, login } from './auth-helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER = {
  'x-client-user-agent': CHROME_WINDOWS,
  'x-client-language': 'es-AR,es;q=0.9',
  'x-client-platform': '"Windows"',
  'x-client-mobile': '?0',
  'x-client-brands': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'
};

describe('browser data of the activity log', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.app.close();
  });

  async function activity(token: string) {
    const response = await harness.call({ method: 'GET', url: '/v1/team/activity', token });
    expect(response.statusCode).toBe(200);
    return response.json().items as { action: string; client: Record<string, unknown> | null }[];
  }

  it('records the browser of each event, shows what it is and removes it after 60 days', async () => {
    harness = await createHarness();
    const token = await login(harness, ADMIN_EMAIL);
    const invited = await harness.call({
      method: 'POST',
      url: '/v1/team/invites',
      token,
      ip: '198.51.100.7',
      headers: BROWSER,
      payload: { email: 'new@example.com', role: 'viewer', mutationId: randomUUID() }
    });
    expect(invited.statusCode).toBe(201);

    const events = await activity(token);
    expect(events.find((event) => event.action === 'invite_created')?.client).toEqual({
      ip: '198.51.100.7',
      userAgent: CHROME_WINDOWS,
      language: 'es-AR,es;q=0.9',
      platform: '"Windows"',
      mobile: false,
      brands: BROWSER['x-client-brands'],
      browser: 'Chrome 131',
      os: 'Windows 10/11',
      device: 'desktop',
      expiresAt: new Date(harness.now().getTime() + 60 * DAY_MS).toISOString()
    });
    // The login of the harness forwards only the IP.
    expect(events.find((event) => event.action === 'login')?.client).toMatchObject({
      ip: '203.0.113.10',
      userAgent: null,
      browser: null
    });

    harness.advance(60 * DAY_MS);
    const later = await login(harness, ADMIN_EMAIL);

    const stored = await harness.store.listActivity(10);
    expect(stored.find((event) => event.action === 'invite_created')?.client).toBeNull();
    const shown = await activity(later);
    expect(shown.find((event) => event.action === 'invite_created')?.client).toBeNull();
    // The events stay; only the new login keeps its browser data.
    expect(shown.map((event) => event.action)).toEqual(['login', 'invite_created', 'login']);
    expect(shown[0]?.client).toMatchObject({ ip: '203.0.113.10' });
  });

  it('records no browser data when the request forwards none, and cuts long headers', async () => {
    harness = await createHarness();
    const token = await login(harness, ADMIN_EMAIL);
    await harness.call({
      method: 'POST',
      url: '/v1/team/invites',
      token,
      ip: 'not-an-ip',
      headers: { 'x-client-user-agent': `agent\u0007${'x'.repeat(600)}` },
      payload: { email: 'other@example.com', role: 'viewer', mutationId: randomUUID() }
    });

    const events = await activity(token);
    const client = events.find((event) => event.action === 'invite_created')?.client;
    expect(client?.ip).toBeNull();
    expect(client?.userAgent).toBe(`agent${'x'.repeat(507)}`);
    expect(client?.device).toBeNull();
  });
});
