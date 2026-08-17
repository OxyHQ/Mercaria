import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import * as WebBrowser from "expo-web-browser";
import { ChevronLeft } from "lucide-react-native";
import type {
  MerchantEntitlementView,
  MerchantPlanCatalogEntry,
  MerchantPlanStatusView,
  MerchantSubscriptionStatus,
} from "@mercaria/shared-types";
import { Text, Button, useColorScheme, useFormatters } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import {
  useCancelPlan,
  useOpenBillingPortal,
  usePlanCatalog,
  usePlanStatus,
  useRefreshPlan,
  useStartPlanCheckout,
} from "@/lib/hooks/use-plan";

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
 * Every field rendered here is a RESULT the server computed. `billingAvailable`
 * decides whether an upgrade button is offered at all, and pressing it anyway
 * would simply be refused — the server re-decides on every write regardless of
 * what this screen believed (#89 entitlement rule 4).
 *
 * ## Hosted flows open in the SYSTEM browser
 *
 * Not a webview, exactly like payout onboarding: a provider's hosted checkout
 * and billing portal do not run inside one.
 */
export default function PlanScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.plan.documentTitle")}</title>
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
      <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
    </Pressable>
  );

  if (status.isPending) {
    return (
      <Screen title={t("settings.plan.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Screen title={t("settings.plan.title")} action={back}>
        <ScreenMessage title={t("settings.plan.loadFailed")} body={t("common.pleaseTryAgain")} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t("settings.plan.title")}
      subtitle={t("settings.plan.subtitle")}
      action={back}
    >
      <View className="gap-4">
        <AlwaysIncluded />
        <CurrentPlan storeId={storeId} status={status.data} />
        <PlanComparison
          storeId={storeId}
          plans={catalog.data ?? []}
          loading={catalog.isPending}
          billingAvailable={status.data.billingAvailable}
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
        {t("settings.plan.alwaysIncludedTitle")}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">
        {t("settings.plan.alwaysIncludedBody")}
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
    headingKey: "settings.plan.statuses.trialing.heading",
    bodyKey: "settings.plan.statuses.trialing.body",
  },
  active: {
    headingKey: "settings.plan.statuses.active.heading",
    bodyKey: "settings.plan.statuses.active.body",
  },
  past_due: {
    headingKey: "settings.plan.statuses.pastDue.heading",
    bodyKey: "settings.plan.statuses.pastDue.body",
  },
  paused: {
    headingKey: "settings.plan.statuses.paused.heading",
    bodyKey: "settings.plan.statuses.paused.body",
  },
  cancelled: {
    headingKey: "settings.plan.statuses.cancelled.heading",
    bodyKey: "settings.plan.statuses.cancelled.body",
  },
  expired: {
    headingKey: "settings.plan.statuses.expired.heading",
    bodyKey: "settings.plan.statuses.expired.body",
  },
};

function CurrentPlan({ storeId, status }: { storeId: string; status: MerchantPlanStatusView }) {
  const [opening, setOpening] = useState(false);
  const { t } = useTranslation();
  const portal = useOpenBillingPortal(storeId);
  const cancel = useCancelPlan(storeId);
  const refresh = useRefreshPlan(storeId);
  const subscription = status.subscription;
  const copy = subscription ? STATUS_COPY[subscription.status] : undefined;

  async function openPortal(): Promise<void> {
    try {
      setOpening(true);
      const session = await portal.mutateAsync();
      await WebBrowser.openBrowserAsync(session.url);
    } catch {
      toast.error(t("settings.plan.portalFailed"));
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
        {subscription ? subscription.planName : t("settings.plan.free")}
      </Text>
      {copy ? (
        <>
          <Text className="mt-2 text-sm font-medium text-foreground">{t(copy.headingKey)}</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{t(copy.bodyKey)}</Text>
        </>
      ) : (
        <Text className="mt-1 text-xs text-muted-foreground">
          {t("settings.plan.notOnPaidPlan")}
        </Text>
      )}

      {subscription?.graceExpiresAt ? (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t("settings.plan.graceEndsOn", { date: formatDate(subscription.graceExpiresAt) })}
        </Text>
      ) : null}
      {subscription?.cancelAt ? (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t("settings.plan.endsOn", { date: formatDate(subscription.cancelAt) })}
        </Text>
      ) : null}
      {subscription?.currentPeriodEnd && !subscription.cancelAt ? (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t("settings.plan.renewsOn", { date: formatDate(subscription.currentPeriodEnd) })}
        </Text>
      ) : null}

      <Entitlements entitlements={status.entitlements} />

      {status.portalAvailable ? (
        <View className="mt-4 flex-row gap-2">
          <Button onPress={openPortal} disabled={portal.isPending || opening}>
            {t("settings.plan.manageBilling")}
          </Button>
          {subscription && !subscription.cancelAt ? (
            <Button
              variant="outline"
              onPress={() => {
                cancel.mutate(undefined, {
                  onError: () => toast.error(t("settings.plan.cancelFailed")),
                });
              }}
              disabled={cancel.isPending}
            >
              {t("settings.plan.cancelPlan")}
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
      <Text className="mt-3 text-xs text-muted-foreground">{t("settings.plan.noExtras")}</Text>
    );
  }
  return (
    <View className="mt-3 gap-1">
      {entitlements.map((entitlement) => (
        <View key={entitlement.capability} className="flex-row items-center justify-between">
          <Text className="text-xs text-foreground">{entitlement.capability}</Text>
          <Text className="text-xs text-muted-foreground">
            {entitlement.limitKind === "flag"
              ? t("settings.plan.usageIncluded")
              : entitlement.limit === null
                ? t("settings.plan.usageNoLimit", { used: entitlement.used })
                : t("settings.plan.usageOfLimit", {
                    used: entitlement.used,
                    limit: entitlement.limit,
                  })}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The comparison. Empty is a real and correct state on this deployment.
 *
 * A plan version whose capabilities are not implemented cannot be activated at
 * all, so an empty catalogue means there is nothing genuine to sell yet — which
 * is what this says, rather than showing a "coming soon" plan nobody could buy.
 */
function PlanComparison({
  storeId,
  plans,
  loading,
  billingAvailable,
}: {
  storeId: string;
  plans: readonly MerchantPlanCatalogEntry[];
  loading: boolean;
  billingAvailable: boolean;
}) {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  if (loading) return null;
  const paid = plans.filter((plan) => plan.tier === "paid");
  if (paid.length === 0) {
    return (
      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">
          {t("settings.plan.paidPlansTitle")}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {t("settings.plan.noPaidPlans")}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-2">
      {paid.map((plan) => (
        <View
          key={plan.planId}
          className="rounded-2xl border border-border bg-surface p-4"
        >
          <Text className="text-sm font-semibold text-foreground">{plan.name}</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{plan.summary}</Text>
          <View className="mt-2 gap-1">
            {plan.prices.map((price) => (
              <Text
                key={`${price.currency}-${price.interval}`}
                className="text-xs text-foreground"
              >
                {t(
                  price.interval === "annual"
                    ? "settings.plan.pricePerYear"
                    : "settings.plan.pricePerMonth",
                  { price: formatMoney(price.unitPrice) },
                )}
              </Text>
            ))}
          </View>
          <View className="mt-2 gap-1">
            {plan.capabilities.map((capability) => (
              <Text key={capability.key} className="text-xs text-muted-foreground">
                {capability.limit === null
                  ? capability.name
                  : t("settings.plan.capabilityWithLimit", {
                      name: capability.name,
                      limit: capability.limit,
                    })}
              </Text>
            ))}
          </View>
          {plan.trialDays > 0 ? (
            <Text className="mt-2 text-xs text-muted-foreground">
              {t("settings.plan.trialNotice", { count: plan.trialDays })}
            </Text>
          ) : null}
          {billingAvailable ? <UpgradeAction storeId={storeId} plan={plan} /> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * The upgrade action, rendered only where the SERVER says billing is available.
 *
 * `billingAvailable` is a result the server computed, so hiding the button is
 * the client explaining rather than deciding: pressing it on a deployment with
 * billing off would simply be refused (#89 entitlement rule 4).
 */
function UpgradeAction({ storeId, plan }: { storeId: string; plan: MerchantPlanCatalogEntry }) {
  const [opening, setOpening] = useState(false);
  const { t } = useTranslation();
  const checkout = useStartPlanCheckout(storeId);
  const refresh = useRefreshPlan(storeId);
  const price = plan.prices[0];
  if (!price) return null;

  async function upgrade(): Promise<void> {
    try {
      setOpening(true);
      const session = await checkout.mutateAsync({
        planId: plan.planId,
        interval: price.interval,
        currency: price.currency,
      });
      // The SYSTEM browser, never a webview: a hosted provider checkout does not
      // run in one. On web this opens a new tab.
      await WebBrowser.openBrowserAsync(session.url);
    } catch {
      toast.error(t("settings.plan.upgradeFailed"));
    } finally {
      setOpening(false);
      // The browser closing is not evidence of anything — the subscription is
      // created from a provider event — but a refetch costs little.
      refresh();
    }
  }

  return (
    <View className="mt-3">
      <Button onPress={upgrade} disabled={checkout.isPending || opening}>
        {t("settings.plan.choosePlan", { plan: plan.name })}
      </Button>
    </View>
  );
}

/** A stored ISO instant as a plain date. Never a countdown — see the docblock. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
