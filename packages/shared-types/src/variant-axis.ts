/**
 * Typed variant axes and retained seller claims (#367, ADR 0007 D6/D7).
 *
 * Two facts that look like one and are not:
 *
 * - **An AXIS** is a dimension a product varies along, cited as an
 *   `attribute_definitions` row and its exact version — never a string. The
 *   product's own declared axis list is authoritative FOR THAT PRODUCT (D6);
 *   `product_type_fields.variant_capable` says an attribute *may* be one for
 *   that type, and `attribute_definitions.variant_defining` says it may be one
 *   at all. This vocabulary consumes both and restates neither.
 * - **A CLAIM** is what a party SAID, verbatim, with its provenance (D7). It is
 *   retained whether or not it ever resolves, it is never promoted to a
 *   canonical fact by this domain, and a canonical fact never overwrites it.
 *
 * ## What this vocabulary structurally cannot express
 *
 * - **A canonical entity.** {@link NATIVE_CLAIM_FORBIDDEN_TARGETS} names the six
 *   as VALUES, asserted DISJOINT from {@link NATIVE_CLAIM_SUBJECTS} by a test,
 *   and no DTO or column in the domain carries one. A claim is about a NATIVE
 *   listing or variant; the moment it could name a canonical product it would be
 *   a write into the selection machinery ADR 0007 D7 keeps it out of.
 * - **A resolved value on an unresolved claim.** Every "the typed columns are
 *   present" rule below is a BICONDITIONAL, so "we could not tell, so we stored
 *   our best guess" has no row shape. `Tono` looking like `Color` is the false
 *   merge #58 is shaped around, and the safe failure is text in a queue.
 * - **A guess about which attribute a legacy option names.**
 *   {@link VariantAxisAttributeRefusal} has an `ambiguous` member precisely so
 *   two candidates produce a REFUSAL rather than the first one.
 *
 * The tuples are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — `db/schema/CONVENTIONS.md`).
 * Adding a value is a code change PLUS an additive migration in the SAME pull
 * request: the TypeScript union widens immediately and the database CHECK does
 * not.
 */

/* -------------------------------------------------------------------------- */
/* Claims (ADR 0007 D7)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a listing-grain claim is ASSERTING.
 *
 * The variant grain needs no such discriminant — a claim about one variant is
 * always a value — and the asymmetry is the legacy shape rather than an
 * oversight. ADR 0007 D6 names three columns that become retained claims:
 * `listing_options.name`, and `product_variant_option_values.name` / `.value`.
 * The first is an option LABEL with no value beside it (a listing declaring it
 * sells shoes in several `Tono`s has not said which), and the second pair is a
 * value assertion. One table describing both without a discriminant would have
 * to make `raw_value` nullable and mean two things by the NULL.
 *
 * `listing_options.values` is deliberately NOT preserved here. D6 does not name
 * it, the set is recoverable from the variant claims, and the legacy row itself
 * is retained (D13) — a third copy is a third thing that can disagree.
 */
export type NativeAttributeClaimKind = 'attribute_value' | 'axis_declaration';

export const NATIVE_ATTRIBUTE_CLAIM_KINDS: readonly NativeAttributeClaimKind[] = [
  'attribute_value',
  'axis_declaration',
];

/**
 * WHO asserted a claim, and on what standing.
 *
 * Deliberately NOT `SOURCE_LINK_METHODS` (`./provenance`), which answers a
 * different question: how an OBSERVATION was matched to a CANONICAL entity. No
 * canonical entity is involved in a claim at all, and sharing that vocabulary
 * would make `connector_declared` mean both "this feed asserted a value about a
 * native listing" and "this feed's record was attached to a canonical product".
 *
 * `legacy_option_migration` is what the #367 backfill writes and it names
 * exactly what is known: this text was preserved from the pre-typed option
 * columns. It does NOT claim the original assertion was a merchant's or a
 * connector's — the legacy rows record no provenance, so inventing one would put
 * a fact nobody observed into the audit trail the claim exists to be.
 */
export type NativeAttributeClaimProvenance =
  | 'merchant_declared'
  | 'p2p_seller_declared'
  | 'connector_import'
  | 'operator_correction'
  | 'legacy_option_migration';

export const NATIVE_ATTRIBUTE_CLAIM_PROVENANCES: readonly NativeAttributeClaimProvenance[] = [
  'merchant_declared',
  'p2p_seller_declared',
  'connector_import',
  'operator_correction',
  'legacy_option_migration',
];

