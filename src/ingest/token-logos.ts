import type { TokenInfo, TokenLogo } from './types.js';

/** Image types a logo may have; anything else is dropped. */
const LOGO_TYPES = new Set(['image/svg+xml', 'image/png', 'image/webp', 'image/jpeg', 'image/gif']);

/** Largest logo kept, in bytes: the logos travel inline in the network catalog of every page. */
export const MAX_LOGO_BYTES: number = 64 * 1024;

const LOGO_TIMEOUT_MS = 5000;

/** Ceiling on logo downloads in one run; a logo already stored for the same URL is not fetched. */
export const MAX_LOGO_FETCHES_PER_RUN: number = 20;

/**
 * Download of one logo: the image as a `data:` URI, or `null` when it could not be read or is not
 * an accepted image.
 */
export type LogoFetcher = (url: string) => Promise<string | null>;

/**
 * Logo URL of a B2C `tokens` document: only absolute `https` URLs, since the site embeds the image
 * and never loads a plain-HTTP or relative address.
 *
 * @param value - Raw `logo` field.
 * @returns The URL, or `null`.
 */
export function logoUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Logo fetcher over `fetch`. A logo is kept when the answer is 2xx, its type is one of
 * {@link LOGO_TYPES} and its body is at most {@link MAX_LOGO_BYTES}. The image goes to the site as a
 * `data:` URI inside an `<img>`, where an SVG runs no script.
 *
 * @param fetcher - `fetch` implementation.
 * @returns The fetcher.
 */
export function httpLogoFetcher(fetcher: typeof fetch): LogoFetcher {
  return async (url) => {
    try {
      const response = await fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(LOGO_TIMEOUT_MS)
      });
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (!response.ok || type === undefined || !LOGO_TYPES.has(type)) {
        return null;
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0 || body.length > MAX_LOGO_BYTES) {
        return null;
      }
      return `data:${type};base64,${body.toString('base64')}`;
    } catch {
      return null;
    }
  };
}

/** Logos of a run and the downloads it made. */
export interface TokenLogoResult {
  logos: TokenLogo[];
  fetched: number;
  failed: number;
}

/**
 * Logo of each token symbol, from the `logo` of the B2C token list. A symbol listed on several
 * networks takes the URL of its first token with one, by chain id. A logo stored for the same URL
 * is reused; the others are downloaded, at most `maxFetches` per run. A failed download stays
 * without image and is tried again in the next run.
 *
 * @param tokens - B2C token list of the run.
 * @param previous - Logos stored by the previous run.
 * @param fetchLogo - Downloader; `null` keeps the stored logos and downloads nothing.
 * @param maxFetches - Ceiling on downloads.
 * @returns The logos by symbol, ascending, with the download counts.
 */
export async function collectTokenLogos(
  tokens: readonly TokenInfo[],
  previous: readonly TokenLogo[],
  fetchLogo: LogoFetcher | null,
  maxFetches: number = MAX_LOGO_FETCHES_PER_RUN
): Promise<TokenLogoResult> {
  const urls = new Map<string, string>();
  for (const token of [...tokens].sort((a, b) => a.chainId.localeCompare(b.chainId))) {
    const url = token.logoUrl ?? null;
    if (url !== null && !urls.has(token.symbol)) {
      urls.set(token.symbol, url);
    }
  }
  const stored = new Map(previous.map((logo) => [logo.url, logo.logo]));
  const logos: TokenLogo[] = [];
  let fetched = 0;
  let failed = 0;
  for (const [symbol, url] of [...urls].sort(([a], [b]) => a.localeCompare(b))) {
    let logo = stored.get(url) ?? null;
    if (logo === null && fetchLogo !== null && fetched < maxFetches) {
      fetched += 1;
      logo = await fetchLogo(url);
      if (logo === null) {
        failed += 1;
      }
    }
    logos.push({ symbol, url, logo });
  }
  return { logos, fetched, failed };
}
