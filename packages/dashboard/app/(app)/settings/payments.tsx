import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Link, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import * as WebBrowser from 'expo-web-browser';
import { ChevronLeft } from 'lucide-react-native';
import type { ProviderOnboardingState, SellerPaymentSettings } from '@mercaria/shared-types';
import {
  FaircoinSellerPayments,
  Text,
  formatDate,
  formatRegionName,
  useColorScheme,
  useFormatters,
  useRefreshOnReturn,
} from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { useTranslation } from '@/lib/i18n';
import { useFeeSchedule } from '@/lib/hooks/use-fees';
import {
  usePaymentSettings,
  useCreateFaircoinLink,
  useCreateOnboardingLink,
  useRefreshPaymentSettings,
} from '@/lib/hooks/use-payments';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useOwnerAccount } from '@/lib/hooks/use-store-people';

/**
 * Payments & payouts — the store's Peable connected account (ADR 0001 D9,
 * ADR 0009).
 *
 * ## What this screen may and may not say
 *
 * It explains, factually, which Mercaria features are unavailable in each state
 * and what changes it. It does NOT interpret the provider's requirements, guess
 * at why an account was rejected, or offer anything that could be read as
 * compliance advice: the gateway's hosted flow collects and holds the identity
 * data (ADR 0001 D2), so it is also the only party that can tell a seller what
 * is missing.
 * Mercaria knows HOW MANY things are outstanding and when they are due, and
 * that is deliberately all this screen has to work with.
 *
 * ## Hosted onboarding opens in the SYSTEM browser
 *
 * Not a webview — the hosted flow does not run in one. `openBrowserAsync`
 * is the same call the channels screen makes for OAuth, and for the same reason.
 *
 * ## The browser closing is not evidence of anything
 *
 * When it closes the screen asks Peable to re-read the account, and may well
 * still show `action_required` — readiness comes from a read of the account
 * (that refresh, or Peable's `connected_account.updated` event), never from a
 * redirect (ADR 0001 D2).
 *
 * ## The country is the owner's choice, once
 *
 * Mercaria stores no country for a store, and which countries can be onboarded
 * is Peable's answer rather than a list here, so the owner names it before the
 * first link. It is immutable at the acquirer afterwards; the field disappears
 * once an account exists.
 *
 * ## FairCoin is its own card, and its own confirmation
 *
 * FairCoin is always offered (ADR 0019): its half of the account is opened for
 * the store's OWNING Oxy account and turned on by that account confirming on
 * Peable's page. The card says where the coins go and why they cannot be paid
 * yet, in words, and its action opens that page the way the card onboarding
 * opens the hosted flow. On web the page opens in a new tab, so the screen
 * re-reads the account when this tab becomes active again as well as after the
 * open returns.
 */
export default function PaymentsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('settings.payments.documentTitle')}</title>
      </Head>
      <RequireStore permission="store:manage">
        {(storeId) => <PaymentsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function PaymentsBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = usePaymentSettings(storeId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title={t('settings.payments.title')} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t('settings.payments.title')} action={back}>
        <ScreenMessage
          title={t('settings.payments.loadFailed')}
          body={t('common.pleaseTryAgain')}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={t('settings.payments.title')}
      subtitle={t('settings.payments.subtitle')}
      action={back}
    >
      <PaymentsPanel storeId={storeId} settings={data} />
    </Screen>
  );
}

/**
 * Copy per state: what is true now, and what changes it.
 *
 * KEYS rather than the sentences (#398). This map is evaluated at import, before
 * the locale store has rehydrated, so a resolved string here would freeze
 * whatever language the first render happened to see; `PaymentsPanel` resolves
 * them and re-renders when the locale changes. `actionKey` stays OPTIONAL,
 * because whether a state offers an action is the fact this map carries — two of
 * the six deliberately do not.
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

/** The visual weight each state carries. Never a colour used for anything else. */
const STATE_TONE: Record<ProviderOnboardingState, string> = {
  not_connected: 'border-border bg-surface',
  action_required: 'border-border bg-surface',
  under_review: 'border-border bg-surface',
  ready: 'border-primary bg-surface',
  restricted: 'border-destructive bg-surface',
  disabled: 'border-destructive bg-surface',
};

