import { liveSourceFrom } from '../metrics/live.js';
import { setLiveSource } from '../metrics/sources.js';
import type { IngestRepository } from './types.js';

/**
 * Loads the last aggregate build of the analytics database into the metrics endpoints, when it is
 * newer than the one already loaded. Reads the analytics database only.
 *
 * @param repository - Source of the aggregates.
 * @param loadedAt - Build instant already loaded; `null` when none is.
 * @returns The build instant loaded after the call.
 */
export async function refreshLiveMetrics(
  repository: Pick<IngestRepository, 'aggregatesBuiltAt' | 'loadAggregates'>,
  loadedAt: Date | null
): Promise<Date | null> {
  const builtAt = await repository.aggregatesBuiltAt();
  if (builtAt === null || builtAt.getTime() === loadedAt?.getTime()) {
    return loadedAt;
  }
  const stored = await repository.loadAggregates();
  if (stored === null) {
    return loadedAt;
  }
  setLiveSource(liveSourceFrom(stored), stored.builtAt);
  return stored.builtAt;
}
