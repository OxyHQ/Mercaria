/**
 * The canonical "Sell yours" flow — issue #91.
 *
 * A person starts from a product Mercaria already knows about, or identifies
 * their item once, and publishes a P2P listing without retyping the brand, the
 * model or the specifications. The whole domain exists to make that saving
 * possible WITHOUT letting the canonical product speak for the physical object
 * in the seller's hands.
 *
 * ## The four things this module makes structural rather than conventional
 *
 * 1. **A prefilled fact is never a seller assertion.** Every canonical value a
 *    draft shows arrives inside a {@link SellerPrefillField} carrying its
 *    `origin`, and the origins are a DISJOINT pair: `canonical` (inherited, the
 *    seller has not spoken) and `seller` (they typed or confirmed it). There is
 *    no third value meaning "prefilled and treated as confirmed", so a screen
 *    cannot present an inherited value as the seller's own without inventing an
 *    origin that does not exist.
 * 2. **The canonical product never describes the ITEM.**
 *    {@link SELLER_PREFILLABLE_FIELDS} and {@link SELLER_OWNED_FIELDS} are
 *    disjoint tuples, gated by a test. Condition, condition evidence, price,
 *    photographs, accessories and fulfilment are in the second set and can never
 *    join the first — which is #91's "do not treat canonical specifications as
 *    seller evidence" as a vocabulary rather than as review discipline.
 * 3. **A seller's declared match is EVIDENCE, not a verdict.** #58's failure
 *    mode is the false merge, and a "Sell yours" flow is the most direct way to
 *    cause one: attaching a listing to a popular product page puts somebody's
 *    sale on a stranger's product. So a declaration passes through the same
 *    deterministic blockers a matcher does ({@link SellerMatchGateOutcome}), and
 *    a refusal publishes the listing UNMATCHED rather than guessing.
 * 4. **Guidance never becomes a price.** {@link SellerPriceGuidance} carries
 *    ranges, a market, a currency, a window, a sample size and a confidence —
 *    and no field a client could read as a recommended value to submit. The
 *    unknown branch of {@link SellerPriceGuidanceSegment} has no range at all,
 *    so "not enough data" cannot be rendered as a number.
 */

import type { ConditionDetailSeverity, ConditionGroup, ItemConditionKey } from './condition.js';
import type { CurrencyCode, Money } from './money.js';

// ---------------------------------------------------------------------------
// Entry, lifecycle and progress
// ---------------------------------------------------------------------------

/**
 * How a draft was STARTED (#91 entry paths 1–5).
 *
 * "Resume a saved draft" (entry path 6) is deliberately not a member: resuming
 * reads a draft that already records how it began, and adding a value for it
 * would overwrite that fact with the fact that somebody came back — which is
 * exactly the information a funnel needs to keep separate.
 */
export type SellerDraftEntryPath =
  /** `Sell yours` from a canonical product page. */
  | 'canonical_product'
  /** `Sell this variant` from a selected variant. */
  | 'canonical_variant'
  /** A barcode or identifier scan resolved to a canonical candidate. */
  | 'identifier_scan'
  /** The seller searched the catalogue and picked a product. */
  | 'catalog_search'
  /** Handmade, collectible or unknown — the seller declined to match. */
  | 'unmatched';

export const SELLER_DRAFT_ENTRY_PATHS: readonly SellerDraftEntryPath[] = [
  'canonical_product',
  'canonical_variant',
  'identifier_scan',
  'catalog_search',
  'unmatched',
];

/**
 * The lifecycle of one draft.
 *
 * `discarded` rather than a delete: a seller who abandons a draft that reached a
 * canonical match has still told the catalogue something (this product exists in
 * the wild, this identifier resolves here), and the match assertions are
 * append-only evidence that a deleted parent would take with it.
 */
export type SellerDraftStatus = 'in_progress' | 'published' | 'discarded';

export const SELLER_DRAFT_STATUSES: readonly SellerDraftStatus[] = [
  'in_progress',
  'published',
  'discarded',
];

