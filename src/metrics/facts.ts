import { allocateInteger } from './allocate.js';
import type { DayHour, TimeWindow } from './calendar.js';
import { dayNumberFromIso, daysTouched } from './calendar.js';
import { DATASET_START_DAY, DATASET_VERSION, type NetworkId, networkProfile } from './catalog.js';
import { seededUnit } from './random.js';

/**
 * Additive activity of one network over a span of time, in integer units.
 *
 * Money is in USD cents per asset; summing two spans is summing their facts. `activeUserDays`
 * adds the daily active users of each day, so it is not a count of distinct users.
 */
export interface Facts {
  newUsers: number;
  activeUserDays: number;
  transfers: number;
  swaps: number;
  /** Transfer volume per asset, cents. */
  transferVolume: Record<string, number>;
  /** Swap volume per asset, cents, counted on the input side only. */
  swapVolume: Record<string, number>;
  transferFees: Record<string, number>;
  swapFees: Record<string, number>;
}

type CountKey = 'newUsers' | 'activeUserDays' | 'transfers' | 'swaps';
type MoneyKey = 'transferVolume' | 'swapVolume' | 'transferFees' | 'swapFees';

const COUNT_KEYS: readonly CountKey[] = ['newUsers', 'activeUserDays', 'transfers', 'swaps'];
const MONEY_KEYS: readonly MoneyKey[] = [
  'transferVolume',
  'swapVolume',
  'transferFees',
  'swapFees'
];

// Share of the daily activity per UTC hour. Peaks in the afternoon and evening of UTC-3.
const HOUR_WEIGHTS: readonly number[] = [
  6, 5, 4, 3, 2, 2, 2, 2, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 6, 6
];
const WEEKEND_FACTOR = 0.78;
// Linear growth: activity reaches twice its initial level GROWTH_DAYS days after the start.
const GROWTH_DAYS = 240;

const START_DAY = dayNumberFromIso(DATASET_START_DAY);
const fullDayCache = new Map<string, Facts>();

/**
 * Facts with every value at zero for the assets of a network.
 *
 * @param network - Network whose assets are listed.
 * @returns Empty facts.
 */
export function emptyFacts(network: NetworkId): Facts {
  const zeros = (): Record<string, number> =>
    Object.fromEntries(networkProfile(network).assets.map((asset) => [asset.symbol, 0]));
  return {
    newUsers: 0,
    activeUserDays: 0,
    transfers: 0,
    swaps: 0,
    transferVolume: zeros(),
    swapVolume: zeros(),
    transferFees: zeros(),
    swapFees: zeros()
  };
}

function noise(network: NetworkId, day: number, key: string): number {
  return 0.85 + 0.3 * seededUnit(`${DATASET_VERSION}:${network}:${day}:${key}`);
}

function generateDay(network: NetworkId, day: number): Facts {
  const profile = networkProfile(network);
  const facts = emptyFacts(network);
  if (day < START_DAY) {
    return facts;
  }

  const weekday = new Date(day * 86_400_000).getUTCDay();
  const level =
    (1 + (day - START_DAY) / GROWTH_DAYS) * (weekday === 0 || weekday === 6 ? WEEKEND_FACTOR : 1);
  const n = (key: string): number => noise(network, day, key);

  facts.activeUserDays = Math.round(profile.activeUsersPerDay * level * n('active'));
  facts.newUsers = Math.round(profile.newUsersPerDay * level * n('new'));
  facts.transfers = Math.round(
    facts.activeUserDays * profile.transfersPerActiveUser * n('transfers')
  );
  facts.swaps = Math.round(facts.activeUserDays * profile.swapsPerActiveUser * n('swaps'));

  const transferVolume =
    facts.transfers * Math.round(profile.averageTransferCents * n('avg-transfer'));
  const swapVolume = facts.swaps * Math.round(profile.averageSwapCents * n('avg-swap'));
  const weights = profile.assets.map((asset) =>
    Math.round(asset.weight * 100 * n(`w:${asset.symbol}`))
  );
  const transferParts = allocateInteger(transferVolume, weights);
  const swapParts = allocateInteger(swapVolume, weights);

  profile.assets.forEach((asset, index) => {
    const transfer = transferParts[index] ?? 0;
    const swap = swapParts[index] ?? 0;
    facts.transferVolume[asset.symbol] = transfer;
    facts.swapVolume[asset.symbol] = swap;
    facts.transferFees[asset.symbol] = Math.floor((transfer * profile.transferFeeBps) / 10_000);
    facts.swapFees[asset.symbol] = Math.floor((swap * profile.swapFeeBps) / 10_000);
  });
  return facts;
}

function fullDay(network: NetworkId, day: number): Facts {
  const key = `${network}:${day}`;
  let facts = fullDayCache.get(key);
  if (facts === undefined) {
    facts = generateDay(network, day);
    fullDayCache.set(key, facts);
  }
  return facts;
}

function hoursOfDay(network: NetworkId, day: number, firstHour: number, lastHour: number): Facts {
  const full = fullDay(network, day);
  if (firstHour === 0 && lastHour === 23) {
    return full;
  }
  const portion = (value: number): number =>
    allocateInteger(value, HOUR_WEIGHTS)
      .slice(firstHour, lastHour + 1)
      .reduce((sum, part) => sum + part, 0);

  const facts = emptyFacts(network);
  for (const key of COUNT_KEYS) {
    facts[key] = portion(full[key]);
  }
  for (const key of MONEY_KEYS) {
    for (const [asset, value] of Object.entries(full[key])) {
      facts[key][asset] = portion(value);
    }
  }
  return facts;
}

