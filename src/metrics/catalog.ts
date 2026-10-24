/**
 * Network id: slug of the network name in the B2C `blockchains` collection (`Base Sepolia` →
 * `base-sepolia`). The set varies per environment, so it is a string validated against the catalog.
 */
export type NetworkId = string;

/** Network filter of the metrics endpoints. */
export type NetworkFilter = NetworkId | 'all';

/** Pattern of a network id; it also rejects `all`, which is the filter for every network. */
export const NETWORK_ID_PATTERN = '^(?!all$)[a-z0-9]+(-[a-z0-9]+)*$';

/** Family of a network, which selects the synthetic activity template. */
export type NetworkFamily = 'evm' | 'cardano';

/** Network of the catalog, as read from the B2C `blockchains` collection. */
export interface NetworkDefinition {
  id: NetworkId;
  label: string;
  family: NetworkFamily;
}

/** Version of the synthetic dataset; changing the generator requires a new value. */
export const DATASET_VERSION = 'mock-v2';

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
  family: NetworkFamily;
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

type ActivityTemplate = Omit<NetworkProfile, 'id' | 'label' | 'family'>;

// Assets mirror what ChatterPay carries on each family; every amount is synthetic.
// Cardano has no swaps: ChatterPay carries ADA and USDCx transfers there.
const TEMPLATES: Readonly<Record<NetworkFamily, ActivityTemplate>> = {
  evm: {
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

/** Catalog used until the B2C networks are loaded, and by tests and local runs without Mongo. */
export const DEFAULT_NETWORKS: readonly NetworkDefinition[] = [
  { id: 'base-sepolia', label: 'Base Sepolia', family: 'evm' },
  { id: 'cardano-preprod', label: 'Cardano Preprod', family: 'cardano' }
];

/**
 * Scale of the user counts of a network, in [0.5, 1.0], derived from its id so two networks of the
 * same family do not show identical activity and a network keeps its scale across restarts.
 */
function scaleOf(id: NetworkId): number {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return 0.5 + (hash % 501) / 1000;
}

function profileOf(definition: NetworkDefinition, position: number): NetworkProfile {
  const template = TEMPLATES[definition.family];
  // The first network of each family keeps the template volume; the following ones are scaled.
  const scale = position === 0 ? 1 : scaleOf(definition.id);
  return {
    ...template,
    id: definition.id,
    label: definition.label,
    family: definition.family,
    newUsersPerDay: Math.max(1, Math.round(template.newUsersPerDay * scale)),
    activeUsersPerDay: Math.max(1, Math.round(template.activeUsersPerDay * scale))
  };
}

let profiles: ReadonlyMap<NetworkId, NetworkProfile> = new Map();
let networkIds: readonly NetworkId[] = [];

/**
 * Replaces the network catalog. Ids must be unique and match {@link NETWORK_ID_PATTERN}.
 *
 * @param definitions - Networks in display order; at least one.
 * @throws {Error} When the list is empty, an id is invalid or two networks share an id.
 */
export function setNetworks(definitions: readonly NetworkDefinition[]): void {
  if (definitions.length === 0) {
    throw new Error('The network catalog needs at least one network');
  }
  const pattern = new RegExp(NETWORK_ID_PATTERN);
  const next = new Map<NetworkId, NetworkProfile>();
  const perFamily = new Map<NetworkFamily, number>();
  for (const definition of definitions) {
    if (!pattern.test(definition.id) || next.has(definition.id)) {
      throw new Error(`Invalid or duplicated network id: ${definition.id}`);
    }
    const position = perFamily.get(definition.family) ?? 0;
    perFamily.set(definition.family, position + 1);
    next.set(definition.id, profileOf(definition, position));
  }
  profiles = next;
  networkIds = definitions.map((definition) => definition.id);
}

setNetworks(DEFAULT_NETWORKS);

/**
 * Networks of the catalog, in display order.
 *
 * @returns Id, label and family of each network.
 */
export function listNetworks(): NetworkDefinition[] {
  return networkIds.map((id) => {
    const { label, family } = networkProfile(id);
    return { id, label, family };
  });
}

/**
 * Tells whether a network filter names `all` or a network of the catalog.
 *
 * @param filter - Value of the `network` query parameter.
 * @returns `true` when the metrics endpoints can serve it.
 */
export function isKnownNetwork(filter: string): filter is NetworkFilter {
  return filter === 'all' || profiles.has(filter);
}

/**
 * Returns the synthetic profile of a network.
 *
 * @param network - Network id of the catalog.
 * @returns The profile used by the generator.
 * @throws {Error} When the id is not in the catalog.
 */
export function networkProfile(network: NetworkId): NetworkProfile {
  const profile = profiles.get(network);
  if (profile === undefined) {
    throw new Error(`Unknown network: ${network}`);
  }
  return profile;
}

/**
 * Expands a network filter into the networks it covers.
 *
 * @param filter - `all` or a single network id.
 * @returns The covered networks, in display order.
 */
export function networksFor(filter: NetworkFilter): readonly NetworkId[] {
  return filter === 'all' ? networkIds : [filter];
}
