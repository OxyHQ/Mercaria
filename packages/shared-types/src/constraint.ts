/**
 * The provider-neutral constraint language (#94 constraint schema).
 *
 * ONE schema, three consumers: deterministic filters and search today, grounded
 * comparison (#96) next, and natural-language interpretation (#95) after that.
 * They share this file rather than each parsing shopper intent into its own
 * shape, because the moment there are two shapes there are two answers to "was
 * this requirement satisfied", and the one a user is shown is whichever happened
 * to render.
 *
 * ## The distinction the whole file exists to make structural
 *
 * A HARD constraint excludes. A PREFERENCE ranks. #94's hard-constraint rule 4
 * says the system "cannot quietly downgrade a hard requirement to a preference
 * to produce more results", and that is a claim about what the code can express,
 * not about what its authors intend. Four mechanisms make it true here:
 *
 * 1. {@link ConstraintStrength} is assigned when a constraint is CONSTRUCTED and
 *    is a `readonly` literal field. Nothing in the evaluator takes a strength
 *    argument, so there is no parameter to pass the wrong value to.
 * 2. Validation partitions a set into {@link HardConstraint}[] and
 *    {@link PreferenceConstraint}[] — two genuinely different types. Moving a
 *    member between the lists is a compile error, not a policy violation.
 * 3. {@link TextPreference} is typed `strength: 'preference'` with no other
 *    inhabitant, so "the description must mention *gaming*" cannot be written as
 *    an exclusion rule at all (#94 constraint rule 7).
 * 4. The evaluator's verdict is DERIVED from the hard results alone and returned
 *    beside them, so a caller reading `verdict` and a caller reading the
 *    per-constraint outcomes cannot disagree.
 *
 * ## And the distinction it refuses to blur in the other direction
 *
 * A preference is never reported SATISFIED on missing data (#94 hard-constraint
 * rule 2). Absence evaluates to {@link ConstraintSatisfaction} `unknown` for both
 * strengths — the same code path, so there is no branch where "we do not know"
 * quietly becomes "yes" because nothing was riding on it.
 */

import type { CurrencyCode } from './money';
import type { AttributeComponentAxis } from './attribute-registry';

/** Whether an unsatisfied constraint EXCLUDES a candidate or merely ranks it. */
export type ConstraintStrength = 'hard' | 'preference';

export const CONSTRAINT_STRENGTHS: readonly ConstraintStrength[] = ['hard', 'preference'];

/**
 * Whether a constraint is asked of the PRODUCT or of one VARIANT
 * (#94 constraint rule 11).
 *
 * The distinction is load-bearing rather than cosmetic: a product-scoped
 * constraint is satisfied if ANY of its variants satisfies it, while a
 * variant-scoped one is asked of that variant and no other. Which is exactly
 * why "variant-specific facts cannot satisfy another variant's constraint"
 * (#94 acceptance 4) is a property of the evaluator's input, not of a filter
 * somebody remembered to apply: a variant evaluation is handed ONE variant's
 * facts, and a product evaluation reports WHICH variants qualified.
 */
export type ConstraintScope = 'product' | 'variant';

export const CONSTRAINT_SCOPES: readonly ConstraintScope[] = ['product', 'variant'];

/**
 * The outcome of one constraint against one candidate.
 *
 * Three values, never two. `unknown` is what missing data produces, and
 * collapsing it into `failed` would exclude every product whose feed happened
 * not to mention a spec, while collapsing it into `satisfied` would assert facts
 * nobody recorded. Which of those a HARD constraint does is the caller's named
 * policy ({@link MissingDataPolicy}); a preference does neither, and simply
 * scores nothing.
 */
export type ConstraintSatisfaction = 'satisfied' | 'failed' | 'unknown';

export const CONSTRAINT_SATISFACTIONS: readonly ConstraintSatisfaction[] = [
  'satisfied',
  'failed',
  'unknown',
];

