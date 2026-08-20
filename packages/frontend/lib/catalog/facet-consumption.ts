import type { useListings } from '@/lib/hooks/use-listings';

/**
 * Whether the product grid a catalogue screen renders can ACT on a facet
 * selection (#637).
 *
 * ## The question this answers, and why it is not "is there a rail"
 *
 * `useFacets` already decides whether a rail EXISTS: `POST /facets` is behind
 * `FACETS_ENABLED`, a 404 leaves `data === undefined`, and a consumer renders
 * nothing. That is a fact about the SERVER.
 *
 * This is the other half and nothing was asking it: given that a rail exists,
 * can the grid underneath it do anything with what a shopper picks? A filter
 * control that re-counts itself and leaves the results identical is worse than
 * no control — there is no error and no empty state, because the grid was never
 * asked a different question.
 *
 * ## The category grid reads a DIFFERENT CATALOGUE from the rail above it
 *
 * The rail is generated from #94's attribute registry over the canonical graph
 * (`db/facets/facetRepository.ts` counts over `canonical_products`), scoped by
 * category id. The grid is `GET /listings` — the listing-first catalogue,
 * scoped by category slug. They answer questions about different sets of rows,
 * which is why this is not an omitted argument: there is no argument.
 *
 * ## Why the consumable PART of a selection is not wired up instead
 *
 * `FacetSelectionEntry` carries three origins and `ListingQuery` is not equally
 * blind to all of them — it has `category`, `minPrice`/`maxPrice`,
 * `conditionKeys`/`conditionGroups` and `inStock`, so the taxonomy entry and
 * some of the commerce dimensions could in principle be mapped onto it. Wiring
 * that subset was considered and rejected, for three reasons that compound:
 *
 * 1. The `attribute` origin — the whole reason this rail is generated from a
 *    registry — has nowhere to go, and `market` and `offer_channel` have none
 *    either. So the rail would stay part dead whatever happened.
 * 2. A shopper cannot tell which half is which. Buckets that filter and buckets
 *    that do not, rendered identically in one rail, is the same defect with a
 *    smaller blast radius rather than a fix.
 * 3. The counts would then disagree with the list, because they are counted over
 *    the canonical graph and the list comes from `listings`. That is exactly the
 *    contradiction #616 and #628 are open about on the HTTP surfaces; adding a
 *    third instance of it on a screen is how that gets worse.
 *
 * And the rail cannot be trimmed to its consumable origins on the client:
 * `FacetRail` composes, filters, orders and suppresses nothing by design, since
 * re-deciding any of it would be the per-category filter list #367 deletes.
 * So the honest unit is the whole rail, and the whole rail is unconsumable.
 *
 * ## What closing this looks like
 *
 * A grid whose query can carry an attribute filter — `GET /search` (#70) or the
 * `/catalog-pages` browse (#72), both of which already accept `attributes` and
 * both of which read the same canonical graph the rail counts over. When such a
 * grid renders here, {@link FacetSelectionConsumption} grows a `supported`
 * member and `mayOfferFacetRail` starts answering `true` for it, with no
 * condition on the screen to find and delete.
 *
 * Neither is wired here, and the reason is that both are gated by
 * `CANONICAL_READS` / `CANONICAL_PUBLIC_ROUTES_ENABLED` / `CANONICAL_SEARCH`,
 * which default OFF — so pointing this grid at one would trade a dead control
 * for an empty page on a default deployment. That is a rollout decision about
 * which catalogue the category page serves, not a repair to this rail.
 */

/** Why a grid cannot act on a facet selection. */
export type FacetSelectionUnsupportedReason = 'grid_query_carries_no_attribute_filter';

/**
 * A product grid's ability to act on a facet selection.
 *
 * ONE member and it is the unsupported one, so "this screen offers a working
 * filter rail" is unrepresentable rather than merely false today. That is the
 * shape `ProductSavePriceAlert` (#80) and `GuestSellerActivation` (#107) take,
 * for the same reason: a client renders nothing rather than a control claiming
 * an unbuilt capability exists.
 */
export type FacetSelectionConsumption = {
  readonly kind: 'unsupported';
  readonly reason: FacetSelectionUnsupportedReason;
};

/** Whether `Q` has anywhere to put an attribute filter. */
type CarriesAttributeFilter<Q> = 'attributes' extends keyof Q ? true : false;

/**
 * The query the category grid sends, read off `useListings` ITSELF rather than
 * restated — a local copy of that signature is a second representation that
 * goes stale in the silent direction.
 *
 * `import type` erases at compile time, so this costs the node test runner no
 * runtime import of react-query or the axios client.
 */
type ListingGridQuery = Parameters<typeof useListings>[0];

/**
 * `false`, CHECKED by the compiler rather than asserted in a comment.
 *
 * The annotation is derived from `ListingQuery`'s own shape, so teaching that
 * type an attribute filter turns it `true` and FAILS TO COMPILE here. That is
 * the whole job: the premise this module rests on cannot change without
 * breaking the build at the decision that depends on it.
 */
export const LISTING_GRID_CARRIES_ATTRIBUTE_FILTER: CarriesAttributeFilter<ListingGridQuery> =
  false;

/** What the category screen's grid can do with a facet selection. */
export function deriveCategoryGridFacetConsumption(): FacetSelectionConsumption {
  return { kind: 'unsupported', reason: 'grid_query_carries_no_attribute_filter' };
}

/**
 * May a screen offer a facet rail over this grid?
 *
 * Always `false` today, because `unsupported` is the only thing a
 * {@link FacetSelectionConsumption} can be. Written as a test on the
 * discriminant rather than a bare `return false` so that a `supported` member
 * added later turns the rail ON where it belongs, instead of leaving a literal
 * that has to be found and changed by somebody who already believes the rail
 * works.
 */
export function mayOfferFacetRail(consumption: FacetSelectionConsumption): boolean {
  return consumption.kind !== 'unsupported';
}
