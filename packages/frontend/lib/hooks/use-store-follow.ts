import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { StoreSummary } from '@mercaria/shared-types';
import { ensureStoreFollowKind, STORE_FOLLOW_KIND, storeFollowUri } from '../follow-graph';
import { queryKeys } from './query-keys';

/**
 * Resolve the follow-graph target id for a store, registering Mercaria's
 * namespace and kind the first time it is needed.
 *
 * A target is resolved on the way into a screen because following takes a
 * target id and never a URI — registration is the moment an application vouches
 * that the thing exists, so it cannot be folded into the press handler.
 *
 * Gated on `canUsePrivateApi` rather than `isAuthenticated`: the device-first
 * cold boot can take seconds to restore a session, and both this call and the
 * registration behind it are user-delegated. Until it settles there is no
 * target, and the caller renders no follow control rather than one that would
 * fail on press.
 */
export function useStoreFollowTarget(store: StoreSummary) {
  const { oxyServices, canUsePrivateApi } = useOxy();

  return useQuery<string>({
    queryKey: queryKeys.stores.followTarget(store.id),
    enabled: canUsePrivateApi,
    // A target id is permanent once minted, so there is nothing to revalidate.
    staleTime: Infinity,
    queryFn: async () => {
      await ensureStoreFollowKind(oxyServices);
      const target = await oxyServices.ensureFollowTarget({
        uri: storeFollowUri(store.id),
        kind: STORE_FOLLOW_KIND,
        // The display snapshot other Oxy surfaces render this store with.
        // Mercaria provides the target, so Mercaria is the only application
        // whose idea of the name and logo is written here.
        metadata: {
          name: store.name,
          handle: store.handle,
          ...(store.logoUrl ? { icon: store.logoUrl } : {}),
        },
        providerReference: store.id,
      });
      return target.id;
    },
  });
}
