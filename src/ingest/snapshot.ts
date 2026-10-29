import type { NetworkId } from '../metrics/catalog.js';
import { formatUnits } from '../metrics/decimal.js';
import type { NativeCoverage, NetworkReadReason, UsdValuation } from '../metrics/types.js';
import { isBlockfrost, KOIOS_BATCH_SIZE, MULTICALL_BATCH_SIZE } from './balance-reader.js';
import type {
  BalanceReader,
  BalanceSnapshot,
  CallBudget,
  ChainEndpoint,
  ChainInfo,
  EvmBalanceQuery,
  IngestedUser,
  MasterWalletReading,
  SnapshotHolding,
  SnapshotNetwork,
  TokenInfo
} from './types.js';

/** Signer of a network whose balances the snapshot reads; public address only. */
export interface MasterWalletConfig {
  network: NetworkId;
  address: string;
  /** Role shown with the wallet, such as `Backend signer`. */
  role: string;
  /**
   * Symbol of the native coin on EVM networks. The balance of the wallet itself takes `ETH` when
   * absent; the user wallets of the network are read with the native coin only when it is stated.
   */
  nativeSymbol?: string | undefined;
}

/** Inputs of {@link takeBalanceSnapshot}. */
export interface SnapshotInput {
  reader: BalanceReader;
  endpoints: readonly ChainEndpoint[];
  chains: readonly ChainInfo[];
  tokens: readonly TokenInfo[];
  users: readonly IngestedUser[];
  masterWallets: readonly MasterWalletConfig[];
  /** USD price per symbol on the snapshot day, from the provider; stable tokens are 1 USD. */
  prices: ReadonlyMap<string, number>;
  /**
   * B2C `enabled` by chain id of the networks the B2C database lists; `null` when the document has
   * no boolean `enabled`. A chain of `chains` absent from it is a network the B2C database dropped.
   * The value is recorded, never used to decide what is read.
   */
  b2cEnabled: ReadonlyMap<string, boolean | null>;
  /** Chain ids whose balances the analytics settings do not read; none when omitted. */
  uncollected?: ReadonlySet<string>;
  budget: CallBudget;
  /** `none` stores every balance without a USD value; `market` by default. */
  valuation?: UsdValuation;
  /** Instant of the snapshot, the `lastSuccessAt` of the networks it reads in full. */
  takenAt: Date;
  /** `lastSuccessAt` of earlier runs by network, kept by a network not read in full now. */
  lastSuccess?: ReadonlyMap<NetworkId, Date>;
  /** Current epoch milliseconds, for the budget deadline and the duration per network. */
  now?: () => number;
}

/** Read of one network with every stored field, plus the fields only the run report carries. */
export type NetworkRead = Required<SnapshotNetwork> & {
  chainId: string;
  /** Whether B2C lists an HTTPS endpoint for the network; the URL itself is never reported. */
  endpointPresent: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Assets held by the user wallets of the network without a USD value. */
  unpricedAssets: number;
  /**
   * Requests a full read of the network takes, before any is sent: one `eth_call` per
   * {@link MULTICALL_BATCH_SIZE} balances on EVM, one per address on Blockfrost and one per
   * {@link KOIOS_BATCH_SIZE} addresses on Koios, which also takes one per additional page of UTxOs
   * that is not known in advance. Zero when no request is sent for the network.
   */
  plannedCalls: number;
};

/** Result of {@link takeBalanceSnapshot}. */
export interface SnapshotResult {
  snapshot: BalanceSnapshot;
  /** The rows of `snapshot.networks`, typed with every field and the report-only ones. */
  networks: NetworkRead[];
  /** `complete` when every wallet was read, `failed` when none was, `partial` otherwise. */
  status: 'complete' | 'partial' | 'failed';
}

/** Lovelace decimals; ADA is read from the UTxO values, not from the asset list. */
const LOVELACE_DECIMALS = 6;
/** Addresses up to this value are placeholders for native coins in the B2C token list. */
const PLACEHOLDER_ADDRESS_LIMIT = 0xffffn;
/** Address that token lists and routers use for the native coin of an EVM network. */
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/** Decimals of the balance an EVM node returns for the native coin (wei). */
const EVM_NATIVE_DECIMALS = 18;

interface Asset {
  symbol: string;
  stable: boolean;
  decimals: number;
  /** ERC-20 contract on EVM; asset unit on Cardano; `null` for the native coin. */
  key: string | null;
}

function evmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/** Whether a token of an EVM list stands for the native coin instead of a contract. */
function isNativePlaceholder(address: string): boolean {
  return (
    evmAddress(address) &&
    (BigInt(address) <= PLACEHOLDER_ADDRESS_LIMIT || address.toLowerCase() === NATIVE_SENTINEL)
  );
}

function evmContract(address: string): string | null {
  return evmAddress(address) && !isNativePlaceholder(address) ? address : null;
}

/** ERC-20 tokens of an EVM chain with a contract address and decimals. */
function evmAssets(tokens: readonly TokenInfo[], chainId: string): Asset[] {
  return tokens.flatMap((token) => {
    const contract = evmContract(token.address);
    return token.chainId !== chainId || token.decimals === null || contract === null
      ? []
      : [{ symbol: token.symbol, stable: token.stable, decimals: token.decimals, key: contract }];
  });
}

/**
 * Native coin of an EVM chain when its B2C token list carries it: the first token whose address
 * is a placeholder (up to `0xffff`) or the `0xEeee…` sentinel. It is read with `eth_getBalance`
 * semantics (`token: null`), in wei, whatever decimals the document states. Without such a token
 * the native coin is not read, and the snapshot says so instead of assuming a contract.
 */
function evmNative(tokens: readonly TokenInfo[], chainId: string): Asset | null {
  const token = tokens.find(
    (item) => item.chainId === chainId && isNativePlaceholder(item.address)
  );
  return token === undefined
    ? null
    : { symbol: token.symbol, stable: token.stable, decimals: EVM_NATIVE_DECIMALS, key: null };
}

/**
 * Native coin of an EVM chain from the analytics configuration, for a B2C token list that does not
 * carry it: the `nativeSymbol` of the first master wallet of the network that states one, read in
 * wei like the listed one. `null` when none states one: an EVM network is not assumed to use ETH.
 */
function configuredNative(masters: readonly MasterWalletConfig[]): Asset | null {
  const symbol = masters.find((wallet) => wallet.nativeSymbol !== undefined)?.nativeSymbol;
  return symbol === undefined
    ? null
    : { symbol, stable: false, decimals: EVM_NATIVE_DECIMALS, key: null };
}

/** Role shown with the paymaster of a network. */
export const PAYMASTER_ROLE = 'Paymaster';

/**
 * Paymaster of an EVM chain and the EntryPoint that holds its deposit, from the contracts of the B2C
 * `blockchains` document. `null` when the document names no valid paymaster address.
 */
function chainPaymaster(chain: ChainInfo): { address: string; entryPoint: string | null } | null {
  const address = chain.contracts.paymasterAddress ?? '';
  const entryPoint = chain.contracts.entryPoint ?? '';
  return chain.family === 'cardano' || !evmAddress(address)
    ? null
    : { address, entryPoint: evmAddress(entryPoint) ? entryPoint : null };
}

/** ADA plus the native assets of a Cardano chain listed in the B2C token list. */
function cardanoAssets(tokens: readonly TokenInfo[], chainId: string): Asset[] {
  const listed = tokens.filter((token) => token.chainId === chainId);
  const ada = listed.find((token) => token.address.startsWith('cardano:'));
  const assets: Asset[] = [
    {
      symbol: ada?.symbol ?? 'ADA',
      stable: ada?.stable ?? false,
      decimals: LOVELACE_DECIMALS,
      key: null
    }
  ];
  for (const token of listed) {
    if (token !== ada && token.decimals !== null && /^[0-9a-fA-F]{56,}$/.test(token.address)) {
      assets.push({
        symbol: token.symbol,
        stable: token.stable,
        decimals: token.decimals,
        key: token.address.toLowerCase()
      });
    }
  }
  return assets;
}

function centsOf(
  raw: bigint,
  asset: Asset,
  prices: ReadonlyMap<string, number>,
  valuation: UsdValuation
): number | null {
  if (valuation === 'none') {
    return null;
  }
  const price = asset.stable ? 1 : prices.get(asset.symbol);
  if (price === undefined) {
    return null;
  }
  return Math.round(Number(formatUnits(raw, asset.decimals)) * price * 100);
}

function explorerAddressUrl(explorer: string, address: string): string | null {
  try {
    const origin = new URL(explorer).origin;
    return origin === 'null' ? null : `${origin}/address/${address}`;
  } catch {
    return null;
  }
}

