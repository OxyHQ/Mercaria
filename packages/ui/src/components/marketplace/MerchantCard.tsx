import type { ReactElement, ReactNode } from 'react';
import type { ProductLinkRenderer } from './ProductCard';
import { resolveCatalogImage } from '../../lib/stored-image-url';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import { merchantImageSource } from '../../lib/shop-merchant-images';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from '../ui/image';
import { LinearGradient } from 'expo-linear-gradient';
import { Rating } from '@oxy.so/bloom/rating';
import { Text } from '../ui/text';
import { useSharedUiTranslation } from '../../i18n/ui-translation';
import { MARKETPLACE_VISIT_MERCHANT_KEY } from '../../lib/marketplace-labels';
import { useRatingDisplay } from '../../lib/rating-display';
import type { StoreSummary } from '@mercaria/shared-types';

/** Fixed card height (px) — the carousel sizes the slot width, the card the height. */
const CARD_HEIGHT = 397;
/** Card corner radius (px). */
const CARD_RADIUS = 28;
/** Product-thumbnail corner radius (px). */
const THUMB_RADIUS = 20;

/** Documented dark cover overlay constant (~20%). */
const COVER_DARK_OVERLAY = 'rgba(0,0,0,0.20)';
/** Light text tone over a merchant cover (documented data-driven exception). */
const TONE_LIGHT = '#FFFFFF';
/** Dark text tone over a merchant cover (documented data-driven exception). */
const TONE_DARK = '#111111';
/**
 * Bottom brand-color gradient stops: opaque brand color at the bottom (0.2)
 * fading to transparent ~80% up, so the wordmark/rating/thumbnails sit over a
 * brand wash. Paired with `start={bottom}`/`end={top}`.
 */
const GRADIENT_LOCATIONS = [0.2, 0.8] as const;

export type MerchantLinkRenderer = (handle: string, child: ReactElement) => ReactNode;

export interface MerchantCardProps {
  merchant: StoreSummary;
  renderMerchantLink: MerchantLinkRenderer;
  renderProductLink: ProductLinkRenderer;
  /** Shop home centers the wordmark with its rating; discovery keeps a heading. */
  variant?: 'home' | 'discovery';
}

/**
 * Editorial "store hero" merchant (shop) card. Layers, back → front: the cover
 * photo (the visual anchor, bleeds the whole card) → a fixed dark tint → a
 * bottom brand-color gradient wash → the foreground content (centered wordmark,
 * name + rating, and a row of featured product thumbnails) → a 1px
 * inset border. Foreground text follows the merchant's `textTone`
 * (light/dark), including the rating star.
 *
 * No nested interactives: the store wordmark is one link, and each product
 * thumbnail is its own SIBLING link (never nested inside the store link), so
 * web renders no `<button>`/`<a>` inside another.
 */
