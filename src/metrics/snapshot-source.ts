import type {
  BalanceSnapshot,
  CountryCount,
  MasterWalletReading,
  RunSnapshot,
  SnapshotHolding,
  SnapshotNetwork
} from '../ingest/types.js';
import { allocateInteger } from './allocate.js';
import { dayNumberFromIso } from './calendar.js';
import { DATASET_START_DAY, DATASET_VERSION, listNetworks, networkProfile } from './catalog.js';
import { fixedAmount } from './decimal.js';
import { totalUsersAt } from './facts.js';
import { seededUnit } from './random.js';
import type { IngestRunStatus } from './types.js';

const HOUR_MS = 3_600_000;

/** Balance and country snapshots the `balances` and `countries` groups read. */
export interface SnapshotSource {
  readonly kind: 'mock' | 'live';
  /**
   * Last snapshot with balances taken inside an inclusive span of hours.
   *
   * @param firstHour - First hour, in hours since 1970-01-01T00:00Z.
   * @param lastHour - Last hour.
   * @returns The snapshot; `null` when none was taken inside the span.
   */
  balancesBetween(firstHour: number, lastHour: number): RunSnapshot | null;
  /** First snapshot with balances; `null` when none was taken. */
  firstBalancesAt(): Date | null;
  /** Last run snapshot taken through `lastHour`, inclusive, with or without balances. */
  latestRun(lastHour: number): RunSnapshot | null;
  /** Balance status of the last run; `null` when unknown. */
  lastBalancesStatus(): IngestRunStatus['sources']['balances'] | null;
}

function hourOf(date: Date): number {
  return Math.floor(date.getTime() / HOUR_MS);
}

