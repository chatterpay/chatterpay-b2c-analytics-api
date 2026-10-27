import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors/api-error.js';
import { listNetworks, type NetworkDefinition } from '../metrics/catalog.js';
import type { HiddenAssets } from '../metrics/token-scope.js';
import { hiddenAssets } from '../metrics/tokens.js';
import { visibleNetworks } from '../store/network-visibility.js';
import type { NetworkVisibility, Store } from '../store/types.js';

/**
 * Reads the network visibility policy for one request. The policy lives in the analytics database
 * shared by every instance. A change applies to the next request of the instance that made it, and
 * to the others once their cached read expires (`withReadCache`).
 *
 * @param store - Store holding the policy.
 * @param request - Request, for its logger.
 * @returns The policy.
 * @throws {ApiError} 503 when the store cannot answer: without the policy a hidden network could
 *   be served.
 */
export async function readVisibility(
  store: Store,
  request: FastifyRequest
): Promise<NetworkVisibility> {
  try {
    return await store.networkVisibility();
  } catch (error) {
    request.log.warn({ err: error }, 'network visibility read failed');
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Network settings are unavailable');
  }
}

/**
 * Networks of the catalog the statistics of one request cover, in display order.
 *
 * @param store - Store holding the policy.
 * @param request - Request, for its logger.
 * @returns The visible networks; at least one.
 * @throws {ApiError} 503 when the policy cannot be read or no network of the catalog is visible,
 *   which a catalog change can cause; zero networks are never served as an empty dataset.
 */
export async function visibleCatalog(
  store: Store,
  request: FastifyRequest
): Promise<NetworkDefinition[]> {
  return (await statisticsScope(store, request)).networks;
}

/** Networks and tokens the statistics of one request cover. */
export interface StatisticsScope {
  /** Visible networks, in display order; at least one. */
  networks: NetworkDefinition[];
  /** Hidden tokens of the visible networks, by network and upper-case symbol. */
  hidden: HiddenAssets;
}

/**
 * Networks and hidden tokens the statistics of one request cover, from one read of the policy.
 *
 * @param store - Store holding the policy.
 * @param request - Request, for its logger.
 * @returns The scope.
 * @throws {ApiError} 503 when the policy cannot be read or no network of the catalog is visible.
 */
export async function statisticsScope(
  store: Store,
  request: FastifyRequest
): Promise<StatisticsScope> {
  const policy = await readVisibility(store, request);
  const visible = visibleNetworks(listNetworks(), policy);
  if (visible.length === 0) {
    request.log.error('no network of the catalog is visible');
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'No network is available');
  }
  return { networks: visible, hidden: hiddenAssets(policy.disabledTokenIds, visible) };
}
