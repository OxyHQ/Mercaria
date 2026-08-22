/**
 * Versioned product types (#367, ADR 0007 D5) — the one genuinely new entity in
 * the universal-catalog epic.
 *
 * A product type is a VERSIONED SCHEMA: "what does a smartphone have to say
 * about itself, and who has to say it". It is the layer a person authors
 * against, and it exists so that the dashboard holds no category-specific truth
 * and so that a listing recorded in 2026 can still be read under the rules it
 * was recorded under.
 *
 * ## What this vocabulary deliberately cannot express
 *
 * - **A field's TYPE, UNIT or VALIDATION.** A product-type field cites an
 *   `attribute_definitions` row and its exact version and restates nothing about
 *   it. #94's registry is the one authority on what a value means; a second
 *   description of one fact is how the two come to disagree, and the direction
 *   they disagree in is never the safe one.
 * - **A price, a stock level, a seller's condition or a compatibility target as
 *   a variant axis.** {@link PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS} names
 *   them as VALUES and a CHECK on `product_type_fields` refuses the row (ADR
 *   0007 D6/D8). One brake pad fits four hundred vehicles and stays ONE variant.
 * - **An open-ended rule.** {@link ProductTypeVisibilityRule} is a closed,
 *   bounded, non-Turing-complete predicate AST: no function call, no
 *   row-supplied regex, no arithmetic, no field path that could leave the
 *   product type's own attribute keys. A source-supplied pattern is a small
 *   language and a DoS primitive — #63's finding, and the reason a
 *   `regex_replace`-shaped operator has no member here to be written down as.
 *
 * The tuples are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is a code change PLUS an additive migration in the SAME pull
 * request: the TypeScript union widens immediately and the database CHECK does
 * not.
 */

import { RESERVED_OFFER_FACT_KEYS } from './attribute-registry';

/**
 * The lifecycle of ONE product-type definition VERSION (ADR 0007 D5).
 *
 * The `fee_schedules` / `attribute_definitions` mechanism, third use: editable
 * only while `draft`, frozen by trigger from `published` onward, and at most one
 * `published` version per key at a time (a partial unique index). A published
 * schema is what an author's answers were recorded against, so changing it would
 * reinterpret those answers rather than correct them.
 *
 * `review` sits between `draft` and `published` and is deliberately NOT frozen:
 * review is where a schema is still being argued about. `deprecated` still
 * resolves records that cite it — they pin the version — and accepts no new
 * authoring.
 */
export type ProductTypeLifecycle = 'draft' | 'review' | 'published' | 'deprecated';

export const PRODUCT_TYPE_LIFECYCLES: readonly ProductTypeLifecycle[] = [
  'draft',
  'review',
  'published',
  'deprecated',
];

/** The lifecycle states in which a version's meaning may still be edited. */
export const PRODUCT_TYPE_EDITABLE_LIFECYCLES: readonly ProductTypeLifecycle[] = [
  'draft',
  'review',
];

/**
 * What a field is ABOUT — the four roles ADR 0007 D5 names.
 *
 * - `identity` — what makes this the product it is (GTIN, brand, model). A
 *   change here is a different product, not an edit.
 * - `product` — a fact true of every variant (screen technology, material).
 * - `variant` — a fact that differs between variants and MAY define an axis.
 * - `compatibility` — what this fits (a vehicle generation, a socket). Held
 *   apart from `variant` because D8's whole point is that fitment is a
 *   relationship and never an option row.
 */
export type ProductTypeFieldScope = 'identity' | 'product' | 'variant' | 'compatibility';

export const PRODUCT_TYPE_FIELD_SCOPES: readonly ProductTypeFieldScope[] = [
  'identity',
  'product',
  'variant',
  'compatibility',
];

/**
 * How hard the schema asks for a field, in ONE authoring flow.
 *
 * `hidden` and `forbidden` are different facts and collapsing them loses the
 * one that matters: `hidden` means "this flow does not ask, and a value that
 * arrives another way is kept", while `forbidden` means "this flow may not
 * supply this at all" — a connector asserting a field only a verified brand may
 * assert is refused, not quietly dropped.
 */
