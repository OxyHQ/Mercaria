/**
 * The sort options a facet surface may offer, and the refusal of every other one
 * (#367 Workstream 10).
 *
 * PURE, and it does NOT sort anything. That is the design rather than an
 * omission: ordering results is #74's, behind its versioned policy, and a second
 * module that put products in an order would be a second ranking authority
 * arriving through the filter rail. What this domain owns is the CLOSED SET of
 * keys a client may ask for and the validation that refuses everything else.
 *
 * `resolveFacetSort` therefore returns a {@link FacetSortDirective} — a key, a
 * direction and a mandatory tiebreak — for whoever lists the products. The
 * tiebreak is not optional and has one member, because a sort on a value many
 * products share is not a total order, and a keyset page over a non-total order
 * repeats and drops rows silently.
 *
 * ## Only what the metadata says is sortable
 *
 * `attribute_definitions.sortable` is #94's column and it is read, never
 * re-derived. An attribute that is `filterable` but not `sortable` produces a
 * facet and no sort option; asking for it is `not_sortable`, which is a
 * different refusal from `unknown_key` because they lead a client to opposite
 * fixes.
 */

import type {
  FacetOrigin,
  FacetSortOption,
  FacetSortResolution,
  MissingDataPolicy,
} from '@mercaria/shared-types';
import type { FacetLabel } from '@mercaria/shared-types';

/**
 * Commerce dimensions that may order a result set.
 *
 * ONE member. Price is a magnitude every offer publishes and "cheapest first" is
 * a question with an answer; availability, condition, market and channel are
 * categorical, and sorting by one means imposing an order on a set that has none
 * — which is a merchandising decision wearing a sort control's clothing.
 *
 * A price sort ALSO needs a currency and an FX pass to be meaningful across a
 * mixed-currency result set, which is why the directive names the key and the
 * reader owns the arithmetic. #74 already does this for the comparison surface.
 */
export const FACET_SORTABLE_COMMERCE_DIMENSIONS: readonly string[] = ['offer_price'];

/** What `buildSortOptions` needs to know about one attribute. */
export interface SortableAttribute {
  readonly key: string;
  readonly sortable: boolean;
  readonly label: FacetLabel;
  /** Present when the facet is suppressed — a withheld facet offers no sort. */
  readonly suppressed: boolean;
}

/**
 * Every sort a client may request, generated from metadata.
 *
 * A suppressed facet contributes nothing: offering "sort by screen size" for an
 * attribute the product type hides would expose the withheld field through the
 * ordering, which is the same disclosure by a different control.
 */
export function buildSortOptions(
  attributes: readonly SortableAttribute[],
  priceLabel: FacetLabel,
): FacetSortOption[] {
  const options: FacetSortOption[] = [];
  for (const dimension of FACET_SORTABLE_COMMERCE_DIMENSIONS) {
    options.push(
      { key: dimension, origin: 'commerce' as FacetOrigin, direction: 'asc', label: priceLabel },
      { key: dimension, origin: 'commerce' as FacetOrigin, direction: 'desc', label: priceLabel },
    );
  }
  for (const attribute of attributes) {
    if (!attribute.sortable || attribute.suppressed) continue;
    options.push(
      { key: attribute.key, origin: 'attribute', direction: 'asc', label: attribute.label },
      { key: attribute.key, origin: 'attribute', direction: 'desc', label: attribute.label },
    );
  }
  return options;
}

/**
 * Validate a requested sort against the options that were actually generated.
 *
 * Matching against the OPTIONS rather than against the definitions is what makes
 * the two agree by construction: a client can only ever be told to sort by
 * something the same response offered it, and a suppressed facet's sort is
 * refused for the same reason it was suppressed without that reason having to be
 * restated here.
 */
export function resolveFacetSort(
  requested: { readonly key: string; readonly direction: string } | undefined,
  options: readonly FacetSortOption[],
): FacetSortResolution | undefined {
  if (requested === undefined) return undefined;
  if (requested.direction !== 'asc' && requested.direction !== 'desc') {
    return { outcome: 'refused', refusal: 'unsupported_direction', key: requested.key };
  }
  const match = options.find(
    (option) => option.key === requested.key && option.direction === requested.direction,
  );
  if (match === undefined) {
    // `unknown_key` when nothing by that name was offered in either direction,
    // `not_sortable` when the key exists in the rail but carries no sort. The
    // caller supplies the second population; here the distinction is whether
    // ANY option shares the key.
    const known = options.some((option) => option.key === requested.key);
    return {
      outcome: 'refused',
      refusal: known ? 'not_sortable' : 'unknown_key',
      key: requested.key,
    };
  }
  return {
    outcome: 'resolved',
    directive: {
      key: match.key,
      origin: match.origin,
      direction: match.direction,
      tiebreak: 'canonical_product_id',
    },
  };
}

/**
 * A sort never relaxes the missing-data policy.
 *
 * Stated as a value so the isolation gate can assert it: sorting by an attribute
 * half the catalogue does not record must not quietly admit the other half at
 * the end of the list. Products excluded by a hard requirement stay excluded;
 * where an unexcluded product has no value, its POSITION is the reader's
 * decision and this domain expresses no opinion — which is why there is no
 * `nullsFirst` member on {@link FacetSortDirective}.
 */
export const FACET_SORT_MISSING_DATA_POLICY: MissingDataPolicy = 'exclude_when_unknown';