function statusOf(wallets: number, read: number): SnapshotNetwork['status'] {
  return read === wallets ? 'complete' : read === 0 ? 'failed' : 'partial';
}

/**
 * Why a network whose reads were started left wallets unread. A node that answered none of its
 * requests is `rpc_failed` even when the budget ran out after it; otherwise a spent budget or a
 * passed deadline names the limit that stopped the reads.
 */
function unreadReason(
  budget: CallBudget,
  calls: number,
  failed: number,
  read: number,
  now: number
): NetworkReadReason {
  if (read === 0 && calls > 0 && failed === calls) {
    return 'rpc_failed';
  }
  if (budget.remaining <= 0) {
    return 'budget_exhausted';
  }
  return now >= budget.deadline ? 'deadline_reached' : 'read_incomplete';
}

/** The fields of a network read that the snapshot stores. */
function storedRow(row: NetworkRead): SnapshotNetwork {
  const {
    chainId,
    endpointPresent,
    startedAt,
    finishedAt,
    durationMs,
    unpricedAssets,
    plannedCalls,
    ...stored
  } = row;
  return stored;
}

/** Balances per wallet, keyed by asset index, for the wallets that were read completely. */
type WalletBalances = Map<string, bigint[]>;

async function readEvm(
  reader: BalanceReader,
  url: string,
  holders: readonly string[],
  assets: readonly Asset[],
  withNative: ReadonlySet<string>,
  budget: CallBudget
): Promise<WalletBalances> {
  const queries: EvmBalanceQuery[] = [];
  const layout: Array<{ holder: string; from: number; count: number }> = [];
  for (const holder of holders) {
    const from = queries.length;
    for (const asset of assets) {
      queries.push({ holder, token: asset.key });
    }
    if (withNative.has(holder)) {
      queries.push({ holder, token: null });
    }
    layout.push({ holder, from, count: queries.length - from });
  }
  const results = queries.length === 0 ? [] : await reader.evm(url, queries, budget);
  const balances: WalletBalances = new Map();
  for (const { holder, from, count } of layout) {
    const values = results.slice(from, from + count);
    if (values.every((value): value is bigint => value !== null)) {
      balances.set(holder, values);
    }
  }
  return balances;
}

async function readCardano(
  reader: BalanceReader,
  url: string,
  holders: readonly string[],
  assets: readonly Asset[],
  budget: CallBudget
): Promise<WalletBalances> {
  const holdings = holders.length === 0 ? new Map() : await reader.cardano(url, holders, budget);
  const balances: WalletBalances = new Map();
  for (const [holder, entry] of holdings) {
    balances.set(
      holder,
      assets.map((asset) =>
        asset.key === null ? entry.lovelace : (entry.assets.get(asset.key) ?? 0n)
      )
    );
  }
  return balances;
}

/**
 * Reads the balances of every user wallet and master wallet of the catalog networks, once, and
 * sums the user wallets per network and asset. Per-wallet balances are not kept.
 *
 * User wallets hold the assets of the B2C token list, tokens with `enabled: false` included
 * (ERC-20 tokens with a contract on EVM, plus the native coin when the list carries it or, failing
 * that, when a master wallet of the network states its `nativeSymbol`; ADA and the listed native
 * assets on Cardano); master wallets always hold the native coin, and their balances never count
 * in the user totals. The paymaster that the B2C document of an EVM network names is a master
 * wallet of the network (role {@link PAYMASTER_ROLE}) without being configured; its native balance
 * adds its deposit in the EntryPoint (`balanceOf(paymaster)`), the funds that pay the gas of the
 * user operations. A paymaster whose deposit could not be read is `failed`. Every address is read once, a master wallet that is also a user wallet
 * included, and the native coin once per address. A network row records whether its user wallets
 * were read with the native coin (`native`). A wallet is counted only when all its balances were
 * read, so a failed batch or an exhausted budget lowers the coverage instead of understating a
 * total. A network without endpoint, or with a provider the reader does not speak, is
 * `unsupported`. Values use the price of the snapshot day; an asset without one has no value, and
 * with `valuation: none` no asset has one.
 *
 * B2C `enabled` plays no part: a network closed to new B2C operations is read through its endpoint
 * like any other, and its row records `b2cEnabled`. No request is sent for a network in
 * `uncollected` (`collection_off`) or that the B2C database no longer lists (`source_absent`,
 * whatever endpoint is passed): it is `unsupported` with the reason, and its earlier snapshots stay
 * as they were. A network whose reads were started and left wallets unread records the cause:
 * `rpc_failed`, `budget_exhausted`, `deadline_reached` or `read_incomplete`. Networks are read one
 * after the other within the shared budget; the reader bounds the requests a failing node takes.
 * `lastSuccessAt` is `takenAt` for a network read in full and its earlier value otherwise.
 *
 * @param input - Reader, endpoints, catalog, users, master wallets, prices, B2C status, settings,
 *   budget and instant.
 * @returns The snapshot and its overall status.
 */
