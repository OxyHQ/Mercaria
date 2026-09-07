import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { DiscoverySignal } from '@mercaria/shared-types';
import { DISCOVERY_SIGNALS } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { SignalGrid } from '@/components/discovery/SignalGrid';
import { useTranslation } from '@/lib/i18n';
import { useDiscoverySignalPage } from '@/lib/hooks/use-discovery-feed';
import { sectionTitleKey, sectionTitleParams } from '@/lib/discovery/section-title';
import { findCategoryByHandle, useCategoryTree } from '@/lib/catalog/category-tree';

/**
 * `/categories/:handle/s/:signal` — one signal, one scope, paginated: the
 * "see all" destination every hero card and `SectionCard` on the feed links
 * to (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
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
 * (`config.discovery.topNPerCategory`). Every page `useDiscoverySignalPage`
 * fetches carries the same `pageDepth` for a fixed signal+scope, so this
 * screen reads it off the first page and shows a notice on the capped case
 * rather than a shopper discovering the edge on their own.
 *
 * ## `hasMore`, never a client-side cap
 *
 * `GET /discovery/signal` computes `hasMore` by reading one row past `limit`
 * server-side (team-lead ruling, `task-4-report.md`), so a `'capped'` signal's
 * "Load more" disappears at the real edge of what the sweep counted, and a
 * `'complete'` one at the real edge of `listings` — this screen never
 * predicts either number itself.
 */

function isDiscoverySignal(value: string): value is DiscoverySignal {
  return (DISCOVERY_SIGNALS as readonly string[]).includes(value);
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

  const signal = isDiscoverySignal(rawSignal) ? rawSignal : undefined;
  const signalPage = useDiscoverySignalPage({ kind: 'category', handle }, signal);

  const onPressProduct = (id: string) =>
    router.push({ pathname: '/products/[id]', params: { id } });

  if (signal === undefined) {
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
  const pages = signalPage.data ?? [];
  const products = pages.flatMap((page) => page.products);
  const pageDepth = pages[0]?.pageDepth;

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
        {pageDepth === 'capped' ? (
          <Text className="text-caption text-text-tertiary">
            {t('discovery.signal.cappedNotice')}
          </Text>
        ) : null}

        {signalPage.isLoading && products.length === 0 ? (
          <Text className="text-body text-text-tertiary">{t('common.loading')}</Text>
        ) : null}

        {!signalPage.isLoading && products.length === 0 ? (
          <Text className="text-body text-text-tertiary">{t('discovery.signal.empty')}</Text>
        ) : null}

        {products.length > 0 ? (
          <SignalGrid products={products} onPressProduct={onPressProduct} />
        ) : null}

        {signalPage.hasNextPage ? (
          <View className="items-center px-4 py-6">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('discovery.signal.loadMoreLabel')}
              disabled={signalPage.isFetchingNextPage}
              onPress={() => void signalPage.fetchNextPage()}
              className="rounded-full border border-border bg-muted px-6 py-3 web:shadow-sm"
            >
              <Text className="text-sm font-semibold text-foreground">
                {signalPage.isFetchingNextPage
                  ? t('discovery.signal.loadingMore')
                  : t('discovery.signal.loadMore')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <Footer />
      </View>
    </ScreenShell>
  );
}
