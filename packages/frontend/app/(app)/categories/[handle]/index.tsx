import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import type { SeoBreadcrumb } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { CatalogBreadcrumbs } from '@/components/catalog/CatalogBreadcrumbs';
import { DiscoveryFeed } from '@/components/discovery/DiscoveryFeed';
import { useTranslation } from '@/lib/i18n';
import { useDiscoveryFeed } from '@/lib/hooks/use-discovery-feed';
import { categoryHref } from '@/lib/catalog/routes';
import {
  categoryAncestors,
  findCategoryByHandle,
  useCategoryTree,
} from '@/lib/catalog/category-tree';
import { renderJsonLd } from '@/lib/catalog/structured-data';
import { useCatalogSeo } from '@/lib/catalog/use-catalog-seo';

/**
 * A category landing page (#367 workstream 9 §"Categories and navigation"),
 * rebuilt against the discovery feed
 * (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
 *
 * Three server surfaces compose it and this file composes none of them:
 *
 * | What | Where it comes from |
 * | --- | --- |
 * | identity, breadcrumb ancestry (fallback only) | `GET /categories` — see `lib/catalog/category-tree.ts` for why |
 * | breadcrumbs, canonical URL, `hreflang`, redirects | `GET /seo/resolve` |
 * | the header art, subcategories and products | `GET /discovery/feed?scope=category:<slug>` |
 *
 * ## There is no facet rail here, and the whole apparatus is now dead code (#637)
 *
 * The manual `useListings`-backed grid this screen used to render is gone,
 * replaced by the feed's own `products` sections. `POST /facets` counted over
 * a different catalogue from that grid to begin with —
 * `lib/catalog/facet-consumption.ts` derives that from the grid's own query
 * type — so removing the grid does not reopen anything #637 closed.
 *
 * It does mean `FacetRail`, `useFacets` and `lib/catalog/facet-selection.ts`
 * lose their only app-level caller. They are left in place, deliberately: the
 * backend `/facets` surface and `FACETS_ENABLED` are untouched, and
 * `facet-consumption.ts`'s own docblock describes the future grid (`GET
 * /search` or `/catalog-pages`) that is meant to consume that rail. Deleting
 * the component now would make that future task rebuild it from nothing.
 *
 * ## The address is `/categories/:handle`, which is the registry's own pattern
 *
 * `PublicRouteId` already reserves `category_browse` for `/categories/:handle`
 * (#75), so this screen is the one that pattern was recorded for. The handle is
 * an id OR the current slug and both resolve, which is what keeps a link
 * working across a rename — a slug is presentation and identity is an id
 * (ADR 0007 D1).
 *
 * The discovery feed's category scope resolves by SLUG alone
 * (`findActiveCategoryBySlug`, `services/discovery/feed.service.ts`), so this
 * screen fetches it on `category.slug` once the v1 tree has resolved `handle`
 * — never the raw route param — to keep an id-based link working. Until the
 * tree resolves, the raw `handle` is used as a best guess (correct whenever
 * `handle` already IS the slug, which is the common case); an id-based visit
 * self-corrects to the right fetch the moment the tree answers.
 *
 * ## A deprecated or localized slug is a REDIRECT, applied with `replace`
 *
 * `GET /seo/resolve` owns the redirect registry, so a withdrawn slug answers
 * `outcome: 'redirect'` and this page moves to the canonical address. `replace`
 * and never `push`: the requested address was a redirect, and putting it in the
 * history would let the back button walk into it again. This is the client half;
 * the HTTP 301 a crawler needs is #75's.
 *
 * ## There is no category-specific anything in this file
 *
 * No filter list, no spec list, no controlled value and no branch on a category
 * id. `scripts/validate-storefront-catalog-driven.mjs` fails the build if one
 * appears here or anywhere else under `packages/frontend`.
 */
