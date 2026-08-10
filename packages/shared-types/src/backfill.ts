/**
 * The flag-gated native-catalogue backfill (#60, ADR 0002 D23/D24).
 *
 * The vocabulary of a STAGED, REVERSIBLE, RESUMABLE migration of the existing
 * listing-first catalogue into the canonical commerce graph. Every tuple here is
 * closed and rendered into a Postgres CHECK by `db/schema/backfill.ts`, so a
 * value this file does not name cannot be stored.
 *
 * ## The three things this vocabulary refuses to express
 *
 * 1. **There is no "delete" outcome and no "rewrite" outcome.** ADR 0002 D23
 *    step 6 and the issue's whole "Immutable history" section say the backfill
 *    adds and never edits what already exists; `CatalogBackfillOutcome` has no
 *    member that could record one, so an implementation that did would have
 *    nothing honest to write down.
 * 2. **There is no outcome that means "matched, probably".** A record either
 *    attached to an exact canonical variant (`matched`), minted one
 *    (`created`), was routed to review (`review_required`) or was left alone
 *    (`unmatched`). Ambiguity is a first-class outcome rather than a weak
 *    match, which is #58's `manual_review` rule carried into the migration that
 *    drives it.
 * 3. **A read mode has no "partial" member.** `off | shadow | on` is ADR 0002
 *    D24's vocabulary exactly: `shadow` computes both answers and serves the
 *    legacy one, which is how measured parity is produced instead of asserted.
 */

/**
 * The ordered stages of the migration, each independently runnable, resumable
 * and re-runnable (ADR 0002 D23 phases 1–3 plus the issue's steps 3–9).
 *
 * The ORDER is the dependency order and is not arbitrary: `provisional_products`
 * reads what `variant_matching` decided, `native_offers` materialises what
 * `provisional_products` attached, and both consistency stages measure what the
 * five before them produced. Running one out of order is not forbidden — it is
 * simply a smaller run, because every stage converges on its own input.
 */
export type CatalogBackfillStage =
  /** Every active native `stores` row mints a merchant plus a verified link. */
  | 'store_merchants'
  /** `listings.vendor` strings become brand CANDIDATES for review. Never brands. */
  | 'vendor_brand_candidates'
  /** Every eligible native variant is enqueued into #58's matching queue. */
  | 'variant_matching'
  /** Unmatched STORE listings mint draft canonical products, variants and links. */
  | 'provisional_products'
  /** Attached listings are enqueued for #57's native-offer convergence. */
  | 'native_offers'
  /** Derived counts on canonical products and families are recomputed. */
  | 'rebuild_projections'
  /**
   * Search reindex requests are enqueued for the canonical products the
   * migration touched. Its OWN stage rather than a second effect of
   * `rebuild_projections`, because a report row is keyed on (stage, subject) —
   * folding the two would make one canonical product owe two verdicts under one
   * key, and one of them would silently overwrite the other.
   */
  | 'search_reindex'
  /** Both directions of the active listing ↔ variant ↔ native offer agreement. */
  | 'consistency';

export const CATALOG_BACKFILL_STAGES: readonly CatalogBackfillStage[] = [
  'store_merchants',
  'vendor_brand_candidates',
  'variant_matching',
  'provisional_products',
  'native_offers',
  'rebuild_projections',
  'search_reindex',
  'consistency',
];

/**
 * Whether a run may write to the canonical graph.
 *
 * `dry_run` performs every read, every decision and every per-record report a
 * real run does, and issues no write outside its own report tables — which is
 * what makes the two comparable rather than merely sequential (issue job
 * behaviour 3).
 */
export type CatalogBackfillMode = 'dry_run' | 'apply';

export const CATALOG_BACKFILL_MODES: readonly CatalogBackfillMode[] = ['dry_run', 'apply'];

/**
 * The lifecycle of one run.
 *
 * `paused` is a run whose pass is incomplete and whose lease is free — the
 * ordinary state between two bounded pages, and deliberately distinguishable
 * from `failed` (a page raised) and from `completed` (the pass reached the end).
 */
export type CatalogBackfillRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export const CATALOG_BACKFILL_RUN_STATUSES: readonly CatalogBackfillRunStatus[] = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
];

/**
 * Which slice of the catalogue a run addresses — the issue's "source or category
 * cohorts" flag, at the grain a rollout actually uses.
 *
 * `all` is the only kind that carries no value; every other kind names exactly
 * one, which is a CHECK rather than a convention.
 */
