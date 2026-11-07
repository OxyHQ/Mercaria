import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { View } from 'react-native';
import { nanoid } from 'nanoid/non-secure';
import type {
  Cart,
  CartGroup,
  CheckoutResult,
  ApiErrorDetails,
  RefusedCheckoutSeller,
} from '@mercaria/shared-types';
import { commercialSellerLabel, type Translate } from '@mercaria/ui';
import { useCart } from '@/lib/hooks/use-cart';
import { useGuestCredentialStore } from '@/lib/stores/guest-credential-store';
import { useCheckoutPaymentStatus } from '@/lib/hooks/use-checkout';
import { usePortalConfirmation } from '@/lib/hooks/use-guest-portal';
import { useTranslation } from '@/lib/i18n';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api/client';
import type { CheckoutSelection } from '@/lib/payments/checkout-preparation';
import { PrepareCartPayment } from './PrepareCartPayment';

/** Names joined the reader's way ("A, B and C"); a plain comma list where the engine has no `Intl.ListFormat`. */
function formatNameList(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/**
 * The sentences a seller refusal is told in, per reason. KEYS, as full literals,
 * so `validate:i18n-strings` sees every one.
 */
const SELLER_REFUSAL_COPY = {
  seller_not_payment_ready: {
    one: 'checkout.error.sellerNotPaymentReady',
    several: 'checkout.error.sellersNotPaymentReady',
    unnamed: 'checkout.error.unnamedSellersNotPaymentReady',
  },
  seller_not_activated: {
    one: 'checkout.error.sellerNotActivated',
    several: 'checkout.error.sellersNotActivated',
    unnamed: 'checkout.error.unnamedSellersNotActivated',
  },
} as const satisfies Record<SellerRefusalReason, Record<string, string>>;

/**
 * The refusals this screen tells in its own words. Every other refusal that
 * names sellers (ADR 0019's payment-rail refusals) carries a reason the server
 * words, and is shown as its message with the sellers highlighted.
 */
type SellerRefusalReason = 'seller_not_payment_ready' | 'seller_not_activated';

function isSellerRefusalReason(reason: ApiErrorDetails['reason']): reason is SellerRefusalReason {
  return reason === 'seller_not_payment_ready' || reason === 'seller_not_activated';
}

/**
 * The refusal for sellers who cannot be paid right now — or are not accepting
 * orders right now — in the buyer's language.
 *
 * Rendered HERE from the refusal's `details` rather than shown as the server's
 * sentence, which is English. Each seller is named by the name the server read
 * (a store's name, a private seller's display name) or, failing that, by the
 * label this screen already shows over their items. Never by `sellerKey`: that
 * is a machine id, and it only selects which groups to highlight.
 */
function refusedSellersMessage(
  t: Translate,
  locale: string,
  reason: SellerRefusalReason,
  sellers: readonly RefusedCheckoutSeller[],
  groups: readonly CartGroup[],
): string {
  const copy = SELLER_REFUSAL_COPY[reason];
  const names = sellers.map(
    (seller) =>
      seller.name ??
      groups
        .filter((group) => group.sellerKey === seller.sellerKey)
        .map((group) => commercialSellerLabel(t, group.commercial))
        .find((label) => label.length > 0),
  );
  const named = names.filter((name): name is string => name !== undefined);
  if (named.length === 0 || named.length !== names.length) {
    return t(copy.unnamed);
  }
  if (named.length === 1) {
    return t(copy.one, { seller: named[0] });
  }
  return t(copy.several, { sellers: formatNameList(named, locale) });
}

interface CartPaymentActions {
  begin: (cart: Cart, sellerKeys?: readonly string[], pickupLocationId?: string) => void;
  resume: () => void;
  resumeSubmitted: () => boolean;
  pending: boolean;
  refusedKeys: ReadonlySet<string>;
  refusalReason: ApiErrorDetails['reason'];
}
const CartPaymentContext = createContext<CartPaymentActions | null>(null);
export function useCartPayment() {
  const value = useContext(CartPaymentContext);
  if (!value) throw new Error('CartPaymentProvider is required');
  return value;
}

/** One owner for payment attempts across cart, Buy now and legacy entry links. */
export function CartPaymentProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, activeSessionId } = useOxy();
  const guestAuthority = useGuestCredentialStore((state) => state.authorityRevision);
  return (
    <AccountCartPayment
      key={isAuthenticated ? `${user?.id}:${activeSessionId}` : `guest:${guestAuthority}`}
    >
      {children}
    </AccountCartPayment>
  );
}
function AccountCartPayment({ children }: { children: ReactNode }) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const publicIntent = useGlobalSearchParams<{ pay?: string; seller?: string; pickup?: string }>();
  const { isAuthenticated } = useOxy();
  const { data: cart } = useCart();
  const portalConfirmation = usePortalConfirmation();
  const [active, setActive] = useState<{ id: string; selection: CheckoutSelection } | null>(null);
  const submitted = useRef(false);
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<CheckoutResult | null>(null);
  const [refusedKeys, setRefusedKeys] = useState<ReadonlySet<string>>(new Set());
  const [refusalReason, setRefusalReason] = useState<ApiErrorDetails['reason']>(
    'seller_not_payment_ready',
  );
  const status = useCheckoutPaymentStatus(placed?.checkoutGroupId, placed !== null);
  useEffect(() => {
    if (!active || placed || submitted.current || !cart) return;
    const groups = cart.groups.filter((group) =>
      active.selection.sellerKeys.includes(group.sellerKey),
    );
    if (
      JSON.stringify(active.selection.groups) !== JSON.stringify(groups) ||
      active.selection.currency !== cart.currency
    ) {
      setOpen(false);
      setActive(null);
    }
  }, [active, placed, cart]);
  const leave = (result: CheckoutResult) => {
    setOpen(false);
    setActive(null);
    setPlaced(null);
    submitted.current = false;
    if (!isAuthenticated) {
      portalConfirmation.mutate(result.checkoutGroupId, {
        onSettled: () =>
          router.push({
            pathname: '/guest-orders/portal',
            params: { group: result.checkoutGroupId },
          }),
      });
    } else {
      const first = result.orders[0];
      router.push(first ? { pathname: '/orders/[id]', params: { id: first.id } } : '/orders');
    }
  };
  const resume = () => {
    if (placed && (status.data?.status === 'succeeded' || status.data?.status === 'canceled'))
      leave(placed);
    else setOpen(true);
  };
  return (
    <CartPaymentContext.Provider
      value={{
        pending: active !== null,
        refusedKeys,
        refusalReason,
        resume,
        resumeSubmitted: () => {
          if (!submitted.current) return false;
          resume();
          return true;
        },
        begin: (snapshot, sellerKeys = [], pickupLocationId) => {
          // Never replace an ambiguous/submitted attempt with a new order key.
          if (submitted.current) {
            resume();
            return;
          }
          const groups = snapshot.groups.filter(
            (group) =>
              group.guestCheckout?.status !== 'blocked' &&
              (!sellerKeys.length || sellerKeys.includes(group.sellerKey)),
          );
          if (!groups.length) return;
          submitted.current = false;
          setPlaced(null);
          setRefusedKeys(new Set());
          setActive({
            id: nanoid(),
            selection: {
              groups,
              sellerKeys: groups.map((group) => group.sellerKey),
              currency: snapshot.currency,
              ...(pickupLocationId ? { pickupLocationId } : {}),
            },
          });
          setOpen(true);
        },
      }}
    >
      {children}
      {active ? (
        <PrepareCartPayment
          key={active.id}
          selection={active.selection}
          attemptId={active.id}
          open={open}
          status={status.data?.status}
          onRefused={(error) => {
            const details = apiErrorDetails(error);
            if (details?.sellers.length) {
              setRefusedKeys(new Set(details.sellers.map((entry) => entry.sellerKey)));
              setRefusalReason(details.reason);
              if (isSellerRefusalReason(details.reason))
                return refusedSellersMessage(
                  t,
                  locale,
                  details.reason,
                  details.sellers,
                  active.selection.groups,
                );
            }
            return apiErrorMessage(error, t('payment.sheet.unreadable'));
          }}
          onRejectedBeforeCreation={() => {
            submitted.current = false;
          }}
          onSubmitting={() => {
            submitted.current = true;
          }}
          onCreated={(result) => {
            // The order now owns its immutable destination. Remove only the
            // public intent that opened THIS selection, preserving all other params.
            if (
              publicIntent.pay === '1' &&
              typeof publicIntent.seller === 'string' &&
              publicIntent.pickup &&
              publicIntent.pickup === active.selection.pickupLocationId &&
              JSON.stringify(
                publicIntent.seller
                  ?.split(',')
                  .map((key) => key.trim())
                  .filter(Boolean)
                  .sort(),
              ) === JSON.stringify([...active.selection.sellerKeys].sort())
            ) {
              router.setParams({ pay: undefined, seller: undefined, pickup: undefined });
            }
            setPlaced(result);
            if (!result.payment) leave(result);
          }}
          onSettled={() => {
            /* Only the merchant's authoritative status can finish an order. */
          }}
          onClose={() => {
            setOpen(false);
            if (
              placed &&
              (status.data?.status === 'succeeded' || status.data?.status === 'canceled')
            )
              leave(placed);
          }}
        />
      ) : null}
    </CartPaymentContext.Provider>
  );
}

/** Closing the sheet never discards a pending payment or claims it succeeded. */
export function CartPaymentRecovery() {
  const { pending, resume } = useCartPayment();
  const { t } = useTranslation();
  return pending ? (
    <View className="px-4 pb-4">
      <Button onPress={resume}>{t('payment.card.payNow')}</Button>
    </View>
  ) : null;
}
