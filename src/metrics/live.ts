import type {
  DailyPrice,
  HourlyFacts,
  IngestedTransaction,
  IngestedUser,
  LiveAggregates,
  NetworkWallets,
  TokenInfo,
  UserActivity,
  UserSignup,
  WalletObservation
} from '../ingest/types.js';
import { addMonths, type DayHour, isoDayOf, type TimeWindow } from './calendar.js';
import type { NetworkId } from './catalog.js';
import type { Facts } from './facts.js';
import { impliedSwapPrices, PriceBook, type StableSwap } from './pricing.js';
import type { MetricsSource, WalletCoverage } from './sources.js';

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
  /** First ingestion run that saw each wallet; none when omitted. */
  observations?: readonly WalletObservation[];
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
  /** User wallets on networks of the catalog. */
  wallets: number;
  /** Of those, the wallets with a verifiable first appearance. */
  verifiedWallets: number;
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
    newWallets: 0,
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
  target.newWallets += item.newWallets;
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

/** Key of a wallet: chain id and address, the address in lower case unless it is bech32. */
function walletKey(chainId: string, address: string): string {
  return `${chainId}|${address.startsWith('0x') ? address.toLowerCase() : address}`;
}

/**
 * Earliest completed B2C operation per wallet, as sender or recipient, in milliseconds. A swap
 * leg counts too: either leg proves the wallet held or received funds at that instant.
 */
