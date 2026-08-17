/**
 * Compatibility and automotive fitment — issue #367 merge-order step 8, bound by
 * ADR 0007 **D8**, and constrained by D1 (identity is an opaque id plus a stable
 * machine key, never a label), D6 (an axis is an attribute, and a compatibility
 * target is refused as one), D7 (a source's claim and a canonical fact are
 * different rows) and D13 (nothing existing is re-modelled).
 *
 * "Does this fit?" is a RELATIONSHIP between two catalogue identities, and the
 * whole of this domain exists because the tempting alternative — writing the
 * answer into the product's variant axes — destroys the product. One brake-pad
 * SKU fits eleven hundred vehicles; expressed as options that is one SKU with
 * eleven hundred variants, no stock anybody can count, no offer anybody can
 * compare and a canonical variant signature that means nothing. **A year range,
 * a make or a model may never be stored as a variant option** is therefore the
 * epic's own acceptance scenario, and it is held here by the ABSENCE of any
 * writer for the option tables plus `compatibility-isolation.test.ts`.
 *
 * ## The six distinctions this file makes STRUCTURAL
 *
 * 1. **Unknown is not false.** {@link COMPATIBILITY_APPLICABILITIES} has four
 *    members and `does_not_apply` is a different value from `unknown`, not a
 *    nullable boolean's two faces. A shopper told "does not fit" ACTS on it —
 *    they buy something else, or they return the part they already bought — so
 *    reporting an absence of data as a refusal is a wrong answer with a
 *    consequence, and reporting a refusal as an absence sells somebody a part
 *    that will not go on their car. {@link resolveApplicability} is the severity
 *    rule that keeps them apart, and it never resolves to `applies` from a set
 *    containing anything else.
 * 2. **A title can never establish a fit.**
 *    {@link COMPATIBILITY_VERIFICATION_METHODS} has no `title_similarity`,
 *    `name_match` or `category_match` member, so "verified because the names
 *    looked alike" has no value to be stored as — #55's device, and the reason
 *    is sharper here: two products whose titles match to four decimal places are
 *    routinely a 2016 part and a 2017 part that do not interchange.
 *    {@link COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS} names the seven
 *    prohibitions as VALUES and a test asserts the two unions are disjoint.
 * 3. **A claim and a selected fact are different rows** (D7). A manufacturer, a
 *    feed, a merchant or a matcher asserts into `compatibility_claims`, verbatim
 *    and with its raw target text intact; the canonical answer lives in
 *    `generic_compatibility_relations` / `automotive_fitments`. A claim never
 *    becomes canonical by being stored, and a canonical fact never overwrites
 *    the claim that disagreed with it — which is what makes a correction
 *    auditable, and what leaves an UNRESOLVED claim visible rather than guessed
 *    at (D6's "ambiguous stays text and stays unresolved", one domain over).
 * 4. **`target_to_subject` is unrepresentable.**
 *    {@link COMPATIBILITY_DIRECTIONS} has two members, not three: the reverse of
 *    a directed claim is the SAME fact with the endpoints swapped, and storing
 *    it as a third direction would let one relationship be written two ways and
 *    then disagree with itself. Reverse lookup is an index, not a second row.
 * 5. **A typed target is a KEY, never a label** (D1). {@link TypedCompatibilityTarget}
 *    carries a namespaced machine key and no display string at all; the
 *    localized name of `connector.usb_c` belongs to the localization family
 *    (D4), which is a different module and a different agent's territory.
 *    A label stored here would be a second identity for the concept.
 * 6. **Specificity is what makes an EXCLUSION work.**
 *    {@link FITMENT_TARGET_SCOPES} is ordered from broadest to narrowest, and
 *    {@link resolveFitment} lets a narrow `does_not_apply` beat a broad
 *    `applies`. That single ordering is why exclusions need no separate table
 *    and no `is_exclusion` boolean: an exclusion is a fitment row at a narrower
 *    scope whose applicability is `does_not_apply`, so the mechanism that
 *    records "fits the 2016–2019 generation" is the mechanism that records "but
 *    not the ones with the sport suspension".
 *
 * ## What this file deliberately does NOT define
 *
 * - **No variant option, axis, signature or option value of any kind.** There is
 *   no type here a caller could pass to the option path, which is the whole
 *   point. D6's axis CHECK (refusing a compatibility target as an axis) is the
 *   OTHER half and belongs to merge-order step 4; the two are independent walls
 *   around one hole.
 * - **No brand or organization relationship.** #55 owns
 *   `commerce_relationships`, and a compatibility claim is a DIFFERENT claim: it
 *   is about two products interoperating, carries no badge, grants no standing
 *   and is asserted routinely by parties with no authority over either brand.
 *   Sharing #55's vocabulary would make "verified" mean two things.
 * - **No ranking input.** #74 owns ranking behind its versioned policy, and
 *   "fits your vehicle" is an eligibility fact a shopper asked for, not a weight.
 * - **No price, stock, offer or seller.** Those are #57's and the listing's.
 *   A fitment says a part goes on a car; it says nothing about whether anybody
 *   is selling it today.
 * - **No VIN.** A vehicle identification number identifies one physical car
 *   somebody owns, which makes it personal data with a garage's worth of history
 *   attached. {@link COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS} names it, and no
 *   column in the domain could hold one.
 */

