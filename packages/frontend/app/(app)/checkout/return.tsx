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

import Head from "expo-router/head";
import { View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { Button, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useCheckoutPaymentStatus } from "@/lib/hooks/use-checkout";

function CheckoutReturnBody() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const { checkoutGroupId } = useLocalSearchParams<{ checkoutGroupId?: string }>();
  // `enabled` is unconditionally true here: arriving on this route IS the
  // trigger. There is no sheet result to wait for — the buyer has just come back
  // from their bank, and the only thing left to do is ask the server.
  const paymentStatus = useCheckoutPaymentStatus(checkoutGroupId, Boolean(checkoutGroupId));
  const status = paymentStatus.data?.status;

  const leave = () =>
    router.replace(
      (isAuthenticated ? "/orders" : "/") as Parameters<typeof router.replace>[0],
    );

  if (!checkoutGroupId) {
    return (
      <View className="px-4">
        <SectionHeader title="Payment" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            This link is missing the checkout it belongs to. If you completed a payment, your
            order is safe — nothing here changes it.
          </Text>
          <Button variant="outline" onPress={leave}>
            <Text className="text-sm font-medium text-foreground">Continue</Text>
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
        <SectionHeader title="Payment received" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            Thank you. Your order is confirmed and the seller has been notified.
          </Text>
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
                    Save these orders to Oxy
                  </Text>
                </Button>
              </Link>
              <Text className="text-sm text-muted-foreground">
                Optional. Your order is confirmed either way.
              </Text>
            </>
          ) : null}
          <Button onPress={leave}>
            <Text className="text-sm font-semibold text-primary-foreground">
              {isAuthenticated ? "View your orders" : "Keep shopping"}
            </Text>
          </Button>
        </View>
      </View>
    );
  }

  if (status === "canceled") {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Payment cancelled" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            This payment was cancelled and nothing was charged.
          </Text>
          <Button variant="outline" onPress={leave}>
            <Text className="text-sm font-medium text-foreground">Continue</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (paymentStatus.isError) {
    return (
      <View className="px-4" accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <SectionHeader title="We could not read this payment" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            We could not check this payment from here. If it went through, your order is safe —
            this page cannot change it either way.
          </Text>
          <Button variant="outline" onPress={leave}>
            <Text className="text-sm font-medium text-foreground">Continue</Text>
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="px-4" accessibilityLiveRegion="polite">
      <SectionHeader title="Confirming your payment" />
      <View className="gap-4">
        <Text className="text-sm text-muted-foreground">
          Your bank has sent you back to us and we are confirming the payment. This usually takes
          a few seconds.
        </Text>
        <Button variant="outline" onPress={leave}>
          <Text className="text-sm font-medium text-foreground">Continue without waiting</Text>
        </Button>
      </View>
    </View>
  );
}

export default function CheckoutReturnScreen() {
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>Confirming your payment — Mercaria</title>
      </Head>
      <CheckoutReturnBody />
    </ScreenShell>
  );
}
