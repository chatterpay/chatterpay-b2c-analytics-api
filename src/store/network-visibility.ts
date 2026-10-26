import type { NetworkDefinition } from '../metrics/catalog.js';
import type {
  NetworkVisibility,
  NetworkVisibilityChange,
  NetworkVisibilityResult,
  TokenVisibilityChange,
  TokenVisibilityResult
} from './types.js';

/** Policy before the first change: every network and token visible. */
export const INITIAL_VISIBILITY: NetworkVisibility = {
  disabledChainIds: [],
  disabledTokenIds: [],
  revision: 0,
  updatedAt: null,
  updatedBy: null
};

/** Decision of {@link planVisibilityChange}: a final answer, or the policy to write. */
export type VisibilityPlan<R = NetworkVisibilityResult> =
  | { kind: 'done'; result: R }
  | { kind: 'write'; next: NetworkVisibility };

/**
 * Checks a visibility change against the current policy: the revision, then the rule that one
 * network of the catalog stays visible. Both stores apply the returned policy with a
 * compare-and-set on `current.revision`, so the checks hold for the state they replace.
 *
 * @param current - Policy read from the store.
 * @param change - Requested change.
 * @param now - Instant of the change.
 * @returns The answer when nothing is written, or the next policy.
 */
export function planVisibilityChange(
  current: NetworkVisibility,
  change: NetworkVisibilityChange,
  now: Date
): VisibilityPlan {
  if (current.revision !== change.expectedRevision) {
    return { kind: 'done', result: { kind: 'conflict', visibility: current } };
  }
  const disabled = new Set(current.disabledChainIds);
  if (disabled.has(change.chainId) !== change.analyticsEnabled) {
    return { kind: 'done', result: { kind: 'ok', visibility: current, changed: false } };
  }
  if (change.analyticsEnabled) {
    disabled.delete(change.chainId);
  } else {
    disabled.add(change.chainId);
  }
  if (!change.catalogChainIds.some((chainId) => !disabled.has(chainId))) {
    return { kind: 'done', result: { kind: 'last_enabled', visibility: current } };
  }
  return {
    kind: 'write',
    next: {
      disabledChainIds: [...disabled].sort(),
      disabledTokenIds: [...current.disabledTokenIds],
      revision: current.revision + 1,
      updatedAt: now,
      updatedBy: change.actorId
    }
  };
}

/**
 * Checks a token visibility change against the current policy. The network ids stay as they are,
 * so a token of a hidden network keeps its own preference until the network is shown again.
 *
 * @param current - Policy read from the store.
 * @param change - Requested change.
 * @param now - Instant of the change.
 * @returns The answer when nothing is written, or the next policy.
 */
export function planTokenVisibilityChange(
  current: NetworkVisibility,
  change: TokenVisibilityChange,
  now: Date
): VisibilityPlan<TokenVisibilityResult> {
  if (current.revision !== change.expectedRevision) {
    return { kind: 'done', result: { kind: 'conflict', visibility: current } };
  }
  const disabled = new Set(current.disabledTokenIds);
  if (disabled.has(change.tokenId) !== change.analyticsEnabled) {
    return { kind: 'done', result: { kind: 'ok', visibility: current, changed: false } };
  }
  if (change.analyticsEnabled) {
    disabled.delete(change.tokenId);
  } else {
    disabled.add(change.tokenId);
  }
  return {
    kind: 'write',
    next: {
      disabledChainIds: [...current.disabledChainIds],
      disabledTokenIds: [...disabled].sort(),
      revision: current.revision + 1,
      updatedAt: now,
      updatedBy: change.actorId
    }
  };
}

/**
 * Networks of a catalog that the analytics show under a policy.
 *
 * @param catalog - Networks of the catalog, in display order.
 * @param visibility - Current policy.
 * @returns The visible networks, in the same order.
 */
export function visibleNetworks(
  catalog: readonly NetworkDefinition[],
  visibility: NetworkVisibility
): NetworkDefinition[] {
  const hidden = new Set(visibility.disabledChainIds);
  return catalog.filter((network) => !hidden.has(network.chainId));
}
