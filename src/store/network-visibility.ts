import type { NetworkDefinition } from '../metrics/catalog.js';
import type {
  NetworkVisibility,
  NetworkVisibilityChange,
  NetworkVisibilityResult
} from './types.js';

/** Policy before the first change: every network visible. */
export const INITIAL_VISIBILITY: NetworkVisibility = {
  disabledChainIds: [],
  revision: 0,
  updatedAt: null,
  updatedBy: null
};

/** Decision of {@link planVisibilityChange}: a final answer, or the policy to write. */
export type VisibilityPlan =
  | { kind: 'done'; result: NetworkVisibilityResult }
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