// ---------------------------------------------------------------------------
// Generic compatibility — the relation itself
// ---------------------------------------------------------------------------

/**
 * What KIND of compatibility one catalogue identity has with another.
 *
 * Eight members, each of which a shopper reads differently and each of which a
 * surface renders in a different place: an accessory belongs on a "goes with
 * this" shelf, a replacement part belongs in a service context, and a successor
 * belongs on the discontinued product's own page. A single `compatible_with`
 * would collapse all three into a list nobody can order.
 *
 * `supersedes` is the one worth reading twice: it points from the NEW product to
 * the old one, always, so "what replaced this" is the reverse lookup and
 * "replaced_by" is not a second kind. That is {@link COMPATIBILITY_DIRECTIONS}'
 * rule applied to a kind.
 */
export type CompatibilityRelationKind =
  /** A case, a strap, a charger, a lens — sold separately, adds to the target. */
  | 'accessory_for'
  /** A brake pad, a filter, a screen — replaces a part OF the target. */
  | 'replacement_part_for'
  /** Ink, pods, blades, bags — used up by the target and re-bought. */
  | 'consumable_for'
  /** The subject does not function without the target present. */
  | 'requires'
  /** Both operate together; neither is a part or an accessory of the other. */
  | 'works_with'
  /** Software, firmware or an app that supports the target device. */
  | 'software_supports_device'
  /** A bracket, rail, adapter plate or mount that physically attaches. */
  | 'mounts_to'
  /** The subject is the manufacturer's successor to the target. */
  | 'supersedes';

export const COMPATIBILITY_RELATION_KINDS: readonly CompatibilityRelationKind[] = [
  'accessory_for',
  'replacement_part_for',
  'consumable_for',
  'requires',
  'works_with',
  'software_supports_device',
  'mounts_to',
  'supersedes',
];

/**
 * Whether the claim reads one way or both.
 *
 * **There is no `target_to_subject` member, deliberately.** "B fits A" is the
 * row "A fits B" with its endpoints swapped, and admitting both spellings means
 * one fact has two rows that can be verified separately, expire separately and
 * eventually contradict each other. The writer picks the subject; the reader
 * gets the reverse for free from an index.
 *
 * `mutual` exists because `works_with` genuinely is symmetric and forcing a
 * direction onto it would make the choice of subject arbitrary — and an
 * arbitrary choice is one a second source makes differently, producing exactly
 * the duplicate the missing third member prevents.
 */
export type CompatibilityDirection = 'subject_to_target' | 'mutual';

export const COMPATIBILITY_DIRECTIONS: readonly CompatibilityDirection[] = [
  'subject_to_target',
  'mutual',
];

/**
 * The four-valued applicability, and the reason it is not a boolean.
 *
 * - `applies` — it fits, on the terms this row states.
 * - `partially_applies` — it fits some of what the target names, and the row
 *   says which through its conditions. A generation-wide claim that holds only
 *   for the pre-facelift cars is this, not `applies`.
 * - `does_not_apply` — a POSITIVE statement that it does not fit. Somebody
 *   established this; it is not the absence of a claim.
 * - `unknown` — nobody has established anything. Distinct from `does_not_apply`
 *   in both directions, and the distinction has consequences at the till.
 *
 * A nullable boolean can express three of these and conflates the two that
 * matter most, which is why this is a four-member tuple and why
 * `automotive_fitments` and `generic_compatibility_relations` both carry it as
 * a NOT NULL column rather than as `fits boolean`.
 */
export type CompatibilityApplicability =
  | 'applies'
  | 'partially_applies'
  | 'does_not_apply'
  | 'unknown';

export const COMPATIBILITY_APPLICABILITIES: readonly CompatibilityApplicability[] = [
  'applies',
  'partially_applies',
  'does_not_apply',
  'unknown',
];

/**
 * Severity order, worst first — the `deriveRetailCompleteness` device (#120),
 * and #121's verdict rule, applied to a fit.
 *
 * Read by {@link resolveApplicability}. `does_not_apply` beats `unknown` beats
 * `partially_applies` beats `applies`, so a set of claims about one pairing can
 * only ever resolve UPWARD in caution. The ordering is exported because
 * `automotive_fitments`' resolution and the generic relation's both use it, and
 * two spellings of one precedence rule can disagree.
 */
export const COMPATIBILITY_APPLICABILITY_SEVERITY: readonly CompatibilityApplicability[] = [
  'does_not_apply',
  'unknown',
  'partially_applies',
  'applies',
];

/**
 * Resolve several statements about ONE pairing at ONE specificity into one.
 *
 * Pure, total, and deliberately pessimistic: an empty set is `unknown` (nobody
 * said anything, which is exactly what `unknown` means), and any single
 * `does_not_apply` wins however many `applies` sit beside it. Selling somebody a
 * part one source says will not fit is the failure this function exists to
 * prevent, and the cost of the rule — a stale exclusion suppressing a real fit
 * until an operator retires it — is visible, correctable and not a refund.
 */
