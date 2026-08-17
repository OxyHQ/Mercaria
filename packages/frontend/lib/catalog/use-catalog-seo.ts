import { useQuery } from '@tanstack/react-query';
import type { SeoDocument, SeoRedirect, SeoResolution } from '@mercaria/shared-types';
import { resolveSeoPath } from '@/lib/api/catalog-seo';
import { queryKeys } from '@/lib/hooks/query-keys';

/**
 * What this address resolves to: its canonical URL, its `hreflang` alternates,
 * its breadcrumbs, and whether it is a redirect (#75, consumed by #367
 * workstream 9).
 *
 * ## The storefront asks; it does not decide
 *
 * A deprecated category slug, a localized slug, a merged brand and a renamed
 * product all resolve through ONE registry, and it is server-side. Composing a
 * canonical URL or an alternates list here would be a second answer that
 * disagrees with the sitemap, the `robots` policy and the HTTP 301 the moment
 * any of them moves.
 *
 * ## Off is not an error, and the page renders anyway
 *
 * `SEO_ROUTES_ENABLED` defaults false, so this 404s on most deployments. The
 * hook then answers `undefined`, and a page emits its own title and NO canonical
 * tag and NO alternates. That is the honest degradation: an absent `rel=canonical`
 * leaves the address as its own canonical, which is what it in fact is, while a
 * client-composed one would assert an indexing decision nobody made.
 *
 * ## A redirect is applied by the CALLER, never here
 *
 * A hook that navigated would move the app from inside a render. The caller
 * reads {@link CatalogSeo.redirect} and does it with `replace`, so the address
 * that redirected does not enter the history for the back button to walk into
 * again — the mechanism `/p/[handle]` already uses for a merged product.
 */

/** Fifteen minutes. Route metadata changes when an operator publishes, not on a read. */
const SEO_STALE_TIME = 1000 * 60 * 15;

export interface CatalogSeo {
  readonly document?: SeoDocument;
  readonly redirect?: SeoRedirect;
  /** True when the registry says this address names nothing. */
  readonly notFound: boolean;
}

function toCatalogSeo(resolution: SeoResolution): CatalogSeo {
  switch (resolution.outcome) {
    case 'document':
      return { document: resolution.document, notFound: false };
    case 'redirect':
      return { redirect: resolution.redirect, notFound: false };
    case 'not_found':
      return { notFound: true };
    case 'no_document':
      // A real page Mercaria publishes no metadata for. Not a 404 and not a
      // document: the page renders exactly as it would with the lever off.
      return { notFound: false };
  }
}

export function useCatalogSeo(path: string | undefined): ReturnType<typeof useQuery<CatalogSeo>> {
  return useQuery<CatalogSeo>({
    queryKey: queryKeys.catalog.seoPath(path ?? ''),
    enabled: path !== undefined && path.length > 0,
    staleTime: SEO_STALE_TIME,
    retry: false,
    queryFn: async () => toCatalogSeo(await resolveSeoPath(path ?? '')),
  });
}
