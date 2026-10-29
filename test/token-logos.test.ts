import { describe, expect, it } from 'vitest';
import { refreshLiveMetrics } from '../src/ingest/live-loader.js';
import { runIngestion } from '../src/ingest/run.js';
import {
  collectTokenLogos,
  httpLogoFetcher,
  type LogoFetcher,
  logoUrlOf,
  MAX_LOGO_BYTES
} from '../src/ingest/token-logos.js';
import type { TokenInfo } from '../src/ingest/types.js';
import { setLiveSource, tokenLogos } from '../src/metrics/sources.js';
import { FakeReader, MemoryIngestRepository, TOKENS, transaction } from './ingest-fakes.js';

const NOW = new Date('2026-10-24T03:00:00.000Z');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const USDC_LOGO = 'https://logos.example/usdc.svg';

function token(chainId: string, symbol: string, logoUrl: string | null): TokenInfo {
  return { chainId, symbol, stable: true, address: '', decimals: 6, logoUrl };
}

function answer(body: string | Uint8Array, type: string, status = 200): typeof fetch {
  return async () => new Response(body, { status, headers: { 'content-type': type } });
}

/** Downloader that records its calls and answers a fixed data URI, or `null` for `failing`. */
function recorder(failing: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const fetchLogo: LogoFetcher = async (url) => {
    calls.push(url);
    return failing.has(url) ? null : `data:image/svg+xml;base64,${url.length}`;
  };
  return { calls, fetchLogo };
}

describe('logo URL of a B2C token', () => {
  it('keeps absolute https URLs only', () => {
    expect(logoUrlOf(' https://cryptofonts.com/img/SVG/usdc.svg ')).toBe(
      'https://cryptofonts.com/img/SVG/usdc.svg'
    );
    expect(logoUrlOf('http://cryptofonts.com/img/SVG/usdc.svg')).toBeNull();
    expect(logoUrlOf('/img/usdc.svg')).toBeNull();
    expect(logoUrlOf('')).toBeNull();
    expect(logoUrlOf(undefined)).toBeNull();
    expect(logoUrlOf(42)).toBeNull();
  });
});

describe('logo download', () => {
  it('returns an accepted image as a data URI', async () => {
    const logo = await httpLogoFetcher(answer(SVG, 'image/svg+xml; charset=utf-8'))(USDC_LOGO);
    expect(logo).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
  });

  it('drops answers that are not an accepted image', async () => {
    expect(await httpLogoFetcher(answer('<html></html>', 'text/html'))(USDC_LOGO)).toBeNull();
    expect(await httpLogoFetcher(answer(SVG, 'image/svg+xml', 404))(USDC_LOGO)).toBeNull();
    expect(await httpLogoFetcher(answer('', 'image/png'))(USDC_LOGO)).toBeNull();
    expect(
      await httpLogoFetcher(answer(new Uint8Array(MAX_LOGO_BYTES + 1), 'image/png'))(USDC_LOGO)
    ).toBeNull();
  });

  it('returns null when the request fails', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await httpLogoFetcher(failing)(USDC_LOGO)).toBeNull();
  });
});

describe('token logos of a run', () => {
  it('takes one logo per symbol, from the first chain id with one', async () => {
    const { calls, fetchLogo } = recorder();
    const result = await collectTokenLogos(
      [
        token('84532', 'USDC', 'https://logos.example/usdc-base.svg'),
        token('421614', 'USDC', USDC_LOGO),
        token('421614', 'WETH', null),
        token('84532', 'ADA', 'https://logos.example/ada.svg')
      ],
      [],
      fetchLogo
    );

    expect(result.logos.map(({ symbol, url }) => ({ symbol, url }))).toEqual([
      { symbol: 'ADA', url: 'https://logos.example/ada.svg' },
      { symbol: 'USDC', url: USDC_LOGO }
    ]);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ fetched: 2, failed: 0 });
  });

  it('reuses a stored logo of the same URL and downloads a changed one', async () => {
    const { calls, fetchLogo } = recorder();
    const result = await collectTokenLogos(
      [token('84532', 'USDC', USDC_LOGO), token('84532', 'USDT', 'https://logos.example/usdt.svg')],
      [
        { symbol: 'USDC', url: USDC_LOGO, logo: 'data:image/svg+xml;base64,stored' },
        { symbol: 'USDT', url: 'https://logos.example/old-usdt.svg', logo: 'data:old' }
      ],
      fetchLogo
    );

    expect(calls).toEqual(['https://logos.example/usdt.svg']);
    expect(result.logos[0]?.logo).toBe('data:image/svg+xml;base64,stored');
  });

  it('keeps a failed download without image and stops at the ceiling', async () => {
    const { calls, fetchLogo } = recorder(new Set(['https://logos.example/a.svg']));
    const result = await collectTokenLogos(
      [
        token('1', 'A', 'https://logos.example/a.svg'),
        token('1', 'B', 'https://logos.example/b.svg'),
        token('1', 'C', 'https://logos.example/c.svg')
      ],
      [],
      fetchLogo,
      2
    );

    expect(calls).toHaveLength(2);
    expect(result.logos.map((logo) => logo.logo === null)).toEqual([true, false, true]);
    expect(result).toMatchObject({ fetched: 2, failed: 1 });
  });

  it('stores the logos with the build and serves them once it is loaded', async () => {
    const repository = new MemoryIngestRepository();
    const { calls, fetchLogo } = recorder();
    const reader = new FakeReader(
      [transaction(1)],
      [],
      TOKENS.map((item) =>
        item.symbol === 'USDC' ? { ...item, logoUrl: USDC_LOGO } : { ...item, logoUrl: null }
      )
    );
    const run = () =>
      runIngestion({
        reader,
        repository,
        prices: null,
        balances: null,
        masterWallets: [],
        logos: fetchLogo,
        clock: () => NOW,
        options: {
          batchSize: 10,
          maxTransactionsPerRun: 100,
          revisitHours: 0,
          maxProviderCallsPerRun: 0,
          maxBalanceCallsPerRun: 0,
          maxRunMs: 60_000,
          lockTtlMs: 120_000
        },
        owner: 'test-run'
      });
    try {
      await run();
      await run();
      await refreshLiveMetrics(repository, null);

      // The second run reuses the logo the first one stored.
      expect(calls).toEqual([USDC_LOGO]);
      expect(tokenLogos()).toEqual([
        { symbol: 'USDC', logo: `data:image/svg+xml;base64,${USDC_LOGO.length}` }
      ]);
    } finally {
      setLiveSource(null);
    }
    expect(tokenLogos()).toEqual([]);
  });
});
