/**
 * The normalized category-attribute registry (#94), extending the first cut #56
 * shipped rather than sitting beside it.
 *
 * #56 gave the catalogue an attribute registry with a stable key, a value type,
 * a unit family and a set of allowed enum values. That was enough to normalize a
 * variant axis. It is not enough to answer a shopper's question, because a
 * question carries requirements: *at least 16 GB of memory, 14 inches or
 * smaller, USB-C, not refurbished*. Answering one deterministically needs three
 * things #56 did not have — a definition that is VERSIONED (so an evaluation can
 * name the rules it ran under), a value that records WHICH definition version
 * and WHICH normalization rules produced it, and a constraint vocabulary
 * (`./constraint`) that both search and a later natural-language interpreter
 * read from the same schema.
 *
 * The tuples here are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is a code change plus an additive migration in the SAME pull
 * request: the TypeScript union widens immediately and the database CHECK does
 * not.
 *
 * ## What this vocabulary deliberately cannot express
 *
 * - **A markup on truth.** There is no "preferred source" ranking and no
 *   tie-break weight. Two equally-attested contradictory facts stay
 *   contradictory (`conflicting`) until a person decides, because the cost of
 *   guessing is a product page asserting a specification nobody published.
 * - **A hard requirement that a text match can satisfy.** `TextPreference` in
 *   `./constraint` is typed `strength: 'preference'`, so "must contain the word
 *   *gaming*" is unrepresentable as an exclusion rule.
 * - **A unit inferred from a bare number.** {@link AttributeNormalizationState}
 *   has `unparsed` and `unknown_unit` as first-class outcomes and only
 *   `normalized` may carry a magnitude at all.
 */

import type { CurrencyCode } from './money';
import type { SourceLinkMethod } from './provenance';

/**
 * How an attribute definition types its values.
 *
 * The #94 set, replacing #56's `text | number | boolean | enum | quantity` as a
 * clean cut rather than a widening — three of those five were ambiguous in a way
 * that mattered:
 *
 * - `number` could not say whether `8` and `8.0` were the same fact, so a
 *   "cores" attribute and a "screen size" attribute shared a comparison rule.
 *   `integer` and `decimal` are separate because their VALIDATION differs
 *   (an integer attribute rejects `8.5`) and their display precision differs.
 * - `quantity` is renamed `measurement`, the issue's word, and now covers the
 *   dimensionless families too (percentage, ratio, rating) — which is how
 *   "percentages, ratios and ratings are distinct types" is enforced: they are
 *   different {@link UnitFamily} members, and cross-family conversion is refused.
 * - `text` is renamed `string` for the same reason `quantity` moved: the
 *   registry's vocabulary is the issue's, not Postgres's.
 *
 * `money` exists so a price-shaped attribute (a manufacturer's suggested retail
 * price) stays in the `Money` domain — a named currency and minor units — rather
 * than becoming a generic decimal whose currency lives in a label. It is NOT the
 * path to an offer price: see {@link RESERVED_OFFER_FACT_KEYS}.
 *
 * `structured` is a value with named COMPONENTS — the shape a dimensions
 * attribute needs, where "155.6 x 71.5 x 8.25 mm" is three facts with an
 * explicit axis each, never one string whose axis order a reader has to guess.
 */
export type AttributeValueType =
  | 'boolean'
  | 'integer'
  | 'decimal'
  | 'string'
  | 'enum'
  | 'date'
  | 'money'
  | 'measurement'
  | 'structured';

export const ATTRIBUTE_VALUE_TYPES: readonly AttributeValueType[] = [
  'boolean',
  'integer',
  'decimal',
  'string',
  'enum',
  'date',
  'money',
  'measurement',
  'structured',
];

/**
 * How many values one entity may carry for one attribute (#94 registry rule 9).
 *
 * - `single` — one value. The overwhelming majority.
 * - `set` — an unordered collection ("ports: USB-C, HDMI, 3.5 mm"). Membership
 *   is the only question; order carries no information.
 * - `ordered_list` — order IS information (a `structured` dimensions attribute's
 *   axes; a colour gradient's stops).
 * - `range` — ONE value that is an interval, with independently inclusive or
 *   exclusive bounds ("operating temperature 0–35 °C", "5–7 business days").
 *   Deliberately not two attributes: a range compared against a point needs both
 *   bounds and their strictness together, and two columns in two rows can
 *   disagree about which is the lower.
 */
export type AttributeCardinality = 'single' | 'set' | 'ordered_list' | 'range';