export type CatalogBackfillCohortKind =
  | 'all'
  /** One native store id. */
  | 'store'
  /** One category id. */
  | 'category'
  /** `user` or `store` — the P2P/store split, which is a policy boundary here. */
  | 'owner_type'
  /** One connector provider id — the listings a given platform sourced. */
  | 'connector_provider';

export const CATALOG_BACKFILL_COHORT_KINDS: readonly CatalogBackfillCohortKind[] = [
  'all',
  'store',
  'category',
  'owner_type',
  'connector_provider',
];

/** What kind of thing one report row is about. */
export type CatalogBackfillSubjectKind =
  | 'store'
  | 'listing'
  | 'product_variant'
  | 'vendor_value'
  | 'canonical_product'
  | 'native_offer';

export const CATALOG_BACKFILL_SUBJECT_KINDS: readonly CatalogBackfillSubjectKind[] = [
  'store',
  'listing',
  'product_variant',
  'vendor_value',
  'canonical_product',
  'native_offer',
];

/**
 * What the backfill did with one record.
 *
 * `unchanged` is the converged re-run — the outcome a second pass over an
 * untouched catalogue produces for every record, and the one that makes
 * idempotency observable rather than merely claimed.
 */
export type CatalogBackfillOutcome =
  /** Already in the state the backfill wants. A genuine no-op. */
  | 'unchanged'
  /** Attached to an existing canonical entity. */
  | 'matched'
  /** Minted a canonical entity (a merchant, a draft product, a variant). */
  | 'created'
  /** Handed to another domain's durable queue (#58's matcher, #57's converger). */
  | 'enqueued'
  /** Ambiguous — recorded as evidence and routed to #59, never guessed. */
  | 'review_required'
  /** Deliberately left listing-first. The normal state for a P2P listing. */
  | 'unmatched'
  /** Outside the cohort, or ineligible for this stage. */
  | 'skipped'
  /** The record raised. Isolated here so the page continues (job behaviour 4). */
  | 'failed';

export const CATALOG_BACKFILL_OUTCOMES: readonly CatalogBackfillOutcome[] = [
  'unchanged',
  'matched',
  'created',
  'enqueued',
  'review_required',
  'unmatched',
  'skipped',
  'failed',
];

/**
 * Why a record got its outcome — a closed vocabulary, never free text.
 *
 * The `payment_discrepancies` and `match_decisions` reasoning: an operator
 * filtering "which listings were left unattached because they are P2P" needs an
 * indexable predicate, and a sentence is not one. Free-form context lives in
 * `detail`, which nothing queries.
 */
export type CatalogBackfillReasonCode =
  // ── store_merchants ────────────────────────────────────────────────────────
  | 'merchant_minted'
  | 'store_already_linked'
  | 'store_not_active'
  | 'store_owner_unresolved'
  | 'store_link_conflict'
  // ── vendor_brand_candidates ────────────────────────────────────────────────
  | 'vendor_candidate_recorded'
  | 'vendor_candidate_unchanged'
  | 'vendor_candidate_ambiguous'
  // ── variant_matching ───────────────────────────────────────────────────────
  | 'match_enqueued'
  // ── provisional_products ───────────────────────────────────────────────────
  | 'provisional_product_minted'
  | 'variant_attached'
  | 'attachment_exists'
  | 'blocked_by_decision'
  | 'awaiting_match_decision'
  | 'p2p_left_unattached'
  | 'identifier_disputed'
  // ── native_offers ──────────────────────────────────────────────────────────
  | 'offer_convergence_enqueued'
  | 'no_active_attachment'
  // ── rebuild_projections ────────────────────────────────────────────────────
  | 'projection_refreshed'
  | 'projection_current'
  | 'reindex_requested'
  | 'reindex_disabled'
  // ── consistency ────────────────────────────────────────────────────────────
  | 'consistent'
  | 'offer_missing_for_attachment'
  | 'offer_listing_not_active'
  | 'offer_link_missing'
  | 'offer_variant_mismatch'
  // ── cross-stage ────────────────────────────────────────────────────────────
  | 'out_of_cohort'
  | 'write_publication_disabled'
  | 'record_error';

export const CATALOG_BACKFILL_REASON_CODES: readonly CatalogBackfillReasonCode[] = [
  'merchant_minted',
  'store_already_linked',
  'store_not_active',
  'store_owner_unresolved',
  'store_link_conflict',
  'vendor_candidate_recorded',
  'vendor_candidate_unchanged',
  'vendor_candidate_ambiguous',
  'match_enqueued',
  'provisional_product_minted',
  'variant_attached',
  'attachment_exists',
  'blocked_by_decision',
  'awaiting_match_decision',
  'p2p_left_unattached',
  'identifier_disputed',
  'offer_convergence_enqueued',
  'no_active_attachment',
  'projection_refreshed',
  'projection_current',
  'reindex_requested',
  'reindex_disabled',
  'consistent',
  'offer_missing_for_attachment',
  'offer_listing_not_active',
  'offer_link_missing',
  'offer_variant_mismatch',
  'out_of_cohort',
  'write_publication_disabled',
  'record_error',
];

