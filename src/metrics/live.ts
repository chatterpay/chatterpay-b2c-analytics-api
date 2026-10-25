import type {
  DailyPrice,
  HourlyFacts,
  IngestedTransaction,
  IngestedUser,
  LiveAggregates,
  NetworkWallets,
  TokenInfo,
  UnpricedOperations,
  UserActivity,
  UserSignup,
  WalletObservation
} from '../ingest/types.js';
import { addMonths, type DayHour, isoDayOf, type TimeWindow } from './calendar.js';
import type { NetworkId } from './catalog.js';
import { emptyUnpriced, type Facts, MONEY_KEYS } from './facts.js';
import { impliedSwapPrices, PriceBook, type StableSwap } from './pricing.js';
import type { MetricsSource, WalletCoverage } from './sources.js';
import type { UsdValuation } from './types.js';

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
  /** `none` leaves every amount and fee other than zero without a USD value; `market` by default. */
  valuation?: UsdValuation;
}

/** Counters of an aggregation. */
export interface AggregationStats {
  transfers: number;
  swaps: number;
  /** Counted operations whose amount has no USD value; left out of the volume, not taken as zero. */
  unpriced: number;
  /** Counted operations whose fee, other than zero, has no USD value; left out of the fees. */
  unpricedFees: number;
  /**
   * Swaps with a completed row that do not prove a complete operation (a single leg, a leg not
   * completed, legs that do not mirror each other, extra legs or a row without hash); not counted.
   */
  unverifiedSwaps: number;
  /** Completed transfers and swaps on chains outside the catalog. */
  outsideCatalog: number;
  users: number;
  /** Users with a wallet on a catalog network and without `creationDate`. */
  undatedUsers: number;
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

/** Hour of a build: its unpriced operations are always recorded. */
type BuiltHour = HourlyFacts & { unpriced: UnpricedOperations };

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
    swapFees: {},
    unpriced: emptyUnpriced()
  };
}

function addTo(record: Record<string, number>, key: string, value: number): void {
  record[key] = (record[key] ?? 0) + value;
}

function addRecord(target: Record<string, number>, item: Readonly<Record<string, number>>): void {
  for (const [asset, value] of Object.entries(item)) {
    addTo(target, asset, value);
  }
}

