/**
 * What a price summary is ABOUT (#72 product-browse rule 3).
 *
 * A "from 320 €" that turns out to be a scratched used unit under a headline
 * about the new model is the single most misleading thing a catalogue page
 * does, so every price a card or a range carries states its condition coverage
 * beside it rather than leaving a reader to assume "new".
 *
 * PURE, over #90's condition SEGMENTS and never over a raw condition key —
 * filters, price history and price alerts all operate on the group for the
 * reason #90 gives: a key is a stored fact whose copy may change, and a segment
 * is what a shopper reasons about.
 *
 * `unknown` is its own answer and is not `mixed`. An offer whose source said
 * nothing about condition contributes no segment at all (#90: an unknown
 * condition is never asserted into one), so a set with no segments means
 * Mercaria does not know — which a page must say rather than print "new".
 */

import type { CatalogPriceConditionScope, ConditionGroup } from '@mercaria/shared-types';

/**
 * The segments that mean "not new".
 *
 * `open_box` and `refurbished` sit here rather than with `new` deliberately:
 * both are legitimate and neither is a sealed retail unit, and a range whose
 * bottom end is a refurbished unit described as "new" is exactly the claim this
 * function exists to stop.
 */
const NON_NEW_GROUPS: readonly ConditionGroup[] = ['open_box', 'refurbished', 'used', 'for_parts'];

/** The condition coverage of a set of segments. */
export function conditionScopeOf(
  groups: readonly ConditionGroup[],
): CatalogPriceConditionScope {
  if (groups.length === 0) return 'unknown';
  const hasNew = groups.includes('new');
  const hasOther = groups.some((group) => NON_NEW_GROUPS.includes(group));
  if (hasNew && hasOther) return 'mixed';
  if (hasNew) return 'new';
  if (hasOther) return 'used';
  return 'unknown';
}

/**
 * The coverage of a whole PAGE, from the coverage of each card.
 *
 * Not a second derivation: it folds the per-card answers, so a page can never
 * claim a narrower scope than one of its own cards. `unknown` anywhere makes
 * the whole thing `mixed` once anything else is known — a range that includes
 * a price of unstated condition is not a "new" range.
 */
export function foldConditionScopes(
  scopes: readonly CatalogPriceConditionScope[],
): CatalogPriceConditionScope {
  const known = scopes.filter((scope) => scope !== 'unknown');
  if (known.length === 0) return 'unknown';
  if (known.length !== scopes.length) return 'mixed';
  const distinct = new Set(known);
  if (distinct.size === 1) {
    const [only] = [...distinct];
    return only ?? 'unknown';
  }
  return 'mixed';
}
