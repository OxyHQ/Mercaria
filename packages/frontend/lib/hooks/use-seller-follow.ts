import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { SELLER_FOLLOW_KIND, oxyUserFollowUri } from '@mercaria/shared-types';
import { queryKeys } from './query-keys';

/**
 * Resolve the follow-graph target id for a P2P SELLER — a person, followed
 * under the platform kind `oxy.user` (#92, #26).
 *
 * ## What this deliberately does NOT do
 *
 * It does not `claimFollowNamespace`, it does not `registerFollowKind`, and it
 * builds no `mercaria.co` URI. `oxy.user` is a platform kind seeded by Oxy's own
 * migration and owned by no application — the registry refuses a kind in a
 * namespace the caller does not hold, so registering it would fail, and
 * registering a person under a `mercaria.*` kind INSTEAD would succeed and be
 * far worse: a target row carries one kind and `ensureFollowTarget` is
 * idempotent on the URI, so the first registration fixes that human being's
 * kind forever and permanently splits their Mercaria followers from the
 * identity every other Oxy app already follows.
 *
 * That is the whole difference from `useStoreFollowTarget`, which DOES register,
 * because `mercaria.store` names a Mercaria-local shop with no Oxy account
 * behind it.
 *
 * ## Both `uri` and `localUserId`
 *
 * The URI is the identity; `localUserId` is the dedicated `follow_targets`
 * column only `oxy.user` targets populate, and it is what keeps Oxy's optimized
 * account graph authoritative for user-to-user queries. The server DERIVES the
 * id from the URI and refuses a `localUserId` that disagrees, so passing both
 * is a consistency assertion rather than a duplication — a wrong pairing fails
 * loudly instead of minting a target pointing at the wrong person.
 *
 * ## No metadata
 *
 * `metadata` is a display snapshot refreshed only for the application that
 * PROVIDES a target, and Oxy provides this one. Mercaria passing its own idea
 * of a person's name and avatar would be a marketplace overwriting an account's
 * own identity for every other Oxy surface — the exact copy of the account
 * document #92 privacy rule 1 refuses.
 *
 * Gated on `canUsePrivateApi` rather than `isAuthenticated`, like the store
 * hook: the device-first cold boot can take seconds to restore a session and
 * this call is user-delegated, so until it settles there is no target and the
 * caller renders no follow control rather than one that would fail on press.
 */
export function useSellerFollowTarget(oxyUserId: string | undefined) {
  const { oxyServices, canUsePrivateApi } = useOxy();

  return useQuery<string>({
    queryKey: queryKeys.sellers.followTarget(oxyUserId ?? ''),
    enabled: canUsePrivateApi && Boolean(oxyUserId),
    // A target id is permanent once minted, so there is nothing to revalidate.
    staleTime: Infinity,
    queryFn: async () => {
      if (!oxyUserId) throw new Error('A seller follow target needs an Oxy user id');
      const target = await oxyServices.ensureFollowTarget({
        uri: oxyUserFollowUri(oxyUserId),
        kind: SELLER_FOLLOW_KIND,
        localUserId: oxyUserId,
      });
      return target.id;
    },
  });
}
