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
import { Text, Button, Label, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
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
  return (
    <>
      <Head>
        <title>Payments & payouts | Mercaria Dashboard</title>
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
  const { data, isPending, isError } = usePaymentSettings(storeId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">Back</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title="Payments & payouts" action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title="Payments & payouts" action={back}>
        <ScreenMessage title="Couldn't load payment settings" body="Please try again." />
      </Screen>
    );
  }

  return (
    <Screen
      title="Payments & payouts"
      subtitle="How you get paid for orders placed on Mercaria"
      action={back}
    >
      <PaymentsPanel storeId={storeId} settings={data} />
    </Screen>
  );
}

/** Copy per state: what is true now, and what changes it. */
const STATE_COPY: Record<
  ProviderOnboardingState,
  { heading: string; body: string; action?: string }
> = {
  not_connected: {
    heading: "Not set up yet",
    body:
      "Your listings are visible and you can use every other part of Mercaria, but buyers " +
      "cannot check out with them yet. Setting up payouts takes a few minutes.",
    action: "Set up payouts",
  },
  action_required: {
    heading: "A few details are still needed",
    body:
      "Stripe needs more information before it can pay you out. Until it has everything, " +
      "buyers cannot check out with your listings.",
    action: "Continue setup",
  },
  under_review: {
    heading: "Under review",
    body:
      "Stripe has what it asked for and is reviewing it. There is nothing for you to do — " +
      "this usually takes a day or two. Buyers cannot check out with your listings until it " +
      "finishes.",
  },
  ready: {
    heading: "Ready to be paid",
    body: "Buyers can check out with your listings, and Stripe pays your balance out to your bank.",
    action: "Manage payout details",
  },
  restricted: {
    heading: "Payouts are paused",
    body:
      "Something Stripe asked for is now overdue, so it has paused payouts and buyers cannot " +
      "check out with your listings. Finishing it restores both.",
    action: "Resolve now",
  },
  disabled: {
    heading: "This account can no longer be used",
    body:
      "Stripe has closed this connected account, or its connection to Mercaria was removed. " +
      "Buyers cannot check out with your listings. Contact Mercaria support to look into it.",
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
      toast.error("Couldn't open the payout setup");
    } finally {
      setOpening(false);
    }
  }

  return (
    <View className="gap-5">
      <View className={`rounded-2xl border p-4 ${STATE_TONE[account.onboardingState]}`}>
        <Text className="text-sm font-semibold text-foreground">{copy.heading}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">{copy.body}</Text>

        {copy.action !== undefined && onboardingAvailable ? (
          <Button onPress={startOnboarding} isLoading={busy} className="mt-4 self-start">
            <Text className="font-semibold text-primary-foreground">{copy.action}</Text>
          </Button>
        ) : null}

        {!onboardingAvailable ? (
          <Text className="mt-3 text-xs text-muted-foreground">
            Payout setup is not available on this Mercaria deployment yet.
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
  const outstanding = requirements.currentlyDue + requirements.pastDue;
  if (outstanding === 0 && requirements.pendingVerification === 0) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Outstanding with Stripe</Text>
      <Row
        label="Needed now"
        value={outstanding === 0 ? "None" : `${String(outstanding)} item(s)`}
      />
      {requirements.pendingVerification > 0 ? (
        <Row
          label="Being reviewed"
          value={`${String(requirements.pendingVerification)} item(s)`}
        />
      ) : null}
      {requirements.currentDeadline !== undefined ? (
        <Row label="Due by" value={new Date(requirements.currentDeadline).toLocaleDateString()} />
      ) : null}
      <Text className="mt-3 text-xs text-muted-foreground">
        Stripe holds these details and is the only place to complete them. Mercaria never sees
        them.
      </Text>
    </View>
  );
}

/** Payout currency and schedule, shown only when Stripe supplies them. */
function PayoutDetailsCard({ settings }: { settings: SellerPaymentSettings }) {
  const { account } = settings;
  if (account.payoutCurrency === undefined && account.payoutSchedule === undefined) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Payouts</Text>
      {account.payoutCurrency !== undefined ? (
        <Row label="Paid out in" value={account.payoutCurrency} />
      ) : null}
      {account.payoutSchedule !== undefined ? (
        <Row
          label="Schedule"
          value={
            account.payoutSchedule.delayDays === undefined
              ? account.payoutSchedule.interval
              : `${account.payoutSchedule.interval}, after ${String(account.payoutSchedule.delayDays)} days`
          }
        />
      ) : null}
      {account.country !== undefined ? <Row label="Registered in" value={account.country} /> : null}
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
  if (codes.length === 0) return null;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="mb-2 text-sm font-semibold text-foreground">Reported by Stripe</Text>
      {codes.map((code) => (
        <Text key={code} className="text-xs text-muted-foreground">
          {code}
        </Text>
      ))}
      <Text className="mt-3 text-xs text-muted-foreground">
        Quote this to Mercaria support if you need help.
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
