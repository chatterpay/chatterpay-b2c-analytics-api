import type {
  DailyPrice,
  HourlyFacts,
  IngestedTransaction,
  IngestedUser,
  LiveAggregates,
  TokenInfo,
  UserActivity,
  UserSignup
} from '../ingest/types.js';
import { addMonths, type DayHour, isoDayOf, type TimeWindow } from './calendar.js';
import type { NetworkId } from './catalog.js';
import type { Facts } from './facts.js';
import { impliedSwapPrices, PriceBook, type StableSwap } from './pricing.js';
import type { MetricsSource } from './sources.js';

const HOUR_MS = 3_600_000;
/** Status of a row that moved funds. Other statuses (`failed`, `submitted`, ...) are not counted. */
const COMPLETED = 'completed';

/** Inputs of {@link aggregateActivity}, all read from the copies in the analytics database. */
export interface AggregationInput {
  transactions: readonly IngestedTransaction[];
  users: readonly IngestedUser[];
  tokens: readonly TokenInfo[];
  /** Network id per chain id; rows of other chains are not counted. */
  chains: ReadonlyMap<string, NetworkId>;
  /** Provider snapshots; swap-implied prices are derived from `transactions`. */
  prices: readonly DailyPrice[];
}

/** Counters of an aggregation. */
export interface AggregationStats {
  transfers: number;
  swaps: number;
  /** Counted operations without a USD price for their token on any day, valued at zero. */
  unpriced: number;
  /** Completed transfers and swaps on chains outside the catalog. */
  outsideCatalog: number;
  users: number;
}

/** Result of {@link aggregateActivity}. */
export interface Aggregation {
  aggregates: LiveAggregates;
  stats: AggregationStats;
}

interface Operation {
  network: NetworkId;
  hour: number;
  user: string;
  kind: 'transfer' | 'swap';
  asset: string;
  stable: boolean;
  amount: number;
  fee: number;
  /** USD value known without a price lookup: the stable leg of a swap. */
  valueUsd: number | null;
  /** USD fee known without a price lookup. */
  feeUsd: number | null;
}

function blankFacts(): Facts {
  return {
    newUsers: 0,
    activeUserDays: 0,
    transfers: 0,
    swaps: 0,
    transferVolume: {},
    swapVolume: {},
    transferFees: {},
    swapFees: {}
  };
}

const MONEY_KEYS = ['transferVolume', 'swapVolume', 'transferFees', 'swapFees'] as const;

function addTo(record: Record<string, number>, key: string, value: number): void {
  record[key] = (record[key] ?? 0) + value;
}

function addFacts(target: Facts, item: Facts): void {
  target.newUsers += item.newUsers;
  target.activeUserDays += item.activeUserDays;
  target.transfers += item.transfers;
  target.swaps += item.swaps;
  for (const key of MONEY_KEYS) {
    for (const [asset, value] of Object.entries(item[key])) {
      addTo(target[key], asset, value);
    }
  }
}

/** First index whose value is at least `value`, in an ascending array. */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? 0) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function hourIndex(date: Date): number {
  return Math.floor(date.getTime() / HOUR_MS);
}

function windowHours(window: TimeWindow): { first: number; last: number } {
  return {
    first: window.start.day * 24 + window.start.hour,
    last: window.end.day * 24 + window.end.hour
  };
}

function activeIn(hours: readonly number[], first: number, last: number): boolean {
  const index = lowerBound(hours, first);
  return index < hours.length && (hours[index] ?? Number.POSITIVE_INFINITY) <= last;
}

type TokenResolver = (chainId: string, raw: string) => { symbol: string; stable: boolean };

function tokenResolver(tokens: readonly TokenInfo[]): TokenResolver {
  const index = new Map<string, { symbol: string; stable: boolean }>();
  for (const token of tokens) {
    index.set(`${token.chainId}|${token.symbol.toUpperCase()}`, {
      symbol: token.symbol,
      stable: token.stable
    });
  }
  // Rows store the symbol as typed at the time (`usdt` and `USDT` both occur), so the lookup
  // ignores case and an unknown token keeps its symbol in upper case.
  return (chainId, raw) =>
    index.get(`${chainId}|${raw.toUpperCase()}`) ?? { symbol: raw.toUpperCase(), stable: false };
}