function PaymentsPanel({
  storeId,
  settings,
}: {
  storeId: string;
  settings: SellerPaymentSettings;
}) {
  const { account, onboardingAvailable } = settings;
  const [opening, setOpening] = useState(false);
  const [country, setCountry] = useState('');
  const { t, locale } = useTranslation();
  const createLink = useCreateOnboardingLink(storeId);
  const refresh = useRefreshPaymentSettings(storeId);

  const copy = STATE_COPY[account.onboardingState];
  const busy = createLink.isPending || opening;
  const needsCountry = account.country === undefined;
  const chosenCountry = country.trim().toUpperCase();
  const countryValid = /^[A-Z]{2}$/.test(chosenCountry);

  async function startOnboarding(): Promise<void> {
    try {
      setOpening(true);
      const link = await createLink.mutateAsync(
        // Only meaningful the first time — the country is immutable at the
        // acquirer once the account exists, and the server ignores a later value.
        needsCountry ? { country: chosenCountry } : {},
      );
      // The SYSTEM browser, never a webview: the hosted flow does not run in
      // one. On web this opens a new tab.
      await WebBrowser.openBrowserAsync(link.url);
      // The browser closing proves nothing — ask Peable to re-read the account
      // and show what it says now.
      await refresh();
    } catch {
      toast.error(t('settings.payments.openFailed'));
    } finally {
      setOpening(false);
    }
  }

  return (
    <View className="gap-5">
      <FaircoinCard storeId={storeId} settings={settings} />

      <View className={`rounded-2xl border p-4 ${STATE_TONE[account.onboardingState]}`}>
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
            loading={busy}
            disabled={needsCountry && !countryValid}
            className="mt-4 self-start"
          >
            {t(copy.actionKey)}
          </Button>
        ) : null}

        {!onboardingAvailable ? (
          <Text className="mt-3 text-xs text-muted-foreground">
            {t('settings.payments.onboardingUnavailable')}
          </Text>
        ) : null}
      </View>

      <MarketplaceFeeCard storeId={storeId} />
      <RequirementsCard settings={settings} />
      <PayoutDetailsCard settings={settings} />
      <ReasonCodesCard settings={settings} />
    </View>
  );
}

/**
 * The store's FairCoin half (ADR 0019). The receiving account is named in words
 * — the owning account's display name or handle, read from Oxy — and falls back
 * to the id the settings carry while that read is pending or refused.
 */
function FaircoinCard({ storeId, settings }: { storeId: string; settings: SellerPaymentSettings }) {
  const { t } = useTranslation();
  const { store } = useActiveStoreContext();
  const { faircoin } = settings;
  const owner = useOwnerAccount(faircoin.receivingOxyAccountId ?? store?.oxyAccountId);
  const [opening, setOpening] = useState(false);
  const createLink = useCreateFaircoinLink(storeId);
  const refresh = useRefreshPaymentSettings(storeId);
  const armReturn = useRefreshOnReturn(refresh);
  const ownerName =
    owner.data?.account.name?.displayName?.trim() ||
    (owner.data?.account.username ? `@${owner.data.account.username}` : undefined);

  async function confirmInPeable(): Promise<void> {
    try {
      setOpening(true);
      const link = await createLink.mutateAsync();
      // Same as the card onboarding: the SYSTEM browser on native, a new tab on
      // web. On web the open returns at once, so the re-read is also armed for
      // the moment this tab is active again.
      armReturn();
      await WebBrowser.openBrowserAsync(link.url);
      await refresh();
    } catch {
      toast.error(t('settings.payments.faircoinOpenFailed'));
    } finally {
      setOpening(false);
    }
  }

  return (
    <View
      className={`rounded-2xl border p-4 ${faircoin.payable ? 'border-primary' : 'border-border'} bg-surface`}
    >
      <FaircoinSellerPayments
        faircoin={faircoin}
        audience="store"
        receivingAccountName={ownerName}
        onboardingAvailable={settings.onboardingAvailable}
        onConfirm={confirmInPeable}
        busy={createLink.isPending || opening}
      />
    </View>
  );
}

/**
 * What Mercaria takes from each sale, stated where a seller sets up being paid
 * (ADR 0018). Read from the SAME schedule the fees screen shows and checkout
 * charges — never a figure written into this screen — and linked to the full
 * terms, which is where they are accepted.
 *
 * A failed read renders nothing rather than a guess: the fees screen behind the
 * link says what the terms are, and a wrong number here would be worse than none.
 */
