import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { DiscoveryFeed } from '@/components/discovery/DiscoveryFeed';
import { useTranslation } from '@/lib/i18n';
import { useDiscoveryFeed } from '@/lib/hooks/use-discovery-feed';

/**
 * `/deals` — `scope: 'deals'`: one `store-offer` section per store with a
 * live automatic discount
 * (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
 *
 * No `categoryName` is passed to `DiscoveryFeed`: a deals feed carries no
 * signal shelf (`store-offer` sections name neither `categoryHandle` nor
 * `signal`), so there is nothing here for that prop to resolve — see
 * `DiscoveryFeed`'s own docblock.
 */
export default function DealsScreen() {
  const { t } = useTranslation();
  const feed = useDiscoveryFeed({ kind: 'deals' });
  const sections = feed.data?.sections ?? [];

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>{t('discovery.deals.title')}</title>
      </Head>
      <View className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <Text className="text-titleMedium text-text" accessibilityRole="header">
          {t('discovery.deals.title')}
        </Text>

        {feed.isLoading && feed.data === undefined ? (
          <Text className="text-body text-text-tertiary">{t('common.loading')}</Text>
        ) : null}

        {/* A FAILED request is not "no active deals" — that is a real state
            (nothing live to show), and this one is a fetch that never
            answered. Checked before the empty branch so a failure cannot
            fall through and read as the confident, unrelated claim. */}
        {feed.isError && feed.data === undefined ? (
          <View className="items-center px-8 py-16">
            <Text className="text-center text-body text-text-tertiary">
              {t('discovery.deals.loadError')}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.tryAgain')}
              onPress={() => feed.refetch()}
              className="mt-4 rounded-full border border-border px-5 py-2"
            >
              <Text className="text-sm font-semibold text-foreground">{t('common.tryAgain')}</Text>
            </Pressable>
          </View>
        ) : null}

        {!feed.isLoading && !feed.isError && sections.length === 0 ? (
          <Text className="text-body text-text-tertiary">{t('discovery.deals.empty')}</Text>
        ) : null}

        <DiscoveryFeed sections={sections} />

        <Footer />
      </View>
    </ScreenShell>
  );
}
