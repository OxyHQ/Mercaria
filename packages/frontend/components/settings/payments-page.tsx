import { useState } from 'react';
import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { Loading } from '@oxy.so/bloom/loading';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import type { ProviderOnboardingState, SellerPaymentSettings } from '@mercaria/shared-types';
import { Text, formatDate, formatRegionName } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import {
  useCreateSellerOnboardingLink,
  useRefreshSellerPaymentSettings,
  useSellerPaymentSettings,
} from '@/lib/hooks/use-seller-payments';

/**
 * Payments & payouts — a P2P seller's own Peable connected account (ADR 0001
 * D9, ADR 0009), the storefront twin of the dashboard's store screen.
 *
 * It says what is true and what changes it, and nothing more: the hosted flow
 * collects and holds the identity data (ADR 0001 D2), so it is the only party
 * that can say what is missing. The link opens in the SYSTEM browser (a hosted
 * provider flow does not run in a webview), and its closing proves nothing —
 * the page asks Peable to re-read the account and shows that.
 *
 * The country is the seller's choice, once: Mercaria stores none, and which
 * countries can be onboarded is Peable's answer.
 */
export function PaymentsSettingsPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useSellerPaymentSettings();
  if (isPending) return <Loading />;
  if (isError || !data) {
    return (
      <Text className="text-sm text-muted-foreground">{t('settings.payments.loadFailed')}</Text>
    );
  }
  return <PaymentsPanel settings={data} />;
}

/**
 * Copy per state, as KEYS: this map is evaluated at import, before the locale
 * store has rehydrated. Whether a state offers an action is the fact it
 * carries — two of the six deliberately do not.
 */
const STATE_COPY: Record<
  ProviderOnboardingState,
  { headingKey: string; bodyKey: string; actionKey?: string }
> = {
  not_connected: {
    headingKey: 'settings.payments.states.notConnected.heading',
    bodyKey: 'settings.payments.states.notConnected.body',
    actionKey: 'settings.payments.states.notConnected.action',
  },
  action_required: {
    headingKey: 'settings.payments.states.actionRequired.heading',
    bodyKey: 'settings.payments.states.actionRequired.body',
    actionKey: 'settings.payments.states.actionRequired.action',
  },
  under_review: {
    headingKey: 'settings.payments.states.underReview.heading',
    bodyKey: 'settings.payments.states.underReview.body',
  },
  ready: {
    headingKey: 'settings.payments.states.ready.heading',
    bodyKey: 'settings.payments.states.ready.body',
    actionKey: 'settings.payments.states.ready.action',
  },
  restricted: {
    headingKey: 'settings.payments.states.restricted.heading',
    bodyKey: 'settings.payments.states.restricted.body',
    actionKey: 'settings.payments.states.restricted.action',
  },
  disabled: {
    headingKey: 'settings.payments.states.disabled.heading',
    bodyKey: 'settings.payments.states.disabled.body',
  },
};

function PaymentsPanel({ settings }: { settings: SellerPaymentSettings }) {
  const { account, onboardingAvailable } = settings;
  const { t, locale } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [country, setCountry] = useState('');
  const createLink = useCreateSellerOnboardingLink();
  const refresh = useRefreshSellerPaymentSettings();

  const copy = STATE_COPY[account.onboardingState];
  const needsCountry = account.country === undefined;
  const chosenCountry = country.trim().toUpperCase();
  const countryValid = /^[A-Z]{2}$/.test(chosenCountry);
  const deadline =
    account.requirements.currentDeadline === undefined
      ? null
      : formatDate(account.requirements.currentDeadline, locale);
  const outstanding = account.requirements.currentlyDue + account.requirements.pastDue;

  async function startOnboarding(): Promise<void> {
    try {
      setOpening(true);
      const link = await createLink.mutateAsync(needsCountry ? { country: chosenCountry } : {});
      await WebBrowser.openBrowserAsync(link.url);
      await refresh();
    } catch {
      toast.error(t('settings.payments.openFailed'));
    } finally {
      setOpening(false);
    }
  }

  return (
    <View className="gap-4">
      <View className="rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-foreground">{t(copy.headingKey)}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">{t(copy.bodyKey)}</Text>

        {copy.actionKey !== undefined && onboardingAvailable && needsCountry ? (
          <View className="mt-4">
            <Field label={t('settings.payments.countryLabel')}>
              <TextFieldInput
                label={t('settings.payments.countryLabel')}
                value={country}
                onValueChange={setCountry}
                autoCapitalize="characters"
                maxLength={2}
              />
            </Field>
            <Text className="mt-1 text-xs text-muted-foreground">
              {countryValid
                ? formatRegionName(chosenCountry, locale)
                : t('settings.payments.countryHint')}
            </Text>
          </View>
        ) : null}

        {copy.actionKey !== undefined && onboardingAvailable ? (
          <Button
            tone="accent"
            onPress={startOnboarding}
            loading={createLink.isPending || opening}
            disabled={needsCountry && !countryValid}
            className="mt-4 self-start"
          >
            {t(copy.actionKey)}
          </Button>
        ) : null}

        {onboardingAvailable ? null : (
          <Text className="mt-3 text-xs text-muted-foreground">
            {t('settings.payments.onboardingUnavailable')}
          </Text>
        )}
      </View>

      {outstanding > 0 || account.requirements.pendingVerification > 0 ? (
        <View className="rounded-2xl border border-border bg-card p-4">
          <Text className="mb-2 text-sm font-semibold text-foreground">
            {t('settings.payments.outstandingTitle')}
          </Text>
          {outstanding > 0 ? (
            <Row
              label={t('settings.payments.neededNow')}
              value={t('settings.payments.itemCount', { count: outstanding })}
            />
          ) : null}
          {account.requirements.pendingVerification > 0 ? (
            <Row
              label={t('settings.payments.beingReviewed')}
              value={t('settings.payments.itemCount', {
                count: account.requirements.pendingVerification,
              })}
            />
          ) : null}
          {deadline === null ? null : <Row label={t('settings.payments.dueBy')} value={deadline} />}
          <Text className="mt-3 text-xs text-muted-foreground">
            {t('settings.payments.requirementsNote')}
          </Text>
        </View>
      ) : null}

      {account.payoutCurrency !== undefined || account.country !== undefined ? (
        <View className="rounded-2xl border border-border bg-card p-4">
          <Text className="mb-2 text-sm font-semibold text-foreground">
            {t('settings.payments.payoutsTitle')}
          </Text>
          {account.payoutCurrency === undefined ? null : (
            <Row label={t('settings.payments.paidOutIn')} value={account.payoutCurrency} />
          )}
          {account.country === undefined ? null : (
            <Row label={t('settings.payments.registeredIn')} value={account.country} />
          )}
        </View>
      ) : null}

      {account.disabledReasonCodes.length > 0 ? (
        <View className="rounded-2xl border border-border bg-card p-4">
          <Text className="mb-2 text-sm font-semibold text-foreground">
            {t('settings.payments.reportedByPeable')}
          </Text>
          {account.disabledReasonCodes.map((code) => (
            <Text key={code} className="text-xs text-muted-foreground">
              {code}
            </Text>
          ))}
          <Text className="mt-3 text-xs text-muted-foreground">
            {t('settings.payments.quoteToSupport')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm text-foreground">{value}</Text>
    </View>
  );
}
