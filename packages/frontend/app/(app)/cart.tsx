import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
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
import { useCart, useUpdateCartItem, useRemoveCartItem } from "@/lib/hooks/use-cart";
import { useFeed } from "@/lib/hooks/use-feed";

/** Vendor logo edge length (px) in the cart-group header. */
const VENDOR_LOGO_SIZE = 40;
/** Heading of the bottom recommendation shelf. */
const RECOMMENDATION_TITLE = "You might also like";

/** Empty / signed-out state — never crashes, mirrors the home error/empty rhythm. */
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
              <ReviewStars rating={vendor.rating ?? 0} count={vendor.reviewCount} size={12} />
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
  const { data: cart, isLoading } = useCart();
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

      {!isAuthenticated ? (
        <CartEmptyState
          title="Your cart is empty"
          subtitle="Sign in to start adding items to your cart."
        />
      ) : isLoading && !cart ? (
        <View className="px-4 py-16">
          <View className="mb-4 h-40 w-full rounded-3xl bg-muted" />
          <View className="h-40 w-full rounded-3xl bg-muted" />
        </View>
      ) : groups.length === 0 ? (
        <CartEmptyState
          title="Your cart is empty"
          subtitle="Browse the marketplace and add items you love."
        />
      ) : (
        <View className="px-4">
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
