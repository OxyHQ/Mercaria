import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { ShoppingBag } from "lucide-react-native";
import {
  CartLineItem,
  CommercialDisclosure,
  PriceDisplay,
  ProductShelf,
  ReviewStars,
  SectionHeader,
  Text,
  commercialSellerLabel,
  useFormatters,
  type ProductSummary,
} from "@mercaria/ui";
import type { CartGroup, CartVendor, Money } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { REVIEW_SCOPE_HEADING_KEYS } from "@/lib/hooks/use-reviews";
import { useCart, useUpdateCartItem, useRemoveCartItem } from "@/lib/hooks/use-cart";
import { useGuestCredential } from "@/lib/stores/guest-credential-store";
import { useFeed } from "@/lib/hooks/use-feed";
import { useTranslation } from "@/lib/i18n";

/** Vendor logo edge length (px) in the cart-group header. */
const VENDOR_LOGO_SIZE = 40;

/**
 * What an Oxy account adds to a cart that already works without one (#104).
 *
 * CONCRETE and true, which is the whole requirement: each line names something
 * the guest path genuinely does not have. "Cross-device" is deliberately worded
 * as a benefit of signing IN rather than as a description of the guest cart —
 * a guest cart lives on ONE device and the copy must never imply otherwise.
 *
 * KEYS rather than sentences: this `const` is evaluated at import, before the
 * locale store has rehydrated, so a `t()` here would freeze whichever language
 * loaded first. They are resolved at the render site instead.
 */
