import { useMemo, useState } from 'react';
import { Linking, Platform, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import * as WebBrowser from 'expo-web-browser';
import { ChevronLeft } from 'lucide-react-native';
import type {
  BillingInterval,
  MerchantEntitlementView,
  MerchantPlanCatalogEntry,
  MerchantPlanCheckoutView,
  MerchantPlanStatusView,
  MerchantSubscriptionStatus,
} from '@mercaria/shared-types';
import { Text, formatDate, useColorScheme, useFormatters } from '@mercaria/ui';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import {
  PeableSheetCheckout,
  sessionSource,
  type SheetSettlement,
} from '@peable.to/sdk/checkout/ui';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { useTranslation } from '@/lib/i18n';
import config, { PEABLE_CHECKOUT_URL, PEABLE_GATEWAY_URL } from '@/lib/config';
import { planCheckoutExpectation, sheetInterval } from '@/lib/plan-checkout';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { CAPABILITY_COPY_KEYS, PLAN_SUMMARY_KEYS } from '@/lib/plan-copy';
import {
  useCancelPlan,
  useChangePlan,
  useOpenBillingPortal,
  usePlanCatalog,
  usePlanCheckoutOutcome,
  usePlanStatus,
  useRefreshPlan,
  useStartPlanCheckout,
} from '@/lib/hooks/use-plan';

/**
 * Plan & billing — what this store gets for nothing, and what a paid plan would
 * add (#89).
 *
 * ## What this screen must never do
 *
 * It never suggests that a plan affects how a store's listings are found or
 * ranked, never implies that anything a merchant already does is at risk, and
 * never uses urgency to sell. Issue #89 UX 5 and 6: past-due messaging says
 * exactly what stops and when, and it cannot threaten order access because order
 * access is not an entitlement — there is no capability key for it, so nothing
 * on this screen could withdraw it.
 *
 * ## The client hides and explains; it never grants
 *
 * Current offers and billing state are RESULTS the server computed: the plans,
 * their prices, limits and terms version all come from `GET /plan/catalog`, and
 * only their copy is translated here (`lib/plan-copy.ts`). `billingAvailable`
 * decides whether an upgrade button is offered at all, and pressing it anyway
 * would simply be refused — the server re-decides on every write regardless of
 * what this screen believed (#89 entitlement rule 4).
 *
 * ## A plan is paid in Peable's sheet; the portal opens in the SYSTEM browser
 *
 * Starting a plan opens Peable's payment sheet over this screen — the same
 * `PeableSheetCheckout` Mention uses — with the card and FairCoin, never a
 * redirect. The billing portal is still Peable's hosted page, in the system
 * browser (not a webview, which a hosted provider page does not run inside).
 */
export default function PlanScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('settings.plan.documentTitle')}</title>
      </Head>
      <RequireStore permission="store:manage">
        {(storeId) => <PlanBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function PlanBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const status = usePlanStatus(storeId);
  const catalog = usePlanCatalog(storeId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
    </Pressable>
  );

  if (status.isPending) {
    return (
      <Screen title={t('settings.plan.title')} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Screen title={t('settings.plan.title')} action={back}>
        <ScreenMessage title={t('settings.plan.loadFailed')} body={t('common.pleaseTryAgain')} />
      </Screen>
    );
  }

  return (
    <Screen title={t('settings.plan.title')} subtitle={t('settings.plan.subtitle')} action={back}>
      <View className="gap-4">
        <AlwaysIncluded />
        <CurrentPlan storeId={storeId} status={status.data} />
        <PlanComparison
          storeId={storeId}
          plans={catalog.data ?? []}
          loading={catalog.isPending}
          status={status.data}
        />
      </View>
    </Screen>
  );
}

/**
 * The panel that comes FIRST, deliberately.
 *
 * A plan screen that opens with what a merchant might be missing reads as
 * pressure. This one opens with what is theirs whatever they pay, because that
 * is the actual product policy — and stating it is the honest alternative to a
 * "free tier" row in a comparison table implying it is the lesser option.
 */
function AlwaysIncluded() {
  const { t } = useTranslation();
  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t('settings.plan.alwaysIncludedTitle')}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">
        {t('settings.plan.alwaysIncludedBody')}
      </Text>
    </View>
  );
}