export function resolveApplicability(
  values: readonly CompatibilityApplicability[],
): CompatibilityApplicability {
  let resolved: CompatibilityApplicability = 'unknown';
  let resolvedRank = COMPATIBILITY_APPLICABILITY_SEVERITY.indexOf('unknown');
  let seen = false;
  for (const value of values) {
    const rank = COMPATIBILITY_APPLICABILITY_SEVERITY.indexOf(value);
    if (rank < 0) continue;
    if (!seen || rank < resolvedRank) {
      resolved = value;
      resolvedRank = rank;
    }
    seen = true;
  }
  return seen ? resolved : 'unknown';
}

/**
 * The conditions under which a compatibility claim holds.
 *
 * A closed vocabulary rather than free text, because a condition is the thing a
 * surface has to be able to SHOW beside the answer — "fits, but you need an
 * adapter" is a different purchase from "fits" — and prose cannot be rendered
 * into a chip, filtered on, or translated. The human sentence still exists, in
 * the row's `condition_note`, and it is presentation beside these facts rather
 * than instead of them.
 *
 * `excludes_configuration` is the one that overlaps the automotive side on
 * purpose: on a vehicle the exclusion is a narrower FITMENT ROW (see
 * {@link FITMENT_TARGET_SCOPES}), and on a generic target — where there is no
 * scope ladder to descend — it is a condition on the claim that does hold.
 */
export type CompatibilityConditionKind =
  | 'requires_adapter'
  | 'requires_firmware_version'
  | 'requires_additional_part'
  | 'requires_professional_installation'
  | 'requires_tool'
  | 'market_restricted'
  | 'quantity_required'
  | 'excludes_configuration'
  | 'production_period_restricted';

export const COMPATIBILITY_CONDITION_KINDS: readonly CompatibilityConditionKind[] = [
  'requires_adapter',
  'requires_firmware_version',
  'requires_additional_part',
  'requires_professional_installation',
  'requires_tool',
  'market_restricted',
  'quantity_required',
  'excludes_configuration',
  'production_period_restricted',
];

/**
 * The verification lifecycle of a compatibility claim.
 *
 * Six members, and `disputed` is the divergence from #55's five that earns this
 * its own tuple rather than sharing `RELATIONSHIP_VERIFICATION_STATES`. A brand
 * relationship has one truth and a rival claimant is a DISPUTE about who holds
 * it; a compatibility claim can have two well-sourced parties flatly
 * contradicting each other about the same pairing — the manufacturer's catalogue
 * and an aftermarket supplier's, routinely — and that state has to be storable
 * without either being called `rejected`. A `disputed` relation publishes
 * `unknown`, never a side.
 */
export type CompatibilityVerificationState =
  | 'candidate'
  | 'verified'
  | 'disputed'
  | 'rejected'
  | 'expired'
  | 'revoked';

export const COMPATIBILITY_VERIFICATION_STATES: readonly CompatibilityVerificationState[] = [
  'candidate',
  'verified',
  'disputed',
  'rejected',
  'expired',
  'revoked',
];

/**
 * HOW a claim was verified. The absences are the content of this tuple.
 *
 * Every member names something that was actually checked against the world: a
 * manufacturer said so in a document that has a digest, an OEM part number
 * matched, somebody physically fitted one, a standard was conformed to, or two
 * independent sources agreed. None of them can be satisfied by two strings
 * looking alike, which is what {@link COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS}
 * makes explicit and a test makes disjoint.
 */
export type CompatibilityVerificationMethod =
  /** A manufacturer's own published fitment or accessory list, with its digest. */
  | 'manufacturer_publication'
  /** The subject carries the target manufacturer's own part number for the part. */
  | 'oem_part_number_match'
  /** A named operator reviewed the claim and its evidence. */
  | 'operator_review'
  /** Somebody fitted one and recorded the result. */
  | 'physical_test'
  /** Both sides conform to a published standard that guarantees interoperation. */
  | 'standards_conformance'
  /** Two INDEPENDENT sources assert the same pairing on the same terms. */
  | 'cross_source_corroboration';

export const COMPATIBILITY_VERIFICATION_METHODS: readonly CompatibilityVerificationMethod[] = [
  'manufacturer_publication',
  'oem_part_number_match',
  'operator_review',
  'physical_test',
  'standards_conformance',
  'cross_source_corroboration',
];

/**
 * Seven things that may never verify a compatibility claim, stated as VALUES.
 *
 * Disjoint from {@link COMPATIBILITY_VERIFICATION_METHODS} by a test, so an
 * addition that looks like diligence — "we matched the model number in the
 * title" — fails the build rather than becoming a verification path. The first
 * three are the false-merge shapes #58 is built around, arriving through a
 * different door; the last four are the ones a ranking or a feed would supply.
 */
