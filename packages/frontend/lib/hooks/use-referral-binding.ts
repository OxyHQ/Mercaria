import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { Platform } from 'react-native';
import { useStore } from 'zustand';
import { referralCredential } from '../stores/referral-credential-store';
import type { Cart, ReferralBindingResult, ReferralClientSurface } from '@mercaria/shared-types';
import { fetchCart } from '../api/cart';
import {
  NO_REFERRAL_STATE,
  bindReferral,
  enterReferralCode,
  fetchReferralState,
} from '../api/referrals';
import { queryKeys } from './query-keys';

/**
 * Turning a followed referral link into an attribution (#143), client side.
 *
 * `GET /r/:token` hands the browser a carrier and nothing else: an anonymous
 * click has no subject to attribute to (ADR 0003 T10 — browsing creates no
 * row), so the server waits for the CLIENT to call `POST /referrals/bind` once
 * there is one. Without that call every signed-out click redirects fine and
 * pays nobody, with every gate green. A subject appears two ways:
 *
 *  - **Signing in** — the bearer makes the request the Oxy account's.
 *  - **The first cart write** — it creates the guest commerce session, and the
 *    cart coming back non-empty is the client-visible sign that one exists
 *    (the transport keeps the independent cart credential).
 *
 * WEB ONLY: a referral link opens in the browser, because the app claims no
 * universal link (docs/referral-attribution.md, "Named seams"), so a native
 * client never holds a carrier.
 */

const IS_WEB = Platform.OS === 'web';

/** The surface this client reports on a touch. */
export const REFERRAL_CLIENT_SURFACE: ReferralClientSurface =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

/** What the paid-referral disclosure shows, and whether it is owed at all. */
interface ReferralDisclosureState {
  required: boolean;
  /** The program's own buyer-facing sentence, rendered verbatim once bound. */
  termsSummary?: string;
}

const disclosureKey = ['referral-disclosure'] as const;
export function useReferralDisclosureStore<T>(selector: (state: ReferralDisclosureState) => T): T {
  const { data } = useQuery<ReferralDisclosureState>({
    queryKey: disclosureKey,
    initialData: { required: false },
    enabled: false,
  });
  return selector(data);
}
function recordDisclosure(
  client: QueryClient,
  view: {
    disclosureRequired: boolean;
    publicTermsSummary?: string;
  },
): void {
  client.setQueryData(disclosureKey, {
    required: view.disclosureRequired,
    termsSummary: view.publicTermsSummary,
  });
}

/**
 * Mounted ONCE, in `AuthSetup` beside the cart merge, because the triggers —
 * signing in, the first cart write — can happen on any screen.
 *
 * Queries rather than effects for the reason `useGuestCartMerge` gives: a key
 * per subject runs the bind exactly once per subject, deduplicated and retried,
 * and a `pending` answer leaves `holding` true so the next subject tries again.
 */
export function useReferralBinding(): void {
  const { canUsePrivateApi, user } = useOxy();
  const queryClient = useQueryClient();

  const carrierRevision = useStore(referralCredential.store, (state) => state.revision);
  const carrier = useQuery({
    queryKey: [...queryKeys.referrals.state, carrierRevision],
    queryFn: async () => {
      const view = await fetchReferralState();
      // A held carrier is proof a link was followed, so the disclosure is owed
      // before any bind. Nothing held says nothing about what a bind said.
      if (view.disclosureRequired) recordDisclosure(queryClient, view);
      return view;
    },
    enabled: IS_WEB,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  const holding = carrier.data?.state === 'pending';

  // The SAME key and fetcher as `useCart`, so this shares its cache: an
  // add-to-cart writes the fresh cart there and this sees it at once. Read only
  // while a carrier is held, so an ordinary visit costs nothing extra.
  const cart = useQuery<Cart>({
    queryKey: queryKeys.cart.all,
    queryFn: fetchCart,
    enabled: holding,
    staleTime: 1000 * 60,
  });

  const subject =
    canUsePrivateApi && user?.id
      ? `oxy:${user.id}`
      : (cart.data?.items.length ?? 0) > 0
        ? 'guest'
        : null;

  useQuery({
    queryKey: queryKeys.referrals.bind(subject ?? ''),
    queryFn: async () => {
      const result = await bindReferral();
      // Anything but `pending` means the server redeemed or dropped the
      // carrier: nothing is left to bind, and what the bind said is now the
      // disclosure. `pending` keeps the carrier and waits for the next subject.
      if (result.state !== 'pending') {
        recordDisclosure(queryClient, result);
        queryClient.setQueryData(queryKeys.referrals.state, NO_REFERRAL_STATE);
      }
      return result;
    },
    enabled: holding && subject !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}

/**
 * A referral code the buyer types in Settings — the `in_app` moment of ADR 0005
 * D4. It needs a subject, so the page offers it only when signed in.
 */
export function useEnterReferralCode() {
  const queryClient = useQueryClient();
  return useMutation<ReferralBindingResult, Error, string>({
    mutationFn: (code) => enterReferralCode({ code, surface: REFERRAL_CLIENT_SURFACE }),
    onSuccess: (result) => {
      // A refused code changes nothing, so it must not hide a link's notice.
      if (result.state === 'attributed' || result.state === 'recorded_not_attributed') {
        recordDisclosure(queryClient, result);
      }
    },
  });
}
