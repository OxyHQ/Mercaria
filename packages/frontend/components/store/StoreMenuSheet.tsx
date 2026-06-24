import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { vars } from "nativewind";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import {
  ArrowLeft,
  ChevronRight,
  Flag,
  Heart,
  RotateCcw,
  Share2,
  ShieldCheck,
  Store as StoreIcon,
  X,
} from "lucide-react-native";
import { Dialog } from "@oxyhq/bloom/dialog";
import {
  ReviewStars,
  Text,
  formatReviewCount,
} from "@mercaria/ui";
import type { Collection, MerchantSummary, Review } from "@mercaria/shared-types";
import { storeThemeVars } from "@/lib/store-theme";
import { useStoreReviews } from "@/lib/hooks/use-store";

/** Light text tone over a brand-tinted surface (mirrors the store page). */
const TONE_LIGHT = "#FFFFFF";
/** Dark text tone over a brand-tinted surface (mirrors the store page). */
const TONE_DARK = "#111111";
/** Round logo size (px) in the in-sheet store header. */
const HEADER_LOGO_SIZE = 56;
/** Round thumbnail size (px) for each collection row. */
const ROW_THUMB_SIZE = 32;
/** Round product thumbnail size (px) on a review card. */
const REVIEW_THUMB_SIZE = 64;
/** Round avatar size (px) in a review card footer. */
const REVIEW_AVATAR_SIZE = 24;
/** Round top-bar control (Close/Back/Follow/Share) diameter (px). */
const CONTROL_SIZE = 44;
/** Top-bar icon size (px). */
const CONTROL_ICON_SIZE = 20;
/** Trailing affordance / policy-row icon size (px). */
const ROW_ICON_SIZE = 20;
/** Star size (px) for the in-sheet review summaries. */
const SUMMARY_STAR_SIZE = 16;
/** Star size (px) on an individual review card. */
const REVIEW_STAR_SIZE = 14;
/** Explicit translucent glass fill for cards over the brand panel. */
const GLASS_FILL = "rgba(255,255,255,0.2)";
/** Side-sheet width (px) on wide screens. */
const SHEET_WIDTH = 460;
/** Nav-rail width (px) = 4.75rem — the overlay starts after it on desktop. */
const RAIL_WIDTH = 76;
/** Width (px) at/above which the shell shows the nav rail (Dialog's `md`). */
const NAV_BREAKPOINT = 768;
/**
 * Side-sheet inset (px) from the overlay-container edges. The overlay is offset
 * by the nav rail on desktop (via `containerStyle.left`), and the content shell
 * is inset 8px from the viewport top/bottom (its column gutter), so top/bottom
 * use 16 (8px shell gutter + 8px margin) while left uses 8 — a symmetric 8px gap
 * inside the shell, clear of the rail.
 */
const SHEET_INSET = { top: 16, bottom: 16, left: 8 } as const;
/** Fallback author label when the Oxy profile doesn't resolve. */
const FALLBACK_AUTHOR = "Verified buyer";

/** The pages the sheet can show. The menu is always the root of the stack. */
type SheetPage = "menu" | "reviews";

interface StoreMenuSheetProps {
  /** The store whose menu this sheet presents (drives palette + header). */
  store: MerchantSummary;
  /** Published collections shown as selectable rows under "Shop all". */
  collections: Collection[];
  /** Whether the sheet is mounted/visible. */
  open: boolean;
  /** Dismiss the sheet (backdrop tap, Close button, after a selection). */
  onClose: () => void;
  /**
   * Apply a collection filter. `undefined` clears it ("Shop all"). The caller
   * is responsible for also closing the sheet.
   */
  onSelectCollection: (id?: string) => void;
  /** Current follow state (shared with the hero Follow toggle). */
  followed: boolean;
  /** Toggle the follow state. */
  onToggleFollow: () => void;
}

/**
 * A round, glassy top-bar control button (Close / Back / Follow / Share).
 * `onPress` is optional: Share is a static affordance (mirrors the original)
 * with no action.
 */
function ControlButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="items-center justify-center rounded-radius-max border border-white/30 web:shadow-sm"
      style={{ width: CONTROL_SIZE, height: CONTROL_SIZE, backgroundColor: GLASS_FILL }}
    >
      {children}
    </Pressable>
  );
}

/**
 * A single tappable collection row: round thumb + title. Used for "Shop all"
 * (no thumb) and each published collection.
 */
function CollectionRow({
  title,
  imageUrl,
  toneColor,
  onPress,
}: {
  title: string;
  imageUrl?: string;
  toneColor: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      className="flex-row items-center gap-space-12 px-space-16 py-space-12 web:transition-colors web:hover:bg-white/10"
    >
      <View
        className="items-center justify-center overflow-hidden rounded-radius-max"
        style={{ width: ROW_THUMB_SIZE, height: ROW_THUMB_SIZE, backgroundColor: GLASS_FILL }}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            contentFit="cover"
            style={{ width: ROW_THUMB_SIZE, height: ROW_THUMB_SIZE }}
          />
        ) : (
          <StoreIcon size={ROW_ICON_SIZE} color={toneColor} />
        )}
      </View>
      <Text numberOfLines={1} className="flex-1 text-buttonLarge" style={{ color: toneColor }}>
        {title}
      </Text>
    </Pressable>
  );
}

/** A static (non-functional) labeled row with a leading icon + trailing chevron. */
function PolicyRow({
  label,
  toneColor,
  icon,
}: {
  label: string;
  toneColor: string;
  icon: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-space-12 px-space-16 py-space-12">
      {icon}
      <Text className="flex-1 text-body" style={{ color: toneColor }}>
        {label}
      </Text>
      <ChevronRight size={ROW_ICON_SIZE} color={toneColor} />
    </View>
  );
}

/**
 * A single store-review card on the Reviews sub-page: a tappable product
 * thumbnail (sibling, not nested in an outer pressable), the star rating, the
 * product title + body, an author/date footer, and a static "Helpful"
 * affordance. The thumbnail link and the Helpful button are siblings so there
 * are no nested interactives.
 */
