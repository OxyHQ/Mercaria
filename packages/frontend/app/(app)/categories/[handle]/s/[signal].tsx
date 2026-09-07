import { useMemo } from 'react';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { DiscoverySection, DiscoverySignal, ProductsSection } from '@mercaria/shared-types';
import { DISCOVERY_SIGNALS } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { SignalGrid } from '@/components/discovery/SignalGrid';
import { useTranslation } from '@/lib/i18n';
import { useDiscoveryFeed } from '@/lib/hooks/use-discovery-feed';
import { sectionTitleKey, sectionTitleParams } from '@/lib/discovery/section-title';
import { findCategoryByHandle, useCategoryTree } from '@/lib/catalog/category-tree';

/**
 * `/categories/:handle/s/:signal` — one signal, one scope: the "see all"
 * destination every hero card and `SectionCard` on the feed links to
 * (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
 *
 * ## An unknown signal is a not-found, never a default
 *
 * `signal` is validated against the closed `DISCOVERY_SIGNALS` tuple before
 * anything is fetched — the same reasoning `routes/discovery.ts`'s 400 has for
 * a malformed `scope`: a typo in the URL is a wrong page, not a silent
 * fallback to some other shelf.
 *
 * ## Depth is reported, never assumed
 *
 * `top-rated`, `new` and `on-sale` read `listings` directly and are
 * `pageDepth: 'complete'`; `best-selling` and `most-viewed` are answered from
 * `discovery_signals` and are `'capped'` — only as deep as the sweep counted
 * (`config.discovery.topNPerCategory`). The section the feed already returns
 * carries its own `pageDepth`, so this screen reads it rather than inferring
 * it from the signal a second time, and shows a notice on the capped case
 * rather than a shopper discovering the edge on their own.
 *
 * ## Where the products come from
 *
 * The category-scoped discovery feed already builds one `products` section
 * per shelf signal (`on-sale`, `best-selling`, `most-viewed`) and folds
 * `top-rated`/`new` into its `card-group` section — see
 * `services/discovery/feed.service.ts`'s `CARD_GROUP_SIGNALS`/`SHELF_SIGNALS`
 * split. `findSignalSection` below reads whichever of the two shapes carries
 * the requested signal, so this screen needs no endpoint of its own.
 */

function isDiscoverySignal(value: string): value is DiscoverySignal {
  return (DISCOVERY_SIGNALS as readonly string[]).includes(value);
}

/** The one `products` section naming `signal`, wherever the feed put it. */
function findSignalSection(
  sections: readonly DiscoverySection[],
  signal: DiscoverySignal,
): ProductsSection | undefined {
  for (const section of sections) {
    if (section.kind === 'products' && section.signal === signal) {
      return section;
    }
    if (section.kind === 'card-group') {
      const nested = section.cards.find((card) => card.signal === signal);
      if (nested) return nested;
    }
  }
  return undefined;
}

export default function SignalScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ handle: string; signal: string }>();
  const handle = params.handle ?? '';
  const rawSignal = params.signal ?? '';

  const tree = useCategoryTree();
  const category = useMemo(
    () => (tree.data === undefined ? undefined : findCategoryByHandle(tree.data, handle)),
    [tree.data, handle],
  );

  const feed = useDiscoveryFeed({ kind: 'category', handle });

  const onPressProduct = (id: string) =>
    router.push({ pathname: '/products/[id]', params: { id } });

  if (!isDiscoverySignal(rawSignal)) {
    return (
      <ScreenShell contentClassName="pt-6">
        <View className="items-center justify-center px-8 py-16">
          <Text className="text-center text-body text-text-tertiary">
            {t('discovery.signal.notFound')}
          </Text>
        </View>
      </ScreenShell>
    );
  }
  const signal = rawSignal;

  if (tree.isLoading && tree.data === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        <Text className="px-8 py-16 text-body text-text-tertiary">{t('common.loading')}</Text>
      </ScreenShell>
    );
  }

  if (category === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        <View className="items-center justify-center px-8 py-16">
          <Text className="text-center text-body text-text-tertiary">
            {t('catalog.category.notFound')}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const title = t(sectionTitleKey(signal), sectionTitleParams(category.name));
  const section =
    feed.data === undefined ? undefined : findSignalSection(feed.data.sections, signal);

  const head = (
    <Head>
      <title>{title}</title>
    </Head>
  );

  return (
    <ScreenShell contentClassName="pt-6">
      {head}
      <View className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <Text className="text-titleMedium text-text" accessibilityRole="header">
          {title}
        </Text>

        {/* Reported rather than implied: a capped shelf says so, up front,
            instead of letting the shopper find the edge on their own. The
            complete case needs no caveat — it is the unqualified default. */}
        {section?.pageDepth === 'capped' ? (
          <Text className="text-caption text-text-tertiary">
            {t('discovery.signal.cappedNotice')}
          </Text>
        ) : null}

        {feed.isLoading && feed.data === undefined ? (
          <Text className="text-body text-text-tertiary">{t('common.loading')}</Text>
        ) : null}

        {!feed.isLoading && (section === undefined || section.products.length === 0) ? (
          <Text className="text-body text-text-tertiary">{t('discovery.signal.empty')}</Text>
        ) : null}

        {section !== undefined && section.products.length > 0 ? (
          <SignalGrid products={section.products} onPressProduct={onPressProduct} />
        ) : null}

        <Footer />
      </View>
    </ScreenShell>
  );
}
