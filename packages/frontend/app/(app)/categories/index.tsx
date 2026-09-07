import Head from 'expo-router/head';
import { View } from 'react-native';
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
 * The taxonomy index hub — `/categories`. Renders the discovery feed at
 * `scope: 'root'` (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
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
 * The page's value to a crawler is that it is a page of links to category
 * pages, and that did not change with this redesign — the tiles and section
 * headers the feed renders ARE those links. The markup changed; the link
 * graph did not.
 *
 * ## This retired the hub's only reader of the taxonomy-v2 fallback
 *
 * Before this redesign this screen rendered `useCatalogNavigation` — the hook
 * that answers with the taxonomy-v2 trees when `CATALOG_TAXONOMY_V2_ENABLED`
 * is on and falls back to the v1 category tree when it is not, REPORTING
 * which answered (ADR 0007 D12) — and was its only app consumer. That is what
 * `docs/runbooks/catalog-rollout-rollback.md` §3/§6 point at when they say the
 * storefront menu visibly falls back when the lever goes off.
 *
 * The discovery feed does not read `GET /navigation` at all:
 * `services/discovery/feed.service.ts`'s root scope composes its sections
 * from `categoryRepository` directly, the same source the v1 fallback reads,
 * regardless of the flag. So this hub now renders identically whether
 * taxonomy-v2 is on or off, and a taxonomy-v2 entry with no destination in
 * this app (`saved_query`, `collection`, `product_type`, `campaign` — the
 * four kinds `NavigationMenu` used to render as text) has no section kind to
 * appear in here anymore. Flagged rather than silently dropped; the runbook's
 * rehearsal step and this consequence need a follow-up decision this task did
 * not make.
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
           * would misreport a configuration as a fault.
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
