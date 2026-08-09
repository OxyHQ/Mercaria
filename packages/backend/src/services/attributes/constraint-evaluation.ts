/**
 * Deterministic, explainable evaluation of a validated constraint set
 * (#94 hard-constraints 1–8, API rules 4–5).
 *
 * The whole module is pure: it takes a {@link ValidatedConstraintSet}, a
 * candidate's FACTS, and returns an outcome per constraint plus a verdict
 * derived from the hard ones. No database access, no clock, no randomness — two
 * runs over the same inputs at the same `CONSTRAINT_EVALUATION_VERSION` are the
 * same answer, which is what makes rule 8 ("constraint evaluation is
 * deterministic and versioned") checkable rather than aspirational.
 *
 * ## The four properties this file exists to hold
 *
 * 1. **A hard constraint unsatisfied excludes.** `verdict` is computed from
 *    `hardOutcomes` alone, inside {@link evaluateCandidate}, and returned beside
 *    them. A caller cannot read one and not the other, and they cannot disagree.
 * 2. **A preference is never reported satisfied on missing data.** Absence
 *    produces `unknown` through the SAME code path for both strengths — there is
 *    no branch where a preference's missing fact is treated more generously
 *    because nothing was riding on it.
 * 3. **Missing data on a hard constraint follows a NAMED policy.**
 *    `exclude_when_unknown` (the default) excludes; `admit_and_report_unknown`
 *    admits with the requirement flagged `unknown` — and still never
 *    `satisfied`. Both are recorded in the outcome, so a UI can say which.
 * 4. **A variant-scoped fact cannot satisfy another variant's constraint**
 *    (#94 acceptance 4). Mechanically: {@link CandidateFacts} carries variant
 *    facts keyed BY VARIANT ID, and a variant-scoped evaluation is handed one
 *    variant's map. A product-scoped constraint reports WHICH variants satisfied
 *    it rather than collapsing them, so "some variant is 1 TB and some variant
 *    is black" can never read as "this variant is a black 1 TB".
 */

import {
  CONSTRAINT_EVALUATION_VERSION,
  NORMALIZATION_RULE_VERSION,
  type AttributeConstraint,
  type AttributePredicate,
  type CommerceConstraint,
  type ConstraintEvaluation,
  type ConstraintGroup,
  type ConstraintOutcome,
  type ConstraintSatisfaction,
  type ConstraintValue,
  type LeafConstraint,
  type ProductConstraint,
  type TaxonomyConstraint,
  type TextPreference,
  type ValidatedConstraintSet,
} from '@mercaria/shared-types';
import { BASE_UNITS, resolveUnit, toBaseUnit, unitFamilyOf } from '../canonical/units.js';
import type { EligibleOfferFacts } from './offer-facts.port.js';

/** One normalized fact a candidate carries, as the evaluator reads it. */
export interface EvaluableFact {
  readonly attributeKey: string;
  readonly definitionVersion: number;
  readonly normalizedText?: string;
  readonly normalizedNumber?: number;
  readonly normalizedNumberMax?: number;
  readonly rangeLowerInclusive?: boolean;
  readonly rangeUpperInclusive?: boolean;
  readonly normalizedBoolean?: boolean;
  readonly normalizedDate?: number;
  readonly normalizedAmountMinor?: number;
  readonly componentAxis?: string;
  /** Whether a recorded observation backs this fact. Always true today. */
  readonly sourceBacked: boolean;
}

/** Everything one candidate offers an evaluation, and nothing it does not. */
export interface CandidateFacts {
  readonly productId: string;
  /** Product-grain facts. A variant-scoped constraint never reads these. */
  readonly productFacts: readonly EvaluableFact[];
  /** Variant-grain facts, keyed by variant id. See property 4 in the header. */
  readonly variantFacts: ReadonlyMap<string, readonly EvaluableFact[]>;
  readonly categoryId?: string;
  /** The category and its ancestors, for a `includeDescendants` taxonomy match. */
  readonly categoryAncestorIds?: readonly string[];
  readonly brandId?: string;
  readonly productFamilyId?: string;
  /** Merchant ids with an eligible offer. Absent means unknown, not none. */
  readonly merchantIds?: readonly string[];
  /** Offer facts per variant, from the #57 port. Absent variant = no eligible offers. */
  readonly offerFacts: ReadonlyMap<string, EligibleOfferFacts>;
  /** Lower-cased searchable text, for a text preference. */
  readonly text?: { readonly name?: string; readonly description?: string };
}