export const ATTRIBUTE_CARDINALITIES: readonly AttributeCardinality[] = [
  'single',
  'set',
  'ordered_list',
  'range',
];

/**
 * The lifecycle of one attribute DEFINITION VERSION (#94 registry rule 12).
 *
 * The `fee_schedules` shape, applied to catalogue policy: a version is editable
 * only while `draft`; from `active` onward every semantic column is frozen by a
 * database trigger, and changing the meaning of an attribute means publishing a
 * NEW version. `deprecated` still resolves stored values (they cite their
 * version) but no longer accepts new assignments; `retired` accepts nothing and
 * is excluded from facets and from the definitions a category advertises.
 *
 * A stored VALUE is never rewritten by a definition change — it names the
 * version it was normalized under, which is what makes "definition changes can
 * trigger controlled re-normalization" a scheduled job rather than a silent
 * mutation.
 */
export type AttributeLifecycleState = 'draft' | 'active' | 'deprecated' | 'retired';

export const ATTRIBUTE_LIFECYCLE_STATES: readonly AttributeLifecycleState[] = [
  'draft',
  'active',
  'deprecated',
  'retired',
];

/**
 * The dimension a `measurement` attribute measures. Every family names ONE base
 * unit, and normalization stores the magnitude in that base — so two sources
 * saying "256 GB" and "0.256 TB" land on one number and compare.
 *
 * Conversion ACROSS families is refused, never approximated, which is what makes
 * the three dimensionless families below carry real meaning: a `percentage` is
 * not a `ratio` and neither is a `rating`, so no constraint can compare "85 %
 * screen-to-body" against a 4.5-star review score even though both are bare
 * numbers (#94 normalization rule 8).
 */
export type UnitFamily =
  | 'length'
  | 'mass'
  | 'volume'
  | 'digital_storage'
  | 'duration'
  | 'power'
  | 'energy'
  | 'frequency'
  | 'data_rate'
  | 'pixel_count'
  | 'luminance'
  | 'electric_charge'
  | 'count'
  | 'percentage'
  | 'ratio'
  | 'rating';

export const UNIT_FAMILIES: readonly UnitFamily[] = [
  'length',
  'mass',
  'volume',
  'digital_storage',
  'duration',
  'power',
  'energy',
  'frequency',
  'data_rate',
  'pixel_count',
  'luminance',
  'electric_charge',
  'count',
  'percentage',
  'ratio',
  'rating',
];

/**
 * The named component of a `structured` value (#94 normalization rule 7).
 *
 * A closed set rather than free text, because the whole point is that a reader
 * never has to guess which number was the width. A source that reports
 * "155.6 x 71.5 x 8.25 mm" without saying which axis is which produces three
 * `unparsed` source facts, not three guesses — the axis has to come from the
 * source's own labelling or from a per-source mapping.
 */
export type AttributeComponentAxis =
  | 'width'
  | 'height'
  | 'depth'
  | 'diagonal'
  | 'circumference';

export const ATTRIBUTE_COMPONENT_AXES: readonly AttributeComponentAxis[] = [
  'width',
  'height',
  'depth',
  'diagonal',
  'circumference',
];

/**
 * What happened when a source's display string was normalized.
 *
 * Only `normalized` may carry a normalized value at all — every other member is
 * the structural form of "unsupported or malformed values remain source facts
 * and do not become canonical constraints" (#94 normalization rule 10). A row
 * that could not be read keeps the source's own words and nothing else.
 *
 * The five refusals are deliberately distinguishable, because they call for
 * different work:
 *
 * - `unparsed` — the string is not a value of the declared type at all.
 * - `unknown_unit` — a number and a unit token were found and the token is not
 *   in the conversion table. A taxonomy gap somebody can close.
 * - `out_of_range` — a well-formed value the definition's validation rules
 *   refuse (a negative weight, a rating above its scale).
 * - `implausible` — a well-formed, in-range value that is almost certainly a
 *   source SCALE error (a 2 400 000 mm phone). Recorded, never selected, and
 *   routed to review; the distinction from `out_of_range` is that nothing here
 *   is definitionally impossible, only wildly unlikely.
 * - `marketing_claim` — the source's words are promotional language rather than
 *   a measurable fact, on an attribute declared `objective`. Refusing it is what
 *   stops "blazing fast" becoming a comparable specification.
 *
 * #56's `conflicting` member is NOT here: disagreement is a property of the
 * SELECTION between two well-normalized facts, not of either one's parse, and
 * conflating them made "we could not read it" and "two sources disagree"
 * indistinguishable in the one place an operator needs them apart. It moved to
 * {@link AttributeSelectionState}.
 */
