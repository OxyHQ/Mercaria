/**
 * The marketplace payment, in Peable's own payment sheet — the SAME
 * `PeableSheetCheckout` Mention opens on /plus (`@peable.to/sdk/checkout/ui`),
 * on the web and on iOS and Android alike.
 *
 * ## What Mercaria supplies, and what it does not
 *
 * The handoff's Peable PaymentIntent — or, for a USD order paid in FairCoin,
 * its FairCoin-only Checkout Session — and ITS `client_secret` (the payer's
 * capability, nothing of the acquirer's), the order's total and numbers, and
 * how to open a page in this app. Everything else — the card in Peable's secure
 * fields (or Peable's secure page where a native app cannot host them),
 * FairCoin, the payment's own states — is the SDK's. There is no card form, no
 * provider frame and no payment logic in Mercaria.
 *
 * ## Nothing here decides success
 *
 * The sheet reports when Peable closed the payment (`onSettled`); whether the
 * buyer's orders are PAID is Mercaria's payment-status endpoint, moved only by a
 * verified gateway event, and handed back as `outcome`. Closing the sheet, a
 * browser coming back or a provider callback proves nothing.
 */

import { useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { CheckoutPaymentHandoff, PaymentStatus } from '@mercaria/shared-types';
import { intentSource, PeableSheetCheckout, sessionSource } from '@peable.to/sdk/checkout/ui';
import { track } from '@/lib/analytics';
import { PEABLE_CHECKOUT_URL, PEABLE_GATEWAY_URL } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { checkoutReturnUrl, sheetOutcome } from '@/lib/payments/peable-payer';

/** Open what the buyer pressed for: Peable's page in the in-app browser, the wallet by its link. */
async function openInApp(url: string, kind: 'wallet' | 'hosted'): Promise<void> {
  if (Platform.OS === 'web') {
    if (kind === 'wallet') window.location.href = url;
    else window.open(url, '_blank', 'noopener');
    return;
  }
  if (kind === 'hosted') await WebBrowser.openBrowserAsync(url);
  else await Linking.openURL(url);
}

export function PeablePaymentSheet({
  payment,
  checkoutGroupId,
  orderNumbers,
  status,
  onSettled,
  onUnavailable,
  onClose,
}: {
  payment: CheckoutPaymentHandoff;
  checkoutGroupId: string;
  orderNumbers: readonly string[];
  /** The server's payment status, polled by the screen. */
  status: PaymentStatus | undefined;
  /** Peable closed the payment; the screen keeps asking the server. */
  onSettled: () => void;
  /** The payment cannot be opened here, with a sentence safe to show. */
  onUnavailable: (message: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  // A USD order the buyer chose to pay in FairCoin is a FairCoin-only Peable
  // Checkout Session (ADR 0020): the sheet quotes the total in FAIR when the
  // buyer confirms. Its one line IS the order's total, so the session's
  // subtotal — what the sheet compares — is the same figure as a payment's.
  const candidate =
    payment.payerObject === 'checkout_session'
      ? sessionSource(payment.clientSecret)
      : intentSource(payment.providerPaymentId, payment.clientSecret);
  const source = candidate?.id === payment.providerPaymentId ? candidate : null;

  const reported = useRef(false);
  useEffect(() => {
    if (source || reported.current) return;
    reported.current = true;
    onUnavailable(t('payment.sheet.unreadable'));
  }, [source, onUnavailable, t]);

  if (!source) return null;
  return (
    <PeableSheetCheckout
      source={source}
      {...(PEABLE_GATEWAY_URL ? { gatewayUrl: PEABLE_GATEWAY_URL } : {})}
      checkoutUrl={PEABLE_CHECKOUT_URL}
      locale={locale}
      expected={{ amount: String(payment.amount.amount), currency: payment.amount.currency }}
      order={{
        merchant: 'Mercaria',
        items: [
          {
            id: checkoutGroupId,
            name: t('payment.sheet.orderLine', { numbers: orderNumbers.join(', ') }),
            detail: '',
            quantity: 1,
            amountMinorUnits: payment.amount.amount,
          },
        ],
      }}
      // Only used when the buyer's bank insists on leaving the page; the return
      // route polls the server and proves nothing.
      {...(Platform.OS === 'web' && typeof window !== 'undefined'
        ? { returnUrl: checkoutReturnUrl(window.location.origin, checkoutGroupId) }
        : {})}
      openUrl={openInApp}
      onSettled={onSettled}
      outcome={sheetOutcome(status)}
      onUnavailable={(reason) => {
        track('guest_payment_client_failed');
        onUnavailable(
          t(reason === 'mismatch' ? 'payment.sheet.mismatch' : 'payment.sheet.unreadable'),
        );
      }}
      onClose={onClose}
    />
  );
}