export type ProductTypeFieldRequirement =
  | 'required'
  | 'recommended'
  | 'optional'
  | 'hidden'
  | 'forbidden';

export const PRODUCT_TYPE_FIELD_REQUIREMENTS: readonly ProductTypeFieldRequirement[] = [
  'required',
  'recommended',
  'optional',
  'hidden',
  'forbidden',
];

/**
 * WHO is authoring (ADR 0007 D5).
 *
 * A requirement is per flow because the same product type is filled in by a
 * merchant with a spec sheet, a person photographing something in their hallway,
 * an operator correcting a record, a connector replaying somebody else's feed
 * and a brand asserting its own catalogue. Demanding a merchant's twelve
 * identity fields from a P2P seller is how a marketplace loses its secondhand
 * supply.
 */
export type ProductTypeAuthoringFlow =
  | 'merchant'
  | 'p2p'
  | 'operator'
  | 'connector'
  | 'verified_brand';

export const PRODUCT_TYPE_AUTHORING_FLOWS: readonly ProductTypeAuthoringFlow[] = [
  'merchant',
  'p2p',
  'operator',
  'connector',
  'verified_brand',
];

/**
 * How a value is SUPPLIED — which is a different question from what it means.
 *
 * - `controlled_value` — one of the attribute's own enum values, and nothing
 *   else.
 * - `canonical_reference` — a pointer at a canonical entity (a brand, a product
 *   family), never a name typed twice.
 * - `typed_scalar` / `typed_structured` — a value validated by the attribute's
 *   own registry rules; `structured` is the multi-axis shape (155.6 × 71.5 ×
 *   8.25 mm as three facts).
 * - `proposal_enabled` — the author may propose a missing controlled value
 *   (ADR 0007 D9). It is the ONLY member that admits a value the registry does
 *   not already carry, which is what keeps "a merchant proposal never becomes
 *   globally trusted data by being submitted" checkable in one place.
 */
export type ProductTypeValuePolicy =
  | 'controlled_value'
  | 'canonical_reference'
  | 'typed_scalar'
  | 'typed_structured'
  | 'proposal_enabled';

export const PRODUCT_TYPE_VALUE_POLICIES: readonly ProductTypeValuePolicy[] = [
  'controlled_value',
  'canonical_reference',
  'typed_scalar',
  'typed_structured',
  'proposal_enabled',
];

/**
 * What happens to a publication while one of its values is still a PROPOSAL
 * (ADR 0007 D9).
 *
 * A property of the product type VERSION rather than a per-request decision, so
 * it is versioned and reviewable: "may a phone list while the colour it claims
 * is still being reviewed" is a policy somebody signed, not something a handler
 * decides on the day.
 */
export type ProductTypePendingProposalPolicy = 'block_publication' | 'allow_local_claim';

export const PRODUCT_TYPE_PENDING_PROPOSAL_POLICIES: readonly ProductTypePendingProposalPolicy[] = [
  'block_publication',
  'allow_local_claim',
];

/**
 * Attribute keys that may never carry a variant axis because they name a
 * COMPATIBILITY TARGET (ADR 0007 D8).
 *
 * Kept separate from {@link RESERVED_OFFER_FACT_KEYS} rather than merged into
 * it, because the registry's list answers a different question: #94 refuses to
 * DEFINE these at all, while a vehicle make is a perfectly legitimate attribute
 * — it just may not become an option row. One brake-pad SKU fits many vehicles
 * and remains one variant, which is the epic's own acceptance scenario.
 */
export const PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS: readonly string[] = [
  'vehicle_make',
  'vehicle_model',
  'vehicle_generation',
  'vehicle_configuration',
  'vehicle_year',
  'vehicle_year_range',
  'model_year',
  'year_range',
  'fitment',
  'fits_vehicle',
  'compatible_with',
  'compatible_model',
  'compatibility',
];

