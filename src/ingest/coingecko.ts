import type { PriceProvider } from './types.js';

/** Public endpoint of the CoinGecko simple price API; it needs no key at low request rates. */
export const COINGECKO_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

/**
 * CoinGecko id per token symbol. Wrapped tokens take the price of the asset they wrap; a symbol
 * absent here is not requested and keeps the swap-implied price.
 */
export const COINGECKO_IDS: Readonly<Record<string, string>> = {
  ETH: 'ethereum',
  WETH: 'ethereum',
  BTC: 'bitcoin',
  WBTC: 'bitcoin',
  ADA: 'cardano',
  POL: 'polygon-ecosystem-token',
  MATIC: 'polygon-ecosystem-token'
};

const TIMEOUT_MS = 10_000;

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * {@link PriceProvider} over the CoinGecko simple price API. One call to `current` sends one
 * request for every known symbol together.
 *
 * @param fetchImpl - Fetch implementation; the global `fetch` by default, replaced by tests.
 * @returns The provider.
 */
export function coingeckoPriceProvider(fetchImpl: Fetch = fetch): PriceProvider {
  return {
    name: 'coingecko',
    async current(symbols) {
      const bySymbol = new Map<string, string>();
      for (const symbol of symbols) {
        const id = COINGECKO_IDS[symbol.toUpperCase()];
        if (id !== undefined) {
          bySymbol.set(symbol, id);
        }
      }
      if (bySymbol.size === 0) {
        return {};
      }
      const ids = [...new Set(bySymbol.values())].sort().join(',');
      const response = await fetchImpl(
        `${COINGECKO_SIMPLE_PRICE_URL}?ids=${encodeURIComponent(ids)}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      );
      if (!response.ok) {
        throw new Error(`CoinGecko answered ${response.status}`);
      }
      const body = (await response.json()) as Record<string, { usd?: unknown } | undefined>;
      const prices: Record<string, number> = {};
      for (const [symbol, id] of bySymbol) {
        const usd = body[id]?.usd;
        if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
          prices[symbol] = usd;
        }
      }
      return prices;
    }
  };
}
