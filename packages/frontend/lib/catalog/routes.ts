import type { Href } from 'expo-router';
import type { NavigationTarget } from '@mercaria/shared-types';

/**
 * The ONE place a catalog concept becomes a navigation target.
 *
 * ## Every target is the OBJECT form, and that is a gate, not a style
 *
 * `typedRoutes` does NOT check a template-literal navigation target — measured
 * on this batch and filed as #456. `` router.push(`/catgeories/${slug}`) ``
 * type-checks, ships, and dies under a shopper's thumb. The object form
 * (`{ pathname: '/categories/[handle]', params }`) is checked against the real
 * route tree, and it is also the shape `route-reachability.test.ts` reads as an
 * edge. Both properties come from the same decision, so every function here
 * returns an object and none composes a path by concatenation.
 *
 * ## A handle is an id OR a slug, and never a translated label
 *
 * ADR 0007 D1: a label is presentation and is never identity. `/categories/:handle`
 * resolves an id first (#75's `SeoRouteIdentity` is `handle` for exactly this
 * reason), so the id is always a legal spelling and a slug is the pretty one.
 * Nothing here accepts a localized NAME, and there is no parameter it could be
 * passed as.
 *
 * ## Six of the seven navigation target kinds route; one does not
 *
 * {@link navigationTargetHref} returns `undefined` for `product_type`, because
 * the storefront has no product-type browse route and composing one would be a
 * dead link that type-checks. The menu renders such a node as plain text rather
 * than as a control that does nothing, which is the same decision `NAV_ITEMS`
 * already makes for an unbuilt screen.
 */

/** A category landing page, addressed by its id or its current slug. */
export function categoryHref(handle: string): Href {
  return { pathname: '/categories/[handle]', params: { handle } };
}

/** A brand page (#72). */
export function brandHref(handle: string): Href {
  return { pathname: '/brands/[handle]', params: { handle } };
}

/** A product family page (#72). */
export function productFamilyHref(handle: string): Href {
  return { pathname: '/families/[handle]', params: { handle } };
}

/**
 * Where a navigation node points, or `undefined` when the storefront has no
 * screen for that kind.
 *
 * A `campaign` node carries an EXTERNAL url and deliberately gets no `Href`
 * either: an external destination is not a route, and handing one to
 * `router.push` would either 404 or leave the app. The menu opens it with
 * `Linking` instead, which is a different act and reads as one.
 */
export function navigationTargetHref(target: NavigationTarget): Href | undefined {
  switch (target.kind) {
    case 'category':
      return categoryHref(target.categorySlug.length > 0 ? target.categorySlug : target.categoryId);
    case 'brand':
      return brandHref(target.brandSlug.length > 0 ? target.brandSlug : target.brandId);
    case 'product_family':
      return productFamilyHref(
        target.productFamilySlug.length > 0
          ? target.productFamilySlug
          : target.productFamilyId,
      );
    case 'saved_query':
      // A curated search is a search, and `/search` takes a term. A saved query
      // has FILTERS and no term, so there is nothing to hand it — routing one
      // to `/search` with an empty `q` would run a different query than the one
      // an operator curated. Named in `docs/storefront-catalog.md`.
      return undefined;
    case 'collection':
      // Merchandising stays separate from taxonomy (ADR 0007 D3) and has no
      // storefront route of its own yet.
      return undefined;
    case 'product_type':
      return undefined;
    case 'campaign':
      return undefined;
  }
}

/** The external address a `campaign` node points at, when it is one. */
export function navigationTargetExternalUrl(target: NavigationTarget): string | undefined {
  return target.kind === 'campaign' ? target.url : undefined;
}
