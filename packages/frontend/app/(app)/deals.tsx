import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { DiscoveryFeed } from '@/components/discovery/DiscoveryFeed';
import { useTranslation } from '@/lib/i18n';
import { useDiscoveryFeed } from '@/lib/hooks/use-discovery-feed';
import { renderJsonLd } from '@/lib/catalog/structured-data';
import { useCatalogSeo } from '@/lib/catalog/use-catalog-seo';

/**
 * `/deals` — `scope: 'deals'`: one `store-offer` section per store with a
 * live automatic discount
 * (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
 *
 * No `categoryName` is passed to `DiscoveryFeed`: a deals feed carries no
 * signal shelf (`store-offer` sections name neither `categoryHandle` nor
 * `signal`), so there is nothing here for that prop to resolve — see
 * `DiscoveryFeed`'s own docblock.
 *
 * `routes.ts` registers `deals` as `availability: 'live'` and indexable, and
 * `resolveDealsPage` composes a full `SeoDocument` for it — same shape,
 * same reasons, as `resolveCategoryIndex` for `/categories`. This screen
 * consumes it the same way `categories/index.tsx` does.
 */
export default function DealsScreen() {
  const { t } = useTranslation();
  const feed = useDiscoveryFeed({ kind: 'deals' });
  const seo = useCatalogSeo('/deals');
  const sections = feed.data?.sections ?? [];

  const document = seo.data?.document;
  const jsonLd = renderJsonLd(document?.structuredData ?? []);
  const title = document?.title ?? t('discovery.deals.title');

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>{t('discovery.deals.documentTitle', { title })}</title>
        {document?.description === undefined ? null : (
          <meta name="description" content={document.description} />
        )}
        {/* The canonical URL and the alternates are the registry's, exactly as
            on `/categories`. With the SEO surface unmounted neither tag is
            emitted, which leaves the address as its own canonical — what it in
            fact is — rather than asserting an indexing decision composed
            here. */}
        {document?.canonicalUrl === undefined ? null : (
          <link rel="canonical" href={document.canonicalUrl} />
        )}
        {(document?.localeAlternates ?? []).map((alternate) => (
          <link
            key={alternate.hreflang}
            rel="alternate"
            hrefLang={alternate.hreflang}
            href={alternate.href}
          />
        ))}
        {document?.robots === undefined ? null : (
          <meta name="robots" content={document.robots} />
        )}
        {jsonLd === undefined ? null : (
          <script
            type="application/ld+json"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: jsonLd }}
          />
        )}
      </Head>
      {/*
       * Page chrome only — the feed renders below, outside this container, so
       * its carousels get the full scroll width instead of clipping inside a
       * centred column. `categories/index.tsx` says the same thing at length.
       */}
      <View className="mb-space-32 web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <Text className="text-headerBold text-text" accessibilityRole="header">
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
      </View>

      <DiscoveryFeed sections={sections} />

      <Footer />
    </ScreenShell>
  );
}
