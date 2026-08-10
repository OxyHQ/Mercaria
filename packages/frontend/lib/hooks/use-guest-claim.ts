/**
 * React Query hooks for claiming a guest checkout group (#109).
 *
 * The one thing worth reading before the code: the claim is a MUTATION driven
 * by an explicit press, never a query and never an effect. #109 UX rule 10 says
 * a claim must not auto-submit after sign-in, and the strongest form of that is
 * having nothing that could — a query with `enabled: isAuthenticated` would run
 * the moment somebody signed in, which is exactly the shape `useGuestCartMerge`
 * uses for the CART because a cart merge is reversible and an ownership change
 * is not.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuestClaimPreview, GuestClaimResult } from '@mercaria/shared-types';
import { claimGuestOrders, getClaimPreview } from '../api/guest-claim';
import { discardPortalToken } from '../stores/portal-credential-store';
import { queryKeys } from './query-keys';

/**
 * What will be attached, and whether it can be.
 *
 * `retry: false` because every failure here is an ANSWER rather than a fault: a
 * 401 means the portal credential is gone, a 404 means this group is not the
 * credential's, and retrying asks the same question of the same request.
 */
export function useGuestClaimPreview(checkoutGroupId: string | undefined, enabled: boolean) {
  return useQuery<GuestClaimPreview>({
    queryKey: queryKeys.guestClaim.preview(checkoutGroupId ?? ''),
    queryFn: () => getClaimPreview(checkoutGroupId ?? ''),
    enabled: enabled && Boolean(checkoutGroupId),
    retry: false,
  });
}

/**
 * Perform the claim.
 *
 * `retry: false` for a different reason from the preview's: the claim IS
 * idempotent server-side (a retry by the same account converges on the same
 * completed result), but a client that retried automatically would also retry a
 * 409, and a rival claimant hammering a contested group is the one thing this
 * flow must not do on its own.
 *
 * On success the portal credential is DISCARDED, because the server revoked it
 * inside the claim transaction (ADR 0003 D14): after a claim, order access is
 * the Oxy account and not the emailed link. Keeping a dead token would make the
 * next portal read a confusing 401.
 */
export function useGuestClaim() {
  const queryClient = useQueryClient();
  return useMutation<GuestClaimResult, Error, string>({
    mutationFn: (checkoutGroupId) => claimGuestOrders(checkoutGroupId),
    retry: false,
    onSuccess: () => {
      discardPortalToken();
      // The orders are the account's now, so its history is stale — and the
      // portal session this device held is gone.
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
      queryClient.removeQueries({ queryKey: queryKeys.guestPortal.all });
      queryClient.removeQueries({ queryKey: queryKeys.guestClaim.all });
    },
  });
}