function StoreReviewCard({
  review,
  toneColor,
  onPressProduct,
}: {
  review: Review;
  toneColor: string;
  onPressProduct: (productId: string) => void;
}) {
  const date = new Date(review.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const author = review.author?.displayName ?? FALLBACK_AUTHOR;

  return (
    <View
      className="flex-row gap-space-12 rounded-radius-20 border border-border-secondary p-space-16"
      style={{ backgroundColor: GLASS_FILL }}
    >
      {review.product ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`View ${review.product.title}`}
          onPress={() => onPressProduct(review.product?.id ?? "")}
          className="overflow-hidden rounded-radius-16"
          style={{ width: REVIEW_THUMB_SIZE, height: REVIEW_THUMB_SIZE, backgroundColor: GLASS_FILL }}
        >
          {review.product.imageUrl ? (
            <Image
              source={{ uri: review.product.imageUrl }}
              contentFit="cover"
              style={{ width: REVIEW_THUMB_SIZE, height: REVIEW_THUMB_SIZE }}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <StoreIcon size={ROW_ICON_SIZE} color={toneColor} />
            </View>
          )}
        </Pressable>
      ) : null}

      <View className="flex-1 gap-space-6">
        <ReviewStars rating={review.rating} count={1} size={REVIEW_STAR_SIZE} />
        {review.product ? (
          <Text numberOfLines={1} className="text-captionBold" style={{ color: toneColor }}>
            {review.product.title}
          </Text>
        ) : null}
        {review.body ? (
          <Text numberOfLines={4} className="text-caption" style={{ color: toneColor }}>
            {review.body}
          </Text>
        ) : null}
        <View className="mt-space-4 flex-row items-center gap-space-8">
          <View
            className="overflow-hidden rounded-radius-max border border-white/30"
            style={{ width: REVIEW_AVATAR_SIZE, height: REVIEW_AVATAR_SIZE, backgroundColor: GLASS_FILL }}
          >
            {review.author?.avatar ? (
              <Image
                source={{ uri: review.author.avatar }}
                contentFit="cover"
                style={{ width: REVIEW_AVATAR_SIZE, height: REVIEW_AVATAR_SIZE }}
              />
            ) : null}
          </View>
          <Text numberOfLines={1} className="flex-1 text-caption" style={{ color: toneColor }}>
            {`${author} · ${date}`}
          </Text>
        </View>
        <View className="mt-space-4 flex-row">
          <View className="rounded-radius-max border border-white/30 px-space-12 py-space-4">
            <Text className="text-captionMedium" style={{ color: toneColor }}>
              Helpful
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The Reviews sub-page: a summary row (big rating + stars + ratings count) over
 * a scrollable list of the store's product-review cards. Mirrors the Shopify
 * store reviews sheet. Fetches via {@link useStoreReviews}; renders loading and
 * empty states.
 */
function ReviewsPage({
  store,
  toneColor,
  onPressProduct,
}: {
  store: MerchantSummary;
  toneColor: string;
  onPressProduct: (productId: string) => void;
}) {
  const { data, isLoading } = useStoreReviews(store.handle);
  const reviews = data?.data ?? [];
  const total = data?.pagination.total ?? store.reviewCount;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 16 }}
    >
      <Text className="text-headerBold" style={{ color: toneColor }}>
        Reviews
      </Text>

      {/* Summary row: big rating + stars + ratings count. */}
      <View className="flex-row items-center gap-space-16">
        <Text className="text-headerBold" style={{ color: toneColor }}>
          {`${store.rating}`}
        </Text>
        <View className="flex-1 gap-space-4">
          <ReviewStars rating={store.rating} count={total} size={SUMMARY_STAR_SIZE} />
          <Text className="text-caption" style={{ color: toneColor }}>
            {`${formatReviewCount(total)} ratings`}
          </Text>
        </View>
      </View>

      {isLoading ? (
        <Text className="py-space-24 text-center text-body" style={{ color: toneColor }}>
          Loading reviews…
        </Text>
      ) : reviews.length === 0 ? (
        <Text className="py-space-24 text-center text-body" style={{ color: toneColor }}>
          No reviews yet
        </Text>
      ) : (
        reviews.map((review) => (
          <StoreReviewCard
            key={review.id}
            review={review}
            toneColor={toneColor}
            onPressProduct={onPressProduct}
          />
        ))
      )}
    </ScrollView>
  );
}

/**
 * The menu (root) sub-page: the store header, collections, the reviews summary
 * (which now NAVIGATES to the Reviews page), policies, and report.
 */