/**
 * Plain-language state, and what changes it. Never urgency, never a threat.
 *
 * KEYS rather than the sentences (#398): this map is evaluated at import, before
 * the locale store has rehydrated, so a resolved string would freeze whatever
 * language loaded first. `CurrentPlan` resolves them per render.
 */
const STATUS_COPY: Record<MerchantSubscriptionStatus, { headingKey: string; bodyKey: string }> = {
  trialing: {
    headingKey: 'settings.plan.statuses.trialing.heading',
    bodyKey: 'settings.plan.statuses.trialing.body',
  },
  active: {
    headingKey: 'settings.plan.statuses.active.heading',
    bodyKey: 'settings.plan.statuses.active.body',
  },
  past_due: {
    headingKey: 'settings.plan.statuses.pastDue.heading',
    bodyKey: 'settings.plan.statuses.pastDue.body',
  },
  paused: {
    headingKey: 'settings.plan.statuses.paused.heading',
    bodyKey: 'settings.plan.statuses.paused.body',
  },
  cancelled: {
    headingKey: 'settings.plan.statuses.cancelled.heading',
    bodyKey: 'settings.plan.statuses.cancelled.body',
  },
  expired: {
    headingKey: 'settings.plan.statuses.expired.heading',
    bodyKey: 'settings.plan.statuses.expired.body',
  },
};