/**
 * The steps of the flow, saved SERVER-side (#91 UX rule 1, acceptance "resume on
 * another Oxy client").
 *
 * Stored rather than derived, and that is deliberate: which step a person is on
 * is a fact about their session, not about the data. A draft with a price and no
 * photographs might be somebody who skipped ahead or somebody who went back, and
 * deriving the step from field completeness would move them without being asked.
 */
export type SellerDraftStep = 'identify' | 'condition' | 'photos' | 'details' | 'price' | 'review';

export const SELLER_DRAFT_STEPS: readonly SellerDraftStep[] = [
  'identify',
  'condition',
  'photos',
  'details',
  'price',
  'review',
];

// ---------------------------------------------------------------------------
// What is inherited and what is the seller's
// ---------------------------------------------------------------------------

/**
 * Where a value on a draft came from.
 *
 * Two members and no third. A `canonical` value is INHERITED — shown so the
 * seller does not retype it, and never stored as something they asserted. The
 * moment they edit or confirm it, it becomes `seller` and stays that way.
 */
export type SellerFieldOrigin = 'canonical' | 'seller';

export const SELLER_FIELD_ORIGINS: readonly SellerFieldOrigin[] = ['canonical', 'seller'];

/** One prefillable fact, with the provenance that decides how it may be rendered. */
export interface SellerPrefillField<T> {
  readonly value: T;
  readonly origin: SellerFieldOrigin;
  /**
   * Whether the seller has affirmatively confirmed this value.
   *
   * A `canonical` field is never confirmed — that is what makes #91's "a
   * prefilled value the seller did not confirm must not be presented as their
   * assertion" checkable rather than a copy review.
   */
  readonly confirmed: boolean;
}

/**
 * The facts a canonical product may supply (#91 canonical prefill 1–6).
 *
 * DISJOINT from {@link SELLER_OWNED_FIELDS} by a test. Every member here is a
 * statement about a MODEL, which is exactly the class of fact that is identical
 * for every copy of it in the world.
 */
export const SELLER_PREFILLABLE_FIELDS = [
  'title',
  'brand',
  'model',
  'identifiers',
  'variant_attributes',
  'category',
  'reference_image',
] as const;

export type SellerPrefillableField = (typeof SELLER_PREFILLABLE_FIELDS)[number];

/**
 * The facts only the SELLER can state (#91 seller-owned fields 1–11).
 *
 * Deliberately disjoint from the tuple above — the retail-pricing markup device.
 * The value of naming them is that a plausible future "we could inherit the
 * manufacturer's photo as the item photo" fails a build gate rather than passing
 * review, which is the same failure #90's photo-provenance vocabulary exists to
 * make unrepresentable.
 */
export const SELLER_OWNED_FIELDS = [
  'condition',
  'condition_details',
  'condition_acknowledgement',
  'item_photos',
  'included_accessories',
  'quantity',
  'price',
  'fulfilment',
  'coarse_location',
  'listing_title_override',
] as const;

export type SellerOwnedField = (typeof SELLER_OWNED_FIELDS)[number];

/**
 * The canonical prefill a draft carries, as a client sees it.
 *
 * `referenceImageFileId` is explicitly labelled by its own field name and by
 * {@link SELLER_REFERENCE_IMAGE_NOTICE}: it identifies the MODEL and is never
 * evidence about the item. It is not copied into the listing's gallery at
 * publication, and #90's trigger would refuse it if anything tried.
 */
export interface SellerCanonicalPrefill {
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string;
  readonly title: SellerPrefillField<string>;
  readonly brand?: SellerPrefillField<string>;
  readonly model?: SellerPrefillField<string>;
  readonly identifiers: readonly SellerPrefillField<string>[];
  readonly variantAttributes: readonly SellerPrefillField<{ key: string; value: string }>[];
  readonly category?: SellerPrefillField<string>;
  readonly referenceImageFileId?: string;
  readonly referenceImageNotice: typeof SELLER_REFERENCE_IMAGE_NOTICE;
}

/**
 * The standing statement that a canonical image is not evidence, shipped BESIDE
 * the image rather than written in a document.
 *
 * #78's `PRICE_HISTORY_DISPLAY_NOTICE` device: the claim a stock photograph
 * makes by accident is that it shows the item for sale, and the only place to
 * refuse that claim is next to the picture.
 */
