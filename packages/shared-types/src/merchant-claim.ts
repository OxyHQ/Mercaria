/**
 * Merchant claiming — value sets and DTOs (issue #83, part of epic #40).
 *
 * A **merchant claim** is one attempt by one Oxy account to become the verified
 * operator of one canonical merchant (`merchants`, #54), backed by evidence
 * strong enough to name. ADR 0002 D9 already made `merchants.claim_state` the
 * ONE stored verdict a gate reads; this domain is the flow that moves it, and
 * it deliberately adds no second verdict beside it.
 *
 * ## What a claim is NOT
 *
 * Claiming a merchant grants no `Official store` and no `Authorized reseller`
 * status. Those are evidence-gated `commerce_relationships` rows owned by #55
 * (ADR 0002 D10/D17) and nothing here writes, reads or anticipates them —
 * claiming "Apple Store" therefore creates no Apple relationship of any kind
 * (issue acceptance 6). Nor does a claim grant anything OPERATIONAL: store
 * members, permissions, inventory and payouts stay on the native `stores` row,
 * which meets the graph only through `native_store_links` (ADR 0002 D4).
 *
 * ## Scope is a set of proven facts, never an inference
 *
 * A proof proves exactly its own subject: control of `example.com` proves
 * `example.com` and nothing that merely resembles it; a Shopify account proof
 * proves THAT shop and not every brand it sells. Requested scope and verified
 * scope are therefore two different sets on the same claim, and one claim may
 * cover a single storefront while the merchant's other storefronts stay
 * unclaimed.
 */

/**
 * `MerchantClaim.state` — the full lifecycle, and the only place claim status
 * is represented.
 *
 * `draft` a claim opened but not yet evidenced · `challenge_pending` a
 * challenge is outstanding · `review_pending` evidence is in and a human must
 * decide (every lower-assurance method lands here, never in `verified`) ·
 * `verified` the claimant IS the merchant's operator · `rejected` a reviewer
 * refused it · `expired` the deadline passed with nothing proven · `revoked` a
 * verification that was withdrawn (domain loss, platform disconnect, fraud) ·
 * `disputed` a conflict with the incumbent that a human must resolve.
 *
 * `rejected`, `expired` and `revoked` are terminal: a claimant who wants
 * another go opens a NEW claim, so the record of what was decided is never
 * edited into a different meaning.
 */
export const MERCHANT_CLAIM_STATES = [
  'draft',
  'challenge_pending',
  'review_pending',
  'verified',
  'rejected',
  'expired',
  'revoked',
  'disputed',
] as const;
export type MerchantClaimState = (typeof MERCHANT_CLAIM_STATES)[number];

/**
 * The states in which a claim is still LIVE — it is being worked on, or it is
 * the merchant's current verification. Anything outside this set is history.
 *
 * Exported as a tuple because it is also the predicate of the partial unique
 * index that stops one account opening many simultaneous claims on one
 * merchant; a second hand-written list in the schema could drift from it.
 */
export const MERCHANT_CLAIM_ACTIVE_STATES = [
  'draft',
  'challenge_pending',
  'review_pending',
  'disputed',
] as const;
export type MerchantClaimActiveState = (typeof MERCHANT_CLAIM_ACTIVE_STATES)[number];

/**
 * `MerchantClaim.method` — the pluggable verification contract's closed set.
 *
 * Which of these a deployment actually OFFERS is a separate question answered
 * by the method registry (`services/merchant-claims/claim-methods.ts`), not by
 * this tuple: a method whose prerequisites are unconfigured is unavailable
 * rather than absent, so the state machine, the review path and the audit
 * vocabulary exist for it before its transport does.
 *
 * `dns_txt` a TXT record under the merchant domain · `well_known_file` a file
 * at a fixed `/.well-known/` path · `meta_tag` a `<meta>` tag on the site root
 * · `platform_oauth` a signed account proof from an existing authorized
 * platform connection (Shopify and friends) · `channel_key` a WooCommerce
 * plugin / channel-key proof scoped to one site AND one connection ·
 * `role_email` a token mailed to an approved ROLE address, deliberately
 * lower-assurance · `business_document` operator review of documents.
 */
