/**
 * Oxy user batch-profile service.
 *
 * Resolves Oxy identities (displayName / username / avatar) for a set of user
 * ids in ONE batch (deduped, parallel) and fail-soft: a user that fails to load
 * is simply OMITTED from the returned map and logged, so a single bad id never
 * fails the whole request.
 *
 * ## One coalesce, one place
 *
 * `user.name.displayName` is OPTIONAL on the Oxy contract — federated and
 * unresolved actors routinely omit it — so reading it straight through produces
 * an EMPTY display name for exactly the accounts a marketplace is least able to
 * describe otherwise. {@link toOxyProfile} applies the sanctioned coalesce
 * (`displayName?.trim() || handle`) and is the ONLY place in this backend that
 * decides what a person is called; every seller card, review author, order
 * seller and cart line comes through it. Recomposing a name from
 * `name.first`/`last`/`full` is forbidden ecosystem-wide and has no code path
 * here.
 */

import { getNormalizedUserHandle, type User } from '@oxyhq/core';
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
 * Project an Oxy `User` onto the identity Mercaria renders.
 *
 * `getNormalizedUserHandle` is the ecosystem's own resolver (local users →
 * `username`, federated users → `username@instance`). Its `null` is a real
 * answer for an actor with no usable handle at all, so the raw `username` is
 * the next fallback and the account id the last — an opaque card beats a
 * nameless one, and neither is ever a name synthesised from name parts.
 */
export function toOxyProfile(user: User): OxyProfile {
  const handle = getNormalizedUserHandle(user) ?? user.username ?? user.id;
  const declared = user.name.displayName?.trim();
  const profile: OxyProfile = {
    id: user.id,
    username: handle,
    displayName: declared && declared.length > 0 ? declared : handle,
  };
  if (user.avatar !== undefined) {
    profile.avatar = user.avatar;
  }
  return profile;
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
        map.set(id, toOxyProfile(await oxyClient.getUserById(id)));
      } catch (err) {
        log.general.warn({ err, oxyUserId: id }, 'Failed to load Oxy profile (omitting from batch)');
      }
    }),
  );

  return map;
}