/** The provenances that name a person, and therefore carry an Oxy account id. */
export const NATIVE_CLAIM_ATTRIBUTED_PROVENANCES: readonly NativeAttributeClaimProvenance[] = [
  'merchant_declared',
  'p2p_seller_declared',
  'operator_correction',
];

/**
 * How far a claim's ATTRIBUTE or VALUE has been settled against the registry.
 *
 * Four states, and the two that are not `resolved` or `unresolved` are held
 * apart because they route differently — the `RetailEligibilityVerdict` rule:
 *
 * - `unresolved` — nobody has tried yet. The honest initial state, and the one a
 *   claim written by a connector before the resolver ran sits in.
 * - `resolved` — the registry settled it. The ONLY state that may carry a typed
 *   pointer or a normalized value, by biconditional CHECK.
 * - `blocked` — the resolver ran and the registry could not settle it. Stays
 *   text, appears in the queue, and {@link VariantAxisAttributeRefusal} /
 *   {@link VariantAxisValueRefusal} name WHICH of the causes it was.
 * - `refused` — a person decided this text is not an attribute (or not that
 *   value). Out of the queue, and its refusal is `operator_refused` in both
 *   vocabularies so the state and the reason cannot disagree.
 */
export type NativeClaimResolution = 'unresolved' | 'resolved' | 'blocked' | 'refused';

export const NATIVE_CLAIM_RESOLUTIONS: readonly NativeClaimResolution[] = [
  'unresolved',
  'resolved',
  'blocked',
  'refused',
];

/** The resolutions that carry a refusal reason. Both, and only these two. */
export const NATIVE_CLAIM_REFUSING_RESOLUTIONS: readonly NativeClaimResolution[] = [
  'blocked',
  'refused',
];

/**
 * The states a REVIEW QUEUE is built from.
 *
 * `refused` is absent on purpose: somebody already answered it, and a queue that
 * keeps showing settled work is one people stop reading. `resolved` is absent
 * for the obvious reason.
 */
export const NATIVE_CLAIM_QUEUED_RESOLUTIONS: readonly NativeClaimResolution[] = [
  'unresolved',
  'blocked',
];

/**
 * Why a raw option NAME did not become a typed attribute.
 *
 * Every member is a fact the resolver OBSERVED, never a judgement it made, and
 * that is what makes each one actionable: `ambiguous` says an operator has to
 * pick, `unmapped` says somebody has to add an alias, `not_variant_defining`
 * says the registry entry has to be changed, and `forbidden_as_axis` says the
 * answer is no and always will be.
 *
 * `forbidden_as_axis` is the one worth reading. It fires for a legacy option
 * literally named `price`, `stock` or `vehicle_make` — which real catalogues
 * contain — and refusing it is ADR 0007 D6/D8: one brake-pad SKU fits four
 * hundred vehicles and stays ONE variant.
 */
export type VariantAxisAttributeRefusal =
  | 'unmapped'
  | 'ambiguous'
  | 'not_variant_defining'
  | 'forbidden_as_axis'
  | 'operator_refused';

export const VARIANT_AXIS_ATTRIBUTE_REFUSALS: readonly VariantAxisAttributeRefusal[] = [
  'unmapped',
  'ambiguous',
  'not_variant_defining',
  'forbidden_as_axis',
  'operator_refused',
];

/**
 * Why a raw option VALUE did not become a typed one.
 *
 * `not_controlled` is separate from `unmapped` and the difference is the whole
 * of "the backfill fails safe": `unmapped` means this attribute HAS controlled
 * values and none of them is this text, so an alias would fix it;
 * `not_controlled` means the attribute is a measurement or a free string, so
 * `attribute_value_aliases` has nothing to say about it and never will. Reporting
 * the second as the first sends somebody to write an alias that cannot exist.
 *
 * `attribute_unresolved` is the dependent case: a value cannot be typed while
 * nobody knows which attribute it is a value OF.
 */
export type VariantAxisValueRefusal =
  | 'unmapped'
  | 'ambiguous'
  | 'not_controlled'
  | 'attribute_unresolved'
  | 'operator_refused';

export const VARIANT_AXIS_VALUE_REFUSALS: readonly VariantAxisValueRefusal[] = [
  'unmapped',
  'ambiguous',
  'not_controlled',
  'attribute_unresolved',
  'operator_refused',
];

/** The one refusal a person's decision writes, in both vocabularies above. */
export const NATIVE_CLAIM_OPERATOR_REFUSAL = 'operator_refused';

