/**
 * The card step on the WEB — Stripe's Payment Element, with the Express
 * Checkout Element above it (ADR 0006 G2).
 *
 * This is the default file, so it is also what a non-Metro bundler resolves;
 * `CardPaymentStep.native.tsx` beside it serves iOS and Android with the
 * PaymentSheet. The two are separate implementations rather than one component
 * with branches because they share no code at all: different packages, different
 * mount lifecycles, different confirmation calls. See `types.ts` for the
 * contract that keeps the split from reaching the checkout screen.
 *
 * ## ONE component for both actor kinds
 *
 * ADR 0006 G1/G2: a guest and an account holder get the same surfaces, in the
 * same order, from the same handoff. The only difference is which credential
 * authenticated the `POST /checkout` that produced the client secret, and that
 * is invisible to Stripe.js. There is deliberately no guest branch here to
 * drift.
 *
 * ## Card details never touch Mercaria
 *
 * The element renders inside Stripe's own cross-origin iframe: the fields are
 * theirs, the values never enter this bundle's memory, and `confirmPayment`
 * submits them from inside that frame. That is what keeps Mercaria on PCI SAQ-A,
 * and it is why there is no `<Input>` anywhere in this directory.
 *
 * ## No Customer, therefore no "save my info"
 *
 * ADR 0006 G4/G5: no Stripe Customer is created for any buyer here, and the
 * Payment Element's saving flows exist only when one (plus a CustomerSession) is
 * configured — so the surface is absent by construction rather than hidden by an
 * option. That is the shape the decision needs: a guest session is a purgeable
 * device credential, and storage outliving the credential that authorized it
 * would be consentless retention.
 *
 * ## Wallets render in the ECE, the card form in the Payment Element
 *
 * Stripe shows wallet methods only in the Express Checkout Element "to avoid
 * duplication", so the two elements are complementary rather than alternatives.
 * When no wallet is available the ECE reports it and this component hides the
 * container entirely — an empty row of buttons above a card form is worse than
 * no row.
 *
 * ## `redirect: 'if_required'`, and what happens when it IS required
 *
 * Most card confirmations finish in place. One that needs 3-D Secure sends the
 * buyer to their bank and back to the SERVER-composed `return_url`, and the
 * payment completes while this component is not mounted — which is fine, because
 * nothing here decides whether the payment succeeded. The buyer lands on the
 * checkout-return route, which resumes the same poll. The return proves nothing
 * (ADR 0006 G10); the verified webhook is the authority.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { paymentMethodCategoryFor, track } from '../../lib/analytics';
import { View } from 'react-native';
import {
  Elements,
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Button, Text } from '@mercaria/ui';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import type { CardPaymentStepProps } from './types';

/**
 * One `loadStripe` per key, for the lifetime of the tab.
 *
 * Stripe's own guidance, and it is not a micro-optimisation: `loadStripe`
 * injects a script and returns a promise, so calling it during render would
 * start a fresh load on every re-render and leave `Elements` remounting under
 * the buyer.
 */
const stripeByKey = new Map<string, Promise<Stripe | null>>();

function stripeFor(publishableKey: string): Promise<Stripe | null> {
  const existing = stripeByKey.get(publishableKey);
  if (existing) return existing;
  const loading = loadStripe(publishableKey);
  stripeByKey.set(publishableKey, loading);
  return loading;
}

export function CardPaymentStep({
  payment,
  onCompleted,
  onCancelled,
  onFailed,
}: CardPaymentStepProps) {
  const { t } = useTranslation();
  // The server's key wins over the bundled one: it belongs to the account that
  // created this payment, and a client secret confirmed against a different
  // account's key fails in a way that reads as a client bug.
  const publishableKey = payment.publishableKey ?? STRIPE_PUBLISHABLE_KEY;

  if (!publishableKey) {
    return (
      <View className="rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm text-muted-foreground">{t('payment.card.notConfigured')}</Text>
      </View>
    );
  }

  return (
    <Elements
      stripe={stripeFor(publishableKey)}
      options={{ clientSecret: payment.clientSecret }}
    >
      <PaymentForm
        payment={payment}
        onCompleted={onCompleted}
        onCancelled={onCancelled}
        onFailed={onFailed}
      />
    </Elements>
  );
}

/**
 * The four CLIENT payment facts #111 emits from here.
 *
 * They are emitted from this component and nowhere else because this is the
 * only place that knows them: which surfaces the sheet actually OFFERED (the
 * server's permission narrowed by the device's capability), which one the buyer
 * pressed, whether the issuer demanded a step-up, and whether the confirmation
 * failed before the server ever saw it. #107 deferred all four rather than
 * derive them server-side, and this closes that half of its seam.
 *
 * What is NOT emitted here is `guest_payment_verified`. Paid state is read from
 * `payments` and a browser must not be able to assert one — the server's ingest
 * endpoint refuses the type outright, so this is a property of the contract
 * rather than of this component's restraint.
 */