/**
 * Attribute keys that may never carry a variant axis because they name what a
 * product CONTAINS (#367 line 144, ADR 0007 D15).
 *
 * The {@link PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS} argument, applied to
 * composition instead of fitment. ADR 0002 D15 makes a bundle its OWN canonical
 * product whose contents are `bundle_components` rows — a relationship between
 * two variants, with its own table, its own quantity, its own self-containment
 * CHECK and its own merge-conflict kind. An attribute axis spelling the same
 * fact would be a second representation of it, and the two would disagree in the
 * direction that matters: the axis would multiply a bundle into one variant per
 * thing it contains, which is exactly the 400-SKU explosion D8 refuses for a
 * brake pad.
 *
 * These keys stay perfectly DEFINABLE — "what's in the box" is an ordinary
 * product-scope specification and a good one. What they may not be is an option
 * row. That is the same asymmetry the compatibility list has, and the reason
 * both are held here rather than in #94's registry.
 *
 * **`pack_count` is deliberately NOT a member**, and the absence is load-bearing
 * rather than an oversight: ADR 0002 D15 makes a multipack a variant of the same
 * product carrying exactly that axis, so forbidding it would make every
 * six-pack-and-single pair unrepresentable. `product-type-composition-axis.test.ts`
 * pins it.
 */
export const PRODUCT_TYPE_COMPOSITION_AXIS_KEYS: readonly string[] = [
  'bundle_components',
  'bundle_contents',
  'bundle_items',
  'box_contents',
  'in_the_box',
  'kit_contents',
  'included_items',
  'includes',
  'contains',
  'contents',
  'components',
  'component_variants',
];

/**
 * Every attribute key a `variant_capable` product-type field is REFUSED for, as
 * a CHECK on `product_type_fields` (ADR 0007 D6/D8/D15).
 *
 * Derived from the three lists above rather than retyped, so #94 adding a
 * reserved offer fact widens this prohibition too. Note the asymmetry that makes
 * it a real gate rather than a restatement: the registry's CHECK stops those
 * keys being DEFINED, and this one stops a compatibility target or a
 * composition — both legally definable — being turned into an option axis.
 *
 * Widening it is a code change PLUS a migration, like every other rendered
 * CHECK: the union widens immediately and the database constraint does not.
 */
export const PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS: readonly string[] = [
  ...RESERVED_OFFER_FACT_KEYS,
  ...PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS,
  ...PRODUCT_TYPE_COMPOSITION_AXIS_KEYS,
];

/**
 * The shape every key in this domain has — lowercase, snake_case, anchored.
 *
 * Identical to `attribute_definitions_key_shape_check`'s pattern on purpose: a
 * visibility rule reads a field by its ATTRIBUTE key, so the two vocabularies
 * must not be able to diverge on what a legal key looks like.
 */
export const PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A product-type key. Dots are permitted (`electronics.phones.smartphone`)
 * because ADR 0007 D1 gives catalog concepts a documented namespace; the
 * attribute pattern above does not, because #94 already shipped without them.
 */
export const PRODUCT_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * `product_type_aliases.kind` — what an alternate name for a product type IS.
 *
 * ## Its own tuple, and NOT `CATEGORY_ALIAS_KINDS`
 *
 * The two vocabularies overlap on four members and are deliberately separate
 * objects, for a mechanical reason and a semantic one.
 *
 * Mechanically: `CATEGORY_ALIAS_KINDS` renders
 * `category_aliases_kind_check` on another domain's table. Adding
 * `transliteration`, `abbreviation` and `regional_term` to it to serve this
 * table would widen a CHECK on `category_aliases` — a constraint change on rows
 * this issue does not own, arriving in a migration whose title says
 * "product types".
 *
 * Semantically: these are the three the epic names under
 * "localized aliases, synonyms, regional terms, abbreviations, common
 * misspellings and transliterations" and that nothing in the repository could
 * previously represent. `misspelling` is kept because a search alias is exactly
 * where one belongs; `legacy_name` is kept because a renamed product type is
 * the commonest reason a stored key stops matching what people type.
 *
 * `external_label` is deliberately NOT a member. A source's own word for a
 * product type is a source MAPPING — it belongs beside the source that said it,
 * with its provenance, the way `attribute_source_mappings` and
 * `category_external_mappings` already record theirs. Admitting it here would
 * make an importer's vocabulary indistinguishable from Mercaria's own, which is
 * the "imported source taxonomies leaking into Mercaria's public model" failure
 * the epic is written against.
 */
