/**
 * The card step on the WEB — Peable's Elements (ADR 0009 D13): the Express
 * Checkout element for wallets above the Payment Element, both the acquirer's
 * own secure frames, mounted from `@peable.to/sdk/checkout`.
 *
 * This is the default file, so it is also what a non-Metro bundler resolves;
 * `CardPaymentStep.native.tsx` beside it serves iOS and Android. See `types.ts`
 * for the contract that keeps the split from reaching the checkout screens.
 *
 * ## What the buyer's client is given, and what it fetches itself
 *
 * The handoff carries Peable's own PaymentIntent (`providerPaymentId`) and ITS
 * `client_secret` — nothing of the acquirer's. `createPeableElements` exchanges
 * those for the acquirer's credential and publishable key at the gateway
 * (`POST /v1/payment_intents/:id/client_action`) inside the SDK, so no acquirer
 * secret or key passes through Mercaria or this component.
 *
 * ## ONE component for both actor kinds
 *
 * ADR 0006 G1/G2: a guest and an account holder get the same surfaces, in the
 * same order, from the same handoff. There is deliberately no guest branch.
 *
 * ## Card details never touch Mercaria
 *
 * Every field is a provider frame from the provider's origin; the values never
 * enter this bundle's memory (PCI SAQ-A). There is no `<Input>` here.
 *
 * ## Nothing here decides success
 *
 * `confirmPayment` resolving means the gateway has an answer or has not decided
 * yet; either way the step calls `onCompleted` and the screen POLLS Mercaria's
 * payment-status endpoint, which answers from the payment aggregate only a
 * verified gateway event moves. A confirmation that needs 3-D Secure leaves the
 * page for the buyer's bank and comes back to `/checkout/return`, which polls
 * the same endpoint — the return proves nothing (ADR 0006 G10).
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  EXPRESS_CHECKOUT_OPTIONS,
  availableWallets,
  createPeableElements,
  type PeableElement,
  type PeableElements,
  type ProviderFieldEvent,
} from '@peable.to/sdk/checkout';
import { Text } from '@mercaria/ui';
import { track } from '@/lib/analytics';
import { PEABLE_GATEWAY_URL } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import {
  checkoutReturnUrl,
  expressCheckoutOptions,
  peableAppearance,
  peableLocale,
  peablePaymentIntent,
  permittedWallets,
  showsProviderMessage,
  walletMethodCategory,
} from '@/lib/payments/peable-payer';
import type { CardPaymentStepProps } from './types';

/** How long the step waits for the gateway's answer before handing over to the poll. */
const GATEWAY_WAIT_MS = 30_000;

/**
 * Listen for the Express Checkout element's `confirm`.
 *
 * Peable's `PeableElement.on` is typed for `ready | change | focus | blur |
 * loaderror` only, yet it forwards every listener to the provider element, and
 * an Express Checkout element whose `confirm` nobody handles leaves the wallet
 * sheet spinning until it times out. The event is the provider's own (its
 * `ProviderElement.on` does name `confirm`), so this widens the one call and
 * nothing else — a recorded gap of the SDK (ADR 0009 D13 "As built").
 */
function onWalletConfirm(
  element: PeableElement,
  callback: (event: ProviderFieldEvent & { expressPaymentType?: unknown }) => void,
): void {
  const on = element.on as (event: string, listener: (event?: unknown) => void) => void;
  on.call(element, 'confirm', (event) => callback((event ?? {}) as ProviderFieldEvent));
}

