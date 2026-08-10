/**
 * The claim REVIEW screen (#109 UX rules 4-11).
 *
 * ## Nothing on this screen submits by itself
 *
 * A person arrives here after signing in, from the portal's "Save these orders
 * to Oxy" button. UX rule 10 says the claim must never auto-submit immediately
 * after authentication, and this screen holds that structurally rather than by
 * discipline: the only call it makes on arrival is the PREVIEW, which is a GET
 * and completes nothing, and the claim is a mutation behind an explicit press.
 * There is no effect here that could fire one.
 *
 * ## Declining costs nothing
 *
 * UX rule 9: "keep purchase access usable if the user declines". Going back
 * leaves the portal credential intact and the orders exactly where they were —
 * which is true because a decline is the ABSENCE of a request rather than a
 * request of its own. The screen says so in as many words, because a person
 * deciding whether to link a purchase to an account needs to know that the
 * alternative works.
 *
 * ## What it never says
 *
 * Nothing about who holds a contested group (that is a fact about a stranger),
 * nothing about a referral partner or attribution (UX rule 12), and no benefit
 * that does not exist today — the list below is #109's own "capabilities that
 * actually exist", and the two payment rails UX rule 11 and acceptance 13
 * exclude are absent from it. `guest-claim-isolation.test.ts` scans this file's
 * RAW source, comments included, and fails the build on either name — which is
 * why this paragraph describes the prohibition rather than spelling it.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { View } from "react-native";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { Button, SectionHeader, Text } from "@mercaria/ui";
import type { GuestClaimBlockReason, GuestClaimOrderRef } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useGuestClaim, useGuestClaimPreview } from "@/lib/hooks/use-guest-claim";

/**
 * What a claim actually gets you, today.
 *
 * #109's "account benefits after claim" list, filtered to the capabilities that
 * EXIST — the issue is explicit that a claim may enable "only capabilities that
 * actually exist". Notification preferences, saved follow-up actions and
 * document access are omitted because they are not built, and promising them
 * here would be the "coming soon" copy acceptance 13 forbids for a different
 * feature and the same reason.
 */
const CLAIM_BENEFITS = [
  "These orders appear in your normal Mercaria order history.",
  "You can open them from any device you are signed in on.",
  "You can write a verified-purchase review of what you bought.",
];

/** The one sentence each refusal deserves. Exhaustive, so a new code fails `tsc`. */
function blockMessage(reason: GuestClaimBlockReason): string {
  switch (reason) {
    case "claiming_unavailable":
      return "Saving orders to an Oxy account is temporarily unavailable. Your order is unaffected and you can still open it from your access link.";
    case "claim_scope_missing":
    case "inbox_not_verified":
      return "Confirm your email address first. Ask for a new access link and open this page from it.";
    case "claimed_by_another_account":
      // Deliberately does not say WHICH account: that is a fact about somebody
      // else's purchase, and a rival claimant learns only that the group is
      // taken.
      return "These orders are already saved to another Oxy account. Contact support if that is not what you expected — Mercaria will not move them automatically.";
  }
}