function firstOperations(rows: readonly IngestedTransaction[]): Map<string, number> {
  const first = new Map<string, number>();
  const note = (chainId: string, address: string, at: number): void => {
    if (address === '') {
      return;
    }
    const key = walletKey(chainId, address);
    const known = first.get(key);
    if (known === undefined || at < known) {
      first.set(key, at);
    }
  };
  for (const row of rows) {
    if (row.status !== COMPLETED) {
      continue;
    }
    const at = row.date.getTime();
    note(row.chainId, row.from, at);
    note(row.chainId, row.to, at);
  }
  return first;
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
 * The first verifiable appearance of a user wallet on its network is the earliest of two pieces of
 * evidence: the first completed B2C operation that sent from or paid to it, and the first
 * ingestion run that saw it after an earlier run had not (`bounded` observations). A wallet with
 * neither, such as one present since before the first tracking run and without operations, is not
 * counted as new and lowers the verified coverage.
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
    users: input.users.length,
    wallets: 0,
    verifiedWallets: 0
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
        newWallets: 0,
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

  const operationsByWallet = firstOperations(input.transactions);
  const observed = new Map<string, WalletObservation>();
  for (const observation of input.observations ?? []) {
    observed.set(walletKey(observation.chainId, observation.address), observation);
  }
  const wallets = new Map<NetworkId, NetworkWallets>();
  const seen = new Set<string>();
  for (const user of input.users) {
    for (const wallet of user.wallets) {
      const network = input.chains.get(wallet.chainId);
      const key = walletKey(wallet.chainId, wallet.address);
      if (network === undefined || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const coverage = wallets.get(network) ?? { network, wallets: 0, verified: 0 };
      coverage.wallets += 1;
      wallets.set(network, coverage);
      stats.wallets += 1;
      const observation = observed.get(key);
      const candidates = [
        operationsByWallet.get(key),
        observation?.bounded === true ? observation.firstObservedAt.getTime() : undefined
      ].filter((value): value is number => value !== undefined);
      if (candidates.length === 0) {
        continue;
      }
      coverage.verified += 1;
      stats.verifiedWallets += 1;
      factsAt(network, Math.floor(Math.min(...candidates) / HOUR_MS)).newWallets += 1;
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
      signups,
      wallets: [...wallets.values()].sort((left, right) =>
        left.network.localeCompare(right.network)
      )
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
 * `activeUserDays` stays at zero: distinct users come from {@link LiveSource.activeUsers}. A user
 * with wallets on several networks has a signup and an activity entry on each of them under the
 * same user id; the `*Across` methods count that id once.
 */
class LiveSource implements MetricsSource {
  readonly kind = 'live' as const;
  private readonly hourly = new Map<NetworkId, HourlySeries>();
  private readonly activity = new Map<NetworkId, Map<string, number[]>>();
  private readonly signups = new Map<NetworkId, Signups>();
  /** Users without a signup date, per network; they count in totals from the start. */
  private readonly undated = new Map<NetworkId, string[]>();
  private readonly wallets = new Map<NetworkId, WalletCoverage>();

  /**
   * @param aggregates - Stored aggregates.
   * @param trackingSince - First run that recorded wallet observations.
   */
  constructor(
    aggregates: LiveAggregates,
    private readonly trackingSince: Date | null = null
  ) {
    for (const item of aggregates.wallets ?? []) {
      this.wallets.set(item.network, { wallets: item.wallets, verified: item.verified });
    }
    const hourly = [...aggregates.hourly].sort((left, right) => left.hour - right.hour);
    for (const item of hourly) {
      const series = this.hourly.get(item.network) ?? { hours: [], facts: [] };
      series.hours.push(item.hour);
      series.facts.push({
        newUsers: item.newUsers,
        // Builds stored before wallets were tracked have no such field.
        newWallets: item.newWallets ?? 0,
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
        const users = this.undated.get(item.network) ?? [];
        users.push(item.user);
        this.undated.set(item.network, users);
      }
    }
  }

  /** Users of a network whose signup hour is inside `[first, last]`. */
  private signedUpBetween(network: NetworkId, first: number, last: number): string[] {
    const signups = this.signups.get(network);
    if (signups === undefined) {
      return [];
    }
    return signups.users.slice(
      lowerBound(signups.hours, first),
      lowerBound(signups.hours, last + 1)
    );
  }

  /** Whether a user was active on any of `networks` inside `[first, last]`. */
  private activeOnAny(
    networks: readonly NetworkId[],
    user: string,
    first: number,
    last: number
  ): boolean {
    return networks.some((network) => {
      const hours = this.activity.get(network)?.get(user);
      return hours !== undefined && activeIn(hours, first, last);
    });
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
    return (
      lowerBound(hours, point.day * 24 + point.hour + 1) + (this.undated.get(network)?.length ?? 0)
    );
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

  activeUsersAcross(networks: readonly NetworkId[], window: TimeWindow): number {
    const { first, last } = windowHours(window);
    const active = new Set<string>();
    for (const network of networks) {
      for (const [user, hours] of this.activity.get(network) ?? []) {
        if (activeIn(hours, first, last)) {
          active.add(user);
        }
      }
    }
    return active.size;
  }

  newUsersAcross(networks: readonly NetworkId[], window: TimeWindow): number {
    const { first, last } = windowHours(window);
    return new Set(networks.flatMap((network) => this.signedUpBetween(network, first, last))).size;
  }

  totalUsersAcross(networks: readonly NetworkId[], point: DayHour): number {
    const last = point.day * 24 + point.hour;
    return new Set(
      networks.flatMap((network) => [
        ...this.signedUpBetween(network, Number.NEGATIVE_INFINITY, last),
        ...(this.undated.get(network) ?? [])
      ])
    ).size;
  }

  cohortAcross(
    networks: readonly NetworkId[],
    cohortStartDay: number,
    months: number
  ): { size: number; retained: number[] } {
    const cohort = new Set(
      networks.flatMap((network) =>
        this.signedUpBetween(network, cohortStartDay * 24, addMonths(cohortStartDay, 1) * 24 - 1)
      )
    );
    const retained: number[] = [];
    for (let month = 1; month <= months; month += 1) {
      const first = addMonths(cohortStartDay, month) * 24;
      const last = addMonths(cohortStartDay, month + 1) * 24 - 1;
      let count = 0;
      for (const user of cohort) {
        if (this.activeOnAny(networks, user, first, last)) {
          count += 1;
        }
      }
      retained.push(count);
    }
    return { size: cohort.size, retained };
  }

  walletCoverage(network: NetworkId, _point: DayHour): WalletCoverage {
    return this.wallets.get(network) ?? { wallets: 0, verified: 0 };
  }

  walletsTrackingSince(): Date | null {
    return this.trackingSince;
  }
}

/**
 * Builds the metrics source over stored aggregates.
 *
 * Wallet coverage is the one of the build, the wallets of the user copy at that run, whatever
 * `point` a caller asks for.
 *
 * @param aggregates - Aggregates read from the analytics database.
 * @param trackingSince - First run that recorded wallet observations; `null` when none did.
 * @returns The live source.
 */
export function liveSourceFrom(
  aggregates: LiveAggregates,
  trackingSince: Date | null = null
): MetricsSource {
  return new LiveSource(aggregates, trackingSince);
}
