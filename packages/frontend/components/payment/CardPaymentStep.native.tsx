/**
 * The card step on iOS and Android — Stripe's PaymentSheet (ADR 0006 G3).
 *
 * The native half of the split described in `CardPaymentStep.tsx`. The sheet is
 * Stripe's own native UI: it collects the card, offers Apple Pay and Google Pay
 * where the device supports them, and handles 3-D Secure without leaving the
 * app. Mercaria never sees a card number, which is what keeps it on PCI SAQ-A.
 *
 * The official React Native SDK and NOT a webview: Link is unsupported in an
 * in-app webview, wallets do not work there at all, and an embedded checkout
 * page is exactly the unsupported integration #107 rules out by name.
 *
 * ## ONE sheet for both actor kinds, with NO customer configuration
 *
 * ADR 0006 G4/G5. `initPaymentSheet` is given a client secret and nothing else
 * about the buyer — no `customerId`, no ephemeral key, no CustomerSession — so
 * the sheet renders no "Save my info" checkbox and no saved-method list. That is
 * the surface being ABSENT rather than suppressed, which is what makes "a guest
 * payment method is never saved" a property of the configuration instead of an
 * option somebody can flip.
 *
 * ## Initialise, then present — and never in one step
 *
 * `initPaymentSheet` prepares the sheet from the client secret and can fail on
 * its own (a malformed secret, a payment already completed);
 * `presentPaymentSheet` shows it and resolves when the buyer is done. Doing them
 * separately is what lets a configuration failure be reported as one, instead of
 * surfacing as a sheet that flashes and disappears.
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
import { track } from '@/lib/analytics';
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
        // contact value sent to a rail is a disclosure with no audit trail. No
        // customer configuration either — see this file's docblock.
        allowsDelayedPaymentMethods: false,
        // The SERVER's payment-surface set decides which wallets are configured
        // at all; the device then decides which of those it can actually show.
        // A wallet the server withheld has no configuration here to render
        // from, which is what makes the eligibility server-authoritative rather
        // than advisory.
        ...(payment.methods.includes('apple_pay') ? { applePay: { merchantCountryCode: 'ES' } } : {}),
        ...(payment.methods.includes('google_pay')
          ? { googlePay: { merchantCountryCode: 'ES', testEnv: !payment.publishableKey?.startsWith('pk_live_') } }
          : {}),
        // Where a bank app returns to. UX only and carrying no credential: the
        // sheet resolves, the screen polls, and a verified webhook is what makes
        // the order paid (ADR 0006 G10).
        ...(payment.returnUrl ? { returnURL: payment.returnUrl } : {}),
      });
      if (cancelled) return;
      if (error) {
        onFailed(error.message);
        return;
      }
      setReady(true);
      // What the SHEET will offer, once it is prepared — the native half of
      // #111's `guest_payment_methods_shown`. Emitted after `initPaymentSheet`
      // succeeds rather than on mount, for the web component's reason: a sheet
      // that failed to prepare offered nothing, and counting it would inflate
      // the denominator of `guest_express_method_usage` with attempts nobody
      // ever saw.
      track('guest_payment_methods_shown', { itemCount: payment.methods.length });
    };
    void prepare();
    return () => {
      cancelled = true;
    };
    // The sheet is prepared for ONE client secret; a new payment remounts it.
  }, [
    initPaymentSheet,
    payment.clientSecret,
    payment.methods,
    payment.publishableKey,
    payment.returnUrl,
    onFailed,
  ]);

  const onPay = async () => {
    setBusy(true);
    try {
      const { error } = await presentPaymentSheet();
      if (error) {
        if (error.code === PaymentSheetError.Canceled) {
          // A cancellation is NOT a client failure. The buyer changed their
          // mind, which is a legitimate outcome and not a drop-off caused by
          // anything Mercaria did — folding the two together would make
          // `guest_funnel_step_failure_rate` unreadable.
          onCancelled();
          return;
        }
        track('guest_payment_client_failed');
        onFailed(error.message);
        return;
      }
      // The buyer finished. Whether they PAID is the server's to say — and no
      // success event is emitted here, for that reason.
      onCompleted();
    } finally {
      setBusy(false);
    }
  };

  /*
   * There is deliberately NO `guest_payment_method_selected` on this path.
   *
   * `presentPaymentSheet` resolves with an error or with nothing; the native
   * sheet does not report which method the buyer pressed, and inventing one
   * from `payment.methods` would record "card" for every wallet purchase on
   * iOS. `guest_express_method_usage` is therefore a WEB measurement, which its
   * attribution limit has to say — a metric that silently means something
   * different per platform is worse than one that is absent on one of them.
   */
  return (
    <View className="gap-3">
      <Button
        onPress={() => void onPay()}
        disabled={!ready || busy}
        isLoading={busy || !ready}
        accessibilityLabel="Pay now"
      >
        <Text>Pay now</Text>
      </Button>
      <Button variant="outline" onPress={onCancelled} disabled={busy}>
        <Text>Back</Text>
      </Button>
    </View>
  );
}