export type AttributeNormalizationState =
  | 'normalized'
  | 'unknown_unit'
  | 'unparsed'
  | 'out_of_range'
  | 'implausible'
  | 'marketing_claim';

export const ATTRIBUTE_NORMALIZATION_STATES: readonly AttributeNormalizationState[] = [
  'normalized',
  'unknown_unit',
  'unparsed',
  'out_of_range',
  'implausible',
  'marketing_claim',
];

/**
 * Whether one recorded fact is the one Mercaria shows (#94 value rule 8).
 *
 * `conflicting` is a first-class state, not an error: when two comparably
 * attested sources disagree, NEITHER is selected and both say why. Contradictory
 * source facts are never erased because one value won a display slot.
 */
export type AttributeSelectionState =
  | 'selected'
  | 'candidate'
  | 'conflicting'
  | 'superseded'
  | 'rejected';

export const ATTRIBUTE_SELECTION_STATES: readonly AttributeSelectionState[] = [
  'selected',
  'candidate',
  'conflicting',
  'superseded',
  'rejected',
];

/**
 * How much independent backing a recorded fact has (#94 value rule 7).
 *
 * Distinct from `confidence`, which is one source's own estimate of itself.
 * `corroborated` means at least two INDEPENDENT source records normalized to the
 * same value; `operator_verified` means a person decided. Neither is derivable
 * from a confidence number, which is why both exist.
 */
export type AttributeVerificationState =
  | 'unverified'
  | 'corroborated'
  | 'operator_verified';

export const ATTRIBUTE_VERIFICATION_STATES: readonly AttributeVerificationState[] = [
  'unverified',
  'corroborated',
  'operator_verified',
];

/**
 * Whether an attribute's values may appear in ordinary public DTOs
 * (#94 registry rule 11, API rule 7).
 *
 * `operator_only` covers attributes that are useful for matching and meaningless
 * or misleading to a shopper (a source's internal grade code). Provenance detail
 * is NOT governed by this flag — it is never in a public DTO at all.
 */
export type AttributeDisplayPolicy = 'public' | 'operator_only';

export const ATTRIBUTE_DISPLAY_POLICIES: readonly AttributeDisplayPolicy[] = [
  'public',
  'operator_only',
];

/**
 * What evidence a value needs before it may be SELECTED (#94 registry rule 11,
 * coverage rule 6).
 *
 * - `source_required` — any recorded observation qualifies. The default, and the
 *   only honest one for a specification a manufacturer publishes once.
 * - `corroboration_required` — two independent sources must agree. For facts
 *   that sources routinely get wrong and shoppers routinely filter on.
 * - `operator_attested` — a person decides. For claims no automated source can
 *   settle.
 *
 * This is the "evidence policy" half of the marketing-claim rule: an attribute
 * that a source would love to assert about itself can be declared
 * `operator_attested`, so an ingested claim is recorded and never shown.
 */
export type AttributeEvidencePolicy =
  | 'source_required'
  | 'corroboration_required'
  | 'operator_attested';

export const ATTRIBUTE_EVIDENCE_POLICIES: readonly AttributeEvidencePolicy[] = [
  'source_required',
  'corroboration_required',
  'operator_attested',
];

/**
 * Whether an attribute states a measurable fact or an opinion
 * (#94 coverage rule 6).
 *
 * Only an `objective` attribute may be `hardConstraintCapable`, and only an
 * `objective` attribute runs the marketing-claim refusal — a `subjective`
 * definition (an editorial "style" tag) is allowed to contain adjectives,
 * because that is what it is for. The pairing is what stops the refusal being
 * either useless (never applied) or absurd (applied to a tagline field).
 */
export type AttributeObjectivity = 'objective' | 'subjective';

export const ATTRIBUTE_OBJECTIVITIES: readonly AttributeObjectivity[] = [
  'objective',
  'subjective',
];

/**
 * Attribute keys the registry REFUSES to define, because each names a fact that
 * belongs to a current eligible OFFER rather than to a product
 * (#94 hard-constraint rule 6).
 *
 * This is the structural half of "price, shipping and availability use current
 * eligible offers rather than static product attributes". Without it, a source
 * could assert `price` as a product attribute, a shopper's price constraint
 * would find it, and the answer would be a number from a feed nobody refreshed.
 * With it there is no such key to find: the constraint language routes every one
 * of these through {@link CommerceConstraint} in `./constraint`, whose only data
 * source is the offer port.
 *
 * The list is deliberately about MEANING, not spelling — `msrp` is absent
 * because a manufacturer's suggested price genuinely is a product fact, and a
 * `money`-typed attribute is the right home for it.
 */
