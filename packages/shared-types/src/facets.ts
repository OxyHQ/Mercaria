/**
 * Facets, filters and the same-variant / same-offer semantics
 * (#367 Workstream 10, ADR 0007 D1/D2/D4/D5/D14).
 *
 * A facet is a QUESTION a shopper may narrow by, together with the answers that
 * exist in the set they are looking at and how many results each answer leaves.
 * Nothing here is a taxonomy, an attribute registry or a ranking policy: #94
 * owns what an attribute IS and what it may be used for, ADR 0007 D5 owns which
 * attributes a product type puts in front of an author, #74 owns what order
 * results come back in, and this domain owns only the composition.
 *
 * ## The two semantics this vocabulary exists for
 *
 * A filter set is not a bag of independent predicates over a product.
 *
 * - **Same-variant.** Every variant-level requirement must be satisfiable by ONE
 *   variant. "Red" from the red one and "43" from the black one is a FALSE
 *   MATCH: the shopper is shown a product that does not exist in the
 *   configuration they asked for, and every downstream page renders normally.
 * - **Same-offer.** Every offer-level requirement must be satisfiable by ONE
 *   offer. A price from the cheapest seller and availability from a different
 *   one is the same failure a layer down, and it is the one a shopper discovers
 *   at checkout.
 *
 * Both are held in SQL by nesting: one `exists` over the variant carrying every
 * variant requirement, with the offer `exists` INSIDE it keyed on that same
 * variant. There is no filter shape in this file that could describe "any
 * variant, any offer" as a conjunction, because {@link FacetLevel} travels on
 * every facet and the resolver partitions on it.
 *
 * ## Missing data
 *
 * `unknown` is never a soft yes. #94 already decides this — every constraint
 * carries a {@link MissingDataPolicy} and this domain CONSUMES it rather than
 * re-implementing it. What is added here is visibility: every facet reports
 * {@link Facet.unknownCount}, the in-scope products for which Mercaria holds no
 * value at all, so a shopper narrowing on a spec that half the catalogue does
 * not record can see the half they are excluding.
 *
 * ## Identity
 *
 * Every key in this file is a STABLE machine key or an opaque id (ADR 0007 D1):
 * an attribute key, a controlled value, a category id, a commerce dimension.
 * `label` is presentation and is never identity — which is why every label
 * carries a {@link FacetLabelSource} saying where it came from, so a client can
 * tell a translated string from a machine key rendered as a fallback.
 */

import type { AttributeCardinality, AttributeValueType } from './attribute-registry';
import { COMMERCE_FACETS, type CommerceFacet, type MissingDataPolicy } from './constraint';
import type { LocalizationStatus, SupportedLocale } from './catalog-localization';
import type { CurrencyCode } from './money';

/**
 * Where a facet came from — that is, which metadata GENERATED it.
 *
 * There is no `manual` or `curated` member and none may be added. A facet list
 * somebody typed is the hard-coded per-category filter set this workstream
 * exists to remove, and giving it a vocabulary member is how it comes back.
 */
export type FacetOrigin = 'attribute' | 'commerce' | 'taxonomy';

export const FACET_ORIGINS: readonly FacetOrigin[] = ['attribute', 'commerce', 'taxonomy'];

/**
 * The entity a facet's requirement is ABOUT, and therefore the grain its
 * conjunction is evaluated at.
 *
 * Not the grain its COUNTS are reported at — those are always distinct products,
 * because a product with forty variants is one result and counting it forty
 * times is the double-count the workstream names. The level decides which
 * `exists` a requirement lands inside, which is the whole of same-variant and
 * same-offer.
 */
export type FacetLevel = 'product' | 'variant' | 'offer';

export const FACET_LEVELS: readonly FacetLevel[] = ['product', 'variant', 'offer'];