export function CardPaymentStep({
  payment,
  checkoutGroupId,
  onCompleted,
  onCancelled,
  onFailed,
}: CardPaymentStepProps) {
  const { t, locale } = useTranslation();
  const theme = useTheme();
  const appearance = useMemo(
    () =>
      peableAppearance({
        isDark: theme.isDark,
        colors: {
          primary: theme.colors.primary,
          background: theme.colors.background,
          text: theme.colors.text,
          error: theme.colors.error,
        },
      }),
    [
      theme.isDark,
      theme.colors.primary,
      theme.colors.background,
      theme.colors.text,
      theme.colors.error,
    ],
  );
  // The payment's identity is its id and secret: a re-rendered handoff object
  // must not remount the fields under the buyer.
  const { id: intentId, client_secret: intentSecret } = peablePaymentIntent(payment);
  const intent = useMemo(
    () => ({ id: intentId, client_secret: intentSecret }),
    [intentId, intentSecret],
  );
  const wallets = permittedWallets(payment.methods);
  const offersWallets = wallets.applePay || wallets.googlePay;

  const walletNode = useRef<HTMLDivElement | null>(null);
  const paymentNode = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<PeableElements | null>(null);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const mounted = useRef(true);
  const callbacks = useRef({ onCompleted, onFailed });
  callbacks.current = { onCompleted, onFailed };

  const [fieldsReady, setFieldsReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /**
   * Whether the wallet row has any button to show. `null` until the provider
   * has probed the device — a THIRD state, so the row does not appear a beat
   * after the card form and push it down under the buyer's pointer.
   */
  const [walletsAvailable, setWalletsAvailable] = useState<boolean | null>(
    offersWallets ? null : false,
  );
  const [retry, setRetry] = useState(0);

  /**
   * Confirm — the ONE path, for a wallet and for a typed card alike, against
   * the gateway's PaymentIntent. Its answer only decides whether to show an
   * error or hand over to the server poll.
   */
  const confirm = useCallback(async (): Promise<boolean> => {
    const elements = elementsRef.current;
    if (!elements) return false;
    setSubmitting(true);
    try {
      const result = await elements.confirmPayment({
        paymentIntent: intent,
        // Only used when the bank insists on leaving the page.
        return_url: checkoutReturnUrl(window.location.origin, checkoutGroupId),
        timeoutMs: GATEWAY_WAIT_MS,
      });
      if (!mounted.current) return true;
      if ('error' in result) {
        track('guest_payment_client_failed');
        callbacks.current.onFailed(
          showsProviderMessage(result.error) && result.error.message
            ? result.error.message
            : t('payment.card.notCompleted'),
        );
        return false;
      }
      // `succeeded`, `processing` or `pending` alike: what the payment IS is
      // the server's to say, and the screen asks it. No success event here —
      // `guest_payment_verified` comes from `payments`, never from a browser.
      callbacks.current.onCompleted();
      return true;
    } catch {
      if (mounted.current) {
        track('guest_payment_client_failed');
        callbacks.current.onFailed(t('payment.card.notCompleted'));
      }
      return false;
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }, [intent, checkoutGroupId, t]);

  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  // Mount the provider's frames for THIS payment. Re-runs only for a different
  // payment, a different locale or an explicit retry; the theme is applied with
  // `update` below so a colour-scheme change does not wipe what was typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` remounts on purpose; appearance and callbacks are read through refs.
  useEffect(() => {
    mounted.current = true;
    setFieldsReady(false);
    setLoadFailed(false);
    setWalletsAvailable(offersWallets ? null : false);
    const elements = createPeableElements({
      paymentIntent: intent,
      appearance: appearanceRef.current,
      locale: peableLocale(locale),
      ...(PEABLE_GATEWAY_URL ? { gatewayUrl: PEABLE_GATEWAY_URL } : {}),
    });
    elementsRef.current = elements;
    const created: PeableElement[] = [];

    if (offersWallets && walletNode.current) {
      const express = elements.create('expressCheckout', {
        provider: expressCheckoutOptions(EXPRESS_CHECKOUT_OPTIONS, payment.methods),
      });
      created.push(express);
      express.on('ready', (event) => {
        if (mounted.current) {
          setWalletsAvailable(availableWallets(event as ProviderFieldEvent).length > 0);
        }
      });
      express.on('loaderror', () => {
        if (mounted.current) setWalletsAvailable(false);
      });
      onWalletConfirm(express, (event) => {
        // The express surface names WHICH wallet was used; the card form
        // cannot, which is why the card path emits its selection at submit.
        track('guest_payment_method_selected', {
          paymentMethodCategory: walletMethodCategory(event.expressPaymentType),
        });
        void confirmRef.current().then((ok) => {
          if (!ok) event.paymentFailed?.({ reason: 'fail' });
        });
      });
      void express.mount(walletNode.current).catch(() => {
        if (mounted.current) setWalletsAvailable(false);
      });
    }

    if (paymentNode.current) {
      const fields = elements.create('payment', {
        // The wallets live in the row above; offering them twice reads as two
        // different ways to pay.
        provider: { wallets: { applePay: 'never', googlePay: 'never' } },
      });
      created.push(fields);
      fields.on('ready', () => {
        if (mounted.current) setFieldsReady(true);
      });
      fields.on('loaderror', () => {
        if (mounted.current) setLoadFailed(true);
      });
      void fields.mount(paymentNode.current).catch(() => {
        if (mounted.current) setLoadFailed(true);
      });
    }

    return () => {
      mounted.current = false;
      elementsRef.current = null;
      for (const element of created) element.destroy();
    };
  }, [intent, locale, retry, offersWallets]);

  useEffect(() => {
    void elementsRef.current?.update({ appearance }).catch(() => {});
  }, [appearance]);

  /**
   * What the step OFFERED, once the wallet answer is in: the denominator of
   * the express-usage metric is "steps that offered a wallet", so emitting
   * before the probe answered would count every step as having offered one.
   */
  useEffect(() => {
    if (walletsAvailable === null || !fieldsReady) return;
    const offered = payment.methods.filter((method) =>
      method === 'card'
        ? true
        : walletsAvailable && (method === 'apple_pay' || method === 'google_pay'),
    );
    track('guest_payment_methods_shown', { itemCount: offered.length });
  }, [walletsAvailable, fieldsReady, payment.methods]);

  return (
    <View className="gap-4">
      {offersWallets && walletsAvailable !== false ? (
        <View className={walletsAvailable === null ? 'opacity-0' : 'gap-2'}>
          {/*
            A VISIBLE heading: the provider's buttons live in a cross-origin
            frame and announce only their brand names, so without it a screen
            reader reads "Apple Pay" with no indication of what it does.
          */}
          <Text
            accessibilityRole="header"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t('payment.card.expressHeading')}
          </Text>
          {createElement('div', {
            ref: (node: HTMLDivElement | null) => {
              walletNode.current = node;
            },
            'data-testid': 'peable-express-checkout',
          })}
          <Text className="text-center text-xs text-muted-foreground">
            {t('payment.card.orPayByCard')}
          </Text>
        </View>
      ) : null}
      {loadFailed ? (
        <View
          accessibilityRole="alert"
          className="gap-3 rounded-2xl border border-border bg-card p-4"
        >
          <Text className="text-sm text-muted-foreground">{t('payment.card.unavailable')}</Text>
          <Button
            appearance="outline"
            tone="neutral"
            className="self-start"
            onPress={() => setRetry((value) => value + 1)}
          >
            {t('common.tryAgain')}
          </Button>
        </View>
      ) : null}
      {fieldsReady || loadFailed ? null : (
        <Text className="text-sm text-muted-foreground">{t('payment.card.loading')}</Text>
      )}
      {createElement('div', {
        ref: (node: HTMLDivElement | null) => {
          paymentNode.current = node;
        },
        'data-testid': 'peable-payment-element',
      })}
      <Button
        tone="accent"
        onPress={() => {
          track('guest_payment_method_selected', { paymentMethodCategory: 'card' });
          void confirm();
        }}
        disabled={!fieldsReady || submitting}
        loading={submitting}
        accessibilityLabel={t('payment.card.payNow')}
      >
        {t('payment.card.payNow')}
      </Button>
      {onCancelled ? (
        <Button appearance="outline" tone="neutral" onPress={onCancelled} disabled={submitting}>
          {t('common.back')}
        </Button>
      ) : null}
    </View>
  );
}