/**
 * Which outcome each reason code is allowed to carry.
 *
 * ONE map, rendered into `catalog_backfill_records_reason_outcome_check` by
 * `db/schema/backfill.ts`, so a reason and an outcome can never disagree — the
 * `REVIEW_SCOPE_TARGET_TYPE` device (#76). Without it `record_error` could be
 * stored beside `unchanged` and a failed page would report as a clean one, which
 * is the exact lie the counter CHECK on the run row exists to prevent one level
 * up.
 *
 * Almost every entry is a singleton. The one thing to notice is that the four
 * consistency reasons map to `review_required` and not to `failed`: the sweep
 * examined the subject perfectly well: what it FOUND needs a person, and the
 * remedy for three of the four may legitimately be "nothing, a jury restricted
 * that listing".
 */
export const CATALOG_BACKFILL_REASON_OUTCOMES: Readonly<
  Record<CatalogBackfillReasonCode, readonly CatalogBackfillOutcome[]>
> = {
  merchant_minted: ['created'],
  store_already_linked: ['unchanged'],
  store_not_active: ['skipped'],
  store_owner_unresolved: ['skipped'],
  store_link_conflict: ['failed'],
  vendor_candidate_recorded: ['created'],
  vendor_candidate_unchanged: ['unchanged'],
  vendor_candidate_ambiguous: ['review_required'],
  match_enqueued: ['enqueued'],
  provisional_product_minted: ['created'],
  variant_attached: ['matched'],
  attachment_exists: ['unchanged'],
  blocked_by_decision: ['review_required'],
  awaiting_match_decision: ['skipped'],
  p2p_left_unattached: ['unmatched'],
  identifier_disputed: ['review_required'],
  offer_convergence_enqueued: ['enqueued'],
  no_active_attachment: ['unmatched'],
  projection_refreshed: ['created'],
  projection_current: ['unchanged'],
  reindex_requested: ['enqueued'],
  reindex_disabled: ['skipped'],
  consistent: ['unchanged'],
  offer_missing_for_attachment: ['review_required'],
  offer_listing_not_active: ['review_required'],
  offer_link_missing: ['review_required'],
  offer_variant_mismatch: ['review_required'],
  out_of_cohort: ['skipped'],
  write_publication_disabled: ['skipped'],
  record_error: ['failed'],
};

/**
 * What a two-way consistency pass can find (issue job behaviour 6, acceptance 6).
 *
 * FOUR kinds and no fifth, because the fifth candidate — "an active native offer
 * whose native variant no longer exists" — is unrepresentable:
 * `offers.product_variant_id` CASCADEs from `product_variants` (ADR 0002 D20),
 * so the offer leaves with the variant. Naming a kind for it would imply the
 * sweep can detect something the schema already prevents.
 */
export type CatalogConsistencyFindingKind =
  /** Forward: an attached, active native variant carrying no active native offer. */
  | 'attached_variant_without_offer'
  /** Reverse: an active native offer whose listing is not `active` any more. */
  | 'offer_without_active_listing'
  /** Reverse: an active native offer whose variant has no active attachment. */
  | 'offer_without_active_link'
  /** Reverse: the offer and the active attachment name DIFFERENT canonical variants. */
  | 'offer_canonical_variant_mismatch';

export const CATALOG_CONSISTENCY_FINDING_KINDS: readonly CatalogConsistencyFindingKind[] = [
  'attached_variant_without_offer',
  'offer_without_active_listing',
  'offer_without_active_link',
  'offer_canonical_variant_mismatch',
];

/**
 * The canonical READ vocabulary (ADR 0002 D24).
 *
 * `shadow` is the phase that produces measured parity: a surface computes the
 * canonical answer, serves the legacy one, and records that the two were both
 * available. It is deliberately NOT a third public behaviour — a shopper sees
 * exactly what `off` shows them.
 */
export type CanonicalReadMode = 'off' | 'shadow' | 'on';

export const CANONICAL_READ_MODES: readonly CanonicalReadMode[] = ['off', 'shadow', 'on'];

