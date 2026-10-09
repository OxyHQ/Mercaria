import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Button } from "@oxy.so/bloom/button";
import { Heart } from "lucide-react-native";
import { Text } from "../ui/text";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  MARKETPLACE_NO_IMAGE_KEY,
  PRODUCT_CARD_DISCOUNT_KEY,
  PRODUCT_CARD_SAVE_KEY,
} from "../../lib/marketplace-labels";
import { Rating } from "@oxy.so/bloom/rating";
import { PriceDisplay } from "../PriceDisplay";
import type { ProductSummary } from "../../lib/format";
import { formatPercent } from "../../lib/format";
import { useFormatters } from "../../lib/use-formatters";
import { useRatingDisplay } from "../../lib/rating-display";
import { useListingSaveAction, type SaveListing } from "./ListingSaveProvider";

/** Light color used for content drawn over the image (badge text, heart). */
const ON_IMAGE_LIGHT = "#FFFFFF";
/** Heart icon size for the favorite button. */
const HEART_SIZE = 18;

export interface ProductCardProps {
  product: ProductSummary;
  /**
   * Initial saved/favorited state. Overrides `product.saved` when provided;
   * otherwise the card seeds from the DTO's `saved` flag.
   */
  saved?: boolean;
  onPress?: (id: string) => void;
  onToggleSave?: SaveListing;
}

/** `formatPercent` reads BASIS POINTS; a whole percent is one hundred of them. */
const BASIS_POINTS_PER_PERCENT = 100;

function isOnSale(product: ProductSummary): boolean {
  return (
    product.compareAtPrice !== undefined &&
    product.compareAtPrice.amount > product.price.amount
  );
}

export function ProductCard({ product, saved, onPress, onToggleSave }: ProductCardProps) {
  const t = useSharedUiTranslation();
  const [isSaved, setIsSaved] = useState(saved ?? product.saved ?? false);
  const [saving, setSaving] = useState(false);
  const defaultSaveAction = useListingSaveAction();
  const saveAction = onToggleSave ?? defaultSaveAction;
  useEffect(() => { setIsSaved(saved ?? product.saved ?? false); }, [saved, product.saved, product.id]);
  const { formatMoney } = useFormatters();
  const ratingDisplay = useRatingDisplay();
  const locale = useSharedUiLocale();
  const onSale = isOnSale(product);
  const discountPercent =
    onSale && product.compareAtPrice
      ? Math.round((1 - product.price.amount / product.compareAtPrice.amount) * 100)
      : 0;

  const handleToggleSave = async () => {
    if (!saveAction || saving) return;
    const next = !isSaved;
    setSaving(true);
    try {
      if (await saveAction(product.id, next) !== false) setIsSaved(next);
    } finally { setSaving(false); }
  };

  return (
    // The card itself is NOT a button. Navigation lives in two SEPARATE,
    // sibling interactive zones (the image link and the text link), and the
    // favorite button is a SIBLING of the image link — never nested inside
    // another interactive element (avoids invalid `<button>`-in-`<button>` on
    // web). `group` is kept here so the image still scales on hover.
    <View className="group flex flex-col gap-2">
      {/* Image block */}
      <View className="relative aspect-square overflow-hidden rounded-[20px] bg-card web:shadow-sm">
        {/* Image navigation link — fills the block, sits beneath the favorite. */}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={product.title}
          onPress={() => onPress?.(product.id)}
          className="absolute inset-0"
        >
          {product.imageUrl ? (
            <Image
              source={{ uri: product.imageUrl }}
              contentFit="cover"
              className="h-full w-full web:transition-transform web:duration-150 web:group-hover:scale-[1.03] web:motion-reduce:transition-none web:motion-reduce:transform-none"
            />
          ) : (
            <View className="h-full w-full items-center justify-center bg-muted">
              <Text className="text-xs text-muted-foreground">{t(MARKETPLACE_NO_IMAGE_KEY)}</Text>
            </View>
          )}
        </Pressable>

        {/* Subtle dark wash over the image (Shop bg-bg-overlay-inverse-04). */}
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-[20px] bg-black/[0.04]"
        />

        {/* Hairline inner border */}
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-[20px] border border-border"
        />

        {/* Sale badge */}
        {onSale ? (
          <View
            pointerEvents="none"
            className="absolute start-3 top-3 rounded-full bg-black/75 px-1.5 py-0.5"
          >
            <Text
              className="text-[10px] font-bold"
              style={{ color: ON_IMAGE_LIGHT }}
            >
              {t(PRODUCT_CARD_DISCOUNT_KEY, {
                percent: formatPercent(discountPercent * BASIS_POINTS_PER_PERCENT, locale, 0),
              })}
            </Text>
          </View>
        ) : null}

        {/* Favorite button — SIBLING of the image link (rendered last so it
            stacks on top and receives presses). Not nested in any link. */}
        {saveAction ? <View className="absolute bottom-3 end-3">
          <Button iconOnly appearance="plain" tone="neutral" pressed={isSaved}
            accessibilityLabel={t(PRODUCT_CARD_SAVE_KEY)} disabled={saving} onPress={handleToggleSave}
            style={{ width: 36, height: 36, minHeight: 36, borderRadius: 18, padding: 0, backgroundColor: "rgba(0,0,0,0.4)" }}
            icon={() => <Heart size={HEART_SIZE} color={ON_IMAGE_LIGHT} fill={isSaved ? ON_IMAGE_LIGHT : "transparent"} />} />
        </View> : null}
      </View>

      {/* Text block — its own separate navigation link. */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={product.title}
        onPress={() => onPress?.(product.id)}
        className="flex flex-col ps-1 leading-4"
      >
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {product.brand}
        </Text>
        <Text numberOfLines={1} className="text-xs font-bold text-foreground">
          {product.title}
        </Text>

        {/* Review row */}
        <Rating
          {...ratingDisplay({ rating: product.rating, reviews: product.reviewCount })}
          size="small"
        />

        {/* Price row. The primary FAIR figure (plus the optional dual-currency
            secondary, driven by FxContext) renders via PriceDisplay; the
            compare-at strikethrough stays a plain formatted figure. */}
        <View className="mt-0.5 flex-row items-center gap-1">
          <PriceDisplay price={product.price} primaryClassName="text-xs font-bold" />
          {onSale && product.compareAtPrice ? (
            <Text className="text-xs font-normal text-muted-foreground line-through">
              {formatMoney(product.compareAtPrice)}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}
