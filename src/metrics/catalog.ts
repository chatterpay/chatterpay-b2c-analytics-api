/** Network ids accepted by the metrics endpoints, besides `all`. */
export type NetworkId = 'base' | 'cardano';

/** Network filter of the metrics endpoints. */
export type NetworkFilter = NetworkId | 'all';

/** Networks of the dataset, in display order. */
export const NETWORK_IDS: readonly NetworkId[] = ['base', 'cardano'];

/** Version of the synthetic dataset; changing the generator requires a new value. */
export const DATASET_VERSION = 'mock-v1';

/** First day with synthetic activity (UTC). Earlier days have no activity. */
export const DATASET_START_DAY = '2025-01-01';

/** Share of one asset in the daily volume of a network, before daily noise. */
export interface AssetProfile {
  symbol: string;
  weight: number;
}

/** Parameters of the synthetic activity of one network. */
export interface NetworkProfile {
  id: NetworkId;
  label: string;
  assets: readonly AssetProfile[];
  newUsersPerDay: number;
  activeUsersPerDay: number;
  transfersPerActiveUser: number;
  /** Zero for networks without swaps. */
  swapsPerActiveUser: number;
  averageTransferCents: number;
  averageSwapCents: number;
  transferFeeBps: number;
  swapFeeBps: number;
}

// Labels and assets mirror the ChatterPay development networks; every amount is synthetic.
// Cardano has no swaps: ChatterPay carries ADA and USDCx transfers there.
const PROFILES: Readonly<Record<NetworkId, NetworkProfile>> = {
  base: {
    id: 'base',
    label: 'Base Sepolia',
    assets: [
      { symbol: 'USDC', weight: 45 },
      { symbol: 'USDT', weight: 30 },
      { symbol: 'WETH', weight: 18 },
      { symbol: 'WBTC', weight: 7 }
    ],
    newUsersPerDay: 14,
    activeUsersPerDay: 110,
    transfersPerActiveUser: 0.9,
    swapsPerActiveUser: 0.18,
    averageTransferCents: 3800,
    averageSwapCents: 12_500,
    transferFeeBps: 30,
    swapFeeBps: 100
  },
  cardano: {
    id: 'cardano',
    label: 'Cardano Preprod',
    assets: [
      { symbol: 'ADA', weight: 70 },
      { symbol: 'USDCx', weight: 30 }
    ],
    newUsersPerDay: 6,
    activeUsersPerDay: 40,
    transfersPerActiveUser: 0.8,
    swapsPerActiveUser: 0,
    averageTransferCents: 5200,
    averageSwapCents: 0,
    transferFeeBps: 30,
    swapFeeBps: 0
  }
};

/**
 * Returns the synthetic profile of a network.
 *
 * @param network - Network id.
 * @returns The profile used by the generator.
 */
export function networkProfile(network: NetworkId): NetworkProfile {
  return PROFILES[network];
}

/**
 * Expands a network filter into the networks it covers.
 *
 * @param filter - `all` or a single network id.
 * @returns The covered networks, in display order.
 */
export function networksFor(filter: NetworkFilter): readonly NetworkId[] {
  return filter === 'all' ? NETWORK_IDS : [filter];
}