/**
 * Picks the input leg of a swap: the backend writes one row from the user to the router and one
 * from the router back to the user, so the input is the row whose sender received the other row.
 */
function swapLegs(
  rows: readonly IngestedTransaction[]
): { input: IngestedTransaction; output: IngestedTransaction | null } | null {
  const sorted = [...rows].sort((left, right) => left.date.getTime() - right.date.getTime());
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }
  const input =
    sorted.find((row) =>
      sorted.some((other) => other !== row && other.to.toLowerCase() === row.from.toLowerCase())
    ) ?? first;
  const output = sorted.find((row) => row !== input) ?? null;
  return { input, output };
}

/**
 * Aggregates the ingested B2C rows into hourly facts, user activity and signups.
 *
 * Counted operations are completed `transfer` rows and completed swaps, one per transaction hash
 * and chain however many rows the swap has. A swap is valued and attributed on its input leg; its
 * USD value is the stable leg when either leg is stable. Other tokens are valued with
 * {@link PriceBook}. Money is rounded to cents per operation. The output depends only on the
 * input, so rebuilding the same day gives the same aggregates.
 *
 * @param input - Ingested rows, tokens, chain map and provider prices.
 * @returns The aggregates and the counters of the build.
 */
export function aggregateActivity(input: AggregationInput): Aggregation {
  const resolve = tokenResolver(input.tokens);
  const owners = new Map<string, string>();
  for (const user of input.users) {
    for (const wallet of user.wallets) {
      owners.set(`${wallet.chainId}|${wallet.address.toLowerCase()}`, user.id);
    }
  }
  const userOf = (chainId: string, address: string): string =>
    owners.get(`${chainId}|${address.toLowerCase()}`) ?? `address:${address.toLowerCase()}`;

  const stats: AggregationStats = {
    transfers: 0,
    swaps: 0,
    unpriced: 0,
    outsideCatalog: 0,
    users: input.users.length
  };
  const operations: Operation[] = [];
  const stableSwaps: StableSwap[] = [];
  const swapRows = new Map<string, IngestedTransaction[]>();

  for (const row of input.transactions) {
    if (row.status !== COMPLETED || (row.type !== 'transfer' && row.type !== 'swap')) {
      continue;
    }
    const network = input.chains.get(row.chainId);
    if (network === undefined) {
      stats.outsideCatalog += 1;
      continue;
    }
    if (row.type === 'swap') {
      const key = `${row.chainId}|${row.hash}`;
      const rows = swapRows.get(key) ?? [];
      rows.push(row);
      swapRows.set(key, rows);
      continue;
    }
    const token = resolve(row.chainId, row.token);
    operations.push({
      network,
      hour: hourIndex(row.date),
      user: userOf(row.chainId, row.from),
      kind: 'transfer',
      asset: token.symbol,
      stable: token.stable,
      amount: row.amount,
      fee: row.fee,
      valueUsd: token.stable ? row.amount : null,
      feeUsd: token.stable ? row.fee : null
    });
  }

  for (const rows of swapRows.values()) {
    const legs = swapLegs(rows);
    const network = legs === null ? undefined : input.chains.get(legs.input.chainId);
    if (legs === null || network === undefined) {
      continue;
    }
    const { input: inLeg, output: outLeg } = legs;
    const inToken = resolve(inLeg.chainId, inLeg.token);
    const outToken = outLeg === null ? null : resolve(outLeg.chainId, outLeg.token);
    const day = isoDayOf(Math.floor(hourIndex(inLeg.date) / 24));
    let valueUsd: number | null = null;
    let feeUsd: number | null = null;
    if (inToken.stable) {
      valueUsd = inLeg.amount;
      feeUsd = inLeg.fee;
      if (outLeg !== null && outToken !== null && !outToken.stable) {
        stableSwaps.push({
          day,
          symbol: outToken.symbol,
          amount: outLeg.amount,
          stableAmount: inLeg.amount
        });
      }
    } else if (outLeg !== null && outToken?.stable === true) {
      valueUsd = outLeg.amount;
      // The fee is taken in the input token; the swap itself gives its stable price.
      feeUsd = inLeg.amount > 0 ? (inLeg.fee * outLeg.amount) / inLeg.amount : 0;
      stableSwaps.push({
        day,
        symbol: inToken.symbol,
        amount: inLeg.amount,
        stableAmount: outLeg.amount
      });
    }
    operations.push({
      network,
      hour: hourIndex(inLeg.date),
      user: userOf(inLeg.chainId, inLeg.from),
      kind: 'swap',
      asset: inToken.symbol,
      stable: inToken.stable,
      amount: inLeg.amount,
      fee: inLeg.fee,
      valueUsd,
      feeUsd
    });
  }

  const prices = new PriceBook([...input.prices, ...impliedSwapPrices(stableSwaps)]);
  const hourly = new Map<string, HourlyFacts>();
  const factsAt = (network: NetworkId, hour: number): HourlyFacts => {
    const key = `${network}|${hour}`;
    let facts = hourly.get(key);
    if (facts === undefined) {
      facts = {
        network,
        hour,
        newUsers: 0,
        transfers: 0,
        swaps: 0,
        transferVolume: {},
        swapVolume: {},
        transferFees: {},
        swapFees: {}
      };
      hourly.set(key, facts);
    }
    return facts;
  };
  const activity = new Map<string, { network: NetworkId; user: string; hours: Set<number> }>();

  for (const operation of operations) {
    const known = operation.valueUsd !== null && operation.feeUsd !== null;
    const price =
      operation.stable || known ? 1 : prices.usd(operation.asset, Math.floor(operation.hour / 24));
    if (price === null) {
      stats.unpriced += 1;
    }
    const valueUsd = operation.valueUsd ?? operation.amount * (price ?? 0);
    const feeUsd = operation.feeUsd ?? operation.fee * (price ?? 0);
    const facts = factsAt(operation.network, operation.hour);
    if (operation.kind === 'transfer') {
      stats.transfers += 1;
      facts.transfers += 1;
      addTo(facts.transferVolume, operation.asset, Math.round(valueUsd * 100));
      addTo(facts.transferFees, operation.asset, Math.round(feeUsd * 100));
    } else {
      stats.swaps += 1;
      facts.swaps += 1;
      addTo(facts.swapVolume, operation.asset, Math.round(valueUsd * 100));
      addTo(facts.swapFees, operation.asset, Math.round(feeUsd * 100));
    }
    const key = `${operation.network}|${operation.user}`;
    const entry = activity.get(key) ?? {
      network: operation.network,
      user: operation.user,
      hours: new Set<number>()
    };
    entry.hours.add(operation.hour);
    activity.set(key, entry);
  }

  const signups: UserSignup[] = [];
  for (const user of input.users) {
    const networks = new Set<NetworkId>();
    for (const wallet of user.wallets) {
      const network = input.chains.get(wallet.chainId);
      if (network !== undefined) {
        networks.add(network);
      }
    }
    for (const network of networks) {
      const hour = user.createdAt === null ? null : hourIndex(user.createdAt);
      signups.push({ network, user: user.id, hour });
      if (hour !== null) {
        factsAt(network, hour).newUsers += 1;
      }
    }
  }

  return {
    aggregates: {
      hourly: [...hourly.values()].sort(
        (left, right) => left.network.localeCompare(right.network) || left.hour - right.hour
      ),
      activity: [...activity.values()].map(
        (entry): UserActivity => ({
          network: entry.network,
          user: entry.user,
          hours: [...entry.hours].sort((left, right) => left - right)
        })
      ),
      signups
    },
    stats
  };
}

