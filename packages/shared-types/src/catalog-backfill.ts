/**
 * Classifying the listing-first catalogue against the universal catalog system
 * — #367 workstream 13, ADR 0007 D6/D7/D12/D13.
 *
 * The epic asks for one thing before any row is written: **classify legacy rows
 * as deterministic, high-confidence, ambiguous or invalid.** That classification
 * is the deliverable, not a step toward one — "N deterministic, M ambiguous,
 * K invalid" with the ambiguous ones queued and visible is what a person needs
 * in order to decide what to migrate, and a migration that resolved the
 * ambiguous ones to make the number look better would be the false merge #58 is
 * shaped around, arriving through the door marked "backfill".
 *
 * ## The failure this vocabulary is shaped around
 *
 * A serious port bug fails by returning something PLAUSIBLE. `Tono` looks like
 * `Color`; `Knitwear` looks like it ought to be a product type; a merged
 * category looks like a live one from every read that does not check
 * `lifecycle`. Every one of those produces a migration report full of
 * confident-looking numbers, and the mistake is found by a seller whose blue
 * shoes are filed under somebody's idea of black.
 *
 * So the vocabulary here is built to make the confident answer the RARE one:
 *
 * - {@link LEGACY_MAPPING_REASONS} is closed, and every member names the exact
 *   evidence that produced it. A reason is never "we think so".
 * - {@link LEGACY_MAPPING_REASON_CLASSES} is a `Record`, so a reason with no
 *   class is a compile error rather than a row filed under a default.
 * - {@link LEGACY_CATALOG_FORBIDDEN_SIGNALS} names ten inputs that may never
 *   decide a mapping, disjoint from {@link LEGACY_CATALOG_CANDIDATE_SIGNALS} by
 *   a test, and a scanned gate fails the build if the domain learns to compute
 *   one. There is no similarity metric anywhere in this domain.
 * - {@link LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE} is separate from mere
 *   permission, because the two most tempting signals — a brand's normalized
 *   name and one of its aliases — are legitimate CANDIDATE evidence for a person
 *   and may never author an attachment (ADR 0007 D1: a label is presentation,
 *   never identity; #55's `verification_method` has no `name_match` member).
 *
 * ## `not_applicable` is not a fifth confidence level
 *
 * It means the row carries no legacy value for that subject at all — an
 * uncategorized listing has no category to map, a listing with no `vendor` text
 * has no brand claim to weigh. It exists because the counters must SUM to the
 * population by EQUALITY: a pass that swallowed a row and a clean pass over a
 * healthy catalogue produce identical output otherwise
 * (`catalog_backfill_runs_counters_total_check`'s rule, #60).
 *
 * How much of the catalogue carries a value at all is a DIFFERENT question and
 * is answered separately, by {@link LegacyCatalogCoverage} — conflating coverage
 * with mapping validity is what makes a migration report unreadable.
 */

/**
 * The legacy fields this epic has to move, one per (table, column group).
 *
 * Two of the six are classified by #367 step 4 and not by this domain — see
 * {@link LEGACY_CATALOG_SUBJECT_CLASSIFIERS}. They are named here anyway because
 * the INVENTORY is the deliverable: a matrix that covered four of the six legacy
 * fields would be a map with a hole in it, and a hole in a map reads exactly
 * like flat ground.
 */
export const LEGACY_CATALOG_SUBJECT_KINDS = [
  /** `listings.category_id` — which taxonomy node a listing is filed under. */
  'listing_category_assignment',
  /** `listings.category_slugs` — the denormalized ancestor path, D13's v1 read contract. */
  'listing_category_path',
  /** `listings.product_type` — free text, predating `product_type_definitions`. */
  'listing_product_type_text',
  /** `listings.vendor` — free text, predating `brands`. */
  'listing_vendor_text',
  /** `listing_options.name` — free text, retained as a claim by ADR 0007 D6. */
  'listing_option_name',
  /** `product_variant_option_values.name`/`.value` — the same, at the variant grain. */
  'variant_option_value',
] as const;