/**
 * What a HARD constraint does when the fact it asks about is missing
 * (#94 hard-constraint rule 3: "fails or returns an explicit unknown state
 * according to a named policy").
 *
 * The policy is named per constraint rather than globally because the right
 * answer differs by question: "must be waterproof" on a product with no
 * waterproofing data should probably exclude, while "must have a headphone jack"
 * on a catalogue where that field is sparsely populated would exclude almost
 * everything. Both are defensible; neither may be silent.
 *
 * `admit_and_report_unknown` never reports the constraint SATISFIED — the
 * candidate is admitted with the requirement explicitly flagged unknown, which
 * is a different statement from a match.
 */
export type MissingDataPolicy = 'exclude_when_unknown' | 'admit_and_report_unknown';

export const MISSING_DATA_POLICIES: readonly MissingDataPolicy[] = [
  'exclude_when_unknown',
  'admit_and_report_unknown',
];

/**
 * A typed literal a constraint compares against.
 *
 * `money` carries minor units and a NAMED currency, never a decimal — the
 * `Money` domain rule (#94 normalization rule 9) applied to the query side, so a
 * "under 300" constraint cannot be evaluated against a price in another
 * currency by accident. `measurement` carries its unit for the same reason: a
 * bare `14` is not a screen size.
 */
export type ConstraintValue =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'integer'; readonly value: number }
  | { readonly type: 'decimal'; readonly value: number }
  | { readonly type: 'date'; readonly value: string }
  | { readonly type: 'money'; readonly amountMinor: number; readonly currency: CurrencyCode }
  | { readonly type: 'measurement'; readonly magnitude: number; readonly unit: string };

/** One end of a range, with its own strictness (#94 constraint rule 3). */
export interface RangeBound {
  readonly value: ConstraintValue;
  /** `true` for `<=` / `>=`; `false` for `<` / `>`. */
  readonly inclusive: boolean;
}

/** The comparison one attribute constraint performs. */
export type AttributePredicate =
  | { readonly op: 'eq'; readonly value: ConstraintValue }
  | { readonly op: 'ne'; readonly value: ConstraintValue }
  | { readonly op: 'gt'; readonly value: ConstraintValue }
  | { readonly op: 'gte'; readonly value: ConstraintValue }
  | { readonly op: 'lt'; readonly value: ConstraintValue }
  | { readonly op: 'lte'; readonly value: ConstraintValue }
  | { readonly op: 'between'; readonly lower: RangeBound; readonly upper: RangeBound }
  | { readonly op: 'in'; readonly values: readonly ConstraintValue[] }
  | { readonly op: 'not_in'; readonly values: readonly ConstraintValue[] }
  | { readonly op: 'exists' }
  | { readonly op: 'missing' }
  | { readonly op: 'is'; readonly value: boolean };

export type AttributeOperator = AttributePredicate['op'];

export const ATTRIBUTE_OPERATORS: readonly AttributeOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'exists',
  'missing',
  'is',
];

/** Fields common to every leaf constraint. */
interface ConstraintBase {
  /**
   * A stable machine id for THIS constraint within its set — what an explanation
   * cites and what a UI keys a chip on. Stable across evaluations of the same
   * set, so "which requirement failed" survives a re-run.
   */
  readonly id: string;
  readonly scope: ConstraintScope;
  /** One line a shopper reads. Composed at construction, never re-derived. */
  readonly explanation: string;
}

/** A requirement on one registry attribute (#94 constraint rules 1–6). */
export interface AttributeConstraint extends ConstraintBase {
  readonly kind: 'attribute';
  readonly strength: ConstraintStrength;
  readonly missingDataPolicy: MissingDataPolicy;
  readonly attributeKey: string;
  /**
   * The definition version this constraint was written against. A validated set
   * records it so an evaluation is reproducible: the same set against the same
   * facts under the same versions gives the same answer forever.
   */
  readonly definitionVersion: number;
  /** For a `structured` attribute, which component axis is constrained. */
  readonly axis?: AttributeComponentAxis;
  readonly predicate: AttributePredicate;
}

/** Which graph entity a taxonomy constraint names (#94 constraint rule 8). */
export type TaxonomySubject = 'category' | 'brand' | 'product_family' | 'merchant';

export const TAXONOMY_SUBJECTS: readonly TaxonomySubject[] = [
  'category',
  'brand',
  'product_family',
  'merchant',
];