/**
 * The commerce dimensions this domain can generate a facet for.
 *
 * A SUBSET of #94's {@link COMMERCE_FACETS}, never a second vocabulary — a facet
 * a shopper picks and a hard constraint the evaluator answers have to be the
 * same concept or the count and the filter disagree. `isFacetCommerceDimension`
 * plus the disjointness test are what keep the subset honest.
 *
 * Three of #94's eight are deliberately excluded and every exclusion is load
 * bearing:
 *
 * - `known_total` — a delivered total is #74's derivation over a PROJECTED
 *   offer, not a stored column, so bucketing it here would mean a second
 *   spelling of that arithmetic. #74 owns it.
 * - `proximity` — a distance is not a value an offer carries; it is a function
 *   of the reader's coordinates and #93's collection points. Its facet arrives
 *   with the publication of those, not before.
 * - `official_channel` — the only one of the three that is genuinely tempting,
 *   and the reason it is out is worth stating. It is not an offer column: it is
 *   whether the offer's merchant holds a LIVE relationship for the product's own
 *   brand, read from #55's temporal rows so a lapsed authorization stops
 *   qualifying with no sweep having run. `findCurrentRelationships` is that
 *   read's one authority and it is keyed on ONE brand, which is a bound a
 *   twenty-row page has and a whole category subtree does not. Facing it here
 *   would mean either sixty statements or a second, batched spelling of the
 *   same predicate — and two spellings of "is this authorization live" can
 *   disagree exactly where a badge is being decided. It stays available as a
 *   #70 filter, where the per-page bound holds.
 */
export type FacetCommerceDimension = Extract<
  CommerceFacet,
  'offer_price' | 'availability' | 'condition' | 'market' | 'offer_channel'
>;

export const FACET_COMMERCE_DIMENSIONS: readonly FacetCommerceDimension[] = [
  'offer_price',
  'availability',
  'condition',
  'market',
  'offer_channel',
];

/** #94's commerce facets this domain does NOT generate, each with an owner. */
export const FACET_DEFERRED_COMMERCE_DIMENSIONS: readonly CommerceFacet[] = [
  'known_total',
  'proximity',
  'official_channel',
];

/** Whether a string names a commerce dimension this domain can face. */
export function isFacetCommerceDimension(value: string): value is FacetCommerceDimension {
  return (FACET_COMMERCE_DIMENSIONS as readonly string[]).includes(value);
}

/** The one taxonomy facet: refine to a child of the scope's category. */
export const FACET_TAXONOMY_KEY = 'category';

/**
 * How a facet's answers are shaped.
 *
 * Decided by the DEFINITION's value type, never by what the stored values
 * happened to look like — #94's rule, and the reason a numeric attribute with
 * three recorded values still gets a slider rather than three chips.
 */
export type FacetValueShape = 'buckets' | 'range' | 'money_range';

export const FACET_VALUE_SHAPES: readonly FacetValueShape[] = [
  'buckets',
  'range',
  'money_range',
];

/** Where a rendered label came from, so a client can tell copy from a key. */
export type FacetLabelSource =
  /** A `category_localizations` / `attribute_value_localizations` row (ADR D4). */
  | 'localization'
  /** `attribute_labels` for the reader's locale, or its fallback. */
  | 'attribute_label'
  /** The definition's own base-locale text — real copy, not yet translated. */
  | 'registry_base'
  /**
   * The stable machine key itself. Mercaria holds NO copy for this concept and
   * says so rather than inventing one; the client owns the string. Every
   * commerce dimension is in this state today — see `docs/facets.md`.
   */
  | 'stable_key';

export const FACET_LABEL_SOURCES: readonly FacetLabelSource[] = [
  'localization',
  'attribute_label',
  'registry_base',
  'stable_key',
];

/**
 * Everything a client needs to explain a rendered string.
 *
 * `effectiveLocale` and `status` are the resolver's own outputs (ADR D4:
 * "returns the effective locale and the translation status alongside the
 * string"), passed through rather than restated.
 */