export interface EvaluateOptions {
  /** Evaluate as ONE variant rather than as the product. */
  readonly variantId?: string;
}

/**
 * Evaluate a validated set against one candidate.
 *
 * @param options.variantId Present for a variant-scoped evaluation, in which
 *   case every variant-scoped constraint reads THAT variant's facts and no
 *   other's. Absent for a product-scoped evaluation, where a variant-scoped
 *   constraint is satisfied if ANY variant satisfies it — and says which.
 */
export function evaluateCandidate(
  set: ValidatedConstraintSet,
  facts: CandidateFacts,
  options: EvaluateOptions = {},
): ConstraintEvaluation {
  const hardOutcomes = set.hard.map((constraint) => evaluate(constraint, facts, options));
  const preferenceOutcomes = set.preferences.map((constraint) =>
    evaluate(constraint, facts, options),
  );

  // The verdict, derived from the hard outcomes and from nothing else. There is
  // deliberately no parameter that could relax this, and no caller-supplied
  // strength anywhere in the module.
  const verdict = hardOutcomes.some((outcome) => outcome.satisfaction === 'failed')
    ? 'excluded'
    : 'included';

  // Only SATISFIED preferences score. An `unknown` contributes nothing, which is
  // property 2: a preference on a fact nobody recorded cannot be presented as a
  // match, however many of them there are.
  const satisfied = preferenceOutcomes.filter(
    (outcome) => outcome.satisfaction === 'satisfied',
  ).length;

  return {
    entityKind: options.variantId === undefined ? 'product' : 'variant',
    entityId: options.variantId ?? facts.productId,
    verdict,
    hardOutcomes,
    preferenceOutcomes,
    preferenceScore:
      preferenceOutcomes.length === 0 ? 1 : satisfied / preferenceOutcomes.length,
    evaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
  };
}

function evaluate(
  constraint: ProductConstraint,
  facts: CandidateFacts,
  options: EvaluateOptions,
): ConstraintOutcome {
  if (constraint.kind === 'any_of') return evaluateGroup(constraint, facts, options);
  const outcome = evaluateLeaf(constraint, facts, options);
  // A text preference carries no missing-data policy because it has no use for
  // one: it is always a preference, and a preference's `unknown` stays unknown.
  if (constraint.kind === 'text') return outcome;
  return applyMissingDataPolicy(constraint, outcome);
}

/**
 * An "any of" group.
 *
 * Satisfied when any member is; failed only when EVERY member failed; unknown
 * otherwise. That middle case is the one worth stating: a group where one member
 * failed and another is unknown is `unknown`, not `failed`, because the unknown
 * member might have satisfied it. Collapsing it to `failed` would exclude a
 * product for a fact nobody recorded, which is precisely what the three-valued
 * outcome exists to prevent.
 */
function evaluateGroup(
  group: ConstraintGroup,
  facts: CandidateFacts,
  options: EvaluateOptions,
): ConstraintOutcome {
  const memberOutcomes = group.members.map((member) => evaluateLeaf(member, facts, options));
  const satisfaction: ConstraintSatisfaction = memberOutcomes.some(
    (outcome) => outcome.satisfaction === 'satisfied',
  )
    ? 'satisfied'
    : memberOutcomes.every((outcome) => outcome.satisfaction === 'failed')
      ? 'failed'
      : 'unknown';

  const base: ConstraintOutcome = {
    constraintId: group.id,
    strength: group.strength,
    satisfaction,
    explanation: group.explanation,
    reason:
      satisfaction === 'satisfied'
        ? `Satisfied by: ${memberOutcomes
            .filter((outcome) => outcome.satisfaction === 'satisfied')
            .map((outcome) => outcome.explanation)
            .join('; ')}.`
        : satisfaction === 'failed'
          ? 'None of the alternatives matched.'
          : 'No recorded value for one or more of the alternatives.',
    sourceBacked: memberOutcomes.some((outcome) => outcome.sourceBacked),
  };
  return applyMissingDataPolicy(group, base);
}

