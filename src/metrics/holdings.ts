import type { CountryCount, RunSnapshot, SnapshotNetwork } from '../ingest/types.js';
import { periodOf, type TimeWindow } from './calendar.js';
import { listNetworks, type NetworkId, networkProfile } from './catalog.js';
import { addDecimals, shareOf } from './decimal.js';
import { centsToUsd, moneyMetric } from './format.js';
import type { ResolvedRange } from './ranges.js';
import type { SnapshotSource } from './snapshot-source.js';
import { snapshotsFor } from './sources.js';
import { type HiddenAssets, NO_HIDDEN_ASSETS, scopedSnapshots } from './token-scope.js';
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

const HOUR_MS = 3_600_000;

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

/**
 * Whether the user wallets of a read network were read without its native coin. A row stored
 * before the coverage was recorded on an EVM network was read without it.
 */
function nativeMissing(row: SnapshotNetwork): boolean {
  if (row.wallets === 0 || !wasRead(row)) {
    return false;
  }
  const family = listNetworks().find((network) => network.id === row.network)?.family;
  return (row.native ?? (family === 'cardano' ? 'included' : 'not_listed')) === 'not_listed';
}

/** Whether `networks` hold assets in a snapshot and none of them has a price. */
function unpricedOnly(snapshot: RunSnapshot, networks: ReadonlySet<NetworkId>): boolean {
  const held = (snapshot.balances?.holdings ?? []).filter((holding) =>
    networks.has(holding.network)
  );
  return held.length > 0 && held.every((holding) => holding.valueCents === null);
}

/** Whether the run valued the snapshot; a run with `USD_VALUATION=none` stores no USD value. */
function isValued(snapshot: RunSnapshot): boolean {
  return snapshot.balances?.valuation !== 'none';
}

/** Wallets read, unpriced assets and networks read without native coin of `networks`. */
function coverageOf(snapshot: RunSnapshot, networks: ReadonlySet<NetworkId>): SnapshotCoverage {
  const rows = (snapshot.balances?.networks ?? []).filter((row) => networks.has(row.network));
  return {
    wallets: sum(rows.map((row) => row.wallets)),
    walletsRead: sum(rows.map((row) => row.walletsRead)),
    unpricedAssets: (snapshot.balances?.holdings ?? [])
      .filter((holding) => networks.has(holding.network) && holding.valueCents === null)
      .map((holding) => ({ network: holding.network, asset: holding.asset })),
    nativeNotCovered: rows.filter(nativeMissing).map((row) => row.network)
  };
}

/**
 * Availability of the snapshot figures of `networks`: unavailable when the run valued nothing
 * (`not_valued`) or no held asset had a price; partial when a network is missing from the
 * snapshot or was not read completely, when the native coin was not read, or when an asset had no
 * price.
 */
function snapshotAvailability(
  snapshot: RunSnapshot,
  networks: ReadonlySet<NetworkId>
): { availability: Availability; reason: UnavailableReason | null } {
  if (!isValued(snapshot)) {
    return { availability: 'unavailable', reason: 'not_valued' };
  }
  if (unpricedOnly(snapshot, networks)) {
    return { availability: 'unavailable', reason: 'unpriced_assets' };
  }
  const rows = (snapshot.balances?.networks ?? []).filter((row) => networks.has(row.network));
  const incomplete =
    rows.length < networks.size ||
    rows.some((row) => row.status !== 'complete' || row.walletsRead < row.wallets);
  if (incomplete) {
    return { availability: 'partial', reason: 'partial_coverage' };
  }
  const coverage = coverageOf(snapshot, networks);
  if (coverage.nativeNotCovered.length > 0) {
    return { availability: 'partial', reason: 'native_not_covered' };
  }
  if (coverage.unpricedAssets.length > 0) {
    return { availability: 'partial', reason: 'unpriced_assets' };
  }
  return { availability: 'available', reason: null };
}

function asOfOf(source: SnapshotSource, snapshot: RunSnapshot): string | null {
  return source.kind === 'live' ? snapshot.takenAt.toISOString() : null;
}

/**
 * Last run that read every user wallet of a network, as stored with the row; for a row stored
 * before it was recorded, the snapshot itself when it read the network in full, else unknown.
 */
function lastSuccessOf(
  source: SnapshotSource,
  snapshot: RunSnapshot,
  row: SnapshotNetwork
): string | null {
  const fallback =
    row.status === 'complete' && (row.reason ?? null) === null ? snapshot.takenAt : null;
  const at = row.lastSuccessAt === undefined ? fallback : row.lastSuccessAt;
  return source.kind === 'live' && at !== null ? at.toISOString() : null;
}

