import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Principal } from '../src/auth/principal.js';
import { loadEnv } from '../src/config/env.js';
import { DEFAULT_NETWORKS, listNetworks, setNetworks } from '../src/metrics/catalog.js';
import { resetFactsCaches } from '../src/metrics/facts.js';
import { buildOverview } from '../src/metrics/overview.js';
import { databaseFromUri, networkSlug, toNetworkDefinitions } from '../src/store/b2c-networks.js';

const NOW = new Date('2026-10-24T15:30:00.000Z');
const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

async function viewer(): Promise<Principal> {
  return { userId: 'user-test-0001', role: 'viewer' };
}

afterEach(() => {
  setNetworks(DEFAULT_NETWORKS);
  resetFactsCaches();
});

describe('B2C connection string', () => {
  it.each([
    [
      'mongodb+srv://user:p%40ss@cluster.example.net/chatterpay-dev?retryWrites=true',
      'chatterpay-dev'
    ],
    ['mongodb://h1:27017,h2:27017/chatterpay?replicaSet=rs0', 'chatterpay'],
    ['mongodb://127.0.0.1:27017/chatterpay-dev', 'chatterpay-dev'],
    ['mongodb+srv://user:pass@cluster.example.net/?retryWrites=true', null],
    ['mongodb://127.0.0.1:27017', null]
  ])('reads the database of %s', (uri, database) => {
    expect(databaseFromUri(uri)).toBe(database);
  });
});

describe('B2C blockchains mapping', () => {
  it.each([
    ['Base Sepolia', 'base-sepolia'],
    ['Cardano', 'cardano'],
    ['  Arbitrum One ', 'arbitrum-one'],
    ['Señal Testnet', 'senal-testnet']
  ])('slugs %j as %s', (name, slug) => {
    expect(networkSlug(name)).toBe(slug);
  });

  it('maps documents to networks sorted by name, with evm as the default family', () => {
    const definitions = toNetworkDefinitions([
      {
        name: 'Cardano Preprod',
        family: 'cardano',
        chainId: 900000000001,
        enabled: true,
        explorer: 'https://preprod.cardanoscan.io/transaction/'
      },
      { name: 'Base Sepolia', family: 'evm', chainId: 84532, explorer: 'http://basescan.test' },
      { name: 'Arbitrum Sepolia', chainId: 421614, enabled: false }
    ]);

    expect(definitions).toEqual([
      {
        id: 'arbitrum-sepolia',
        label: 'Arbitrum Sepolia',
        family: 'evm',
        chainId: '421614',
        b2cEnabled: false,
        sourcePresent: true,
        explorer: null
      },
      {
        id: 'base-sepolia',
        label: 'Base Sepolia',
        family: 'evm',
        chainId: '84532',
        b2cEnabled: null,
        sourcePresent: true,
        explorer: null
      },
      {
        id: 'cardano-preprod',
        label: 'Cardano Preprod',
        family: 'cardano',
        chainId: '900000000001',
        b2cEnabled: true,
        sourcePresent: true,
        explorer: 'https://preprod.cardanoscan.io'
      }
    ]);
  });

  it('skips unknown families, unusable names or chain ids and repeated slugs or chain ids', () => {
    const definitions = toNetworkDefinitions([
      { name: 'Bitcoin Testnet4', family: 'bitcoin', chainId: 1 },
      { name: 42, chainId: 2 },
      { name: '***', chainId: 3 },
      { name: 'All', chainId: 4 },
      { name: 'No Chain' },
      { name: 'Base', chainId: 8453 },
      { name: 'base', chainId: 8454 },
      { name: 'Base Again', chainId: 8453 }
    ]);

    expect(definitions.map((network) => [network.id, network.chainId])).toEqual([['base', '8453']]);
  });
});

describe('network catalog', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(env, { authenticate: viewer, clock: () => NOW });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the networks of the environment', async () => {
    setNetworks(
      toNetworkDefinitions([
        { name: 'Base', chainId: 8453 },
        { name: 'Cardano', family: 'cardano', chainId: 764824073 }
      ])
    );

    const response = await app.inject({ method: 'GET', url: '/v1/metrics/networks' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      networks: [
        { id: 'base', label: 'Base', family: 'evm' },
        { id: 'cardano', label: 'Cardano', family: 'cardano' }
      ]
    });
  });

  it('serves the metrics of every network of the catalog and rejects the others', async () => {
    setNetworks(
      toNetworkDefinitions([
        { name: 'Arbitrum Sepolia', chainId: 421614 },
        { name: 'Base Sepolia', chainId: 84532 }
      ])
    );

    const known = await app.inject({
      method: 'GET',
      url: '/v1/metrics/overview?network=arbitrum-sepolia'
    });
    const removed = await app.inject({
      method: 'GET',
      url: '/v1/metrics/overview?network=cardano-preprod'
    });

    expect(known.statusCode).toBe(200);
    expect(known.json().byNetwork).toMatchObject([
      { network: 'arbitrum-sepolia', label: 'Arbitrum Sepolia' }
    ]);
    expect(removed.statusCode).toBe(400);
    expect(removed.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('gives networks of the same family different activity', () => {
    setNetworks(
      toNetworkDefinitions([
        { name: 'Arbitrum Sepolia', chainId: 421614 },
        { name: 'Base Sepolia', chainId: 84532 }
      ])
    );

    const [first, second] = buildOverview('all', 'month', NOW).byNetwork;

    expect(first?.network).toBe('arbitrum-sepolia');
    expect(second?.network).toBe('base-sepolia');
    expect(first?.activeUsers).not.toBe(second?.activeUsers);
  });

  it('refuses an empty catalog and keeps the previous one', () => {
    expect(() => setNetworks([])).toThrow();
    expect(listNetworks()).toEqual(DEFAULT_NETWORKS);
  });
});
