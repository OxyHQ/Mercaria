import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@oxy.so/bloom/button';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { PriceSummary } from '@oxy.so/bloom/price-breakdown';
import { nanoid } from 'nanoid/non-secure';
import type {
  CartGroup,
  CheckoutPaymentHandoff,
  CheckoutPaymentStatus,
  ApiErrorDetails,
  Money,
  RefusedCheckoutSeller,
} from '@mercaria/shared-types';
import {
  SectionHeader,
  Text,
  useFormatters,
  usePriceText,
  CommercialDisclosure,
  commercialSellerLabel,
  type Translate,
} from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { useCart } from '@/lib/hooks/use-cart';
import { useCheckoutPaymentStatus } from '@/lib/hooks/use-checkout';
import { usePortalConfirmation } from '@/lib/hooks/use-guest-portal';
import { useTranslation } from '@/lib/i18n';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api/client';
import { PrepareCartPayment } from '@/components/payment/PrepareCartPayment';
import type { CheckoutSelection } from '@/lib/payments/checkout-preparation';
import type { CheckoutResult } from '@mercaria/shared-types';

/** The stable seller-group key, matching the backend (`store:<id>` / `user:<id>`). */
function groupKey(group: CartGroup): string {
  return group.sellerKey;
}

/**
 * The seller keys `?seller=` names — one, several (comma-separated), or none.
 *
 * A LIST because a mixed cart has to be separable (#112): a guest whose cart
 * holds both a shop and a person can check out the shop's group, and the cart
 * sends the keys that are actually checkout-able rather than the whole cart the
 * server would then refuse. A single key parses to a one-element list, so every
 * link that existed before behaves exactly as it did.
 */
function parseSellerKeys(seller: string | undefined): string[] {
  if (!seller) return [];
  return seller
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/** Sum the subtotals of the groups being checked out (all share one currency). */
function sumSubtotals(groups: CartGroup[]): Money | null {
  if (groups.length === 0) return null;
  const currency = groups[0].subtotal.currency;
  const amount = groups.reduce((acc, g) => acc + g.subtotal.amount, 0);
  return { amount, currency };
}

/** No group refused — a stable empty set, so the summary does not re-render for nothing. */
const NO_UNPAYABLE_SELLERS: ReadonlySet<string> = new Set();

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

function SignInBenefit() {
  const { openAccountDialog } = useOxy();
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground">{t('checkout.signIn.title')}</Text>
      <Text className="mt-1 text-sm text-muted-foreground">{t('checkout.signIn.body')}</Text>
      <Button
        appearance="outline"
        tone="neutral"
        className="mt-3 self-start"
        onPress={() => openAccountDialog()}
      >
        {t('checkout.signIn.action')}
      </Button>
    </View>
  );
}

/**
 * What is being bought, per seller, and the subtotal.
 *
 * The figures are Bloom's `price-breakdown`: each group's lines are a
 * `PriceSummary` of rows, and the subtotal is a `PriceSummary` total under the
 * rule. Every amount is a STRING from `usePriceText` — the formatter
 * `PriceDisplay` draws — so the primary figure and its `≈` secondary are
 * exactly what `PriceDisplay` showed here before (`amount` /
 * `secondaryAmount`). Bloom adds nothing up and converts nothing.
 */