/**
 * A requirement on the product's place in the graph.
 *
 * Ids, never names: "brand is Apple" resolves to a brand id before it becomes a
 * constraint, so nothing here can be satisfied by a name that merely looks like
 * one (the ADR 0002 D10 rule, carried into the query language).
 */
export interface TaxonomyConstraint extends ConstraintBase {
  readonly kind: 'taxonomy';
  readonly strength: ConstraintStrength;
  readonly missingDataPolicy: MissingDataPolicy;
  readonly subject: TaxonomySubject;
  readonly op: 'in' | 'not_in';
  readonly ids: readonly string[];
  /** Category constraints may cover a subtree; other subjects have no hierarchy. */
  readonly includeDescendants?: boolean;
}

/**
 * The commercial facts a constraint may ask about — every one of them answered
 * from CURRENT ELIGIBLE OFFERS and from nothing else (#94 hard-constraint
 * rule 6).
 *
 * `known_total` is deliberately separate from `offer_price`: "under 300
 * delivered" is a different question from "under 300 before shipping", and a
 * catalogue that cannot tell them apart will answer the wrong one. A total is
 * only KNOWN when every component of it is; an estimate never satisfies it.
 */
export type CommerceFacet =
  | 'offer_price'
  | 'known_total'
  | 'availability'
  | 'condition'
  | 'market'
  | 'official_channel'
  | 'offer_channel'
  | 'proximity';

export const COMMERCE_FACETS: readonly CommerceFacet[] = [
  'offer_price',
  'known_total',
  'availability',
  'condition',
  'market',
  'official_channel',
  'offer_channel',
  'proximity',
];

/** Whether an offer reaches Mercaria's own checkout or leaves for a third party. */
export type OfferChannelKind = 'native' | 'external';

export const OFFER_CHANNEL_KINDS: readonly OfferChannelKind[] = ['native', 'external'];

/** The comparison a commerce constraint performs, per facet. */
export type CommercePredicate =
  | {
      readonly facet: 'offer_price' | 'known_total';
      readonly op: 'lte' | 'lt' | 'gte' | 'gt' | 'between';
      readonly currency: CurrencyCode;
      readonly amountMinor?: number;
      readonly lower?: RangeBound;
      readonly upper?: RangeBound;
    }
  | { readonly facet: 'availability'; readonly op: 'in'; readonly values: readonly string[] }
  | { readonly facet: 'condition'; readonly op: 'in' | 'not_in'; readonly values: readonly string[] }
  | { readonly facet: 'market'; readonly op: 'in'; readonly territories: readonly string[] }
  | { readonly facet: 'official_channel'; readonly op: 'is'; readonly value: boolean }
  | {
      readonly facet: 'offer_channel';
      readonly op: 'in';
      readonly values: readonly OfferChannelKind[];
    }
  | {
      readonly facet: 'proximity';
      readonly op: 'within';
      readonly latitude: number;
      readonly longitude: number;
      readonly radiusMetres: number;
    };

/**
 * A requirement on the commercial terms currently available for a variant
 * (#94 constraint rules 9–10).
 *
 * SEPARATE from {@link AttributeConstraint} because its data source is separate:
 * these are answered by the offer port (#57) and by nothing in the attribute
 * tables. With no offer data, every one of them is `unknown` — never satisfied
 * from a static product field, which is the failure mode the split exists to
 * make impossible.
 */
export interface CommerceConstraint extends ConstraintBase {
  readonly kind: 'commerce';
  readonly strength: ConstraintStrength;
  readonly missingDataPolicy: MissingDataPolicy;
  readonly predicate: CommercePredicate;
}

/**
 * A textual leaning — ALWAYS a preference (#94 constraint rule 7).
 *
 * `strength` is the literal `'preference'` and has no other inhabitant, so a
 * hard text requirement is not something this schema can express. That is the
 * point: free text is the one input whose absence proves nothing, so excluding
 * on it would silently remove products whose sellers wrote a different word for
 * the same thing.
 */