export const COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS: readonly string[] = [
  'title_similarity',
  'name_match',
  'category_match',
  'image_similarity',
  'seller_assertion_alone',
  'price_proximity',
  'search_co_occurrence',
];

/** Who asserted a compatibility fact. */
export type CompatibilityAssertedByKind =
  /** The product's own manufacturer, through a publication or a data feed. */
  | 'manufacturer'
  /** An ingested catalogue source (#62). Carries a source id and may carry confidence. */
  | 'catalog_source'
  /** The merchant selling the subject. Never sufficient on its own to verify. */
  | 'merchant'
  /** A named Mercaria operator. */
  | 'operator'
  /** Mercaria's own deterministic matching. Carries confidence, never a verdict. */
  | 'matcher';

export const COMPATIBILITY_ASSERTED_BY_KINDS: readonly CompatibilityAssertedByKind[] = [
  'manufacturer',
  'catalog_source',
  'merchant',
  'operator',
  'matcher',
];

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * What a generic compatibility relation points AT.
 *
 * Three of the four are real canonical identities and carry real foreign keys;
 * the fourth is a typed target for the enormous class of compatibility facts
 * whose other end is not a product at all — a connector standard, a lamp socket,
 * a coffee-capsule system, an operating system. Modelling those as canonical
 * products would mint catalogue entities nobody sells.
 */
export type CompatibilityTargetKind =
  | 'canonical_family'
  | 'canonical_product'
  | 'canonical_variant'
  | 'typed';

export const COMPATIBILITY_TARGET_KINDS: readonly CompatibilityTargetKind[] = [
  'canonical_family',
  'canonical_product',
  'canonical_variant',
  'typed',
];

/**
 * The classes of non-catalogue target a compatibility claim may name.
 *
 * Closed, because the alternative is a free-text `target_type` and then two
 * sources spelling one standard three ways — the `Color`/`Colour`/`Tono` failure
 * ADR 0007 exists to end, reproduced in a new column. Adding a class is a code
 * change with a reviewer, which is the correct cost for a new axis of
 * comparison.
 */
export type TypedCompatibilityTargetType =
  | 'connector_standard'
  | 'mounting_standard'
  | 'media_format'
  | 'operating_system'
  | 'socket_type'
  | 'cartridge_system'
  | 'battery_platform'
  | 'filter_standard'
  | 'wireless_standard'
  | 'fastener_standard';

export const TYPED_COMPATIBILITY_TARGET_TYPES: readonly TypedCompatibilityTargetType[] = [
  'connector_standard',
  'mounting_standard',
  'media_format',
  'operating_system',
  'socket_type',
  'cartridge_system',
  'battery_platform',
  'filter_standard',
  'wireless_standard',
  'fastener_standard',
];

/**
 * The shape of a typed target's stable key (ADR 0007 D1).
 *
 * Lowercase, dot-namespaced, at least two segments: `connector.usb_c`,
 * `mount.vesa_100x100`, `capsule.nespresso_original`. The pattern is exported so
 * the request schema, the repository and the database CHECK are all rendered
 * from one statement of it rather than from three regexes that drift.
 *
 * A key is frozen the moment anything cites it — a renamed key is
 * indistinguishable from a different concept to every source mapping that named
 * the old one (D1 rule 2), which is why the correction is a NEW key plus a
 * superseding relation rather than an UPDATE.
 */
export const TYPED_COMPATIBILITY_TARGET_KEY_PATTERN = '^[a-z0-9]+(_[a-z0-9]+)*(\\.[a-z0-9]+(_[a-z0-9]+)*)+$';

/** {@link TYPED_COMPATIBILITY_TARGET_KEY_PATTERN}, compiled once. */
export const TYPED_COMPATIBILITY_TARGET_KEY_REGEX = new RegExp(
  TYPED_COMPATIBILITY_TARGET_KEY_PATTERN,
);

export function isTypedCompatibilityTargetKey(value: string): boolean {
  return TYPED_COMPATIBILITY_TARGET_KEY_REGEX.test(value);
}

/**
 * A target that is not a catalogue identity.
 *
 * Carries a type and a KEY and no label of any kind — D1's invariant, and the
 * reason is not tidiness: a label here would be a second name for the concept,
 * unlocalized, unversioned and immediately in disagreement with the
 * localization record that owns the real one (D4).
 */
export interface TypedCompatibilityTarget {
  readonly type: TypedCompatibilityTargetType;
  readonly key: string;
}

/**
 * The target of a generic relation, as a discriminated union.
 *
 * STRING discriminants throughout this file: the backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — the #68 finding,
 * which cost real time in two later domains.
 */
export type CompatibilityTarget =
  | { readonly kind: 'canonical_family'; readonly familyId: string }
  | { readonly kind: 'canonical_product'; readonly productId: string }
  | { readonly kind: 'canonical_variant'; readonly variantId: string }
  | { readonly kind: 'typed'; readonly target: TypedCompatibilityTarget };

/** The subject of a compatibility claim — a canonical product or one of its variants. */
export type CompatibilitySubject =
  | { readonly kind: 'canonical_product'; readonly productId: string }
  | { readonly kind: 'canonical_variant'; readonly variantId: string };

