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

import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import Head from "expo-router/head";
import { View } from "react-native";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { Button, SectionHeader, Text } from "@mercaria/ui";
import type { GuestClaimBlockReason, GuestClaimOrderRef } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useGuestClaim, useGuestClaimPreview } from "@/lib/hooks/use-guest-claim";
import { track } from "@/lib/analytics";
import { useTranslation } from "@/lib/i18n";

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
const CLAIM_BENEFIT_KEYS = [
  "guestOrders.claim.benefits.history",
  "guestOrders.claim.benefits.anyDevice",
  "guestOrders.claim.benefits.review",
];

/**
 * The one sentence each refusal deserves, as a KEY resolved at the render site.
 *
 * A `Record` rather than a `switch` for the reason the brief gives about
 * module scope: a `const` evaluated at import cannot call `t()`, so the map
 * holds keys and the sentence is looked up while rendering. It keeps the
 * exhaustiveness the switch had — a new reason code fails `tsc` here.
 *
 * `claimed_by_another_account` deliberately does not say WHICH account: that is
 * a fact about somebody else's purchase, and a rival claimant learns only that
 * the group is taken.
 */
const CLAIM_BLOCK_MESSAGE_KEYS: Record<GuestClaimBlockReason, string> = {
  claiming_unavailable: "guestOrders.claim.blocked.unavailable",
  claim_scope_missing: "guestOrders.claim.blocked.inboxNotVerified",
  inbox_not_verified: "guestOrders.claim.blocked.inboxNotVerified",
  claimed_by_another_account: "guestOrders.claim.blocked.claimedByAnotherAccount",
};

function ClaimBody() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ group?: string }>();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const claim = useGuestClaim();

  const checkoutGroupId = params.group;
  const preview = useGuestClaimPreview(checkoutGroupId, isAuthenticated);

  /**
   * `guest_claim_offered` (#111), emitted when the review screen has actually
   * RENDERED an offer.
   *
   * #109 deferred this rather than derive it from the preview ENDPOINT being
   * read, and the distinction is the whole reason it is here: a client can poll
   * that endpoint, and a claim made from a link the buyer never looked at would
   * still have counted an offer. The condition below is "the preview resolved
   * AND it says a claim is possible" — an unclaimable preview is not an offer,
   * it is an explanation.
   */
  useEffect(() => {
    if (preview.data === undefined || !preview.data.claimable) return;
    track("guest_claim_offered");
  }, [preview.data]);

  if (!checkoutGroupId) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("guestOrders.claim.missingTitle")} />
        <Text className="text-sm text-muted-foreground">
          {t("guestOrders.claim.missingBody")}
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
        <SectionHeader title={t("guestOrders.claim.signInTitle")} />
        <Text className="text-sm text-muted-foreground">
          {t("guestOrders.claim.signInBody")}
        </Text>
        <Button onPress={() => openAccountDialog()}>
          <Text className="text-sm font-semibold text-primary-foreground">
            {t("guestOrders.claim.signInAction")}
          </Text>
        </Button>
      </View>
    );
  }

  if (claim.isSuccess) {
    return (
      <View className="px-4 gap-4" accessibilityLiveRegion="polite">
        <SectionHeader
          title={
            claim.data.alreadyClaimed
              ? t("guestOrders.claim.alreadySavedTitle")
              : t("guestOrders.claim.savedTitle")
          }
        />
        <Text className="text-sm text-muted-foreground">
          {claim.data.alreadyClaimed
            ? t("guestOrders.claim.alreadySavedBody")
            : t("guestOrders.claim.savedBody")}
        </Text>
        <Button onPress={() => router.replace("/orders")}>
          <Text className="text-sm font-semibold text-primary-foreground">
            {t("guestOrders.claim.goToOrders")}
          </Text>
        </Button>
      </View>
    );
  }

  if (preview.isPending) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("guestOrders.claim.checkingTitle")} />
        <Text className="text-sm text-muted-foreground">{t("guestOrders.oneMoment")}</Text>
      </View>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <View className="px-4 gap-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("guestOrders.claim.failedTitle")} />
        <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
          {t("guestOrders.claim.failedBody")}
        </Text>
        <Button variant="outline" onPress={() => router.replace("/guest-orders/recover")}>
          <Text className="text-sm font-medium text-foreground">
            {t("guestOrders.sendAccessLink")}
          </Text>
        </Button>
      </View>
    );
  }

  const { orders, claimable, alreadyClaimedByYou, blockReason } = preview.data;

  return (
    <View className="px-4 gap-6" accessibilityLiveRegion="polite">
      <SectionHeader
        title={
          alreadyClaimedByYou
            ? t("guestOrders.claim.reviewAlreadyTitle")
            : t("guestOrders.claim.reviewTitle")
        }
      />

      {/* UX rule 5: exactly which checkout and which sibling orders attach. */}
      <View className="gap-3">
        <Text className="text-sm text-muted-foreground">
          {orders.length === 1
            ? t("guestOrders.claim.oneOrder")
            : t("guestOrders.claim.manyOrders", { count: orders.length })}
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
        {CLAIM_BENEFIT_KEYS.map((benefitKey) => (
          <Text key={benefitKey} className="text-sm text-muted-foreground">
            {t(benefitKey)}
          </Text>
        ))}
        <Text className="text-sm text-muted-foreground">
          {t("guestOrders.claim.notRequired")}
        </Text>
      </View>

      {blockReason ? (
        <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
          {t(CLAIM_BLOCK_MESSAGE_KEYS[blockReason])}
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
            {alreadyClaimedByYou ? t("common.confirm") : t("guestOrders.claim.submit")}
          </Text>
        </Button>
        {/*
          UX rule 9: declining leaves purchase access exactly as it was.

          `guest_claim_declined` (#111) is emitted from THIS press and from
          nowhere else. #109 deferred it rather than derive it from "a preview
          was read and no claim followed", because the server cannot tell that
          from a lost connection, a closed tab or a person who went to find
          their password. An explicit dismissal is the only decline there is.
        */}
        <Button
          variant="outline"
          onPress={() => {
            track("guest_claim_declined");
            router.back();
          }}
          disabled={claim.isPending}
        >
          <Text className="text-sm font-medium text-foreground">
            {t("guestOrders.claim.decline")}
          </Text>
        </Button>
      </View>
    </View>
  );
}

export default function GuestOrderClaimScreen() {
  const { t } = useTranslation();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>{t("guestOrders.claim.pageTitle")}</title>
        {/* Reached from the portal, which is the page a credential lands on. */}
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <ClaimBody />
    </ScreenShell>
  );
}
