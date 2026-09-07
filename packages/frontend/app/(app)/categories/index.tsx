import Head from 'expo-router/head';
import { Pressable, View } from 'react-native';
import type { Href } from 'expo-router';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { CatalogBreadcrumbs } from '@/components/catalog/CatalogBreadcrumbs';
import { DiscoveryFeed } from '@/components/discovery/DiscoveryFeed';
import { useTranslation } from '@/lib/i18n';
import { useDiscoveryFeed } from '@/lib/hooks/use-discovery-feed';
import { renderJsonLd } from '@/lib/catalog/structured-data';
import { useCatalogSeo } from '@/lib/catalog/use-catalog-seo';

/**
 * The taxonomy index hub — `/categories`.
 *
 * ## The SEO decision this page needed, and what was decided
 *
 * `docs/storefront-catalog.md` §Seams held the screen back on one question:
 * whether a page whose entire content is links to pages each indexed on their
 * own earns a `PublicRouteId` of its own. It does, and it is registered as
 * `category_index`. Every route the registry excuses from indexing is excused
 * for one of three reasons — account-private, a shopper-assembled combination
 * or position-dependent, or a step in a transaction — and a taxonomy root is
 * none of those. The reasoning is on the `PublicRouteId` member, where the next
 * person to ask will find it.
 *
 * ## It must render the PUBLISHED navigation, not a second taxonomy — and does not yet
 *
 * That is this page's contract, and it is the reason the hub cannot simply
 * arrange categories however it likes: it shows the same menu the rest of the
 * storefront shows, in the order somebody published, rather than a private
 * arrangement that would disagree with the header the moment an operator
 * reordered one. `useCatalogNavigation` is what serves it — taxonomy-v2 trees
 * when `CATALOG_TAXONOMY_V2_ENABLED` is on, the v1 category tree when it is
 * not, REPORTING which answered (ADR 0007 D12).
 *
 * The body below no longer calls it. It renders the discovery feed at
 * `scope: 'root'`, and `services/discovery/feed.service.ts` composes that scope
 * from `categoryRepository` directly, with no reading of `GET /navigation` and
 * no involvement of the lever. Two things follow, both true today and neither
 * intended:
 *
 * - This page renders identically whether `CATALOG_TAXONOMY_V2_ENABLED` is on
 *   or off, so the rollback visibility `docs/runbooks/catalog-rollout-rollback.md`
 *   §3/§6 promises has no surface here.
 * - The four non-category target kinds (`saved_query`, `collection`,
 *   `product_type`, `campaign`) have no section kind to render as, so
 *   taxonomy-v2-only entries do not appear at all.
 *
 * This was investigated as a server-side fix and DELIBERATELY RETIRED rather
 * than built, once its real cost was measured. It needs a new
 * `DiscoverySection` kind — `navigationTargetHref` answers `undefined` for
 * all four, so no existing tile section, which hard-navigates via
 * `categoryHref`, can carry them — plus `market` and `locale` on
 * `GET /discovery/feed`, since `readPublishedNavigation` requires both and
 * neither reaches the server today. Without them, `resolveCatalogNavigation`'s
 * own rule is "market undefined, skip to v1", so a faithful port would take
 * the fallback branch every time and leave the lever exactly as invisible as
 * it is now.
 *
 * Against that: `docs/runbooks/catalog-rollout-rollback.md`'s lever table says
 * every tree, node and label stays readable through `/internal/navigation`
 * with the lever off, its section 3 storefront rehearsal has never been run,
 * and `lib/catalog/navigation-fallback.test.ts` covers the mechanism either
 * way. The four kinds rendered as inert, non-navigable TEXT before this
 * redesign. Two contract changes and new client render logic to restore four
 * text labels and an unrehearsed check with another surface is not a trade
 * worth making, and the runbook records the retirement.
 *
 * ## No count, no "N products"
 *
 * Nothing here reads a listing count per category. One would need a per-node
 * aggregate no read serves, and inventing it from a page of listings would put
 * a number on screen that is wrong for every category with more than a page.
 */
export default function CategoryIndexScreen() {
  const { t } = useTranslation();
  const feed = useDiscoveryFeed({ kind: 'root' });
  const seo = useCatalogSeo('/categories');

  const document = seo.data?.document;
  const jsonLd = renderJsonLd(document?.structuredData ?? []);
  const title = document?.title ?? t('catalog.categoryIndex.title');

  const head = (
    <Head>
      <title>{t('catalog.categoryIndex.documentTitle', { title })}</title>
      {document?.description === undefined ? null : (
        <meta name="description" content={document.description} />
      )}
      {/* The canonical URL and the alternates are the registry's, exactly as on
          the per-category page. With the SEO surface unmounted neither tag is
          emitted, which leaves the address as its own canonical — what it in
          fact is — rather than asserting an indexing decision composed here. */}
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
  );

  if (feed.isLoading && feed.data === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        {head}
        <Text className="px-8 py-16 text-body text-text-tertiary">{t('common.loading')}</Text>
      </ScreenShell>
    );
  }

  // A FAILED request is not the empty state below — that one is a real,
  // published-but-empty taxonomy and is not an error. Before `useDiscoveryFeed`
  // replaced it, `useCatalogNavigation` had its own v1 fallback, so only a
  // total failure of both reached the empty branch; this hook has no such
  // fallback, so one failed request lands here directly and needs its own
  // branch rather than inheriting the empty one's confident "nothing published"
  // text.
  if (feed.isError && feed.data === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        {head}
        <View className="items-center px-8 py-16">
          <Text className="text-center text-body text-text-tertiary">
            {t('catalog.categoryIndex.loadError')}
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
      </ScreenShell>
    );
  }

  const sections = feed.data?.sections ?? [];

  return (
    <ScreenShell contentClassName="pt-6">
      {head}
      <View className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <CatalogBreadcrumbs
          crumbs={document?.breadcrumbs ?? []}
          hrefForPath={hubHrefForPath}
        />

        <Text className="text-titleMedium text-text" accessibilityRole="header">
          {t('catalog.categoryIndex.title')}
        </Text>

        {sections.length === 0 ? (
          /*
           * A real state, and it is not an error. A deployment with no active
           * taxonomy yet composes an empty feed rather than failing — and a
           * page that showed a spinner forever, or "something went wrong",
           * would misreport a configuration as a fault. A FAILED request is
           * caught above, before `sections` is even read, precisely so it
           * cannot fall through and be told apart from this one.
           */
          <Text className="text-body text-text-tertiary">
            {t('catalog.categoryIndex.empty')}
          </Text>
        ) : (
          <DiscoveryFeed sections={sections} />
        )}
      </View>
      <Footer />
    </ScreenShell>
  );
}

/**
 * The `Href` for a registry breadcrumb path, for the two paths this hub's own
 * trail can name.
 *
 * Narrow on purpose, exactly as the per-category screen's own mapper is: a
 * breadcrumb pointing anywhere else is rendered as text rather than followed,
 * so a registry trail that named a brand or a product could not be walked from
 * here as if it were part of this page's structure. Both destinations are
 * spelled in the OBJECT form, which `typedRoutes` checks completely.
 */
function hubHrefForPath(path: string): Href | undefined {
  const withoutQuery = path.split('?')[0];
  if (withoutQuery === '/') return { pathname: '/' };
  if (withoutQuery === '/categories') return { pathname: '/categories' };
  return undefined;
}