/**
 * Six facts that may never become a compatibility SUBJECT or target.
 *
 * `vin` is the one to read: it identifies one physical car with an owner, a
 * service history and an address attached, so a column able to hold one would
 * make this domain hold personal data about somebody who never used Mercaria.
 * The rest are attempts to key a fit on something that is not an identity —
 * a person, a seller, an order or a price — each of which would make "does this
 * fit" answerable differently for two shoppers.
 */
export const COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS: readonly string[] = [
  'vin',
  'license_plate',
  'oxy_user_id',
  'buyer_id',
  'order_id',
  'offer_price',
];

// ---------------------------------------------------------------------------
// The claim layer (ADR 0007 D7)
// ---------------------------------------------------------------------------

/**
 * What happened to a claim once somebody looked at it.
 *
 * `unresolved` is the state that makes D6's ruling real one domain over: a claim
 * naming "fits Golf Mk7" in raw text, which resolves to nothing Mercaria can
 * point a foreign key at, STAYS as raw text in that state and produces no
 * canonical relation. Inventing a resolution for it is the false merge #58 is
 * shaped around; discarding it destroys the only record that a source said
 * something Mercaria could not read.
 */
export type CompatibilityClaimState =
  /** Stored, target not yet resolved to any identity. Produces nothing. */
  | 'unresolved'
  /** Resolved, and it is the claim the canonical relation was selected from. */
  | 'selected'
  /** Resolved, agrees with the selected claim, and is why corroboration counts. */
  | 'corroborating'
  /** Resolved, and contradicts the selected claim. Retained; never deleted. */
  | 'conflicting'
  /** An operator judged it wrong. Retained with its reason. */
  | 'rejected'
  /** Superseded by a newer observation from the same source. */
  | 'superseded';

export const COMPATIBILITY_CLAIM_STATES: readonly CompatibilityClaimState[] = [
  'unresolved',
  'selected',
  'corroborating',
  'conflicting',
  'rejected',
  'superseded',
];

/**
 * Why a claim could not be resolved to a target.
 *
 * A closed vocabulary because the counts are what tell an operator whether a
 * feed is unmappable or merely unmapped, and "unresolved: 4,812" with no reason
 * is a number nobody can act on. `ambiguous_target` and `unknown_target` are
 * deliberately different: the first found several identities and refused to
 * pick, the second found none — opposite fixes.
 */
export type CompatibilityUnresolvedReason =
  | 'unknown_target'
  | 'ambiguous_target'
  | 'unparsed_target'
  | 'unsupported_target_class'
  | 'unknown_subject'
  | 'awaiting_review';

export const COMPATIBILITY_UNRESOLVED_REASONS: readonly CompatibilityUnresolvedReason[] = [
  'unknown_target',
  'ambiguous_target',
  'unparsed_target',
  'unsupported_target_class',
  'unknown_subject',
  'awaiting_review',
];

// ---------------------------------------------------------------------------
// Automotive
// ---------------------------------------------------------------------------

/**
 * The scope ladder a fitment attaches to, BROADEST FIRST.
 *
 * The order is load-bearing and is asserted by a test rather than left to
 * whoever reads the array: {@link fitmentScopeSpecificity} indexes into it, and
 * {@link resolveFitment} lets a narrower row override a broader one. Reverse the
 * tuple and every exclusion in the database silently stops applying, while every
 * query still returns rows and every page still renders.
 *
 * A make-scoped fitment is rare and legitimate — a universal wiper blade
 * connector, a manufacturer-wide diagnostic tool — and having the scope means
 * such a claim does not have to be exploded into ten thousand configuration rows
 * that then rot independently.
 */
export type FitmentTargetScope =
  | 'vehicle_make'
  | 'vehicle_model'
  | 'vehicle_generation'
  | 'vehicle_configuration';

export const FITMENT_TARGET_SCOPES: readonly FitmentTargetScope[] = [
  'vehicle_make',
  'vehicle_model',
  'vehicle_generation',
  'vehicle_configuration',
];

/** How specific a scope is; higher wins. Reads {@link FITMENT_TARGET_SCOPES}' order. */
export function fitmentScopeSpecificity(scope: FitmentTargetScope): number {
  return FITMENT_TARGET_SCOPES.indexOf(scope);
}

/**
 * Where on the vehicle the part goes (#367 D8's "position/location").
 *
 * `not_applicable` is a real member and not an omission: a cabin air filter has
 * no side, and leaving the column NULL for it would make NULL mean both "this
 * part has no position" and "nobody recorded one" — the conflation this whole
 * file is written against.
 */
export type FitmentPosition =
  | 'front'
  | 'rear'
  | 'front_left'
  | 'front_right'
  | 'rear_left'
  | 'rear_right'
  | 'left'
  | 'right'
  | 'upper'
  | 'lower'
  | 'interior'
  | 'exterior'
  | 'not_applicable';