export function MerchantCard({
  merchant,
  renderMerchantLink,
  renderProductLink,
  variant = 'discovery',
}: MerchantCardProps) {
  const resolveImage = useImageResolver();
  const coverSource = merchantImageSource(
    merchant.coverImageUrl,
    resolveImage,
    merchant.coverFileId,
  );
  const logoSource = merchantImageSource(merchant.logoUrl, resolveImage, merchant.logoFileId);
  const ratingDisplay = useRatingDisplay();
  const t = useSharedUiTranslation();
  const toneColor = merchant.textTone === 'light' ? TONE_LIGHT : TONE_DARK;

  const products = (merchant.products ?? []).slice(0, 3);
  const centeredDetails = variant === 'home' && Boolean(logoSource);
  const rating =
    merchant.rating > 0 && merchant.reviewCount > 0 ? (
      <Rating
        {...ratingDisplay({ rating: merchant.rating, reviews: merchant.reviewCount })}
        size="small"
        color={toneColor}
      />
    ) : null;

  return (
    <View
      testID="merchant-card"
      className="group w-full overflow-hidden web:shadow-lg"
      style={{
        height: CARD_HEIGHT,
        borderRadius: CARD_RADIUS,
        backgroundColor: merchant.brandColor,
      }}
    >
      {/* Layer 1 — cover image, bleeds the whole card (the visual anchor). */}
      {coverSource ? (
        <Image
          testID="merchant-card-cover"
          source={coverSource}
          contentFit="cover"
          pointerEvents="none"
          className="web:transition-transform web:duration-500 web:ease-out web:motion-safe:group-hover:scale-105 web:motion-reduce:transition-none"
          style={StyleSheet.absoluteFill}
        />
      ) : null}

      {/* The cover treatment belongs only to image-backed themes. */}
      {coverSource ? (
        <>
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: COVER_DARK_OVERLAY }]}
          />

          {/* Layer 3 — bottom brand-color gradient: opaque brand at the bottom → transparent ~80% up. */}
          <LinearGradient
            pointerEvents="none"
            colors={[merchant.brandColor, 'transparent']}
            locations={GRADIENT_LOCATIONS}
            start={{ x: 0, y: 1 }}
            end={{ x: 0, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : null}

      {/* Layer 4 — foreground content (above the layers as a later sibling). */}
      <View className="flex-1 p-3">
        {renderMerchantLink(
          merchant.handle,
          <Pressable
            testID="merchant-card-store-link"
            accessibilityLabel={t(MARKETPLACE_VISIT_MERCHANT_KEY, { name: merchant.name })}
            className="relative flex-1"
          >
            {variant === 'discovery' || logoSource ? (
              <View
                testID="merchant-card-branding"
                pointerEvents="none"
                className="absolute inset-0 items-center justify-center gap-2 web:transition-transform web:duration-150 web:ease-out web:motion-safe:group-hover:scale-110 web:motion-reduce:transition-none"
              >
                {logoSource ? (
                  <Image
                    source={logoSource}
                    contentFit="contain"
                    style={{
                      maxHeight: 74,
                      maxWidth: 195,
                      width: centeredDetails ? '60%' : '70%',
                      height: 74,
                    }}
                  />
                ) : (
                  <Text
                    numberOfLines={1}
                    className="max-w-[195px] text-center text-3xl font-bold"
                    style={{ color: toneColor }}
                  >
                    {merchant.name}
                  </Text>
                )}
                {centeredDetails ? rating : null}
              </View>
            ) : null}
            {!centeredDetails ? (
              <View testID="merchant-card-heading" pointerEvents="none" className="gap-0.5 p-1">
                <Text numberOfLines={1} className="text-sm font-bold" style={{ color: toneColor }}>
                  {merchant.name}
                </Text>
                {rating}
              </View>
            ) : null}
          </Pressable>,
        )}

        {/* Product links are siblings of the store link, with at most three squares. */}
        {products.length > 0 ? (
          <View testID="merchant-card-products" className="flex-row justify-center gap-1.5">
            {products.map((thumb) => {
              const imageUrl = resolveCatalogImage(
                thumb.imageFileId,
                thumb.imageUrl,
                resolveImage,
                'thumb',
              );
              return (
                <View key={thumb.id} className="min-w-0 max-w-[150px] flex-1">
                  {renderProductLink(
                    thumb.id,
                    <Pressable
                      testID="merchant-card-product-link"
                      accessibilityLabel={thumb.title}
                      className="group/product overflow-hidden bg-muted web:shadow-sm"
                      style={{ aspectRatio: 1, borderRadius: THUMB_RADIUS }}
                    >
                      {imageUrl ? (
                        <Image
                          testID="merchant-card-product-image"
                          source={{ uri: imageUrl }}
                          contentFit="cover"
                          className="web:transition-transform web:motion-safe:group-hover/product:scale-110 web:motion-reduce:transition-none"
                          style={StyleSheet.absoluteFill}
                        />
                      ) : null}
                      <View
                        pointerEvents="none"
                        className="absolute inset-0 border border-border"
                        style={{ borderRadius: THUMB_RADIUS }}
                      />
                    </Pressable>,
                  )}
                </View>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* Layer 5 — 1px inset border (very front, non-interactive). */}
      <View
        pointerEvents="none"
        className="absolute inset-0 border border-border"
        style={{ borderRadius: CARD_RADIUS }}
      />
    </View>
  );
}