export async function takeBalanceSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const valuation = input.valuation ?? 'market';
  const now = input.now ?? Date.now;
  const endpoints = new Map(input.endpoints.map((endpoint) => [endpoint.chainId, endpoint]));
  const networks: NetworkRead[] = [];
  const holdings: SnapshotHolding[] = [];
  const masterWallets: MasterWalletReading[] = [];

  for (const chain of input.chains) {
    const startedAt = now();
    const endpoint = endpoints.get(chain.chainId);
    const evm = endpoint?.family !== 'cardano';
    const normalize = (address: string): string => (evm ? address.toLowerCase() : address);
    const holders = [
      ...new Set(
        input.users.flatMap((user) =>
          user.wallets
            .filter((wallet) => wallet.chainId === chain.chainId)
            .map((wallet) => normalize(wallet.address))
        )
      )
    ];
    const paymaster = chainPaymaster(chain);
    const configuredMasters = input.masterWallets.filter(
      (wallet) => wallet.network === chain.network
    );
    const masters =
      paymaster === null ||
      configuredMasters.some((wallet) => normalize(wallet.address) === normalize(paymaster.address))
        ? configuredMasters
        : [
            ...configuredMasters,
            { network: chain.network, address: paymaster.address, role: PAYMASTER_ROLE }
          ];
    const listed = input.b2cEnabled.has(chain.chainId);
    const b2cEnabled = input.b2cEnabled.get(chain.chainId) ?? null;
    const collectBalances = input.uncollected?.has(chain.chainId) !== true;
    const skipped: NetworkReadReason | null = !collectBalances
      ? 'collection_off'
      : !listed
        ? 'source_absent'
        : null;
    const supported =
      skipped === null &&
      endpoint !== undefined &&
      (endpoint.family === 'evm' || input.reader.supportsCardano(endpoint.url));
    const native =
      endpoint?.family === 'cardano' || chain.family === 'cardano'
        ? null
        : (evmNative(input.tokens, chain.chainId) ?? configuredNative(masters));
    const assets =
      endpoint?.family === 'cardano'
        ? cardanoAssets(input.tokens, chain.chainId)
        : [...evmAssets(input.tokens, chain.chainId), ...(native === null ? [] : [native])];
    const nativeCoverage: NativeCoverage =
      chain.family === 'cardano' || native !== null ? 'included' : 'not_listed';
    const masterAddresses = masters.map((wallet) => normalize(wallet.address));
    const depositAsset: Asset | null =
      paymaster?.entryPoint == null
        ? null
        : {
            symbol: native?.symbol ?? 'ETH',
            stable: false,
            decimals: EVM_NATIVE_DECIMALS,
            key: paymaster.entryPoint
          };
    /** EntryPoint deposit of the paymaster, in wei; `null` when not read. */
    let paymasterDeposit: bigint | null = null;

    let balances: WalletBalances = new Map();
    let plannedCalls = 0;
    const callsBefore = input.budget.used;
    const failedBefore = input.budget.failed;
    if (supported && endpoint !== undefined) {
      const addresses = [...new Set([...holders, ...masterAddresses])];
      if (endpoint.family === 'cardano') {
        plannedCalls = isBlockfrost(endpoint.url)
          ? addresses.length
          : Math.ceil(addresses.length / KOIOS_BATCH_SIZE);
        balances = await readCardano(input.reader, endpoint.url, addresses, assets, input.budget);
      } else {
        // With the native coin in the list every address already reads it.
        const withNative = new Set(native === null ? masterAddresses : []);
        const queries =
          addresses.length * assets.length +
          addresses.filter((address) => withNative.has(address)).length;
        plannedCalls = Math.ceil(queries / MULTICALL_BATCH_SIZE);
        balances = await readEvm(
          input.reader,
          endpoint.url,
          addresses,
          assets,
          withNative,
          input.budget
        );
        if (paymaster !== null && depositAsset !== null) {
          // EntryPoint `balanceOf(address)` shares the ERC-20 selector, so the deposit reads as a
          // token balance of the paymaster.
          plannedCalls += 1;
          const address = normalize(paymaster.address);
          const deposit = await readEvm(
            input.reader,
            endpoint.url,
            [address],
            [depositAsset],
            new Set(),
            input.budget
          );
          paymasterDeposit = deposit.get(address)?.[0] ?? null;
        }
      }
    }

    const read = holders.filter((holder) => balances.has(holder));
    const calls = input.budget.used - callsBefore;
    const failedCalls = input.budget.failed - failedBefore;
    const finishedAt = now();
    const reason: NetworkReadReason | null =
      skipped ??
      (endpoint === undefined
        ? 'no_endpoint'
        : !supported
          ? 'unsupported_provider'
          : read.length < holders.length
            ? unreadReason(input.budget, calls, failedCalls, read.length, finishedAt)
            : null);
    const held = assets.flatMap((asset, index): SnapshotHolding[] => {
      let raw = 0n;
      for (const holder of read) {
        raw += balances.get(holder)?.[index] ?? 0n;
      }
      return raw > 0n
        ? [
            {
              network: chain.network,
              asset: asset.symbol,
              amount: formatUnits(raw, asset.decimals),
              valueCents: centsOf(raw, asset, input.prices, valuation)
            }
          ]
        : [];
    });
    holdings.push(...held);
    networks.push({
      network: chain.network,
      chainId: chain.chainId,
      // The status describes the user wallets; a network without any has nothing left unread.
      status:
        supported || holders.length === 0 ? statusOf(holders.length, read.length) : 'unsupported',
      wallets: holders.length,
      walletsRead: read.length,
      calls,
      failedCalls,
      b2cEnabled,
      collectBalances,
      attempted: supported,
      endpointPresent: listed && endpoint !== undefined,
      reason,
      native: nativeCoverage,
      lastSuccessAt:
        reason === null ? input.takenAt : (input.lastSuccess?.get(chain.network) ?? null),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      unpricedAssets: held.filter((holding) => holding.valueCents === null).length,
      plannedCalls
    });

    masters.forEach((wallet, position) => {
      const address = masterAddresses[position] ?? '';
      const isPaymaster = paymaster !== null && address === normalize(paymaster.address);
      const own = balances.get(address);
      // The native coin is the last asset of an EVM reading; the paymaster adds its deposit to it.
      const values =
        own === undefined || !isPaymaster || paymaster.entryPoint === null
          ? own
          : paymasterDeposit === null
            ? undefined
            : own.map((value, index) =>
                index === own.length - 1 ? value + paymasterDeposit : value
              );
      const configured: Asset = {
        symbol: wallet.nativeSymbol ?? 'ETH',
        stable: false,
        decimals: EVM_NATIVE_DECIMALS,
        key: null
      };
      // EVM readings carry the native balance after the tokens, as the last asset of the list when
      // the list has it; on Cardano ADA is the first asset.
      const walletAssets = evm && native === null ? [...assets, configured] : assets;
      masterWallets.push({
        network: chain.network,
        role: wallet.role,
        address: wallet.address,
        explorerUrl: explorerAddressUrl(chain.explorer, wallet.address),
        status: !supported ? 'unsupported' : values === undefined ? 'failed' : 'complete',
        balances:
          values === undefined
            ? []
            : walletAssets.flatMap((asset, index) => {
                const raw = values[index] ?? 0n;
                return raw > 0n
                  ? [
                      {
                        asset: asset.symbol,
                        amount: formatUnits(raw, asset.decimals),
                        valueCents: centsOf(raw, asset, input.prices, valuation)
                      }
                    ]
                  : [];
              })
      });
    });
  }

  const wallets = networks.reduce((sum, row) => sum + row.wallets, 0);
  const read = networks.reduce((sum, row) => sum + row.walletsRead, 0);
  const unread = networks.some((row) => row.status !== 'complete');
  return {
    snapshot: { networks: networks.map(storedRow), holdings, masterWallets, valuation },
    networks,
    status: !unread ? 'complete' : wallets > 0 && read === 0 ? 'failed' : 'partial'
  };
}
