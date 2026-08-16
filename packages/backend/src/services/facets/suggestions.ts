/**
 * What to tell a shopper whose filters left nothing (#367 Workstream 10).
 *
 * PURE, and the whole module is shaped by one requirement: an empty-state
 * suggestion must never SILENTLY RELAX A HARD CONSTRAINT.
 *
 * The tempting implementation is to notice the empty page, drop the requirement
 * that costs the most, and show those results with a note. It is tempting
 * because it always has something to show. It is wrong because the shopper asked
 * a question, the page answers a different one, and the note explaining that is
 * the part people do not read — so somebody who needs a 64 GB phone is shown 32
 * GB phones and buys one.
 *
 * The refusal is STRUCTURAL rather than remembered: {@link FacetSuggestion} has
 * no results member, so a suggestion cannot carry the products it would have
 * produced. Nothing in this domain can compute a page under a selection the
 * shopper did not make, because the only thing a suggestion can hold is a count
 * and the identity of what to drop. Applying it is a request the client makes
 * next, with the shopper having pressed something.
 *
 * `relaxesHardConstraint` rides along so a client can say so out loud before
 * they press it — a suggestion that drops a hard requirement is a bigger thing
 * than one that widens a price band, and the difference is a fact about the
 * requirement rather than about the copy.
 */

import type {
  FacetEmptyState,
  FacetEmptyStateReason,
  FacetOrigin,
  FacetSuggestion,
} from '@mercaria/shared-types';

/** One candidate relaxation, already measured by the caller. */
export interface MeasuredRelaxation {
  readonly facetKey: string;
  readonly origin: FacetOrigin;
  readonly valueKey?: string;
  /** Distinct products that would remain if this ONE selection were dropped. */
  readonly resultCount: number;
  readonly relaxesHardConstraint: boolean;
}

/** How many suggestions one empty state carries. */
export const FACET_MAX_SUGGESTIONS = 3;

/**
 * Compose the empty state.
 *
 * Suggestions that would still leave nothing are DROPPED. A control offering to
 * remove a filter and then showing an empty page twice is worse than no control,
 * and `resultCount > 0` is the only test that distinguishes them — which is why
 * the caller measures each candidate rather than guessing from the facet counts,
 * where a bucket's own count is taken with that facet lifted and therefore says
 * nothing about dropping a DIFFERENT one.
 *
 * Ordering is by how much each relaxation recovers, then by the stable key. Note
 * what is NOT an input: nothing about who sells the recovered products, what
 * they cost Mercaria or what anybody paid. A suggestion rail is a place a
 * commercial signal would be invisible, which is why the comparator has nowhere
 * to put one.
 */
export function composeEmptyState(
  reason: FacetEmptyStateReason,
  candidates: readonly MeasuredRelaxation[],
): FacetEmptyState {
  const useful = candidates
    .filter((candidate) => candidate.resultCount > 0)
    .sort((left, right) => {
      if (left.resultCount !== right.resultCount) return right.resultCount - left.resultCount;
      if (left.facetKey !== right.facetKey) return left.facetKey < right.facetKey ? -1 : 1;
      return (left.valueKey ?? '') < (right.valueKey ?? '') ? -1 : 1;
    })
    .slice(0, FACET_MAX_SUGGESTIONS);

  const suggestions: FacetSuggestion[] = useful.map((candidate) => ({
    facetKey: candidate.facetKey,
    origin: candidate.origin,
    ...(candidate.valueKey === undefined ? {} : { valueKey: candidate.valueKey }),
    resultCount: candidate.resultCount,
    relaxesHardConstraint: candidate.relaxesHardConstraint,
  }));

  return { reason, suggestions };
}

/**
 * Which empty state this is.
 *
 * Two reasons, and the difference is what a shopper should do next: an empty
 * SCOPE means there is nothing here whatever they filter by, so removing a chip
 * will not help; an empty SELECTION means the chips are the whole problem.
 * Collapsing them would send somebody to fiddle with filters in a category with
 * no products in it.
 */
export function emptyStateReason(scopeIsEmpty: boolean): FacetEmptyStateReason {
  return scopeIsEmpty ? 'no_products_in_scope' : 'selection_excludes_everything';
}
