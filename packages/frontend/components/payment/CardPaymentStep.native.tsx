/**
 * The card step on iOS and Android — Stripe's PaymentSheet.
 *
 * The native half of the split described in `CardPaymentStep.tsx`. The sheet is
 * Stripe's own native UI: it collects the card, offers Apple Pay and Google Pay
 * where the device supports them, and handles 3-D Secure without leaving the
 * app. Mercaria never sees a card number, which is what keeps it on PCI SAQ-A.
 *
 * ## Initialise, then present — and never in one step
 *
 * `initPaymentSheet` prepares the sheet from the client secret and can fail on
 * its own (a malformed secret, a payment already completed); `presentPaymentSheet`
 * shows it and resolves when the buyer is done. Doing them separately is what
 * lets a configuration failure be reported as one, instead of surfacing as a
 * sheet that flashes and disappears.
 *
 * ## A cancellation is not a failure
 *
 * Stripe reports it as an error with `code: 'Canceled'`. Treating it as a
 * failure would tell a buyer who simply changed their mind that their payment
 * was declined — and their orders are still there, still payable, until the
 * reservation expires.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  PaymentSheetError,
  StripeProvider,
  useStripe,
} from '@stripe/stripe-react-native';
import { Button, Text } from '@mercaria/ui';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import type { CardPaymentStepProps } from './types';

export function CardPaymentStep({
  payment,
  onCompleted,
  onCancelled,
  onFailed,
}: CardPaymentStepProps) {
  // The server's key wins over the bundled one — see the web file for why.
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
    <StripeProvider publishableKey={publishableKey}>
      <PaymentSheetButton
        payment={payment}
        onCompleted={onCompleted}
        onCancelled={onCancelled}
        onFailed={onFailed}
      />
    </StripeProvider>
  );
}

/** Prepares the sheet on mount, then shows it when the buyer asks. */
function PaymentSheetButton({
  payment,
  onCompleted,
  onCancelled,
  onFailed,
}: CardPaymentStepProps) {
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      const { error } = await initPaymentSheet({
        merchantDisplayName: 'Mercaria',
        paymentIntentClientSecret: payment.clientSecret,
        // Nothing about the buyer is passed: the sheet needs none of it, and a
        // contact value sent to a rail is a disclosure with no audit trail.
        allowsDelayedPaymentMethods: false,
      });
      if (cancelled) return;
      if (error) {
        onFailed(error.message);
        return;
      }
      setReady(true);
    };
    void prepare();
    return () => {
      cancelled = true;
    };
    // The sheet is prepared for ONE client secret; a new payment remounts it.
  }, [initPaymentSheet, payment.clientSecret, onFailed]);

  const onPay = async () => {
    setBusy(true);
    try {
      const { error } = await presentPaymentSheet();
      if (error) {
        if (error.code === PaymentSheetError.Canceled) {
          onCancelled();
          return;
        }
        onFailed(error.message);
        return;
      }
      // The buyer finished. Whether they PAID is the server's to say.
      onCompleted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-3">
      <Button onPress={() => void onPay()} disabled={!ready || busy} isLoading={busy || !ready}>
        <Text>Pay now</Text>
      </Button>
      <Button variant="outline" onPress={onCancelled} disabled={busy}>
        <Text>Back</Text>
      </Button>
    </View>
  );
}