/** One of {@link LEGACY_CATALOG_SUBJECT_KINDS}. */
export type LegacyCatalogSubjectKind = (typeof LEGACY_CATALOG_SUBJECT_KINDS)[number];

/** Which domain answers the classification question for a subject. */
export const LEGACY_CATALOG_CLASSIFIERS = ['catalog_backfill', 'variant_axes'] as const;

/** One of {@link LEGACY_CATALOG_CLASSIFIERS}. */
export type LegacyCatalogClassifier = (typeof LEGACY_CATALOG_CLASSIFIERS)[number];

/**
 * Who classifies each subject.
 *
 * The two option subjects are `variant_axes` — #367 step 4 already classifies
 * them, under its OWN refusal vocabulary
 * (`VariantAxisAttributeRefusal`/`VariantAxisValueRefusal`), against its own
 * evidence. Re-classifying them here would be a second authority over one fact,
 * and the two would disagree the first time somebody published an alias. This
 * domain QUOTES step 4's counts instead — see
 * {@link LegacyCatalogClassificationReport.retainedClaims}.
 */
export const LEGACY_CATALOG_SUBJECT_CLASSIFIERS: Readonly<
  Record<LegacyCatalogSubjectKind, LegacyCatalogClassifier>
> = {
  listing_category_assignment: 'catalog_backfill',
  listing_category_path: 'catalog_backfill',
  listing_product_type_text: 'catalog_backfill',
  listing_vendor_text: 'catalog_backfill',
  listing_option_name: 'variant_axes',
  variant_option_value: 'variant_axes',
};

/**
 * What one row of a subject's tally COUNTS.
 *
 * Not every legacy field is a per-listing question. A vendor string is a VALUE:
 * three hundred listings spelling `Nike` are one mapping decision, not three
 * hundred, and a per-listing count of them would report a catalogue as
 * overwhelmingly high-confidence because one popular seller repeats. #60's
 * `vendor_brand_candidates` stage groups the same way and refuses a cohort for
 * the same reason — a cohort-scoped aggregate produces groups that are not the
 * real groups.
 */
export const LEGACY_CATALOG_SUBJECT_GRAINS: Readonly<
  Record<LegacyCatalogSubjectKind, 'listing' | 'vendor_value' | 'listing_option' | 'option_value'>
> = {
  listing_category_assignment: 'listing',
  listing_category_path: 'listing',
  listing_product_type_text: 'listing',
  listing_vendor_text: 'vendor_value',
  listing_option_name: 'listing_option',
  variant_option_value: 'option_value',
};

/**
 * How strong the evidence for a legacy row's mapping is.
 *
 * The epic's four, plus `not_applicable` for a row with no legacy value — read
 * the module header for why that is not a fifth level.
 */
export const LEGACY_MAPPING_CLASSES = [
  /** One target, from an identity fact already stored. No person needed. */
  'deterministic',
  /** One target, from evidence a person recorded about a CLASS of values. */
  'high_confidence',
  /** More than one candidate, or a candidate the rules refuse to choose between. */
  'ambiguous',
  /** The legacy value names no target in the new model. */
  'invalid',
  /** The row carries no legacy value for this subject. */
  'not_applicable',
] as const;

/** One of {@link LEGACY_MAPPING_CLASSES}. */
export type LegacyMappingClass = (typeof LEGACY_MAPPING_CLASSES)[number];

/**
 * Who owes the next action on a row.
 *
 * `automatic` and `none` are not the same as a person: `automatic` is a job that
 * can act with no judgement, `none` is a row that is already where it belongs.
 * The invariant a census asserts is `(owner === 'none') === !actionable` — so a
 * row nobody owes anything on cannot be marked as owing work, and work cannot be
 * owed to nobody.
 */