export const MERCHANT_CLAIM_METHODS = [
  'dns_txt',
  'well_known_file',
  'meta_tag',
  'platform_oauth',
  'channel_key',
  'role_email',
  'business_document',
] as const;
export type MerchantClaimMethod = (typeof MERCHANT_CLAIM_METHODS)[number];

/**
 * How much a method's proof is worth. DERIVED from the method by the registry
 * and never stored beside it — two representations of one fact can disagree,
 * and the disagreement that matters here is a `low` proof recorded as `high`.
 *
 * `high` cryptographic or platform-authenticated control of the exact subject ·
 * `standard` control of a site the merchant is already observed at · `low`
 * evidence that a human must weigh, which is why no `low` method may reach
 * `verified` without a reviewer.
 */
export const MERCHANT_CLAIM_ASSURANCES = ['high', 'standard', 'low'] as const;
export type MerchantClaimAssurance = (typeof MERCHANT_CLAIM_ASSURANCES)[number];

/**
 * What a scope row names. A `domain` scope is the proof subject itself; a
 * `storefront` scope is one channel the proof covers; the `merchant` scope is
 * the identity the claim is for and is always requested exactly once.
 */
export const MERCHANT_CLAIM_SCOPE_KINDS = ['merchant', 'storefront', 'domain'] as const;
export type MerchantClaimScopeKind = (typeof MERCHANT_CLAIM_SCOPE_KINDS)[number];

/**
 * `requested` the claimant asked for it · `verified` the evidence actually
 * proved it · `out_of_scope` the evidence did NOT reach it, recorded rather
 * than dropped so a claimant can see which storefront their proof missed.
 */
export const MERCHANT_CLAIM_SCOPE_STATES = ['requested', 'verified', 'out_of_scope'] as const;
export type MerchantClaimScopeState = (typeof MERCHANT_CLAIM_SCOPE_STATES)[number];

/** What one private evidence row holds. Never part of a claimant-facing DTO. */
export const MERCHANT_CLAIM_EVIDENCE_KINDS = [
  'challenge_proof',
  'business_document',
  'platform_account',
  'operator_note',
  'contest_statement',
] as const;
export type MerchantClaimEvidenceKind = (typeof MERCHANT_CLAIM_EVIDENCE_KINDS)[number];

/**
 * The append-only audit vocabulary. `evidence_accessed` is in it because issue
 * #83 requires every reviewer ACCESS to be audited, not only every decision —
 * reading a claimant's business documents is itself the event.
 */
export const MERCHANT_CLAIM_EVENT_ACTIONS = [
  'created',
  'challenge_issued',
  'challenge_attempted',
  'challenge_verified',
  'challenge_failed',
  'submitted_for_review',
  'evidence_added',
  'evidence_accessed',
  'verified',
  'rejected',
  'expired',
  'revoked',
  'disputed',
  'dispute_resolved',
] as const;
export type MerchantClaimEventAction = (typeof MERCHANT_CLAIM_EVENT_ACTIONS)[number];

/** Who did it. `system` is an automatic transition (expiry, an auto-verify). */
export const MERCHANT_CLAIM_ACTOR_KINDS = ['claimant', 'operator', 'system'] as const;
export type MerchantClaimActorKind = (typeof MERCHANT_CLAIM_ACTOR_KINDS)[number];

/**
 * Why a verification was withdrawn (issue scope rule 7). A closed set, because
 * "revoked" with a free-text reason alone cannot be counted, alerted on or
 * distinguished from an operator correcting their own mistake.
 */
export const MERCHANT_CLAIM_REVOKE_REASONS = [
  'domain_loss',
  'platform_disconnect',
  'fraud',
  'operator_correction',
  'claimant_request',
] as const;
export type MerchantClaimRevokeReason = (typeof MERCHANT_CLAIM_REVOKE_REASONS)[number];

