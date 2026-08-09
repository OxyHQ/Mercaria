import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { ShoppingBag } from "lucide-react-native";
import {
  CartLineItem,
  PriceDisplay,
  ProductShelf,
  ReviewStars,
  SectionHeader,
  Text,
  formatReviewCount,
  type ProductSummary,
} from "@mercaria/ui";
import type { CartGroup, CartVendor } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { REVIEW_SCOPE_LABELS } from "@/lib/hooks/use-reviews";
import { useCart, useUpdateCartItem, useRemoveCartItem } from "@/lib/hooks/use-cart";
import { useGuestCredential } from "@/lib/stores/guest-credential-store";
import { useFeed } from "@/lib/hooks/use-feed";

/** Vendor logo edge length (px) in the cart-group header. */
const VENDOR_LOGO_SIZE = 40;
/** Heading of the bottom recommendation shelf. */
const RECOMMENDATION_TITLE = "You might also like";

/**
 * What an Oxy account adds to a cart that already works without one (#104).
 *
 * CONCRETE and true, which is the whole requirement: each line names something
 * the guest path genuinely does not have. "Cross-device" is deliberately worded
 * as a benefit of signing IN rather than as a description of the guest cart —
 * a guest cart lives on ONE device and the copy must never imply otherwise.
 */
const ACCOUNT_BENEFITS = [
  "Your cart follows you to your other devices",
  "Saved addresses, so checkout is one step",
  "Every order in one place, tied to your account",
];

/** Empty state — never crashes, mirrors the home error/empty rhythm. */
function CartEmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View className="items-center px-8 py-24">
      <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-secondary">
        <ShoppingBag size={28} className="text-muted-foreground" />
      </View>
      <Text className="text-center text-lg font-bold text-foreground">{title}</Text>
      <Text className="mt-1 text-center text-sm text-muted-foreground">{subtitle}</Text>
    </View>
  );
}

/**
 * The signed-out invitation. It sits BELOW the cart and blocks nothing — the
 * point of #104 is that the guest path is complete, so this is an offer and
 * never a gate.
 */
function AccountBenefitsCard() {
  return (
    <View className="mb-4 rounded-3xl border border-border bg-card p-4 web:shadow">
      <Text className="text-base font-bold text-foreground">Shopping as a guest</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        You can check out without an account. With one, you also get:
      </Text>
      <View className="mt-3 gap-1.5">
        {ACCOUNT_BENEFITS.map((benefit) => (
          <Text key={benefit} className="text-sm text-foreground">
            {`• ${benefit}`}
          </Text>
        ))}
      </View>
      <Text className="mt-3 text-xs text-muted-foreground">
        Sign in any time — the items already in your cart come with you.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in to your Oxy account"
        onPress={() => openAccountDialog()}
        className="mt-4 items-center rounded-full border border-border py-3 web:hover:opacity-90 active:opacity-90"
      >
        <Text className="text-sm font-semibold text-foreground">Sign in</Text>
      </Pressable>
    </View>
  );
}

/**
 * The recovery state for a device whose secure storage refused us (#104 guest
 * UX requirement 7).
 *
 * Honest rather than alarming: the cart works right now and will not survive a
 * restart, and the fix in the buyer's hands is to sign in. Shown only when
 * storage actually failed, so a healthy device never sees it.
 */
function GuestStorageWarning() {
  return (
    <View className="mb-4 rounded-3xl border border-destructive/40 bg-card p-4">
      <Text accessibilityRole="alert" className="text-sm font-semibold text-foreground">
        This cart may not survive closing the app
      </Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        We could not save your cart securely on this device. You can keep shopping and check out
        now. Signing in keeps your cart safe.
      </Text>
    </View>
  );
}

/** One merchant's cart card: vendor header, its lines, its subtotal + checkout. */
function CartGroupCard({
  group,
  onPressVendor,
  onChangeQuantity,
  onRemove,
  onCheckout,
}: {
  group: CartGroup;
  onPressVendor: (vendor: CartVendor) => void;
  onChangeQuantity: (variantId: string, qty: number) => void;
  onRemove: (variantId: string) => void;
  onCheckout: (vendor: CartVendor) => void;
}) {
  const { vendor } = group;
  const showRating = vendor.rating !== undefined;

  return (
    <View className="mb-4 overflow-hidden rounded-3xl border border-border bg-card p-4 web:shadow">
      {/* Header: vendor link (logo + name + rating) */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Visit ${vendor.name}`}
        onPress={() => onPressVendor(vendor)}
        className="flex-row items-center gap-3"
      >
        <View
          className="overflow-hidden rounded-full bg-secondary"
          style={{ width: VENDOR_LOGO_SIZE, height: VENDOR_LOGO_SIZE }}
        >
          {vendor.logoUrl ? (
            <Image source={{ uri: vendor.logoUrl }} contentFit="cover" style={StyleSheet.absoluteFill} />
          ) : null}
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-bold text-foreground">
            {vendor.name}
          </Text>
          {showRating ? (
            <View className="mt-0.5 flex-row items-center gap-1.5">
              {/* Named scope (#76 UI rule 6): this is the SELLER's service
                  rating, not a rating of what is in the basket. */}
              <ReviewStars
                rating={vendor.rating ?? 0}
                count={vendor.reviewCount}
                size={12}
                scopeLabel={REVIEW_SCOPE_LABELS.merchant}
              />
              <Text className="text-xs text-muted-foreground">
                {`${vendor.rating} (${formatReviewCount(vendor.reviewCount ?? 0)})`}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>

      {/* Lines */}
      <View className="mt-4 gap-4">
        {group.items.map((item) => (
          <CartLineItem
            key={item.variantId}
            item={item}
            onChangeQuantity={onChangeQuantity}
            onRemove={onRemove}
          />
        ))}
      </View>

      {/* Subtotal + checkout (sibling to the vendor link, never nested) */}
      <View className="mt-5 flex-row items-center justify-between border-t border-border pt-4">
        <Text className="text-sm text-muted-foreground">Subtotal</Text>
        <PriceDisplay price={group.subtotal} primaryClassName="text-base font-bold" />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Continue to checkout with ${vendor.name}`}
        onPress={() => onCheckout(vendor)}
        className="mt-4 items-center rounded-full bg-primary py-3.5 web:hover:opacity-90 active:opacity-90"
      >
        <Text className="text-sm font-semibold text-primary-foreground">Continue to checkout</Text>
      </Pressable>
    </View>
  );
}

