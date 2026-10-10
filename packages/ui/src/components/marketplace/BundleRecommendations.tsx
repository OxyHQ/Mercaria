import { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Button } from '@oxy.so/bloom/button';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import { isImageUrl, useImageResolver } from '@oxy.so/bloom/image-resolver';
import type { ListingBundleRecommendation } from '@mercaria/shared-types';
import { Text } from '../ui/text';
import { PriceDisplay } from '../PriceDisplay';
import { useSharedUiTranslation } from '../../i18n/ui-translation';
import { useShelfCarouselProps } from '../../lib/shelf-carousel';
import { useShopControlClassName } from '../../lib/useShopControlClassName';

export interface BundleRecommendationsProps {
  bundles: readonly ListingBundleRecommendation[];
  onView: (bundle: ListingBundleRecommendation) => void;
  onAddToCart: (bundle: ListingBundleRecommendation) => Promise<void>;
}

/** Shop's bundle upsell: 134px photos, horizontal cards, 1.25/2.5/3 visible.
 * Reuses Bloom's carousel and buttons; the seller's own pack price is displayed. */
export function BundleRecommendations({ bundles, onView, onAddToCart }: BundleRecommendationsProps) {
  const t = useSharedUiTranslation();
  const { width } = useWindowDimensions();
  const shelf = useShelfCarouselProps();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  if (!bundles.length) return null;
  const desktop = width >= 768;
  // Below 360px, peeking a second card leaves too little room beside the
  // fixed photo for prices and translated actions. Keep one complete card.
  const visible = width >= 976 ? 3 : desktop ? 2.5 : bundles.length === 1 || width < 360 ? 1 : 1.25;
  const inset = desktop ? 0 : 16;
  const cardWidth = (measuredWidth - inset * 2 - (visible - 1) * 8) / visible;
  const title = t(bundles.some(bundle => bundle.compareAtPrice) ? 'ui.bundle.andSave' : 'ui.bundle.together');
  return (
    <View testID="bundle-recommendations" className="my-space-32 min-w-0 gap-space-16 md:px-space-16">
      <Text accessibilityRole="header" className="px-space-16 text-shop-subtitle text-text md:px-0 md:text-shop-sectionTitle">{title}</Text>
      <View className="min-w-0" onLayout={event => setMeasuredWidth(event.nativeEvent.layout.width)}>
      {measuredWidth > 0 ? <Carousel {...shelf} gap={8} inset={inset} accessibilityLabel={title}>
        {bundles.map(bundle => <CarouselItem key={bundle.variantId} width={cardWidth}>
          <BundleRecommendationCard bundle={bundle} onView={onView} onAddToCart={onAddToCart} />
        </CarouselItem>)}
      </Carousel> : null}
      </View>
    </View>
  );
}

function BundleRecommendationCard({ bundle, onView, onAddToCart }: Omit<BundleRecommendationsProps, 'bundles'> & { bundle: ListingBundleRecommendation }) {
  const t = useSharedUiTranslation();
  const controls = useShopControlClassName();
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failedImage, setFailedImage] = useState<string>();
  const resolveImage = useImageResolver();
  const fileId = bundle.image?.fileId;
  const uri = fileId && !isImageUrl(fileId) ? resolveImage?.(fileId, 'thumb') : undefined;
  const activate = async () => {
    if (bundle.action === 'view_bundle') { onView(bundle); return; }
    if (pending) return;
    setPending(true); setFailed(false); setAdded(false);
    try { await onAddToCart(bundle); setAdded(true); }
    catch { setFailed(true); }
    finally { setPending(false); }
  };
  return (
    <View testID="bundle-recommendation-card" className="min-h-[155px] min-w-0 max-w-full flex-row gap-space-12 rounded-radius-12 border border-border-secondary bg-bg-fill p-space-16">
      {bundle.image ? <Pressable testID="bundle-recommendation-image" accessibilityRole="link" accessibilityLabel={bundle.title} disabled={pending}
        onPress={() => onView(bundle)} className="h-[134px] w-[134px] shrink-0 items-center justify-center overflow-hidden rounded-radius-8 bg-muted">
        {uri && failedImage !== uri ? <Image source={{ uri }} contentFit="cover" accessibilityLabel={bundle.image.alt ?? bundle.title}
          onError={() => setFailedImage(uri)} className="size-full" />
          : <Text className="p-space-8 text-shop-badge text-muted-foreground">{t('ui.marketplace.noImage')}</Text>}
      </Pressable> : null}
      <View className="min-w-0 flex-1 justify-between gap-space-12">
        <Pressable accessibilityRole="link" accessibilityLabel={bundle.title} disabled={pending} onPress={() => onView(bundle)} className="min-w-0 flex-1">
          <Text numberOfLines={2} className="text-shop-bodySmall text-text">{bundle.title}</Text>
          <View className="min-w-0 flex-row flex-wrap gap-space-4 pt-space-4">
            <PriceDisplay price={bundle.price} primaryClassName="text-shop-bodySmall font-normal" className="min-w-0 flex-wrap" />
            {bundle.compareAtPrice ? <PriceDisplay price={bundle.compareAtPrice} primaryClassName="text-shop-bodySmall font-normal text-text-tertiary line-through" secondaryClassName="line-through" className="min-w-0 flex-wrap" /> : null}
          </View>
        </Pressable>
        <Button material="flat" appearance="subtle" size="sm" loading={pending} disabled={pending}
          className={`${controls('tertiary', false, pending)} min-w-0 w-full web:whitespace-normal`}
          textStyle={{ flexShrink: 1, paddingHorizontal: 0, textAlign: 'center' }}
          accessibilityLabel={t(bundle.action === 'view_bundle' ? 'ui.bundle.view' : added ? 'ui.purchase.added' : 'ui.purchase.addToCart')}
          onPress={() => { void activate(); }}>
          {t(bundle.action === 'view_bundle' ? 'ui.bundle.view' : added ? 'ui.purchase.added' : 'ui.purchase.addToCart')}
        </Button>
        {failed ? <Text accessibilityRole="alert" className="text-shop-caption text-destructive">{t('ui.bundle.addFailed')}</Text> : null}
      </View>
    </View>
  );
}