/** The two elements and the one submit button, inside the `Elements` context. */
function PaymentForm({ payment, onCompleted, onCancelled, onFailed }: CardPaymentStepProps) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  /**
   * Whether the ECE has any button to show.
   *
   * `null` while Stripe has not answered yet, which is a THIRD state and not a
   * pessimistic `false`: rendering nothing until the answer arrives avoids a
   * wallet row appearing a beat after the card form and pushing it down under
   * the buyer's thumb.
   */
  const [walletsAvailable, setWalletsAvailable] = useState<boolean | null>(null);

  /**
   * Which express surfaces the SERVER permits — never the client's own idea.
   *
   * `never` is Stripe's "do not show this at all", so a surface the server left
   * out cannot be rendered even if the device would support it. The device then
   * narrows what remains (an Apple Pay button appears only on a machine that has
   * Apple Pay), which is the correct division: the server owns policy and the
   * device owns capability, and neither can override the other.
   */
  const expressOptions = useMemo(
    () => ({
      paymentMethods: {
        applePay: payment.methods.includes('apple_pay') ? ('auto' as const) : ('never' as const),
        googlePay: payment.methods.includes('google_pay') ? ('auto' as const) : ('never' as const),
        link: payment.methods.includes('link') ? ('auto' as const) : ('never' as const),
        // ADR 0001 D3's launch set is cards and card-based wallets. These three
        // are asynchronous or non-card methods whose transfer timing and failure
        // recovery no decision covers, so they are refused here as well as being
        // absent from the dashboard — two independent places, because a
        // dashboard toggle is not a reviewed diff.
        paypal: 'never' as const,
        klarna: 'never' as const,
        amazonPay: 'never' as const,
      },
      // ADR 0006 G12: the wallet is PAYMENT-ONLY at launch. Mercaria's order
      // snapshot was written before this element mounted, from the contact and
      // destination #105 validated, so a shipping address collected here could
      // only either be ignored or silently disagree with the order.
      shippingAddressRequired: false,
      billingAddressRequired: false,
      emailRequired: false,
      phoneNumberRequired: false,
    }),
    [payment.methods],
  );

  /**
   * Confirm — the ONE path, for a wallet and for a typed card alike.
   *
   * `elements.submit()` first because both surfaces share this instance: it
   * validates and collects whatever the buyer used, and confirming without it
   * fails for the wallet path only, which is the kind of bug that ships.
   */
  const confirm = useCallback(async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    try {
      const submitted = await elements.submit();
      if (submitted.error) {
        // A failure BEFORE the rail was called. Counted as a client failure
        // because that is exactly what it is — nothing reached Stripe, so no
        // server-side record of this attempt exists or ever will.
        track('guest_payment_client_failed');
        onFailed(submitted.error.message ?? t('payment.card.detailsNotConfirmed'));
        return;
      }
      const { error } = await stripe.confirmPayment({
        elements,
        // Only leave the page when the bank insists. The return trip lands on
        // the checkout-return route, which resumes the poll.
        redirect: 'if_required',
        ...(payment.returnUrl ? { confirmParams: { return_url: payment.returnUrl } } : {}),
      });
      if (error) {
        track('guest_payment_client_failed');
        onFailed(error.message ?? t('payment.card.notCompleted'));
        return;
      }
      // The buyer finished. Whether they PAID is the server's to say — and this
      // emits NO success event for that reason: `guest_payment_verified` comes
      // from `payments`, never from here.
      onCompleted();
    } finally {
      setSubmitting(false);
    }
  }, [stripe, elements, payment.returnUrl, onCompleted, onFailed, t]);

  /**
   * What the sheet OFFERED, once the wallet answer has arrived.
   *
   * Deliberately keyed on `walletsAvailable` rather than emitted on mount: the
   * denominator of `guest_express_method_usage` is "sheets that offered a
   * wallet", and emitting before Stripe has answered would count every sheet as
   * having offered one. `null` is the third state that makes the wait
   * expressible.
   */
  useEffect(() => {
    if (walletsAvailable === null) return;
    const offered = payment.methods.filter((method) =>
      walletsAvailable ? true : method === 'card',
    );
    track('guest_payment_methods_shown', { itemCount: offered.length });
  }, [walletsAvailable, payment.methods]);

  return (
    <View className="gap-4">
      {walletsAvailable === false ? null : (
        <View className={walletsAvailable === null ? 'opacity-0' : 'gap-2'}>
          {/*
            A VISIBLE heading rather than an `accessibilityLabel` on a wrapper:
            Stripe's buttons live in a cross-origin frame and announce only their
            brand names, so without this a screen reader reads "Apple Pay" with
            no indication of what pressing it does. A real heading serves sighted
            buyers too, which an invisible label would not.
          */}
          <Text
            accessibilityRole="header"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t('payment.card.expressHeading')}
          </Text>
          <ExpressCheckoutElement
            options={expressOptions}
            onAvailablePaymentMethodsChange={(event) => {
              const methods = event.paymentMethods;
              setWalletsAvailable(
                methods === undefined
                  ? false
                  : Object.values(methods).some((method) => method?.available === true),
              );
            }}
            onClick={(event) => {
              // The express surface names WHICH wallet was pressed; the card
              // form below cannot, because a `PaymentElement` submit does not
              // say which tab the buyer was on. That asymmetry is why the card
              // path emits its selection at SUBMIT and this one emits here.
              track('guest_payment_method_selected', {
                paymentMethodCategory: paymentMethodCategoryFor(event.expressPaymentType),
              });
              event.resolve();
            }}
            onConfirm={() => void confirm()}
          />
          <Text className="text-center text-xs text-muted-foreground">
            {t('payment.card.orPayByCard')}
          </Text>
        </View>
      )}
      <PaymentElement />
      <Button
        onPress={() => {
          track('guest_payment_method_selected', { paymentMethodCategory: 'card' });
          void confirm();
        }}
        disabled={!stripe || submitting}
        isLoading={submitting}
        accessibilityLabel={t('payment.card.payNow')}
      >
        <Text>{t('payment.card.payNow')}</Text>
      </Button>
      <Button variant="outline" onPress={onCancelled} disabled={submitting}>
        <Text>{t('common.back')}</Text>
      </Button>
    </View>
  );
}
