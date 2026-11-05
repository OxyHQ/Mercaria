/**
 * The card step on iOS and Android — Peable's HOSTED pay page in the system
 * browser (ADR 0009 Consequences).
 *
 * ## Why not a native card form
 *
 * Peable's payer SDK has no native card path. Its Elements
 * (`@peable.to/sdk/checkout`) mount the acquirer's fields onto a DOM, and its
 * React Native entry's card form (`@peable.to/sdk/checkout/ui`'s
 * `PeableProviderFields`) hosts the same DOM fields and renders only an
 * "unavailable" line where there is no `document`. A webview is not a
 * substitute: wallets do not run inside one, and an embedded checkout page is
 * the unsupported integration #107 rules out by name.
 *
 * What Peable DOES offer for one bare PaymentIntent is its hosted page,
 * `checkout.peable.to/i/:intentId#client_secret=…`, which pays the intent with
 * the same card fields and wallets the web step mounts. The system browser
 * (SFSafariViewController / Custom Tabs) runs Apple Pay and Google Pay, and the
 * secret travels in the URL fragment, which no server or CDN log receives.
 *
 * ## The browser closing proves nothing
 *
 * `openBrowserAsync` resolves when the buyer dismisses the browser, whether or
 * not they paid. So the step does NOT call `onCompleted` on its own word: it
 * stays on screen, offering the page again, while the checkout screen's poll of
 * Mercaria's payment-status endpoint — moved only by a verified gateway event —
 * replaces it once the payment settles. No native success is ever asserted.
 */

import { useState } from 'react';
import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import { PEABLE_CHECKOUT_URL } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { hostedPayUrl } from '@/lib/payments/peable-payer';
import type { CardPaymentStepProps } from './types';

export function CardPaymentStep({ payment, onCancelled, onFailed }: CardPaymentStepProps) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [returned, setReturned] = useState(false);

  const open = async () => {
    setOpening(true);
    try {
      await WebBrowser.openBrowserAsync(hostedPayUrl(PEABLE_CHECKOUT_URL, payment));
      // Back from the browser: paid or not is the server's to say.
      setReturned(true);
    } catch {
      onFailed(t('payment.card.browserUnavailable'));
    } finally {
      setOpening(false);
    }
  };

  return (
    <View className="gap-4">
      <View className="rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm text-muted-foreground">
          {returned ? t('payment.card.browserReturned') : t('payment.card.browserIntro')}
        </Text>
      </View>
      <Button
        tone="accent"
        onPress={() => void open()}
        disabled={opening}
        loading={opening}
        accessibilityLabel={returned ? t('payment.card.browserReopen') : t('payment.card.payNow')}
      >
        {returned ? t('payment.card.browserReopen') : t('payment.card.payNow')}
      </Button>
      {onCancelled ? (
        <Button appearance="outline" tone="neutral" onPress={onCancelled} disabled={opening}>
          {t('common.back')}
        </Button>
      ) : null}
    </View>
  );
}
