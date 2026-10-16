import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { create } from 'zustand';
import type {
  Cart,
  ReferralBindingResult,
  ReferralClientSurface,
  ReferralConsentAnswer,
  ReferralStateView,
} from '@mercaria/shared-types';
import { fetchCart } from '../api/cart';
import {
  NO_REFERRAL_STATE,
  answerReferralConsent,
  bindReferral,
  enterReferralCode,
  fetchReferralState,
} from '../api/referrals';
import { queryKeys } from './query-keys';

/**
 * Turning a followed referral link into an attribution (#143), client side —
 * and asking first.
 *
 * ## Consent first (ePrivacy Art. 5(3))
 *
 * `GET /r/:token` stores nothing on the device: it sends the browser on with
 * the click's signed carrier in the URL FRAGMENT (`#mercaria_ref=mrf_…`). This
 * module takes it out of the fragment the moment it loads, strips it from the
 * address bar, and holds it in MEMORY only — never localStorage,
 * sessionStorage or a cookie. While it is held the buyer is asked
 * (`ReferralDisclosureNotice`), and nothing is bound, whoever they are:
 *
 *  - **Allow** → `POST /referrals/consent` with the carrier on the header. A
 *    request with a subject is attributed there and then; an anonymous one
 *    gets the carrier back as an `HttpOnly` cookie and `pending`, and the bind
 *    below takes over.
 *  - **No thanks** → `POST /referrals/consent` `denied` (so an older carrier
 *    cookie is cleared too), and the in-memory carrier is dropped.
 *
 * ## Binding a consented carrier
 *
 * An anonymous click has no subject to attribute to (ADR 0003 T10 — browsing
 * creates no row), so the server waits for the CLIENT to call
 * `POST /referrals/bind` once there is one. Without that call every signed-out
 * click pays nobody, with every gate green. A subject appears two ways:
 *
 *  - **Signing in** — the bearer makes the request the Oxy account's.
 *  - **The first cart write** — it creates the guest commerce session, and the
 *    cart coming back non-empty is the client-visible sign that one exists
 *    (the web credential is an `HttpOnly` cookie this code cannot see).
 *
 * `GET /referrals/state` is how a LATER visit learns an earlier consented
 * carrier is still pending; it is not asked while a fresh carrier awaits an
 * answer.
 *
 * WEB ONLY: a referral link opens in the browser, because the app claims no
 * universal link (docs/referral-attribution.md, "Named seams"), so a native
 * client never holds a carrier.
 */

const IS_WEB = Platform.OS === 'web';

/** The fragment key the API's redirect puts the carrier under. */
const REFERRAL_FRAGMENT_KEY = 'mercaria_ref';

/** The carrier's whole alphabet, as the server mints it. Anything else is ignored. */
const CARRIER_SHAPE = /^mrf_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The surface this client reports on a touch. */
export const REFERRAL_CLIENT_SURFACE: ReferralClientSurface =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

/**
 * Take the carrier out of the URL fragment, ONCE, and strip it from the
 * address bar so it is not bookmarked, shared or kept in history.
 *
 * Runs when this module is first evaluated — before the router renders — so no
 * navigation can drop the fragment first. Any other fragment content survives.
 */