/**
 * Adds facts of the same network.
 *
 * @param network - Network of every operand.
 * @param items - Facts to add.
 * @returns The sum; empty facts when `items` is empty.
 */
export function sumFacts(network: NetworkId, items: readonly Facts[]): Facts {
  const total = emptyFacts(network);
  for (const item of items) {
    for (const key of COUNT_KEYS) {
      total[key] += item[key];
    }
    for (const key of MONEY_KEYS) {
      for (const [asset, value] of Object.entries(item[key])) {
        total[key][asset] = (total[key][asset] ?? 0) + value;
      }
    }
  }
  return total;
}

/**
 * Activity of a network inside a window.
 *
 * Partial days take their share of the day through a fixed hourly profile, so the hours of a day
 * always add up to the whole day.
 *
 * @param network - Network to read.
 * @param window - Inclusive span of hours.
 * @returns The facts of the window.
 */
export function factsInWindow(network: NetworkId, window: TimeWindow): Facts {
  const days: Facts[] = [];
  for (let day = window.start.day; day <= window.end.day; day += 1) {
    const firstHour = day === window.start.day ? window.start.hour : 0;
    const lastHour = day === window.end.day ? window.end.hour : 23;
    days.push(hoursOfDay(network, day, firstHour, lastHour));
  }
  return sumFacts(network, days);
}

/**
 * Users that joined a network from the dataset start through `point` (inclusive hour).
 *
 * @param network - Network to read.
 * @param point - Last hour counted.
 * @returns Cumulative new users.
 */
export function totalUsersAt(network: NetworkId, point: DayHour): number {
  if (point.day < START_DAY) {
    return 0;
  }
  return (
    usersBeforeDay(network, point.day) + hoursOfDay(network, point.day, 0, point.hour).newUsers
  );
}

// Prefix sums of new users per network: index i holds the users that joined before START_DAY + i.
const usersBeforeCache = new Map<NetworkId, number[]>();

/**
 * Drops the memoized facts. Called after the network catalog changes, because the profile of a
 * network id may change with it.
 */
export function resetFactsCaches(): void {
  fullDayCache.clear();
  usersBeforeCache.clear();
}

function usersBeforeDay(network: NetworkId, day: number): number {
  let prefix = usersBeforeCache.get(network);
  if (prefix === undefined) {
    prefix = [0];
    usersBeforeCache.set(network, prefix);
  }
  const index = day - START_DAY;
  while (prefix.length <= index) {
    const last = prefix.length - 1;
    prefix.push((prefix[last] ?? 0) + fullDay(network, START_DAY + last).newUsers);
  }
  return prefix[index] ?? 0;
}

/**
 * Distinct active users of a network inside a window, per the synthetic model.
 *
 * Daily active users are added and divided by the average number of active days per user, which
 * grows with the logarithm of the window length; the result never exceeds the users that joined
 * up to the end of the window. A person active on two networks counts once per network.
 *
 * @param network - Network to read.
 * @param window - Inclusive span of hours.
 * @returns Distinct active users.
 */
export function activeUsersInWindow(network: NetworkId, window: TimeWindow): number {
  const activeUserDays = factsInWindow(network, window).activeUserDays;
  const averageActiveDays = 1 + 0.9 * Math.log(daysTouched(window));
  return Math.min(
    Math.round(activeUserDays / averageActiveDays),
    totalUsersAt(network, window.end)
  );
}

/**
 * Users of a monthly cohort still active `monthsAfter` months later, per the synthetic model.
 *
 * Retention decays geometrically with seeded noise and never increases from one month to the next.
 *
 * @param network - Network of the cohort.
 * @param cohortStartDay - First day of the cohort month.
 * @param cohortSize - Users that joined in the cohort month.
 * @param months - Number of later months to compute.
 * @returns Retained users for months 1..`months`.
 */
export function retainedUsers(
  network: NetworkId,
  cohortStartDay: number,
  cohortSize: number,
  months: number
): number[] {
  const retained: number[] = [];
  let previous = cohortSize;
  for (let month = 1; month <= months; month += 1) {
    const rate =
      0.42 *
      0.8 ** (month - 1) *
      (0.9 + 0.2 * seededUnit(`${DATASET_VERSION}:${network}:cohort:${cohortStartDay}:${month}`));
    previous = Math.min(previous, Math.round(cohortSize * rate));
    retained.push(previous);
  }
  return retained;
}

/**
 * Adds the per-asset values of a money record.
 *
 * @param values - Cents per asset.
 * @returns Total cents.
 */
export function sumAssets(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

/**
 * Volume of a span in cents: transfers plus the input side of swaps, so a swap output is never
 * counted again.
 *
 * @param facts - Facts of the span.
 * @returns Volume in cents.
 */
export function volumeCents(facts: Facts): number {
  return sumAssets(facts.transferVolume) + sumAssets(facts.swapVolume);
}

/**
 * Fees of a span in cents.
 *
 * @param facts - Facts of the span.
 * @returns Transfer plus swap fees in cents.
 */
export function feesCents(facts: Facts): number {
  return sumAssets(facts.transferFees) + sumAssets(facts.swapFees);
}
