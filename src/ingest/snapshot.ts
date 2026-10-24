import type { NetworkId } from '../metrics/catalog.js';
import { formatUnits } from '../metrics/decimal.js';
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
  /** Symbol of the native coin on EVM networks; `ETH` when absent. */
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
  budget: CallBudget;
}

/** Result of {@link takeBalanceSnapshot}. */
export interface SnapshotResult {
  snapshot: BalanceSnapshot;
  /** `complete` when every wallet was read, `failed` when none was, `partial` otherwise. */
  status: 'complete' | 'partial' | 'failed';
}

/** Lovelace decimals; ADA is read from the UTxO values, not from the asset list. */
const LOVELACE_DECIMALS = 6;
/** Addresses up to this value are placeholders for native coins in the B2C token list. */
const PLACEHOLDER_ADDRESS_LIMIT = 0xffffn;

interface Asset {
  symbol: string;
  stable: boolean;
  decimals: number;
  /** ERC-20 contract on EVM; asset unit on Cardano; `null` for the native coin. */
  key: string | null;
}

function evmContract(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || BigInt(address) <= PLACEHOLDER_ADDRESS_LIMIT) {
    return null;
  }
  return address;
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

function centsOf(raw: bigint, asset: Asset, prices: ReadonlyMap<string, number>): number | null {
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
 * User wallets hold the assets of the B2C token list (ERC-20 tokens with a contract on EVM, ADA
 * and the listed native assets on Cardano); master wallets also hold the native coin. A wallet is
 * counted only when all its balances were read, so a failed batch lowers the coverage instead of
 * understating a total. A network without endpoint, or with a provider the reader does not speak,
 * is `unsupported`. Values use the price of the snapshot day; an asset without one has no value.
 *
 * @param input - Reader, endpoints, catalog, users, master wallets, prices and budget.
 * @returns The snapshot and its overall status.
 */
export async function takeBalanceSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const endpoints = new Map(input.endpoints.map((endpoint) => [endpoint.chainId, endpoint]));
  const networks: SnapshotNetwork[] = [];
  const holdings: SnapshotHolding[] = [];
  const masterWallets: MasterWalletReading[] = [];

  for (const chain of input.chains) {
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
    const masters = input.masterWallets.filter((wallet) => wallet.network === chain.network);
    const supported =
      endpoint !== undefined &&
      (endpoint.family === 'evm' || input.reader.supportsCardano(endpoint.url));
    const assets =
      endpoint?.family === 'cardano'
        ? cardanoAssets(input.tokens, chain.chainId)
        : evmAssets(input.tokens, chain.chainId);
    const masterAddresses = masters.map((wallet) => normalize(wallet.address));

    let balances: WalletBalances = new Map();
    if (supported && endpoint !== undefined) {
      const addresses = [...new Set([...holders, ...masterAddresses])];
      balances =
        endpoint.family === 'cardano'
          ? await readCardano(input.reader, endpoint.url, addresses, assets, input.budget)
          : await readEvm(
              input.reader,
              endpoint.url,
              addresses,
              assets,
              new Set(masterAddresses),
              input.budget
            );
    }

    const read = holders.filter((holder) => balances.has(holder));
    networks.push({
      network: chain.network,
      // The status describes the user wallets; a network without any has nothing left unread.
      status:
        supported || holders.length === 0 ? statusOf(holders.length, read.length) : 'unsupported',
      wallets: holders.length,
      walletsRead: read.length
    });
    assets.forEach((asset, index) => {
      let raw = 0n;
      for (const holder of read) {
        raw += balances.get(holder)?.[index] ?? 0n;
      }
      if (raw > 0n) {
        holdings.push({
          network: chain.network,
          asset: asset.symbol,
          amount: formatUnits(raw, asset.decimals),
          valueCents: centsOf(raw, asset, input.prices)
        });
      }
    });

    masters.forEach((wallet, position) => {
      const values = balances.get(masterAddresses[position] ?? '');
      const native: Asset = {
        symbol: wallet.nativeSymbol ?? 'ETH',
        stable: false,
        decimals: 18,
        key: null
      };
      // EVM readings carry the native balance after the tokens; on Cardano ADA is the first asset.
      const walletAssets = evm ? [...assets, native] : assets;
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
                        valueCents: centsOf(raw, asset, input.prices)
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
    snapshot: { networks, holdings, masterWallets },
    status: !unread ? 'complete' : wallets > 0 && read === 0 ? 'failed' : 'partial'
  };
}
