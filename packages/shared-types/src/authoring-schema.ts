/**
 * The server-owned authoring contract (#367 step 5, ADR 0007 D10).
 *
 * ```
 * category + product type (exact version) + attribute definitions (exact versions)
 *         + controlled value policies + store/seller permissions
 *         + flow + locale + market
 *         = AuthoringSchema
 * ```
 *
 * This is the vocabulary the dashboard renders a product form from, and the
 * whole reason it exists is that no React component may hold category-specific
 * truth. Adding a product type has to be a data change; the moment a client
 * knows that "smartphones need a storage capacity", a schema change needs a
 * frontend release and the two go out of step in production.
 *
 * ## The separation that is the point: RULES and TEXT are different objects
 *
 * {@link AuthoringField} carries stable ids and keys, scope, type, requirement,
 * validation, grouping, order and value policy. {@link AuthoringSchemaText}
 * carries the labels, help, placeholders and examples. They are two properties
 * of the response rather than one merged object, and no rule-bearing type here
 * has a `label` property at all.
 *
 * The reason is stated in ADR 0007 D10 and is worth repeating where somebody
 * will be tempted to merge them: a client that read a label as a rule could not
 * localize without changing behaviour. `if (field.label === 'Colour')` works in
 * one locale and silently stops working in the next, and the failure is a form
 * that quietly asks for nothing.
 *
 * ## What a client is NEVER asked to do
 *
 * - **Match on message text.** Every refusal is a
 *   {@link AuthoringValidationCode} plus a {@link AuthoringFieldPath}; the
 *   sentence is localized at the boundary and carries no information the code
 *   does not.
 * - **Compose a schema.** There is no partial shape here: a response is a whole
 *   schema or an error. The DTO deliberately has no "merge these fragments"
 *   affordance.
 * - **Decide what a value MEANS.** {@link AuthoringFieldValidation} is a
 *   PROJECTION of the cited `attribute_definitions` version and is never
 *   authored here. #94's registry is the one authority; this vocabulary can
 *   restate it for one exact version and can never disagree with it, because
 *   there is no writer.
 *
 * ## Versioning
 *
 * {@link AUTHORING_SCHEMA_CONTRACT_VERSION} is the DTO's own shape version and
 * is a different number from the product type's. A draft pins the product type
 * VERSION, the attribute definition VERSIONS, the locale and the market; a newer
 * product-type version produces an {@link AuthoringUpgradePreview} and never a
 * silent rewrite, because the values already stored were answers to the older
 * questions.
 *
 * The tuples below are closed value sets, rendered into the schema's CHECK
 * constraints (`text` + CHECK, never a pg enum). Adding a value is a code change
 * PLUS an additive migration in the SAME pull request.
 */

import type {
  ProductTypeAuthoringFlow,
  ProductTypeFieldRequirement,
  ProductTypeFieldScope,
  ProductTypeLifecycle,
  ProductTypePendingProposalPolicy,
  ProductTypeValuePolicy,
  ProductTypeVisibilityRule,
} from './product-type';
import type {
  AttributeCardinality,
  AttributeComponentAxis,
  AttributeValueType,
  UnitFamily,
} from './attribute-registry';
import type { CurrencyCode } from './money';
import type { LocalizationFallbackStep, LocalizationStatus } from './catalog-localization';

/**
 * The DTO's own shape version.
 *
 * Bumped when a consumer would have to change to read a response correctly —
 * never for an additive optional property, which is what the `readonly` optional
 * members are for. It travels on every response so a client can refuse a shape
 * it does not understand rather than reading a missing property as a rule.
 */
export const AUTHORING_SCHEMA_CONTRACT_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Steps: listing, offer and inventory are COMPOSED, never product-type fields */
/* -------------------------------------------------------------------------- */

/**
 * The ordered steps an authoring surface walks (ADR 0007 D5's closing rule).
 *
 * Price, stock, availability, condition and fulfilment stay in their own
 * domains and are **referenced as separate steps**, never modelled as
 * product-type attributes — which is why #94's
 * `attribute_definitions_reserved_key_check` refuses to define them at all.
 *
 * A step is therefore a POINTER at a domain, and the vocabulary is closed so a
 * client cannot be handed a step it has no screen for.
 */
export type AuthoringStepKind =
  /** Category and product type selection — the two facts everything else pins. */
  | 'classification'
  /** The product-type fields whose scope is `identity` or `product`. */
  | 'product_fields'
  /** The declared variant axes and the variant matrix. */
  | 'variants'
  /** Title, description, images — `listings`' own columns. */
  | 'listing'
  /**
   * What the GOODS are like — #90's nine-key taxonomy, per listing (#572).
   *
   * Its own step and emphatically NOT a product-type field: `condition` and
   * `item_condition` are both in {@link AUTHORING_FORBIDDEN_FIELD_KEYS} and
   * #94's `attribute_definitions_reserved_key_check` refuses to define either,
   * because a condition is a fact about one seller's copy rather than about the
   * product. So the only way an authoring surface can ask the question at all is
   * a composed step pointing at the condition domain, exactly as `offer` points
   * at money and `inventory` at stock.
   */
  | 'condition'
  /** Price and compare-at price — the catalogue's NATIVE-currency money. */
  | 'offer'
  /** Stock, per location. `inventory_levels`' domain. */
  | 'inventory'
  /** The canonical product or variant the author selected, if any. */
  | 'canonical_link';

export const AUTHORING_STEP_KINDS: readonly AuthoringStepKind[] = [
  'classification',
  'product_fields',
  'variants',
  'listing',
  'condition',
  'offer',
  'inventory',
  'canonical_link',
];