export interface TextPreference extends ConstraintBase {
  readonly kind: 'text';
  readonly strength: 'preference';
  readonly query: string;
  readonly fields: readonly TextPreferenceField[];
}

export type TextPreferenceField = 'name' | 'description' | 'attribute_text';

export const TEXT_PREFERENCE_FIELDS: readonly TextPreferenceField[] = [
  'name',
  'description',
  'attribute_text',
];

/** A leaf constraint — anything that is not a group. */
export type LeafConstraint =
  | AttributeConstraint
  | TaxonomyConstraint
  | CommerceConstraint
  | TextPreference;

/**
 * A bounded OR group (#94 constraint rule 12).
 *
 * "USB-C or Thunderbolt" is a real requirement; "any of these forty things" is a
 * query that cannot be explained to a shopper or planned by a database. The
 * group therefore takes only LEAF members — the type admits no nested group — and
 * {@link MAX_OR_GROUP_MEMBERS} bounds its width. Together those make the
 * expression tree exactly two levels deep, always, which is what "carefully
 * bounded" has to mean if it is to be checkable rather than aspirational.
 *
 * A group's own `strength` governs the whole group: a HARD group is satisfied
 * when any member is, and a group whose members are all `unknown` is `unknown`.
 * Members do not carry independent strengths, because "either this hard thing or
 * that soft thing" has no coherent reading.
 */
export interface ConstraintGroup extends ConstraintBase {
  readonly kind: 'any_of';
  readonly strength: ConstraintStrength;
  readonly missingDataPolicy: MissingDataPolicy;
  readonly members: readonly LeafConstraint[];
}

/** Any constraint a set may contain. Top-level members are combined with AND. */
export type ProductConstraint = LeafConstraint | ConstraintGroup;

/**
 * The set as a caller submits it — AND across every member.
 *
 * There is no top-level OR and no NOT: `not_in` and `ne` cover negation at the
 * leaf, and a top-level disjunction is two searches. Both absences keep the set
 * explainable, which #94 requires of every constraint.
 */
export interface ConstraintSet {
  readonly constraints: readonly ProductConstraint[];
}

/** A constraint that excludes when unsatisfied. See the file header, point 2. */
export type HardConstraint = ProductConstraint & { readonly strength: 'hard' };

/** A constraint that only ranks. See the file header, point 2. */
export type PreferenceConstraint = ProductConstraint & { readonly strength: 'preference' };

/** The bounds that keep a set explainable and plannable. */
export const MAX_CONSTRAINTS_PER_SET = 32;
export const MAX_OR_GROUP_MEMBERS = 8;
export const MAX_OR_GROUPS_PER_SET = 4;
export const MAX_CONSTRAINT_VALUES_PER_OPERATOR = 32;

/**
 * The version of the evaluation RULES (#94 hard-constraint rule 8).
 *
 * Stamped on every explanation. Two evaluations that name the same version, over
 * the same facts at the same definition versions, are the same answer — which is
 * what makes a cached or re-rendered result trustworthy instead of merely
 * plausible.
 */
export const CONSTRAINT_EVALUATION_VERSION = 'ce-1';

/** Why a constraint set was refused before search (#94 hard-constraint rule 7). */
export type ConstraintValidationCode =
  | 'unknown_attribute'
  | 'attribute_not_in_category'
  | 'attribute_not_filterable'
  | 'attribute_not_hard_constraint_capable'
  | 'operator_not_supported_for_type'
  | 'value_type_mismatch'
  | 'unit_not_in_family'
  | 'unknown_unit'
  | 'currency_mismatch'
  | 'enum_value_not_allowed'
  | 'axis_not_declared'
  | 'range_bounds_inverted'
  | 'empty_value_list'
  | 'too_many_values'
  | 'too_many_constraints'
  | 'or_group_too_wide'
  | 'too_many_or_groups'
  | 'empty_or_group'
  | 'duplicate_constraint_id'
  | 'definition_retired'
  | 'offer_facts_unavailable'
  | 'reserved_offer_fact_key';