export const LEGACY_REVIEW_OWNERS = ['automatic', 'catalog_operator', 'merchant', 'none'] as const;

/** One of {@link LEGACY_REVIEW_OWNERS}. */
export type LegacyReviewOwner = (typeof LEGACY_REVIEW_OWNERS)[number];

/**
 * Every verdict this domain can reach, and the evidence each one names.
 *
 * Closed, and prefixed by subject so a reason read out of a report says what it
 * is about without a second column. `LEGACY_MAPPING_REASON_SUBJECTS` states the
 * subject relationally anyway — a prefix is a spelling and a `Record` is a fact.
 */
export const LEGACY_MAPPING_REASONS = [
  // --- listings.category_id -------------------------------------------------
  /** Published, selectable, inside its effective window. Nothing is owed. */
  'category_assignment_current',
  /** The node was merged and the chain resolves to a live selectable node. */
  'category_assignment_merged_target_live',
  /** Merged, but the chain ends nowhere usable, cycles, or runs too deep. */
  'category_assignment_merge_chain_unresolved',
  /** A structural node: a real node, but not one a product may be filed under. */
  'category_assignment_not_selectable',
  /** Deprecated with no successor named. */
  'category_assignment_deprecated',
  /**
   * Suppressed — withheld from the shopper-visible tree while still assignable.
   * Mercaria's connector holding pen is exactly this, so this bucket is a
   * legitimate backlog rather than damage; it is still a listing nobody can
   * browse to.
   */
  'category_assignment_suppressed',
  /** Filed under a node that was authored and never published. */
  'category_assignment_unpublished_node',
  /** The node's `effective_from`/`effective_to` window does not cover now. */
  'category_assignment_outside_effective_window',
  /** `category_id IS NULL` — an uncategorized listing, a real and different state. */
  'category_assignment_absent',

  // --- listings.category_slugs ----------------------------------------------
  /** The stored path is exactly the path the taxonomy derives today. */
  'category_path_agrees',
  /** The stored path differs from the derivation — a projection to re-derive. */
  'category_path_drifted',
  /** A path with no category to have derived it from. */
  'category_path_present_without_category',
  /** No category and no path. Consistent, and nothing to derive. */
  'category_path_absent_without_category',

  // --- listings.product_type ------------------------------------------------
  /** No free text to map. */
  'product_type_text_absent',
  /** The folded text IS a published key, and that version is scoped here. */
  'product_type_key_published_and_eligible',
  /** The key is published, and its scope does not reach this listing's category. */
  'product_type_key_published_not_eligible',
  /** The listing has no category, so eligibility cannot be decided at all. */
  'product_type_key_category_unknown',
  /** A version exists under the key, and none of them is published. */
  'product_type_key_unpublished',
  /** The folded text is not a key any version carries. */
  'product_type_no_registered_key',

  // --- listings.vendor ------------------------------------------------------
  /**
   * The text normalizes to nothing — punctuation, a lone separator, an emoji.
   *
   * There is deliberately no `vendor_text_absent` member beside it: this
   * subject's grain is the VALUE, so a listing with no vendor string is not a
   * row of this tally at all (it is a `LegacyCatalogCoverage` figure). A reason
   * nothing can produce reads as coverage, which is the one thing a migration
   * vocabulary must not do.
   */
  'vendor_text_unnormalizable',
  /** Exactly one active brand answers to the normalized text or one of its aliases. */
  'vendor_brand_single_candidate',
  /** Several do. Picking one is a coin toss with a brand's identity on it. */
  'vendor_brand_multiple_candidates',
  /** None does. */
  'vendor_brand_no_candidate',
] as const;

/** One of {@link LEGACY_MAPPING_REASONS}. */
export type LegacyMappingReason = (typeof LEGACY_MAPPING_REASONS)[number];