function ClaimBody() {
  const params = useLocalSearchParams<{ group?: string }>();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const claim = useGuestClaim();

  const checkoutGroupId = params.group;
  const preview = useGuestClaimPreview(checkoutGroupId, isAuthenticated);

  if (!checkoutGroupId) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Nothing to save" />
        <Text className="text-sm text-muted-foreground">
          Open this page from your order so we know which purchase you mean.
        </Text>
      </View>
    );
  }

  if (!isAuthenticated) {
    // UX rule 3: start or resume the normal Oxy sign-in flow, and come BACK
    // here. The sheet is the SDK's own in-app sign-in — never a redirect to an
    // identity provider, which would lose the portal credential's cookie on the
    // way back.
    return (
      <View className="px-4 gap-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Sign in to save these orders" />
        <Text className="text-sm text-muted-foreground">
          Signing in adds this purchase to your Mercaria order history. Your order works
          exactly as it does now if you would rather not.
        </Text>
        <Button onPress={() => openAccountDialog()}>
          <Text className="text-sm font-semibold text-primary-foreground">
            Sign in to Oxy
          </Text>
        </Button>
      </View>
    );
  }

  if (claim.isSuccess) {
    return (
      <View className="px-4 gap-4" accessibilityLiveRegion="polite">
        <SectionHeader
          title={claim.data.alreadyClaimed ? "Already saved" : "Saved to your account"}
        />
        <Text className="text-sm text-muted-foreground">
          {claim.data.alreadyClaimed
            ? "These orders were already in your Mercaria order history."
            : "These orders are now in your Mercaria order history. The access link you used has been retired — you can open them from your account from now on."}
        </Text>
        <Button onPress={() => router.replace("/orders")}>
          <Text className="text-sm font-semibold text-primary-foreground">
            Go to my orders
          </Text>
        </Button>
      </View>
    );
  }

  if (preview.isPending) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Checking this order" />
        <Text className="text-sm text-muted-foreground">One moment.</Text>
      </View>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <View className="px-4 gap-4" accessibilityLiveRegion="polite">
        <SectionHeader title="We could not open this order" />
        <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
          Your access link may have expired. Ask for a new one and try again — your order is
          unaffected either way.
        </Text>
        <Button variant="outline" onPress={() => router.replace("/guest-orders/recover")}>
          <Text className="text-sm font-medium text-foreground">Send me an access link</Text>
        </Button>
      </View>
    );
  }

  const { orders, claimable, alreadyClaimedByYou, blockReason } = preview.data;

  return (
    <View className="px-4 gap-6" accessibilityLiveRegion="polite">
      <SectionHeader
        title={alreadyClaimedByYou ? "Already in your account" : "Save these orders to Oxy"}
      />

      {/* UX rule 5: exactly which checkout and which sibling orders attach. */}
      <View className="gap-3">
        <Text className="text-sm text-muted-foreground">
          {orders.length === 1
            ? "This order will be added to your account:"
            : `These ${orders.length} orders were placed together and will be added to your account:`}
        </Text>
        {orders.map((order: GuestClaimOrderRef) => (
          <View key={order.id} className="gap-1">
            <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
            <Text className="text-sm text-muted-foreground">
              {order.sellerLabel} · {order.status}
            </Text>
          </View>
        ))}
      </View>

      {/* UX rule 2: concrete benefits, without implying it is required. */}
      <View className="gap-2">
        {CLAIM_BENEFITS.map((benefit) => (
          <Text key={benefit} className="text-sm text-muted-foreground">
            {benefit}
          </Text>
        ))}
        <Text className="text-sm text-muted-foreground">
          You do not need to do this to receive your order.
        </Text>
      </View>

      {blockReason ? (
        <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
          {blockMessage(blockReason)}
        </Text>
      ) : null}

      {claim.isError ? (
        <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
          {claim.error.message}
        </Text>
      ) : null}

      {/* UX rule 6: an explicit confirmation, and nothing that presses it. */}
      <View className="gap-3">
        <Button
          onPress={() => claim.mutate(checkoutGroupId)}
          disabled={!claimable || claim.isPending}
        >
          <Text className="text-sm font-semibold text-primary-foreground">
            {alreadyClaimedByYou ? "Confirm" : "Save these orders to my account"}
          </Text>
        </Button>
        {/* UX rule 9: declining leaves purchase access exactly as it was. */}
        <Button variant="outline" onPress={() => router.back()} disabled={claim.isPending}>
          <Text className="text-sm font-medium text-foreground">Not now</Text>
        </Button>
      </View>
    </View>
  );
}

export default function GuestOrderClaimScreen() {
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>Save your orders — Mercaria</title>
        {/* Reached from the portal, which is the page a credential lands on. */}
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <ClaimBody />
    </ScreenShell>
  );
}