export default function CategoryScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ handle: string }>();
  const handle = params.handle ?? '';

  const tree = useCategoryTree();
  const category = useMemo(
    () => (tree.data === undefined ? undefined : findCategoryByHandle(tree.data, handle)),
    [tree.data, handle],
  );

  const path = handle.length === 0 ? undefined : `/categories/${encodeURIComponent(handle)}`;
  const seo = useCatalogSeo(path);

  /**
   * A withdrawn or localized slug resolves to its live address.
   *
   * The registry answers with an absolute path; this navigates by the LAST
   * segment through the typed object form rather than pushing the raw string,
   * so a redirect to a pattern this app does not have fails to compile rather
   * than 404ing under a shopper's thumb.
   */
  const redirectTarget = seo.data?.redirect?.location;
  useEffect(() => {
    if (redirectTarget === undefined) return;
    const next = categoryHandleOfPath(redirectTarget);
    if (next === undefined || next === handle) return;
    router.replace(categoryHref(next));
  }, [redirectTarget, handle, router]);

  const feed = useDiscoveryFeed({ kind: 'category', handle: category?.slug ?? handle });

  const breadcrumbs = useMemo<readonly SeoBreadcrumb[]>(() => {
    const fromRegistry = seo.data?.document?.breadcrumbs;
    if (fromRegistry !== undefined && fromRegistry.length > 0) return fromRegistry;
    if (tree.data === undefined || category === undefined) return [];
    // The registry did not answer — the SEO surface is not mounted on this
    // deployment. The tree's own ancestry is the plainer trail, and it is the
    // one this page renders rather than none. See `lib/catalog/category-tree.ts`.
    return [
      ...categoryAncestors(tree.data, category.id).map((node) => ({
        name: node.name,
        path: `/categories/${node.slug}`,
      })),
      { name: category.name, path: `/categories/${category.slug}` },
    ];
  }, [seo.data, tree.data, category]);

  const title = category?.name ?? t('catalog.category.fallbackTitle');
  const document = seo.data?.document;
  const jsonLd = renderJsonLd(document?.structuredData ?? []);

  const head = (
    <Head>
      <title>{t('catalog.category.documentTitle', { title: document?.title ?? title })}</title>
      {document?.description === undefined ? null : (
        <meta name="description" content={document.description} />
      )}
      {/* The canonical URL and the alternates are the registry's. With the SEO
          surface unmounted neither tag is emitted, which leaves the address as
          its own canonical — what it in fact is — rather than asserting an
          indexing decision composed on the client. */}
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
      {/*
        The registry's own JSON-LD, composed from normalized facts and EMPTY
        whenever the document is not indexable (#75's contract). This renders
        it; it never composes one. See `lib/catalog/structured-data.ts` for why
        the escaping is not `JSON.stringify` alone.
      */}
      {jsonLd === undefined ? null : (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: jsonLd }}
        />
      )}
    </Head>
  );

  if (tree.isLoading && tree.data === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        {head}
        <Text className="px-8 py-16 text-body text-text-tertiary">{t('common.loading')}</Text>
      </ScreenShell>
    );
  }

  if (category === undefined) {
    return (
      <ScreenShell contentClassName="pt-6">
        {head}
        <View className="items-center justify-center px-8 py-16">
          <Text className="text-center text-body text-text-tertiary">
            {t('catalog.category.notFound')}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const sections = feed.data?.sections ?? [];

  return (
    <ScreenShell contentClassName="pt-6">
      {head}
      <View className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <CatalogBreadcrumbs crumbs={breadcrumbs} hrefForPath={categoryHrefForPath} />

        <Text className="text-header text-text md:text-posterXS" accessibilityRole="header">
          {category.name}
        </Text>

        {feed.isLoading && feed.data === undefined ? (
          <Text className="text-body text-text-tertiary">{t('common.loading')}</Text>
        ) : null}

        {!feed.isLoading && sections.length === 0 ? (
          <Text className="text-body text-text-tertiary">{t('discovery.signal.empty')}</Text>
        ) : null}

        <DiscoveryFeed sections={sections} />

        <Footer />
      </View>
    </ScreenShell>
  );
}

/**
 * The handle a `/categories/:handle` path names, or `undefined`.
 *
 * Deliberately narrow: it recognises exactly the one pattern this screen
 * serves and answers nothing for any other path, so a redirect pointing at a
 * brand or a product cannot be applied here as if it were a category. The page
 * then stays where it is, which is visible, rather than navigating somewhere
 * wrong, which is not.
 */
function categoryHandleOfPath(path: string): string | undefined {
  const withoutQuery = path.split('?')[0];
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== 'categories') return undefined;
  const handle = decodeURIComponent(segments[1]);
  return handle.length === 0 ? undefined : handle;
}

/** The `Href` for a registry breadcrumb path, when it names a category. */
function categoryHrefForPath(path: string): Href | undefined {
  const handle = categoryHandleOfPath(path);
  return handle === undefined ? undefined : categoryHref(handle);
}
