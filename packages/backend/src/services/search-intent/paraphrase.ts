/**
 * The understanding paraphrase — COMPOSED, never quoted (#95 output field 9,
 * clarification rule 6, client rule 8).
 *
 * PURE: no database, no clock, no configuration, no model.
 *
 * ## The sentence a shopper reads is Mercaria's, not the model's
 *
 * `ShoppingIntentResult` has no field a model's prose could occupy, and this
 * module is why: every line is rendered from the VALIDATED structure — a
 * constraint's own `explanation`, a budget's amount and currency, a condition
 * segment — after that structure has resolved against the registry. So the
 * paraphrase cannot describe a requirement that was not built, cannot name an
 * attribute that does not exist, and cannot be persuasive about a product,
 * because it has no product to be persuasive about. That is #95 client rule 8's
 * "never show model prose as a substitute for actual results", held by there
 * being no model prose anywhere in the response.
 *
 * ## Three voices, and the origin decides which
 *
 * `IntentElementOrigin` travels on every element precisely so this renderer can
 * distinguish them, which is clarification rule 6 ("never pretend a model
 * inference was explicitly stated by the user") made structural:
 *
 * - `user_explicit` — "You asked for …". The shopper's own words or their own
 *   filter selection.
 * - `deterministic_rule` — "We read … from your search". A rule fired on text
 *   they typed; attributable to them, but Mercaria did the reading.
 * - `model_inferred` — "We guessed …". Nobody said it.
 *
 * The `editable` flag follows the same fact rather than a second one: every line
 * a client may offer a one-tap removal for is one whose element the shopper can
 * drop without breaking the plan, which is every element except a filter they
 * selected themselves — that one they remove in the filter UI they set it in.
 */

import {
  CURRENCY_PRECISION,
  CURRENCY_SYMBOLS,
  type ConstraintSet,
  type CurrencyCode,
  type IntentBudget,
  type IntentElementOrigin,
  type IntentParaphraseLine,
  type IntentUnresolvedPhrase,
  type ProductConstraint,
  type ShoppingUseTag,
} from '@mercaria/shared-types';

/** What the renderer needs. Everything already validated. */
export interface ParaphraseInput {
  readonly searchText: string;
  readonly set: ConstraintSet;
  readonly origins: Readonly<Record<string, IntentElementOrigin>>;
  readonly budget?: IntentBudget;
  readonly useTags: readonly ShoppingUseTag[];
  readonly unresolved: readonly IntentUnresolvedPhrase[];
  readonly categoryName?: string;
}

/**
 * Render the paraphrase.
 *
 * ORDER is deliberate and is the order a shopper checks their own sentence in:
 * what is being looked for, then where (category), then the budget — the number
 * they will notice a mistake in fastest — then the hard requirements, then the
 * leanings, then what Mercaria could not use. Putting the unresolved list LAST
 * rather than hiding it is client rule 4's "highlight unsatisfied and unknown
 * requirements", brought forward to before the results are even fetched.
 */
export function composeParaphrase(input: ParaphraseInput): IntentParaphraseLine[] {
  const lines: IntentParaphraseLine[] = [];

  if (input.searchText.trim().length > 0) {
    lines.push({
      subjectId: 'search-text',
      origin: 'user_explicit',
      text: `Searching for “${input.searchText}”`,
      editable: true,
    });
  }

  if (input.categoryName !== undefined) {
    const origin = input.origins.category ?? 'deterministic_rule';
    lines.push({
      subjectId: 'category',
      origin,
      text: voiced(origin, `the category ${input.categoryName}`),
      editable: origin !== 'user_explicit',
    });
  }

  if (input.budget !== undefined) {
    lines.push({
      subjectId: 'budget',
      origin: input.budget.origin,
      text: voiced(input.budget.origin, describeBudget(input.budget)),
      editable: true,
    });
  }

  for (const constraint of input.set.constraints) {
    // The budget and the category already have their own lines above, rendered
    // from the richer objects. Rendering them twice from the constraint would
    // put "at most 90000 minor units of EUR" beside "under 900 €".
    if (constraint.id === 'budget' || constraint.id === 'category') continue;
    const origin = input.origins[constraint.id] ?? 'deterministic_rule';
    lines.push({
      subjectId: constraint.id,
      origin,
      text: voiced(origin, describeConstraint(constraint)),
      editable: origin !== 'user_explicit',
    });
  }

  for (const tag of input.useTags) {
    lines.push({
      subjectId: `use-${tag}`,
      origin: input.origins[`use-${tag}`] ?? 'deterministic_rule',
      text: voiced(
        input.origins[`use-${tag}`] ?? 'deterministic_rule',
        `that it is for ${tag.replace(/_/gu, ' ')}`,
      ),
      editable: true,
    });
  }

  for (const [index, entry] of input.unresolved.entries()) {
    lines.push({
      subjectId: entry.constraintId ?? `unresolved-${index}`,
      // An unresolved phrase is never a model inference — it is a piece of the
      // shopper's own text Mercaria could not use, so the voice is theirs and
      // the sentence says what happened to it.
      origin: 'user_explicit',
      text: entry.explanation,
      editable: false,
    });
  }

  return lines;
}

/**
 * Put a clause in the voice its origin earns.
 *
 * The three prefixes are the whole mechanism, and the middle one is the
 * interesting case: a deterministic rule reading `16 GB` out of a query the
 * shopper typed is neither their explicit statement nor a guess, and collapsing
 * it into either would be wrong in a way somebody would eventually complain
 * about — "I never said that" for the first, "I did say that" for the second.
 */
function voiced(origin: IntentElementOrigin, clause: string): string {
  if (origin === 'user_explicit') return `You asked for ${clause}`;
  if (origin === 'deterministic_rule') return `We read ${clause} from your search`;
  return `We guessed ${clause} — remove it if that is wrong`;
}

/** One clause for one constraint, from its own explanation. */
function describeConstraint(constraint: ProductConstraint): string {
  const suffix = constraint.strength === 'hard' ? '' : ' (a preference, not a requirement)';
  return `${constraint.explanation.toLowerCase()}${suffix}`;
}

/**
 * A budget, in the shopper's own currency and in major units.
 *
 * Rendered from minor units through `CURRENCY_PRECISION` rather than through an
 * `Intl.NumberFormat`, because the paraphrase must say EXACTLY what the
 * constraint holds: a formatter that rounds `1234567` JPY-style or groups
 * `90000` as `900.00` under a locale the request did not name would show a
 * number the search is not using. Grouping and locale-aware rendering belong to
 * the client, which knows the shopper's locale and has `formatMoney` for it.
 */
function describeBudget(budget: IntentBudget): string {
  const basis = budget.basis === 'known_total' ? 'delivered' : 'before delivery';
  const min = budget.minMinor === undefined ? undefined : major(budget.minMinor, budget.currency);
  const max = budget.maxMinor === undefined ? undefined : major(budget.maxMinor, budget.currency);
  if (min !== undefined && max !== undefined) {
    return `a price between ${min} and ${max}, ${basis}`;
  }
  if (max !== undefined) return `a price of at most ${max}, ${basis}`;
  return `a price of at least ${min ?? '0'}, ${basis}`;
}

/** Minor units rendered as major units with the currency's own symbol. */
function major(amountMinor: number, currency: CurrencyCode): string {
  const precision = CURRENCY_PRECISION[currency];
  return `${(amountMinor / 10 ** precision).toFixed(precision)} ${CURRENCY_SYMBOLS[currency]}`;
}