/** Cart body — only the content; the host (web flow / native scroll) wraps it. */
function CartBody() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const { data: cart, isLoading, isError } = useCart();
  const { storageAvailable } = useGuestCredential();
  const { data: feed } = useFeed();

  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();

  const onPressVendor = (vendor: CartVendor) => {
    if (vendor.kind === "store" && vendor.handle) {
      router.push(`/stores/${vendor.handle}` as Parameters<typeof router.push>[0]);
    }
  };

  const onChangeQuantity = (variantId: string, qty: number) => {
    updateItem.mutate({ variantId, input: { quantity: qty } });
  };

  const onRemove = (variantId: string) => {
    removeItem.mutate(variantId);
  };

  // Per-vendor checkout: place just this seller's group (the rest stay in cart).
  const onCheckout = (vendor: CartVendor) => {
    router.push(
      `/checkout?seller=${vendor.kind}:${vendor.id}` as Parameters<typeof router.push>[0],
    );
  };

  // Whole-cart checkout: place every group (one order per seller).
  const onCheckoutAll = () => {
    router.push("/checkout" as Parameters<typeof router.push>[0]);
  };

  // Bottom recommendation shelf: flatten product-feed-section products.
  const recommendations = useMemo<ProductSummary[]>(() => {
    const sections = feed?.sections ?? [];
    return sections.flatMap((section) =>
      section.kind === "products" ? section.products ?? [] : [],
    );
  }, [feed]);

  const groups = cart?.groups ?? [];

  return (
    <>
      <SectionHeader title="Your cart" />

      {/* Signing out of the cart is no longer a state this screen has: the cart
          belongs to whoever the server resolves the caller to be, so a guest
          sees their own real cart here and the auth check below decides only
          what to OFFER them, never what to withhold (#104). */}
      {isLoading && !cart ? (
        <View className="px-4 py-16" accessibilityRole="progressbar" accessibilityLabel="Loading your cart">
          <View className="mb-4 h-40 w-full rounded-3xl bg-muted" />
          <View className="h-40 w-full rounded-3xl bg-muted" />
        </View>
      ) : isError && !cart ? (
        <CartEmptyState
          title="We could not load your cart"
          subtitle="Check your connection and try again — nothing has been lost."
        />
      ) : groups.length === 0 ? (
        <>
          <CartEmptyState
            title="Your cart is empty"
            subtitle="Browse the marketplace and add items you love."
          />
          {!isAuthenticated ? (
            <View className="px-4">
              <AccountBenefitsCard />
            </View>
          ) : null}
        </>
      ) : (
        <View className="px-4">
          {!isAuthenticated && !storageAvailable ? <GuestStorageWarning /> : null}

          {groups.map((group) => (
            <CartGroupCard
              key={`${group.vendor.kind}:${group.vendor.id}`}
              group={group}
              onPressVendor={onPressVendor}
              onChangeQuantity={onChangeQuantity}
              onRemove={onRemove}
              onCheckout={onCheckout}
            />
          ))}

          {/* Whole-cart checkout — only meaningful with more than one vendor
              (with a single group the per-vendor button already does this). */}
          {groups.length > 1 && cart ? (
            <View className="mb-4 rounded-3xl border border-border bg-card p-4 web:shadow">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">Cart total</Text>
                <PriceDisplay price={cart.subtotal} primaryClassName="text-base font-bold" />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Check out everything in your cart"
                onPress={onCheckoutAll}
                className="mt-4 items-center rounded-full bg-primary py-3.5 web:hover:opacity-90 active:opacity-90"
              >
                <Text className="text-sm font-semibold text-primary-foreground">
                  Checkout everything
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* The offer sits BELOW the cart and its checkout buttons, so it can
              never read as a step between the buyer and their purchase. */}
          {!isAuthenticated ? <AccountBenefitsCard /> : null}
        </View>
      )}

      {/* Bottom recommendation shelf — rendered only when feed products exist. */}
      {recommendations.length > 0 ? (
        <View className="mt-6">
          <ProductShelf title={RECOMMENDATION_TITLE} items={recommendations} />
        </View>
      ) : null}

      <View className="h-24" />
    </>
  );
}

export default function CartScreen() {
  return (
    // The cart is a narrower column than the home/store feed
    // (`max-w-[1200px]`) and gets `pt-5` on both platforms.
    <ScreenShell contentClassName="pt-5 web:max-w-[1200px]">
      <Head>
        <title>Your cart — Mercaria</title>
      </Head>
      <CartBody />
    </ScreenShell>
  );
}