function addFacts(target: Facts, item: Facts): void {
  target.newUsers += item.newUsers;
  target.newWallets += item.newWallets;
  target.activeUserDays += item.activeUserDays;
  target.transfers += item.transfers;
  target.swaps += item.swaps;
  for (const key of MONEY_KEYS) {
    addRecord(target[key], item[key]);
    addRecord(target.unpriced[key], item.unpriced[key]);
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

/** Earlier row first: by date, then by B2C id, so the order of the copies never matters. */
function byDateThenId(left: IngestedTransaction, right: IngestedTransaction): number {
  return left.date.getTime() - right.date.getTime() || left.id.localeCompare(right.id);
}

/** A swap whose two legs prove the complete operation. */
interface CompleteSwap {
  input: IngestedTransaction;
  output: IngestedTransaction;
}

/** One leg of a swap: its earliest row, completed when any copy of the leg is. */
interface SwapLeg {
  row: IngestedTransaction;
  completed: boolean;
}

/**
 * Legs of the rows of one swap group. Rows with the same direction, token and amount are one leg
 * written more than once (a retransmission), never two legs.
 */
function legsOf(rows: readonly IngestedTransaction[]): SwapLeg[] {
  const legs = new Map<string, SwapLeg>();
  for (const row of [...rows].sort(byDateThenId)) {
    const key = [row.from.toLowerCase(), row.to.toLowerCase(), row.token.toUpperCase(), row.amount]
      .map(String)
      .join('|');
    const leg = legs.get(key);
    const completed = row.status === COMPLETED;
    if (leg === undefined || (completed && !leg.completed)) {
      legs.set(key, { row, completed });
    }
  }
  return [...legs.values()];
}

/** Whether two legs go in opposite directions between the same two distinct addresses. */
function mirrored(left: SwapLeg, right: SwapLeg): boolean {
  const from = left.row.from.toLowerCase();
  const to = left.row.to.toLowerCase();
  return from !== to && from === right.row.to.toLowerCase() && to === right.row.from.toLowerCase();
}

/**
 * Pairs the swap rows of the catalog chains into complete swaps.
 *
 * The backend writes a swap as two rows with the transaction hash of the chain: one from the
 * user's wallet to the router and one from the router back to the wallet. B2C rows carry no
 * operation id, so rows are grouped by chain id, hash and the unordered pair of addresses; two
 * swaps sharing a transaction (several wallets in one bundle) stay apart. A group proves a complete
 * swap only with exactly two legs that mirror each other, both completed. The input is the leg
 * sent by a known user wallet, or the earlier one when that does not decide it. Any other group
 * with a completed row (a single leg, a leg not completed yet, extra legs, a row without hash) is
 * unverified: it is left out of every count, never read as a transfer or as half a swap. Groups
 * without a completed row are failed or pending swaps and count nowhere, as failed transfers do.
 *
 * @param rows - Swap rows of catalog chains, of any status.
 * @param isUserWallet - Whether an address is a wallet of a known user on a chain.
 * @returns The complete swaps and how many groups were unverified.
 */
function pairSwaps(
  rows: readonly IngestedTransaction[],
  isUserWallet: (chainId: string, address: string) => boolean
): { swaps: CompleteSwap[]; unverified: number } {
  const groups = new Map<string, IngestedTransaction[]>();
  for (const row of rows) {
    const pair = [row.from.toLowerCase(), row.to.toLowerCase()].sort().join('|');
    // Without a hash nothing ties a row to its other leg.
    const key =
      row.hash === '' ? `${row.chainId}||${row.id}` : `${row.chainId}|${row.hash}|${pair}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const swaps: CompleteSwap[] = [];
  let unverified = 0;
  for (const group of groups.values()) {
    if (!group.some((row) => row.status === COMPLETED)) {
      continue;
    }
    const legs = legsOf(group);
    const [left, right] = legs;
    if (
      legs.length !== 2 ||
      left === undefined ||
      right === undefined ||
      !mirrored(left, right) ||
      !left.completed ||
      !right.completed
    ) {
      unverified += 1;
      continue;
    }
    const leftUser = isUserWallet(left.row.chainId, left.row.from);
    const rightUser = isUserWallet(right.row.chainId, right.row.from);
    const leftIsInput = leftUser === rightUser ? byDateThenId(left.row, right.row) <= 0 : leftUser;
    swaps.push(
      leftIsInput ? { input: left.row, output: right.row } : { input: right.row, output: left.row }
    );
  }
  return { swaps, unverified };
}

function byNetworkThenUser(
  left: { network: string; user: string },
  right: { network: string; user: string }
): number {
  return left.network.localeCompare(right.network) || left.user.localeCompare(right.user);
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
 * Counted operations are completed `transfer` rows and complete swaps (see {@link pairSwaps}),
 * one per swap however many rows it has. A swap is valued and attributed on its input leg; its
 * USD value is the stable leg when either leg is stable. Other tokens are valued with
 * {@link PriceBook}. An amount, or a fee other than zero, without a USD value is left out of the
 * money figures and counted per asset in `unpriced`, never taken as zero; with `valuation: none`
 * nothing is valued. Money is rounded to cents per operation. The output depends only on the input
 * and not on the order of its rows, so rebuilding the same copies gives the same aggregates.
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
  const valued = (input.valuation ?? 'market') === 'market';

  const stats: AggregationStats = {
    transfers: 0,
    swaps: 0,
    unpriced: 0,
    unpricedFees: 0,
    unverifiedSwaps: 0,
    outsideCatalog: 0,
    users: input.users.length,
    undatedUsers: 0,
    wallets: 0,
    verifiedWallets: 0
  };
  const operations: Operation[] = [];
  const stableSwaps: StableSwap[] = [];
  const swapRows: IngestedTransaction[] = [];
  // The copies come in any order; walking them by B2C id makes every sum and list of the build
  // independent of it.
  const rows = [...input.transactions].sort((left, right) => left.id.localeCompare(right.id));

  for (const row of rows) {
    if (row.type !== 'transfer' && row.type !== 'swap') {
      continue;
    }
    const network = input.chains.get(row.chainId);
    if (network === undefined) {
      stats.outsideCatalog += row.status === COMPLETED ? 1 : 0;
      continue;
    }
    // Swap rows of every status are paired, so a leg not completed yet keeps its swap unverified.
    if (row.type === 'swap') {
      swapRows.push(row);
      continue;
    }
    if (row.status !== COMPLETED) {
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
      valueUsd: valued && token.stable ? row.amount : null,
      feeUsd: valued && token.stable ? row.fee : null
    });
  }

  const paired = pairSwaps(swapRows, (chainId, address) =>
    owners.has(`${chainId}|${address.toLowerCase()}`)
  );
  stats.unverifiedSwaps = paired.unverified;
  for (const { input: inLeg, output: outLeg } of paired.swaps) {
    const network = input.chains.get(inLeg.chainId);
    if (network === undefined) {
      continue;
    }
    const inToken = resolve(inLeg.chainId, inLeg.token);
    const outToken = resolve(outLeg.chainId, outLeg.token);
    const day = isoDayOf(Math.floor(hourIndex(inLeg.date) / 24));
    let valueUsd: number | null = null;
    let feeUsd: number | null = null;
    if (valued && inToken.stable) {
      valueUsd = inLeg.amount;
      feeUsd = inLeg.fee;
      if (!outToken.stable) {
        stableSwaps.push({
          day,
          symbol: outToken.symbol,
          amount: outLeg.amount,
          stableAmount: inLeg.amount
        });
      }
    } else if (valued && outToken.stable) {
      valueUsd = outLeg.amount;
      // The fee is taken in the input token; the swap itself gives its stable price. Without an
      // input amount it gives none, and the fee is priced like any other.
      feeUsd = inLeg.amount > 0 ? (inLeg.fee * outLeg.amount) / inLeg.amount : null;
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
  const hourly = new Map<string, BuiltHour>();
  const factsAt = (network: NetworkId, hour: number): BuiltHour => {
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
        swapFees: {},
        unpriced: emptyUnpriced()
      };
      hourly.set(key, facts);
    }
    return facts;
  };
  const activity = new Map<string, { network: NetworkId; user: string; hours: Set<number> }>();

  for (const operation of operations) {
    const needsPrice =
      operation.valueUsd === null || (operation.feeUsd === null && operation.fee !== 0);
    const price =
      !valued || !needsPrice
        ? null
        : operation.stable
          ? 1
          : prices.usd(operation.asset, Math.floor(operation.hour / 24));
    const valueUsd = operation.valueUsd ?? (price === null ? null : operation.amount * price);
    const feeUsd =
      operation.feeUsd ?? (operation.fee === 0 ? 0 : price === null ? null : operation.fee * price);
    const facts = factsAt(operation.network, operation.hour);
    const transfer = operation.kind === 'transfer';
    const volumeKey = transfer ? 'transferVolume' : 'swapVolume';
    const feesKey = transfer ? 'transferFees' : 'swapFees';
    if (transfer) {
      stats.transfers += 1;
      facts.transfers += 1;
    } else {
      stats.swaps += 1;
      facts.swaps += 1;
    }
    if (valueUsd === null) {
      stats.unpriced += 1;
      addTo(facts.unpriced[volumeKey], operation.asset, 1);
    } else {
      addTo(facts[volumeKey], operation.asset, Math.round(valueUsd * 100));
    }
    if (feeUsd === null) {
      stats.unpricedFees += 1;
      addTo(facts.unpriced[feesKey], operation.asset, 1);
    } else {
      addTo(facts[feesKey], operation.asset, Math.round(feeUsd * 100));
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
    if (user.createdAt === null && networks.size > 0) {
      stats.undatedUsers += 1;
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
      activity: [...activity.values()]
        .map(
          (entry): UserActivity => ({
            network: entry.network,
            user: entry.user,
            hours: [...entry.hours].sort((left, right) => left - right)
          })
        )
        .sort(byNetworkThenUser),
      signups: signups.sort(byNetworkThenUser),
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
        swapFees: item.swapFees,
        // Builds stored before it was recorded valued those operations at zero.
        unpriced: item.unpriced ?? emptyUnpriced()
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

  undatedUsersAcross(networks: readonly NetworkId[]): number {
    return new Set(networks.flatMap((network) => this.undated.get(network) ?? [])).size;
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