/**
 * Turn an `unknown` on a HARD constraint into the caller's named policy.
 *
 * A preference is untouched: `unknown` stays `unknown` and scores nothing. A
 * hard constraint under `exclude_when_unknown` becomes `failed` — and the reason
 * SAYS SO, naming the policy, so an explanation never reports "does not match"
 * where the truth is "we do not know".
 */
function applyMissingDataPolicy(
  constraint: Exclude<ProductConstraint, TextPreference>,
  outcome: ConstraintOutcome,
): ConstraintOutcome {
  if (outcome.satisfaction !== 'unknown') return outcome;
  if (constraint.strength !== 'hard') return outcome;
  if (constraint.missingDataPolicy !== 'exclude_when_unknown') return outcome;
  return {
    ...outcome,
    satisfaction: 'failed',
    reason: `${outcome.reason} Excluded because this requirement's missing-data policy is 'exclude_when_unknown'.`,
  };
}

function evaluateLeaf(
  leaf: LeafConstraint,
  facts: CandidateFacts,
  options: EvaluateOptions,
): ConstraintOutcome {
  switch (leaf.kind) {
    case 'attribute':
      return evaluateAttribute(leaf, facts, options);
    case 'taxonomy':
      return evaluateTaxonomy(leaf, facts);
    case 'commerce':
      return evaluateCommerce(leaf, facts, options);
    case 'text':
      return evaluateText(leaf, facts);
  }
}

function evaluateAttribute(
  constraint: AttributeConstraint,
  facts: CandidateFacts,
  options: EvaluateOptions,
): ConstraintOutcome {
  const base = {
    constraintId: constraint.id,
    strength: constraint.strength,
    explanation: constraint.explanation,
  };

  if (constraint.scope === 'variant') {
    const targets =
      options.variantId === undefined
        ? [...facts.variantFacts.entries()]
        : ([[options.variantId, facts.variantFacts.get(options.variantId) ?? []]] as const);

    const satisfying: string[] = [];
    let anySeen = false;
    let anySourceBacked = false;
    for (const [variantId, variantFacts] of targets) {
      const matched = matchAttribute(constraint, variantFacts);
      if (matched.satisfaction !== 'unknown') anySeen = true;
      if (matched.sourceBacked) anySourceBacked = true;
      if (matched.satisfaction === 'satisfied') satisfying.push(variantId);
    }

    if (satisfying.length > 0) {
      return {
        ...base,
        satisfaction: 'satisfied',
        reason: `Satisfied by ${satisfying.length} variant${satisfying.length === 1 ? '' : 's'}.`,
        sourceBacked: anySourceBacked,
        ...(options.variantId === undefined ? { satisfyingVariantIds: satisfying } : {}),
      };
    }
    return {
      ...base,
      satisfaction: anySeen ? 'failed' : 'unknown',
      reason: anySeen
        ? `No variant carries a value for '${constraint.attributeKey}' that matches.`
        : `No recorded value for '${constraint.attributeKey}' on any variant.`,
      sourceBacked: anySourceBacked,
    };
  }

  const matched = matchAttribute(constraint, facts.productFacts);
  return { ...base, ...matched };
}

