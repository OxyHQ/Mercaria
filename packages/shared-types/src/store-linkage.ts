/**
 * Merchant → native `Store` linkage (#84, ADR 0002 D4/D9).
 *
 * A verified merchant claim (#83) says WHO operates a canonical merchant. This
 * vocabulary says what happens next: the merchant gets a native `stores` row to
 * be operated THROUGH — either a new one or one the claimant already runs — and
 * the two are joined by exactly one active `native_store_links` row (#54).
 *
 * ## Identity does not move, in either direction
 *
 * The merchant and its storefronts stay the canonical identity; the store stays
 * the operational account. Nothing here replaces a merchant id with a store id,
 * migrates a handle, moves a follow target or reassigns a placed order. That is
 * why this file's vocabulary is about a REQUEST and its outcome, and never about
 * an entity: linkage produces one join row and a small, named set of side
 * effects, and everything it must not touch is absent because there is no value
 * that could express it.
 *
 * ## No name-only linkage, expressed FOUR independent ways
 *
 * Issue #84 forbids linking a merchant to a store because their names look
 * alike. This file carries the first of the four places that makes it
 * structural rather than a rule somebody remembers:
 *
 *  1. **The vocabulary** — {@link STORE_LINKAGE_CANDIDATE_SOURCES} has no
 *     `name_match` member, and neither does `NATIVE_STORE_LINK_METHODS` (#54's
 *     own tuple, for the same reason). There is no value to store.
 *  2. **The schema** (`db/schema/storeLinkage.ts`) — no name, similarity, score
 *     or confidence column exists anywhere in the four tables, so a matcher
 *     could not record a similarity even if one were computed.
 *  3. **The API** (`middleware/store-linkage-schemas.ts`) — every body is
 *     `.strict()` and carries ids and reasons only; there is no field a name
 *     could ride in on.
 *  4. **Candidate discovery** (`services/store-linkage/linkage-candidates.ts`)
 *     — a pure function over ids and PROVEN facts that never reads a display
 *     name, pinned by a static scan.
 */

/**
 * What a linkage request is asking for.
 *
 * Four modes, deliberately not two: creating a store and linking an existing
 * one differ in what they may touch, and revoking or correcting a link is a
 * different act from making one — with a different actor, a different audit
 * question, and a mandatory impact preview. Collapsing them would make "who may
 * do this" a property of which fields happen to be filled in.
 *
 *  - `create_store` — the verified merchant has no native store; make one and
 *    put the claimant in it as owner.
 *  - `link_existing` — the claimant already operates a native store that IS
 *    this merchant; join the two.
 *  - `correct_link` — an existing link names the wrong merchant; revoke it and
 *    open the right one, as ONE resumable job (issue revocation rule 2).
 *  - `unlink` — remove the management linkage without deleting the native store
 *    or the public merchant (issue revocation rule 1).
 */
export const STORE_LINKAGE_MODES = [
  'create_store',
  'link_existing',
  'correct_link',
  'unlink',
] as const;
export type StoreLinkageMode = (typeof STORE_LINKAGE_MODES)[number];

/**
 * The lifecycle of one request.
 *
 * `blocked` is a real state and not an error, because issue revocation rule 6
 * requires a conflicting live link to BLOCK new activation until resolved — an
 * outcome somebody has to see and act on, not an exception a client retries.
 * `applying` exists because the application is resumable: a task that dies
 * mid-run leaves the row here with its furthest step recorded, and the next
 * attempt continues from it rather than starting over.
 */
export const STORE_LINKAGE_STATES = [
  'draft',
  'awaiting_review',
  'applying',
  'applied',
  'blocked',
  'rejected',
  'abandoned',
] as const;
export type StoreLinkageState = (typeof STORE_LINKAGE_STATES)[number];

/**
 * The ORDERED steps of applying a request — the resumption cursor.
 *
 * Every step is idempotent on its own, so re-running from any point converges;
 * the recorded step is what stops the work being repeated rather than what makes
 * repeating it safe. The order is the tuple's order and the index is the
 * comparison, so adding a step in the middle is a visible edit here rather than
 * a silent reordering in a switch somewhere.
 */
export const STORE_LINKAGE_STEPS = [
  'opened',
  'store_ready',
  'link_written',
  'profile_applied',
  'catalog_matching_requested',
  'offers_reconciled',
  'completed',
] as const;
export type StoreLinkageStep = (typeof STORE_LINKAGE_STEPS)[number];