function CurrentPlan({ storeId, status }: { storeId: string; status: MerchantPlanStatusView }) {
  const [opening, setOpening] = useState(false);
  const { t, locale } = useTranslation();
  const portal = useOpenBillingPortal(storeId);
  const cancel = useCancelPlan(storeId);
  const refresh = useRefreshPlan(storeId);
  const subscription = status.subscription;
  const copy = subscription ? STATUS_COPY[subscription.status] : undefined;
  // Three plain dates, never a countdown. Each is bound here rather than
  // formatted inline so the null a bad instant produces guards its own
  // sentence: every one of them NAMES its date, and i18n-js renders a
  // missing placeholder as the literal `[missing "%{date}" value]` (#529).
  const graceEndsOn = subscription?.graceExpiresAt
    ? formatDate(subscription.graceExpiresAt, locale)
    : null;
  const endsOn = subscription?.cancelAt ? formatDate(subscription.cancelAt, locale) : null;
  const renewsOn =
    subscription?.currentPeriodEnd && !subscription.cancelAt
      ? formatDate(subscription.currentPeriodEnd, locale)
      : null;

  async function openPortal(): Promise<void> {
    try {
      setOpening(true);
      const session = await portal.mutateAsync();
      await WebBrowser.openBrowserAsync(session.url);
    } catch {
      toast.error(t('settings.plan.portalFailed'));
    } finally {
      setOpening(false);
      // The browser closing is not evidence of anything — subscription state
      // comes from a provider event — but refetching costs little and a merchant
      // who did change something there sees it sooner.
      refresh();
    }
  }

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {subscription ? subscription.planName : t('settings.plan.free')}
      </Text>
      {copy ? (
        <>
          <Text className="mt-2 text-sm font-medium text-foreground">{t(copy.headingKey)}</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{t(copy.bodyKey)}</Text>
        </>
      ) : (
        <Text className="mt-1 text-xs text-muted-foreground">
          {t('settings.plan.notOnPaidPlan')}
        </Text>
      )}

      {graceEndsOn === null ? null : (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t('settings.plan.graceEndsOn', { date: graceEndsOn })}
        </Text>
      )}
      {endsOn === null ? null : (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t('settings.plan.endsOn', { date: endsOn })}
        </Text>
      )}
      {renewsOn === null ? null : (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t('settings.plan.renewsOn', { date: renewsOn })}
        </Text>
      )}

      <Entitlements entitlements={status.entitlements} />

      {status.portalAvailable ? (
        <View className="mt-4 flex-row gap-2">
          <Button tone="accent" onPress={openPortal} disabled={portal.isPending || opening}>
            {t('settings.plan.manageBilling')}
          </Button>
          {subscription && !subscription.cancelAt ? (
            <Button
              appearance="outline"
              tone="neutral"
              onPress={() => {
                cancel.mutate(undefined, {
                  onError: () => toast.error(t('settings.plan.cancelFailed')),
                });
              }}
              disabled={cancel.isPending}
            >
              {t('settings.plan.cancelPlan')}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * What this store is entitled to right now, with usage where there is a limit.
 *
 * An empty list is the ordinary state and says so plainly rather than reading as
 * a failure: the free plan grants no entitlements because everything it offers
 * is included for every store by construction.
 */
function Entitlements({ entitlements }: { entitlements: readonly MerchantEntitlementView[] }) {
  const { t } = useTranslation();
  if (entitlements.length === 0) {
    return (
      <Text className="mt-3 text-xs text-muted-foreground">{t('settings.plan.noExtras')}</Text>
    );
  }
  return (
    <View className="mt-3 gap-1">
      {entitlements.map((entitlement) => (
        <View key={entitlement.capability} className="flex-row items-center justify-between">
          <Text className="text-xs text-foreground">
            {t(CAPABILITY_COPY_KEYS[entitlement.capability])}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {entitlement.limitKind === 'flag'
              ? t('settings.plan.usageIncluded')
              : entitlement.limit === null
                ? t('settings.plan.usageNoLimit', { used: entitlement.used })
                : t('settings.plan.usageOfLimit', {
                    used: entitlement.used,
                    limit: entitlement.limit,
                  })}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The currencies a store can be billed in, in the order the picker shows them. */
const BILLING_CURRENCIES = ['USD', 'EUR'] as const;

/** A subscription that still bills — anything but ended. */
const LIVE: readonly MerchantSubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
];

/**
 * The comparison. Empty is a real and correct state on a deployment with
 * nothing on sale: a plan version whose capabilities are not implemented
 * cannot be activated at all.
 *
 * Plans are ordered by price, cheapest first, in the chosen currency; every
 * figure is the server's. A store with a live subscription CHANGES plan (one
 * subscription, prorated on one invoice now) rather than starting a second
 * checkout, which the server refuses.
 */
function PlanComparison({
  storeId,
  plans,
  loading,
  status,
}: {
  storeId: string;
  plans: readonly MerchantPlanCatalogEntry[];
  loading: boolean;
  status: MerchantPlanStatusView;
}) {
  const { t } = useTranslation();
  const { store } = useActiveStoreContext();
  const subscription = status.subscription;
  const live = subscription !== null && LIVE.includes(subscription.status);
  const [interval, setBillingInterval] = useState<BillingInterval>(
    subscription?.interval ?? 'monthly',
  );
  const [currency, setCurrency] = useState<string>(
    store?.defaultCurrency === 'EUR' ? 'EUR' : 'USD',
  );

  const paid = useMemo(() => {
    const priceOf = (plan: MerchantPlanCatalogEntry) =>
      plan.prices.find((price) => price.currency === currency && price.interval === 'monthly')
        ?.unitPrice.amount ?? Number.MAX_SAFE_INTEGER;
    return plans.filter((plan) => plan.tier === 'paid').sort((a, b) => priceOf(a) - priceOf(b));
  }, [plans, currency]);

  if (loading) return null;
  if (paid.length === 0) {
    return (
      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">
          {t('settings.plan.paidPlansTitle')}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">{t('settings.plan.noPaidPlans')}</Text>
      </View>
    );
  }

  const offered = BILLING_CURRENCIES.filter((code) =>
    paid.some((plan) => plan.prices.some((price) => price.currency === code)),
  );
  const termsVersion = paid[0]?.termsVersion;

  return (
    <View className="gap-3">
      <Text className="text-lg font-semibold text-foreground">
        {t('settings.plan.paidPlansTitle')}
      </Text>
      <View className="flex-row flex-wrap items-center gap-3">
        <SegmentedControl
          type="radio"
          value={interval}
          onValueChange={(value) => setBillingInterval(value as BillingInterval)}
        >
          <SegmentedControlItem value="monthly">
            <SegmentedControlItemText>
              {t('settings.plan.intervalMonthly')}
            </SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="annual">
            <SegmentedControlItemText>{t('settings.plan.intervalAnnual')}</SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
        {offered.length > 1 ? (
          <SegmentedControl type="radio" value={currency} onValueChange={setCurrency}>
            {offered.map((code) => (
              <SegmentedControlItem key={code} value={code}>
                <SegmentedControlItemText>{code}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : null}
        {interval === 'annual' ? (
          <Text className="text-xs text-muted-foreground">{t('settings.plan.annualSaving')}</Text>
        ) : null}
      </View>

      <View className="flex-row flex-wrap gap-4">
        {paid.map((plan) => (
          <PlanCard
            key={plan.planId}
            storeId={storeId}
            plan={plan}
            interval={interval}
            currency={currency}
            status={status}
            live={live}
          />
        ))}
      </View>

      <View className="gap-1">
        <Text className="text-xs text-muted-foreground">{t('settings.plan.exclTax')}</Text>
        <Text className="text-xs text-muted-foreground">{t('settings.plan.termsSummary')}</Text>
        {termsVersion ? (
          <View className="flex-row flex-wrap items-center gap-1">
            <Text className="text-xs text-muted-foreground">{t('settings.plan.termsNotice')}</Text>
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                void WebBrowser.openBrowserAsync(
                  `${config.apiUrl}/legal/merchant-plan-terms/${encodeURIComponent(termsVersion)}`,
                );
              }}
            >
              <Text className="text-xs font-medium text-foreground underline">
                {t('settings.plan.termsLink')}
              </Text>
            </Pressable>
          </View>
        ) : null}
        <Text className="text-xs text-muted-foreground">{t('settings.plan.design.ethics')}</Text>
      </View>
    </View>
  );
}

/** One plan, at the chosen cadence and currency, with the action that fits this store. */
function PlanCard({
  storeId,
  plan,
  interval,
  currency,
  status,
  live,
}: {
  storeId: string;
  plan: MerchantPlanCatalogEntry;
  interval: BillingInterval;
  currency: string;
  status: MerchantPlanStatusView;
  live: boolean;
}) {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const price = plan.prices.find(
    (candidate) => candidate.currency === currency && candidate.interval === interval,
  );
  const summaryKey = PLAN_SUMMARY_KEYS[plan.planKey];
  const subscription = status.subscription;
  const onThisPlan = live && subscription?.planKey === plan.planKey;
  const current = onThisPlan && subscription?.interval === interval;

  return (
    <View
      testID={`merchant-plan-${plan.planKey}`}
      className="min-w-64 flex-1 gap-3 rounded-2xl border border-border bg-surface p-4"
    >
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">{plan.name}</Text>
        <Text className="text-sm text-muted-foreground">
          {summaryKey ? t(summaryKey) : plan.summary}
        </Text>
      </View>
      {price ? (
        <Text className="text-lg font-semibold text-foreground">
          {t(interval === 'annual' ? 'settings.plan.pricePerYear' : 'settings.plan.pricePerMonth', {
            price: formatMoney(price.unitPrice),
          })}
        </Text>
      ) : (
        <Text className="text-sm text-muted-foreground">{t('settings.plan.notInCurrency')}</Text>
      )}
      <View className="gap-1">
        {plan.capabilities.map((capability) => {
          const name = t(CAPABILITY_COPY_KEYS[capability.key]);
          return (
            <Text key={capability.key} className="text-xs text-foreground">
              {capability.limit === null
                ? name
                : t(
                    capability.limitKind === 'per_period'
                      ? 'settings.plan.capabilityPerPeriod'
                      : 'settings.plan.capabilityWithLimit',
                    { name, limit: capability.limit },
                  )}
            </Text>
          );
        })}
      </View>
      {plan.trialDays > 0 ? (
        <Text className="text-xs text-muted-foreground">
          {t('settings.plan.trialNotice', { count: plan.trialDays })}
        </Text>
      ) : null}
      {current ? (
        <Text className="text-sm font-medium text-foreground">
          {t('settings.plan.currentPlan')}
        </Text>
      ) : status.billingAvailable && price ? (
        live ? (
          <ChangeAction storeId={storeId} plan={plan} interval={interval} currency={currency} />
        ) : (
          <UpgradeAction storeId={storeId} plan={plan} interval={interval} currency={currency} />
        )
      ) : null}
    </View>
  );
}

/**
 * Start a first paid plan, rendered only where the SERVER says billing is
 * available. Pressing it on a deployment with billing off would simply be
 * refused (#89 entitlement rule 4).
 *
 * The press records the terms acceptance and answers a Peable session, paid in
 * Peable's sheet right here. The subscription is created from a provider event:
 * the sheet shows success only once this store's plan status says it pays.
 */
function UpgradeAction({
  storeId,
  plan,
  interval,
  currency,
}: {
  storeId: string;
  plan: MerchantPlanCatalogEntry;
  interval: BillingInterval;
  currency: string;
}) {
  const { t } = useTranslation();
  const checkout = useStartPlanCheckout(storeId);
  const refresh = useRefreshPlan(storeId);
  const [view, setView] = useState<MerchantPlanCheckoutView | null>(null);

  async function upgrade(): Promise<void> {
    try {
      setView(await checkout.mutateAsync({ planId: plan.planId, interval, currency }));
    } catch {
      toast.error(t('settings.plan.upgradeFailed'));
    }
  }

  return (
    <>
      <Button tone="accent" onPress={upgrade} disabled={checkout.isPending || view !== null}>
        {t('settings.plan.choosePlan', { plan: plan.name })}
      </Button>
      {view ? (
        <PlanCheckoutSheet
          storeId={storeId}
          view={view}
          onClose={() => {
            setView(null);
            // Closing proves nothing; a refetch costs little and shows the
            // state the provider event has produced so far.
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Open what the merchant pressed for: Peable's page in the in-app browser, the wallet by its link. */
async function openFromSheet(url: string, kind: 'wallet' | 'hosted'): Promise<void> {
  if (Platform.OS === 'web') {
    if (kind === 'wallet') window.location.href = url;
    else window.open(url, '_blank', 'noopener');
    return;
  }
  if (kind === 'hosted') await WebBrowser.openBrowserAsync(url);
  else await Linking.openURL(url);
}

/** One plan purchase in Peable's sheet; its outcome is this store's plan status, nothing else. */
function PlanCheckoutSheet({
  storeId,
  view,
  onClose,
}: {
  storeId: string;
  view: MerchantPlanCheckoutView;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  const [settlement, setSettlement] = useState<SheetSettlement | null>(null);
  const outcome = usePlanCheckoutOutcome(storeId, settlement);
  const source = sessionSource(view.clientSecret);
  if (!source) return null;
  return (
    <PeableSheetCheckout
      source={source}
      {...(PEABLE_GATEWAY_URL ? { gatewayUrl: PEABLE_GATEWAY_URL } : {})}
      checkoutUrl={PEABLE_CHECKOUT_URL}
      locale={locale}
      expected={planCheckoutExpectation(view)}
      presentation={{
        merchant: 'Mercaria',
        recurring: { interval: sheetInterval(view.interval) },
        itemDetail: () =>
          t(
            view.interval === 'annual'
              ? 'settings.plan.intervalAnnual'
              : 'settings.plan.intervalMonthly',
          ),
      }}
      openUrl={openFromSheet}
      onSettled={setSettlement}
      outcome={outcome}
      onUnavailable={(reason) => {
        toast.error(
          t(
            reason === 'mismatch'
              ? 'settings.plan.checkoutMismatch'
              : 'settings.plan.checkoutUnreadable',
          ),
        );
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/**
 * Move a live subscription to this plan or cadence, after saying exactly what
 * happens to the money: the change starts now and is settled on one invoice.
 */
function ChangeAction({
  storeId,
  plan,
  interval,
  currency,
}: {
  storeId: string;
  plan: MerchantPlanCatalogEntry;
  interval: BillingInterval;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const change = useChangePlan(storeId);

  return (
    <>
      <Button appearance="outline" tone="accent" onPress={() => setOpen(true)}>
        {t('settings.plan.switchTo', { plan: plan.name })}
      </Button>
      <Dialog
        open={open}
        title={t('settings.plan.changeConfirmTitle', { plan: plan.name })}
        dismissOnBackdrop={!change.isPending}
        onClose={() => {
          if (!change.isPending) setOpen(false);
        }}
      >
        <View className="gap-3">
          <Text className="text-sm text-foreground">{t('settings.plan.changeConfirmBody')}</Text>
          <Button appearance="outline" disabled={change.isPending} onPress={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            tone="accent"
            loading={change.isPending}
            onPress={() => {
              change.mutate(
                { planId: plan.planId, interval, currency },
                {
                  onSuccess: () => {
                    setOpen(false);
                    toast.success(t('settings.plan.changed'));
                  },
                  onError: () => toast.error(t('settings.plan.changeFailed')),
                },
              );
            }}
          >
            {t('settings.plan.changeConfirm')}
          </Button>
        </View>
      </Dialog>
    </>
  );
}
