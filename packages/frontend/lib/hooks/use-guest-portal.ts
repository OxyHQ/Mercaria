/**
 * React Query hooks for the guest order portal (#108).
 *
 * The one thing worth reading before the code: `useMagicLinkExchange` is a
 * MUTATION driven by an explicit call rather than a query keyed on the
 * fragment. An exchange is single-use and irreversible, and React Query retries
 * failed queries — which would burn a second and third link on a transient
 * network error and leave the buyer with nothing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GuestOrderPortalView,
  GuestOrderStatusView,
  GuestPortalSessionState,
} from '@mercaria/shared-types';
import {
  createPortalConfirmation,
  exchangePortalToken,
  getPortalSession,
  getPortalStatus,
  getPortalView,
  requestPortalRecovery,
  signOutOfPortal,
} from '../api/guest-portal';
import { discardPortalToken } from '../stores/portal-credential-store';
import { queryKeys } from './query-keys';

/** Whether this browser or device currently holds a live portal session. */
export function useGuestPortalSession(enabled = true) {
  return useQuery<GuestPortalSessionState>({
    queryKey: queryKeys.guestPortal.session,
    queryFn: getPortalSession,
    enabled,
    // A 401 here is the ORDINARY state — nobody has exchanged a link yet — so
    // retrying is asking the same question of the same absent credential.
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * Exchange the token the screen read out of the URL fragment.
 *
 * `retry: false` is the load-bearing option, not a default: an exchange
 * CONSUMES the link, so a retry after a timeout the client never saw would burn
 * a second grant and the buyer would be told their link is invalid.
 */
export function useMagicLinkExchange() {
  const queryClient = useQueryClient();
  return useMutation<GuestPortalSessionState, Error, string>({
    mutationFn: (token) => exchangePortalToken(token),
    retry: false,
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.guestPortal.session, session);
      queryClient.invalidateQueries({ queryKey: queryKeys.guestPortal.all });
    },
  });
}

/** Pull the bounded confirmation credential using the guest cart session. */
export function usePortalConfirmation() {
  const queryClient = useQueryClient();
  return useMutation<GuestPortalSessionState, Error, string>({
    mutationFn: (checkoutGroupId) => createPortalConfirmation(checkoutGroupId),
    retry: false,
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.guestPortal.session, session);
    },
  });
}

/** The full order view. Enabled only once a session with `orders:read` exists. */
export function useGuestPortalView(checkoutGroupId: string | undefined, enabled: boolean) {
  return useQuery<GuestOrderPortalView>({
    queryKey: queryKeys.guestPortal.view(checkoutGroupId ?? ''),
    queryFn: () => getPortalView(checkoutGroupId ?? ''),
    enabled: enabled && Boolean(checkoutGroupId),
    retry: false,
  });
}

/** The bounded status view. */
export function useGuestPortalStatus(checkoutGroupId: string | undefined, enabled: boolean) {
  return useQuery<GuestOrderStatusView>({
    queryKey: queryKeys.guestPortal.status(checkoutGroupId ?? ''),
    queryFn: () => getPortalStatus(checkoutGroupId ?? ''),
    enabled: enabled && Boolean(checkoutGroupId),
    retry: false,
  });
}

/**
 * Ask for an access link.
 *
 * Resolves with the server's one fixed sentence whether or not anything
 * matched, and the hook deliberately exposes nothing else — a `matched` flag
 * would be the enumeration oracle the whole flow exists to close, and a UI that
 * had one would eventually render it.
 */
export function usePortalRecoveryRequest() {
  return useMutation<string, Error, { email: string; orderNumber?: string }>({
    mutationFn: requestPortalRecovery,
    retry: false,
  });
}

/** Sign out: revoke the credential server-side, then forget the native copy. */
export function usePortalSignOut() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: signOutOfPortal,
    onSettled: () => {
      // `onSettled` and not `onSuccess`: the server revokes idempotently and
      // always answers 204, so a failure here is a network one — and a client
      // that kept a credential it believes is dead is worse than one that
      // forgot a live one, which costs a fresh link at most.
      discardPortalToken();
      queryClient.removeQueries({ queryKey: queryKeys.guestPortal.all });
    },
  });
}