export type ProductTypeAliasKind =
  | 'synonym'
  | 'search_term'
  | 'legacy_name'
  | 'misspelling'
  | 'transliteration'
  | 'abbreviation'
  | 'regional_term';

/** The tuple `product_type_aliases_kind_check` is rendered from. */
export const PRODUCT_TYPE_ALIAS_KINDS: readonly ProductTypeAliasKind[] = [
  'synonym',
  'search_term',
  'legacy_name',
  'misspelling',
  'transliteration',
  'abbreviation',
  'regional_term',
];

/* -------------------------------------------------------------------------- */
/* The conditional-visibility rule AST (ADR 0007 D5, D14)                      */
/* -------------------------------------------------------------------------- */

/**
 * Comparison operators — a total order question, or an equality one.
 *
 * There is no `matches`, no `like` and no `regex`, and that absence is the
 * point: a pattern supplied by a stored row is a small language, and evaluating
 * one on behalf of whoever wrote the row is both an injection surface and a DoS
 * primitive (#63's `FEED_FORBIDDEN_TRANSFORM_KINDS`, same reasoning one domain
 * over). A schema that needs "starts with" declares a controlled value instead.
 */
export type ProductTypeRuleComparisonOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** Set membership. `includes_any` is named for its semantics so nobody has to guess. */
export type ProductTypeRuleMembershipOperator = 'in' | 'not_in' | 'includes_any';

/** Whether the draft has answered a field at all. */
export type ProductTypeRulePresenceOperator = 'is_present' | 'is_absent';

export type ProductTypeRuleOperator =
  | ProductTypeRuleComparisonOperator
  | ProductTypeRuleMembershipOperator
  | ProductTypeRulePresenceOperator;

export const PRODUCT_TYPE_RULE_COMPARISON_OPERATORS: readonly ProductTypeRuleComparisonOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
];

export const PRODUCT_TYPE_RULE_MEMBERSHIP_OPERATORS: readonly ProductTypeRuleMembershipOperator[] = [
  'in',
  'not_in',
  'includes_any',
];

export const PRODUCT_TYPE_RULE_PRESENCE_OPERATORS: readonly ProductTypeRulePresenceOperator[] = [
  'is_present',
  'is_absent',
];

export const PRODUCT_TYPE_RULE_OPERATORS: readonly ProductTypeRuleOperator[] = [
  ...PRODUCT_TYPE_RULE_COMPARISON_OPERATORS,
  ...PRODUCT_TYPE_RULE_MEMBERSHIP_OPERATORS,
  ...PRODUCT_TYPE_RULE_PRESENCE_OPERATORS,
];

/**
 * Operator shapes a rule may never take, named as VALUES and asserted DISJOINT
 * from {@link PRODUCT_TYPE_RULE_OPERATORS} by a test.
 *
 * A negative list beside the positive one is what fails the build when somebody
 * adds a plausible-looking member later. Every one of these is a small language
 * or an unbounded computation wearing an operator's clothes.
 */
export const PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS: readonly string[] = [
  'matches',
  'regex',
  'like',
  'ilike',
  'similar_to',
  'eval',
  'call',
  'script',
  'template',
  'sql',
  'jsonpath',
  'fetch',
];

/** A leaf value. Deliberately three scalars: no object, no array, no null. */
export type ProductTypeRuleScalar = string | number | boolean;