function MenuPage({
  store,
  collections,
  toneColor,
  onSelectCollection,
  onOpenReviews,
}: {
  store: MerchantSummary;
  collections: Collection[];
  toneColor: string;
  onSelectCollection: (id?: string) => void;
  onOpenReviews: () => void;
}) {
  const hasReviews = store.reviewCount > 0;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 24 }}
    >
      {/* ---- Store header ---- */}
      <View className="flex-row items-center gap-space-16 pt-space-8">
        <View
          className="items-center justify-center overflow-hidden rounded-radius-max"
          style={{ width: HEADER_LOGO_SIZE, height: HEADER_LOGO_SIZE, backgroundColor: GLASS_FILL }}
        >
          {store.logoUrl ? (
            <Image
              source={{ uri: store.logoUrl }}
              contentFit="cover"
              style={{ width: HEADER_LOGO_SIZE, height: HEADER_LOGO_SIZE }}
            />
          ) : (
            <StoreIcon size={ROW_ICON_SIZE} color={toneColor} />
          )}
        </View>
        <View className="flex-1">
          <Text numberOfLines={2} className="text-headerBold" style={{ color: toneColor }}>
            {store.name}
          </Text>
          <View className="mt-space-4 flex-row items-center gap-space-6">
            <Text className="text-captionBold" style={{ color: toneColor }}>
              {`★ ${store.rating}`}
            </Text>
            <Text className="text-captionBold" style={{ color: toneColor }}>
              {`(${formatReviewCount(store.reviewCount)})`}
            </Text>
          </View>
        </View>
      </View>

      {/* ---- Collections card ---- */}
      <View className="overflow-hidden rounded-radius-16" style={{ backgroundColor: GLASS_FILL }}>
        <CollectionRow
          title="Shop all"
          toneColor={toneColor}
          onPress={() => onSelectCollection(undefined)}
        />
        {collections.map((collection) => (
          <CollectionRow
            key={collection.id}
            title={collection.title}
            imageUrl={collection.imageUrl}
            toneColor={toneColor}
            onPress={() => onSelectCollection(collection.id)}
          />
        ))}
      </View>

      {/* ---- Reviews summary (navigates to the Reviews page) ---- */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View reviews"
        onPress={onOpenReviews}
        className="rounded-radius-16 p-space-16 web:transition-colors web:hover:bg-white/10"
        style={{ backgroundColor: GLASS_FILL }}
      >
        <Text className="text-subtitle" style={{ color: toneColor }}>
          Reviews
        </Text>
        {hasReviews ? (
          <View className="mt-space-12 flex-row items-center gap-space-16">
            <Text className="text-headerBold" style={{ color: toneColor }}>
              {`${store.rating}`}
            </Text>
            <View className="flex-1 gap-space-4">
              <ReviewStars
                rating={store.rating}
                count={store.reviewCount}
                size={SUMMARY_STAR_SIZE}
              />
              <Text className="text-caption" style={{ color: toneColor }}>
                {`${formatReviewCount(store.reviewCount)} ratings`}
              </Text>
            </View>
            <ChevronRight size={ROW_ICON_SIZE} color={toneColor} />
          </View>
        ) : (
          <Text className="mt-space-12 text-body" style={{ color: toneColor }}>
            No reviews yet
          </Text>
        )}
      </Pressable>

      {/* ---- Policies card ---- */}
      <View className="overflow-hidden rounded-radius-16" style={{ backgroundColor: GLASS_FILL }}>
        <View className="px-space-16 pt-space-16">
          <Text className="text-subtitle" style={{ color: toneColor }}>
            Policies
          </Text>
        </View>
        <PolicyRow
          label="Privacy policy"
          toneColor={toneColor}
          icon={<ShieldCheck size={ROW_ICON_SIZE} color={toneColor} />}
        />
        <PolicyRow
          label="Return policy"
          toneColor={toneColor}
          icon={<RotateCcw size={ROW_ICON_SIZE} color={toneColor} />}
        />
      </View>

      {/* ---- Report store ---- */}
      <View className="overflow-hidden rounded-radius-16" style={{ backgroundColor: GLASS_FILL }}>
        <PolicyRow
          label="Report store"
          toneColor={toneColor}
          icon={<Flag size={ROW_ICON_SIZE} color={toneColor} />}
        />
      </View>
    </ScrollView>
  );
}

/**
 * A left-anchored, brand-themed store-menu sheet mirroring Shopify's store
 * sheet. The overlay, backdrop, enter/exit animation, responsive side↔bottom
 * switching, and Escape/backdrop dismissal are all owned by Bloom's
 * {@link Dialog} with a responsive `placement` map (`{ base: 'bottom', md:
 * 'left' }`): it renders as a left side-sheet floating inside the content shell
 * on wide screens (>=768px) and as a bottom-sheet (with drag handle) on small
 * screens.
 *
 * This component supplies only the CONTENTS: an INTERNAL navigation stack
 * (`SheetPage[]`) with the menu as the root, a contextual top bar (Close (X) at
 * the root, Back (←) on a sub-page, with Follow/Share on the right), and the
 * Menu / Reviews pages. Tapping "Reviews" pushes the Reviews sub-page rendered
 * WITHIN the same sheet.
 *
 * `Dialog` is controlled here (driven by `open`) and keeps its children mounted
 * across the close transition, so closing also resets the internal stack to the
 * menu root (`handleClose`) — each reopen starts fresh at the menu, with no
 * `useEffect`. The store palette is scoped on the overlay container via
 * `storeThemeVars` + `vars()`, and the panel is explicitly painted with the
 * brand color so glassy `rgba(255,255,255,0.2)` cards read correctly over it.
 */
