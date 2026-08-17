import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import type { FacetScope, FacetSelectionEntry, SeoBreadcrumb } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { CatalogBreadcrumbs } from '@/components/catalog/CatalogBreadcrumbs';
import { CategoryListingCard } from '@/components/catalog/CategoryListingCard';
import { FacetRail } from '@/components/catalog/FacetRail';
import { NavigationMenu } from '@/components/catalog/NavigationMenu';
import { useTranslation } from '@/lib/i18n';
import { useListings } from '@/lib/hooks/use-listings';
import { categoryHref } from '@/lib/catalog/routes';
import {
  categoryAncestors,
  findCategoryByHandle,
  useCategoryTree,
} from '@/lib/catalog/category-tree';
import {
  parseFacetSelection,
  serializeFacetSelection,
} from '@/lib/catalog/facet-selection';
import { renderJsonLd } from '@/lib/catalog/structured-data';
import { useCatalogSeo } from '@/lib/catalog/use-catalog-seo';
import { useFacets } from '@/lib/catalog/use-facets';

/**
 * A category landing page (#367 workstream 9 §"Categories and navigation").
 *
 * Four server surfaces compose it and this file composes none of them:
 *
 * | What | Where it comes from |
 * | --- | --- |
 * | identity, children | `GET /categories` — see `lib/catalog/category-tree.ts` for why |
 * | breadcrumbs, canonical URL, `hreflang`, redirects | `GET /seo/resolve` |
 * | the filter rail | `POST /facets`, scoped to this category |
 * | the products | `GET /listings?category=` |
 *
 * ## The address is `/categories/:handle`, which is the registry's own pattern
 *
 * `PublicRouteId` already reserves `category_browse` for `/categories/:handle`
 * (#75), so this screen is the one that pattern was recorded for. The handle is
 * an id OR the current slug and both resolve, which is what keeps a link
 * working across a rename — a slug is presentation and identity is an id
 * (ADR 0007 D1).
 *
 * ## A deprecated or localized slug is a REDIRECT, applied with `replace`
 *
 * `GET /seo/resolve` owns the redirect registry, so a withdrawn slug answers
 * `outcome: 'redirect'` and this page moves to the canonical address. `replace`
 * and never `push`: the requested address was a redirect, and putting it in the
 * history would let the back button walk into it again. This is the client half;
 * the HTTP 301 a crawler needs is #75's.
 *
 * ## The filter selection lives in the URL, in STABLE KEYS
 *
 * `?filters=` carries origins, facet keys and bucket keys — never a translated
 * word — so a shopper sharing a filtered category shares the same filter into
 * any language. `lib/catalog/facet-selection.ts` owns the grammar.
 *
 * ## There is no category-specific anything in this file
 *
 * No filter list, no spec list, no controlled value and no branch on a category
 * id. `scripts/validate-storefront-catalog-driven.mjs` fails the build if one
 * appears here or anywhere else under `packages/frontend`.
 */
/** How many listings one page of the grid asks for. */
const CATEGORY_PAGE_SIZE = 24;

export default function CategoryScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ handle: string; filters?: string | string[] }>();
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

  const selection = useMemo(
    () => parseFacetSelection(params.filters),
    [params.filters],
  );

  const scope = useMemo<FacetScope | undefined>(
    () => (category === undefined ? undefined : { kind: 'category', categoryId: category.id }),
    [category],
  );
  const facets = useFacets({ scope, selection: selection.entries });

  // Disabled until the category names its slug. An empty `ListingQuery` means
  // "every listing", not "nothing", so passing one while the taxonomy loads
  // would fetch the whole catalogue and discard it.
  const listings = useListings(
    category === undefined ? {} : { category: category.slug, limit: CATEGORY_PAGE_SIZE },
    { enabled: category !== undefined },
  );

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

  const onSelectionChange = (next: readonly FacetSelectionEntry[]) => {
    const serialized = serializeFacetSelection(next);
    router.setParams(serialized === undefined ? { filters: '' } : { filters: serialized });
  };

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

  const children = category.children ?? [];
  const products = listings.data?.data ?? [];

  return (
    <ScreenShell contentClassName="pt-6">
      {head}
      <View className="web:mx-auto web:w-full web:max-w-[1200px] gap-space-32 md:px-5">
        <CatalogBreadcrumbs crumbs={breadcrumbs} hrefForPath={categoryHrefForPath} />

        <Text className="text-titleMedium text-text" accessibilityRole="header">
          {category.name}
        </Text>

        {children.length > 0 ? (
          <NavigationMenu
            tree={{
              key: `children:${category.id}`,
              surface: 'category_tree',
              entries: children.map((child) => ({
                key: child.id,
                label: child.name,
                href: categoryHref(child.slug.length > 0 ? child.slug : child.id),
                children: [],
              })),
            }}
            accessibilityLabel={t('catalog.category.subcategories')}
          />
        ) : null}

        {selection.droppedEntryCount > 0 ? (
          <Text className="text-caption text-text-tertiary">
            {t('catalog.filters.droppedFromLink', { count: selection.droppedEntryCount })}
          </Text>
        ) : null}

        {facets.data === undefined ? null : (
          <FacetRail
            response={facets.data}
            selection={selection.entries}
            onSelectionChange={onSelectionChange}
          />
        )}

        {listings.isLoading && listings.data === undefined ? (
          <Text className="text-body text-text-tertiary">{t('common.loading')}</Text>
        ) : null}

        {!listings.isLoading && products.length === 0 ? (
          <Text className="text-body text-text-tertiary">{t('catalog.category.empty')}</Text>
        ) : null}

        <View className="flex-row flex-wrap gap-4">
          {products.map((listing) => (
            <View key={listing.id} className="w-40">
              <CategoryListingCard
                listing={listing}
                onPress={(listingId) =>
                  router.push({ pathname: '/products/[id]', params: { id: listingId } })
                }
              />
            </View>
          ))}
        </View>

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