/**
 * What a claim may be ABOUT. Two members, both native.
 *
 * A claim is one seller's or one connector's assertion about ONE row in this
 * marketplace's own catalogue. That is the whole of ADR 0007 D7's separation,
 * and the list exists so the prohibition below has something to be disjoint
 * from.
 */
export type NativeClaimSubject = 'native_listing' | 'native_variant';

export const NATIVE_CLAIM_SUBJECTS: readonly NativeClaimSubject[] = [
  'native_listing',
  'native_variant',
];

/**
 * Entities a claim may never name, stated as VALUES and asserted DISJOINT from
 * {@link NATIVE_CLAIM_SUBJECTS} by a test.
 *
 * The negative list beside the positive one is what fails the build when
 * somebody adds a plausible-looking member later — the
 * `RETAIL_FORBIDDEN_COMPONENT_KINDS` device. Every one of these is a canonical
 * identity, and a claim able to name one is a claim that has become a canonical
 * fact by being written: `canonical_attribute_values` is the SELECTED fact and
 * reaches its rows through #56's selection and provenance machinery, which a
 * merchant's assertion does not get to skip.
 *
 * No column in `db/schema/variantAxes.ts` holds any of them, which is the
 * enforcement; this list is what makes the absence checkable.
 */
export const NATIVE_CLAIM_FORBIDDEN_TARGETS: readonly string[] = [
  'canonical_product',
  'canonical_variant',
  'canonical_product_family',
  'brand',
  'organization',
  'merchant',
];

/* -------------------------------------------------------------------------- */
/* Which representation a catalogue READ prefers (#367 line 324)               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a hydration read serves a listing's options from the TYPED axes or
 * from the legacy free-text tables.
 *
 * #367 line 324 asks that `listing_options` and `product_variant_option_values`
 * become "a migration compatibility projection/fallback, not the new source of
 * truth". That is a question about which table a READ prefers, and no listing's
 * own state can answer it — which is why this is a deployment lever and not a
 * column.
 *
 * - `off` — legacy only. Today's behaviour exactly, and the default.
 * - `shadow` — compute BOTH, record how they compared, serve LEGACY. The
 *   instrument, not the change.
 * - `on` — prefer the typed axes for any listing that declares them; fall back
 *   to legacy for every listing that does not.
 *
 * The three members are `CANONICAL_READ_MODES`' spelling because it is the
 * right vocabulary, and a SEPARATE tuple because this lever gates the NATIVE
 * catalogue rather than the canonical graph. One tuple serving two rollouts is
 * a shared fate nobody chose: widening one would widen the other.
 */
export type VariantAxisReadMode = 'off' | 'shadow' | 'on';

export const VARIANT_AXIS_READ_MODES: readonly VariantAxisReadMode[] = ['off', 'shadow', 'on'];

/* -------------------------------------------------------------------------- */
/* The variant signature (ADR 0007 D6)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Bumping this changes every typed signature at once.
 *
 * Inside the hashed payload, the `variantSignature` (#56) precedent: a
 * serialization change becomes a visible recompute-and-migrate rather than a
 * silent drift where rows written before and after a refactor stop colliding
 * with each other.
 *
 * `t` for TYPED, and deliberately not `v1`: #56's canonical signature hashes
 * `(attribute_key, normalized_value)` pairs and this one hashes
 * `(attribute_definition_id, normalized_value)` pairs. The two produce different
 * digests for the same variant and always will; a shared version token would
 * suggest they are comparable.
 */
export const TYPED_VARIANT_SIGNATURE_VERSION = 't1';

/**
 * The shape a stored signature has, and the CHECK
 * `native_variant_signatures_signature_shape_check` is rendered from.
 *
 * A signature that is not a sha-256 hex digest is not one this codebase
 * produced, and a hand-written row carrying a made-up one would occupy the key
 * space of `native_variant_signatures_listing_signature_key` without colliding
 * with anything.
 */
export const TYPED_VARIANT_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One axis assignment, as the signature reads it.
 *
 * The definition ID rather than the key, per ADR 0007 D6 verbatim — and the
 * consequence is worth stating because it is not free: `attribute_definitions`
 * rows are per VERSION, so publishing a new version of `color` changes the
 * signature of every variant re-declared under it. That is correct and it is the
 * same property #94 gives every stored value (a version bump schedules a
 * re-normalization rather than reinterpreting facts silently); it means a
 * listing's axes and its variants' signatures are recomputed together, which
 * `writeVariantAxisAssignments` does in one transaction.
 */