export interface FacetLabel {
  readonly text: string;
  readonly source: FacetLabelSource;
  readonly effectiveLocale?: SupportedLocale;
  readonly status?: LocalizationStatus;
}

/**
 * Why a facet or one of its values was not offered.
 *
 * Suppression is REPORTED rather than silent, for the reason a census carries a
 * vacuity floor: a facet that vanished and a facet that never existed look
 * identical to whoever is debugging a filter rail.
 */
export type FacetSuppressionReason =
  /** The definition says `filterable: false` — #94 decides this, not this domain. */
  | 'not_filterable'
  /** The product type version marks the field `hidden` or `forbidden` (ADR D5). */
  | 'hidden_by_product_type'
  /** The field's scope is `compatibility`; fitment is a relationship (ADR D8). */
  | 'compatibility_scope'
  /** No in-scope entity carries a value, so the facet answers nothing. */
  | 'no_values'
  /** One distinct value in scope: choosing it narrows nothing. */
  | 'single_value'
  /** A range whose lower and upper bound coincide. */
  | 'degenerate_range'
  /** A value type this domain cannot bucket or bound. */
  | 'unsupported_value_type'
  /** A price facet whose bound currency had no rate for any in-scope offer. */
  | 'unconvertible_currency';

export const FACET_SUPPRESSION_REASONS: readonly FacetSuppressionReason[] = [
  'not_filterable',
  'hidden_by_product_type',
  'compatibility_scope',
  'no_values',
  'single_value',
  'degenerate_range',
  'unsupported_value_type',
  'unconvertible_currency',
];

/** One suppressed facet, named so a client can log it rather than wonder. */
export interface FacetSuppression {
  readonly facetKey: string;
  readonly origin: FacetOrigin;
  readonly reason: FacetSuppressionReason;
}

/**
 * The inputs that MAY decide the order of facets and of the values inside them.
 *
 * A closed set, and DISJOINT from {@link FACET_FORBIDDEN_ORDERING_INPUTS} — the
 * device #55, #58, #74, #82 and #95 all use, because an ordering input is
 * exactly the surface a commercial signal arrives through. Every member here is
 * either versioned metadata somebody published or a property of the data itself.
 */
export type FacetOrderingInput =
  /** `product_type_field_groups.position` — versioned with the type (ADR D5). */
  | 'product_type_group_position'
  /** `product_type_fields.position` — versioned with the type (ADR D5). */
  | 'product_type_field_position'
  /** `attribute_enum_values.position` — the registry's own value order (#94). */
  | 'registry_value_position'
  /** `categories.position` — the taxonomy's own sibling order. */
  | 'category_position'
  /** The numeric magnitude of a bucket, for a value type that has one. */
  | 'value_magnitude'
  /** How many products an answer leaves — permitted for UNORDERED value sets only. */
  | 'result_count'
  /** The stable key, as the final total-order tiebreak. */
  | 'stable_key';

export const FACET_ORDERING_INPUTS: readonly FacetOrderingInput[] = [
  'product_type_group_position',
  'product_type_field_position',
  'registry_value_position',
  'category_position',
  'value_magnitude',
  'result_count',
  'stable_key',
];

/**
 * Inputs that may NEVER order a facet, a facet value or a sort option.
 *
 * Every one of them is a way somebody pays for position. The list is a VALUE
 * rather than a comment so `facet-isolation.test.ts` can assert disjointness
 * from {@link FACET_ORDERING_INPUTS} and scan for each by name.
 */
export type FacetForbiddenOrderingInput =
  | 'marketplace_fee'
  | 'affiliate_commission'
  | 'referral_reward'
  | 'merchant_plan_tier'
  | 'sponsored_placement'
  | 'paid_ranking_slot'
  | 'retail_margin'
  | 'payment_rail_preference';

export const FACET_FORBIDDEN_ORDERING_INPUTS: readonly FacetForbiddenOrderingInput[] = [
  'marketplace_fee',
  'affiliate_commission',
  'referral_reward',
  'merchant_plan_tier',
  'sponsored_placement',
  'paid_ranking_slot',
  'retail_margin',
  'payment_rail_preference',
];