/**
 * Attribute keys the authoring schema may never carry as a product-type field,
 * named as VALUES and asserted DISJOINT from what a schema actually composes.
 *
 * This is the same prohibition #94's reserved-key CHECK states one layer down,
 * restated HERE because the failure it prevents is different: the registry stops
 * such an attribute being DEFINED, and this stops a composition presenting a
 * price or a stock level as though it were one — which is what would make a
 * client write `fields.price` and put the money path behind a schema an operator
 * can edit.
 */
export const AUTHORING_FORBIDDEN_FIELD_KEYS: readonly string[] = [
  'price',
  'compare_at_price',
  'availability',
  'stock',
  'inventory',
  'inventory_quantity',
  'shipping_cost',
  'delivery_cost',
  'condition',
  'item_condition',
  'seller',
  'merchant',
  'offer_count',
  'fulfilment',
  'fulfillment',
];

/* -------------------------------------------------------------------------- */
/* Locale and fallback metadata                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which locale actually answered, and how far down the chain it was found.
 *
 * ADR 0007 D4 requires the effective locale and the translation status to travel
 * BESIDE the string rather than instead of it. That is what lets an internal
 * client debug "why is this English" and a public client decide whether to badge
 * a machine translation — neither of which is answerable from the text.
 *
 * `coverage` is the count of localizable strings this response resolved in the
 * requested locale, over the count it emitted. A form that is 12/40 translated
 * is a fact an operator needs and no individual string can state.
 */
export interface AuthoringLocaleContext {
  /** The folded BCP 47 tag the caller asked for. */
  readonly requestedLocale: string;
  /**
   * The locale MOST of this response resolved in. Per-string effective locales
   * differ and travel on {@link AuthoringLocalizedText}; this is the summary.
   */
  readonly effectiveLocale: string;
  readonly step: LocalizationFallbackStep;
  readonly coverage: {
    readonly resolvedInRequestedLocale: number;
    readonly total: number;
  };
}

/**
 * One localized string, with the metadata that makes it debuggable.
 *
 * A string is ABSENT rather than empty when nothing resolved — the
 * `LocalizedResolution` rule one layer down, applied to a payload: a client that
 * wants to show something has to handle the absence, which is what stops a raw
 * key reaching a shopper.
 */
export interface AuthoringLocalizedText {
  readonly value: string;
  readonly effectiveLocale: string;
  readonly step: LocalizationFallbackStep;
  readonly status: LocalizationStatus;
}

/** The localized text for one field. Every member is optional and may be absent. */
export interface AuthoringFieldText {
  readonly label?: AuthoringLocalizedText;
  readonly help?: AuthoringLocalizedText;
  readonly placeholder?: AuthoringLocalizedText;
  readonly example?: AuthoringLocalizedText;
}

/**
 * Every localized string in one response, keyed by the STABLE id of the thing it
 * describes.
 *
 * Keyed by id and never by label, because a label is presentation and an id is
 * identity (ADR 0007 D1). A client renders `text.fields[field.id]?.label` and
 * has no path that could read a rule out of it.
 */