function OrderSummaryCard({
  groups,
  unpayableSellerKeys,
  refusalReason,
}: {
  groups: CartGroup[];
  /** Groups the last checkout refused because of their seller. */
  unpayableSellerKeys: ReadonlySet<string>;
  /** Why those groups were refused: cannot be paid, or not accepting orders. */
  refusalReason: ApiErrorDetails['reason'];
}) {
  const { t } = useTranslation();
  const priceText = usePriceText();
  const subtotal = sumSubtotals(groups);
  const subtotalText = subtotal ? priceText(subtotal) : null;
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t('checkout.summary.title')}
      </Text>
      <View className="gap-4">
        {groups.map((group) => {
          const unpayable = unpayableSellerKeys.has(group.sellerKey);
          return (
            <View
              key={groupKey(group)}
              className={
                unpayable
                  ? 'gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3'
                  : 'gap-2'
              }
            >
              {unpayable ? (
                <Text className="text-xs font-semibold text-destructive">
                  {t(
                    refusalReason === 'seller_not_activated'
                      ? 'checkout.summary.notAcceptingOrders'
                      : 'checkout.summary.cannotAcceptPayment',
                  )}
                </Text>
              ) : null}
              {/*
              #129 checkout rule 1: the customer-facing SELLER for every order
              group, before payment. From the group's commercial presentation
              and never from `vendor.name`, which names whose CATALOGUE the
              lines came from — a different party on anything Mercaria sells
              itself.
            */}
              <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {commercialSellerLabel(t, group.commercial)}
              </Text>
              {/*
              And what that means: the payment destination, the fulfilment
              disclosure and the return and warranty windows, spelled out rather
              than chipped, because this is the last screen before money moves
              (#129 checkout rules 5 and 6).
            */}
              <CommercialDisclosure presentation={group.commercial} showExplanations />
              <PriceSummary
                accessibilityLabel={commercialSellerLabel(t, group.commercial)}
                lines={group.items.map((item) => {
                  const line = priceText(item.lineTotal);
                  return {
                    id: item.variantId,
                    label: item.title,
                    sublabel: `${item.variantTitle} · ×${item.quantity}`,
                    amount: line.primary,
                    secondaryAmount: line.secondary ?? undefined,
                  };
                })}
              />
            </View>
          );
        })}
        {subtotalText ? (
          <PriceSummary
            accessibilityLabel={t('checkout.summary.title')}
            lines={[]}
            total={{
              label: t('checkout.summary.subtotal'),
              amount: subtotalText.primary,
              secondaryAmount: subtotalText.secondary ?? undefined,
              note: t('checkout.summary.calculatedAtPlacement'),
            }}
          />
        ) : (
          <Text className="text-xs text-muted-foreground">
            {t('checkout.summary.calculatedAtPlacement')}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * The payment step — the second half of checkout, and the only place a buyer is
 * told what happened to their money.
 *
 * ## Every state here is REPORTED, never assumed
 *
 * `status` comes from the server's payment-status endpoint, which answers from
 * the payment aggregate — a value only a verified provider webhook can move. The
 * card step's own result decides only whether to show an error or keep asking.
 * That is why a client cannot forge a paid order, and it is why "we are
 * confirming your payment" is a real state with its own screen rather than an
 * optimistic success message.
 *
 * `requires_action` and `processing` are shown as the same honest sentence: from
 * the buyer's side both mean the bank has not finished, and inventing a
 * difference would be describing a provider's internals to somebody who cannot
 * act on them.
 *
 * A `failed` payment is a declined attempt the buyer can recover from: the
 * gateway returns the intent to "needs a payment method", and Peable's sheet
 * takes the buyer back to the card.
 *
 * ## The payment itself is Peable's sheet
 *
 * `PeablePaymentSheet` opens over this screen the moment the orders exist and
 * stays mounted across every status below, so the buyer sees the payment end in
 * the sheet before this screen says so. Closed early, it reopens from Pay.
 */
function PaymentScreen({
  payment,
  status,
  awaiting,
  error,
  isGuest,
  orderNumbers,
  onLeave,
  onDone,
  onPay,
}: {
  payment: CheckoutPaymentHandoff;
  checkoutGroupId: string;
  status: CheckoutPaymentStatus['status'] | undefined;
  awaiting: boolean;
  error: string | null;
  isGuest: boolean;
  orderNumbers: string[];
  onLeave: () => void;
  onDone: () => void;
  onPay: () => void;
}) {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const router = useRouter();
  if (status === 'succeeded') {
    return (
      // A live region: this screen changes under the buyer while they are not
      // touching it (the poll answers), so a screen reader has to be told rather
      // than waiting to be asked.
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t('payment.received.title')} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t('payment.received.body')}</Text>
          {isGuest ? (
            /*
              A guest is still NOT sent to `/orders/...`: that route is
              account-authenticated and would answer 401 for the person who just
              paid (#107 client rule 8). What #108 added is the honest
              destination — a grant-scoped portal reached with a credential this
              device pulls for the group it just placed, which is a DIFFERENT
              credential from the cart token and carries only the bounded status
              view until the buyer confirms their address (ADR 0003 D17).

              The order number stays, and stays first: it is the thing a support
              conversation starts from, it works when a link does not, and — as
              ADR 0003 T6 says outright — it authorizes nothing, so printing it
              costs nothing either.
            */
            <>
              <View className="rounded-2xl border border-border bg-card p-4">
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {orderNumbers.length > 1
                    ? t('checkout.orderNumbers.headingOther')
                    : t('checkout.orderNumbers.headingOne')}
                </Text>
                <Text className="mt-1 text-base font-bold text-foreground" selectable>
                  {orderNumbers.join('  ·  ')}
                </Text>
                <Text className="mt-2 text-sm text-muted-foreground">
                  {t('checkout.orderNumbers.keepToHand')}
                </Text>
              </View>
              <Button appearance="outline" tone="neutral" onPress={onDone}>
                {t('checkout.keepShopping')}
              </Button>
              <Button
                appearance="outline"
                tone="neutral"
                onPress={() => router.push('/guest-orders/recover')}
              >
                {t('checkout.emailMeLink')}
              </Button>
            </>
          ) : (
            <Button tone="accent" onPress={onDone}>
              {t('checkout.viewOrder')}
            </Button>
          )}
        </View>
      </View>
    );
  }

  if (status === 'canceled') {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t('payment.cancelled.title')} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            {t('payment.cancelled.bodyItemsReturned')}
          </Text>
          <Button appearance="outline" tone="neutral" onPress={onDone}>
            {isGuest ? t('checkout.keepShopping') : t('checkout.backToOrders')}
          </Button>
        </View>
      </View>
    );
  }

  if (
    status === 'requires_action' ||
    status === 'processing' ||
    (awaiting && status !== 'failed')
  ) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t('payment.confirming.title')} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            {status === 'requires_action' || status === 'processing'
              ? t('payment.confirming.bankStillCompleting')
              : t('payment.confirming.checkingWithBank')}
          </Text>
          <Button appearance="outline" tone="neutral" onPress={onDone}>
            {isGuest ? t('checkout.keepShopping') : t('checkout.checkLaterFromOrders')}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="px-4">
      <SectionHeader title={t('payment.title')} />
      <View className="gap-4">
        <View className="flex-row items-baseline justify-between">
          <Text className="text-sm text-muted-foreground">{t('payment.totalToPay')}</Text>
          {/*
            `formatMoney` and NOT `PriceDisplay`: this figure is what the rail
            will actually charge, in the currency the payment was created in.
            `PriceDisplay` converts into whatever the shopper is browsing in,
            which is right for a catalogue price and wrong here — a buyer must
            see the amount their bank will show them (issue #47, client 4).
          */}
          <Text className="text-lg font-bold text-foreground">{formatMoney(payment.amount)}</Text>
        </View>
        {error ? (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4"
          >
            <Text className="text-sm text-foreground">{error}</Text>
          </View>
        ) : null}
        <Button tone="accent" onPress={onPay} accessibilityLabel={t('payment.card.payNow')}>
          {t('payment.card.payNow')}
        </Button>
        <Button appearance="outline" tone="neutral" onPress={onLeave}>
          {t('common.back')}
        </Button>
        <Text className="text-xs text-muted-foreground">{t('payment.cardDetailsNotice')}</Text>
      </View>
      <View className="h-24" />
    </View>
  );
}