function MarketplaceFeeCard({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const { formatMoney, formatPercent } = useFormatters();
  const { data } = useFeeSchedule(storeId);
  if (!data) return null;
  const { schedule, acceptance } = data;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-1 text-sm font-semibold text-foreground">
        {t('settings.payments.fee.title')}
      </Text>
      {schedule ? (
        <>
          <Text className="text-xs text-foreground">
            {schedule.fixedFee
              ? t('settings.payments.fee.summary', {
                  percent: formatPercent(schedule.percentageBps),
                  fixed: formatMoney(schedule.fixedFee),
                })
              : t('settings.payments.fee.summaryPercentOnly', {
                  percent: formatPercent(schedule.percentageBps),
                })}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {t('settings.payments.fee.faircoin')}
          </Text>
          {acceptance ? null : (
            <Text className="mt-1 text-xs text-muted-foreground">
              {t('settings.payments.fee.pending')}
            </Text>
          )}
        </>
      ) : (
        <Text className="text-xs text-muted-foreground">{t('settings.payments.fee.none')}</Text>
      )}
      <Link href={{ pathname: '/settings/fees' }} className="mt-3 self-start">
        <Text className="text-xs font-medium text-primary">
          {t('settings.payments.fee.action')}
        </Text>
      </Link>
    </View>
  );
}

/** Counts and a deadline — never the list, which only the hosted flow holds. */
function RequirementsCard({ settings }: { settings: SellerPaymentSettings }) {
  const { requirements } = settings.account;
  const { t, locale } = useTranslation();
  const deadline =
    requirements.currentDeadline === undefined
      ? null
      : formatDate(requirements.currentDeadline, locale);
  const outstanding = requirements.currentlyDue + requirements.pastDue;
  if (outstanding === 0 && requirements.pendingVerification === 0) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t('settings.payments.outstandingTitle')}
      </Text>
      <Row
        label={t('settings.payments.neededNow')}
        value={
          outstanding === 0
            ? t('common.none')
            : t('settings.payments.itemCount', { count: outstanding })
        }
      />
      {requirements.pendingVerification > 0 ? (
        <Row
          label={t('settings.payments.beingReviewed')}
          value={t('settings.payments.itemCount', { count: requirements.pendingVerification })}
        />
      ) : null}
      {/* `Row`'s value is the whole of what the row says, so an unformattable
          deadline drops the row rather than rendering "Invalid Date" beside a
          "Due by" label (#529). */}
      {deadline === null ? null : <Row label={t('settings.payments.dueBy')} value={deadline} />}
      <Text className="mt-3 text-xs text-muted-foreground">
        {t('settings.payments.requirementsNote')}
      </Text>
    </View>
  );
}

/** Payout currency and registration country, shown only when Peable reports them. */
function PayoutDetailsCard({ settings }: { settings: SellerPaymentSettings }) {
  const { account } = settings;
  const { t } = useTranslation();
  if (account.payoutCurrency === undefined && account.country === undefined) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t('settings.payments.payoutsTitle')}
      </Text>
      {account.payoutCurrency !== undefined ? (
        <Row label={t('settings.payments.paidOutIn')} value={account.payoutCurrency} />
      ) : null}
      {account.country !== undefined ? (
        <Row label={t('settings.payments.registeredIn')} value={account.country} />
      ) : null}
    </View>
  );
}

/**
 * The acquirer's own reason codes, as Peable reports them, rendered as codes.
 *
 * Deliberately not translated into prose: Mercaria does not know why the
 * acquirer made a decision, and a friendly-sounding guess about someone's account being
 * rejected is worse than the code they can quote to support.
 */
function ReasonCodesCard({ settings }: { settings: SellerPaymentSettings }) {
  const codes = settings.account.disabledReasonCodes;
  const { t } = useTranslation();
  if (codes.length === 0) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-2 text-sm font-semibold text-foreground">
        {t('settings.payments.reportedByPeable')}
      </Text>
      {codes.map((code) => (
        <Text key={code} className="text-xs text-muted-foreground">
          {code}
        </Text>
      ))}
      <Text className="mt-3 text-xs text-muted-foreground">
        {t('settings.payments.quoteToSupport')}
      </Text>
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