export interface TypedVariantAxisAssignment {
  /** The `attribute_definitions` row id — one exact VERSION of one attribute. */
  readonly attributeDefinitionId: string;
  /** The normalized value: a folded string, or a base-unit magnitude rendered once. */
  readonly normalizedValue: string;
}

/* -------------------------------------------------------------------------- */
/* Read DTOs                                                                   */
/* -------------------------------------------------------------------------- */

/** One declared axis of one native listing. */
export interface NativeVariantAxisSummary {
  readonly id: string;
  readonly listingId: string;
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  readonly attributeDefinitionVersion: number;
  /**
   * The product type version the declaration was made under, or `null` when the
   * listing has not been migrated to one. NOT a second authority on whether the
   * attribute may be an axis — see the schema's citation trigger.
   */
  readonly productTypeDefinitionId: string | null;
  /** Display order. Deliberately NOT an input to the signature. */
  readonly position: number;
}

/** One variant's value on one of its listing's axes. */
export interface NativeVariantAxisAssignmentSummary {
  readonly id: string;
  readonly variantId: string;
  readonly axisId: string;
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  /** What a shopper reads — the seller's own words where there are any. */
  readonly displayValue: string;
  /** What the signature hashed. */
  readonly normalizedValue: string;
  readonly enumValueId: string | null;
  readonly normalizedNumber: number | null;
  readonly normalizedUnit: string | null;
  /** The retained claim this typed value came from, when it came from one. */
  readonly sourceClaimId: string | null;
}

/** One variant's order-independent identity within its listing. */
export interface NativeVariantSignatureSummary {
  readonly variantId: string;
  readonly listingId: string;
  readonly signature: string;
  readonly axisCount: number;
}

/**
 * One retained claim, as an operator surface reports it.
 *
 * The raw halves are always present and the typed halves never are unless the
 * matching resolution says `resolved` — which is the DTO reading of the
 * biconditional CHECKs, and the reason a client cannot render a normalized value
 * for a claim nobody settled.
 */
export interface NativeAttributeClaimSummary {
  readonly id: string;
  readonly subject: NativeClaimSubject;
  /** The listing or the variant, depending on `subject`. */
  readonly subjectId: string;
  readonly kind: NativeAttributeClaimKind;
  readonly provenance: NativeAttributeClaimProvenance;
  /** The party's own words for the attribute — `Tono`, `Colour`, `color `. */
  readonly rawName: string;
  /** The party's own words for the value. `null` for an `axis_declaration`. */
  readonly rawValue: string | null;
  readonly attributeResolution: NativeClaimResolution;
  readonly attributeRefusal: VariantAxisAttributeRefusal | null;
  readonly valueResolution: NativeClaimResolution;
  readonly valueRefusal: VariantAxisValueRefusal | null;
  readonly attributeDefinitionId: string | null;
  readonly attributeDefinitionVersion: number | null;
  readonly enumValueId: string | null;
  readonly normalizedValue: string | null;
  /** When the claiming party asserted it — not when Mercaria wrote the row. */
  readonly assertedAt: string;
}

/**
 * How much is waiting, and for what.
 *
 * A COUNT and not a silence, which is ADR 0007's closing consequence stated as a
 * type: "Ambiguous legacy values are not resolved. They stay text, in a queue,
 * visible. This is deliberate and it means the migration's output includes a
 * backlog rather than a clean number."
 */
export interface VariantAxisClaimQueueCounts {
  readonly queued: number;
  readonly byAttributeRefusal: Readonly<Record<VariantAxisAttributeRefusal, number>>;
  readonly byValueRefusal: Readonly<Record<VariantAxisValueRefusal, number>>;
  /** Attempted by nobody yet — distinct from every refusal above. */
  readonly neverAttempted: number;
}

/* -------------------------------------------------------------------------- */
/* The backfill (ADR 0007 D6)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What one backfill pass did, or would do.
 *
 * `mode` is a STRING discriminant on a report rather than a boolean, for the
 * reason every union in this repository states (#68): the backend compiles with
 * `strict: false`, so a boolean-literal discriminant does not narrow.
 *
 * The counters are checked for SUM EQUALITY before the report is printed —
 * `catalog_backfill_runs_counters_total_check`'s vacuity floor, applied to a
 * script. A pass that swallowed a row cannot report a clean number.
 */
