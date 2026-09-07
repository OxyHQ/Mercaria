import { View } from 'react-native';
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

        {!feed.isLoading && sections.length === 0 ? (
          <Text className="text-body text-text-tertiary">{t('discovery.deals.empty')}</Text>
        ) : null}

        <DiscoveryFeed sections={sections} />

        <Footer />
      </View>
    </ScreenShell>
  );
}