export function StoreMenuSheet({
  store,
  collections,
  open,
  onClose,
  onSelectCollection,
  followed,
  onToggleFollow,
}: StoreMenuSheetProps) {
  const router = useRouter();
  // Offset the overlay past the nav rail on desktop so the side-sheet + backdrop
  // sit inside the content shell (not over the rail). On small screens the rail
  // is gone and the sheet presents from the bottom, so no offset. Numeric inline
  // style is used (not a responsive className) because it merges last over the
  // Dialog overlay's own `left: 0`, which a className can't reliably override.
  const { width } = useWindowDimensions();
  const railOffset = width >= NAV_BREAKPOINT ? { left: RAIL_WIDTH } : null;
  // Internal navigation stack: the menu is always the root.
  const [stack, setStack] = useState<SheetPage[]>(["menu"]);
  const current = stack[stack.length - 1];

  const toneColor = store.textTone === "light" ? TONE_LIGHT : TONE_DARK;
  const atRoot = current === "menu";

  const push = (page: SheetPage) => setStack((prev) => [...prev, page]);
  const pop = () => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));

  // Dismiss the sheet AND reset the internal stack to the menu root, so the
  // next open starts fresh at the menu rather than on a lingering sub-page.
  const handleClose = () => {
    setStack(["menu"]);
    onClose();
  };

  const onPressProduct = (productId: string) => {
    if (!productId) return;
    handleClose();
    router.push(`/products/${productId}` as Parameters<typeof router.push>[0]);
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      placement={{ base: "bottom", md: "left" }}
      width={SHEET_WIDTH}
      inset={SHEET_INSET}
      maxHeightRatio={0.9}
      showHandle
      dismissOnBackdrop
      contentPadding={0}
      containerStyle={[vars(storeThemeVars(store.brandColor, store.textTone)), railOffset]}
      panelStyle={{ backgroundColor: store.brandColor }}
      label={`${store.name} menu`}
    >
      {/* Pinned top bar: contextual Close/Back (left), Follow + Share (right). */}
      <View className="flex-row items-center justify-between px-space-16 pb-space-12 pt-space-16">
        {atRoot ? (
          <ControlButton label={`Close ${store.name} menu`} onPress={handleClose}>
            <X size={CONTROL_ICON_SIZE} color={toneColor} />
          </ControlButton>
        ) : (
          <ControlButton label="Back" onPress={pop}>
            <ArrowLeft size={CONTROL_ICON_SIZE} color={toneColor} />
          </ControlButton>
        )}
        <View className="flex-row items-center gap-space-12">
          <ControlButton
            label={followed ? `Following ${store.name}` : `Follow ${store.name}`}
            onPress={onToggleFollow}
          >
            <Heart
              size={CONTROL_ICON_SIZE}
              color={toneColor}
              fill={followed ? toneColor : "transparent"}
            />
          </ControlButton>
          <ControlButton label={`Share ${store.name}`}>
            <Share2 size={CONTROL_ICON_SIZE} color={toneColor} />
          </ControlButton>
        </View>
      </View>

      {/* Sub-page region: the current page from the internal stack. */}
      <View className="flex-1">
        {atRoot ? (
          <MenuPage
            store={store}
            collections={collections}
            toneColor={toneColor}
            onSelectCollection={onSelectCollection}
            onOpenReviews={() => push("reviews")}
          />
        ) : (
          <ReviewsPage store={store} toneColor={toneColor} onPressProduct={onPressProduct} />
        )}
      </View>
    </Dialog>
  );
}