export const FITMENT_POSITIONS: readonly FitmentPosition[] = [
  'front',
  'rear',
  'front_left',
  'front_right',
  'rear_left',
  'rear_right',
  'left',
  'right',
  'upper',
  'lower',
  'interior',
  'exterior',
  'not_applicable',
];

/**
 * The qualifiers that narrow a fitment within its scope.
 *
 * Closed and stored as an array whose ELEMENTS are CHECKed by containment (a
 * CHECK may hold no subquery, so "every element is in range" is written `<@`).
 * These are the facts an aftermarket catalogue actually publishes beside a
 * fitment, and they are the difference between a part that goes on the car in
 * the drive and one that goes on the same model with a different brake package.
 */
export type FitmentQualifier =
  | 'with_sport_suspension'
  | 'without_sport_suspension'
  | 'with_towing_package'
  | 'with_sunroof'
  | 'left_hand_drive_only'
  | 'right_hand_drive_only'
  | 'heavy_duty'
  | 'requires_abs'
  | 'vin_range_restricted'
  | 'production_date_restricted'
  | 'chassis_number_restricted'
  | 'facelift_only'
  | 'pre_facelift_only';

export const FITMENT_QUALIFIERS: readonly FitmentQualifier[] = [
  'with_sport_suspension',
  'without_sport_suspension',
  'with_towing_package',
  'with_sunroof',
  'left_hand_drive_only',
  'right_hand_drive_only',
  'heavy_duty',
  'requires_abs',
  'vin_range_restricted',
  'production_date_restricted',
  'chassis_number_restricted',
  'facelift_only',
  'pre_facelift_only',
];

/**
 * A vehicle configuration's fuel type. Nullable on the row — a configuration
 * imported before its powertrain was known is a real state, and defaulting it to
 * `petrol` would be a fabricated fact in a column a shopper filters on.
 */
export type VehicleFuelType =
  | 'petrol'
  | 'diesel'
  | 'hybrid'
  | 'plug_in_hybrid'
  | 'electric'
  | 'hydrogen'
  | 'lpg'
  | 'cng'
  | 'ethanol';

export const VEHICLE_FUEL_TYPES: readonly VehicleFuelType[] = [
  'petrol',
  'diesel',
  'hybrid',
  'plug_in_hybrid',
  'electric',
  'hydrogen',
  'lpg',
  'cng',
  'ethanol',
];

export type VehicleDrivetrain = 'fwd' | 'rwd' | 'awd' | 'four_wd';

export const VEHICLE_DRIVETRAINS: readonly VehicleDrivetrain[] = ['fwd', 'rwd', 'awd', 'four_wd'];

export type VehicleTransmission = 'manual' | 'automatic' | 'cvt' | 'dual_clutch' | 'single_speed';

export const VEHICLE_TRANSMISSIONS: readonly VehicleTransmission[] = [
  'manual',
  'automatic',
  'cvt',
  'dual_clutch',
  'single_speed',
];

export type VehicleBodyStyle =
  | 'hatchback'
  | 'saloon'
  | 'estate'
  | 'coupe'
  | 'convertible'
  | 'suv'
  | 'mpv'
  | 'pickup'
  | 'van'
  | 'roadster';

export const VEHICLE_BODY_STYLES: readonly VehicleBodyStyle[] = [
  'hatchback',
  'saloon',
  'estate',
  'coupe',
  'convertible',
  'suv',
  'mpv',
  'pickup',
  'van',
  'roadster',
];

/**
 * The lifecycle of a vehicle record.
 *
 * Deliberately SHORTER than the catalogue's: a vehicle record is reference data
 * Mercaria maintains, not a saleable entity, so it has no `draft` and no
 * `discontinued`. `merged` exists because two feeds spell one model two ways and
 * the correction has to be a merge that keeps the loser resolvable — the
 * `canonical_products` posture, for the same reason.
 */
export type VehicleRecordStatus = 'active' | 'merged' | 'retired';

export const VEHICLE_RECORD_STATUSES: readonly VehicleRecordStatus[] = [
  'active',
  'merged',
  'retired',
];

/**
 * The earliest and latest model years this domain will store.
 *
 * `canonical_products.model_year` uses 1800–2200 and these are narrower on
 * purpose: a vehicle year outside 1885–2100 is a parsing accident (a price read
 * as a year, a two-digit year expanded wrongly), and admitting it puts a fitment
 * on a car that will never exist in a range query somebody filters on.
 */
export const VEHICLE_MIN_YEAR = 1885;
export const VEHICLE_MAX_YEAR = 2100;

/** One resolved fitment statement, as the resolver consumes it. */
export interface FitmentStatement {
  readonly scope: FitmentTargetScope;
  readonly applicability: CompatibilityApplicability;
}

/**
 * The answer to "does this part fit this vehicle", from every statement that
 * covers it.
 *
 * A discriminated union on a STRING (the `strict: false` rule above). The
 * `unknown` branch carries NO applicability and NO scope, so a caller cannot
 * render "we do not know" as a fit by reading a field that is not there — #74's
 * `RankingSignalOutcome` device, and #122's `unknownAnswer()` posture.
 */
