import type { RunSnapshot } from '../ingest/types.js';
import type { TimeWindow } from './calendar.js';
import type { NetworkId } from './catalog.js';
import type { Facts } from './facts.js';
import type { SnapshotSource } from './snapshot-source.js';
import type { MetricsSource } from './sources.js';
import type { TokenScope } from './types.js';

/** Assets the statistics leave out, per network, as upper-case symbols. */
export type HiddenAssets = ReadonlyMap<NetworkId, ReadonlySet<string>>;

/** Policy without hidden tokens. */
export const NO_HIDDEN_ASSETS: HiddenAssets = new Map();

function isHidden(hidden: ReadonlySet<string> | undefined, asset: string): boolean {
  return hidden?.has(asset.toUpperCase()) ?? false;
}

function keep(
  record: Readonly<Record<string, number>>,
  hidden: ReadonlySet<string>
): Record<string, number> {
  return Object.fromEntries(Object.entries(record).filter(([asset]) => !isHidden(hidden, asset)));
}

function removed(
  record: Readonly<Record<string, number>> | undefined,
  hidden: ReadonlySet<string>
) {
  return Object.entries(record ?? {}).reduce(
    (sum, [asset, value]) => sum + (isHidden(hidden, asset) ? value : 0),
    0
  );
}

/**
 * Facts of a network without its hidden assets: their money entries and unpriced operations are
 * dropped, and their operations leave `transfers` and `swaps` when the facts count operations per
 * asset. Without those counts the operation totals stay as they are.
 *
 * @param facts - Facts of one network.
 * @param hidden - Hidden symbols of that network.
 * @returns The scoped facts; `facts` itself when nothing of the network is hidden.
 */
export function scopeFacts(facts: Facts, hidden: ReadonlySet<string> | undefined): Facts {
  if (hidden === undefined || hidden.size === 0) {
    return facts;
  }
  const scoped: Facts = {
    ...facts,
    transfers: facts.transfers - removed(facts.transfersByAsset, hidden),
    swaps: facts.swaps - removed(facts.swapsByAsset, hidden),
    transferVolume: keep(facts.transferVolume, hidden),
    swapVolume: keep(facts.swapVolume, hidden),
    transferFees: keep(facts.transferFees, hidden),
    swapFees: keep(facts.swapFees, hidden),
    unpriced: {
      transferVolume: keep(facts.unpriced.transferVolume, hidden),
      swapVolume: keep(facts.unpriced.swapVolume, hidden),
      transferFees: keep(facts.unpriced.transferFees, hidden),
      swapFees: keep(facts.unpriced.swapFees, hidden)
    }
  };
  if (facts.transfersByAsset !== undefined) {
    scoped.transfersByAsset = keep(facts.transfersByAsset, hidden);
  }
  if (facts.swapsByAsset !== undefined) {
    scoped.swapsByAsset = keep(facts.swapsByAsset, hidden);
  }
  if (facts.deposits !== undefined) {
    scoped.deposits = {
      volume: keep(facts.deposits.volume, hidden),
      unpriced: keep(facts.deposits.unpriced, hidden),
      count: keep(facts.deposits.count, hidden)
    };
  }
  return scoped;
}

/**
 * Activity of a source under a token policy.
 *
 * @param source - Source of the `activity` group.
 * @param hidden - Hidden assets per network.
 * @returns A reader of the scoped facts of a network inside a window.
 */
export function scopedActivity(
  source: MetricsSource,
  hidden: HiddenAssets
): (network: NetworkId, window: TimeWindow) => Facts {
  return (network, window) => scopeFacts(source.facts(network, window), hidden.get(network));
}

/**
 * Run snapshot without the holdings and master wallet balances of hidden assets. Network rows,
 * wallet counts and countries stay: they have no token.
 *
 * @param run - Run snapshot.
 * @param hidden - Hidden assets per network.
 * @returns The scoped snapshot; `run` itself when nothing is hidden.
 */
export function scopeSnapshot(run: RunSnapshot, hidden: HiddenAssets): RunSnapshot {
  if (hidden.size === 0 || run.balances === null) {
    return run;
  }
  const balances = run.balances;
  return {
    ...run,
    balances: {
      ...balances,
      holdings: balances.holdings.filter(
        (holding) => !isHidden(hidden.get(holding.network), holding.asset)
      ),
      masterWallets: balances.masterWallets.map((wallet) => ({
        ...wallet,
        balances: wallet.balances.filter(
          (balance) => !isHidden(hidden.get(wallet.network), balance.asset)
        )
      }))
    }
  };
}

/**
 * Snapshot source whose snapshots leave out hidden assets (see {@link scopeSnapshot}).
 *
 * @param source - Snapshot source.
 * @param hidden - Hidden assets per network.
 * @returns The scoped source; `source` itself when nothing is hidden.
 */
export function scopedSnapshots(source: SnapshotSource, hidden: HiddenAssets): SnapshotSource {
  if (hidden.size === 0) {
    return source;
  }
  const scoped = new WeakMap<RunSnapshot, RunSnapshot>();
  const scope = (run: RunSnapshot | null): RunSnapshot | null => {
    if (run === null) {
      return null;
    }
    let found = scoped.get(run);
    if (found === undefined) {
      found = scopeSnapshot(run, hidden);
      scoped.set(run, found);
    }
    return found;
  };
  return {
    kind: source.kind,
    balancesBetween: (first, last) => scope(source.balancesBetween(first, last)),
    firstBalancesAt: () => source.firstBalancesAt(),
    latestRun: (last) => scope(source.latestRun(last)),
    lastBalancesStatus: () => source.lastBalancesStatus()
  };
}

/**
 * `meta.tokenScope` of a response.
 *
 * @param networks - Networks the response covers.
 * @param hidden - Hidden assets per network.
 * @param activity - Source of the `activity` group, which says whether it counts per asset.
 * @returns The scope, hidden tokens by network in the order of `networks` and then by symbol.
 */
export function tokenScopeOf(
  networks: readonly NetworkId[],
  hidden: HiddenAssets,
  activity: MetricsSource
): TokenScope {
  const rows = networks.flatMap((network) =>
    [...(hidden.get(network) ?? [])].sort().map((asset) => ({ network, asset }))
  );
  return {
    hidden: rows,
    operationCounts: rows.length === 0 || activity.countsByAsset() ? 'filtered' : 'unfiltered'
  };
}