export const RESERVED_OFFER_FACT_KEYS: readonly string[] = [
  'price',
  'sale_price',
  'list_price',
  'current_price',
  'total_price',
  'known_total',
  'availability',
  'in_stock',
  'stock',
  'stock_level',
  'inventory',
  'condition',
  'shipping_cost',
  'shipping_price',
  'delivery_cost',
  'delivery_days',
  'lead_time',
  'seller',
  'merchant',
  'offer_count',
];

/**
 * The version of the normalization RULES a stored value was produced under
 * (#94 value rule 10).
 *
 * Bumping it does not rewrite anything: it makes every value written before the
 * change identifiable, so a re-normalization pass can find exactly the rows that
 * need re-reading. `nr-1` was #56's implicit ruleset (quantity parsing and
 * lowercase folding); `nr-2` is this issue's, which adds typed parsing per value
 * type, enum alias resolution, range and component semantics, precision
 * preservation and plausibility refusal.
 */
export const NORMALIZATION_RULE_VERSION = 'nr-2';

/** One permitted value of an `enum` attribute, with its display label. */
export interface AttributeEnumValue {
  /** The canonical, normalized value stored and compared. */
  value: string;
  /** What a shopper reads. Changing it never moves a stored value. */
  label: string;
  position: number;
  /** Source spellings that resolve to this value, normalized for lookup. */
  aliases: string[];
}

/**
 * A localized label for an attribute or one of its enum values
 * (#94 registry rule 2).
 *
 * Labels live apart from the KEY on purpose: the stored key is what every value
 * cites, and it is guaranteed stable across every label change. That is the
 * whole of "stored keys remain stable when labels or descriptions change" —
 * there is no code path that writes a label into a value row.
 */
export interface AttributeLabel {
  /** BCP-47 tag. */
  locale: string;
  label: string;
  description?: string;
}

/**
 * The validation and precision rules one definition version imposes
 * (#94 registry rule 10).
 *
 * `decimalPlaces` is a DISPLAY and comparison precision, not a storage
 * truncation: a converted magnitude keeps its full value in the column and is
 * ROUNDED to this many places when rendered or compared for equality, which is
 * how "6.1 in" and "154.94 mm" compare equal at one decimal place without either
 * stored number being falsified. Absent means "as many places as the source
 * gave", which is the honest default for a value nobody has declared a precision
 * for.
 */
export interface AttributeValidationRules {
  /** Inclusive lower bound in the definition's base unit, when one applies. */
  minValue?: number;
  /** Inclusive upper bound in the definition's base unit, when one applies. */
  maxValue?: number;
  /** Significant decimal places after conversion. See the note above. */
  decimalPlaces?: number;
  /** Maximum characters a `string` value may carry before it is `out_of_range`. */
  maxLength?: number;
  /**
   * The magnitude beyond which a value is `implausible` rather than merely
   * large — the scale-error detector (#94 coverage rule 5). Separate from
   * `maxValue` because a scale error is not a definitional impossibility: a
   * 2 400 000 mm phone is a source that reported micrometres in a millimetre
   * field, and recording it as a refusal a person can see beats both storing it
   * and dropping it.
   */
  implausibleAbove?: number;
  /** The symmetric floor. A 0.0001 mm screen is the same mistake, downward. */
  implausibleBelow?: number;
}

