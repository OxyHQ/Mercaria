/**
 * Turning an interpretation draft into #94's constraint language.
 *
 * PURE: no database, no clock, no configuration. One function, and the shape of
 * what it produces is the point — it emits a `ConstraintSet`, which is the
 * SAME object a filter UI and #96's grounded comparison submit, so an
 * interpretation gets exactly the validation and evaluation a hand-built query
 * does. #94's own note says so: "the constraint schema is the seam: #95
 * produces a `ConstraintSet` and gets the same validation and evaluation search
 * does."
 *
 * ## There is no third strength, and this module cannot invent one
 *
 * A draft requirement carries `'hard' | 'preference'` and that value is copied
 * into the constraint at CONSTRUCTION, where #94 says strength is assigned. This
 * module takes no strength argument, has no branch that changes one, and
 * produces no function that converts between the two types — which is the third
 * of #94's four mechanisms surviving into the query-parsing layer rather than
 * stopping at its boundary.
 *
 * ## Explicit user filters are constraints too, and they are `user_explicit`
 *
 * #95 input 6 says the filters a shopper already selected in the UI ride along,
 * and #95 acceptance 3 says hard constraints are never silently weakened. Both
 * are satisfied by the same decision: a selected filter becomes a HARD
 * constraint with origin `user_explicit`, so an interpretation that "understood"
 * something looser cannot widen it — the two are separate members of one AND
 * set, and an AND of a shopper's bound with a looser one is the shopper's bound.
 */

import {
  ALL_CURRENCY_CODES,
  type CommercePredicate,
  type ConditionGroup,
  type ConstraintSet,
  type CurrencyCode,
  type IntentElementOrigin,
  type IntentPreferenceRanking,
  type ProductConstraint,
  type SearchFilters,
} from '@mercaria/shared-types';
import type { InterpretationDraft } from './deterministic.js';

/** What `buildConstraintSet` produces, beside the set itself. */
export interface BuiltConstraints {
  readonly set: ConstraintSet;
  /** Per-constraint provenance, so the paraphrase can use three voices. */
  readonly origins: Readonly<Record<string, IntentElementOrigin>>;
  /** Preferences in the order the shopper stated them. Ordinal, never a weight. */
  readonly preferenceRanking: readonly IntentPreferenceRanking[];
}

/** What the builder needs beyond the draft. */
export interface BuildConstraintsInput {
  readonly draft: InterpretationDraft;
  /** Brand ids the caller RESOLVED from the draft's mentions. Never a model's. */
  readonly brandIds: readonly string[];
  /** Merchant ids the caller RESOLVED. Never a model's. */
  readonly merchantIds: readonly string[];
  /** The category id the caller resolved from the slug, when one resolved. */
  readonly categoryId?: string;
  /** Filters the shopper selected in the UI (#95 input 6). */
  readonly selectedFilters?: SearchFilters;
}

/**
 * Build the #94 set.
 *
 * Every constraint gets a `scope`, and it is `product` for all of them. A
 * variant-scoped constraint means "this exact configuration must satisfy it",
 * and a natural-language query never says that: "a laptop with 16 GB" is
 * satisfied by a laptop that COMES IN a 16 GB configuration, which is precisely
 * what #94's product scope means. Emitting `variant` would silently exclude
 * every product whose 16 GB variant was not the one the search matched.
 */