/**
 * Equivalences this domain may never assert between two facet values.
 *
 * The size-system case is the one the workstream names, and the prohibition is
 * structural rather than checked: a size system IS an attribute definition
 * (`shoe_size_eu` and `shoe_size_uk` are two keys), so there is no row, column
 * or function that could map a bucket of one onto a bucket of the other. What
 * this list adds is the ability to say so as a value and scan for the shapes
 * that would introduce one.
 *
 * `colour_family_collapse` is the opposite direction and is equally forbidden:
 * a colour FAMILY is a controlled value with the commercial names recorded
 * beside it ({@link FacetBucket.observedLabels}), never a bucket that replaced
 * them. A shopper filtering "black" must still be told the seller calls it
 * "Midnight".
 */
export type FacetForbiddenEquivalence =
  | 'size_system_conversion'
  | 'size_system_merge'
  | 'colour_family_collapse'
  | 'unit_family_crossover'
  | 'cross_attribute_bucket_merge';

export const FACET_FORBIDDEN_EQUIVALENCES: readonly FacetForbiddenEquivalence[] = [
  'size_system_conversion',
  'size_system_merge',
  'colour_family_collapse',
  'unit_family_crossover',
  'cross_attribute_bucket_merge',
];

/** How many commercial spellings a bucket carries before the list is truncated. */
export const FACET_MAX_OBSERVED_LABELS = 8;

/** Fewer distinct answers than this and a facet cannot narrow anything. */
export const FACET_MIN_DISTINCT_VALUES = 2;

/** The largest candidate id set a caller may scope a facet run to. */
export const FACET_MAX_SCOPE_PRODUCT_IDS = 1_000;

/** The largest number of selections one request may carry. */
export const FACET_MAX_SELECTIONS = 24;

/** The largest number of values one selection may carry. */
export const FACET_MAX_SELECTION_VALUES = 32;

/** The largest number of buckets one facet reports. */
export const FACET_MAX_BUCKETS = 200;

// ---------------------------------------------------------------------------
// Scope and selection
// ---------------------------------------------------------------------------

/**
 * What a facet run is ABOUT.
 *
 * Two members, and the split is a statement about who retrieved what. A category
 * scope is an indexable predicate over the whole taxonomy subtree, so its counts
 * are exact over a set nobody had to materialise. A `canonical_products` scope
 * is a BOUNDED id list a caller already retrieved — #70's candidate ids, a
 * comparison basket, a saved query's result — and it exists so this domain never
 * has to grow a second answer to "what matches this text", which is search's.
 */
export type FacetScope =
  | {
      readonly kind: 'category';
      readonly categoryId: string;
      /** Whether the subtree beneath the category is in scope. Defaults true. */
      readonly includeDescendants?: boolean;
    }
  | {
      readonly kind: 'canonical_products';
      readonly canonicalProductIds: readonly string[];
    };

/** The scope as it was actually resolved, echoed so a client can cache on it. */
export interface ResolvedFacetScope {
  readonly kind: FacetScope['kind'];
  readonly categoryId?: string;
  /** Every category id in scope, root first — the resolved subtree. */
  readonly categoryIds?: readonly string[];
  readonly productIdCount?: number;
  /** The product type whose versioned metadata ordered these facets, if any. */
  readonly productTypeKey?: string;
  readonly productTypeVersion?: number;
}

/**
 * One narrowing a shopper has applied.
 *
 * A discriminated union on a STRING (`origin`), never a boolean-literal
 * discriminant: the backend compiles with `strict: false`, and without
 * `strictNullChecks` TypeScript does not narrow a union on the truthiness of a
 * boolean member — measured in #68 and again in #110.
 *
 * Values are stable keys, so a selection survives a translation, a rename and a
 * cache. `values` is an OR within one selection and an AND across selections,
 * which is what makes a facet's own counts computable with its own selection
 * lifted.
 */