/** How far along the ordered step tuple a step sits. Total, so it can be compared. */
export function storeLinkageStepIndex(step: StoreLinkageStep): number {
  return STORE_LINKAGE_STEPS.indexOf(step);
}

/**
 * Why a request cannot proceed. A CODE, so a refusal can be counted and
 * alerted on and so the message shown to a claimant never has to name another
 * party's store or merchant.
 */
export const STORE_LINKAGE_BLOCK_REASONS = [
  /** Case 4: the target store already resolves to a DIFFERENT canonical merchant. */
  'store_linked_to_other_merchant',
  /** The merchant already has an active link to a different native store. */
  'merchant_linked_to_other_store',
  /** The claim is not `verified`, so nobody has proven they operate this merchant. */
  'claim_not_verified',
  /** The claim is verified but its scope never covered this merchant. */
  'claim_scope_missing',
  /** Case 3: several native stores are candidates and a person must choose. */
  'multiple_candidates',
  /** The claimant does not hold `store:manage` on the store they named. */
  'store_permission_missing',
  /** A correction or unlink was asked for and there is no active link to move. */
  'no_active_link',
  /** The merchant is merged or suppressed; link the winner, or nothing. */
  'merchant_not_active',
] as const;
export type StoreLinkageBlockReason = (typeof STORE_LINKAGE_BLOCK_REASONS)[number];

/**
 * WHY a native store is a candidate for this merchant — the evidence, from a
 * closed set with **no name-match member**.
 *
 * Each value names a fact somebody proved or asserted, never a resemblance:
 *
 *  - `claimant_named` — the claimant explicitly named this store id (and must
 *    still hold `store:manage` on it). An intent, not a proof.
 *  - `claim_native_store_intent` — #83's `merchant_claims.native_store_id`, the
 *    store the claimant named when they OPENED the claim, carried forward.
 *  - `claimant_store_membership` — the claimant is a member of this store with
 *    `store:manage`. Membership is a fact Mercaria owns.
 *  - `claim_verified_domain` — the store's connected channel is on a domain the
 *    claim actually PROVED (#83's domain-control mechanism).
 *  - `claim_platform_connection` — the store owns the connector connection whose
 *    OAuth round trip the claim consumed as proof.
 *  - `operator` — a catalogue operator decided it, on the record.
 *
 * There is deliberately no `name_match`, no `similar_handle` and no `heuristic`.
 */
export const STORE_LINKAGE_CANDIDATE_SOURCES = [
  'claimant_named',
  'claim_native_store_intent',
  'claimant_store_membership',
  'claim_verified_domain',
  'claim_platform_connection',
  'operator',
] as const;
export type StoreLinkageCandidateSource = (typeof STORE_LINKAGE_CANDIDATE_SOURCES)[number];

/**
 * Which candidate sources are strong enough to link WITHOUT an operator looking.
 *
 * The #55 `SUFFICIENT_EVIDENCE_KINDS` device: a table rather than a condition, so
 * "may this evidence link on its own" is answered in one place a reviewer can
 * read. `claimant_named` and `claim_native_store_intent` are intents and are NOT
 * here — an intent plus `store:manage` plus a verified claim IS enough, and that
 * conjunction is exactly what {@link STORE_LINKAGE_AUTO_LINK_SOURCES} leaves to
 * the service to establish rather than pretending the intent alone carries it.
 */
export const STORE_LINKAGE_AUTO_LINK_SOURCES: readonly StoreLinkageCandidateSource[] = [
  'claimant_store_membership',
  'claim_verified_domain',
  'claim_platform_connection',
  'operator',
];

/** What happened to one candidate. Three states of one row, the `merchant_claim_scopes` shape. */
export const STORE_LINKAGE_CANDIDATE_DISPOSITIONS = ['proposed', 'selected', 'rejected'] as const;
export type StoreLinkageCandidateDisposition =
  (typeof STORE_LINKAGE_CANDIDATE_DISPOSITIONS)[number];