/**
 * What each reason means, as one record per reason.
 *
 * A `Record` rather than an array of `{reason, …}`, deliberately: a `Record`
 * over a union cannot omit a member, where an array silently can — and a reason
 * missing from a table of classes would be counted under whatever the reader's
 * fallback was, which for a migration report is the one failure that looks like
 * a result.
 *
 * `actionable` is whether work is owed on the row; `reviewOwner` is whether a
 * PERSON owes it. They are independent: a merged category with a live target is
 * actionable and needs nobody, and a current assignment is neither.
 */
export const LEGACY_MAPPING_REASON_CLASSES: Readonly<
  Record<
    LegacyMappingReason,
    {
      readonly subject: LegacyCatalogSubjectKind;
      readonly mappingClass: LegacyMappingClass;
      readonly actionable: boolean;
      readonly reviewOwner: LegacyReviewOwner;
    }
  >
> = {
  category_assignment_current: {
    subject: 'listing_category_assignment',
    mappingClass: 'deterministic',
    actionable: false,
    reviewOwner: 'none',
  },
  category_assignment_merged_target_live: {
    subject: 'listing_category_assignment',
    mappingClass: 'deterministic',
    actionable: true,
    reviewOwner: 'automatic',
  },
  category_assignment_merge_chain_unresolved: {
    subject: 'listing_category_assignment',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  category_assignment_not_selectable: {
    subject: 'listing_category_assignment',
    mappingClass: 'ambiguous',
    actionable: true,
    // The merchant, not the operator: choosing which shelf under a department a
    // product belongs on is a fact about the product, and the operator who
    // published the department does not know it.
    reviewOwner: 'merchant',
  },
  category_assignment_deprecated: {
    subject: 'listing_category_assignment',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  category_assignment_suppressed: {
    subject: 'listing_category_assignment',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  category_assignment_unpublished_node: {
    subject: 'listing_category_assignment',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  category_assignment_outside_effective_window: {
    subject: 'listing_category_assignment',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  category_assignment_absent: {
    subject: 'listing_category_assignment',
    mappingClass: 'not_applicable',
    actionable: false,
    reviewOwner: 'none',
  },

  category_path_agrees: {
    subject: 'listing_category_path',
    mappingClass: 'deterministic',
    actionable: false,
    reviewOwner: 'none',
  },
  category_path_drifted: {
    subject: 'listing_category_path',
    mappingClass: 'deterministic',
    actionable: true,
    reviewOwner: 'automatic',
  },
  category_path_present_without_category: {
    subject: 'listing_category_path',
    mappingClass: 'invalid',
    actionable: true,
    reviewOwner: 'automatic',
  },
  category_path_absent_without_category: {
    subject: 'listing_category_path',
    mappingClass: 'not_applicable',
    actionable: false,
    reviewOwner: 'none',
  },

  product_type_text_absent: {
    subject: 'listing_product_type_text',
    mappingClass: 'not_applicable',
    actionable: false,
    reviewOwner: 'none',
  },
  product_type_key_published_and_eligible: {
    subject: 'listing_product_type_text',
    mappingClass: 'deterministic',
    actionable: true,
    // `automatic` names the strength of the evidence, not a job that exists
    // today: `listings` carries no `product_type_definition_id` yet, and ADR
    // 0007 D13 assigns that column to the authoring workstream. See
    // `LEGACY_CATALOG_WRITE_OWNERS`.
    reviewOwner: 'automatic',
  },
  product_type_key_published_not_eligible: {
    subject: 'listing_product_type_text',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  product_type_key_category_unknown: {
    subject: 'listing_product_type_text',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'merchant',
  },
  product_type_key_unpublished: {
    subject: 'listing_product_type_text',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  product_type_no_registered_key: {
    subject: 'listing_product_type_text',
    mappingClass: 'invalid',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },

  vendor_text_unnormalizable: {
    subject: 'listing_vendor_text',
    mappingClass: 'invalid',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  vendor_brand_single_candidate: {
    subject: 'listing_vendor_text',
    mappingClass: 'high_confidence',
    actionable: true,
    // A person, ALWAYS. A normalized-name match is a candidate, never identity
    // (ADR 0007 D1), and `LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE` says so about
    // both brand signals.
    reviewOwner: 'catalog_operator',
  },
  vendor_brand_multiple_candidates: {
    subject: 'listing_vendor_text',
    mappingClass: 'ambiguous',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
  vendor_brand_no_candidate: {
    subject: 'listing_vendor_text',
    mappingClass: 'invalid',
    actionable: true,
    reviewOwner: 'catalog_operator',
  },
};

/**
 * What EVIDENCE may drive a write for a subject — the epic's rule, as data.
 *
 * "Backfill category IDs only when mapping is deterministic. Backfill attribute
 * definition/value IDs using aliases and category context." The asymmetry is
 * real and is the whole of why these are two members: an attribute value's alias
 * is a human statement that this spelling means that controlled value, and a
 * category has no comparable statement about a LISTING.
 */
export const LEGACY_CATALOG_BACKFILL_POLICIES = [
  'deterministic_only',
  'alias_evidence_permitted',
  'never_backfilled',
] as const;

/** One of {@link LEGACY_CATALOG_BACKFILL_POLICIES}. */
export type LegacyCatalogBackfillPolicy = (typeof LEGACY_CATALOG_BACKFILL_POLICIES)[number];

/** Which module performs the write for a subject, today. */
export const LEGACY_CATALOG_WRITERS = [
  /** This domain. */
  'catalog_backfill',
  /** #367 step 4, `services/variant-axes/backfill.service.ts`. */
  'variant_axes',
  /** #60, `services/backfill/stages/vendor-brands.ts` — candidates only, no brand. */
  'canonical_graph_backfill',
  /** Nothing writes it yet, and the seam is named in `docs/catalog-backfill.md`. */
  'none_yet',
] as const;

/** One of {@link LEGACY_CATALOG_WRITERS}. */
export type LegacyCatalogWriter = (typeof LEGACY_CATALOG_WRITERS)[number];

/**
 * The backfill policy per subject.
 *
 * Kept apart from {@link LEGACY_CATALOG_WRITE_OWNERS} because they answer
 * different questions: this one is what evidence WOULD justify a write, that one
 * is who performs it today. Collapsing them would make "nothing writes this yet"
 * indistinguishable from "nothing may ever write this", and only one of those is
 * a seam somebody closes.
 */
export const LEGACY_CATALOG_BACKFILL_POLICY: Readonly<
  Record<LegacyCatalogSubjectKind, LegacyCatalogBackfillPolicy>
> = {
  listing_category_assignment: 'deterministic_only',
  listing_category_path: 'deterministic_only',
  listing_product_type_text: 'deterministic_only',
  // A vendor string is a NAME. ADR 0007 D1 makes a label presentation and #55
  // has no `name_match` verification method, so no amount of exactness makes it
  // identity — #60's `vendor_brand_candidates` stage extracts candidates and
  // creates no brand, and this subject is reported for the same reason.
  listing_vendor_text: 'never_backfilled',
  listing_option_name: 'alias_evidence_permitted',
  variant_option_value: 'alias_evidence_permitted',
};

/** Who performs the write for each subject today. */
export const LEGACY_CATALOG_WRITE_OWNERS: Readonly<
  Record<LegacyCatalogSubjectKind, LegacyCatalogWriter>
> = {
  // Deterministic and NOT written here: a repoint destroys the previous
  // category id, so it is only reversible beside a durable record of what it
  // replaced. `docs/catalog-backfill.md` §"The repair this domain does not
  // perform" states what that record would be.
  listing_category_assignment: 'none_yet',
  // The one apply path. A derived projection over `category_id`: re-running is
  // the rollback, because the correct value is always re-derivable.
  listing_category_path: 'catalog_backfill',
  // `listings` has no `product_type_definition_id`; ADR 0007 D13 assigns it to
  // the authoring workstream.
  listing_product_type_text: 'none_yet',
  listing_vendor_text: 'canonical_graph_backfill',
  listing_option_name: 'variant_axes',
  variant_option_value: 'variant_axes',
};

/**
 * Every input this domain is allowed to consult when it classifies a row.
 *
 * Each is an EXACT lookup against something somebody stored deliberately. There
 * is no similarity metric, no distance, no threshold and no score anywhere in
 * the domain, which is what `catalog-backfill-isolation.test.ts` asserts.
 */
export const LEGACY_CATALOG_CANDIDATE_SIGNALS = [
  'stored_category_id',
  'category_lifecycle',
  'category_selectable',
  'category_merge_pointer',
  'category_ancestor_ids',
  'category_effective_window',
  'product_type_key_exact',
  'product_type_lifecycle',
  'product_type_category_scope',
  'brand_normalized_name_exact',
  'brand_alias_normalized_exact',
] as const;

/** One of {@link LEGACY_CATALOG_CANDIDATE_SIGNALS}. */
export type LegacyCatalogCandidateSignal = (typeof LEGACY_CATALOG_CANDIDATE_SIGNALS)[number];

/**
 * Whether a signal may author a write, or may only put a candidate in front of a
 * person.
 *
 * Separate from mere permission, and the two brand signals are why. An exact
 * normalized-name match against exactly one active brand is perfectly good
 * evidence for an operator to look at and terrible evidence to attach identity
 * on: two companies share a name, a merchant's shop name is not the maker, and a
 * wrong brand attachment is invisible from every screen that renders it.
 */
export const LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE: Readonly<
  Record<LegacyCatalogCandidateSignal, boolean>
> = {
  stored_category_id: true,
  category_lifecycle: true,
  category_selectable: true,
  category_merge_pointer: true,
  category_ancestor_ids: true,
  category_effective_window: true,
  product_type_key_exact: true,
  product_type_lifecycle: true,
  product_type_category_scope: true,
  brand_normalized_name_exact: false,
  brand_alias_normalized_exact: false,
};

/**
 * Inputs that may NEVER decide a legacy mapping, named as VALUES.
 *
 * Disjoint from {@link LEGACY_CATALOG_CANDIDATE_SIGNALS} by a test, and scanned
 * for in the domain's own source with a mutation self-test. Every one of them is
 * something a reasonable person reaches for while staring at a migration report
 * with too many `invalid` rows in it, and every one of them turns an honest
 * backlog into a confident wrong answer.
 */
export const LEGACY_CATALOG_FORBIDDEN_SIGNALS = [
  'trigram_similarity',
  'levenshtein_distance',
  'localized_label_match',
  'category_name_match',
  'product_type_name_match',
  'brand_name_to_category_inference',
  'listing_title_keyword',
  'listing_tag_keyword',
  'sibling_listing_majority_vote',
  'machine_translation',
] as const;

/** One of {@link LEGACY_CATALOG_FORBIDDEN_SIGNALS}. */
export type LegacyCatalogForbiddenSignal = (typeof LEGACY_CATALOG_FORBIDDEN_SIGNALS)[number];

/** One row's verdict. */
export interface LegacyCatalogVerdict {
  readonly subject: LegacyCatalogSubjectKind;
  readonly reason: LegacyMappingReason;
  /**
   * The target this verdict resolved to, when it resolved to exactly one and the
   * target is an id rather than a derivation. `null` otherwise — including for
   * `category_path_drifted`, whose target is an array and is re-derived at the
   * moment of writing rather than carried.
   */
  readonly targetId: string | null;
}

/**
 * How much of the catalogue carries a legacy value at all.
 *
 * Reported beside the classification and never folded into it: "how many
 * listings have no category" and "how many listings have a category that no
 * longer works" are different questions, and a single number answering both is
 * a number nobody can act on. It is also the classification's POSITIVE CONTROL —
 * a pass reporting zero classified rows while these are positive is a broken
 * pager, and `assertReportSums` throws rather than printing the tidy zero.
 */
export interface LegacyCatalogCoverage {
  readonly listingsTotal: number;
  readonly withCategory: number;
  readonly withoutCategory: number;
  readonly withProductTypeText: number;
  readonly withVendorText: number;
  readonly withLegacyOptions: number;
}

/** Per-class and per-reason tallies for one subject. */
export interface LegacyCatalogSubjectTally {
  readonly scanned: number;
  readonly byClass: Readonly<Record<LegacyMappingClass, number>>;
  readonly byReason: Readonly<Partial<Record<LegacyMappingReason, number>>>;
  /** Rows on which work is owed — `byReason` filtered by `actionable`. */
  readonly actionable: number;
  /** Rows on which a PERSON owes work, by who owes it. */
  readonly awaitingReview: Readonly<Record<LegacyReviewOwner, number>>;
}

/**
 * What #367 step 4 has left unresolved, quoted rather than recomputed.
 *
 * Always WHOLE-CATALOGUE, even on a cohort-scoped pass: the figure comes from
 * step 4's own `countQueuedClaims`, whose vocabulary and scoping are that
 * domain's, and narrowing somebody else's number to this pass's cohort would be
 * this domain deciding what their backlog means.
 */
export interface LegacyRetainedClaimSummary {
  readonly queued: number;
  readonly neverAttempted: number;
  readonly byAttributeRefusal: Readonly<Record<string, number>>;
  readonly byValueRefusal: Readonly<Record<string, number>>;
}

/**
 * What a pass has to say about one subject.
 *
 * A discriminated union rather than `Tally | null`, because `null` would carry
 * three different meanings — classified by another domain, not reached by this
 * page, and genuinely empty — and a reader would have to guess which. The
 * `state` says it, and a `Record` over the subject tuple means every subject has
 * one.
 */
export type LegacyCatalogSubjectResult =
  | { readonly state: 'tallied'; readonly tally: LegacyCatalogSubjectTally }
  | { readonly state: 'classified_elsewhere'; readonly classifier: LegacyCatalogClassifier }
  | { readonly state: 'not_in_this_pass'; readonly note: string };

/** One classification pass. */
export interface LegacyCatalogClassificationReport {
  readonly classifierVersion: number;
  readonly coverage: LegacyCatalogCoverage;
  readonly scannedListings: number;
  readonly bySubject: Readonly<Record<LegacyCatalogSubjectKind, LegacyCatalogSubjectResult>>;
  readonly retainedClaims: LegacyRetainedClaimSummary;
  /** Keyset cursor; `null` when the pass reached the end. */
  readonly resumeAfterListingId: string | null;
}

/** What one reconciliation probe compared, and what it found. */
export interface LegacyCatalogReconciliationProbe {
  readonly probe: string;
  /** How many subjects the probe examined. Zero is a vacuous probe, never a pass. */
  readonly examined: number;
  readonly agreed: number;
  readonly diverged: number;
  /** A bounded sample of divergences, for an operator to open by hand. */
  readonly sample: readonly string[];
}

/** One reconciliation pass: the legacy read against the new one. */
export interface LegacyCatalogReconciliationReport {
  readonly classifierVersion: number;
  readonly probes: readonly LegacyCatalogReconciliationProbe[];
  readonly resumeAfterListingId: string | null;
}

/** What one apply pass re-derived. */
export interface LegacyCatalogRepairReport {
  readonly mode: 'dry_run' | 'apply';
  readonly classifierVersion: number;
  readonly scannedListings: number;
  /** Rows whose stored path already matched the derivation. */
  readonly pathsAgreed: number;
  /** Rows whose path this pass re-derived. */
  readonly pathsRewritten: number;
  /** Rows carrying a path with no category, cleared. */
  readonly pathsCleared: number;
  readonly resumeAfterListingId: string | null;
}
