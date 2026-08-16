import { useState } from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { Cart, NearbyLocationResult } from "@mercaria/shared-types";
import { Button, Text } from "@mercaria/ui";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { Footer } from "@/components/shell/Footer";
import { NearbyAvailability } from "@/components/nearby/NearbyAvailability";
import { useAddCartItem } from "@/lib/hooks/use-cart";

/**
 * Collect in person — the screen where a shopper turns "a shop near me has
 * this" into an order they can walk in and pick up.
 *
 * ## Why this is a screen and not a control on the product page
 *
 * The product page runs the same component in BROWSE mode, which asks the
 * server for availability and NOT for an actor-specific verdict (#93 nearby
 * rule 12): a page view should not spend per-location eligibility work, and a
 * shopper reading about a product has not decided to buy it here. This screen
 * is the surface that HAS decided, so it turns eligibility on, offers the
 * "Collect here" control only where the server said yes, and carries the choice
 * into checkout.
 *
 * ## Signed-out shoppers get the whole thing (#93 client rules 9 and 10)
 *
 * There is no account wall on this screen, no gate on the query and no prompt
 * before the list renders. Sign-in appears in exactly one place: on a shop
 * whose ONLY refusal is a guest-specific one, where signing in genuinely
 * changes the answer — `describeBuyerPickupBlock` decides that, not this
 * screen, and a mixed refusal never offers it.
 *
 * ## What travels in the URL, and why it is allowed to
 *
 * `?pickup=` carries a LOCATION id and `?pickupName=` its published display
 * name. #93 client rule 14 forbids precise location, contact and access tokens
 * in URLs — a merchant's own published shop front is none of the three: it is
 * public, it is the merchant's rather than the buyer's, and it authorizes
 * nothing (the server re-validates it against the actor and every cart line
 * before a single unit is reserved). The BUYER's position never leaves this
 * screen: it lives in `useNearbyOrigin`'s state and is never written to a
 * param, a store or an analytics call.
 *
 * That choice also has to survive a reload and a bank redirect, which is #93
 * client rule 11 — and a URL param survives both where component state does
 * not.
 */

export default function NearbyScreen() {
  const params = useLocalSearchParams<{ product?: string; variant?: string }>();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const addToCart = useAddCartItem();
  const [error, setError] = useState<string | null>(null);

  const canonicalProductId = params.product;
  const canonicalVariantId = params.variant;

  /**
   * Take the chosen shop to checkout.
   *
   * The line is added to the cart FIRST, and the group it landed in is what
   * scopes the checkout: a `PickupDestination` names ONE location, so checking
   * out a mixed cart against it would ask one shop to hand over another
   * seller's goods. The server refuses that anyway — this is what stops a buyer
   * meeting the refusal.
   */
  const collectHere = (result: NearbyLocationResult) => {
    setError(null);
    addToCart.mutate(
      { listingId: result.listingId, variantId: result.variantId, quantity: 1 },
      {
        onSuccess: (cart: Cart) => {
          const group = cart.groups.find((candidate) =>
            candidate.items.some((item) => item.variantId === result.variantId),
          );
          if (group === undefined) {
            // The line is in the cart and the cart is authoritative, so the
            // honest recovery is to send the buyer to it rather than to guess a
            // seller key and have checkout answer "no matching cart items".
            setError("Added to your cart. Open your cart to check out.");
            return;
          }
          const query = new URLSearchParams({
            seller: group.sellerKey,
            pickup: result.location.locationId,
            pickupName: result.location.displayName,
          });
          router.push(`/checkout?${query.toString()}`);
        },
        onError: (cause: Error) => setError(cause.message),
      },
    );
  };

  if (canonicalProductId === undefined && canonicalVariantId === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        <View className="items-center px-8 py-24">
          <Text className="text-center text-bodyTitleLarge text-text">
            Nothing to collect
          </Text>
          <Text className="mt-1 text-center text-caption text-text-secondary">
            Open a product and choose “Collect in person” to see the shops near you that have it.
          </Text>
          <Button variant="outline" className="mt-4" onPress={() => router.replace("/")}>
            <Text className="text-buttonSmall text-text">Back to Mercaria</Text>
          </Button>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>Collect in person · Mercaria</title>
      </Head>
      <View className="web:mx-auto web:w-full web:max-w-[900px] gap-space-24 md:px-5">
        <NearbyAvailability
          {...(canonicalProductId === undefined ? {} : { canonicalProductId })}
          {...(canonicalVariantId === undefined ? {} : { canonicalVariantId })}
          withCheckoutEligibility
          onSelectLocation={collectHere}
          selectLabel="Collect here"
          {...(isAuthenticated ? {} : { onSignIn: () => openAccountDialog() })}
        />

        {error === null ? null : (
          <Text className="text-caption text-text-secondary" accessibilityRole="alert">
            {error}
          </Text>
        )}

        <Footer />
      </View>
    </ScreenShell>
  );
}