export const CONSTRAINT_VALIDATION_CODES: readonly ConstraintValidationCode[] = [
  'unknown_attribute',
  'attribute_not_in_category',
  'attribute_not_filterable',
  'attribute_not_hard_constraint_capable',
  'operator_not_supported_for_type',
  'value_type_mismatch',
  'unit_not_in_family',
  'unknown_unit',
  'currency_mismatch',
  'enum_value_not_allowed',
  'axis_not_declared',
  'range_bounds_inverted',
  'empty_value_list',
  'too_many_values',
  'too_many_constraints',
  'or_group_too_wide',
  'too_many_or_groups',
  'empty_or_group',
  'duplicate_constraint_id',
  'definition_retired',
  'offer_facts_unavailable',
  'reserved_offer_fact_key',
];

/** One reason a set was refused, naming the constraint it came from. */
export interface ConstraintValidationIssue {
  readonly constraintId: string;
  readonly code: ConstraintValidationCode;
  /** A sentence a shopper or an operator can act on. */
  readonly message: string;
}

/**
 * The result of validating a set before search (#94 API rule 3).
 *
 * A set is either valid — in which case it is partitioned into two typed lists
 * the evaluator consumes — or it is not, in which case it names every problem at
 * once rather than the first. A shopper who asked for three impossible things
 * should be told about three.
 */
export type ConstraintSetValidation =
  | {
      readonly valid: true;
      readonly set: ValidatedConstraintSet;
      /** Non-fatal notes: a deprecated definition, a preference nothing can score. */
      readonly warnings: readonly ConstraintValidationIssue[];
    }
  | { readonly valid: false; readonly issues: readonly ConstraintValidationIssue[] };

/**
 * A set that has been checked against the registry.
 *
 * The two lists are the mechanism, not a convenience: `hard` is typed
 * {@link HardConstraint}[] and `preferences` is typed
 * {@link PreferenceConstraint}[], so a downstream module cannot move a member
 * from one to the other without a compile error, and cannot construct the
 * validated set at all without going through the validator (the `brand` field is
 * unexported and unforgeable).
 */
export interface ValidatedConstraintSet {
  readonly hard: readonly HardConstraint[];
  readonly preferences: readonly PreferenceConstraint[];
  /** The evaluation ruleset these constraints were checked under. */
  readonly evaluationVersion: string;
  /** Attribute key → the definition version each constraint was bound to. */
  readonly definitionVersions: Readonly<Record<string, number>>;
  /** Set by the validator and by nothing else. */
  readonly brand: 'validated-constraint-set';
}

/** The outcome of ONE constraint against one candidate (#94 API rule 5). */
export interface ConstraintOutcome {
  readonly constraintId: string;
  readonly strength: ConstraintStrength;
  readonly satisfaction: ConstraintSatisfaction;
  /** The explanation the constraint carried, echoed so a UI needs one object. */
  readonly explanation: string;
  /**
   * Why the outcome is what it is, in one sentence — "16 GB ≥ 16 GB required",
   * "no recorded value for screen size". Composed from the facts actually read.
   */
  readonly reason: string;
  /** Whether a recorded observation backed the fact this outcome read. */
  readonly sourceBacked: boolean;
  /** For a product-scoped constraint: the variants that satisfied it. */
  readonly satisfyingVariantIds?: readonly string[];
}

/** Whether a candidate survives its hard constraints. */
export type ConstraintVerdict = 'included' | 'excluded';

/**
 * The complete, explainable answer for one candidate (#94 API rules 4–5).
 *
 * `verdict` is derived inside the evaluator from `hardOutcomes` alone and can
 * never disagree with them. `preferenceScore` counts only SATISFIED preferences,
 * so an unknown one contributes nothing and is never presentable as a match.
 */
export interface ConstraintEvaluation {
  readonly entityKind: 'product' | 'variant';
  readonly entityId: string;
  readonly verdict: ConstraintVerdict;
  readonly hardOutcomes: readonly ConstraintOutcome[];
  readonly preferenceOutcomes: readonly ConstraintOutcome[];
  /** Satisfied preferences over total preferences, in [0, 1]. 1 when there are none. */
  readonly preferenceScore: number;
  readonly evaluationVersion: string;
  readonly normalizationRuleVersion: string;
}