interface HourlySeries {
  hours: number[];
  facts: Facts[];
}

/** Users with a signup date and their signup hours, in parallel arrays by hour ascending. */
interface Signups {
  users: string[];
  hours: number[];
}

/**
 * Source over stored aggregates.
 *
 * `activeUserDays` stays at zero: distinct users come from {@link LiveSource.activeUsers}.
 */
class LiveSource implements MetricsSource {
  readonly kind = 'live' as const;
  private readonly hourly = new Map<NetworkId, HourlySeries>();
  private readonly activity = new Map<NetworkId, Map<string, number[]>>();
  private readonly signups = new Map<NetworkId, Signups>();
  private readonly undated = new Map<NetworkId, number>();

  constructor(aggregates: LiveAggregates) {
    const hourly = [...aggregates.hourly].sort((left, right) => left.hour - right.hour);
    for (const item of hourly) {
      const series = this.hourly.get(item.network) ?? { hours: [], facts: [] };
      series.hours.push(item.hour);
      series.facts.push({
        newUsers: item.newUsers,
        activeUserDays: 0,
        transfers: item.transfers,
        swaps: item.swaps,
        transferVolume: item.transferVolume,
        swapVolume: item.swapVolume,
        transferFees: item.transferFees,
        swapFees: item.swapFees
      });
      this.hourly.set(item.network, series);
    }
    for (const item of aggregates.activity) {
      const users = this.activity.get(item.network) ?? new Map<string, number[]>();
      users.set(
        item.user,
        [...item.hours].sort((left, right) => left - right)
      );
      this.activity.set(item.network, users);
    }
    const dated = aggregates.signups
      .filter((item): item is UserSignup & { hour: number } => item.hour !== null)
      .sort((left, right) => left.hour - right.hour);
    for (const item of dated) {
      const signups = this.signups.get(item.network) ?? { users: [], hours: [] };
      signups.users.push(item.user);
      signups.hours.push(item.hour);
      this.signups.set(item.network, signups);
    }
    for (const item of aggregates.signups) {
      if (item.hour === null) {
        this.undated.set(item.network, (this.undated.get(item.network) ?? 0) + 1);
      }
    }
  }