/** Whether a snapshot read every network of `networks` completely and valued all they held. */
function readCompletely(snapshot: RunSnapshot, networks: ReadonlySet<NetworkId>): boolean {
  return (
    readsAny(snapshot, networks) &&
    snapshotAvailability(snapshot, networks).availability === 'available'
  );
}

/**
 * Last snapshot through `lastHourOf` that read `networks` completely, stepping back one snapshot
 * hour at a time; `null` when none did. Only the last snapshot of each hour is considered, as in
 * {@link SnapshotSource.balancesBetween}.
 */
function lastCompleteSnapshot(
  source: SnapshotSource,
  networks: ReadonlySet<NetworkId>,
  lastHourOf: number
): RunSnapshot | null {
  let found = source.balancesBetween(Number.NEGATIVE_INFINITY, lastHourOf);
  while (found !== null && !readCompletely(found, networks)) {
    found = source.balancesBetween(
      Number.NEGATIVE_INFINITY,
      Math.floor(found.takenAt.getTime() / HOUR_MS) - 1
    );
  }
  return found;
}

/**
 * Builds the TVL block: the USD value of the assets in user wallets, from the last snapshot taken
 * through the end of the range. The comparison value is the last snapshot inside the previous
 * period; each series bucket takes the last snapshot inside it. Without a snapshot the value is
 * `null`: earlier periods are never estimated. A snapshot that read none of the selected networks
 * gives `null` as well (`not_read`): an earlier reading is never served as the current balance.
 * So does a run that valued nothing (`not_valued`) or a snapshot whose held assets have no price
 * (`unpriced_assets`). User wallets read without the native coin leave it `partial`
 * (`native_not_covered`), never `available`. A `partial` value is the subtotal of what was read,
 * so it carries no comparison, and neither does a value whose previous snapshot was `partial`.
 * When the block is `not_read`, `lastComplete` is the last earlier snapshot that read every
 * selected network completely, as a dated historical balance; it is never the value. Hidden
 * tokens are left out of every snapshot before anything is added.
 *
 * @param networks - Networks of the filter.
 * @param resolved - Range windows and buckets.
 * @param hidden - Hidden tokens per network.
 * @returns The block.
 */