export function buildConstraintSet(input: BuildConstraintsInput): BuiltConstraints {
  const constraints: ProductConstraint[] = [];
  const origins: Record<string, IntentElementOrigin> = {};
  const preferenceOrder: string[] = [];

  const push = (constraint: ProductConstraint, origin: IntentElementOrigin): void => {
    constraints.push(constraint);
    origins[constraint.id] = origin;
    if (constraint.strength === 'preference') preferenceOrder.push(constraint.id);
  };

  for (const requirement of input.draft.requirements) {
    push(
      {
        kind: 'attribute',
        id: requirement.id,
        scope: 'product',
        explanation: requirement.explanation,
        strength: requirement.strength,
        // `exclude_when_unknown` is #94's own default and is the right one for a
        // requirement a shopper STATED: they asked for at least 16 GB, and a
        // product whose memory nobody recorded has not been shown to have it.
        // The alternative admits the product with the requirement flagged
        // unknown, which is the right default for a filter UI offering a facet
        // and the wrong one for a sentence somebody typed.
        missingDataPolicy: 'exclude_when_unknown',
        attributeKey: requirement.attributeKey,
        definitionVersion: requirement.definitionVersion,
        predicate: requirement.predicate,
      },
      requirement.origin,
    );
  }

  if (input.draft.budget !== undefined) {
    const budget = input.draft.budget;
    const predicate = budgetPredicate(budget);
    if (predicate !== undefined) {
      push(
        {
          kind: 'commerce',
          id: 'budget',
          scope: 'product',
          explanation: describeBudget(budget),
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          predicate,
        },
        budget.origin,
      );
    }
  }

  const conditionGroups = mergeConditionGroups(
    input.draft.condition?.groups,
    input.selectedFilters?.conditionGroups,
  );
  if (conditionGroups !== undefined) {
    push(
      {
        kind: 'commerce',
        id: 'condition',
        scope: 'product',
        explanation: `Condition is ${conditionGroups.join(' or ')}`,
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'condition', op: 'in', values: [...conditionGroups] },
      },
      input.selectedFilters?.conditionGroups === undefined
        ? (input.draft.condition?.origin ?? 'deterministic_rule')
        : 'user_explicit',
    );
  }

  if (input.draft.officialChannelOnly === true || input.selectedFilters?.officialChannelOnly === true) {
    push(
      {
        kind: 'commerce',
        id: 'official-channel',
        scope: 'product',
        explanation: 'Sold by an official or authorized channel',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'official_channel', op: 'is', value: true },
      },
      input.selectedFilters?.officialChannelOnly === true ? 'user_explicit' : 'deterministic_rule',
    );
  }

  if (input.draft.nativeOnly === true) {
    push(
      {
        kind: 'commerce',
        id: 'offer-channel',
        scope: 'product',
        explanation: 'Can be bought on Mercaria',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'offer_channel', op: 'in', values: ['native'] },
      },
      'deterministic_rule',
    );
  }

  if (input.draft.availability !== undefined && input.draft.availability.length > 0) {
    push(
      {
        kind: 'commerce',
        id: 'availability',
        scope: 'product',
        explanation: 'Available to buy now',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        predicate: { facet: 'availability', op: 'in', values: [...input.draft.availability] },
      },
      'deterministic_rule',
    );
  }

  // Taxonomy: ids only, and every one of them was resolved by the caller
  // against Mercaria's own tables. A model's `entityMentions` reach this point
  // only through that resolution, which is #95 model-boundary rule 5 as a
  // property of the call graph rather than as a check.
  const brandIds = dedupe([...input.brandIds, ...(input.selectedFilters?.brandIds ?? [])]);
  if (brandIds.length > 0) {
    push(
      {
        kind: 'taxonomy',
        id: 'brand',
        scope: 'product',
        explanation: 'From the brand you named',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        subject: 'brand',
        op: 'in',
        ids: brandIds,
      },
      input.selectedFilters?.brandIds === undefined ? 'deterministic_rule' : 'user_explicit',
    );
  }

  const merchantIds = dedupe([...input.merchantIds, ...(input.selectedFilters?.merchantIds ?? [])]);
  if (merchantIds.length > 0) {
    push(
      {
        kind: 'taxonomy',
        id: 'merchant',
        scope: 'product',
        explanation: 'Sold by the seller you named',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        subject: 'merchant',
        op: 'in',
        ids: merchantIds,
      },
      input.selectedFilters?.merchantIds === undefined ? 'deterministic_rule' : 'user_explicit',
    );
  }

  if (input.categoryId !== undefined) {
    push(
      {
        kind: 'taxonomy',
        id: 'category',
        scope: 'product',
        explanation: 'In the category we understood',
        strength: 'hard',
        missingDataPolicy: 'exclude_when_unknown',
        subject: 'category',
        op: 'in',
        ids: [input.categoryId],
        includeDescendants: true,
      },
      input.draft.categorySlug === undefined ? 'user_explicit' : 'deterministic_rule',
    );
  }

  if (input.selectedFilters?.price !== undefined && input.draft.budget === undefined) {
    const price = input.selectedFilters.price;
    // A selected filter's currency is a wire `string` (#70's own type), so it is
    // MEMBERSHIP-tested rather than asserted: a code outside Mercaria's
    // presentment set produces no constraint at all, which is the fail-closed
    // direction — a price bound whose currency nobody can convert would
    // otherwise compare raw minor units across currencies.
    const currency = ALL_CURRENCY_CODES.find((code) => code === price.currency.toUpperCase());
    const predicate =
      currency === undefined
        ? undefined
        : budgetPredicate({
            basis: 'item_price',
            currency,
            ...(price.minMinor === undefined ? {} : { minMinor: price.minMinor }),
            ...(price.maxMinor === undefined ? {} : { maxMinor: price.maxMinor }),
          });
    if (predicate !== undefined) {
      push(
        {
          kind: 'commerce',
          id: 'selected-price',
          scope: 'product',
          explanation: 'Within the price range you selected',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          predicate,
        },
        'user_explicit',
      );
    }
  }

  return {
    set: { constraints },
    origins,
    // A DENSE, CONTIGUOUS rank in the order the constraints were built, which is
    // the order the phrases appear in the query. That is the only ordering
    // information a query actually carries — a shopper who says "cheap and light,
    // mostly light" has not given a number, and inventing one would be the weight
    // this domain must not produce.
    preferenceRanking: preferenceOrder.map((constraintId, index) => ({
      constraintId,
      rank: index + 1,
      origin: origins[constraintId] ?? 'deterministic_rule',
    })),
  };
}

