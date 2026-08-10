/**
 * The comparison policy (#96) — what may be compared, in which direction, and
 * how far a search may go.
 *
 * A CODE constant and not a table, for the reason every other versioned policy
 * in this repository is one: the policy is a PROCEDURE, and a table would let
 * an operator publish a version whose rules nobody shipped. Changing any value
 * in this file means a new {@link COMPARISON_POLICY_VERSION} in the same change,
 * so an explanation logged under one version is reproducible forever.
 *
 * ## `not_comparable` is the DEFAULT, and that is the whole of rule 6
 *
 * "A larger number is not always better" (product-comparison rule 6) is not a
 * caveat to be handled — it is the normal case. #94's registry records what an
 * attribute MEANS (its type, its unit family, its base unit) and deliberately
 * records nothing about which direction a shopper prefers, because that is a
 * property of the CATEGORY: a lower weight is better for a laptop and worse for
 * a dumbbell, a longer cable is better in a living room and worse on a desk.
 *
 * So a direction is DECLARED, per attribute key, and only where it is genuinely
 * category-independent. Everything else compares fine and simply refuses to
 * call either value better — the shopper sees both numbers and decides. A
 * default of `higher_is_better` would announce that a heavier laptop and a
 * longer charging time are improvements, silently, on every row nobody
 * classified.
 *
 * The seam this leaves is named rather than hidden: a per-CATEGORY direction is
 * a column on #94's `attribute_definitions`, and whoever adds it replaces
 * {@link resolveComparisonDirection}'s body. Until then the honest answer for an
 * unclassified attribute is "these differ", not "this one wins".
 */

import type { ComparisonDirection } from '@mercaria/shared-types';

/**
 * One declared direction, with the reason it is safe to declare globally.
 *
 * The `because` field is not decoration: it is the review artefact. An entry
 * whose justification does not survive being written down does not belong in
 * this table, and the table is the only thing standing between a comparison and
 * a confident, wrong recommendation.
 */
export interface ComparisonDirectionRule {
  readonly attributeKey: string;
  readonly direction: Exclude<ComparisonDirection, 'not_comparable'>;
  readonly because: string;
}

/**
 * The attributes whose preferred direction does not depend on the category.
 *
 * Deliberately short. Every entry is a fact about the QUANTITY rather than
 * about a product: more warranty is more warranty whatever is under it, and a
 * device that consumes less power to do the same job consumes less power. An
 * attribute whose direction flips between two categories — weight, size,
 * capacity of a container, length of a cable — is deliberately ABSENT and
 * resolves to `not_comparable`.
 *
 * These keys are the #94 registry's own spelling convention (`^[a-z][a-z0-9_]*$`).
 * A key no deployment has defined simply never matches, which is why the table
 * can be shipped ahead of the registry rows it describes.
 */
export const COMPARISON_DIRECTION_RULES: readonly ComparisonDirectionRule[] = [
  {
    attributeKey: 'warranty_months',
    direction: 'higher_is_better',
    because: 'A longer warranty is strictly more cover, in every category that has one.',
  },
  {
    attributeKey: 'return_window_days',
    direction: 'higher_is_better',
    because: 'A longer return window is strictly more of the buyer’s own option.',
  },
  {
    attributeKey: 'battery_life_hours',
    direction: 'higher_is_better',
    because: 'More runtime for the same job is more runtime; nothing prefers less.',
  },
  {
    attributeKey: 'power_consumption',
    direction: 'lower_is_better',
    because: 'Less energy for the same job costs less to run, in every category.',
  },
  {
    attributeKey: 'charging_time',
    direction: 'lower_is_better',
    because: 'Waiting less to use the thing is the point of the number.',
  },
  {
    attributeKey: 'noise_level',
    direction: 'lower_is_better',
    because: 'A quieter appliance is quieter; a category that wants noise measures output, not this.',
  },
  {
    attributeKey: 'water_resistance_depth',
    direction: 'higher_is_better',
    because: 'More ingress protection is strictly more protection.',
  },
  {
    attributeKey: 'energy_efficiency_ratio',
    direction: 'higher_is_better',
    because: 'The ratio is output over input; more output per unit input is better by definition.',
  },
];

