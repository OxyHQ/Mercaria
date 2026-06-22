/**
 * Oxy user batch-profile service.
 *
 * Resolves Oxy identities (displayName / username / avatar) for a set of user
 * ids in ONE batch (deduped, parallel) and fail-soft: a user that fails to load
 * is simply OMITTED from the returned map and logged, so a single bad id never
 * fails the whole request. Display name is taken from the canonical
 * `user.name.displayName` contract — never recomputed.
 */

import { oxyClient } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

/** The minimal Oxy identity Mercaria renders for a user. */
export interface OxyProfile {
  id: string;
  username: string;
  displayName: string;
  avatar?: string | null;
}

/**
 * Batch-load Oxy profiles for a set of user ids. Ids are deduped; lookups run in
 * parallel; any id that fails to resolve is omitted (and logged). The returned
 * map is keyed by the requested user id.
 */
export async function getProfiles(oxyUserIds: string[]): Promise<Map<string, OxyProfile>> {
  const uniqueIds = [...new Set(oxyUserIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const map = new Map<string, OxyProfile>();

  if (uniqueIds.length === 0) {
    return map;
  }

  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const user = await oxyClient.getUserById(id);
        map.set(id, {
          id: user.id,
          username: user.username,
          displayName: user.name.displayName,
          avatar: user.avatar,
        });
      } catch (err) {
        log.general.warn({ err, oxyUserId: id }, 'Failed to load Oxy profile (omitting from batch)');
      }
    }),
  );

  return map;
}
