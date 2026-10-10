import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import { CurationCard, Text, useShelfCarouselProps } from '@mercaria/ui';
import { useCurations } from '@/lib/curations/use-curations';
import { useTranslation } from '@/lib/i18n';

export function CurationHighlights() {
  const { curations } = useCurations();
  const { t } = useTranslation();
  const router = useRouter();
  const shelf = useShelfCarouselProps();
  const { width: viewport } = useWindowDimensions();
  const [width, setWidth] = useState(viewport);
  if (!curations.length) return null;
  const inset = viewport >= 1024 ? 48 : 16;
  const itemWidth = viewport >= 768 ? (width - inset * 2 - 32) / 3 : Math.max(240, width * 0.8);
  return (
    <View
      className="mb-10"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      testID="curation-highlights"
    >
      <Carousel {...shelf} showArrows={false} accessibilityLabel={t('curations.heading')}>
        {curations.map((curation) => (
          <CarouselItem key={curation.slug} width={itemWidth}>
            <CurationCard
              title={t(curation.titleKey)}
              imageUrl={curation.imageUrl}
              fallbackImageUrl={curation.products[0]?.imageUrl}
              onPress={() =>
                router.push({
                  pathname: '/curations/[slug]',
                  params: { slug: curation.slug },
                })
              }
            />
          </CarouselItem>
        ))}
      </Carousel>
      <Text className="mt-3 px-4 text-xs text-muted-foreground lg:px-12">
        {t('curations.preview')}
      </Text>
    </View>
  );
}
