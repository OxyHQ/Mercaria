import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import * as WebBrowser from "expo-web-browser";
import { ChevronLeft } from "lucide-react-native";
import type {
  ProviderOnboardingState,
  SellerPaymentSettings,
} from "@mercaria/shared-types";
import { Text, Button, Label, formatDate, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import {
  usePaymentSettings,
  useCreateOnboardingLink,
  useRefreshPaymentSettings,
} from "@/lib/hooks/use-payments";

/**
 * Payments & payouts — the seller side of ADR 0001's connected account.
 *
 * ## What this screen may and may not say
 *
 * It explains, factually, which Mercaria features are unavailable in each state
 * and what changes it. It does NOT interpret the provider's requirements, guess
 * at why an account was rejected, or offer anything that could be read as
 * compliance advice: Stripe collects and holds the identity data (ADR 0001 D2),
 * so Stripe is also the only party that can tell a seller what is missing.
 * Mercaria knows HOW MANY things are outstanding and when they are due, and
 * that is deliberately all this screen has to work with.
 *
 * ## Hosted onboarding opens in the SYSTEM browser
 *
 * Not a webview — Stripe's hosted flow does not run in one. `openBrowserAsync`
 * is the same call the channels screen makes for OAuth, and for the same reason.
 *
 * ## The browser closing is not evidence of anything
 *
 * When it closes the screen refetches, and may well still show `action_required`
 * — readiness comes from Stripe's `account.updated` webhook and the
 * reconciliation sweep, never from a redirect (ADR 0001 D2). The copy says so
 * rather than pretending the refetch is authoritative.
 */
export default function PaymentsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.payments.documentTitle")}</title>
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
      <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title={t("settings.payments.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t("settings.payments.title")} action={back}>
        <ScreenMessage
          title={t("settings.payments.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={t("settings.payments.title")}
      subtitle={t("settings.payments.subtitle")}
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
    headingKey: "settings.payments.states.notConnected.heading",
    bodyKey: "settings.payments.states.notConnected.body",
    actionKey: "settings.payments.states.notConnected.action",
  },
  action_required: {
    headingKey: "settings.payments.states.actionRequired.heading",
    bodyKey: "settings.payments.states.actionRequired.body",
    actionKey: "settings.payments.states.actionRequired.action",
  },
  under_review: {
    headingKey: "settings.payments.states.underReview.heading",
    bodyKey: "settings.payments.states.underReview.body",
  },
  ready: {
    headingKey: "settings.payments.states.ready.heading",
    bodyKey: "settings.payments.states.ready.body",
    actionKey: "settings.payments.states.ready.action",
  },
  restricted: {
    headingKey: "settings.payments.states.restricted.heading",
    bodyKey: "settings.payments.states.restricted.body",
    actionKey: "settings.payments.states.restricted.action",
  },
  disabled: {
    headingKey: "settings.payments.states.disabled.heading",
    bodyKey: "settings.payments.states.disabled.body",
  },
};

/** The visual weight each state carries. Never a colour used for anything else. */
const STATE_TONE: Record<ProviderOnboardingState, string> = {
  not_connected: "border-border bg-surface",
  action_required: "border-border bg-surface",
  under_review: "border-border bg-surface",
  ready: "border-primary bg-surface",
  restricted: "border-destructive bg-surface",
  disabled: "border-destructive bg-surface",
};

function PaymentsPanel({
  storeId,
  settings,
}: {
  storeId: string;
  settings: SellerPaymentSettings;
}) {
  const { account, onboardingAvailable, supportedCountries } = settings;
  const [opening, setOpening] = useState(false);
  const { t } = useTranslation();
  const createLink = useCreateOnboardingLink(storeId);
  const refresh = useRefreshPaymentSettings(storeId);

  const copy = STATE_COPY[account.onboardingState];
  const busy = createLink.isPending || opening;

  async function startOnboarding(): Promise<void> {
    try {
      setOpening(true);
      const link = await createLink.mutateAsync(
        // Only meaningful the first time — the country is immutable at Stripe
        // once the account exists, and the server ignores a later value.
        account.country === undefined ? { country: supportedCountries[0] } : {},
      );
      // The SYSTEM browser, never a webview: Stripe's hosted flow does not run
      // in one. On web this opens a new tab.
      await WebBrowser.openBrowserAsync(link.url);
      // The browser closing proves nothing — refetch and show whatever Stripe
      // has actually told the backend by now.
      await refresh();
    } catch {
      toast.error(t("settings.payments.openFailed"));
    } finally {
      setOpening(false);
    }
  }

  return (
    <View className="gap-5">
      <View className={`rounded-2xl border p-4 ${STATE_TONE[account.onboardingState]}`}>
        <Text className="text-sm font-semibold text-foreground">{t(copy.headingKey)}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">{t(copy.bodyKey)}</Text>

        {copy.actionKey !== undefined && onboardingAvailable ? (
          <Button onPress={startOnboarding} isLoading={busy} className="mt-4 self-start">
            <Text className="font-semibold text-primary-foreground">{t(copy.actionKey)}</Text>
          </Button>
        ) : null}

        {!onboardingAvailable ? (
          <Text className="mt-3 text-xs text-muted-foreground">
            {t("settings.payments.onboardingUnavailable")}
          </Text>
        ) : null}
      </View>

      <RequirementsCard settings={settings} />
      <PayoutDetailsCard settings={settings} />
      <ReasonCodesCard settings={settings} />
    </View>
  );
}

/** Counts and a deadline — never the list, which only Stripe holds. */
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
        {t("settings.payments.outstandingTitle")}
      </Text>
      <Row
        label={t("settings.payments.neededNow")}
        value={
          outstanding === 0
            ? t("common.none")
            : t("settings.payments.itemCount", { count: outstanding })
        }
      />
      {requirements.pendingVerification > 0 ? (
        <Row
          label={t("settings.payments.beingReviewed")}
          value={t("settings.payments.itemCount", { count: requirements.pendingVerification })}
        />
      ) : null}
      {/* `Row`'s value is the whole of what the row says, so an unformattable
          deadline drops the row rather than rendering "Invalid Date" beside a
          "Due by" label (#529). */}
      {deadline === null ? null : <Row label={t("settings.payments.dueBy")} value={deadline} />}
      <Text className="mt-3 text-xs text-muted-foreground">
        {t("settings.payments.requirementsNote")}
      </Text>
    </View>
  );
}

/** Payout currency and schedule, shown only when Stripe supplies them. */
function PayoutDetailsCard({ settings }: { settings: SellerPaymentSettings }) {
  const { account } = settings;
  const { t } = useTranslation();
  if (account.payoutCurrency === undefined && account.payoutSchedule === undefined) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">
        {t("settings.payments.payoutsTitle")}
      </Text>
      {account.payoutCurrency !== undefined ? (
        <Row label={t("settings.payments.paidOutIn")} value={account.payoutCurrency} />
      ) : null}
      {account.payoutSchedule !== undefined ? (
        <Row
          label={t("settings.payments.schedule")}
          value={
            account.payoutSchedule.delayDays === undefined
              ? account.payoutSchedule.interval
              : t("settings.payments.scheduleWithDelay", {
                  interval: account.payoutSchedule.interval,
                  count: account.payoutSchedule.delayDays,
                })
          }
        />
      ) : null}
      {account.country !== undefined ? (
        <Row label={t("settings.payments.registeredIn")} value={account.country} />
      ) : null}
    </View>
  );
}

/**
 * Stripe's own reason codes, rendered as codes.
 *
 * Deliberately not translated into prose: Mercaria does not know why Stripe made
 * a decision, and a friendly-sounding guess about someone's account being
 * rejected is worse than the code they can quote to support.
 */
function ReasonCodesCard({ settings }: { settings: SellerPaymentSettings }) {
  const codes = settings.account.disabledReasonCodes;
  const { t } = useTranslation();
  if (codes.length === 0) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-2 text-sm font-semibold text-foreground">
        {t("settings.payments.reportedByStripe")}
      </Text>
      {codes.map((code) => (
        <Text key={code} className="text-xs text-muted-foreground">
          {code}
        </Text>
      ))}
      <Text className="mt-3 text-xs text-muted-foreground">
        {t("settings.payments.quoteToSupport")}
      </Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      <Text className="text-sm text-foreground">{value}</Text>
    </View>
  );
}