/**
 * Why a challenge stopped being open. A challenge is single-use: it closes on
 * the first success and can never be reopened, which is what makes replaying a
 * consumed token impossible rather than merely unlikely.
 */
export const MERCHANT_CLAIM_CHALLENGE_CLOSE_REASONS = [
  'verified',
  'superseded',
  'expired',
  'abandoned',
] as const;
export type MerchantClaimChallengeCloseReason =
  (typeof MERCHANT_CLAIM_CHALLENGE_CLOSE_REASONS)[number];

/** What a challenge's proof subject IS — one of these per method. */
export const MERCHANT_CLAIM_CHALLENGE_SUBJECT_KINDS = ['domain', 'connection', 'email'] as const;
export type MerchantClaimChallengeSubjectKind =
  (typeof MERCHANT_CLAIM_CHALLENGE_SUBJECT_KINDS)[number];

/**
 * Why a merchant cannot be claimed right now. Returned by the eligibility read
 * so a storefront can explain the missing `Claim this merchant` button without
 * guessing, and deliberately says nothing about WHO holds an existing claim.
 *
 * "Somebody else has a claim in progress" is deliberately NOT in this list. A
 * squatter opening a claim first must not be able to lock the real operator
 * out, so several claims may be in flight and exactly one of them can verify —
 * that fact is {@link MerchantClaimEligibility.claimInProgress}, a signal a
 * client may render, never a refusal.
 */
export const MERCHANT_CLAIM_INELIGIBILITY_REASONS = [
  'already_claimed',
  'merchant_not_active',
  'claiming_disabled',
] as const;
export type MerchantClaimIneligibilityReason =
  (typeof MERCHANT_CLAIM_INELIGIBILITY_REASONS)[number];

/**
 * One scope entry on a claim — what was asked for, and whether the evidence
 * actually reached it.
 */
export interface MerchantClaimScope {
  kind: MerchantClaimScopeKind;
  /** A merchant id, a storefront id, or a normalized lowercase hostname. */
  ref: string;
  state: MerchantClaimScopeState;
  verifiedAt: string | null;
}

/**
 * The claimant-facing claim DTO — what state polling returns.
 *
 * Every field is named explicitly (the payments status-projection rule). What
 * is deliberately ABSENT: evidence of any kind, the reviewer's identity, the
 * challenge token, the conflicting claim's id, and any contact address. A
 * claimant learns their own claim's state and the reason a human gave them,
 * and nothing about anybody else's.
 */