/**
 * The #94 predicate for a budget.
 *
 * `known_total` and `offer_price` are two different FACETS rather than a flag,
 * which is what makes "under 900 delivered" a genuinely different question at
 * evaluation time. A budget with neither bound produces nothing — it is not a
 * constraint, and emitting `lte undefined` would be one that admits everything.
 */
function budgetPredicate(budget: {
  basis: 'item_price' | 'known_total';
  currency: CurrencyCode;
  minMinor?: number;
  maxMinor?: number;
}): CommercePredicate | undefined {
  const facet = budget.basis === 'known_total' ? 'known_total' : 'offer_price';
  const currency = budget.currency;
  if (budget.maxMinor !== undefined && budget.minMinor !== undefined) {
    return {
      facet,
      op: 'between',
      currency,
      lower: { value: { type: 'money', amountMinor: budget.minMinor, currency }, inclusive: true },
      upper: { value: { type: 'money', amountMinor: budget.maxMinor, currency }, inclusive: true },
    };
  }
  if (budget.maxMinor !== undefined) {
    return { facet, op: 'lte', currency, amountMinor: budget.maxMinor };
  }
  if (budget.minMinor !== undefined) {
    return { facet, op: 'gte', currency, amountMinor: budget.minMinor };
  }
  return undefined;
}

/** One line describing a budget, composed here and never by a model. */
function describeBudget(budget: {
  basis: 'item_price' | 'known_total';
  currency: CurrencyCode;
  minMinor?: number;
  maxMinor?: number;
}): string {
  const what = budget.basis === 'known_total' ? 'total price including delivery' : 'price';
  if (budget.minMinor !== undefined && budget.maxMinor !== undefined) {
    return `A ${what} between ${budget.minMinor} and ${budget.maxMinor} minor units of ${budget.currency}`;
  }
  if (budget.maxMinor !== undefined) {
    return `A ${what} of at most ${budget.maxMinor} minor units of ${budget.currency}`;
  }
  return `A ${what} of at least ${budget.minMinor ?? 0} minor units of ${budget.currency}`;
}

/**
 * The INTERSECTION of what the shopper selected and what the query said.
 *
 * Intersection and not union, because both are requirements and an AND of two
 * requirements is the narrower one. An empty intersection means the two
 * genuinely conflict — a shopper who filtered to `new` and typed `segunda mano`
 * — and the SELECTED filter wins, because it is the one they can see and undo.
 */
function mergeConditionGroups(
  interpreted: readonly ConditionGroup[] | undefined,
  selected: readonly ConditionGroup[] | undefined,
): readonly ConditionGroup[] | undefined {
  if (selected === undefined) return interpreted;
  if (interpreted === undefined) return selected;
  const intersection = selected.filter((group) => interpreted.includes(group));
  return intersection.length > 0 ? intersection : selected;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