/**
 * The store profile fields a linkage may adopt from the canonical merchant.
 *
 * EXACTLY the two safe public fields the canonical merchant carries, and the
 * set is closed at the type, at the CHECK and at the `.strict()` request schema.
 *
 * What is NOT a member, and why each absence is deliberate:
 *
 *  - `handle` — issue existing-store rule 7: `/m/<handle>` and the store's
 *    follow target must stay stable. A handle is also the store's public route
 *    and its follow URI is keyed on the immutable store id precisely so a rename
 *    cannot empty a shop's followers; making it adoptable would reintroduce that
 *    hazard through a different door.
 *  - `defaultCurrency`, `status`, `brandColor`, policies, notification and tax
 *    settings — issue existing-store rule 4: members, permissions, policies,
 *    collections, inventory, customers, orders and reports are unchanged. None
 *    of them is a public identity fact a canonical merchant could be authoritative
 *    about.
 *  - the merchant's own `slug`, `claimState`, ratings and rollups — those are
 *    the canonical row's, and copying one onto a store would create the second
 *    representation ADR 0002 exists to prevent.
 */
export const STORE_LINKAGE_PROFILE_FIELDS = ['name', 'description'] as const;
export type StoreLinkageProfileField = (typeof STORE_LINKAGE_PROFILE_FIELDS)[number];

/**
 * Where an adopted value came from — the PROVENANCE half of issue existing-store
 * rule 3 ("let the owner select safe public fields while retaining provenance").
 *
 * One member today, and that is the point: only the canonical merchant row is a
 * source a store owner may adopt from. An UNVERIFIED external profile — a
 * crawled page title, a marketplace seller blurb — has no value here, so "do not
 * copy unverified external profile fields into merchant-managed fields silently"
 * (issue store-creation rule 4) is unrepresentable rather than merely refused.
 */
export const STORE_LINKAGE_PROFILE_SOURCES = ['canonical_merchant'] as const;
export type StoreLinkageProfileSource = (typeof STORE_LINKAGE_PROFILE_SOURCES)[number];

/**
 * The DETERMINISTIC rule that decided which of two representations of one
 * merchant's offer is the primary one (issue catalog rule 4).
 *
 * Ordered by precedence and applied in exactly this order, so two runs over the
 * same rows always name the same primary. The last two exist to make the order
 * TOTAL: `most_recently_seen` breaks a tie between two comparable offers, and
 * `lowest_offer_id` breaks a tie between two seen at the same instant. A rule
 * set that could end in a coin flip is not deterministic, and "the newest one"
 * alone can end in one.
 */
export const STORE_LINKAGE_OVERLAP_RULES = [
  'native_supersedes_external',
  'operated_channel_supersedes_marketplace',
  'most_recently_seen',
  'lowest_offer_id',
] as const;
export type StoreLinkageOverlapRule = (typeof STORE_LINKAGE_OVERLAP_RULES)[number];

/**
 * Why #58's matcher did not attach a listing. Absence is a first-class outcome
 * here: an unmatched listing materializes no native offer (#57 materializes only
 * variants with an active canonical attachment), which is the fail-closed
 * behaviour — never a guess from a title.
 */
export const STORE_LINKAGE_MATCH_STATES = [
  /** The matcher ran and every listing it was given got an answer. */
  'matched',
  /** The matcher ran and could not decide for some listings. They stay unattached. */
  'partial',
  /** No matcher is registered in this deployment (#58 has not landed). */
  'matcher_unavailable',
  /** The store had no listings to match. */
  'nothing_to_match',
] as const;
export type StoreLinkageMatchState = (typeof STORE_LINKAGE_MATCH_STATES)[number];

// ── DTOs ────────────────────────────────────────────────────────────────────

/**
 * One linkage request, as a claimant or an operator reads it.
 *
 * Every field is named explicitly (the payments status-projection rule). The
 * request never carries another party's identifiers: a `blocked` request says
 * WHY with a code and does not name the merchant or store that holds the
 * conflicting link, because a claimant learning who else claimed their name is
 * an information leak dressed as a helpful error.
 */
