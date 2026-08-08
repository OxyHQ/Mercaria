/**
 * The card step on the WEB — Stripe's Payment Element.
 *
 * This is the default file, so it is also what a non-Metro bundler resolves;
 * `CardPaymentStep.native.tsx` beside it serves iOS and Android with the
 * PaymentSheet. The two are separate implementations rather than one component
 * with branches because they share no code at all: different packages, different
 * mount lifecycles, different confirmation calls. See `types.ts` for the
 * contract that keeps the split from reaching the checkout screen.
 *
 * ## Card details never touch Mercaria
 *
 * The element renders inside Stripe's own cross-origin iframe: the fields are
 * theirs, the values never enter this bundle's memory, and `confirmPayment`
 * submits them from inside that frame. That is what keeps Mercaria on PCI SAQ-A,
 * and it is why there is no `<Input>` anywhere in this directory.
 *
 * ## `redirect: 'if_required'` and what happens when it IS required
 *
 * Most card confirmations finish in place. One that needs 3-D Secure sends the
 * buyer to their bank and back to `return_url`, and the payment completes while
 * this component is not mounted — which is fine, because nothing here decides
 * whether the payment succeeded. The buyer lands back on the checkout screen,
 * which polls the server and learns the answer from a verified webhook.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Button, Text } from '@mercaria/ui';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
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
  // The server's key wins over the bundled one: it belongs to the account that
  // created this payment, and a client secret confirmed against a different
  // account's key fails in a way that reads as a client bug.
  const publishableKey = payment.publishableKey ?? STRIPE_PUBLISHABLE_KEY;

  if (!publishableKey) {
    return (
      <View className="rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm text-muted-foreground">
          Card payments are not configured for this app yet.
        </Text>
      </View>
    );
  }

  return (
    <Elements
      stripe={stripeFor(publishableKey)}
      options={{ clientSecret: payment.clientSecret }}
    >
      <PaymentForm onCompleted={onCompleted} onCancelled={onCancelled} onFailed={onFailed} />
    </Elements>
  );
}

/** The element and its submit button, inside the `Elements` context. */
function PaymentForm({
  onCompleted,
  onCancelled,
  onFailed,
}: Omit<CardPaymentStepProps, 'payment'>) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  const onPay = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        // Only leave the page when the bank insists. The return trip lands back
        // on the checkout screen, which polls the server for the outcome.
        redirect: 'if_required',
      });
      if (error) {
        onFailed(error.message ?? 'Your payment could not be completed.');
        return;
      }
      // The buyer finished. Whether they PAID is the server's to say.
      onCompleted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View className="gap-4">
      <PaymentElement />
      <Button onPress={() => void onPay()} disabled={!stripe || submitting} isLoading={submitting}>
        <Text>Pay now</Text>
      </Button>
      <Button variant="outline" onPress={onCancelled} disabled={submitting}>
        <Text>Back</Text>
      </Button>
    </View>
  );
}