/** The comparison itself, against one entity's facts. */
function matchAttribute(
  constraint: AttributeConstraint,
  facts: readonly EvaluableFact[],
): { satisfaction: ConstraintSatisfaction; reason: string; sourceBacked: boolean } {
  const relevant = facts.filter(
    (fact) =>
      fact.attributeKey === constraint.attributeKey &&
      (constraint.axis === undefined || fact.componentAxis === constraint.axis),
  );

  if (constraint.predicate.op === 'exists') {
    return {
      satisfaction: relevant.length > 0 ? 'satisfied' : 'failed',
      reason:
        relevant.length > 0
          ? `A value for '${constraint.attributeKey}' is recorded.`
          : `No value for '${constraint.attributeKey}' is recorded.`,
      sourceBacked: relevant.some((fact) => fact.sourceBacked),
    };
  }
  if (constraint.predicate.op === 'missing') {
    return {
      satisfaction: relevant.length === 0 ? 'satisfied' : 'failed',
      reason:
        relevant.length === 0
          ? `No value for '${constraint.attributeKey}' is recorded.`
          : `A value for '${constraint.attributeKey}' is recorded.`,
      sourceBacked: relevant.some((fact) => fact.sourceBacked),
    };
  }

  if (relevant.length === 0) {
    return {
      satisfaction: 'unknown',
      reason: `No recorded value for '${constraint.attributeKey}'.`,
      sourceBacked: false,
    };
  }

  // A `set` or `ordered_list` attribute has several facts; the constraint is
  // satisfied when ANY of them matches, which is what set membership means. A
  // NEGATIVE operator is the exception: `not_in` must hold for EVERY value, or
  // "no HDMI port" would be satisfied by a laptop that also has USB-C.
  const negative = constraint.predicate.op === 'ne' || constraint.predicate.op === 'not_in';
  const results = relevant.map((fact) => comparesTrue(constraint.predicate, fact));
  const satisfied = negative ? results.every(Boolean) : results.some(Boolean);

  return {
    satisfaction: satisfied ? 'satisfied' : 'failed',
    reason: satisfied
      ? `'${constraint.attributeKey}' matches (${describePredicate(constraint.predicate)}).`
      : `'${constraint.attributeKey}' does not match (${describePredicate(constraint.predicate)}).`,
    sourceBacked: relevant.some((fact) => fact.sourceBacked),
  };
}

/** One fact against one predicate. */
function comparesTrue(predicate: AttributePredicate, fact: EvaluableFact): boolean {
  switch (predicate.op) {
    case 'is':
      return fact.normalizedBoolean === predicate.value;
    case 'eq':
      return valueEquals(predicate.value, fact);
    case 'ne':
      return !valueEquals(predicate.value, fact);
    case 'in':
      return predicate.values.some((value) => valueEquals(value, fact));
    case 'not_in':
      return !predicate.values.some((value) => valueEquals(value, fact));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const bound = comparableOf(predicate.value);
      const actual = comparableFact(fact);
      if (bound === undefined || actual === undefined) return false;
      // A RANGE fact compares through the bound that could satisfy the
      // requirement: "at least 5" is met by a 5–7 range's UPPER end, and "at
      // most 5" by its LOWER end. Comparing a range's midpoint or either end
      // unconditionally answers the wrong question half the time.
      const side =
        predicate.op === 'gt' || predicate.op === 'gte'
          ? (fact.normalizedNumberMax ?? actual)
          : actual;
      switch (predicate.op) {
        case 'gt':
          return side > bound;
        case 'gte':
          return side >= bound;
        case 'lt':
          return side < bound;
        case 'lte':
          return side <= bound;
      }
      return false;
    }
    case 'between': {
      const lower = comparableOf(predicate.lower.value);
      const upper = comparableOf(predicate.upper.value);
      const actual = comparableFact(fact);
      if (lower === undefined || upper === undefined || actual === undefined) return false;
      const aboveLower = predicate.lower.inclusive ? actual >= lower : actual > lower;
      const belowUpper = predicate.upper.inclusive ? actual <= upper : actual < upper;
      return aboveLower && belowUpper;
    }
    case 'exists':
    case 'missing':
      return true;
  }
}