function takeFragmentCarrier(): string | null {
  if (!IS_WEB || typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const carrier = params.get(REFERRAL_FRAGMENT_KEY);
  if (carrier === null) return null;
  stripFragmentCarrier();
  return carrier.length <= 1_024 && CARRIER_SHAPE.test(carrier) ? carrier : null;
}

/** The fragment minus the carrier — `undefined` when nothing else was in it. */
function fragmentWithoutCarrier(hash: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete(REFERRAL_FRAGMENT_KEY);
  return params.toString() || undefined;
}

/** Remove the carrier from the address bar, keeping path, query and any other fragment. */
function stripFragmentCarrier(): void {
  const { hash, pathname, search } = window.location;
  if (!new URLSearchParams(hash.slice(1)).has(REFERRAL_FRAGMENT_KEY)) return;
  const rest = fragmentWithoutCarrier(hash);
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${search}${rest ? `#${rest}` : ''}`,
    );
  } catch {
    // A sandboxed frame may refuse; the carrier is still only in memory.
  }
}

/**
 * Expo Router read the initial URL — fragment included — into the focused
 * route's `#` param before this ran, and writes it back to the address bar when
 * it mounts. So the router's copy is cleared too, once it is ready; the direct
 * strip after it is the belt to that brace.
 */
function useStripRouterFragment(): void {
  useEffect(() => {
    if (!IS_WEB || !CARRIED_IN_FRAGMENT) return;
    const timer = setTimeout(() => {
      try {
        // `''`, not `undefined`: the router stringifies an undefined param to
        // `#undefined`, while an empty one writes no fragment at all.
        router.setParams({ '#': fragmentWithoutCarrier(INITIAL_FRAGMENT) ?? '' });
      } catch {
        // Not ready, or no route to set on: the direct strip below still runs.
      }
      setTimeout(stripFragmentCarrier, 0);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
}

/** The fragment as the page was opened, read before anything rewrites it. */
const INITIAL_FRAGMENT = IS_WEB && typeof window !== 'undefined' ? window.location.hash : '';
const CARRIED_IN_FRAGMENT = new URLSearchParams(INITIAL_FRAGMENT.slice(1)).has(
  REFERRAL_FRAGMENT_KEY,
);

/** The carrier awaiting the buyer's answer — in memory, and nowhere else. */
interface ReferralConsentState {
  carrier: string | null;
  /** The buyer answered (or the answer was recorded): forget the carrier. */
  settle: () => void;
}

export const useReferralConsentStore = create<ReferralConsentState>((set) => ({
  carrier: takeFragmentCarrier(),
  settle: () => set({ carrier: null }),
}));

/** What the paid-referral disclosure shows, and whether it is owed at all. */
interface ReferralDisclosureState {
  required: boolean;
  /** The program's own buyer-facing sentence, rendered verbatim once bound. */
  termsSummary?: string;
  record: (view: { disclosureRequired: boolean; publicTermsSummary?: string }) => void;
}

/**
 * A store rather than a query, because several writers feed one notice: the
 * state read, a consent answer, a bind and a typed code — and the notice must
 * keep showing what a bind said after the carrier it redeemed is gone.
 */
export const useReferralDisclosureStore = create<ReferralDisclosureState>((set) => ({
  required: false,
  record: (view) =>
    set({ required: view.disclosureRequired, termsSummary: view.publicTermsSummary }),
}));

function recordDisclosure(view: {
  disclosureRequired: boolean;
  publicTermsSummary?: string;
}): void {
  useReferralDisclosureStore.getState().record(view);
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
  useStripRouterFragment();
  // While a fresh carrier awaits an answer, nothing below runs: no state read,
  // no cart read, and — whoever is signed in — no bind.
  const undecided = useReferralConsentStore((state) => state.carrier !== null);

  const carrier = useQuery({
    queryKey: queryKeys.referrals.state,
    queryFn: async () => {
      const view = await fetchReferralState();
      // A held carrier is proof a link was followed, so the disclosure is owed
      // before any bind. Nothing held says nothing about what a bind said.
      if (view.disclosureRequired) recordDisclosure(view);
      return view;
    },
    enabled: IS_WEB && !undecided,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  const holding = !undecided && carrier.data?.state === 'pending';

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
        recordDisclosure(result);
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

/** The state a consented-but-unbound carrier leaves: the server holds it as a cookie. */
const CONSENTED_PENDING: ReferralStateView = { state: 'pending', disclosureRequired: true };

/**
 * The buyer's answer to the consent prompt.
 *
 * `denied` takes effect locally at once — the carrier is forgotten before the
 * request even leaves, so a refusal never waits on the network — and the call
 * itself only clears any older carrier cookie. `granted` keeps the carrier
 * until the server has answered, so a failed call can be retried from the same
 * prompt.
 */
export function useReferralConsent() {
  const queryClient = useQueryClient();
  return useMutation<ReferralBindingResult, Error, ReferralConsentAnswer>({
    mutationFn: (consent) =>
      answerReferralConsent({
        consent,
        carrier: consent === 'granted' ? useReferralConsentStore.getState().carrier : null,
      }),
    onMutate: (consent) => {
      if (consent !== 'denied') return;
      queryClient.setQueryData(queryKeys.referrals.state, NO_REFERRAL_STATE);
      recordDisclosure({ disclosureRequired: false });
      useReferralConsentStore.getState().settle();
    },
    onSuccess: (result, consent) => {
      if (consent !== 'granted') return;
      if (result.state === 'pending') {
        // Anonymous: the server now holds the carrier as a cookie, and the bind
        // in `useReferralBinding` redeems it when a subject appears.
        queryClient.setQueryData(queryKeys.referrals.state, CONSENTED_PENDING);
        recordDisclosure(CONSENTED_PENDING);
      } else {
        // Bound there and then (a subject was present), or the carrier was no
        // longer usable. Either way nothing is left to hold.
        queryClient.setQueryData(queryKeys.referrals.state, NO_REFERRAL_STATE);
        recordDisclosure(result);
      }
      useReferralConsentStore.getState().settle();
    },
  });
}

/**
 * A referral code the buyer types in Settings — the `in_app` moment of ADR 0005
 * D4. It needs a subject, so the page offers it only when signed in.
 */
export function useEnterReferralCode() {
  return useMutation<ReferralBindingResult, Error, string>({
    mutationFn: (code) => enterReferralCode({ code, surface: REFERRAL_CLIENT_SURFACE }),
    onSuccess: (result) => {
      // A refused code changes nothing, so it must not hide a link's notice.
      if (result.state === 'attributed' || result.state === 'recorded_not_attributed') {
        recordDisclosure(result);
      }
    },
  });
}