/** One VERSION of one attribute definition — the registry #94 asks for. */
export interface AttributeDefinition {
  id: string;
  /** Stable machine key, `^[a-z][a-z0-9_]*$`. Never renamed; a rename is a new key. */
  key: string;
  /** Monotonic per key. A stored value cites the version it was read under. */
  version: number;
  lifecycleState: AttributeLifecycleState;
  /** The default-locale label. Localized labels are in {@link labels}. */
  label: string;
  description?: string;
  labels: AttributeLabel[];
  valueType: AttributeValueType;
  cardinality: AttributeCardinality;
  objectivity: AttributeObjectivity;
  /** Present exactly when `valueType` is `measurement`. */
  unitFamily?: UnitFamily;
  /** The unit normalized magnitudes are stored in. Present with `unitFamily`. */
  baseUnit?: string;
  /** Present exactly when `unitFamily` is `rating` — a 5-star scale is not a 10-point one. */
  ratingScaleMax?: number;
  /** Present exactly when `valueType` is `money` — a money attribute names ONE currency. */
  currency?: CurrencyCode;
  /** The permitted values and their aliases; empty for every non-`enum` type. */
  enumValues: AttributeEnumValue[];
  /** The axes a `structured` value carries, in order; empty otherwise. */
  componentAxes: AttributeComponentAxis[];
  validation: AttributeValidationRules;
  /** Whether an assignment of this attribute can distinguish two variants. */
  variantDefining: boolean;
  filterable: boolean;
  sortable: boolean;
  comparable: boolean;
  /** Whether a shopper's requirement on this attribute may EXCLUDE a product. */
  hardConstraintCapable: boolean;
  displayPolicy: AttributeDisplayPolicy;
  evidencePolicy: AttributeEvidencePolicy;
  /**
   * Category ids this version applies to, with their inheritance rule. EMPTY
   * means unscoped — the attribute applies anywhere. That is the opposite
   * reading from a procurement agreement's empty scope, and deliberately: a
   * scope NARROWS a definition that is otherwise general, while a grant that
   * names no destination grants none.
   */
  categoryScopes: AttributeCategoryScope[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  deprecatedAt?: string;
}

/**
 * One category this definition version applies to (#94 registry rule 4).
 *
 * `includeDescendants` is the INHERITANCE rule, stated per scope rather than
 * globally: "screen size" scoped to *Electronics* with descendants covers
 * laptops and phones without a row each, while "shoe width" scoped to *Shoes*
 * without descendants deliberately does not leak into *Shoe care*. A single
 * global policy would force one of the two to be wrong.
 */
export interface AttributeCategoryScope {
  categoryId: string;
  includeDescendants: boolean;
}

/**
 * One source-specific normalization mapping (#94 coverage rule 4).
 *
 * The answer to "does `16 GB` mean memory or storage": not inference, but a
 * recorded statement that THIS source's field `memory_size` is the attribute
 * `ram_capacity`, optionally with the unit the source omits. A source that
 * reports bare numbers is usable only through a mapping that names the unit,
 * which is exactly the shape of "never infer a unit from a number when the
 * source is genuinely ambiguous" — the unit comes from a human-recorded fact
 * about the FEED, never from the value.
 */
export interface AttributeSourceMapping {
  id: string;
  catalogSourceId: string;
  /** The field name as the source spells it. Matched case-insensitively. */
  sourceField: string;
  attributeKey: string;
  /** The unit this source's values are in when it omits one. */
  assumedUnit?: string;
  /** The component axis this field always carries, for a structured attribute. */
  componentAxis?: AttributeComponentAxis;
  /**
   * Category ids this mapping is scoped to; empty means every category the
   * attribute itself is scoped to. This is where "category rules decide whether
   * `16 GB` means memory or storage" is actually decided when one source reuses
   * a field name across categories.
   */
  categoryIds: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** Why a recorded value is waiting for a person (#94 coverage rule 2). */
export type AttributeReviewReason =
  | 'conflicting_sources'
  | 'implausible_value'
  | 'unknown_unit'
  | 'marketing_claim'
  | 'invalid_category_attribute'
  | 'definition_deprecated';

export const ATTRIBUTE_REVIEW_REASONS: readonly AttributeReviewReason[] = [
  'conflicting_sources',
  'implausible_value',
  'unknown_unit',
  'marketing_claim',
  'invalid_category_attribute',
  'definition_deprecated',
];

/** The lifecycle of one review-queue entry. */
export type AttributeReviewState = 'open' | 'resolved' | 'dismissed';

export const ATTRIBUTE_REVIEW_STATES: readonly AttributeReviewState[] = [
  'open',
  'resolved',
  'dismissed',
];

/**
 * Why a canonical entity needs re-indexing (#94 coverage rule 8).
 *
 * The queue exists because a definition change and a selection change both
 * invalidate whatever a search index believes, and neither of them touches the
 * product row a naive index watcher would be following.
 */
export type AttributeReindexReason =
  | 'selected_value_changed'
  | 'definition_published'
  | 'definition_deprecated'
  | 'normalization_rules_changed'
  | 'operator_correction';

export const ATTRIBUTE_REINDEX_REASONS: readonly AttributeReindexReason[] = [
  'selected_value_changed',
  'definition_published',
  'definition_deprecated',
  'normalization_rules_changed',
  'operator_correction',
];

/** Which canonical grain an attribute value annotates. */
export type AttributeEntityKind = 'product' | 'variant';

export const ATTRIBUTE_ENTITY_KINDS: readonly AttributeEntityKind[] = ['product', 'variant'];

/**
 * One recorded attribute fact, as an authorized caller sees it — the SOURCE
 * view (#94 value rules 1–10, API rule 2).
 *
 * Everything about where the fact came from lives here and nowhere else: the
 * ordinary public projection ({@link PublicAttributeValue}) carries the value
 * and the unit, and no provenance at all.
 */
export interface SourceAttributeValue {
  id: string;
  entityKind: AttributeEntityKind;
  entityId: string;
  attributeKey: string;
  /** The definition version this value was normalized under. */
  definitionVersion: number;
  normalizationState: AttributeNormalizationState;
  selectionState: AttributeSelectionState;
  verificationState: AttributeVerificationState;
  /** The source's own words, preserved verbatim whatever happened next. */
  sourceDisplayValue: string;
  /** The unit the source used, before conversion. */
  sourceUnit?: string;
  /** Present only when `normalizationState` is `normalized`. */
  normalizedText?: string;
  normalizedNumber?: number;
  /** The upper bound of a `range` value; the lower bound is `normalizedNumber`. */
  normalizedNumberMax?: number;
  rangeLowerInclusive?: boolean;
  rangeUpperInclusive?: boolean;
  normalizedUnit?: string;
  normalizedBoolean?: boolean;
  normalizedDate?: string;
  normalizedAmountMinor?: number;
  normalizedCurrency?: CurrencyCode;
  /** The named component of a `structured` value. */
  componentAxis?: AttributeComponentAxis;
  /** Position within a `set` or `ordered_list`; 0 for a single value. */
  position: number;
  /** BCP-47 tag when the value is locale-specific (a localized colour name). */
  locale?: string;
  sourceRecordId: string;
  observedAt: string;
  /** 0–1; absent for a deterministic or human assertion, which outranks numbers. */
  confidence?: number;
  method: SourceLinkMethod;
  normalizationRuleVersion: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One SELECTED attribute value, as an ordinary public DTO carries it
 * (#94 API rule 7).
 *
 * No source record, no confidence, no method, no normalization rule version —
 * enough context for a shopper to trust the number (its unit, and that Mercaria
 * has a source for it) and nothing that describes Mercaria's internal matching.
 */
export interface PublicAttributeValue {
  key: string;
  label: string;
  /** The value as a shopper reads it, in the display unit. */
  displayValue: string;
  valueType: AttributeValueType;
  normalizedNumber?: number;
  normalizedNumberMax?: number;
  normalizedUnit?: string;
  normalizedText?: string;
  normalizedBoolean?: boolean;
  normalizedDate?: string;
  normalizedAmountMinor?: number;
  normalizedCurrency?: CurrencyCode;
  componentAxis?: AttributeComponentAxis;
  position: number;
  /** Whether Mercaria has a recorded observation behind it. Always true today. */
  sourceBacked: boolean;
  verificationState: AttributeVerificationState;
}

/** One facet bucket, derived from the registry rather than from free text. */
export interface AttributeFacetBucket {
  /** The canonical value, or the base-unit magnitude rendered as text. */
  value: string;
  label: string;
  count: number;
}

/** One filter facet, for one attribute of one category (#94 API rule 6). */
export interface AttributeFacet {
  attributeKey: string;
  label: string;
  definitionVersion: number;
  valueType: AttributeValueType;
  cardinality: AttributeCardinality;
  unit?: string;
  sortable: boolean;
  hardConstraintCapable: boolean;
  buckets: AttributeFacetBucket[];
  /** The range facets a numeric attribute offers instead of buckets. */
  minValue?: number;
  maxValue?: number;
  /** Entities in scope that carry NO value for this attribute. */
  missingCount: number;
}

/** Attribute completeness for one (category, source, attribute) cell. */
export interface AttributeCoverageCell {
  categoryId?: string;
  catalogSourceId?: string;
  attributeKey: string;
  entityKind: AttributeEntityKind;
  /** Entities in scope — the denominator. */
  eligibleCount: number;
  /** Entities with at least one recorded fact, however it normalized. */
  observedCount: number;
  /** Entities with a SELECTED, normalized value — what search can actually use. */
  selectedCount: number;
  conflictingCount: number;
  unnormalizedCount: number;
}