function valueEquals(value: ConstraintValue, fact: EvaluableFact): boolean {
  switch (value.type) {
    case 'boolean':
      return fact.normalizedBoolean === value.value;
    case 'string':
      return fact.normalizedText === value.value.trim().replace(/\s+/gu, ' ').toLowerCase();
    case 'integer':
    case 'decimal':
      return fact.normalizedNumber === value.value;
    case 'money':
      return fact.normalizedAmountMinor === value.amountMinor;
    case 'date':
      return fact.normalizedDate === Date.parse(value.value);
    case 'measurement': {
      const magnitude = baseMagnitudeOf(value.magnitude, value.unit);
      if (magnitude === undefined || fact.normalizedNumber === undefined) return false;
      // Equality on a converted magnitude at IEEE-754 exactness is a coin flip:
      // `1.1 in` and `2.794 cm` both mean 27.94 mm, and their two conversions
      // land on doubles that differ in the last bits (measured — the pair that
      // makes a strict and a loose reading disagree). The tolerance is half a
      // unit at the SIXTH decimal of the base unit, which is finer than any
      // source measures and coarser than float error.
      return Math.abs(fact.normalizedNumber - magnitude) <= 5e-7;
    }
  }
}

/** The single comparable number of a fact, whatever type it carries. */
function comparableFact(fact: EvaluableFact): number | undefined {
  return fact.normalizedNumber ?? fact.normalizedAmountMinor ?? fact.normalizedDate;
}

/** The single comparable number of a constraint literal. */
function comparableOf(value: ConstraintValue): number | undefined {
  switch (value.type) {
    case 'integer':
    case 'decimal':
      return value.value;
    case 'money':
      return value.amountMinor;
    case 'date':
      return Date.parse(value.value);
    case 'measurement':
      return baseMagnitudeOf(value.magnitude, value.unit);
    case 'string':
    case 'boolean':
      return undefined;
  }
}

function baseMagnitudeOf(magnitude: number, unit: string): number | undefined {
  const resolved = resolveUnit(unit);
  if (resolved === null) return undefined;
  const family = unitFamilyOf(resolved);
  if (family === null) return undefined;
  if (BASE_UNITS[family] === resolved) return magnitude;
  return toBaseUnit(magnitude, resolved) ?? undefined;
}

function evaluateTaxonomy(
  constraint: TaxonomyConstraint,
  facts: CandidateFacts,
): ConstraintOutcome {
  const base = {
    constraintId: constraint.id,
    strength: constraint.strength,
    explanation: constraint.explanation,
    sourceBacked: true,
  };

  const actual = taxonomyValues(constraint, facts);
  if (actual === undefined) {
    return {
      ...base,
      satisfaction: 'unknown',
      reason: `This product records no ${constraint.subject}.`,
      sourceBacked: false,
    };
  }

  const wanted = new Set(constraint.ids);
  const hit = actual.some((id) => wanted.has(id));
  const satisfied = constraint.op === 'in' ? hit : !hit;
  return {
    ...base,
    satisfaction: satisfied ? 'satisfied' : 'failed',
    reason: satisfied
      ? `The ${constraint.subject} requirement is met.`
      : `The ${constraint.subject} requirement is not met.`,
  };
}

/** The ids a candidate offers for one taxonomy subject, or `undefined` if none. */
function taxonomyValues(
  constraint: TaxonomyConstraint,
  facts: CandidateFacts,
): readonly string[] | undefined {
  switch (constraint.subject) {
    case 'category': {
      if (facts.categoryId === undefined) return undefined;
      // `includeDescendants` matches against the candidate's ANCESTRY, which is
      // the same walk the registry's category scope uses — a constraint on
      // "Electronics" must find a laptop three levels below it.
      return constraint.includeDescendants === true
        ? [facts.categoryId, ...(facts.categoryAncestorIds ?? [])]
        : [facts.categoryId];
    }
    case 'brand':
      return facts.brandId === undefined ? undefined : [facts.brandId];
    case 'product_family':
      return facts.productFamilyId === undefined ? undefined : [facts.productFamilyId];
    case 'merchant':
      return facts.merchantIds;
  }
}