export interface StoreLinkageRequest {
  id: string;
  merchantId: string;
  claimId: string;
  mode: StoreLinkageMode;
  state: StoreLinkageState;
  step: StoreLinkageStep;
  /** The store the request NAMED. NULL for `create_store`; immutable once written. */
  requestedStoreId: string | null;
  /** The store the request ended up joining. NULL until `applied`. */
  resolvedStoreId: string | null;
  /** The `native_store_links` row this request produced, once it has one. */
  nativeStoreLinkId: string | null;
  blockReason: StoreLinkageBlockReason | null;
  /** Why the request was opened — mandatory, and part of the audit trail. */
  reason: string;
  /** What the matcher seam reported on the last run. NULL before it ran. */
  matchState: StoreLinkageMatchState | null;
  impact: StoreLinkageImpact;
  attempts: number;
  lastError: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The IMPACT PREVIEW (issue revocation rule 5: operator actions require a reason
 * and an impact preview).
 *
 * COUNTS in real integer columns, never a jsonb summary — the
 * `provider_accounts` requirements decision, for the same reason: an integer
 * column cannot hold a customer's name, a listing title or an order number, so
 * an impact preview can never become a way to read a store's book through the
 * operator surface.
 */
export interface StoreLinkageImpact {
  /** Active listings the store currently publishes. */
  activeListings: number;
  /** Native offers currently materialized from those listings. */
  nativeOffers: number;
  /** Active EXTERNAL offers already attributed to this merchant. Never deleted. */
  externalOffers: number;
  /** Canonical channels the merchant operates. Unchanged by linkage. */
  storefronts: number;
  /** Orders already placed on this store. They never migrate (revocation rule 3). */
  placedOrders: number;
  /** Members of the store. Unchanged by linkage (existing-store rule 4). */
  storeMembers: number;
}

/** One native store proposed for a merchant, with the evidence that proposed it. */
export interface StoreLinkageCandidate {
  id: string;
  requestId: string;
  storeId: string;
  source: StoreLinkageCandidateSource;
  /**
   * The proven fact behind the source — a verified hostname, a connection id, a
   * store role. NEVER a name or a similarity score; there is no source value
   * that would put one here.
   */
  evidenceRef: string | null;
  disposition: StoreLinkageCandidateDisposition;
  /** Whether this evidence can carry a link on its own, or needs a person. */
  autoLinkable: boolean;
  createdAt: string;
}

/** One adoptable field, with both sides shown and neither applied. */
export interface StoreLinkageDiffField {
  field: StoreLinkageProfileField;
  /** What the native store says today. */
  storeValue: string | null;
  /** What the canonical merchant says. */
  merchantValue: string | null;
  differs: boolean;
  /** False when the canonical side has nothing to adopt — an empty value is not a fact. */
  adoptable: boolean;
}

/** A verified source fact, shown BESIDE the diff and never adoptable into a field. */
export interface StoreLinkageSourceFact {
  kind: 'verified_domain' | 'storefront';
  ref: string;
  detail: string | null;
}

/**
 * The DIFF between native profile, canonical merchant and source facts (issue
 * existing-store rule 2).
 *
 * `unchanged` is part of the contract rather than documentation: the surface
 * states, in the same payload, exactly what linkage will not touch. A merchant
 * deciding whether to link should not have to take that on trust from a
 * changelog.
 */
export interface StoreLinkageDiff {
  storeId: string;
  merchantId: string;
  fields: StoreLinkageDiffField[];
  sourceFacts: StoreLinkageSourceFact[];
  /** Named aspects linkage leaves alone, verbatim, so the promise is inspectable. */
  unchanged: readonly string[];
  impact: StoreLinkageImpact;
}

/** One adopted field, with the value it replaced kept as provenance. */
export interface StoreLinkageProfileAdoption {
  id: string;
  requestId: string;
  storeId: string;
  field: StoreLinkageProfileField;
  source: StoreLinkageProfileSource;
  previousValue: string | null;
  adoptedValue: string;
  at: string;
}

/**
 * One detected duplicate representation of a merchant's offer, and the rule
 * that named the primary (issue catalog rule 4).
 *
 * Both offers survive — recording an overlap deletes nothing, retires nothing
 * and changes no price. Acceptance 3 requires exactly that: matching external
 * and native offers remain DISTINCT and share the canonical product.
 */
export interface StoreLinkageOfferOverlap {
  id: string;
  requestId: string;
  merchantId: string;
  canonicalVariantId: string;
  primaryOfferId: string;
  duplicateOfferId: string;
  rule: StoreLinkageOverlapRule;
  detectedAt: string;
}

/** What one application run produced, for the claimant response and the operator trace. */
export interface StoreLinkageOutcome {
  request: StoreLinkageRequest;
  /** The store row's id and handle, so a caller need not re-fetch to route. */
  storeId: string | null;
  storeHandle: string | null;
  adoptions: StoreLinkageProfileAdoption[];
  overlaps: StoreLinkageOfferOverlap[];
}