  facts(network: NetworkId, window: TimeWindow): Facts {
    const total = blankFacts();
    const series = this.hourly.get(network);
    if (series === undefined) {
      return total;
    }
    const { first, last } = windowHours(window);
    for (let index = lowerBound(series.hours, first); index < series.hours.length; index += 1) {
      if ((series.hours[index] ?? Number.POSITIVE_INFINITY) > last) {
        break;
      }
      const facts = series.facts[index];
      if (facts !== undefined) {
        addFacts(total, facts);
      }
    }
    return total;
  }

  activeUsers(network: NetworkId, window: TimeWindow): number {
    const users = this.activity.get(network);
    if (users === undefined) {
      return 0;
    }
    const { first, last } = windowHours(window);
    let count = 0;
    for (const hours of users.values()) {
      if (activeIn(hours, first, last)) {
        count += 1;
      }
    }
    return count;
  }

  totalUsersAt(network: NetworkId, point: DayHour): number {
    const hours = this.signups.get(network)?.hours ?? [];
    return lowerBound(hours, point.day * 24 + point.hour + 1) + (this.undated.get(network) ?? 0);
  }

  retained(
    network: NetworkId,
    cohortStartDay: number,
    _cohortSize: number,
    months: number
  ): number[] {
    const signups = this.signups.get(network) ?? { users: [], hours: [] };
    const cohort = signups.users.slice(
      lowerBound(signups.hours, cohortStartDay * 24),
      lowerBound(signups.hours, addMonths(cohortStartDay, 1) * 24)
    );
    const users = this.activity.get(network);
    const retained: number[] = [];
    for (let month = 1; month <= months; month += 1) {
      const first = addMonths(cohortStartDay, month) * 24;
      const last = addMonths(cohortStartDay, month + 1) * 24 - 1;
      retained.push(
        cohort.filter((user) => {
          const hours = users?.get(user);
          return hours !== undefined && activeIn(hours, first, last);
        }).length
      );
    }
    return retained;
  }
}

/**
 * Builds the metrics source over stored aggregates.
 *
 * @param aggregates - Aggregates read from the analytics database.
 * @returns The live source.
 */
export function liveSourceFrom(aggregates: LiveAggregates): MetricsSource {
  return new LiveSource(aggregates);
}