export type FitmentVerdict =
  | {
      readonly outcome: 'determined';
      readonly applicability: CompatibilityApplicability;
      /** The narrowest scope that contributed to the verdict. */
      readonly decidedAtScope: FitmentTargetScope;
    }
  | { readonly outcome: 'unknown' };

/**
 * Resolve every statement covering one (part, vehicle) pair into one verdict.
 *
 * Two rules, in this order, and both are load-bearing:
 *
 * 1. **The narrowest scope that said anything decides.** A configuration-scoped
 *    `does_not_apply` beats a generation-scoped `applies`, which is what makes
 *    an exclusion an ordinary row rather than a second table. It also means a
 *    narrow `applies` beats a broad `does_not_apply` — correct, and the case is
 *    "this part does not fit the model, EXCEPT the 2019 facelift".
 * 2. **Within that scope, {@link resolveApplicability} decides**, so two sources
 *    contradicting each other at the same specificity resolve to the more
 *    cautious answer rather than to whichever row was written last.
 *
 * An empty set is `unknown` — not `does_not_apply`. Nothing is known about a
 * vehicle nobody has published a fitment for, and telling a shopper their car is
 * excluded because Mercaria has no data is the exact error the four-valued
 * applicability exists to prevent.
 */
export function resolveFitment(statements: readonly FitmentStatement[]): FitmentVerdict {
  let narrowest = -1;
  for (const statement of statements) {
    const specificity = fitmentScopeSpecificity(statement.scope);
    if (specificity > narrowest) narrowest = specificity;
  }
  if (narrowest < 0) return { outcome: 'unknown' };
  const scope = FITMENT_TARGET_SCOPES[narrowest];
  if (scope === undefined) return { outcome: 'unknown' };
  const applicability = resolveApplicability(
    statements
      .filter((statement) => fitmentScopeSpecificity(statement.scope) === narrowest)
      .map((statement) => statement.applicability),
  );
  return { outcome: 'determined', applicability, decidedAtScope: scope };
}

// ---------------------------------------------------------------------------
// The invariant this domain exists to hold
// ---------------------------------------------------------------------------

/**
 * Twelve facts that may never be stored as a variant option (ADR 0007 D8, and
 * the epic's own acceptance scenario).
 *
 * Stated as VALUES so the prohibition is testable rather than a sentence in a
 * document: `compatibility-isolation.test.ts` walks the real drizzle columns of
 * `listing_options` and `product_variant_option_values` and fails the build if
 * one of these ever appears there, and separately asserts that no module in this
 * domain has a writer for either table.
 *
 * The reason, once, in numbers: a mid-range brake pad fits on the order of a
 * thousand vehicle configurations. As options that is one SKU with a thousand
 * variants — a thousand rows of stock nobody counts, a thousand canonical
 * variant signatures that describe a car rather than a part, a thousand offers
 * to compare against each other, and a variant matrix the authoring wizard
 * (D10) would try to render. The part did not change. Only the question did.
 */
export const COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS: readonly string[] = [
  'vehicle_make',
  'vehicle_model',
  'vehicle_generation',
  'vehicle_configuration',
  'year_range',
  'model_year',
  'fitment_position',
  'fitment',
  'engine_code',
  'body_style',
  'drivetrain',
  'compatible_with',
];

// ---------------------------------------------------------------------------
// Public projections
// ---------------------------------------------------------------------------

/**
 * One compatibility relation, as a public surface renders it.
 *
 * Every field is named explicitly (the `provider_accounts` #46 precedent) rather
 * than spread from a row type, so a column added to the table does not reach a
 * shopper by default. There is no confidence, no source id, no claim id and no
 * asserting merchant: a machine's estimate of itself is an operator's fact, and
 * publishing it invites reading a number as a strength of verification, which
 * #55's `confidence_machine_check` exists to prevent one table over.
 */
