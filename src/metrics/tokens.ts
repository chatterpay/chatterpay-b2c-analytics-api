import type { TokenInfo } from '../ingest/types.js';
import { listNetworks, type NetworkDefinition, type NetworkId, networkProfile } from './catalog.js';

/**
 * Token of the catalog of one network, with the id its analytics visibility is kept under. The
 * same symbol on two networks is two tokens.
 */
export interface TokenDefinition {
  /** See {@link tokenIdOf}. */
  id: string;
  chainId: string;
  network: NetworkId;
  symbol: string;
  /** Address as the B2C document stores it; empty when it has none. */
  address: string;
  /** Whether the token stands for the native coin of the network. */
  native: boolean;
  stable: boolean;
  /**
   * `enabled` of the B2C document: whether B2C takes new operations in the token. Informative
   * only; `null` when the document has no such field or the copy predates it.
   */
  b2cEnabled: boolean | null;
  /** `false` for a token the B2C database no longer lists, kept for its history. */
  sourcePresent: boolean;
}

/** Pattern of a token id: chain id, then the native key, the address or the symbol. */
export const TOKEN_ID_PATTERN =
  '^[0-9]{1,30}:(native|0x[0-9a-f]{40}|[0-9a-f]{56,120}|symbol:[A-Z0-9._-]{1,32})$';

/** EVM addresses up to this value stand for the native coin in the B2C token list. */
const PLACEHOLDER_ADDRESS_LIMIT = 0xffffn;
/** Address that token lists and routers use for the native coin of an EVM network. */
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** Native placeholders follow the rule the balance snapshot applies to the B2C token list. */
function isNativeAddress(address: string): boolean {
  if (address.startsWith('cardano:')) {
    return true;
  }
  return (
    /^0x[0-9a-fA-F]{40}$/.test(address) &&
    (BigInt(address) <= PLACEHOLDER_ADDRESS_LIMIT || address.toLowerCase() === NATIVE_SENTINEL)
  );
}

/**
 * Stable id of a token: its chain id and its address, so neither a renamed symbol nor the same
 * symbol on another network shares its state. EVM contracts and Cardano asset units (`policyId +
 * assetName`) are in lower case; the native coin of a network (an EVM placeholder up to `0xffff`,
 * the `0xEeee…` sentinel or `cardano:…`) is `native`; a document without a usable address falls
 * back to its symbol in upper case.
 *
 * @param token - Chain id, symbol and address of the token.
 * @returns The id, matching {@link TOKEN_ID_PATTERN}.
 */
export function tokenIdOf(token: Pick<TokenInfo, 'chainId' | 'symbol' | 'address'>): string {
  const address = token.address.trim();
  if (isNativeAddress(address)) {
    return `${token.chainId}:native`;
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(address) || /^[0-9a-fA-F]{56,120}$/.test(address)) {
    return `${token.chainId}:${address.toLowerCase()}`;
  }
  const symbol = token.symbol
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '_')
    .slice(0, 32);
  return `${token.chainId}:symbol:${symbol === '' ? '_' : symbol}`;
}

let loaded: readonly TokenInfo[] | null = null;

/**
 * Replaces the token catalog with the copies of the analytics database. Until it is called, every
 * network lists the assets of its synthetic profile.
 *
 * @param tokens - Token copies, including the ones the B2C database no longer lists; `null` goes
 *   back to the synthetic profiles.
 */
export function setTokens(tokens: readonly TokenInfo[] | null): void {
  loaded = tokens === null ? null : tokens.map((token) => ({ ...token }));
}

/** Synthetic tokens of a network: the assets of its profile, without addresses. */
function syntheticTokens(network: NetworkDefinition): TokenDefinition[] {
  return networkProfile(network.id).assets.map((asset) => ({
    id: tokenIdOf({ chainId: network.chainId, symbol: asset.symbol, address: '' }),
    chainId: network.chainId,
    network: network.id,
    symbol: asset.symbol,
    address: '',
    native: network.family === 'cardano' && asset.symbol === 'ADA',
    stable: /^USD/.test(asset.symbol),
    b2cEnabled: null,
    sourcePresent: true
  }));
}

/**
 * Tokens of the catalog networks, by network in catalog order, the native coin first and then by
 * symbol. Two documents with the same id keep the first one.
 *
 * @param networks - Networks to list; the whole catalog when omitted.
 * @returns The tokens.
 */
export function listTokens(
  networks: readonly NetworkDefinition[] = listNetworks()
): TokenDefinition[] {
  return networks.flatMap((network) => {
    if (loaded === null) {
      return syntheticTokens(network);
    }
    const tokens = new Map<string, TokenDefinition>();
    for (const token of loaded) {
      const id = tokenIdOf(token);
      if (token.chainId !== network.chainId || tokens.has(id)) {
        continue;
      }
      tokens.set(id, {
        id,
        chainId: token.chainId,
        network: network.id,
        symbol: token.symbol,
        address: token.address,
        native: id.endsWith(':native'),
        stable: token.stable,
        b2cEnabled: token.b2cEnabled ?? null,
        sourcePresent: token.sourcePresent ?? true
      });
    }
    return [...tokens.values()].sort(
      (left, right) =>
        Number(right.native) - Number(left.native) || left.symbol.localeCompare(right.symbol)
    );
  });
}

/**
 * Assets the statistics leave out per network under a token policy, as upper-case symbols. The
 * aggregates and snapshots know an asset by network and symbol only, so a symbol is hidden when
 * every token of the network with that symbol (ignoring case) is hidden: operations of two
 * same-symbol tokens of one network cannot be told apart.
 *
 * @param disabledTokenIds - Ids of the hidden tokens.
 * @param networks - Networks the statistics cover.
 * @returns Hidden symbols per network; networks without any are absent.
 */
export function hiddenAssets(
  disabledTokenIds: readonly string[],
  networks: readonly NetworkDefinition[]
): Map<NetworkId, Set<string>> {
  const disabled = new Set(disabledTokenIds);
  const hidden = new Map<NetworkId, Set<string>>();
  if (disabled.size === 0) {
    return hidden;
  }
  const bySymbol = new Map<string, TokenDefinition[]>();
  for (const token of listTokens(networks)) {
    const key = `${token.network}|${token.symbol.toUpperCase()}`;
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), token]);
  }
  for (const tokens of bySymbol.values()) {
    const [first] = tokens;
    if (first !== undefined && tokens.every((token) => disabled.has(token.id))) {
      const symbols = hidden.get(first.network) ?? new Set<string>();
      symbols.add(first.symbol.toUpperCase());
      hidden.set(first.network, symbols);
    }
  }
  return hidden;
}