export function buildTvl(
  networks: readonly NetworkId[],
  resolved: ResolvedRange,
  hidden: HiddenAssets = NO_HIDDEN_ASSETS
): TvlBlock {
  const source = scopedSnapshots(snapshotsFor('balances'), hidden);
  const selected = new Set(networks);
  const kind = source.kind;
  const first = source.firstBalancesAt();
  const current = source.balancesBetween(Number.NEGATIVE_INFINITY, lastHour(resolved.current));
  const series = resolved.buckets.map((bucket) => {
    const found = source.balancesBetween(firstHour(bucket), lastHour(bucket));
    return {
      ...periodOf(bucket),
      // A bucket whose held assets all lack a price has no value, not a value of zero.
      tvlUsd:
        found === null ||
        !readsAny(found, selected) ||
        !isValued(found) ||
        unpricedOnly(found, selected)
          ? null
          : centsToUsd(tvlCents(found, selected)),
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
      byNetwork: [],
      lastComplete: null
    };
  }
  const previousWindow = resolved.previous;
  const previous =
    previousWindow === null
      ? null
      : source.balancesBetween(firstHour(previousWindow), lastHour(previousWindow));
  const total = tvlCents(current, selected);
  const status: { availability: Availability; reason: UnavailableReason | null } = readsAny(
    current,
    selected
  )
    ? snapshotAvailability(current, selected)
    : { availability: 'unavailable', reason: 'not_read' };
  const shown = status.availability !== 'unavailable';
  const previousCents =
    status.availability === 'available' && previous !== null && readCompletely(previous, selected)
      ? tvlCents(previous, selected)
      : null;
  const historical =
    status.reason === 'not_read'
      ? lastCompleteSnapshot(source, selected, lastHour(resolved.current))
      : null;
  return {
    source: kind,
    ...status,
    asOf: asOfOf(source, current),
    value: shown ? moneyMetric(total, previousCents) : null,
    firstSnapshotAt: first?.toISOString() ?? null,
    coverage: coverageOf(current, selected),
    series,
    byNetwork: (current.balances?.networks ?? [])
      .filter((row) => selected.has(row.network))
      .map((row) => {
        const own = new Set([row.network]);
        const cents = tvlCents(current, own);
        // A network whose held assets all lack a price has no value, not a value of zero.
        const priced = isValued(current) && !unpricedOnly(current, own);
        return {
          network: row.network,
          label: networkProfile(row.network).label,
          tvlUsd: wasRead(row) && priced ? centsToUsd(cents) : null,
          share: wasRead(row) && priced && shown ? shareOf(cents, total) : null,
          status: row.status,
          reason: row.reason ?? null,
          lastSuccessAt: lastSuccessOf(source, current, row)
        };
      }),
    lastComplete:
      historical === null
        ? null
        : {
            asOf: historical.takenAt.toISOString(),
            valueUsd: centsToUsd(tvlCents(historical, selected))
          }
  };
}

/**
 * Builds the Top Tokens block from the snapshot behind the TVL: each asset summed over the selected
 * networks, by USD value, with its amount and value on each network. An asset unpriced on any of
 * them has no total value and goes last; its amounts stay. A snapshot that read none of the
 * selected networks answers `unavailable` (`not_read`), as the TVL does. Hidden tokens are left
 * out.
 *
 * @param networks - Networks of the filter.
 * @param resolved - Range windows.
 * @param hidden - Hidden tokens per network.
 * @returns The block.
 */
export function buildTopTokens(
  networks: readonly NetworkId[],
  resolved: ResolvedRange,
  hidden: HiddenAssets = NO_HIDDEN_ASSETS
): TopTokensBlock {
  const source = scopedSnapshots(snapshotsFor('balances'), hidden);
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
  const order = new Map(networks.map((id, index) => [id, index]));
  const byAsset = new Map<
    string,
    { amounts: string[]; cents: number | null; networks: TokenHolding['networks'] }
  >();
  const held = (current.balances?.holdings ?? [])
    .filter((holding) => selected.has(holding.network))
    .sort((left, right) => (order.get(left.network) ?? 0) - (order.get(right.network) ?? 0));
  for (const holding of held) {
    const entry = byAsset.get(holding.asset) ?? { amounts: [], cents: 0, networks: [] };
    entry.amounts.push(holding.amount);
    entry.cents =
      entry.cents === null || holding.valueCents === null ? null : entry.cents + holding.valueCents;
    entry.networks.push({
      network: holding.network,
      amount: holding.amount,
      valueUsd: holding.valueCents === null ? null : centsToUsd(holding.valueCents)
    });
    byAsset.set(holding.asset, entry);
  }
  const total = sum([...byAsset.values()].map((entry) => entry.cents ?? 0));
  const status = snapshotAvailability(current, selected);
  const items: TokenHolding[] = [...byAsset.entries()]
    .sort(
      ([leftAsset, left], [rightAsset, right]) =>
        (right.cents ?? -1) - (left.cents ?? -1) || leftAsset.localeCompare(rightAsset)
    )
    .map(([asset, entry]) => ({
      asset,
      amount: addDecimals(entry.amounts),
      valueUsd: entry.cents === null ? null : centsToUsd(entry.cents),
      share: entry.cents === null ? null : shareOf(entry.cents, total),
      networks: entry.networks
    }));
  // Without any USD value the items keep their amounts and the total is `null`, not zero.
  return {
    source: source.kind,
    ...status,
    asOf: asOfOf(source, current),
    items,
    totalUsd: status.availability === 'unavailable' ? null : centsToUsd(total)
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
 * `null`; the wallets stay listed with their status. Balances of hidden tokens are left out.
 *
 * @param networks - Networks of the filter.
 * @param now - Current hour, in hours since 1970-01-01T00:00Z.
 * @param hidden - Hidden tokens per network.
 * @returns The block.
 */
export function buildMasterWallets(
  networks: readonly NetworkId[],
  now: number,
  hidden: HiddenAssets = NO_HIDDEN_ASSETS
): MasterWalletsBlock {
  const source = scopedSnapshots(snapshotsFor('balances'), hidden);
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
  // The balances of an unvalued run stay listed with their amounts; the USD figures are `null`.
  const notValued = !noneRead && !isValued(current);
  return {
    source: source.kind,
    availability:
      noneRead || notValued ? 'unavailable' : unread || unpriced ? 'partial' : 'available',
    reason: noneRead
      ? 'not_read'
      : notValued
        ? 'not_valued'
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
      valueUsd: cents === null || notValued ? null : centsToUsd(cents),
      share: cents === null || notValued ? null : shareOf(cents, total)
    })),
    totalUsd: noneRead || notValued ? null : centsToUsd(total)
  };
}