export const SELLER_REFERENCE_IMAGE_NOTICE = {
  identificationOnly: true,
  isConditionEvidence: false,
  authenticatesPhysicalItem: false,
} as const;

// ---------------------------------------------------------------------------
// The match a seller declares
// ---------------------------------------------------------------------------

/**
 * Where a draft stands with the canonical graph.
 *
 * `review_required` and `unmatched` are different states and neither is a soft
 * version of the other: the first says a declaration was made and the
 * deterministic gate refused it, the second says nobody declared anything. Both
 * publish a perfectly valid listing (#91 listing creation 7), and only the first
 * leaves an assertion for #59 to read.
 */
export type SellerDraftMatchState =
  /** Nobody has proposed a canonical product. Handmade and unique items live here. */
  | 'unmatched'
  /** A candidate was surfaced (scan, search, product page) and not yet confirmed. */
  | 'proposed'
  /** The seller affirmatively said "yes, this is that product". */
  | 'seller_confirmed'
  /** The seller looked at a proposal and said no. */
  | 'seller_rejected'
  /** A confirmation was refused by the deterministic gate; a person must decide. */
  | 'review_required';

export const SELLER_DRAFT_MATCH_STATES: readonly SellerDraftMatchState[] = [
  'unmatched',
  'proposed',
  'seller_confirmed',
  'seller_rejected',
  'review_required',
];

/** Who asserted a canonical match on a draft. */
export type SellerMatchActor = 'seller' | 'matcher' | 'operator';

export const SELLER_MATCH_ACTORS: readonly SellerMatchActor[] = ['seller', 'matcher', 'operator'];

/**
 * The actors that carry a CONFIDENCE.
 *
 * Exactly one, and the CHECK is rendered from this tuple — #58's rule that a
 * deterministic attachment is certain by construction, so a number on it could
 * only be read as doubt about a fact nobody doubted. A person saying "this is my
 * phone" has no score either.
 */
export const SCORED_SELLER_MATCH_ACTORS: readonly SellerMatchActor[] = ['matcher'];

/** What one recorded assertion did (append-only; see `docs/sell-yours.md`). */
export type SellerMatchAssertionOutcome =
  /** A candidate was surfaced to the seller. */
  | 'declared'
  /** The seller confirmed it. */
  | 'confirmed'
  /** The seller rejected it, or changed an earlier confirmation. */
  | 'rejected'
  /** The deterministic gate refused to attach it and named its blockers. */
  | 'gate_refused'
  /** A `native_listing_links` row was written at publication. */
  | 'attached';

export const SELLER_MATCH_ASSERTION_OUTCOMES: readonly SellerMatchAssertionOutcome[] = [
  'declared',
  'confirmed',
  'rejected',
  'gate_refused',
  'attached',
];

/**
 * What the deterministic gate decided about a seller's declaration.
 *
 * A discriminated union whose `refused` branch has NO canonical ids: a caller
 * cannot attach a refused declaration by forgetting a check, because there is
 * nothing on that branch to attach.
 */
export type SellerMatchGateOutcome =
  | {
      readonly state: 'attach';
      readonly canonicalProductId: string;
      readonly canonicalVariantId: string;
    }
  | {
      readonly state: 'refused';
      readonly blockers: readonly string[];
      readonly reasonCodes: readonly string[];
    }
  | { readonly state: 'unmatched' };

// ---------------------------------------------------------------------------
// Fulfilment and location
// ---------------------------------------------------------------------------

/**
 * What the seller says about collection (#91 seller-owned field 8).
 *
 * `offered` is REPRESENTABLE and REFUSED at publication under
 * `pickup_not_supported`, the `role_email` device: #93 owns pickup publication,
 * freshness and collectable inventory, and #105's `assertPickupLocationEligible`
 * already refuses every pickup for the same reason. Modelling it as
 * unrepresentable would hide the gap; accepting it and publishing a listing
 * whose pickup nothing honours would be worse.
 */
export type SellerPickupAvailability = 'not_offered' | 'offered';

export const SELLER_PICKUP_AVAILABILITIES: readonly SellerPickupAvailability[] = [
  'not_offered',
  'offered',
];

