import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { SearchFilters, ShoppingIntentResult } from '@mercaria/shared-types';
import { getLocales } from 'expo-localization';
import { interpretShoppingIntent, runCanonicalSearch } from '../api/search-intent';
import { queryKeys } from './query-keys';

/**
 * Natural-language search, as the storefront drives it (#95 "Client
 * experience").
 *
 * ## Two steps, and the shopper sees the first before paying for the second
 *
 * `interpret` is a MUTATION and `results` is a QUERY keyed on what the
 * interpretation produced. That split is what makes #95 client rules 2, 3 and 5
 * cheap: removing a chip changes the FILTERS, which re-runs the query and does
 * not re-parse; dismissing the interpretation drops it entirely and searches the
 * raw text; and the paraphrase renders as soon as the interpretation lands,
 * before any result has been fetched.
 *
 * ## Removing a chip narrows the plan and never widens it
 *
 * A removal drops the constraint from the LOCAL filter set only. It never asks
 * the server to re-interpret with the element excluded, because a re-parse
 * could resolve something else differently and the shopper would see a second
 * change they did not ask for. What they removed is what changes.
 */

/** What the screen holds while a shopper refines an interpretation. */
export interface SearchIntentState {
  readonly interpretation?: ShoppingIntentResult;
  /** The filters actually in force — the plan's, minus anything removed. */
  readonly filters: SearchFilters;
  /** Constraint ids the shopper has dropped. */
  readonly removed: readonly string[];
}

/** The locale the request is read under. The device's, never a guess. */
function deviceLocale(): string {
  const [locale] = getLocales();
  return locale?.languageTag ?? 'en-GB';
}

export function useSearchIntent() {
  const [term, setTerm] = useState('');
  const [state, setState] = useState<SearchIntentState>({ filters: {}, removed: [] });
  const [dismissed, setDismissed] = useState(false);

  const interpret = useMutation({
    mutationFn: (input: { query: string; sessionId?: string; answer?: { clarificationId: string; optionId: string } }) =>
      interpretShoppingIntent({
        query: input.query,
        locale: deviceLocale(),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.answer === undefined ? {} : { clarificationAnswer: input.answer }),
      }),
    onSuccess: (result) => {
      setState({ interpretation: result, filters: result.filters, removed: [] });
      setDismissed(false);
    },
  });

  /**
   * Drop one interpreted element.
   *
   * The filter set is rebuilt from the PLAN minus the removed ids rather than
   * mutated in place, so removing two chips and putting one back cannot leave a
   * filter nobody can see — the plan is the only source and the removal list is
   * the only diff.
   */
  const removeChip = useCallback((chipId: string) => {
    setState((previous) => {
      const plan = previous.interpretation;
      if (plan === undefined) return previous;
      const removed = previous.removed.includes(chipId)
        ? previous.removed
        : [...previous.removed, chipId];
      return { ...previous, removed, filters: filtersWithout(plan, removed) };
    });
  }, []);

  /** Drop the whole interpretation and search the raw text (#95 client rule 5). */
  const dismiss = useCallback(() => {
    setDismissed(true);
    setState({ filters: {}, removed: [] });
  }, []);

  const effectiveFilters = dismissed ? {} : state.filters;

  const results = useQuery({
    queryKey: queryKeys.searchIntent.results(term, effectiveFilters),
    queryFn: () => runCanonicalSearch(term, effectiveFilters),
    enabled: term.trim().length > 0,
    // A search whose canonical surface is not rolled out answers 404, and a
    // retry loop against a 404 is a client insisting a feature exists. One
    // attempt, and the screen says what happened.
    retry: false,
  });

  return useMemo(
    () => ({
      term,
      setTerm,
      interpret,
      interpretation: dismissed ? undefined : state.interpretation,
      removed: state.removed,
      removeChip,
      dismiss,
      results,
    }),
    [term, interpret, dismissed, state.interpretation, state.removed, removeChip, dismiss, results],
  );
}

/**
 * The plan's filters minus the elements a shopper removed.
 *
 * Keyed on the constraint ids the server assigned, which is why those ids are
 * stable within a set and why the interpretation reports an `enforcement` entry
 * per hard constraint: without them a client would have to guess which filter a
 * chip corresponded to, and the guess would be wrong for exactly the compound
 * cases (two attribute bounds on one key) that matter.
 */
function filtersWithout(plan: ShoppingIntentResult, removed: readonly string[]): SearchFilters {
  if (removed.length === 0) return plan.filters;
  const dropped = new Set(removed);
  const constraintById = new Map(
    plan.interpretation.constraints.constraints.map((constraint) => [constraint.id, constraint]),
  );

  // `SearchFilters` is `readonly` throughout — #70's wire contract — so the
  // surviving set is BUILT rather than pruned. A mutable copy plus `delete`
  // would need a writable clone of a type whose immutability is the point, and
  // rebuilding is what makes "removing two chips and putting one back" produce
  // exactly the plan minus one rather than whatever survived two mutations.
  const keeps = (id: string): boolean => !dropped.has(id);
  const commerceKept = (facet: string): boolean =>
    [...constraintById.values()].every(
      (constraint) =>
        constraint.kind !== 'commerce' ||
        constraint.predicate.facet !== facet ||
        keeps(constraint.id),
    );
  const taxonomyKept = (subject: string): boolean =>
    [...constraintById.values()].every(
      (constraint) =>
        constraint.kind !== 'taxonomy' || constraint.subject !== subject || keeps(constraint.id),
    );
  const droppedAttributeKeys = new Set(
    [...constraintById.values()]
      .filter((constraint) => constraint.kind === 'attribute' && dropped.has(constraint.id))
      .map((constraint) => (constraint.kind === 'attribute' ? constraint.attributeKey : '')),
  );

  const attributes = (plan.filters.attributes ?? []).filter(
    (attribute) => !droppedAttributeKeys.has(attribute.key),
  );

  return {
    ...(plan.filters.categorySlugs === undefined || !taxonomyKept('category')
      ? {}
      : { categorySlugs: plan.filters.categorySlugs }),
    ...(plan.filters.brandIds === undefined || !taxonomyKept('brand')
      ? {}
      : { brandIds: plan.filters.brandIds }),
    ...(plan.filters.merchantIds === undefined || !taxonomyKept('merchant')
      ? {}
      : { merchantIds: plan.filters.merchantIds }),
    ...(plan.filters.market === undefined || !commerceKept('market')
      ? {}
      : { market: plan.filters.market }),
    ...(plan.filters.price === undefined || !commerceKept('offer_price')
      ? {}
      : { price: plan.filters.price }),
    ...(plan.filters.conditionGroups === undefined || !commerceKept('condition')
      ? {}
      : { conditionGroups: plan.filters.conditionGroups }),
    ...(plan.filters.availability === undefined || !commerceKept('availability')
      ? {}
      : { availability: plan.filters.availability }),
    ...(plan.filters.offerKinds === undefined || !commerceKept('offer_channel')
      ? {}
      : { offerKinds: plan.filters.offerKinds }),
    ...(plan.filters.officialChannelOnly !== true || !commerceKept('official_channel')
      ? {}
      : { officialChannelOnly: true }),
    ...(attributes.length === 0 ? {} : { attributes }),
  };
}
