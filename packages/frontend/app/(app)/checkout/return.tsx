/**
 * Where a buyer lands after their bank's authentication step (ADR 0006 G10).
 *
 * ## The return proves nothing, and this screen is built around that
 *
 * Stripe appends its own `redirect_status` and `payment_intent_client_secret` to
 * this URL, and neither is read here. Whatever the query string says, this page
 * asks Mercaria's own `GET /checkout/:checkoutGroupId/payment-status`, which
 * answers from the payment aggregate — a value only a verified webhook moves.
 * The same posture as onboarding's `return_url` (ADR 0001 D2): a redirect is
 * navigation, not evidence.
 *
 * ## The one parameter it does read is not a credential
 *
 * `checkoutGroupId` is a server-issued uuid the server itself put into the
 * return URL. Knowing it authorizes nothing: the status endpoint scopes its
 * answer to the CALLER — an Oxy account that owns or claimed the orders, or the
 * guest session whose `guest_checkouts` row names the group — and answers 404
 * to anyone else. So a pasted link shows a stranger nothing.
 *
 * ## The guest credential survives the round trip by construction
 *
 * The bank redirect is a top-level navigation back to `mercaria.co`, and
 * `__Host-mercaria_guest` is `SameSite=Lax` — which permits exactly that. The
 * poll below is then the same same-site request it would have been without the
 * detour, so nothing has to be re-established. On native the sheet handles its
 * own return and this route is not used.
 *
 * ## Losing this page costs nothing
 *
 * A buyer who closes the tab here still gets their order: the webhook chain runs
 * to completion server-side, the orders reach `paid`, and #108's confirmation
 * carries the portal path. This screen is a convenience for the buyer who came
 * back, not a step the payment depends on.
 */

import { useEffect } from "react";
import Head from "expo-router/head";
import { View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { track } from "../../../lib/analytics";
import { Button, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useCheckoutPaymentStatus } from "@/lib/hooks/use-checkout";
import { usePortalConfirmation } from "@/lib/hooks/use-guest-portal";
import { useTranslation } from "@/lib/i18n";

function CheckoutReturnBody() {
  const { t } = useTranslation();
  const router = useRouter();
  const portalConfirmation = usePortalConfirmation();
  const { isAuthenticated } = useOxy();
  const { checkoutGroupId } = useLocalSearchParams<{ checkoutGroupId?: string }>();
  // `enabled` is unconditionally true here: arriving on this route IS the
  // trigger. There is no sheet result to wait for — the buyer has just come back
  // from their bank, and the only thing left to do is ask the server.
  const paymentStatus = useCheckoutPaymentStatus(checkoutGroupId, Boolean(checkoutGroupId));
  const status = paymentStatus.data?.status;

  /**
   * `guest_payment_action_required` (#111), emitted from HERE and not from the
   * payment step.
   *
   * The step-up is invisible to the component that started the payment:
   * `confirmPayment` with `redirect: 'if_required'` either handles the
   * challenge inline and returns, or navigates the whole page away — and in the
   * second case there is no callback to fire, because the JavaScript that would
   * have fired it is gone. ARRIVING on this route is therefore the only
   * client-observable evidence that an issuer demanded one, which is why the
   * event belongs to the return screen.
   *
   * It says nothing about the OUTCOME. Whether the payment succeeded is read
   * from `payments` by the poll below, and no event asserts it.
   */
  useEffect(() => {
    if (!checkoutGroupId) return;
    track('guest_payment_action_required');
  }, [checkoutGroupId]);

  /**
   * Where the buyer goes from here.
   *
   * A guest lands on the SECURE ORDER PORTAL (#93 client rule 12, #108) rather
   * than the storefront: they have just paid, and the storefront can tell them
   * nothing about the order. The confirmation grant is minted here because this
   * is the first moment there is a client to hand one to — see
   * `docs/guest-portal.md` on why it is PULLED and never pushed.
   *
   * `onSettled`, so a mint that fails still lands on the portal, which has its
   * own recovery path where the storefront has none.
   */
  const leave = () => {
    if (isAuthenticated) {
      router.replace("/orders");
      return;
    }
    if (!checkoutGroupId) {
      router.replace("/");
      return;
    }
    const group = checkoutGroupId;
    const toPortal = () =>
      router.replace(`/guest-orders/portal?group=${encodeURIComponent(group)}`);
    portalConfirmation.mutate(group, { onSettled: toPortal });
  };

  if (!checkoutGroupId) {
    return (
      <View className="px-4">
        <SectionHeader title={t("payment.title")} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t("payment.return.missingGroup")}</Text>
          <Button variant="outline" onPress={leave}>
            <Text className="text-sm font-medium text-foreground">{t("payment.continue")}</Text>
          </Button>
        </View>
      </View>
    );
  }

  // A live region on every branch: this screen resolves on its own while the
  // buyer waits, so a screen reader must be told when it does.
  if (status === "succeeded") {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("payment.received.title")} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t("payment.received.body")}</Text>
          {/*
            #109 UX rule 1: the OFFER, on the guest confirmation. Shown only to
            a signed-out buyer, because an authenticated one already has these
            orders in their history — there is nothing to claim.

            It is a LINK to the review screen rather than an action, and rule 2
            is why the copy says "you do not need to": claiming is optional, the
            order is already confirmed, and the review screen is where the
            benefits and the confirmation live. Guest proof is still required
            there (rule 8) — the link carries a checkout group and nothing that
            could stand in for one.
          */}
          {!isAuthenticated ? (
            <>
              <Link
                href={{ pathname: "/guest-orders/claim", params: { group: checkoutGroupId } }}
                asChild
              >
                <Button variant="outline">
                  <Text className="text-sm font-medium text-foreground">
                    {t("checkout.claim.saveToOxy")}
                  </Text>
                </Button>
              </Link>
              <Text className="text-sm text-muted-foreground">{t("checkout.claim.optional")}</Text>
            </>
          ) : null}
          <Button onPress={leave}>
            <Text className="text-sm font-semibold text-primary-foreground">
              {isAuthenticated ? t("checkout.viewOrders") : t("checkout.keepShopping")}
            </Text>
          </Button>
        </View>
      </View>
    );
  }

  if (status === "canceled") {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("payment.cancelled.title")} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t("payment.cancelled.body")}</Text>
          <Button variant="outline" onPress={leave}>
            <Text className="text-sm font-medium text-foreground">{t("payment.continue")}</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (paymentStatus.isError) {
    return (
      <View className="px-4" accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <SectionHeader title={t("payment.unreadable.title")} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">{t("payment.unreadable.body")}</Text>
          <Button variant="outline" onPress={leave}>
            <Text className="text-sm font-medium text-foreground">{t("payment.continue")}</Text>
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="px-4" accessibilityLiveRegion="polite">
      <SectionHeader title={t("payment.confirming.title")} />
      <View className="gap-4">
        <Text className="text-sm text-muted-foreground">{t("payment.confirming.returnBody")}</Text>
        <Button variant="outline" onPress={leave}>
          <Text className="text-sm font-medium text-foreground">
            {t("payment.confirming.continueWithoutWaiting")}
          </Text>
        </Button>
      </View>
    </View>
  );
}

export default function CheckoutReturnScreen() {
  const { t } = useTranslation();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>{t("payment.confirming.pageTitle")}</title>
      </Head>
      <CheckoutReturnBody />
    </ScreenShell>
  );
}