/** `field <op> value` — an equality or ordering test against one scalar. */
export interface ProductTypeComparisonRule {
  readonly node: 'compare';
  /** The attribute key of another field of the SAME product type version. */
  readonly field: string;
  readonly op: ProductTypeRuleComparisonOperator;
  readonly value: ProductTypeRuleScalar;
}

/** `field <op> values` — a bounded set test. */
export interface ProductTypeMembershipRule {
  readonly node: 'membership';
  readonly field: string;
  readonly op: ProductTypeRuleMembershipOperator;
  readonly values: readonly ProductTypeRuleScalar[];
}

/**
 * `field is_present` / `field is_absent`.
 *
 * Its own node rather than an operator on {@link ProductTypeComparisonRule},
 * so "a presence test carrying a value" has no shape at all — the JSON is
 * refused by the parser rather than accepted with the value ignored.
 */
export interface ProductTypePresenceRule {
  readonly node: 'presence';
  readonly field: string;
  readonly op: ProductTypeRulePresenceOperator;
}

export interface ProductTypeAllRule {
  readonly node: 'all';
  readonly rules: readonly ProductTypeVisibilityRule[];
}

export interface ProductTypeAnyRule {
  readonly node: 'any';
  readonly rules: readonly ProductTypeVisibilityRule[];
}

export interface ProductTypeNotRule {
  readonly node: 'not';
  readonly rule: ProductTypeVisibilityRule;
}

/**
 * The whole rule language. `node` is a STRING discriminant, not a boolean flag:
 * the backend compiles with `strict: false`, so without `strictNullChecks`
 * TypeScript does not narrow a union on the truthiness of a boolean-literal
 * discriminant and every consumer would be left holding the union (#68's
 * finding, and #110 hit it again).
 */
export type ProductTypeVisibilityRule =
  | ProductTypeComparisonRule
  | ProductTypeMembershipRule
  | ProductTypePresenceRule
  | ProductTypeAllRule
  | ProductTypeAnyRule
  | ProductTypeNotRule;

export const PRODUCT_TYPE_RULE_NODES: readonly ProductTypeVisibilityRule['node'][] = [
  'compare',
  'membership',
  'presence',
  'all',
  'any',
  'not',
];

/**
 * The bounds. Every one of them is checked while PARSING, before anything is
 * evaluated, and the storage layer carries an independent byte bound
 * (`product_type_fields_visibility_rule_bounded_check`) so an oversized rule
 * cannot be stored and then refused on every read.
 *
 * They are constants rather than configuration deliberately: "how much
 * computation may a stored row ask for" is not a question a deployment should be
 * able to answer differently.
 */
export const PRODUCT_TYPE_RULE_MAX_NODES = 64;
export const PRODUCT_TYPE_RULE_MAX_DEPTH = 6;
export const PRODUCT_TYPE_RULE_MAX_BRANCHES = 16;
export const PRODUCT_TYPE_RULE_MAX_VALUES = 32;
export const PRODUCT_TYPE_RULE_MAX_STRING_LENGTH = 256;
export const PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES = 4096;

/**
 * Why a candidate rule was refused. A closed set so a caller can act on the
 * answer, and so a client never matches on message text (ADR 0007 D10).
 */
export type ProductTypeRuleRefusal =
  | 'not_an_object'
  | 'unknown_node'
  | 'unknown_operator'
  | 'forbidden_operator'
  | 'invalid_field_key'
  | 'invalid_value'
  | 'value_type_mismatch'
  | 'empty_branch_list'
  | 'too_many_branches'
  | 'too_many_values'
  | 'too_deep'
  | 'too_many_nodes'
  | 'too_large';

export const PRODUCT_TYPE_RULE_REFUSALS: readonly ProductTypeRuleRefusal[] = [
  'not_an_object',
  'unknown_node',
  'unknown_operator',
  'forbidden_operator',
  'invalid_field_key',
  'invalid_value',
  'value_type_mismatch',
  'empty_branch_list',
  'too_many_branches',
  'too_many_values',
  'too_deep',
  'too_many_nodes',
  'too_large',
];