export type FacetSelectionEntry =
  | {
      readonly origin: 'attribute';
      /** The #94 registry key. */
      readonly facetKey: string;
      readonly values?: readonly string[];
      /** Inclusive, in the definition's BASE unit — never the source's. */
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly origin: 'commerce';
      readonly facetKey: FacetCommerceDimension;
      readonly values?: readonly string[];
      /** Inclusive, in `currency`'s minor units. */
      readonly minMinor?: number;
      readonly maxMinor?: number;
      readonly currency?: CurrencyCode;
    }
  | {
      readonly origin: 'taxonomy';
      readonly facetKey: typeof FACET_TAXONOMY_KEY;
      readonly values: readonly string[];
    };

/** Everything one request narrows by. */
export interface FacetSelection {
  readonly entries: readonly FacetSelectionEntry[];
}

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

/** One answer a shopper may pick, and what picking it leaves. */
export interface FacetBucket {
  /** The STABLE key that travels in a URL and in client state. */
  readonly key: string;
  readonly label: FacetLabel;
  /** Distinct in-scope canonical PRODUCTS this answer leaves. Never a row count. */
  readonly count: number;
  readonly selected: boolean;
  /**
   * The commercial spellings observed under this canonical value — "Midnight",
   * "Jet Black" under `black`. Display only, capped at
   * {@link FACET_MAX_OBSERVED_LABELS}, and present so a family filter never
   * erases the name a seller actually used.
   */
  readonly observedLabels?: readonly string[];
}

/** A numeric facet's span, in the definition's base unit. */
export interface FacetRange {
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  readonly selectedMin?: number;
  readonly selectedMax?: number;
}

/** A money facet's span, always naming its currency. */
export interface FacetMoneyRange {
  readonly minMinor: number;
  readonly maxMinor: number;
  readonly currency: CurrencyCode;
  readonly selectedMinMinor?: number;
  readonly selectedMaxMinor?: number;
  /**
   * Currencies present in scope that could not be priced into {@link currency}
   * and were therefore left out — the `SearchFxContext` posture. An
   * unconvertible price is never reported as "too expensive".
   *
   * `string`, not `CurrencyCode`: a currency Mercaria does not model is exactly
   * the one most worth naming here, and the narrower type made it unreportable
   * even deliberately (#450).
   */
  readonly unconvertibleCurrencies?: readonly string[];
  /**
   * The subset of {@link unconvertibleCurrencies} Mercaria does not model at all
   * — permanent until the code is added, where a missing rate is transient.
   */
  readonly unmodelledCurrencies?: readonly string[];
}

/** A facet's answers, shaped by the definition rather than by the data. */
export type FacetValues =
  | { readonly shape: 'buckets'; readonly buckets: readonly FacetBucket[] }
  | { readonly shape: 'range'; readonly range: FacetRange }
  | { readonly shape: 'money_range'; readonly range: FacetMoneyRange };

/** One question a shopper may narrow by. */
export interface Facet {
  /** Stable: an attribute key, a commerce dimension, or `category`. */
  readonly key: string;
  readonly origin: FacetOrigin;
  readonly level: FacetLevel;
  readonly label: FacetLabel;
  /** The exact #94 definition version this facet was generated from. */
  readonly definitionVersion?: number;
  readonly valueType?: AttributeValueType;
  readonly cardinality?: AttributeCardinality;
  /** The authoring group this facet belongs to, from the product type version. */
  readonly groupKey?: string;
  readonly groupLabel?: FacetLabel;
  /** Whether several answers may be picked at once. */
  readonly multiSelect: boolean;
  /** #94's own capability flag, passed through — never re-derived here. */
  readonly hardConstraintCapable: boolean;
  readonly sortable: boolean;
  /** #94's policy for this facet's absence, consumed rather than re-decided. */
  readonly missingDataPolicy: MissingDataPolicy;
  /**
   * In-scope products for which Mercaria holds NO value for this facet.
   *
   * On every facet, deliberately. Narrowing on a spec half the catalogue does
   * not record is a decision about that half, and a facet that hides the gap
   * makes it on the shopper's behalf.
   */
  readonly unknownCount: number;
  readonly values: FacetValues;
}