export interface VariantAxisBackfillReport {
  readonly mode: 'dry_run' | 'apply';
  /** What was read. `listingOptions` is the denominator every axis outcome sums to. */
  readonly scanned: {
    readonly listings: number;
    readonly listingOptions: number;
    readonly variantOptionValues: number;
    /**
     * How many listings carry legacy options ANYWHERE — the pager's positive
     * control, and deliberately not a page figure.
     *
     * `listings: 0` is a correct answer for a catalogue with nothing to migrate
     * AND what a broken cursor produces, and the sum check cannot tell them
     * apart because 0 = 0 + 0 + 0. A first-page pass that scanned nothing while
     * this is positive is refused rather than reported.
     */
    readonly listingsWithLegacyOptionsTotal: number;
  };
  /**
   * Per legacy `listing_options` row: exactly one outcome each, and the three
   * SUM to `scanned.listingOptions`.
   */
  readonly axes: {
    readonly declared: number;
    readonly alreadyDeclared: number;
    readonly unresolved: number;
  };
  /**
   * Per legacy `product_variant_option_values` row: exactly one outcome each,
   * and the FOUR SUM to `scanned.variantOptionValues`.
   *
   * `withheld` is the outcome that has to exist for the sum to stay honest: the
   * value RESOLVED and Mercaria declined to write it anyway, because two of that
   * listing's variants would have folded to one signature and
   * `native_variant_signatures_listing_signature_key` treats them as one variant.
   * Counting those as `unresolved` would blame the registry for a duplicate in
   * the merchant's own data, and counting them as `written` would be a lie.
   */
  readonly assignments: {
    readonly written: number;
    readonly alreadyWritten: number;
    readonly unresolved: number;
    readonly withheld: number;
  };
  /** Claims are written for EVERY legacy row, resolved or not (ADR 0007 D6/D7). */
  readonly claims: {
    readonly written: number;
    readonly alreadyPresent: number;
  };
  readonly signatures: {
    readonly written: number;
    readonly unchanged: number;
  };
  /**
   * The backlog, by cause. Never a silence.
   *
   * The two maps together sum to `axes.unresolved + assignments.unresolved` —
   * every refusal is attributed, and `withheld` is deliberately outside them
   * because Mercaria's own refusal to write is not a registry gap anybody can
   * close by recording an alias.
   */
  readonly unresolved: {
    readonly total: number;
    readonly byAttributeRefusal: Readonly<Record<VariantAxisAttributeRefusal, number>>;
    readonly byValueRefusal: Readonly<Record<VariantAxisValueRefusal, number>>;
  };
  /**
   * Facts about the pass that are not outcomes of a legacy row, and are
   * therefore deliberately outside every sum above.
   */
  readonly diagnostics: {
    /**
     * Listings left entirely untyped because two of their variants resolved to
     * one signature. Their claims are still recorded — preserving what somebody
     * said is unconditional — so nothing is lost and an operator can see which
     * listings carry a duplicate.
     */
    readonly listingsWithIndistinguishableVariants: number;
    /**
     * Assignments a previous pass wrote that this one no longer derives, and
     * which were KEPT.
     *
     * Not silent: it means the registry stopped resolving something it used to,
     * which is a change somebody made and should see. Retained rather than
     * removed, because a stored assignment cites its exact definition VERSION and
     * `deprecateAttributeDefinition` takes a version "out of service for NEW
     * assignments" while "stored values still resolve".
     *
     * Counted per AXIS. It was a per-LISTING net until #612, so one variant
     * losing a row while another gained one reported zero — the one case the
     * count existed for and the one case it could not report.
     *
     * Outside every sum above, because a retained row has no legacy option value
     * behind it: that is precisely why this pass no longer derives it.
     */
    readonly assignmentsRetainedUnresolved: number;
    /**
     * Listings that were on this page and no longer existed when their own
     * transaction ran — a seller deleting one mid-pass, or a sibling fixture in
     * a shared test database.
     *
     * Counted rather than fatal, because the alternative was losing the REPORT:
     * the page is read on the root connection, so the row can be gone by the
     * time its writes run, and rethrowing took `resumeAfterListingId` with it.
     * The operator lost the CURSOR rather than one listing, which a resumed pass
     * cannot tell from a completed one.
     *
     * Such a listing contributes NO outcome counters — the tally is restored to
     * its pre-listing snapshot — so it can never disturb the sums above. It does
     * still count in `scanned.listings`, because it genuinely was on the page.
     */
    readonly listingsVanishedDuringPass: number;
  };
  /** Where to resume. `null` when the pass reached the end of the catalogue. */
  readonly resumeAfterListingId: string | null;
}