/**
 * The result of parsing an untrusted candidate into a rule.
 *
 * A discriminated union with a STRING discriminant, and the invalid branch has
 * no `rule` property — so a caller cannot reach a rule it did not get.
 */
export type ProductTypeRuleParse =
  | {
      readonly outcome: 'valid';
      readonly rule: ProductTypeVisibilityRule;
      readonly nodeCount: number;
      readonly depth: number;
      /** Every attribute key the rule reads, deduplicated, in first-seen order. */
      readonly fields: readonly string[];
    }
  | {
      readonly outcome: 'invalid';
      readonly refusal: ProductTypeRuleRefusal;
      /** Where in the candidate the refusal happened (`$.rules[1].field`). */
      readonly path: string;
    };

/**
 * Three-valued, because two values would have to lie about absence.
 *
 * `unknown` is not a soft yes and not a soft no: it means the draft has not yet
 * answered a field the rule reads. Collapsing it into `unsatisfied` hides a
 * field an author has not reached; collapsing it into `satisfied` shows fields
 * whose precondition nobody established.
 */
export type ProductTypeVisibilityOutcome = 'satisfied' | 'unsatisfied' | 'unknown';

export const PRODUCT_TYPE_VISIBILITY_OUTCOMES: readonly ProductTypeVisibilityOutcome[] = [
  'satisfied',
  'unsatisfied',
  'unknown',
];

export interface ProductTypeVisibilityVerdict {
  readonly outcome: ProductTypeVisibilityOutcome;
  /** The fields the rule read and the draft had no answer for. */
  readonly unknownFields: readonly string[];
}

/**
 * What an authoring draft can hand the interpreter for one field.
 *
 * `null` and `undefined` both mean "unanswered" and are indistinguishable to
 * the interpreter on purpose — a client that clears a field and one that never
 * set it have said the same thing.
 */
export type ProductTypeRuleFieldValue =
  | ProductTypeRuleScalar
  | readonly ProductTypeRuleScalar[]
  | null
  | undefined;

/** The answers a rule is evaluated against, keyed by attribute key. */
export type ProductTypeRuleValues = Readonly<Record<string, ProductTypeRuleFieldValue>>;

/* -------------------------------------------------------------------------- */
/* The read DTOs                                                               */
/* -------------------------------------------------------------------------- */

/** One version of one product type, as a read surface reports it. */
export interface ProductTypeDefinitionSummary {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly lifecycle: ProductTypeLifecycle;
  /** The base-locale name. Localized names are ADR 0007 D4's, never this. */
  readonly name: string;
  readonly description: string | null;
  readonly pendingProposalPolicy: ProductTypePendingProposalPolicy;
  readonly publishedAt: string | null;
  readonly deprecatedAt: string | null;
}

/** An ordered authoring/display group inside one version. */
export interface ProductTypeFieldGroupSummary {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly position: number;
}

/**
 * One field of one version, for one flow.
 *
 * It carries the attribute's IDENTITY (`attributeKey` + `attributeVersion`) and
 * nothing about its meaning — no type, no unit family, no bounds. A consumer
 * that needs those resolves the cited registry version, which is the only place
 * they exist.
 */
export interface ProductTypeFieldSummary {
  readonly id: string;
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  readonly attributeVersion: number;
  readonly groupId: string | null;
  readonly scope: ProductTypeFieldScope;
  readonly flow: ProductTypeAuthoringFlow;
  readonly requirement: ProductTypeFieldRequirement;
  readonly valuePolicy: ProductTypeValuePolicy;
  readonly variantCapable: boolean;
  readonly position: number;
  readonly visibilityRule: ProductTypeVisibilityRule | null;
}

/** Which categories a version may be used under (ADR 0007 D2/D5). */
export interface ProductTypeCategoryScopeSummary {
  readonly id: string;
  readonly categoryId: string;
  readonly includeDescendants: boolean;
}

