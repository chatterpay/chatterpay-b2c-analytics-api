import type { CountryCount, RunSnapshot, SnapshotNetwork } from '../ingest/types.js';
import { periodOf, type TimeWindow } from './calendar.js';
import { listNetworks, type NetworkId, networkProfile } from './catalog.js';
import { addDecimals, shareOf } from './decimal.js';
import { centsToUsd, moneyMetric } from './format.js';
import type { ResolvedRange } from './ranges.js';
import type { SnapshotSource } from './snapshot-source.js';
import { snapshotsFor } from './sources.js';
import type {
  Availability,
  MasterWalletsBlock,
  SnapshotCoverage,
  TokenHolding,
  TopCountriesBlock,
  TopTokensBlock,
  TvlBlock,
  UnavailableReason
} from './types.js';

function firstHour(window: TimeWindow): number {
  return window.start.day * 24 + window.start.hour;
}

function lastHour(window: TimeWindow): number {
  return window.end.day * 24 + window.end.hour;
}

function missingReason(source: SnapshotSource): UnavailableReason {
  return source.lastBalancesStatus() === 'disabled' ? 'snapshots_disabled' : 'no_snapshot';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Whether a network row holds a reading: every or some of its wallets, or none to read. */
function wasRead(row: SnapshotNetwork): boolean {
  return row.status === 'complete' || row.status === 'partial';
}

/**
 * Whether a snapshot holds a reading of any of `networks`. Without one, its sums are not a value
 * of the networks but the absence of one, so the blocks answer `null` instead of zero.
 */
function readsAny(snapshot: RunSnapshot, networks: ReadonlySet<NetworkId>): boolean {
  return (snapshot.balances?.networks ?? []).some(
    (row) => networks.has(row.network) && wasRead(row)
  );
}

/** USD cents of the priced holdings of `networks` in a snapshot. */
function tvlCents(snapshot: RunSnapshot, networks: ReadonlySet<NetworkId>): number {
  return sum(
    (snapshot.balances?.holdings ?? [])
      .filter((holding) => networks.has(holding.network))
      .map((holding) => holding.valueCents ?? 0)
  );
}

/** Wallets read and unpriced assets of `networks` in a snapshot. */
function coverageOf(snapshot: RunSnapshot, networks: ReadonlySet<NetworkId>): SnapshotCoverage {
  const rows = (snapshot.balances?.networks ?? []).filter((row) => networks.has(row.network));
  return {
    wallets: sum(rows.map((row) => row.wallets)),
    walletsRead: sum(rows.map((row) => row.walletsRead)),
    unpricedAssets: (snapshot.balances?.holdings ?? [])
      .filter((holding) => networks.has(holding.network) && holding.valueCents === null)
      .map((holding) => ({ network: holding.network, asset: holding.asset }))
  };
}

/**
 * Availability of the snapshot figures of `networks`: partial when a network is missing from the
 * snapshot or was not read completely, or when an asset had no price.
 */
function snapshotAvailability(
  snapshot: RunSnapshot,
  networks: ReadonlySet<NetworkId>
): { availability: Availability; reason: UnavailableReason | null } {
  const rows = (snapshot.balances?.networks ?? []).filter((row) => networks.has(row.network));
  const incomplete =
    rows.length < networks.size ||
    rows.some((row) => row.status !== 'complete' || row.walletsRead < row.wallets);
  if (incomplete) {
    return { availability: 'partial', reason: 'partial_coverage' };
  }
  if (coverageOf(snapshot, networks).unpricedAssets.length > 0) {
    return { availability: 'partial', reason: 'unpriced_assets' };
  }
  return { availability: 'available', reason: null };
}

function asOfOf(source: SnapshotSource, snapshot: RunSnapshot): string | null {
  return source.kind === 'live' ? snapshot.takenAt.toISOString() : null;
}

/**
 * Builds the TVL block: the USD value of the assets in user wallets, from the last snapshot taken
 * through the end of the range. The comparison value is the last snapshot inside the previous
 * period; each series bucket takes the last snapshot inside it. Without a snapshot the value is
 * `null`: earlier periods are never estimated. A snapshot that read none of the selected networks
 * gives `null` as well (`not_read`): an earlier reading is never served as the current balance.
 *
 * @param networks - Networks of the filter.
 * @param resolved - Range windows and buckets.
 * @returns The block.
 */
export function buildTvl(networks: readonly NetworkId[], resolved: ResolvedRange): TvlBlock {
  const source = snapshotsFor('balances');
  const selected = new Set(networks);
  const kind = source.kind;
  const first = source.firstBalancesAt();
  const current = source.balancesBetween(Number.NEGATIVE_INFINITY, lastHour(resolved.current));
  const series = resolved.buckets.map((bucket) => {
    const found = source.balancesBetween(firstHour(bucket), lastHour(bucket));
    return {
      ...periodOf(bucket),
      tvlUsd:
        found === null || !readsAny(found, selected) ? null : centsToUsd(tvlCents(found, selected)),
      asOf: found === null ? null : found.takenAt.toISOString()
    };
  });
  if (current === null) {
    return {
      source: kind,
      availability: 'unavailable',
      reason: missingReason(source),
      asOf: null,
      value: null,
      firstSnapshotAt: first?.toISOString() ?? null,
      coverage: null,
      series,
      byNetwork: []
    };
  }
  const previousWindow = resolved.previous;
  const previous =
    previousWindow === null
      ? null
      : source.balancesBetween(firstHour(previousWindow), lastHour(previousWindow));
  const total = tvlCents(current, selected);
  const read = readsAny(current, selected);
  return {
    source: kind,
    ...(read
      ? snapshotAvailability(current, selected)
      : { availability: 'unavailable', reason: 'not_read' }),
    asOf: asOfOf(source, current),
    value: read
      ? moneyMetric(
          total,
          previous === null || !readsAny(previous, selected) ? null : tvlCents(previous, selected)
        )
      : null,
    firstSnapshotAt: first?.toISOString() ?? null,
    coverage: coverageOf(current, selected),
    series,
    byNetwork: (current.balances?.networks ?? [])
      .filter((row) => selected.has(row.network))
      .map((row) => {
        const cents = tvlCents(current, new Set([row.network]));
        return {
          network: row.network,
          label: networkProfile(row.network).label,
          tvlUsd: wasRead(row) ? centsToUsd(cents) : null,
          share: wasRead(row) ? shareOf(cents, total) : null,
          status: row.status,
          reason: row.reason ?? null
        };
      })
  };
}

/**
 * Builds the Top Tokens block from the snapshot behind the TVL: each asset summed over the selected
 * networks, by USD value. An asset unpriced on any of them has no value and goes last. A snapshot
 * that read none of the selected networks answers `unavailable` (`not_read`), as the TVL does.
 *
 * @param networks - Networks of the filter.
 * @param resolved - Range windows.
 * @returns The block.
 */
export function buildTopTokens(
  networks: readonly NetworkId[],
  resolved: ResolvedRange
): TopTokensBlock {
  const source = snapshotsFor('balances');
  const selected = new Set(networks);
  const current = source.balancesBetween(Number.NEGATIVE_INFINITY, lastHour(resolved.current));
  if (current === null) {
    return {
      source: source.kind,
      availability: 'unavailable',
      reason: missingReason(source),
      asOf: null,
      items: [],
      totalUsd: null
    };
  }
  if (!readsAny(current, selected)) {
    return {
      source: source.kind,
      availability: 'unavailable',
      reason: 'not_read',
      asOf: asOfOf(source, current),
      items: [],
      totalUsd: null
    };
  }
  const byAsset = new Map<string, { amounts: string[]; cents: number | null }>();
  for (const holding of current.balances?.holdings ?? []) {
    if (!selected.has(holding.network)) {
      continue;
    }
    const entry = byAsset.get(holding.asset) ?? { amounts: [], cents: 0 };
    entry.amounts.push(holding.amount);
    entry.cents =
      entry.cents === null || holding.valueCents === null ? null : entry.cents + holding.valueCents;
    byAsset.set(holding.asset, entry);
  }
  const total = sum([...byAsset.values()].map((entry) => entry.cents ?? 0));
  const items: TokenHolding[] = [...byAsset.entries()]
    .sort(
      ([leftAsset, left], [rightAsset, right]) =>
        (right.cents ?? -1) - (left.cents ?? -1) || leftAsset.localeCompare(rightAsset)
    )
    .map(([asset, entry]) => ({
      asset,
      amount: addDecimals(entry.amounts),
      valueUsd: entry.cents === null ? null : centsToUsd(entry.cents),
      share: entry.cents === null ? null : shareOf(entry.cents, total)
    }));
  return {
    source: source.kind,
    ...snapshotAvailability(current, selected),
    asOf: asOfOf(source, current),
    items,
    totalUsd: centsToUsd(total)
  };
}

/**
 * Users per country of `all` over the visible networks, each user once. With every network of the
 * catalog visible these are the `all` rows of the run. With some hidden they come from the counts
 * per set of networks; a run stored before those were counted only serves a single visible network
 * (its own rows), and `null` otherwise. The synthetic model has no identities, so its networks are
 * added.
 */
function countriesOfAll(
  run: RunSnapshot,
  visible: ReadonlySet<NetworkId>,
  synthetic: boolean
): Array<Pick<CountryCount, 'country' | 'users'>> | null {
  if (listNetworks().every((network) => visible.has(network.id))) {
    return run.countries.filter((row) => row.network === null);
  }
  const byCountry = new Map<string, number>();
  const add = (country: string, users: number): void => {
    byCountry.set(country, (byCountry.get(country) ?? 0) + users);
  };
  if (run.countryCombinations !== undefined) {
    for (const row of run.countryCombinations) {
      if (row.networks.some((network) => visible.has(network))) {
        add(row.country, row.users);
      }
    }
  } else if (synthetic || visible.size === 1) {
    for (const row of run.countries) {
      if (row.network !== null && visible.has(row.network)) {
        add(row.country, row.users);
      }
    }
  } else {
    return null;
  }
  return [...byCountry.entries()].map(([country, users]) => ({ country, users }));
}

/**
 * Builds the Top Countries block from the country counts of the last ingestion run.
 *
 * @param network - `all` or one network id.
 * @param now - Current hour, in hours since 1970-01-01T00:00Z.
 * @param visible - Networks visible in the analytics, which `all` covers; every network of the
 *   catalog when omitted.
 * @returns The block, countries by users descending, `Unknown` last.
 */
export function buildTopCountries(
  network: NetworkId | 'all',
  now: number,
  visible?: readonly NetworkId[]
): TopCountriesBlock {
  const source = snapshotsFor('countries');
  const run = source.latestRun(now);
  const rows =
    run === null
      ? null
      : network === 'all'
        ? countriesOfAll(
            run,
            new Set(visible ?? listNetworks().map((item) => item.id)),
            source.kind === 'mock'
          )
        : run.countries.filter((row) => row.network === network);
  if (run === null || rows === null) {
    return {
      source: source.kind,
      availability: 'unavailable',
      reason: 'no_snapshot',
      asOf: null,
      method: 'phone_prefix',
      items: [],
      totalUsers: 0
    };
  }
  const counted = rows.filter((row) => row.users > 0);
  const total = sum(counted.map((row) => row.users));
  return {
    source: source.kind,
    availability: 'available',
    reason: null,
    asOf: asOfOf(source, run),
    method: 'phone_prefix',
    items: counted
      .sort(
        (left, right) =>
          Number(left.country === 'Unknown') - Number(right.country === 'Unknown') ||
          right.users - left.users ||
          left.country.localeCompare(right.country)
      )
      .map((row) => ({ country: row.country, users: row.users, share: shareOf(row.users, total) })),
    totalUsers: total
  };
}

/**
 * Builds the Master Wallets block: the configured signers of the selected networks with their
 * balances in the last snapshot. Balances are not fees: nothing here is attributed as revenue.
 * When none of the listed wallets was read the block is `unavailable` (`not_read`) and its total
 * `null`; the wallets stay listed with their status.
 *
 * @param networks - Networks of the filter.
 * @param now - Current hour, in hours since 1970-01-01T00:00Z.
 * @returns The block.
 */
export function buildMasterWallets(
  networks: readonly NetworkId[],
  now: number
): MasterWalletsBlock {
  const source = snapshotsFor('balances');
  const selected = new Set(networks);
  const current = source.balancesBetween(Number.NEGATIVE_INFINITY, now);
  if (current === null) {
    return {
      source: source.kind,
      availability: 'unavailable',
      reason: missingReason(source),
      asOf: null,
      items: [],
      totalUsd: null
    };
  }
  const wallets = (current.balances?.masterWallets ?? []).filter((wallet) =>
    selected.has(wallet.network)
  );
  if (wallets.length === 0) {
    return {
      source: source.kind,
      availability: 'unavailable',
      reason: 'not_configured',
      asOf: asOfOf(source, current),
      items: [],
      totalUsd: null
    };
  }
  const valued = wallets.map((wallet) => {
    const read = wallet.status === 'complete';
    const cents = sum(wallet.balances.map((balance) => balance.valueCents ?? 0));
    return { wallet, cents: read ? cents : null };
  });
  const total = sum(valued.map((item) => item.cents ?? 0));
  const unread = wallets.some((wallet) => wallet.status !== 'complete');
  const noneRead = wallets.every((wallet) => wallet.status !== 'complete');
  const unpriced = wallets.some((wallet) =>
    wallet.balances.some((balance) => balance.valueCents === null)
  );
  return {
    source: source.kind,
    availability: noneRead ? 'unavailable' : unread || unpriced ? 'partial' : 'available',
    reason: noneRead
      ? 'not_read'
      : unread
        ? 'partial_coverage'
        : unpriced
          ? 'unpriced_assets'
          : null,
    asOf: asOfOf(source, current),
    items: valued.map(({ wallet, cents }) => ({
      network: wallet.network,
      label: networkProfile(wallet.network).label,
      role: wallet.role,
      address: wallet.address,
      explorerUrl: wallet.explorerUrl,
      status: wallet.status,
      balances: wallet.balances.map((balance) => ({
        asset: balance.asset,
        amount: balance.amount,
        valueUsd: balance.valueCents === null ? null : centsToUsd(balance.valueCents)
      })),
      valueUsd: cents === null ? null : centsToUsd(cents),
      share: cents === null ? null : shareOf(cents, total)
    })),
    totalUsd: noneRead ? null : centsToUsd(total)
  };
}