const ACCOUNT_BENEFIT_KEYS = [
  "cart.guestOffer.benefits.crossDevice",
  "cart.guestOffer.benefits.savedAddresses",
  "cart.guestOffer.benefits.orderHistory",
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
 *
 * It is WITHHELD when nothing in the cart can be checked out as a guest
 * (#112): "You can check out without an account" is then simply false, and
 * `GuestGroupBlockedNotice` is already saying the true thing with the same
 * sign-in button. An offer that contradicts the screen it sits under reads as
 * a bug, and this one would be reassuring somebody about a purchase they
 * cannot make.
 */
function AccountBenefitsCard() {
  const { t } = useTranslation();
  return (
    <View className="mb-4 rounded-3xl border border-border bg-card p-4 web:shadow">
      <Text className="text-base font-bold text-foreground">{t("cart.guestOffer.title")}</Text>
      <Text className="mt-1 text-sm text-muted-foreground">{t("cart.guestOffer.intro")}</Text>
      <View className="mt-3 gap-1.5">
        {ACCOUNT_BENEFIT_KEYS.map((benefitKey) => (
          <Text key={benefitKey} className="text-sm text-foreground">
            {`• ${t(benefitKey)}`}
          </Text>
        ))}
      </View>
      <Text className="mt-3 text-xs text-muted-foreground">{t("cart.guestOffer.footnote")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("cart.guestOffer.signInA11yLabel")}
        onPress={() => openAccountDialog()}
        className="mt-4 items-center rounded-full border border-border py-3 web:hover:opacity-90 active:opacity-90"
      >
        <Text className="text-sm font-semibold text-foreground">{t("cart.signIn")}</Text>
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
  const { t } = useTranslation();
  return (
    <View className="mb-4 rounded-3xl border border-destructive/40 bg-card p-4">
      <Text accessibilityRole="alert" className="text-sm font-semibold text-foreground">
        {t("cart.storageWarning.title")}
      </Text>
      <Text className="mt-1 text-sm text-muted-foreground">{t("cart.storageWarning.body")}</Text>
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
  onCheckout: (group: CartGroup) => void;
}) {
  const { t } = useTranslation();
  const { formatReviewCount } = useFormatters();
  const { vendor, commercial } = group;
  // #129 cart rules 1-3: the SELLER a buyer reads comes from the group's
  // commercial presentation, never from `vendor.name`. `vendor` names whose
  // CATALOGUE the lines came from, which is what the logo and the storefront
  // link need — and on a group Mercaria sells itself those are two different
  // parties, so rendering the vendor's name as the seller is exactly the
  // mislabelling acceptance 2 forbids.
  const sellerName = commercialSellerLabel(t, commercial);
  // A rating is a rating OF THE VENDOR. On a Mercaria-sold group it would read
  // as a rating of Mercaria, which nobody left, so it is withheld rather than
  // relabelled.
  const showRating = vendor.rating !== undefined && commercial.mode === "connected_marketplace";
  const linksToVendor = commercial.mode === "connected_marketplace";

  return (
    <View className="mb-4 overflow-hidden rounded-3xl border border-border bg-card p-4 web:shadow">
      {/* Header: the seller, linked to the vendor page only when they are one. */}
      <Pressable
        accessibilityRole={linksToVendor ? "link" : "text"}
        accessibilityLabel={
          linksToVendor
            ? t("cart.group.visitSellerA11yLabel", { seller: sellerName })
            : t("cart.group.soldByA11yLabel", { seller: sellerName })
        }
        disabled={!linksToVendor}
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
            {sellerName}
          </Text>
          {showRating ? (
            <View className="mt-0.5 flex-row items-center gap-1.5">
              {/* Named scope (#76 UI rule 6): this is the SELLER's service
                  rating, not a rating of what is in the basket. */}
              <ReviewStars
                rating={vendor.rating ?? 0}
                count={vendor.reviewCount}
                size={12}
                scopeLabel={t(REVIEW_SCOPE_HEADING_KEYS.merchant)}
              />
              <Text className="text-xs text-muted-foreground">
                {`${vendor.rating} (${formatReviewCount(vendor.reviewCount ?? 0)})`}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>

      {/* What this group's commercial mode means, from the server's own list. */}
      <View className="mt-3">
        <CommercialDisclosure presentation={commercial} />
      </View>

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
        <Text className="text-sm text-muted-foreground">{t("cart.group.subtotal")}</Text>
        <PriceDisplay price={group.subtotal} primaryClassName="text-base font-bold" />
      </View>
      {group.guestCheckout?.status === "blocked" ? (
        <GuestGroupBlockedNotice vendorName={sellerName} />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("cart.group.checkoutWithA11yLabel", { seller: sellerName })}
          onPress={() => onCheckout(group)}
          className="mt-4 items-center rounded-full bg-primary py-3.5 web:hover:opacity-90 active:opacity-90"
        >
          <Text className="text-sm font-semibold text-primary-foreground">
            {t("cart.group.checkout")}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * What a guest sees on a group they cannot check out (#112).
 *
 * The SERVER decided this — `CartGroup.guestCheckout` carries the same verdict
 * checkout will enforce — so the items stay visible and priced and only the
 * checkout affordance changes. Hiding the group instead would make the cart
 * disagree with what the buyer added, and leaving the button would send them to
 * a refusal they could have been told about here.
 *
 * The copy says what is true and offers the one remedy that works. It does not
 * name a criterion, a policy or a seller's readiness: the server sends ONE
 * reason for the whole gate, and a client that could tell those apart would be
 * a switchboard somebody could read out one item at a time.
 */
function GuestGroupBlockedNotice({ vendorName }: { vendorName: string }) {
  const { t } = useTranslation();
  return (
    <View className="mt-4 rounded-2xl border border-border bg-secondary p-4">
      <Text className="text-sm font-semibold text-foreground">{t("cart.guestBlocked.title")}</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        {t("cart.guestBlocked.body", { seller: vendorName })}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("cart.guestBlocked.signInA11yLabel")}
        onPress={() => openAccountDialog()}
        className="mt-4 items-center rounded-full bg-primary py-3 web:hover:opacity-90 active:opacity-90"
      >
        <Text className="text-sm font-semibold text-primary-foreground">{t("cart.signIn")}</Text>
      </Pressable>
    </View>
  );
}

/** Cart body — only the content; the host (web flow / native scroll) wraps it. */
function CartBody() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const { data: cart, isLoading, isError } = useCart();
  const { storageAvailable } = useGuestCredential();
  const { data: feed } = useFeed();

  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();

  const onPressVendor = (vendor: CartVendor) => {
    if (vendor.kind === "store" && vendor.handle) {
      router.push(`/stores/${vendor.handle}`);
    }
  };

  const onChangeQuantity = (variantId: string, qty: number) => {
    updateItem.mutate({ variantId, input: { quantity: qty } });
  };

  const onRemove = (variantId: string) => {
    removeItem.mutate(variantId);
  };

  // Per-group checkout: place just this group (the rest stay in cart).
  //
  // The key comes from the SERVER (`group.sellerKey`) rather than being built
  // from `vendor.kind` and `vendor.id`: Mercaria's own lines answer to the flat
  // `platform` key #123 put in the same namespace, and a client composing
  // `store:<id>` for them would be told there are no matching cart items.
  const onCheckout = (group: CartGroup) => {
    router.push({ pathname: "/checkout", params: { seller: group.sellerKey } });
  };

  // Whole-cart checkout: place every group the CALLER may actually place.
  //
  // A guest whose cart mixes a shop with a person gets the shop's group and is
  // told why the rest is left behind (#112: a mixed cart is separated before
  // the payment, never charged as a whole and then refused). With nothing
  // blocked this pushes the bare `/checkout` route exactly as it always did.
  const onCheckoutAll = () => {
    router.push(
      blockedGroups.length === 0
        ? "/checkout"
        : { pathname: "/checkout", params: { seller: checkoutableKeys.join(",") } },
    );
  };

  // Bottom recommendation shelf: flatten product-feed-section products.
  const recommendations = useMemo<ProductSummary[]>(() => {
    const sections = feed?.sections ?? [];
    return sections.flatMap((section) =>
      section.kind === "products" ? section.products ?? [] : [],
    );
  }, [feed]);

  const groups = cart?.groups ?? [];
  const blockedGroups = groups.filter((group) => group.guestCheckout?.status === "blocked");
  const checkoutableGroups = groups.filter((group) => group.guestCheckout?.status !== "blocked");
  const checkoutableKeys = checkoutableGroups.map((group) => group.sellerKey);
  // Summed on the client purely for DISPLAY, and only over one currency: every
  // cart line is already converted to `cart.currency` at hydration, so this is
  // an addition rather than a conversion. Checkout reprices authoritatively.
  // `null` with no cart, rather than a defaulted currency — the presentment
  // currency is the server's answer and a fallback here would be a second one.
  const checkoutableTotal: Money | null = cart
    ? {
        amount: checkoutableGroups.reduce((total, group) => total + group.subtotal.amount, 0),
        currency: cart.currency,
      }
    : null;

  return (
    <>
      <SectionHeader title={t("cart.title")} />

      {/* Signing out of the cart is no longer a state this screen has: the cart
          belongs to whoever the server resolves the caller to be, so a guest
          sees their own real cart here and the auth check below decides only
          what to OFFER them, never what to withhold (#104). */}
      {isLoading && !cart ? (
        <View
          className="px-4 py-16"
          accessibilityRole="progressbar"
          accessibilityLabel={t("cart.loadingA11yLabel")}
        >
          <View className="mb-4 h-40 w-full rounded-3xl bg-muted" />
          <View className="h-40 w-full rounded-3xl bg-muted" />
        </View>
      ) : isError && !cart ? (
        <CartEmptyState
          title={t("cart.error.title")}
          subtitle={t("cart.error.subtitle")}
        />
      ) : groups.length === 0 ? (
        <>
          <CartEmptyState
            title={t("cart.empty.title")}
            subtitle={t("cart.empty.subtitle")}
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
              (with a single group the per-vendor button already does this), and
              only when at least one group is checkout-able for this caller. */}
          {groups.length > 1 && checkoutableTotal && checkoutableKeys.length > 0 ? (
            <View className="mb-4 rounded-3xl border border-border bg-card p-4 web:shadow">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">
                  {blockedGroups.length === 0
                    ? t("cart.summary.totalAll")
                    : t("cart.summary.totalAvailable")}
                </Text>
                {/* The figure has to be the one the button will charge. Showing
                    the whole cart's subtotal beside a button that places only
                    part of it is the mismatch a buyer reads as a bug. */}
                <PriceDisplay price={checkoutableTotal} primaryClassName="text-base font-bold" />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  blockedGroups.length === 0
                    ? t("cart.summary.checkoutAllA11yLabel")
                    : t("cart.summary.checkoutAvailableA11yLabel")
                }
                onPress={onCheckoutAll}
                className="mt-4 items-center rounded-full bg-primary py-3.5 web:hover:opacity-90 active:opacity-90"
              >
                <Text className="text-sm font-semibold text-primary-foreground">
                  {blockedGroups.length === 0
                    ? t("cart.summary.checkoutAll")
                    : t("cart.summary.checkoutAvailable")}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* The offer sits BELOW the cart and its checkout buttons, so it can
              never read as a step between the buyer and their purchase — and
              it is withheld outright when none of them would work. */}
          {!isAuthenticated && checkoutableKeys.length > 0 ? <AccountBenefitsCard /> : null}
        </View>
      )}

      {/* Bottom recommendation shelf — rendered only when feed products exist. */}
      {recommendations.length > 0 ? (
        <View className="mt-6">
          {/* Heading of the bottom recommendation shelf. */}
          <ProductShelf title={t("cart.recommendations.title")} items={recommendations} />
        </View>
      ) : null}

      <View className="h-24" />
    </>
  );
}

export default function CartScreen() {
  const { t } = useTranslation();
  return (
    // The cart is a narrower column than the home/store feed
    // (`max-w-[1200px]`) and gets `pt-5` on both platforms.
    <ScreenShell contentClassName="pt-5 web:max-w-[1200px]">
      <Head>
        <title>{t("cart.pageTitle")}</title>
      </Head>
      <CartBody />
    </ScreenShell>
  );
}