export interface CompatibilityRelationView {
  readonly id: string;
  readonly kind: CompatibilityRelationKind;
  readonly direction: CompatibilityDirection;
  readonly subject: CompatibilitySubject;
  readonly target: CompatibilityTarget;
  readonly applicability: CompatibilityApplicability;
  readonly verification: CompatibilityVerificationState;
  readonly verificationMethod: CompatibilityVerificationMethod | null;
  readonly conditionKinds: readonly CompatibilityConditionKind[];
  readonly conditionNote: string | null;
  /** ISO 3166-1 alpha-2. Empty means worldwide — a claim scoped down, not up. */
  readonly markets: readonly string[];
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** A vehicle, as a fitment surface names it. Identity plus base name, no labels. */
export interface VehicleReferenceView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** One fitment row, as a public surface renders it. */
export interface AutomotiveFitmentView {
  readonly id: string;
  readonly subject: CompatibilitySubject;
  readonly scope: FitmentTargetScope;
  readonly make: VehicleReferenceView;
  readonly model: VehicleReferenceView | null;
  readonly generation: VehicleReferenceView | null;
  readonly configuration: VehicleReferenceView | null;
  readonly applicability: CompatibilityApplicability;
  readonly position: FitmentPosition;
  readonly qualifiers: readonly FitmentQualifier[];
  readonly conditionKinds: readonly CompatibilityConditionKind[];
  readonly conditionNote: string | null;
  readonly yearFrom: number | null;
  readonly yearTo: number | null;
  readonly verification: CompatibilityVerificationState;
  readonly verificationMethod: CompatibilityVerificationMethod | null;
}

/**
 * Six fields no compatibility DTO may declare.
 *
 * Gated statically AND by a walk of a real emitted projection (#92's two-gate
 * rule): a static scan proves the module does not declare them, and a runtime
 * walk proves the serializer does not add them. `confidence` is on the list for
 * the reason above — it is a machine's number and not a public verdict.
 */
export const COMPATIBILITY_FORBIDDEN_VIEW_FIELDS: readonly string[] = [
  'confidence',
  'assertedBySourceId',
  'assertedByMerchantId',
  'claimId',
  'rawTargetText',
  'sourceRecordId',
];

// ---------------------------------------------------------------------------
// The public read surface
// ---------------------------------------------------------------------------

/**
 * Which of the two lookups a relation response answered.
 *
 * Carried on the response rather than left to the client to remember from the
 * parameter it sent, because the two answers are lists of DIFFERENT things —
 * `subject` returns what this product fits, `target` returns what fits it — and
 * a client that renders one under the other's heading has produced a fitment
 * claim nobody made. `subject_to_target` and `mutual` (the stored
 * {@link CompatibilityDirection}) are a property of a ROW; this is a property of
 * the QUESTION, and collapsing the two would give the reverse index a third
 * direction to be stored as, which distinction 4 in this file's header forbids.
 */
export type CompatibilityLookupDirection = 'subject' | 'target';

/**
 * One page of relations, in one direction.
 *
 * `examinedLimit` is the bound the QUERY ran under and `truncated` says it was
 * reached — deliberately not "there are more results". The publication policy
 * runs after the query (`compatibility.service`'s documented `stale_at`
 * posture), so the limit bounds what was EXAMINED and a page can legitimately
 * return fewer rows than it examined. A `total` would be a count the read never
 * took, and a `nextCursor` would promise a keyset this domain's ordering
 * (`kind`, then `created_at`) does not carry.
 */
export interface CompatibilityRelationsView {
  readonly lookup: CompatibilityLookupDirection;
  readonly relations: readonly CompatibilityRelationView[];
  readonly examinedLimit: number;
  readonly truncated: boolean;
}

/**
 * The vehicles one part is stated to fit — and the ones it is stated NOT to.
 *
 * Exclusions are IN the list, each carrying its own `applicability`, and there
 * is no parameter that removes them. A list filtered to `applies` is a
 * confident yes for every vehicle somebody explicitly excluded, which is the
 * one failure this whole domain is shaped around; and an exclusion a shopper
 * can read is the cheapest possible way for them to find out.
 */
export interface PartFitmentsView {
  readonly subject: CompatibilitySubject;
  readonly fitments: readonly AutomotiveFitmentView[];
  readonly examinedLimit: number;
  readonly truncated: boolean;
}

/**
 * "Does this part fit this car?" — the verdict, and every statement behind it.
 *
 * The statements are returned WITH the verdict rather than instead of it: the
 * verdict is {@link resolveFitment}'s answer and is the only thing a surface may
 * render as the answer, while the statements are what let a shopper see that
 * the `does_not_apply` came from their exact engine variant rather than from the
 * model as a whole. A surface computing its own verdict from the statements
 * would be the second implementation `resolveFitment` exists to prevent.
 *
 * `vehicle` echoes the ancestry the SERVER resolved, not the one the client
 * sent. A caller naming a configuration under the wrong generation gets the
 * real one back, so a page cannot render a verdict beside a car it was not
 * about.
 */
export interface FitmentVerdictView {
  readonly subject: CompatibilitySubject;
  readonly vehicle: {
    readonly make: VehicleReferenceView | null;
    readonly model: VehicleReferenceView | null;
    readonly generation: VehicleReferenceView | null;
    readonly configuration: VehicleReferenceView | null;
  };
  /** The model year the question was asked about, when one was given. */
  readonly year: number | null;
  readonly verdict: FitmentVerdict;
  readonly statements: readonly AutomotiveFitmentView[];
}

/** Which rung of the vehicle ladder a picker response answered for. */
export type VehicleCatalogLevel = 'make' | 'model' | 'generation' | 'configuration';

/**
 * One rung of the vehicle picker.
 *
 * Every entry is a {@link VehicleReferenceView} — id, stable key, base name —
 * whatever the rung, so the picker has one shape to render and no rung can
 * quietly start publishing an engine code, a power figure or a market. Those
 * are columns on `vehicle_configurations` and they belong to a fitment's own
 * statement, not to the list a shopper walks down.
 */
export interface VehicleCatalogLevelView {
  readonly level: VehicleCatalogLevel;
  readonly vehicles: readonly VehicleReferenceView[];
}