/**
 * A commercial requirement, answered from the offer port and from NOTHING else.
 *
 * The absence of any attribute lookup in this function is the point. Every facet
 * below reads `facts.offerFacts`, which comes from #57; with no port registered
 * that map is empty, every facet is `unknown`, and a hard constraint's named
 * policy decides. There is no fallback to a product attribute, and the registry
 * refuses to define keys that would make one possible.
 */
function evaluateCommerce(
  constraint: CommerceConstraint,
  facts: CandidateFacts,
  options: EvaluateOptions,
): ConstraintOutcome {
  const base = {
    constraintId: constraint.id,
    strength: constraint.strength,
    explanation: constraint.explanation,
  };

  const relevant =
    options.variantId === undefined
      ? [...facts.offerFacts.values()]
      : [facts.offerFacts.get(options.variantId)].filter(
          (value): value is EligibleOfferFacts => value !== undefined,
        );

  if (relevant.length === 0) {
    return {
      ...base,
      satisfaction: 'unknown',
      reason: 'No eligible offers are recorded, so the commercial terms are unknown.',
      sourceBacked: false,
    };
  }

  const results = relevant.map((offer) => commerceSatisfaction(constraint, offer));
  const satisfaction: ConstraintSatisfaction = results.includes('satisfied')
    ? 'satisfied'
    : results.every((result) => result === 'failed')
      ? 'failed'
      : 'unknown';

  return {
    ...base,
    satisfaction,
    reason:
      satisfaction === 'satisfied'
        ? `An eligible offer meets the ${constraint.predicate.facet.replace(/_/gu, ' ')} requirement.`
        : satisfaction === 'failed'
          ? `No eligible offer meets the ${constraint.predicate.facet.replace(/_/gu, ' ')} requirement.`
          : `The ${constraint.predicate.facet.replace(/_/gu, ' ')} of the eligible offers is not recorded.`,
    sourceBacked: true,
  };
}

function commerceSatisfaction(
  constraint: CommerceConstraint,
  offer: EligibleOfferFacts,
): ConstraintSatisfaction {
  const predicate = constraint.predicate;
  switch (predicate.facet) {
    case 'offer_price':
    case 'known_total': {
      const amount =
        predicate.facet === 'offer_price' ? offer.lowestPriceMinor : offer.lowestKnownTotalMinor;
      if (amount === undefined || offer.currency === undefined) return 'unknown';
      // A price in another currency is UNKNOWN, never converted here: an FX
      // conversion inside an evaluator would pin a rate into a search result and
      // make the same query answer differently by the minute.
      if (offer.currency !== predicate.currency) return 'unknown';
      if (predicate.op === 'between') {
        const lower = predicate.lower;
        const upper = predicate.upper;
        if (lower === undefined || upper === undefined) return 'unknown';
        const low = lower.value.type === 'money' ? lower.value.amountMinor : undefined;
        const high = upper.value.type === 'money' ? upper.value.amountMinor : undefined;
        if (low === undefined || high === undefined) return 'unknown';
        const aboveLow = lower.inclusive ? amount >= low : amount > low;
        const belowHigh = upper.inclusive ? amount <= high : amount < high;
        return aboveLow && belowHigh ? 'satisfied' : 'failed';
      }
      if (predicate.amountMinor === undefined) return 'unknown';
      const bound = predicate.amountMinor;
      const held =
        predicate.op === 'lte'
          ? amount <= bound
          : predicate.op === 'lt'
            ? amount < bound
            : predicate.op === 'gte'
              ? amount >= bound
              : amount > bound;
      return held ? 'satisfied' : 'failed';
    }
    case 'availability': {
      if (offer.availability === undefined) return 'unknown';
      return predicate.values.some((value) => offer.availability?.includes(value))
        ? 'satisfied'
        : 'failed';
    }
    case 'condition': {
      if (offer.conditions === undefined) return 'unknown';
      const hit = predicate.values.some((value) => offer.conditions?.includes(value));
      return (predicate.op === 'in' ? hit : !hit) ? 'satisfied' : 'failed';
    }
    case 'market': {
      if (offer.territories === undefined) return 'unknown';
      return predicate.territories.some((territory) => offer.territories?.includes(territory))
        ? 'satisfied'
        : 'failed';
    }
    case 'official_channel': {
      if (offer.hasOfficialChannelOffer === undefined) return 'unknown';
      return offer.hasOfficialChannelOffer === predicate.value ? 'satisfied' : 'failed';
    }
    case 'offer_channel': {
      const wantsNative = predicate.values.includes('native');
      const wantsExternal = predicate.values.includes('external');
      if (wantsNative && offer.hasNativeOffer === true) return 'satisfied';
      if (wantsExternal && offer.hasExternalOffer === true) return 'satisfied';
      if (offer.hasNativeOffer === undefined && offer.hasExternalOffer === undefined) {
        return 'unknown';
      }
      return 'failed';
    }
    case 'proximity': {
      if (offer.nearestSellerMetres === undefined) return 'unknown';
      return offer.nearestSellerMetres <= predicate.radiusMetres ? 'satisfied' : 'failed';
    }
  }
}