/**
 * How many decimal places a published coarse location keeps.
 *
 * Two, which is about 1.1 km at the equator — a neighbourhood, not a doorstep.
 * A constant rather than a per-request precision, because a precision a client
 * could choose is a precision somebody sets to seven, and the seller opted in to
 * "roughly where I am" rather than to an address.
 */
export const SELLER_LOCATION_PRECISION_DECIMALS = 2;

/** Round a coordinate to the published grid. Exported so one rule serves both ends. */
export function coarsenSellerCoordinate(value: number): number {
  const factor = 10 ** SELLER_LOCATION_PRECISION_DECIMALS;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Protected proof fields — DEFINED and NOT CAPTURABLE
// ---------------------------------------------------------------------------

/**
 * Identity evidence a seller might be asked for (#91 seller-owned field 10) —
 * and NONE of it may be sent to Mercaria today.
 *
 * The `role_email` (#83) and `replacement` (#110) device: the vocabulary exists
 * so the gap is legible and so enabling it later is not a schema change, and the
 * API refuses any of these keys BY NAME rather than with "unrecognized field".
 *
 * The reason it is refused rather than stored: a protected identity-evidence
 * store needs a reader, and the only legitimate reader is a moderation review
 * whose vocabulary CrowdSource owns (#90 made the same call about condition
 * reason codes). A write-only encrypted column with no reviewer is a place
 * secrets go to sit — it carries every risk of holding a serial number and none
 * of the benefit.
 */
export const SELLER_PROOF_FIELD_KINDS = [
  'serial_number',
  'imei',
  'proof_of_purchase',
  'authenticity_certificate',
] as const;

export type SellerProofFieldKind = (typeof SELLER_PROOF_FIELD_KINDS)[number];

// ---------------------------------------------------------------------------
// Publication readiness
// ---------------------------------------------------------------------------

/**
 * Why a draft cannot be published yet.
 *
 * A closed set, because the client renders one message per reason and a free
 * sentence cannot be translated, tested or counted. Every member names a fact
 * the seller can act on; none of them names another seller, a stock level or a
 * moderation decision.
 */
export type SellerDraftBlockReason =
  | 'title_missing'
  | 'description_missing'
  | 'category_missing'
  | 'condition_missing'
  | 'item_photos_missing'
  | 'defects_not_acknowledged'
  | 'refurbisher_not_named'
  | 'price_missing'
  | 'quantity_invalid'
  /**
   * The seller named a product but not a configuration.
   *
   * A block rather than a silent unmatched publication: `native_listing_links`
   * attaches a native variant to a canonical VARIANT, so there is nothing to
   * write — and picking one for them is exactly the invention #58 rule 5
   * forbids. The remedy is one tap, which is why it is worth asking for.
   */
  | 'match_variant_missing'
  | 'match_review_required'
  | 'pickup_not_supported'
  | 'category_forbids_condition'
  | 'already_published'
  | 'draft_discarded';

export const SELLER_DRAFT_BLOCK_REASONS: readonly SellerDraftBlockReason[] = [
  'title_missing',
  'description_missing',
  'category_missing',
  'condition_missing',
  'item_photos_missing',
  'defects_not_acknowledged',
  'refurbisher_not_named',
  'price_missing',
  'quantity_invalid',
  'match_variant_missing',
  'match_review_required',
  'pickup_not_supported',
  'category_forbids_condition',
  'already_published',
  'draft_discarded',
];

/**
 * A warning that does NOT block publication (#91 price guidance: "Extreme values
 * may produce a warning before publication").
 *
 * Kept apart from the blocks above because collapsing them is how an unusual but
 * valid price becomes unpublishable — which #91 forbids in the same sentence
 * that asks for the warning.
 */
export type SellerDraftWarning = 'price_far_below_guidance' | 'price_far_above_guidance';

export const SELLER_DRAFT_WARNINGS: readonly SellerDraftWarning[] = [
  'price_far_below_guidance',
  'price_far_above_guidance',
];

/**
 * The multiple of the guidance range beyond which a price earns a warning.
 *
 * One constant read by one function, so "extreme" means the same thing in the
 * preview and at publication. Deliberately generous: a rare variant legitimately
 * sells for several times the ordinary range, and a warning nobody believes is a
 * warning everybody dismisses.
 */
export const SELLER_PRICE_EXTREME_FACTOR = 4;

// ---------------------------------------------------------------------------
// Price guidance
// ---------------------------------------------------------------------------

/**
 * How much a guidance figure is worth (#91 price guidance rule 5).
 *
 * `insufficient_data` is a real answer and the DEFAULT one. It is not a level of
 * confidence in a number; it means there is no number, which is why the segment
 * union below has no range on that branch.
 */
export type SellerPriceGuidanceConfidence = 'insufficient_data' | 'low' | 'medium' | 'high';

export const SELLER_PRICE_GUIDANCE_CONFIDENCES: readonly SellerPriceGuidanceConfidence[] = [
  'insufficient_data',
  'low',
  'medium',
  'high',
];

/**
 * The minimum number of independent observations a guidance range needs.
 *
 * Below it the segment answers `insufficient_data` with no range at all. Three
 * is not a statistical claim — it is the floor below which a "range" is one
 * seller's asking price wearing a plural.
 */
export const SELLER_GUIDANCE_MIN_SAMPLE = 3;

/**
 * The floors a SOLD-price segment must clear (#91 price guidance rule 3:
 * "only if policy and sample size permit it").
 *
 * Two floors rather than one, and the second is the privacy floor: a range over
 * five sales that were all made by the same person is that person's sales
 * history, republished to whoever asks. #77's disclosure-floor reasoning, on a
 * different denominator.
 */
export const SELLER_SOLD_GUIDANCE_MIN_SAMPLE = 5;
export const SELLER_SOLD_GUIDANCE_MIN_DISTINCT_SELLERS = 3;

/** Which reference a guidance segment answers about. */
export type SellerPriceGuidanceSegmentKind =
  /** Currently eligible offers in the seller's own condition group. */
  | 'current_same_condition'
  /** Currently eligible NEW offers, labelled as such. */
  | 'current_new'
  /** Currently eligible REFURBISHED offers, labelled as such. */
  | 'current_refurbished'
  /** What comparable native listings actually sold for. */
  | 'recent_sold_native';

export const SELLER_PRICE_GUIDANCE_SEGMENT_KINDS: readonly SellerPriceGuidanceSegmentKind[] = [
  'current_same_condition',
  'current_new',
  'current_refurbished',
  'recent_sold_native',
];

/**
 * One guidance segment.
 *
 * A discriminated union: the `insufficient_data` branch has no `low`, no `high`
 * and no `sampleSize` a client could render as a number. That is #91's
 * "confidence or insufficient-data state" held by the type rather than by
 * whoever writes the screen — and it is the reason nothing here can quietly
 * become a suggested price.
 */
export type SellerPriceGuidanceSegment =
  | {
      readonly kind: SellerPriceGuidanceSegmentKind;
      readonly conditionGroup: ConditionGroup;
      readonly state: 'insufficient_data';
      /** Why: which floor was not met. Never a number. */
      readonly reason: 'no_observations' | 'below_sample_floor' | 'below_seller_floor';
    }
  | {
      readonly kind: SellerPriceGuidanceSegmentKind;
      readonly conditionGroup: ConditionGroup;
      readonly state: 'available';
      readonly low: Money;
      readonly median: Money;
      readonly high: Money;
      readonly sampleSize: number;
      readonly confidence: Exclude<SellerPriceGuidanceConfidence, 'insufficient_data'>;
    };

/**
 * The guidance a seller sees, with everything needed to read it honestly.
 *
 * `market`, `currency` and the window are REQUIRED — #78's rule that a figure
 * which does not say what it is about is a figure that cannot be wrong. There is
 * deliberately no `suggestedPrice`, no `recommended` and no `autoFill`: guidance
 * that names a number to submit is a price the marketplace set.
 */
export interface SellerPriceGuidance {
  readonly canonicalVariantId?: string;
  readonly canonicalProductId?: string;
  readonly market?: string;
  readonly currency: CurrencyCode;
  readonly from: string;
  readonly to: string;
  readonly segments: readonly SellerPriceGuidanceSegment[];
  /**
   * The standing statement that guidance is not an offer, a valuation or a
   * promise — the `PRICE_HISTORY_DISPLAY_NOTICE` device.
   */
  readonly notice: typeof SELLER_PRICE_GUIDANCE_NOTICE;
}

export const SELLER_PRICE_GUIDANCE_NOTICE = {
  setsPriceAutomatically: false,
  guaranteesSale: false,
  blocksUnusualPrice: false,
} as const;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One structured condition detail as a draft holds it (#90's vocabulary). */
export interface SellerDraftConditionDetailDTO {
  readonly id: string;
  readonly kind: string;
  readonly severity?: ConditionDetailSeverity;
  readonly note?: string;
}

/** One seller-owned photograph on a draft. */
export interface SellerDraftImageDTO {
  readonly id: string;
  /** A bare Oxy media file id — resolved through the shared media chokepoint. */
  readonly fileId: string;
  readonly alt?: string;
  readonly position: number;
  /** Always seller-owned; #90's provenance vocabulary has no other kind. */
  readonly provenance: string;
  readonly showsDefect: boolean;
  readonly conditionDetailId?: string;
}

/** A draft, as its owner sees it. */
export interface SellerDraftDTO {
  readonly id: string;
  readonly entryPath: SellerDraftEntryPath;
  readonly status: SellerDraftStatus;
  readonly currentStep: SellerDraftStep;
  readonly completedSteps: readonly SellerDraftStep[];
  readonly matchState: SellerDraftMatchState;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly prefill?: SellerCanonicalPrefill;
  readonly title?: string;
  /**
   * Whether the seller's title differs from the canonical product's name.
   *
   * DERIVED, never stored (#91 listing creation 5): a stored flag beside a
   * stored title is two representations of one fact, and the one that goes
   * stale is the flag. A `true` here changes nothing about the canonical
   * product — it is listing PRESENTATION and says so.
   */
  readonly titleOverridesCanonical: boolean;
  readonly description?: string;
  readonly categorySlug?: string;
  readonly tags: readonly string[];
  readonly conditionKey?: ItemConditionKey;
  readonly conditionGroup?: ConditionGroup;
  readonly conditionDetails: readonly SellerDraftConditionDetailDTO[];
  readonly defectsAcknowledgedAt?: string;
  readonly includedAccessories: readonly string[];
  readonly images: readonly SellerDraftImageDTO[];
  readonly quantity: number;
  readonly price?: Money;
  readonly pickup: SellerPickupAvailability;
  readonly locationOptIn: boolean;
  readonly publishedListingId?: string;
  readonly publishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Whether a draft may be published, and what stands in the way. */
export interface SellerDraftReadiness {
  readonly publishable: boolean;
  readonly blockReasons: readonly SellerDraftBlockReason[];
  readonly warnings: readonly SellerDraftWarning[];
  /** The item-photo minimum this draft's condition requires (#90's policy table). */
  readonly requiredItemPhotos: number;
}

/**
 * Where a published listing will appear (#91 UX rule 7).
 *
 * Three booleans rather than prose, because the answer differs per draft and a
 * screen that promises a canonical product page for an unmatched listing is
 * telling somebody their handmade chair will appear on a product comparison.
 */
export interface SellerDraftPlacement {
  readonly onCanonicalProduct: boolean;
  readonly onSellerProfile: boolean;
  readonly inLocalResults: boolean;
}

/** Everything a review step renders. */
export interface SellerDraftPreview {
  readonly draft: SellerDraftDTO;
  readonly readiness: SellerDraftReadiness;
  readonly placement: SellerDraftPlacement;
  readonly guidance?: SellerPriceGuidance;
}

/** One canonical candidate offered to a seller during the identify step. */
export interface SellerMatchCandidateDTO {
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string;
  readonly title: string;
  readonly brand?: string;
  readonly imageFileId?: string;
  /**
   * How this candidate was found. A LABEL for the seller, never a score — a
   * number beside a product a person is about to claim reads as a probability
   * that they are right.
   */
  readonly foundBy: 'identifier' | 'search';
}
