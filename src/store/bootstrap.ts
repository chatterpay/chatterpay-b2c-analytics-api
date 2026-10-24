import type { AppEnv } from '../config/env.js';
import type { Store } from './types.js';

/**
 * Creates the members listed in `BOOTSTRAP_ADMIN_EMAILS` and `BOOTSTRAP_VIEWER_EMAILS`.
 *
 * Idempotent: an email that already belongs to an active member keeps its current role. An email
 * listed in both variables becomes an admin.
 *
 * @param store - Store to populate.
 * @param env - Configuration with the normalized email lists.
 * @param now - Creation instant.
 */
export async function bootstrapMembers(
  store: Store,
  env: Pick<AppEnv, 'BOOTSTRAP_ADMIN_EMAILS' | 'BOOTSTRAP_VIEWER_EMAILS'>,
  now: Date
): Promise<void> {
  for (const email of env.BOOTSTRAP_ADMIN_EMAILS) {
    await store.ensureUser(email, 'admin', now);
  }
  for (const email of env.BOOTSTRAP_VIEWER_EMAILS) {
    await store.ensureUser(email, 'viewer', now);
  }
}