export interface AuthoringSchemaText {
  readonly productTypeName?: AuthoringLocalizedText;
  readonly productTypeDescription?: AuthoringLocalizedText;
  readonly categoryName?: AuthoringLocalizedText;
  readonly groups: Readonly<Record<string, { readonly label?: AuthoringLocalizedText }>>;
  readonly fields: Readonly<Record<string, AuthoringFieldText>>;
  /** Controlled-value labels, keyed by `attribute_enum_values.id`. */
  readonly values: Readonly<Record<string, { readonly label?: AuthoringLocalizedText }>>;
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What THIS caller may do with THIS schema.
 *
 * Composed from the store permissions the request already carries, so a schema
 * and the surface built from it cannot disagree about whether a field is
 * editable. It is a PROJECTION and never an authority: the server re-checks
 * every one of these on the write, because a boolean travelling to a client is a
 * boolean a client can send back.
 */
export interface AuthoringPermissionContext {
  readonly canEditDraft: boolean;
  readonly canPublish: boolean;
  /** Whether this caller may propose a missing controlled value (ADR 0007 D9). */
  readonly canProposeValues: boolean;
  /** Whether this caller may select a canonical entity directly (D10). */
  readonly canSelectCanonicalEntity: boolean;
}

/* -------------------------------------------------------------------------- */
/* The rule half                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One controlled value a field admits.
 *
 * Carries the CANONICAL value — what a stored assignment holds — and never the
 * label, which lives in {@link AuthoringSchemaText}. A per-locale canonical
 * value would make a stored fact mean different things in different markets,
 * which is the identity failure ADR 0007 D1 exists to prevent.
 */
export interface AuthoringControlledValue {
  readonly id: string;
  readonly value: string;
  readonly position: number;
}

/**
 * Everything the cited `attribute_definitions` VERSION says about a value.
 *
 * A projection, resolved once per composition, of one exact version. It is
 * restated here rather than left for the client to fetch because a form has to
 * validate before it submits — but nothing writes it, so it cannot drift: change
 * the meaning and #94 makes you publish a new version, which a draft does not
 * silently adopt.
 */
export interface AuthoringFieldValidation {
  readonly valueType: AttributeValueType;
  readonly cardinality: AttributeCardinality;
  readonly unitFamily: UnitFamily | null;
  readonly baseUnit: string | null;
  readonly ratingScaleMax: number | null;
  readonly currency: CurrencyCode | null;
  readonly componentAxes: readonly AttributeComponentAxis[];
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly decimalPlaces: number | null;
  readonly maxLength: number | null;
  readonly implausibleAbove: number | null;
  readonly implausibleBelow: number | null;
}

/** An ordered authoring section. Its label is in {@link AuthoringSchemaText}. */
export interface AuthoringGroup {
  readonly id: string;
  readonly key: string;
  readonly position: number;
}

/**
 * One field of the composed schema — RULES ONLY.
 *
 * `id` is the `product_type_fields` row id and is what a draft value and a
 * validation path cite. `key` is the attribute's stable machine key and is what
 * a visibility rule reads. Both are stable and neither is presentation.
 */
export interface AuthoringField {
  readonly id: string;
  readonly key: string;
  readonly attributeDefinitionId: string;
  readonly attributeVersion: number;
  readonly scope: ProductTypeFieldScope;
  readonly requirement: ProductTypeFieldRequirement;
  readonly valuePolicy: ProductTypeValuePolicy;
  readonly variantCapable: boolean;
  readonly groupId: string | null;
  readonly position: number;
  readonly visibilityRule: ProductTypeVisibilityRule | null;
  readonly validation: AuthoringFieldValidation;
  readonly controlledValues: readonly AuthoringControlledValue[];
}

/** One step of the authoring flow, in the order a surface should walk them. */
export interface AuthoringStep {
  readonly kind: AuthoringStepKind;
  readonly position: number;
  /** Whether this deployment can complete the step at all. */
  readonly available: boolean;
}

/** The product type this schema was composed from, pinned to its exact version. */
export interface AuthoringProductTypeRef {
  readonly definitionId: string;
  readonly key: string;
  readonly version: number;
  readonly lifecycle: ProductTypeLifecycle;
  readonly pendingProposalPolicy: ProductTypePendingProposalPolicy;
}

/**
 * The whole contract.
 *
 * `etag` is a deterministic hash over every semantic dimension AND the composed
 * body, so two tasks composing the same schema produce the same string and a
 * `304` is safe across a fleet. It is the ONE cache validator: there is no
 * `updatedAt` here to compare instead, deliberately, because a timestamp is a
 * fact about a row and this is a fact about a composition over eleven of them.
 */
export interface AuthoringSchema {
  readonly contractVersion: number;
  readonly productType: AuthoringProductTypeRef;
  readonly categoryId: string;
  readonly flow: ProductTypeAuthoringFlow;
  readonly market: string;
  readonly locale: AuthoringLocaleContext;
  readonly permissions: AuthoringPermissionContext;
  readonly steps: readonly AuthoringStep[];
  readonly groups: readonly AuthoringGroup[];
  readonly fields: readonly AuthoringField[];
  readonly text: AuthoringSchemaText;
  readonly etag: string;
}

/* -------------------------------------------------------------------------- */
/* The category and product-type listings                                      */
/* -------------------------------------------------------------------------- */

/** One selectable category, for the classification step. */
export interface AuthoringCategoryOption {
  readonly id: string;
  readonly key: string;
  readonly parentId: string | null;
  readonly ancestorIds: readonly string[];
  readonly selectable: boolean;
  readonly position: number;
  readonly name?: AuthoringLocalizedText;
}

/** One product type eligible under a category, for the classification step. */
export interface AuthoringProductTypeOption {
  readonly definitionId: string;
  readonly key: string;
  readonly version: number;
  readonly includeDescendants: boolean;
  readonly name?: AuthoringLocalizedText;
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a draft sits.
 *
 * Three states and no `publishing`: publication is ONE transaction (ADR 0007
 * D10), so the row moves `open → published` inside it and a failed publish rolls
 * back to `open` with everything intact. A durable in-flight state would be a
 * state nothing could ever leave if a task died holding it.
 */
export type AuthoringDraftStatus = 'open' | 'published' | 'discarded';

export const AUTHORING_DRAFT_STATUSES: readonly AuthoringDraftStatus[] = [
  'open',
  'published',
  'discarded',
];

/**
 * How one answer is carried.
 *
 * A STRING discriminant, and every branch names exactly one storage column, so
 * "a draft value that is two things at once" has no row shape rather than being
 * refused by a service. The backend compiles with `strict: false`, where a
 * boolean-literal discriminant does not narrow a union at all (#68's finding,
 * #110's again) — that is why this is a string here and everywhere else in the
 * domain.
 */
export type AuthoringValueKind =
  /** A free-text answer — `string` and `date` attributes. */
  | 'text'
  /** A number — `integer`, `decimal`, `measurement`, `money` and `rating`. */
  | 'number'
  | 'boolean'
  /** One of the attribute's own `attribute_enum_values` rows, by id. */
  | 'controlled_value'
  /** A pointer at a canonical entity — a brand, a family. Never a typed name. */
  | 'canonical_reference';

export const AUTHORING_VALUE_KINDS: readonly AuthoringValueKind[] = [
  'text',
  'number',
  'boolean',
  'controlled_value',
  'canonical_reference',
];

/**
 * What a `canonical_reference` value points at.
 *
 * A closed set, because the alternative — a free `entity_type` string — makes
 * "which table does this id live in" a question the reader answers by guessing.
 */
export type AuthoringCanonicalRefKind =
  | 'canonical_product'
  | 'canonical_variant'
  | 'canonical_product_family'
  | 'brand';

export const AUTHORING_CANONICAL_REF_KINDS: readonly AuthoringCanonicalRefKind[] = [
  'canonical_product',
  'canonical_variant',
  'canonical_product_family',
  'brand',
];

/** One stored answer, as a read surface reports it. */
export interface AuthoringDraftValue {
  readonly fieldId: string;
  readonly attributeKey: string;
  readonly scope: ProductTypeFieldScope;
  /** NULL for a product-scope value; the draft variant for a variant-scope one. */
  readonly draftVariantId: string | null;
  /** 0 for a single value; the position within an ordered/multi value otherwise. */
  readonly ordinal: number;
  /** Non-null only for a `structured` attribute's component. */
  readonly componentAxis: AttributeComponentAxis | null;
  readonly kind: AuthoringValueKind;
  readonly text: string | null;
  readonly number: number | null;
  readonly boolean: boolean | null;
  readonly enumValueId: string | null;
  readonly canonicalRefKind: AuthoringCanonicalRefKind | null;
  readonly canonicalRefId: string | null;
  /** The unit the author entered, when the attribute has a unit family. */
  readonly unit: string | null;
}

/** One variant an author is building, before publication mints a real one. */
export interface AuthoringDraftVariant {
  readonly id: string;
  readonly position: number;
  readonly title: string | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly priceAmount: number | null;
  readonly priceCurrency: CurrencyCode | null;
  readonly compareAtPriceAmount: number | null;
  readonly compareAtPriceCurrency: CurrencyCode | null;
  readonly inventoryTracked: boolean;
  readonly inventoryAvailable: number;
  /**
   * The order-independent hash of this variant's `(attributeDefinitionId,
   * normalizedValue)` axis pairs (ADR 0007 D6). Two variants whose axes were
   * entered in different orders collide, by construction.
   */
  readonly axisSignature: string | null;
  /**
   * The canonical configuration the author selected for THIS variant, which the
   * publication links with method `merchant_declared` and never re-matches (D10).
   */
  readonly selectedCanonicalVariantId: string | null;
}

/** A draft, whole. */
export interface AuthoringDraft {
  readonly id: string;
  readonly storeId: string;
  readonly status: AuthoringDraftStatus;
  readonly categoryId: string;
  readonly productType: AuthoringProductTypeRef;
  readonly flow: ProductTypeAuthoringFlow;
  readonly locale: string;
  readonly market: string;
  /** The ETag of the schema this draft's answers were given under. */
  readonly schemaEtag: string;
  /** Optimistic concurrency: every mutation states the version it read. */
  readonly version: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly imageFileIds: readonly string[];
  readonly tags: readonly string[];
  /**
   * The canonical PRODUCT the author selected, which is never re-matched (D10).
   * The configuration is on each variant, because a draft has one product and N
   * configurations.
   */
  readonly selectedCanonicalProductId: string | null;
  readonly publishedListingId: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly variants: readonly AuthoringDraftVariant[];
  readonly values: readonly AuthoringDraftValue[];
}

/* -------------------------------------------------------------------------- */
/* Validation: stable codes and stable paths                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every way a draft can fail validation.
 *
 * A CLOSED set, and the whole reason it exists: ADR 0007 D10 requires stable
 * machine codes and field paths, with the message localized at the boundary. A
 * client that matched on message text would break on the first translation, and
 * the breakage is silent — a form that stops highlighting the field somebody
 * needs to fix.
 *
 * Ordering here is the order a reviewer should read them in — classification,
 * then values, then variants, then publication — and carries no semantics.
 */
export type AuthoringValidationCode =
  // Classification
  | 'category_not_selectable'
  | 'category_not_in_product_type_scope'
  | 'product_type_not_published'
  | 'schema_version_superseded'
  // Field values
  | 'required_field_missing'
  | 'unknown_field'
  | 'field_forbidden_in_flow'
  | 'value_type_mismatch'
  | 'value_not_in_controlled_set'
  | 'value_below_minimum'
  | 'value_above_maximum'
  | 'value_too_long'
  | 'too_many_decimal_places'
  | 'value_implausible'
  | 'cardinality_exceeded'
  | 'structured_component_missing'
  | 'unknown_component_axis'
  /**
   * No unit where the attribute declares a family, OR a unit token the unit
   * registry cannot read.
   *
   * Both are the same fact for an author — "6.1 of what" — and #56's own
   * vocabulary already calls an unreadable spelling `unknown_unit`. What is a
   * DIFFERENT fact is a unit that reads perfectly and measures the wrong thing,
   * which is {@link AuthoringValidationCode}'s `unit_not_in_family`.
   */
  | 'unknown_unit'
  /**
   * A resolvable unit from the wrong DIMENSION — `kg` on a screen size.
   *
   * Its own code because the remedy is different: `unknown_unit` means "spell it
   * so we can read it" and this means "you have measured the wrong property".
   * Reported separately rather than folded in, so a form can say which.
   */
  | 'unit_not_in_family'
  | 'currency_mismatch'
  | 'canonical_reference_not_permitted'
  | 'proposal_not_permitted'
  /**
   * A `range` cardinality whose low bound is above its high bound.
   *
   * A range is exactly two magnitudes in ordinal order, and an inverted pair is
   * not a smaller range — every comparison against it is false, so it filters
   * nothing and looks like a value nobody entered.
   */
  | 'range_bounds_inverted'
  // Variants
  | 'no_variant_declared'
  | 'variant_axis_not_permitted'
  | 'variant_missing_axis_value'
  | 'duplicate_variant_signature'
  /**
   * Two variants of one draft carry the same SKU. A WARNING, deliberately.
   *
   * `product_variants.sku` is unique at NO grain and #296 dropped the index that
   * pretended otherwise — Shopify enforces no SKU uniqueness at all, so one
   * product legitimately carries two variants sharing one. Refusing publication
   * would re-impose in the authoring surface exactly the constraint the schema
   * removed for being wrong about real data.
   *
   * It is still REPORTED, because the consequence is real and invisible:
   * `matchIncomingVariant` and `resolveInventoryVariant` both REFUSE to pick
   * between several candidates, so the connector pull and the inventory push
   * rails cannot address either of these variants by SKU afterwards.
   */
  | 'duplicate_variant_sku'
  /**
   * A variant `barcode` whose digit length names a GS1 GTIN scheme and whose
   * mod-10 check digit does not hold. A WARNING, like its SKU neighbour.
   *
   * `identifiers.ts` calls a transcription error "the single most common way a
   * real catalogue asserts an identifier that belongs to a different product"
   * and REFUSES it — but it refuses it at the canonical write, into
   * `product_identifiers`, which is a global fact about a trade item.
   * `product_variants.barcode` is not that: it is free text, unique at no
   * grain, and a thirteen-digit internal article number is an ordinary thing to
   * keep in it. Nothing can tell one of those from a mistyped EAN, so blocking
   * would leave a merchant whose only remedy is deleting a true value.
   *
   * Only the four GS1 digit lengths raise it — see `GTIN_SCHEME_BY_LENGTH` in
   * `services/catalog-authoring/identifier.ts`. A barcode that is not a digit
   * string of one of those lengths is left ALONE rather than reported.
   */
  | 'identifier_check_digit_invalid'
  /**
   * Two variants of one draft assert the same barcode. A WARNING, and for the
   * same reason `duplicate_variant_sku` is one.
   *
   * `IDENTIFIER_SCHEME_REGISTRY` declares every GTIN scheme
   * `globallyUnique: true`, which is a fact about the IDENTIFIER SPACE — a GTIN
   * names one trade item worldwide. It is not a rule about what a merchant's
   * draft may assert, and this schema deliberately enforces no uniqueness on
   * `product_variants.barcode` at all. Merchants do put one manufacturer
   * barcode on two configurations; reporting it is useful, refusing it would
   * re-impose a constraint the schema removed on purpose.
   */
  | 'duplicate_variant_barcode'
  /**
   * The barcode is an ACTIVE identifier of a canonical product OTHER than the
   * one the author selected. A WARNING, and the severity is the load-bearing
   * part.
   *
   * It is not an error because the catalogue's own posture on a conflicting
   * identifier is to RECORD the dispute rather than refuse it: `assignIdentifier`
   * answers `disputed` and keeps both rows, and #58's
   * `match_decisions_blockers_auto_check` already makes a conflicting valid
   * identifier unable to auto-merge. Blocking here would let one catalogue row —
   * possibly itself under dispute, and not editable by this merchant — stop a
   * publication, while the merge it might contaminate is refused by a CHECK
   * either way.
   *
   * It fires only when the draft names a `selectedCanonicalProductId`. With no
   * selection there is no contradiction to report: an owned barcode is then
   * evidence the author picked the right product, which is what the matcher is
   * for.
   */
  | 'identifier_collision'
  | 'price_missing'
  | 'price_currency_missing'
  | 'inventory_negative'
  // Listing
  | 'title_missing'
  | 'description_missing'
  /**
   * The flow requires a stated condition and the draft has none (#572).
   *
   * Only the flows in `CONDITION_REQUIRED_AUTHORING_FLOWS` raise it — `p2p`
   * today. Everywhere else an unstated condition is filled from
   * `AUTHORING_DEFAULT_MERCHANT_CONDITION`, openly, and publishes.
   *
   * It is an ERROR rather than a warning because the alternative is not a gap in
   * a form: it is `new` / `seller_declared` written onto the listing in the
   * seller's own name, about goods nobody described.
   */
  | 'condition_missing'
  /**
   * The flow expects the listing to carry at least one image and it carries
   * none. A WARNING; the flow tuple is `MEDIA_EXPECTED_AUTHORING_FLOWS`.
   *
   * The other half of "validate media/condition requirements separately from
   * canonical product facts". #90 draws condition evidence from the listing's
   * OWN gallery and refuses a `file_id` any `canonical_images` row already
   * claims, so a `p2p` draft — which `CONDITION_REQUIRED_AUTHORING_FLOWS`
   * already obliges to state a condition — with no photograph of its own has
   * asserted a condition it can supply no evidence for, and the catalogue's
   * picture of the model is barred from standing in.
   *
   * It is a WARNING and not an error because no surface in this repository can
   * obtain an Oxy file id — there is no upload path, and the dashboard wizard
   * renders a notice saying so where a picker would go. An error would be a
   * gate whose only green is unreachable. `MEDIA_EXPECTED_AUTHORING_FLOWS`
   * carries the full reasoning and the condition under which it escalates.
   *
   * This is about the LISTING's media and reaches no canonical image, which is
   * what "separately from canonical product facts" asks for.
   */
  | 'media_missing'
  /**
   * The same Oxy `file_id` appears twice in one draft's `imageFileIds`. A
   * WARNING — the `duplicate_variant_sku` posture.
   *
   * A gallery rendering one photograph twice is a defect and not a false
   * assertion, and the position ordering downstream reads as two distinct
   * slots. Nothing about the file's CONTENT is checked here or anywhere in this
   * domain: Mercaria stores bare Oxy file ids, holds no service credential to
   * read their metadata, and a check that claimed to confirm a file exists
   * would be a mechanism nobody built.
   */
  | 'duplicate_media_file'
  // Publication
  | 'proposal_pending_blocks_publication'
  | 'draft_not_open';

export const AUTHORING_VALIDATION_CODES: readonly AuthoringValidationCode[] = [
  'category_not_selectable',
  'category_not_in_product_type_scope',
  'product_type_not_published',
  'schema_version_superseded',
  'required_field_missing',
  'unknown_field',
  'field_forbidden_in_flow',
  'value_type_mismatch',
  'value_not_in_controlled_set',
  'value_below_minimum',
  'value_above_maximum',
  'value_too_long',
  'too_many_decimal_places',
  'value_implausible',
  'cardinality_exceeded',
  'structured_component_missing',
  'unknown_component_axis',
  'unknown_unit',
  'unit_not_in_family',
  'currency_mismatch',
  'canonical_reference_not_permitted',
  'proposal_not_permitted',
  'range_bounds_inverted',
  'no_variant_declared',
  'variant_axis_not_permitted',
  'variant_missing_axis_value',
  'duplicate_variant_signature',
  'duplicate_variant_sku',
  'identifier_check_digit_invalid',
  'duplicate_variant_barcode',
  'identifier_collision',
  'price_missing',
  'price_currency_missing',
  'inventory_negative',
  'title_missing',
  'description_missing',
  'condition_missing',
  'media_missing',
  'duplicate_media_file',
  'proposal_pending_blocks_publication',
  'draft_not_open',
];

/**
 * How severe one finding is.
 *
 * `error` blocks publication; `warning` does not. The distinction is what makes
 * `recommended` a real requirement level rather than a synonym for `optional` —
 * a recommended field that is empty is reported, visibly, and still publishes.
 */
export type AuthoringValidationSeverity = 'error' | 'warning';

export const AUTHORING_VALIDATION_SEVERITIES: readonly AuthoringValidationSeverity[] = [
  'error',
  'warning',
];

/**
 * A stable path into the draft, in the ONE spelling every producer uses.
 *
 * `fields.<attributeKey>` · `fields.<attributeKey>[<ordinal>]` ·
 * `variants[<position>].price` · `variants[<position>].fields.<attributeKey>` ·
 * `listing.title` · `classification.categoryId`.
 *
 * A string alias rather than a structured object, because the value a client
 * needs is exactly a key into its own form state — and a structured path would
 * be a second representation of one fact, which two producers would eventually
 * spell differently.
 */
export type AuthoringFieldPath = string;

/** One validation finding. The message is composed at the HTTP boundary. */
export interface AuthoringValidationFinding {
  readonly code: AuthoringValidationCode;
  readonly severity: AuthoringValidationSeverity;
  readonly path: AuthoringFieldPath;
  /**
   * The field this is about, when it is about one. Absent for a classification
   * or publication finding, which are about the draft.
   */
  readonly fieldId?: string;
  readonly attributeKey?: string;
}

/**
 * The verdict.
 *
 * `publishable` is DERIVED from the findings (no error) rather than stored
 * beside them, so the two can never disagree — the one-verdict rule applied to a
 * response body.
 */
export interface AuthoringValidationResult {
  readonly publishable: boolean;
  readonly findings: readonly AuthoringValidationFinding[];
  /** The schema ETag the draft was validated against. */
  readonly schemaEtag: string;
}

/* -------------------------------------------------------------------------- */
/* The publication result                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How a published variant came to carry the canonical configuration it carries
 * — and, deliberately, NOT what the matcher decided.
 *
 * `syncListingFacets` requests a match for every variant AFTER the publishing
 * transaction commits, so at the moment this result is composed the matcher has
 * not run. `matched` and `unmatched` are therefore not members and cannot be:
 * the only honest statements are that a person resolved this variant, or that
 * nobody has yet and #58 owns it.
 */
export type AuthoringVariantResolution =
  /**
   * The author selected the configuration; the `merchant_declared` link is
   * written and `MATCHER_MAY_DISPLACE` stops an automatic match moving it
   * (ADR 0007 D10).
   */
  | 'merchant_declared'
  /** No author selection. The matcher owns this variant and has not decided. */
  | 'queued_for_matching';

export const AUTHORING_VARIANT_RESOLUTIONS: readonly AuthoringVariantResolution[] = [
  'merchant_declared',
  'queued_for_matching',
] as const;

/**
 * One published variant.
 *
 * `position` is the pairing, and it is the reason this is worth returning at
 * all: a draft variant and its `product_variants` row share a position, and that
 * is a fact the publishing join has in hand. A client re-deriving it has only
 * titles and prices two variants can legitimately share.
 *
 * IDs appear where a caller can act on them and COUNTS where a caller can only
 * check that the publication was whole. An axis assignment id and a claim id
 * address rows no merchant surface addresses; their counts are what tell a
 * caller a variant did not land half-written.
 */
export interface AuthoringPublishedVariant {
  /** The draft variant this was published from. */
  readonly draftVariantId: string;
  /** Shared by the draft variant and the listing variant. */
  readonly position: number;
  readonly productVariantId: string;
  readonly resolution: AuthoringVariantResolution;
  /**
   * The linked canonical configuration — present exactly when `resolution` is
   * `merchant_declared`, because the only link this path writes is the author's.
   */
  readonly canonicalVariantId: string | null;
  /** ADR 0007 D6's typed identity for this variant, as stored. */
  readonly axisSignature: string | null;
  readonly axisAssignmentCount: number;
  readonly merchantDeclaredClaimCount: number;
}

/**
 * What is still owed on a publication, at the moment it is answered.
 *
 * Every field here is a fact about the LISTING and the DRAFT, never a prediction
 * and never a verdict.
 */
export interface AuthoringPublicationReview {
  readonly merchantDeclaredCount: number;
  /** Variants #58's matcher owns. Not a claim that it will fail to match them. */
  readonly queuedForMatchingCount: number;
  /**
   * Attribute claims for THIS listing that landed queued for review.
   *
   * The authoring path writes its claims already `resolved`, so this is reliably
   * zero today — which is why reporting it costs nothing, and why it must be
   * reported rather than assumed: the day a value stops resolving, a caller
   * finds out from the publication instead of from a review queue nobody
   * attributed.
   */
  readonly queuedAttributeClaimCount: number;
  /**
   * Proposals still open against the draft.
   *
   * Non-empty only under a product type version whose `pendingProposalPolicy` is
   * `allow_local_claim`: `block_publication` refuses the publish outright, so a
   * published listing under that policy has none. This is the one moment the
   * author can be told that the value they proposed is still somebody else's
   * decision.
   */
  readonly openProposalIds: readonly string[];
}

/**
 * A complete publication (#367 step 5's "return a complete publication result").
 *
 * ## It describes the LISTING, not what this call happened to write
 *
 * A convergence — a retry whose first response was lost — created nothing this
 * time, and it is the case the publish endpoint exists to serve. If this were
 * accumulated as the transaction went, the converging answer would be the thin
 * one, which would make retrying (the safe client behaviour) the one that loses
 * information. So every field is DERIVED from the published listing and its
 * draft, and `published` and `converged` answer identically by construction.
 *
 * That is also why no field is named "created".
 */
export interface AuthoringPublicationResult {
  /**
   * Carried in the BODY as well as by the status code (201 / 200), because a
   * client that has to read a status code to know which of two shapes it holds
   * will eventually read neither.
   */
  readonly outcome: 'published' | 'converged';
  readonly listingId: string;
  /** Axes the listing declares (ADR 0007 D6's authoritative list). */
  readonly declaredAxisCount: number;
  /** Product-scope assertions recorded for the listing. */
  readonly listingClaimCount: number;
  readonly variants: readonly AuthoringPublishedVariant[];
  readonly review: AuthoringPublicationReview;
}

/* -------------------------------------------------------------------------- */
/* The upgrade preview                                                         */
/* -------------------------------------------------------------------------- */

/** What a newer product-type version does to one of a draft's answers. */
export type AuthoringUpgradeEffect =
  /** The field still exists with the same cited attribute version. */
  | 'unchanged'
  /** The field exists but cites a NEWER attribute definition version. */
  | 'attribute_version_changed'
  /** The field's requirement changed in this flow. */
  | 'requirement_changed'
  /** The newer version does not declare this field for this flow. */
  | 'field_removed'
  /** The newer version declares a field the draft has no answer for. */
  | 'field_added'
  /** The stored value is no longer in the field's controlled set. */
  | 'value_no_longer_permitted';

export const AUTHORING_UPGRADE_EFFECTS: readonly AuthoringUpgradeEffect[] = [
  'unchanged',
  'attribute_version_changed',
  'requirement_changed',
  'field_removed',
  'field_added',
  'value_no_longer_permitted',
];

/** One line of the preview. */
export interface AuthoringUpgradeChange {
  readonly effect: AuthoringUpgradeEffect;
  readonly attributeKey: string;
  readonly path: AuthoringFieldPath;
  readonly fromRequirement?: ProductTypeFieldRequirement;
  readonly toRequirement?: ProductTypeFieldRequirement;
  readonly fromAttributeVersion?: number;
  readonly toAttributeVersion?: number;
}

/**
 * What moving a draft to a newer product-type version would do — and NOTHING
 * else.
 *
 * ADR 0007 D10: a newer schema version produces a preview, never a silent
 * rewrite. So this type has no `apply` affordance and no result: it is a
 * description an author reads before deciding, and applying it is a separate,
 * explicit request that re-pins the draft.
 *
 * The `available: false` branch carries no `changes` and no target, so a caller
 * cannot render a preview of an upgrade that does not exist.
 */
export type AuthoringUpgradePreview =
  | {
      readonly outcome: 'up_to_date';
      readonly currentVersion: number;
    }
  | {
      readonly outcome: 'upgrade_available';
      readonly currentVersion: number;
      readonly targetVersion: number;
      readonly targetDefinitionId: string;
      readonly changes: readonly AuthoringUpgradeChange[];
      /** Whether any change would drop or invalidate a stored answer. */
      readonly losesAnswers: boolean;
    };

/**
 * Why a PUBLISHED listing cannot be moved forward, even though a newer version
 * exists (#587).
 *
 * A closed set, and both members name a mechanical reason rather than a policy:
 *
 * - `variant_axis_not_authorised` — the listing declares a variant axis the
 *   target version does not declare as a `variant_capable`, `variant`-scope
 *   field. That is `mercaria_native_variant_axis_citation`'s own predicate,
 *   applied at the listing grain: an axis row naming the target for that
 *   attribute is a row the database would REFUSE, so moving the listing onto it
 *   would reach that state through the one door the trigger does not watch. It
 *   is not repairable by moving the axes either —
 *   `mercaria_native_variant_axis_frozen` makes an axis's cited version
 *   immutable, and the only way to re-cite one is to retire and re-declare it,
 *   which cascades every assignment away. Refusing is the sole non-destructive
 *   answer.
 * - `listing_not_editable` — the listing is `restricted` or `archived`. Moving a
 *   pin is an EDIT, and `catalog-write.service.updateListing` refuses to edit a
 *   restricted listing at all; reaching one through a different function is the
 *   moderation escape that rule exists to close.
 */
export type ListingUpgradeBlocker = 'variant_axis_not_authorised' | 'listing_not_editable';

export const LISTING_UPGRADE_BLOCKERS: readonly ListingUpgradeBlocker[] = [
  'variant_axis_not_authorised',
  'listing_not_editable',
];

/** One reason, with the thing it is about. */
export interface ListingUpgradeBlockerDetail {
  readonly blocker: ListingUpgradeBlocker;
  /** The attribute key for `variant_axis_not_authorised`; absent otherwise. */
  readonly attributeKey?: string;
  /** Operator-facing, bounded, and never a stack trace. */
  readonly detail: string;
}

/**
 * What moving a PUBLISHED listing to a newer product-type version would do.
 *
 * The listing twin of {@link AuthoringUpgradePreview}, and it carries the same
 * rule for the same reason (ADR 0007 D10): a newer schema version produces a
 * preview, never a silent rewrite. There is no `apply` affordance on the type.
 *
 * `blocked` carries **no `targetDefinitionId`**, which is the same device the
 * draft preview uses on its unavailable branch: the apply takes that id, so a
 * caller holding only a blocked preview has nothing to send. It DOES carry the
 * changes, because an operator deciding what to fix first needs to see what the
 * move would have done.
 */
export type ListingProductTypeUpgradePreview =
  | {
      /**
       * The listing is pinned to no product-type version — every P2P listing,
       * and every store listing created outside the authoring flow. There is
       * nothing to move forward, and a FIRST pin is not this operation.
       */
      readonly outcome: 'not_pinned';
    }
  | {
      readonly outcome: 'up_to_date';
      readonly currentVersion: number;
    }
  | {
      readonly outcome: 'blocked';
      readonly currentVersion: number;
      readonly targetVersion: number;
      readonly changes: readonly AuthoringUpgradeChange[];
      readonly blockers: readonly ListingUpgradeBlockerDetail[];
    }
  | {
      readonly outcome: 'upgrade_available';
      readonly currentVersion: number;
      readonly targetVersion: number;
      readonly targetDefinitionId: string;
      readonly changes: readonly AuthoringUpgradeChange[];
      /**
       * Whether any change would leave something the listing already recorded
       * without a field in the new version.
       *
       * Reported and NEVER acted on: nothing in the apply deletes or rewrites a
       * stored answer. Every claim keeps the attribute version it was settled
       * under, and a field the target no longer declares becomes a visible
       * finding rather than a deletion — deleting it would be the silent
       * rewrite ADR 0007 D10 forbids, wearing a tidy-up's clothes.
       */
      readonly losesAnswers: boolean;
    };

/** What one applied listing upgrade moved. */
export interface ListingProductTypeUpgradeResult {
  readonly listingId: string;
  readonly fromDefinitionId: string;
  readonly fromVersion: number;
  readonly toDefinitionId: string;
  readonly toVersion: number;
}

/* -------------------------------------------------------------------------- */
/* Canonical search                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One canonical entity an author may select.
 *
 * Deliberately thin: an id, a kind, a name and the identifiers that make two
 * similar-looking products distinguishable. It carries no offer, no price and no
 * merchant — the authoring surface is choosing an IDENTITY, and putting a price
 * beside it would invite a seller to pick the row with the number they liked.
 */
export interface AuthoringCanonicalCandidate {
  readonly kind: AuthoringCanonicalRefKind;
  readonly id: string;
  readonly name: string;
  readonly brandName: string | null;
  /** `gtin`, `mpn`, … → the value. The keys are #56's identifier schemes. */
  readonly identifiers: Readonly<Record<string, string>>;
  readonly canonicalProductId: string | null;
}

export interface AuthoringCanonicalSearchResult {
  readonly candidates: readonly AuthoringCanonicalCandidate[];
  /**
   * Whether the query was an EXACT identifier match.
   *
   * A client shows an exact identifier hit differently from a name search, and
   * the difference is not cosmetic: an author confirming a barcode is making a
   * far stronger statement than one picking the closest-looking name, and
   * `merchant_declared` records both as the same method.
   */
  readonly exactIdentifierMatch: boolean;
}

/* -------------------------------------------------------------------------- */
/* Cache invalidation subjects                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What an authoring-schema cache entry depends on that is NOT frozen.
 *
 * ADR 0007 D10 requires cache invalidation to be transactional rather than
 * process-local, because Mercaria runs several ECS tasks and a process-local
 * cache is one task's opinion. The mechanism is
 * `catalog_authoring_schema_invalidations`: a transactional revision per
 * subject, read INTO the cache key rather than pushed at a listener.
 *
 * The subjects are exactly the things that can change under a composition whose
 * product-type version and attribute definition versions are already frozen by
 * their own triggers — controlled values, localizations and the category.
 */
export type AuthoringInvalidationSubject =
  /** One `attribute_definitions` row's controlled values changed. */
  | 'attribute_values'
  /** A localization row for one entity changed. */
  | 'localization'
  /** A category's lifecycle, selectability or presentation changed. */
  | 'category'
  /** A product type version's scopes, groups or fields changed (drafts only). */
  | 'product_type';

export const AUTHORING_INVALIDATION_SUBJECTS: readonly AuthoringInvalidationSubject[] = [
  'attribute_values',
  'localization',
  'category',
  'product_type',
];