/** One way a client may order results — published here, applied by the reader. */
export interface FacetSortOption {
  readonly key: string;
  readonly origin: FacetOrigin;
  readonly direction: 'asc' | 'desc';
  readonly label: FacetLabel;
}

/**
 * A validated sort, ready to hand to whatever lists the products.
 *
 * `tiebreak` is not optional and has one member: without a total order two
 * products with the same value can swap between pages, which is the
 * keyset-paging bug every list in this repository is written to avoid.
 */
export interface FacetSortDirective {
  readonly key: string;
  readonly origin: FacetOrigin;
  readonly direction: 'asc' | 'desc';
  readonly tiebreak: 'canonical_product_id';
}

/** Why a sort was refused. Codes, never message text (ADR D10). */
export type FacetSortRefusal = 'unknown_key' | 'not_sortable' | 'unsupported_direction';

export const FACET_SORT_REFUSALS: readonly FacetSortRefusal[] = [
  'unknown_key',
  'not_sortable',
  'unsupported_direction',
];

/** The outcome of validating a requested sort. */
export type FacetSortResolution =
  | { readonly outcome: 'resolved'; readonly directive: FacetSortDirective }
  | { readonly outcome: 'refused'; readonly refusal: FacetSortRefusal; readonly key: string };

/** Why a result set is empty. */
export type FacetEmptyStateReason = 'no_products_in_scope' | 'selection_excludes_everything';

export const FACET_EMPTY_STATE_REASONS: readonly FacetEmptyStateReason[] = [
  'no_products_in_scope',
  'selection_excludes_everything',
];

/**
 * One narrowing that, if the shopper removed it, would leave results.
 *
 * There is NO results member on this type and none may be added. A suggestion
 * is a PROPOSAL the client presents and the shopper accepts; the server never
 * answers a request under a selection the shopper did not make, which is what
 * "never silently relax a hard constraint" means when it is a property of the
 * response shape rather than a promise in a comment. `relaxesHardConstraint`
 * exists so a client can say so out loud before the shopper presses it.
 */
export interface FacetSuggestion {
  readonly facetKey: string;
  readonly origin: FacetOrigin;
  /** The specific value to drop, or absent when the whole selection would go. */
  readonly valueKey?: string;
  /** Distinct products that would remain. Always > 0 — a useless suggestion is not one. */
  readonly resultCount: number;
  readonly relaxesHardConstraint: boolean;
}

export interface FacetEmptyState {
  readonly reason: FacetEmptyStateReason;
  readonly suggestions: readonly FacetSuggestion[];
}

/** A selection as the server understood it, echoed back with stable keys. */
export interface ResolvedFacetSelectionEntry {
  readonly facetKey: string;
  readonly origin: FacetOrigin;
  readonly level: FacetLevel;
  readonly values: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly currency?: CurrencyCode;
  /**
   * Whether the facet this selection names is still being OFFERED. A selection
   * on a facet suppressed by the current scope stays applied and stays visible;
   * dropping it would change the shopper's query without telling them.
   */
  readonly facetOffered: boolean;
}

/** The whole answer. */
export interface FacetResponse {
  readonly scope: ResolvedFacetScope;
  readonly locale: string;
  readonly facets: readonly Facet[];
  readonly selection: readonly ResolvedFacetSelectionEntry[];
  readonly sortOptions: readonly FacetSortOption[];
  /** Distinct canonical products satisfying every selection, at every level. */
  readonly matchedProductCount: number;
  readonly suppressed: readonly FacetSuppression[];
  readonly emptyState?: FacetEmptyState;
}