/**
 * The direction for one attribute key, or `not_comparable`.
 *
 * ONE lookup, and there is deliberately no `defaultDirection` parameter: an
 * optional default is what a caller in a hurry fills in with
 * `higher_is_better`, and the whole point of the table is that the fallback
 * cannot be chosen at the call site.
 */
export function resolveComparisonDirection(attributeKey: string): ComparisonDirection {
  const rule = COMPARISON_DIRECTION_RULES.find((entry) => entry.attributeKey === attributeKey);
  return rule === undefined ? 'not_comparable' : rule.direction;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The commerce rows                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The commerce facts the table carries as rows beside the registry attributes.
 *
 * They are ROWS rather than a separate structure because a shopper comparing
 * two phones reads "price" in the same column layout as "screen size", and two
 * layouts is two places a value can be rendered differently. They carry no
 * `definitionVersion`, which is how a reader tells a commerce row from a
 * registry one.
 *
 * Their directions are declared HERE and not in
 * {@link COMPARISON_DIRECTION_RULES}, because these are not attribute keys and
 * a registry attribute with one of these names is refused outright by #94's
 * `RESERVED_OFFER_FACT_KEYS`.
 */
export const COMMERCE_ROWS: readonly {
  readonly key: string;
  readonly label: string;
  readonly direction: ComparisonDirection;
}[] = [
  { key: 'offer_price', label: 'Lowest item price', direction: 'lower_is_better' },
  { key: 'known_total', label: 'Lowest known delivered total', direction: 'lower_is_better' },
  { key: 'availability', label: 'Availability', direction: 'not_comparable' },
  { key: 'condition', label: 'Condition', direction: 'not_comparable' },
  { key: 'delivery_days', label: 'Slowest quoted delivery', direction: 'lower_is_better' },
  { key: 'merchant_count', label: 'Merchants offering it', direction: 'not_comparable' },
  { key: 'official_channel', label: 'Sold by an official channel', direction: 'not_comparable' },
];

export const COMMERCE_ROW_KEYS: readonly string[] = COMMERCE_ROWS.map((row) => row.key);

/* ────────────────────────────────────────────────────────────────────────── */
/* Bounds                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How many products one comparison may hold.
 *
 * Eight, because a table wider than that is not readable on a phone and is not
 * summarizable in a paragraph — and because the explanation package is quadratic
 * in subjects once tradeoffs are enumerated.
 */
export const MAX_COMPARISON_SUBJECTS = 8;

/** How many lines one basket may request. */
export const MAX_BASKET_LINES = 40;

/** How many offers one line may contribute as candidates, after pruning. */
export const MAX_CANDIDATES_PER_LINE = 24;

/** How many offers the whole solve may consider, after pruning. */
export const MAX_BASKET_CANDIDATES = 400;

/**
 * The merchant count above which the exact search is abandoned.
 *
 * The exact algorithm enumerates merchant SUBSETS, so it is `O(2^M · L)`; at
 * `M = 14` and `L = 40` that is roughly 650 000 line evaluations, which is a
 * few tens of milliseconds and is the point at which the next doubling stops
 * being affordable. Above it the solver runs the greedy pass and reports
 * `approximate` with `merchant_limit_reached` — never silently.
 */
export const MAX_SOLVER_MERCHANTS = 14;

/**
 * The wall-clock budget one solve may spend, in milliseconds.
 *
 * Checked between merchant subsets rather than inside the inner loop: a budget
 * checked per line makes the clock read dominate the search, and a subset is
 * already the unit at which the search can stop with a consistent best-so-far.
 */
export const SOLVER_TIME_BUDGET_MS = 750;

/** How many sentences a generated summary may carry. */
export const MAX_EXPLANATION_SENTENCES = 6;

/** How many comparison points a generated explanation may carry. */
export const MAX_EXPLANATION_POINTS = 12;

/** How long any one generated sentence may be. */
export const MAX_EXPLANATION_SENTENCE_CHARS = 320;