function CheckoutBody() {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const { seller, pickup } = useLocalSearchParams<{ seller?: string; pickup?: string }>();
  const { isAuthenticated } = useOxy();
  const { data: cart, isLoading } = useCart();
  const portalConfirmation = usePortalConfirmation();
  const [active, setActive] = useState<{ id: string; selection: CheckoutSelection } | null>(null);
  const submitted = useRef(false);
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<CheckoutResult | null>(null);
  const [refusedKeys, setRefusedKeys] = useState<ReadonlySet<string>>(NO_UNPAYABLE_SELLERS);
  const [refusalReason, setRefusalReason] = useState<ApiErrorDetails['reason']>(
    'seller_not_payment_ready',
  );
  const [awaiting, setAwaiting] = useState(false);
  const status = useCheckoutPaymentStatus(placed?.checkoutGroupId, placed !== null);
  const sellerKeys = useMemo(() => parseSellerKeys(seller), [seller]);
  const groups = useMemo(
    () =>
      (cart?.groups ?? []).filter(
        (group) => sellerKeys.length === 0 || sellerKeys.includes(groupKey(group)),
      ),
    [cart, sellerKeys],
  );
  // A refreshed cart is a different checkout; discard the old private draft and abort its callback.
  // Our own successful placement sets `placed` before invalidating the cart.
  useEffect(() => {
    if (!active || placed || submitted.current || !cart) return;
    const previous = JSON.stringify(active.selection.groups);
    if (previous !== JSON.stringify(groups) || active.selection.currency !== cart.currency) {
      setOpen(false);
      setActive(null);
    }
  }, [active, placed, cart, groups]);
  const leave = (result = placed) => {
    if (!result) return;
    if (!isAuthenticated) {
      portalConfirmation.mutate(result.checkoutGroupId, {
        onSettled: () =>
          router.replace({
            pathname: '/guest-orders/portal',
            params: { group: result.checkoutGroupId },
          }),
      });
    } else {
      const first = result.orders[0];
      router.replace(first ? { pathname: '/orders/[id]', params: { id: first.id } } : '/orders');
    }
  };
  return (
    <>
      {placed?.payment ? (
        <PaymentScreen
          payment={placed.payment}
          checkoutGroupId={placed.checkoutGroupId}
          status={status.data?.status}
          awaiting={awaiting}
          error={null}
          isGuest={!isAuthenticated}
          orderNumbers={placed.orders.map((order) => order.orderNumber)}
          onPay={() => setOpen(true)}
          onLeave={() => leave()}
          onDone={() => leave()}
        />
      ) : isLoading && !cart ? (
        <View className="h-40 bg-muted" />
      ) : groups.length === 0 && !active ? (
        <EmptyState
          title={t('checkout.empty.title')}
          description={t('checkout.empty.body')}
          action={{ label: t('checkout.empty.backToCart'), onPress: () => router.replace('/cart') }}
        />
      ) : (
        <View className="gap-5 px-4">
          <SectionHeader title={t('checkout.title')} />
          {isAuthenticated ? null : <SignInBenefit />}
          <OrderSummaryCard
            groups={active ? [...active.selection.groups] : groups}
            unpayableSellerKeys={refusedKeys}
            refusalReason={refusalReason}
          />
          <Button
            tone="accent"
            onPress={() => {
              if (!active && cart)
                setActive({
                  id: nanoid(),
                  selection: {
                    groups,
                    sellerKeys,
                    currency: cart.currency,
                    ...(pickup ? { pickupLocationId: pickup } : {}),
                  },
                });
              setOpen(true);
            }}
          >
            {t('payment.card.payNow')}
          </Button>
        </View>
      )}
      {active ? (
        <PrepareCartPayment
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
          onSubmitting={() => {
            submitted.current = true;
          }}
          onCreated={(result) => {
            setPlaced(result);
            if (!result.payment) leave(result);
          }}
          onSettled={() => setAwaiting(true)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export default function CheckoutScreen() {
  const { t } = useTranslation();
  const { user, isAuthenticated } = useOxy();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>{t('checkout.pageTitle')}</title>
      </Head>
      <CheckoutBody key={isAuthenticated ? user?.id : 'guest'} />
    </ScreenShell>
  );
}