/** Last index whose snapshot is at or before `lastHour`; -1 when none. */
function lastAtOrBefore(snapshots: readonly RunSnapshot[], lastHour: number): number {
  let low = 0;
  let high = snapshots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = snapshots[middle];
    if (item !== undefined && hourOf(item.takenAt) <= lastHour) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

/**
 * Snapshot source over the stored run snapshots.
 *
 * @param snapshots - Run snapshots in any order.
 * @param lastBalances - Balance status of the last run.
 * @returns The live source.
 */
export function liveSnapshots(
  snapshots: readonly RunSnapshot[],
  lastBalances: IngestRunStatus['sources']['balances'] | null
): SnapshotSource {
  const runs = [...snapshots].sort(
    (left, right) => left.takenAt.getTime() - right.takenAt.getTime()
  );
  const withBalances = runs.filter((run) => run.balances !== null);
  return {
    kind: 'live',
    balancesBetween(firstHour, lastHour) {
      const found = withBalances[lastAtOrBefore(withBalances, lastHour)];
      return found !== undefined && hourOf(found.takenAt) >= firstHour ? found : null;
    },
    firstBalancesAt: () => withBalances[0]?.takenAt ?? null,
    latestRun: (lastHour) => runs[lastAtOrBefore(runs, lastHour)] ?? null,
    lastBalancesStatus: () => lastBalances
  };
}

/** Live source without snapshots: every snapshot block answers `unavailable`. */
export const EMPTY_LIVE_SNAPSHOTS: SnapshotSource = liveSnapshots([], null);

/** UTC hour of the synthetic daily snapshot. */
const MOCK_SNAPSHOT_HOUR = 3;
const MOCK_START_DAY = dayNumberFromIso(DATASET_START_DAY);
// Same growth as the synthetic activity: twice the initial level after this many days.
const MOCK_GROWTH_DAYS = 240;
/** USD cents held per daily active user of the profile, before growth and noise. */
const MOCK_CENTS_PER_ACTIVE_USER = 60_000;
const MOCK_STABLE = new Set(['USDC', 'USDT', 'USDCx']);
const MOCK_PRICES: Readonly<Record<string, number>> = {
  WETH: 2500,
  ETH: 2500,
  WBTC: 60_000,
  ADA: 0.45
};
/** Synthetic users per country, as weights; `Unknown` stands for numbers without one country. */
const MOCK_COUNTRIES: ReadonlyArray<readonly [string, number]> = [
  ['AR', 38],
  ['MX', 17],
  ['CO', 11],
  ['BR', 9],
  ['ES', 7],
  ['US', 5],
  ['CL', 4],
  ['PE', 3],
  ['Unknown', 6]
];
/** Addresses that cannot belong to a real signer, so a synthetic wallet is never mistaken for one. */
const MOCK_SIGNERS = {
  evm: '0x000000000000000000000000000000000000c0de',
  cardano: 'addr_test1_synthetic_signer'
} as const;

function unit(key: string): number {
  return seededUnit(`${DATASET_VERSION}:snapshot:${key}`);
}

function mockPrice(asset: string, day: number): number | null {
  if (MOCK_STABLE.has(asset)) {
    return 1;
  }
  const base = MOCK_PRICES[asset];
  return base === undefined ? null : base * (0.9 + 0.2 * unit(`price:${asset}:${day}`));
}

function mockBalances(day: number): BalanceSnapshot {
  const growth = 1 + (day - MOCK_START_DAY) / MOCK_GROWTH_DAYS;
  const networks: SnapshotNetwork[] = [];
  const holdings: SnapshotHolding[] = [];
  const masterWallets: MasterWalletReading[] = [];
  for (const { id } of listNetworks()) {
    const profile = networkProfile(id);
    const wallets = Math.round(
      totalUsersAt(id, { day, hour: MOCK_SNAPSHOT_HOUR }) * (1.1 + 0.1 * unit(`w:${id}:${day}`))
    );
    // The synthetic model reads every asset of a wallet, the native coin included.
    networks.push({
      network: id,
      status: 'complete',
      wallets,
      walletsRead: wallets,
      native: 'included'
    });
    const totalCents = Math.round(
      profile.activeUsersPerDay *
        MOCK_CENTS_PER_ACTIVE_USER *
        growth *
        (0.9 + 0.2 * unit(`tvl:${id}:${day}`))
    );
    const parts = allocateInteger(
      totalCents,
      profile.assets.map((asset) => Math.round(asset.weight * 100))
    );
    profile.assets.forEach((asset, index) => {
      const valueCents = parts[index] ?? 0;
      const price = mockPrice(asset.symbol, day) ?? 1;
      holdings.push({
        network: id,
        asset: asset.symbol,
        amount: fixedAmount(valueCents / 100 / price, 6),
        valueCents
      });
    });
    const native = profile.family === 'cardano' ? 'ADA' : 'ETH';
    const nativeAmount =
      native === 'ADA' ? 1200 + 600 * unit(`m:${id}:${day}`) : 0.4 + 0.2 * unit(`m:${id}:${day}`);
    masterWallets.push({
      network: id,
      role: 'Synthetic signer',
      address: MOCK_SIGNERS[profile.family],
      explorerUrl: null,
      status: 'complete',
      balances: [
        {
          asset: native,
          amount: fixedAmount(nativeAmount, 6),
          valueCents: Math.round(nativeAmount * (mockPrice(native, day) ?? 0) * 100)
        }
      ]
    });
  }
  return { networks, holdings, masterWallets };
}

function mockCountries(day: number): CountryCount[] {
  const weights = MOCK_COUNTRIES.map(([, weight]) => weight);
  const rows: CountryCount[] = [];
  let total = 0;
  for (const { id } of listNetworks()) {
    const users = totalUsersAt(id, { day, hour: MOCK_SNAPSHOT_HOUR });
    total += users;
    allocateInteger(users, weights).forEach((count, index) => {
      rows.push({ network: id, country: MOCK_COUNTRIES[index]?.[0] ?? 'Unknown', users: count });
    });
  }
  // The synthetic model has no identities, so the users of every network are added.
  allocateInteger(total, weights).forEach((count, index) => {
    rows.push({ network: null, country: MOCK_COUNTRIES[index]?.[0] ?? 'Unknown', users: count });
  });
  return rows;
}

const mockCache = new Map<string, RunSnapshot>();

function mockRun(day: number): RunSnapshot {
  // The catalog can change at runtime, and the snapshot covers every network of it.
  const key = `${day}|${listNetworks()
    .map((network) => network.id)
    .join(',')}`;
  let run = mockCache.get(key);
  if (run === undefined) {
    run = {
      takenAt: new Date((day * 24 + MOCK_SNAPSHOT_HOUR) * HOUR_MS),
      balances: mockBalances(day),
      countries: mockCountries(day)
    };
    if (mockCache.size > 2000) {
      mockCache.clear();
    }
    mockCache.set(key, run);
  }
  return run;
}

/** Day of the last synthetic snapshot through `lastHour`; `null` before the dataset start. */
function mockDayThrough(lastHour: number): number | null {
  const day = Math.floor((lastHour - MOCK_SNAPSHOT_HOUR) / 24);
  return day < MOCK_START_DAY ? null : day;
}

/**
 * Synthetic snapshots: one per day at 03:00 UTC from the dataset start, every network complete,
 * the master wallets at addresses that cannot be real.
 */
export const MOCK_SNAPSHOTS: SnapshotSource = {
  kind: 'mock',
  balancesBetween(firstHour, lastHour) {
    const day = mockDayThrough(lastHour);
    if (day === null || day * 24 + MOCK_SNAPSHOT_HOUR < firstHour) {
      return null;
    }
    return mockRun(day);
  },
  firstBalancesAt: () => new Date((MOCK_START_DAY * 24 + MOCK_SNAPSHOT_HOUR) * HOUR_MS),
  latestRun(lastHour) {
    const day = mockDayThrough(lastHour);
    return day === null ? null : mockRun(day);
  },
  lastBalancesStatus: () => 'complete'
};