/** One run, as the operator surface projects it. */
export interface CatalogBackfillRun {
  readonly id: string;
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly mappingVersion: number;
  readonly cohortKind: CatalogBackfillCohortKind;
  readonly cohortValue: string | null;
  readonly status: CatalogBackfillRunStatus;
  /** Where the NEXT page starts. `null` at the beginning and at the end of a pass. */
  readonly cursor: string | null;
  readonly scanned: number;
  readonly matched: number;
  readonly created: number;
  readonly enqueued: number;
  readonly reviewRequired: number;
  readonly unmatched: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unchanged: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastError: string | null;
  readonly requestedByOxyUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One record's outcome — the per-record isolation the issue asks for. */
export interface CatalogBackfillRecord {
  readonly id: string;
  readonly runId: string;
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly mappingVersion: number;
  readonly subjectKind: CatalogBackfillSubjectKind;
  readonly subjectKey: string;
  readonly outcome: CatalogBackfillOutcome;
  readonly reasonCode: CatalogBackfillReasonCode;
  readonly detail: string | null;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One open or resolved disagreement between the native catalogue and its offers. */
export interface CatalogConsistencyFinding {
  readonly id: string;
  readonly kind: CatalogConsistencyFindingKind;
  readonly subjectKind: CatalogBackfillSubjectKind;
  readonly subjectKey: string;
  readonly detail: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt: string | null;
}

/**
 * What one bounded page did (issue job behaviour 2).
 *
 * `scanned` is the VACUITY FLOOR: a report claiming zero failures over zero
 * scanned records is a broken traversal, not a clean catalogue, and every reader
 * of this shape — the operator surface, the dry-run comparison, the tests —
 * checks it before believing the other numbers.
 */
export interface CatalogBackfillPageResult {
  readonly runId: string;
  readonly stage: CatalogBackfillStage;
  readonly mode: CatalogBackfillMode;
  readonly scanned: number;
  readonly matched: number;
  readonly created: number;
  readonly enqueued: number;
  readonly reviewRequired: number;
  readonly unmatched: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unchanged: number;
  /** `null` when the pass is complete. */
  readonly nextCursor: string | null;
}

/**
 * The rollout metrics (issue job behaviour 5): throughput, ambiguity, unmatched
 * rate and orphaned offers.
 *
 * Every rate is `null` rather than `0` when its denominator is zero — the
 * `match_benchmark_categories` rule: "nothing was scanned" is not "the unmatched
 * rate is 0%", and a dashboard that cannot tell them apart reports a healthy
 * migration for a job that never ran.
 */
export interface CatalogBackfillMetrics {
  readonly mappingVersion: number;
  /** Records scanned across every run of the current mapping version. */
  readonly scanned: number;
  /** Records per second, measured over runs that actually started. */
  readonly throughputPerSecond: number | null;
  /** `review_required / scanned`. */
  readonly ambiguityRate: number | null;
  /** `unmatched / scanned`. */
  readonly unmatchedRate: number | null;
  /** `failed / scanned`. */
  readonly failureRate: number | null;
  /** Open findings, by kind — "orphaned offers" is the reverse-direction sum. */
  readonly openFindings: Readonly<Record<CatalogConsistencyFindingKind, number>>;
  /** Open findings whose kind means an offer has no valid active native source. */
  readonly orphanedNativeOffers: number;
  readonly runs: readonly CatalogBackfillRun[];
}

/** What every canonical rollout lever is currently set to (issue flag list). */
export interface CanonicalRolloutFlags {
  /** Does the backfill dispatcher LOOP run at all. */
  readonly graphEnabled: boolean;
  /** May an `apply` run mutate the canonical graph. */
  readonly writePublicationEnabled: boolean;
  readonly reads: CanonicalReadMode;
  readonly offerComparison: CanonicalReadMode;
  /**
   * `CANONICAL_SEARCH` — #70's canonical multi-entity discovery surface.
   *
   * A SEVENTH lever rather than a widening of `reads`, for the reason the other
   * six are separate: withdrawing search during an incident must not take the
   * product identity pages down with it. It is the ONE canonical read lever
   * whose default is `off`, because it gates a surface that did not previously
   * exist — where `reads` and `offerComparison` gate routes #56/#57 shipped
   * without a flag, and defaulting THOSE off would be an outage rather than a
   * rollout (ADR 0002 D24).
   */
  readonly search: CanonicalReadMode;
  readonly publicRoutesEnabled: boolean;
  readonly searchIndexingEnabled: boolean;
  /** Empty means every cohort. Entries are `<kind>:<value>`. */
  readonly readCohorts: readonly string[];
}