/**
 * A text preference.
 *
 * Never a hard constraint — the type forbids it — and never `failed` on absent
 * text, because a product whose description nobody wrote has not failed to
 * mention anything. Missing text is `unknown` and scores nothing.
 */
function evaluateText(preference: TextPreference, facts: CandidateFacts): ConstraintOutcome {
  const base = {
    constraintId: preference.id,
    strength: preference.strength,
    explanation: preference.explanation,
  };
  const haystacks: string[] = [];
  if (preference.fields.includes('name') && facts.text?.name !== undefined) {
    haystacks.push(facts.text.name.toLowerCase());
  }
  if (preference.fields.includes('description') && facts.text?.description !== undefined) {
    haystacks.push(facts.text.description.toLowerCase());
  }
  if (preference.fields.includes('attribute_text')) {
    for (const fact of facts.productFacts) {
      if (fact.normalizedText !== undefined) haystacks.push(fact.normalizedText);
    }
    for (const variantFacts of facts.variantFacts.values()) {
      for (const fact of variantFacts) {
        if (fact.normalizedText !== undefined) haystacks.push(fact.normalizedText);
      }
    }
  }

  if (haystacks.length === 0) {
    return {
      ...base,
      satisfaction: 'unknown',
      reason: 'No text is recorded to match against.',
      sourceBacked: false,
    };
  }

  const needle = preference.query.trim().toLowerCase();
  const hit = haystacks.some((haystack) => haystack.includes(needle));
  return {
    ...base,
    satisfaction: hit ? 'satisfied' : 'failed',
    reason: hit ? `The text mentions '${preference.query}'.` : `The text does not mention '${preference.query}'.`,
    sourceBacked: true,
  };
}

/** A predicate rendered for a reason string. Short, and never a value dump. */
function describePredicate(predicate: AttributePredicate): string {
  switch (predicate.op) {
    case 'between':
      return `between ${renderValue(predicate.lower.value)}${predicate.lower.inclusive ? '' : ' exclusive'} and ${renderValue(predicate.upper.value)}${predicate.upper.inclusive ? '' : ' exclusive'}`;
    case 'in':
    case 'not_in':
      return `${predicate.op === 'in' ? 'one of' : 'none of'} ${predicate.values.length} value${predicate.values.length === 1 ? '' : 's'}`;
    case 'exists':
      return 'recorded';
    case 'missing':
      return 'not recorded';
    case 'is':
      return predicate.value ? 'required' : 'excluded';
    default:
      return `${predicate.op} ${renderValue(predicate.value)}`;
  }
}

function renderValue(value: ConstraintValue): string {
  switch (value.type) {
    case 'measurement':
      return `${value.magnitude} ${value.unit}`;
    case 'money':
      return `${value.amountMinor} ${value.currency} minor units`;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'date':
      return value.value;
    default:
      return String(value.value);
  }
}