/**
 * One version, resolved for ONE flow: the definition, its groups, its fields and
 * its category scopes.
 *
 * Deliberately NOT called an authoring schema. ADR 0007 D10 gives that name to
 * a composition over this PLUS the registry versions, the controlled-value
 * policies, the store permissions, the locale and the market — and it belongs to
 * `services/catalog-authoring/`. This is the product-type half and nothing else.
 */
export interface ProductTypeVersionView {
  readonly definition: ProductTypeDefinitionSummary;
  readonly flow: ProductTypeAuthoringFlow;
  readonly groups: readonly ProductTypeFieldGroupSummary[];
  readonly fields: readonly ProductTypeFieldSummary[];
  readonly categoryScopes: readonly ProductTypeCategoryScopeSummary[];
}

/* -------------------------------------------------------------------------- */
/* The PUBLIC specification layout                                             */
/* -------------------------------------------------------------------------- */

/**
 * One display group of a specification table.
 *
 * A different TYPE from {@link ProductTypeFieldGroupSummary} rather than a
 * filtered one — the `MerchantOrder` device — because the two answer different
 * questions and the authoring one carries a row `id`. This carries the group's
 * stable KEY (D1: identity is a key, never a label), and a serializer that
 * reached for an id fails `tsc` instead of publishing one.
 */
export interface PublicProductTypeSpecificationGroup {
  readonly key: string;
  readonly label: string;
  readonly position: number;
  /** The attribute keys this group holds, in the version's own layout order. */
  readonly attributeKeys: readonly string[];
}

/**
 * How a product type says its specifications are grouped — the PUBLIC read.
 *
 * ## Why it carries no flow, and what that costs
 *
 * `product_type_fields` rows are per AUTHORING FLOW: a P2P form is a different,
 * shorter list from a merchant form, deliberately. A shopper's specification
 * table must not depend on which form the seller happened to fill in — two
 * listings of one phone would group their specs differently with nothing saying
 * why — so this layout is derived across EVERY flow and names none.
 *
 * The cost is that two flows can legitimately place one attribute in two
 * different groups, and nothing in the schema forbids it (the citation trigger
 * pins `variant_capable` across flows, not `group_id`). Such an attribute is
 * reported in {@link conflictingAttributeKeys} and is NOT placed — #94's
 * `conflicting` selection state, applied to a layout: two sources disagree, so
 * neither is selected, because picking one would make a shopper's spec table a
 * function of which flow was read first.
 *
 * ## An unplaced attribute is not a missing one
 *
 * `ungroupedAttributeKeys` is the honest home for both an attribute no flow
 * grouped and one the flows disagree about. A client renders those rows — under
 * its own heading, or by entity scope, which is what the storefront does today —
 * rather than dropping them, because a spec a seller filled in and a shopper
 * cannot see is worse than an ungrouped one.
 */
export interface PublicProductTypeSpecificationLayout {
  readonly productTypeKey: string;
  readonly version: number;
  /** The base-locale name. Localized names are ADR 0007 D4's, never this. */
  readonly name: string;
  readonly groups: readonly PublicProductTypeSpecificationGroup[];
  /** Placed in no group: grouped by no flow, or disagreed about across flows. */
  readonly ungroupedAttributeKeys: readonly string[];
  /** The disagreed-about subset of {@link ungroupedAttributeKeys}. */
  readonly conflictingAttributeKeys: readonly string[];
}

/**
 * Five fields no public product-type DTO may declare.
 *
 * Stated as VALUES so the prohibition is testable, and gated both statically and
 * by a walk of a real emitted layout (#92's two-gate rule). Each is an AUTHORING
 * fact rather than a display one: `requirement` and `valuePolicy` say what a
 * seller must supply, `visibilityRule` is form logic, `flow` says which form, and
 * a row `id` is an identity D1 assigns to the key instead. A shopper reading a
 * spec table needs none of them, and `visibilityRule` in particular is a
 * conditional expression over other fields — publishing it would put the
 * authoring form's branching on a product page.
 */
export const PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS: readonly string[] = [
  'id',
  'flow',
  'requirement',
  'valuePolicy',
  'visibilityRule',
];