export interface MerchantClaim {
  id: string;
  merchantId: string;
  /** The Oxy account that opened the claim. */
  claimantOxyUserId: string;
  method: MerchantClaimMethod;
  /** Derived from `method` by the registry; never a stored column. */
  assurance: MerchantClaimAssurance;
  state: MerchantClaimState;
  /** The native store this claim intends to link to (#84), when the claimant named one. */
  nativeStoreId: string | null;
  requestedScope: MerchantClaimScope[];
  verifiedScope: MerchantClaimScope[];
  /** Deadline for finishing the attempt; `null` once the claim is terminal. */
  expiresAt: string | null;
  /** When a verified claim must prove itself again (issue model field 9). */
  revalidateAfter: string | null;
  /** True when {@link revalidateAfter} is in the past — derived, never stored. */
  revalidationDue: boolean;
  /** The reviewer's words, written to be read by the claimant. */
  decisionReason: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  revokeReason: MerchantClaimRevokeReason | null;
  /**
   * Whether a conflicting claim exists — a boolean, not the other claim's id.
   * A contestant already knows they are in dispute; handing them a handle on
   * someone else's record tells them something about that person instead.
   */
  hasConflictingClaim: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a claimant is told when a challenge is issued: where to put the proof,
 * what the proof is, and when it stops being accepted.
 *
 * `token` is present ONLY for the methods whose proof IS the token — the
 * claimant publishes it in DNS or on their site, or receives it by mail. It is
 * returned exactly once, at issuance, and the server keeps only its SHA-256.
 */
export interface MerchantClaimChallengeInstructions {
  challengeId: string;
  method: MerchantClaimMethod;
  subjectKind: MerchantClaimChallengeSubjectKind;
  /** The domain, connection id or role address the proof is about. */
  subject: string;
  expiresAt: string;
  /** The one-time proof value, when the claimant needs to carry it. */
  token?: string;
  /** `dns_txt`: the record name to create, e.g. `_mercaria-challenge.example.com`. */
  dnsRecordName?: string;
  /** `dns_txt`: the exact TXT value to publish. */
  dnsRecordValue?: string;
  /** `well_known_file`: the absolute path the file must be served from. */
  filePath?: string;
  /** `well_known_file`: the exact file contents. */
  fileContents?: string;
  /** `meta_tag`: the `name` attribute of the meta tag. */
  metaTagName?: string;
  /** `meta_tag`: the `content` attribute of the meta tag. */
  metaTagContent?: string;
}

/** One method a client may offer, with everything it needs to render the choice. */
export interface MerchantClaimMethodOption {
  method: MerchantClaimMethod;
  assurance: MerchantClaimAssurance;
  /**
   * Whether proving it verifies the claim outright. `false` means a reviewer
   * decides afterwards — which is why a matching email domain, on its own, can
   * never complete a claim.
   */
  autoVerifies: boolean;
  subjectKind: MerchantClaimChallengeSubjectKind | null;
}

/**
 * `GET /merchants/:idOrSlug/claim-eligibility` — whether to show
 * `Claim this merchant`, and which proofs this deployment can actually take.
 *
 * Public and evidence-free: it names no claimant, no reviewer and no pending
 * claim's id, because the button's visibility is not worth disclosing who is
 * mid-claim on a merchant page anybody can load.
 */
export interface MerchantClaimEligibility {
  merchantId: string;
  claimable: boolean;
  /** Present exactly when `claimable` is false. */
  reason: MerchantClaimIneligibilityReason | null;
  /**
   * Whether SOMEBODY has a live claim on this merchant — a boolean, never a
   * name or a count, and never a refusal: a claim already in flight does not
   * stop another person opening one, because the first mover would otherwise
   * be able to lock the real operator out by squatting.
   */
  claimInProgress: boolean;
  /** ADR 0002 D9's stored verdict, restated so a client need not fetch twice. */
  claimState: 'unclaimed' | 'claim_pending' | 'claimed';
  availableMethods: MerchantClaimMethodOption[];
}

/** One entry of a claim's audit timeline, as the operator surface reads it. */
export interface MerchantClaimEvent {
  id: string;
  action: MerchantClaimEventAction;
  actorKind: MerchantClaimActorKind;
  actorOxyUserId: string | null;
  fromState: MerchantClaimState | null;
  toState: MerchantClaimState | null;
  reason: string | null;
  at: string;
}

/** One private evidence reference. Operator surface only, never public. */
export interface MerchantClaimEvidence {
  id: string;
  kind: MerchantClaimEvidenceKind;
  /** An Oxy file id — the file itself never travels through Mercaria. */
  oxyFileId: string | null;
  /** Digest of the referenced document, when one was declared. */
  sha256: string | null;
  note: string | null;
  collectedByOxyUserId: string | null;
  collectedAt: string;
}

/**
 * The operator review view: the claim, its full scope, its audit timeline and
 * its private evidence. Reading one is itself an audited event.
 */
export interface MerchantClaimOperatorView {
  claim: MerchantClaim;
  /** The conflicting claim's id — visible here and nowhere else. */
  conflictingClaimId: string | null;
  reviewedByOxyUserId: string | null;
  reviewedAt: string | null;
  events: MerchantClaimEvent[];
  evidence: MerchantClaimEvidence[];
}
