import { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import type { ProductBundleComponent, ProductBundleContents } from '@mercaria/shared-types';
import { Text } from '../ui/text';
import { useSharedUiTranslation } from '../../i18n/ui-translation';
import { useShelfCarouselProps } from '../../lib/shelf-carousel';

export interface BundleContentsProps {
  contents?: ProductBundleContents;
  pending?: boolean;
  resolveImage: (image: NonNullable<ProductBundleComponent['image']>) => string | undefined;
  onPressComponent: (component: ProductBundleComponent) => void;
}

/** Shop's three-item phone rail and four/five-column gallery-side grid. */
export function BundleContents({
  contents,
  pending = false,
  resolveImage,
  onPressComponent,
}: BundleContentsProps) {
  const t = useSharedUiTranslation();
  const { width } = useWindowDimensions();
  const shelf = useShelfCarouselProps();
  const [availableWidth, setAvailableWidth] = useState(0);
  const desktop = width >= 768;
  const columns = width >= 976 ? 5 : 4;
  if (!contents || (contents.status === 'available' && !contents.components.length)) return null;
  const title = t('ui.bundle.title');
  const cardWidth = desktop
    ? (availableWidth - (columns - 1) * 8) / columns
    : (availableWidth - 32 - 16) / 3;
  const card = (component: ProductBundleComponent) => (
    <BundleComponentCard
      key={component.variantId}
      component={component}
      disabled={pending}
      uri={component.image ? resolveImage(component.image) : undefined}
      onPress={() => onPressComponent(component)}
    />
  );
  return (
    <View
      testID="included-in-bundle-section"
      accessibilityState={{ busy: pending }}
      aria-busy={pending}
      onLayout={({ nativeEvent }) => setAvailableWidth(nativeEvent.layout.width)}
      className={
        desktop
          ? 'mt-[52px] mb-space-8 gap-space-16'
          : 'mt-space-4 -mx-space-16 gap-space-16 border-y border-border py-space-16'
      }
    >
      <Text
        accessibilityRole="header"
        className={
          desktop
            ? 'text-shop-sectionTitle text-foreground'
            : 'px-space-16 text-shop-subtitle text-foreground'
        }
      >
        {title}
      </Text>
      {contents.status === 'withheld' ? (
        <Text
          className={
            desktop
              ? 'text-shop-bodySmall text-muted-foreground'
              : 'px-space-16 text-shop-bodySmall text-muted-foreground'
          }
        >
          {t('ui.bundle.unavailable')}
        </Text>
      ) : availableWidth > 0 ? (
        desktop ? (
          <View testID="bundle-components-desktop-grid" className="flex-row flex-wrap gap-space-8">
            {contents.components.map((component) => (
              <View key={component.variantId} style={{ width: cardWidth }}>
                {card(component)}
              </View>
            ))}
          </View>
        ) : (
          <Carousel
            {...shelf}
            gap={8}
            inset={16}
            accessibilityLabel={title}
            testID="bundle-components-mobile-rail"
          >
            {contents.components.map((component) => (
              <CarouselItem key={component.variantId} width={cardWidth}>
                {card(component)}
              </CarouselItem>
            ))}
          </Carousel>
        )
      ) : null}
    </View>
  );
}

function BundleComponentCard({
  component,
  uri,
  onPress,
  disabled,
}: {
  component: ProductBundleComponent;
  uri?: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const t = useSharedUiTranslation();
  const [failedUri, setFailedUri] = useState<string>();
  return (
    <Pressable
      testID="bundled-product-card"
      accessibilityRole="link"
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      accessibilityLabel={t('ui.bundle.open', {
        name: component.name,
        variant: component.variantName ?? '',
        quantity: component.quantity,
      })}
      className="group relative overflow-hidden rounded-[10px] border border-border bg-card web:focus-visible:outline web:focus-visible:outline-2 web:focus-visible:outline-primary"
    >
      <View className="aspect-square overflow-hidden bg-muted">
        {uri && uri !== failedUri ? (
          <Image
            source={{ uri }}
            accessibilityLabel={component.image?.alt ?? component.name}
            onError={() => setFailedUri(uri)}
            contentFit="cover"
            className="size-full web:transition-transform web:duration-150 web:group-hover:scale-105 web:motion-reduce:transition-none web:motion-reduce:transform-none"
          />
        ) : (
          <View className="flex-1 items-center justify-center p-space-8">
            <Text className="text-shop-badge text-muted-foreground">
              {t('ui.marketplace.noImage')}
            </Text>
          </View>
        )}
      </View>
      {component.quantity > 1 ? (
        <View
          testID="bundle-quantity"
          pointerEvents="none"
          className="absolute top-space-12 start-space-12 rounded-[4px] bg-white px-space-4 py-space-2"
        >
          <Text className="text-shop-badge text-black">
            {t('ui.bundle.quantity', { quantity: component.quantity })}
          </Text>
        </View>
      ) : null}
      <View className="border-t border-border">
        <Text numberOfLines={1} className="m-space-8 text-shop-bodyTitleSmall text-foreground">
          {component.name}
        </Text>
      </View>
    </Pressable>
  );
}
