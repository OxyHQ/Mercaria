import { View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { EditorialCuration, Text, type EditorialStory } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { CurationHighlights } from '@/components/discovery/CurationHighlights';
import { useCurations } from '@/lib/curations/use-curations';
import { useTranslation } from '@/lib/i18n';

const STORY_HEADINGS = ['curations.everyday', 'curations.fresh', 'curations.pleasures'];
const STORY_QUOTES = [
  'curations.quoteComfort',
  'curations.quoteTexture',
  'curations.quoteEveryday',
];
const STORY_PRODUCT_COUNTS = [10, 6, 8, 4, 10, 10];

export default function CurationScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { curations, isLoading, isError, refetch } = useCurations();
  const curation = curations.find((item) => item.slug === slug || item.referenceId === slug);
  const { t } = useTranslation();
  const router = useRouter();
  const stories: EditorialStory[] = curation
    ? Array.from({ length: 6 }, (_, index) => {
        const offset = (index * 3) % curation.products.length;
        const products = [
          ...curation.products.slice(offset),
          ...curation.products.slice(0, offset),
        ].slice(0, STORY_PRODUCT_COUNTS[index]);
        const gallery = index % 2 === 1;
        return {
          id: `story-${index}`,
          heading: t(STORY_HEADINGS[Math.floor(index / 2)]!),
          products,
          ...(gallery
            ? {
                imageUrl: curation.galleryImages?.[Math.floor(index / 2)] ?? products[0]?.imageUrl,
                body: t('curations.description'),
                quote: t(STORY_QUOTES[Math.floor(index / 2)]!),
              }
            : {}),
        };
      })
    : [];
  return (
    <ScreenShell>
      <Head>
        <title>{curation ? t(curation.titleKey) : t('curations.heading')}</title>
        <meta name="robots" content="noindex" />
      </Head>
      {isLoading ? (
        <View className="py-20">
          <Loading variant="inline" />
        </View>
      ) : !curation ? (
        <View className="items-center gap-4 px-4 py-20">
          <Text className="text-center text-muted-foreground">
            {t(isError ? 'home.loadError' : 'curations.unavailable')}
          </Text>
          <Button
            appearance="outline"
            tone="neutral"
            onPress={() => (isError ? void refetch() : router.replace('/explore'))}
          >
            {t(isError ? 'common.tryAgain' : 'nav.explore')}
          </Button>
        </View>
      ) : (
        <>
          <EditorialCuration
            title={t(curation.titleKey)}
            subtitle={t(
              curation.referenceId ? 'curations.referenceSubtitle' : 'curations.description',
            )}
            introduction={t('curations.description')}
            previewLabel={t('curations.preview')}
            heroImageUrl={curation.imageUrl}
            mobileHeroImageUrl={curation.mobileImageUrl}
            stories={stories}
            onPressProduct={(id) => router.push({ pathname: '/products/[id]', params: { id } })}
          />
          <CurationHighlights />
        </>
      )}
    </ScreenShell>
  );
}
