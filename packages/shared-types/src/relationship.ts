/**
 * Verified organization / brand / official-store relationships — issue #55,
 * bound by ADR 0002 (`docs/adr/0002-canonical-commerce-graph.md`) D10/D11/D17.
 *
 * A relationship is a **typed, scoped, temporal, evidence-backed claim** between
 * two canonical graph entities. It is never a boolean on an entity and never
 * inferred from a name, a logo or a domain: "Apple Store is Apple's official
 * store in Spain" is one row with an evidence trail, a market list and a
 * validity window — not a flag someone can set.
 *
 * ## The distinction the whole file exists to hold
 *
 * `status` (a verification VERDICT decided by an authorized actor) and
 * `confidence` (how sure a MACHINE matcher is) are two different fields and
 * neither implies the other. A 0.99-confidence candidate is still a candidate;
 * a hand-entered verified row carries no confidence at all. Collapsing them
 * would make "the matcher was very sure" indistinguishable from "a human with
 * evidence decided", which is precisely the badge this domain must not be able
 * to mint by accident.
 *
 * ## Three of the issue's nine relationship types are NOT kinds
 *
 * ADR 0002 D17 draws the line: *containment is a foreign key, assertable and
 * temporal facts are relationship rows*. "Merchant operates storefront", "brand
 * contains product family" and "brand markets product" are containment — they
 * live on `storefronts.merchant_id` and `canonical_product_families.brand_id`,
 * where they cannot disagree with a second copy. {@link STRUCTURAL_GRAPH_FACTS}
 * names each one and where it is stored, so the graph still answers all nine
 * questions and a reader can see which mechanism answers which.
 */

/** The canonical entity kinds a relationship endpoint may address. */
export const RELATIONSHIP_ENTITY_KINDS = [
  'organization',
  'brand',
  'merchant',
  'product_family',
] as const;
export type RelationshipEntityKind = (typeof RELATIONSHIP_ENTITY_KINDS)[number];

/**
 * The closed set of relationship kinds (ADR 0002 D17, extended by #55 with
 * `brand_succeeds_brand` for the issue's ninth type).
 *
 * Direction is FIXED per kind — subject → object, exactly as the name reads —
 * and there are no inverse rows: the inverse reading is a query, so the two
 * directions cannot disagree.
 */
export const RELATIONSHIP_KINDS = [
  'organization_owns_brand',
  'organization_operates_merchant',
  'organization_manufactures',
  'merchant_official_channel_for_brand',
  'merchant_authorized_reseller_for_brand',
  'brand_succeeds_brand',
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

/**
 * What each kind means, and which entity kinds its two endpoints accept.
 *
 * This registry is the TypeScript half of "relationship types must constrain
 * valid subject and object entity kinds"; the SQL half is
 * `commerce_relationships_endpoints_check`, a per-kind CHECK whose `else false`
 * branch makes an unrecognised kind unrepresentable even with the kind CHECK
 * removed. Both halves are pinned: the registry by a unit test, the CHECK by a
 * real-database test that tries every kind with the wrong endpoint set.
 */
export interface RelationshipKindDefinition {
  readonly subject: RelationshipEntityKind;
  readonly object: RelationshipEntityKind;
  /**
   * Whether a verified row of this kind can produce a PUBLIC badge. Only these
   * kinds reach a product or brand page as a claim about a seller, which is why
   * they are the ones four-eyes approval covers.
   */
  readonly publicBadge: PublicRelationshipBadge | null;
  readonly description: string;
}

/**
 * The two public labels this domain can produce, and they are deliberately
 * DIFFERENT WORDS for different facts (issue product behaviour 2). An
 * authorized reseller is not a brand store; a merchant with neither is an
 * ordinary offer with no badge at all, which is the normal state (ADR D10).
 */
export const PUBLIC_RELATIONSHIP_BADGES = ['official_store', 'authorized_reseller'] as const;
export type PublicRelationshipBadge = (typeof PUBLIC_RELATIONSHIP_BADGES)[number];

export const RELATIONSHIP_KIND_DEFINITIONS: Readonly<
  Record<RelationshipKind, RelationshipKindDefinition>
> = Object.freeze({
  organization_owns_brand: {
    subject: 'organization',
    object: 'brand',
    publicBadge: null,
    description: 'A legal entity owns the brand. At most one verified owner per brand at a time.',
  },
  organization_operates_merchant: {
    subject: 'organization',
    object: 'merchant',
    publicBadge: null,
    description: 'A legal entity operates the commercial actor that sells.',
  },
  organization_manufactures: {
    subject: 'organization',
    object: 'product_family',
    publicBadge: null,
    description:
      'A legal entity manufactures a product family. Deliberately independent of brand ' +
      'ownership (ADR 0002 D11): Foxconn manufactures iPhones and owns no Apple brand.',
  },
  merchant_official_channel_for_brand: {
    subject: 'merchant',
    object: 'brand',
    publicBadge: 'official_store',
    description: "A merchant is the brand's own direct sales channel in the scoped markets.",
  },
  merchant_authorized_reseller_for_brand: {
    subject: 'merchant',
    object: 'brand',
    publicBadge: 'authorized_reseller',
    description:
      'A merchant is authorized by the brand to resell it. A DIFFERENT claim, and a ' +
      'different public label, from being the brand’s own store.',
  },
  brand_succeeds_brand: {
    subject: 'brand',
    object: 'brand',
    publicBadge: null,
    description:
      'A brand succeeds, renames or supersedes another where historically relevant. ' +
      'Distinct from a merge tombstone (one identity, wrongly split) and from an alias ' +
      '(another spelling of the same identity): succession is two real identities in ' +
      'sequence, with dates and evidence.',
  },
});

/** The kinds a public badge can be produced from — derived, never a second list. */
export const BADGE_RELATIONSHIP_KINDS: readonly RelationshipKind[] = RELATIONSHIP_KINDS.filter(
  (kind) => RELATIONSHIP_KIND_DEFINITIONS[kind].publicBadge !== null,
);

/**
 * The issue's other three relationship types, and the column that already holds
 * each one (ADR 0002 D17). They are listed rather than omitted so "the graph
 * cannot express it" and "the graph expresses it as a foreign key" stay
 * distinguishable — and so a future kind that duplicates one fails review with
 * a name to point at.
 */
export const STRUCTURAL_GRAPH_FACTS = [
  {
    question: 'merchant operates storefront',
    storedAs: 'storefronts.merchant_id',
    reason: 'A storefront cannot exist without its merchant — containment, not a claim.',
  },
  {
    question: 'brand contains product family',
    storedAs: 'canonical_product_families.brand_id',
    reason: 'The family belongs to the brand by construction (#56).',
  },
  {
    question: 'brand markets product',
    storedAs: 'canonical_products.family_id → canonical_product_families.brand_id',
    reason: 'Resolved through the family a product belongs to; no second edge exists (#56).',
  },
] as const;

/**
 * The verification VERDICT — one stored value, nothing re-derives it and no
 * boolean sits beside it (the `provider_accounts.onboarding_state` precedent).
 *
 * `candidate` is ADR 0002 D17's `asserted`, named as the issue names it: a row
 * a source adapter or a self-claiming merchant produced, which is visible,
 * queryable and completely without public effect. `pending_review` is a
 * candidate whose owner has asked for a decision. `expired` and `revoked` are
 * different endings and both keep the row: expiry is time running out on a true
 * claim, revocation is a decision that it should no longer stand.
 */
export const RELATIONSHIP_VERIFICATION_STATES = [
  'candidate',
  'pending_review',
  'verified',
  'rejected',
  'expired',
  'revoked',
] as const;
export type RelationshipVerificationState = (typeof RELATIONSHIP_VERIFICATION_STATES)[number];

/**
 * WHO asserted the row. The authority matrix (ADR 0002 D17) is a function of
 * this, not of the HTTP surface the write arrived on: ingestion may only ever
 * create candidates, a merchant may only ever speak about itself, and only an
 * operator (or an explicit trusted rule) may reach `verified`.
 */
export const RELATIONSHIP_ASSERTED_BY_KINDS = [
  'ingestion_source',
  'merchant_self_claim',
  'platform_verification',
  'catalog_operator',
] as const;
export type RelationshipAssertedByKind = (typeof RELATIONSHIP_ASSERTED_BY_KINDS)[number];

/**
 * HOW a verified row was verified. There is deliberately no `name_match` and no
 * `logo_match` member — the closed set is what makes "verified because the name
 * looked right" unrepresentable rather than merely forbidden, exactly as
 * `NATIVE_STORE_LINK_METHODS` does for #54's linkage.
 */
export const RELATIONSHIP_VERIFICATION_METHODS = [
  'operator_review',
  'domain_control',
  'platform_verification',
  'legal_register',
  'brand_statement',
] as const;
export type RelationshipVerificationMethod = (typeof RELATIONSHIP_VERIFICATION_METHODS)[number];

/**
 * The kind of proof one evidence row carries (ADR 0002 D17).
 *
 * `domain_control` names the domain it proves control OF, and proves nothing
 * else: control of `apple-store-madrid.example` is control of that hostname,
 * never ownership of the Apple brand and never authorization to resell it
 * (D10). {@link SUFFICIENT_EVIDENCE_KINDS} is where that stops being a comment.
 */
export const RELATIONSHIP_EVIDENCE_KINDS = [
  'domain_control',
  'platform_verification',
  'legal_register',
  'brand_statement',
  'operator_attestation',
  'source_document',
] as const;
export type RelationshipEvidenceKind = (typeof RELATIONSHIP_EVIDENCE_KINDS)[number];

/** Evidence outlives its own validity: revoking or expiring it never deletes it. */
export const RELATIONSHIP_EVIDENCE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type RelationshipEvidenceStatus = (typeof RELATIONSHIP_EVIDENCE_STATUSES)[number];

/**
 * Which evidence kinds can, on their own, carry a relationship kind to
 * `verified`.
 *
 * The load-bearing row is `merchant_official_channel_for_brand`: it does NOT
 * list `domain_control`. A merchant proving it controls a hostname has proved
 * control of that hostname — it has not shown the brand appointed it, and a
 * badge minted from a domain is the exact failure ADR 0002 D10 forbids. The
 * same reasoning excludes `domain_control` from brand ownership and from
 * reseller authorization; it stays sufficient for `organization_operates_merchant`,
 * where the fact being proved is control of the operator's own presence.
 *
 * `operator_attestation` is sufficient everywhere on purpose: an operator
 * verifying with evidence is the authority matrix's normal path, and the
 * attestation row is what records that a person put their name to it.
 */
export const SUFFICIENT_EVIDENCE_KINDS: Readonly<
  Record<RelationshipKind, readonly RelationshipEvidenceKind[]>
> = Object.freeze({
  organization_owns_brand: ['legal_register', 'brand_statement', 'operator_attestation'],
  organization_operates_merchant: [
    'legal_register',
    'domain_control',
    'platform_verification',
    'operator_attestation',
  ],
  organization_manufactures: ['legal_register', 'brand_statement', 'operator_attestation'],
  merchant_official_channel_for_brand: [
    'brand_statement',
    'legal_register',
    'platform_verification',
    'operator_attestation',
  ],
  merchant_authorized_reseller_for_brand: [
    'brand_statement',
    'platform_verification',
    'operator_attestation',
  ],
  brand_succeeds_brand: ['legal_register', 'brand_statement', 'operator_attestation'],
});

/** The operator actions the review workflow admits. Append-only audit rows. */
export const RELATIONSHIP_REVIEW_ACTIONS = [
  'approve',
  'reject',
  'request_more_evidence',
  'expire',
  'revoke',
  'correct',
] as const;
export type RelationshipReviewAction = (typeof RELATIONSHIP_REVIEW_ACTIONS)[number];

/**
 * The mutually-inconsistent shapes the conflict detector reports.
 *
 * Detection is DERIVED on read, never a stored column (the
 * `procurement-eligibility` precedent): a stored verdict computed from four
 * other rows goes stale the moment any of them moves, and the place that must
 * not happen is a queue an operator trusts to be complete.
 */
export const RELATIONSHIP_CONFLICT_KINDS = [
  /** An open row already claims this (kind, endpoints, storefront scope). */
  'duplicate_open_claim',
  /** Two organizations hold a verified ownership claim on one brand. */
  'contested_brand_ownership',
  /** One merchant is verified as BOTH a brand's own store and its reseller, in one market. */
  'channel_and_reseller_overlap',
  /** A succeeds B while B succeeds A — the succession chain is not a sequence. */
  'succession_cycle',
  /** Verified, but every evidence row backing it has been revoked or has expired. */
  'verified_without_active_evidence',
  /** Verified and still marked so, while its validity window has already closed. */
  'verified_past_validity',
] as const;
export type RelationshipConflictKind = (typeof RELATIONSHIP_CONFLICT_KINDS)[number];

/**
 * The PUBLIC relationship projection — issue evidence rule 6.
 *
 * Every field is named explicitly (the payments status-projection rule). What is
 * absent is the point: no evidence rows, no reviewer notes, no operator or
 * source actor ids, no confidence, no review round. Private review material has
 * no field here to ride along in, so a serializer cannot leak it by forgetting.
 */
export interface PublicCommerceRelationship {
  id: string;
  kind: RelationshipKind;
  subjectKind: RelationshipEntityKind;
  subjectId: string;
  objectKind: RelationshipEntityKind;
  objectId: string;
  /** ISO 3166-1 alpha-2 markets. EMPTY MEANS WORLDWIDE, never "no markets". */
  territories: string[];
  /** Lowercased language subtags. Empty means every language. */
  languages: string[];
  /** Narrowed to one channel of the merchant, or null for all of them. */
  storefrontId: string | null;
  validFrom: string;
  validTo: string | null;
  /** Always `verified` on a public read — the projection has no other source. */
  status: Extract<RelationshipVerificationState, 'verified'>;
  verifiedAt: string;
  /** The public label this row produces, or null when it produces none. */
  badge: PublicRelationshipBadge | null;
}

/** One relationship as the OPERATOR surface sees it: the whole row. */
export interface OperatorCommerceRelationship {
  id: string;
  kind: RelationshipKind;
  subjectKind: RelationshipEntityKind;
  subjectId: string;
  objectKind: RelationshipEntityKind;
  objectId: string;
  territories: string[];
  languages: string[];
  storefrontId: string | null;
  validFrom: string;
  validTo: string | null;
  status: RelationshipVerificationState;
  verificationMethod: RelationshipVerificationMethod | null;
  /** Machine-matching confidence, 0–1. NULL on deterministic and human rows. */
  confidence: number | null;
  assertedByKind: RelationshipAssertedByKind;
  assertedBySourceId: string | null;
  reviewRound: number;
  createdAt: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  supersededById: string | null;
  supersedesId: string | null;
  note: string | null;
  updatedAt: string;
}

/** One durable piece of proof. Operator-visible only. */
export interface RelationshipEvidence {
  id: string;
  relationshipId: string;
  kind: RelationshipEvidenceKind;
  status: RelationshipEvidenceStatus;
  /** What was actually observed, in words — the claim this row supports. */
  observedFact: string;
  /** The hostname a `domain_control` row proves control of, and nothing more. */
  subjectDomain: string | null;
  sourceUrl: string | null;
  oxyFileId: string | null;
  /** Hex sha-256 of the fetched content, so the claim survives the page changing. */
  contentSha256: string | null;
  sourceRecordId: string | null;
  /** BCP-47 tag of the material observed; a reseller list differs per locale. */
  locale: string | null;
  observedAt: string;
  collectedAt: string;
  reviewerNote: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One append-only review action. The row IS the audit record. */
export interface RelationshipReview {
  id: string;
  relationshipId: string;
  action: RelationshipReviewAction;
  actorOxyUserId: string;
  reason: string;
  reviewRound: number;
  fromStatus: RelationshipVerificationState;
  toStatus: RelationshipVerificationState | null;
  createdAt: string;
}

/** One finding from the conflict detector. */
export interface RelationshipConflict {
  kind: RelationshipConflictKind;
  relationshipId: string;
  /** The other row involved, when the conflict is between two rows. */
  otherRelationshipId: string | null;
  /** Markets both claims cover; empty when the conflict is not market-scoped. */
  overlappingTerritories: string[];
  detail: string;
}

/** A candidate-queue entry: the row, its evidence summary and its conflicts. */
export interface RelationshipCandidate {
  relationship: OperatorCommerceRelationship;
  evidenceCount: number;
  activeEvidenceCount: number;
  evidenceKinds: RelationshipEvidenceKind[];
  /** Operators who have already endorsed this round — the four-eyes tally. */
  approvedByOxyUserIds: string[];
  /** Whether this kind needs a second operator before it can be verified. */
  requiresFourEyes: boolean;
  conflicts: RelationshipConflict[];
}

/**
 * "Is this merchant an official direct channel for this brand, in this market,
 * right now?" — the one question a product page asks (issue product behaviour
 * 1/2/4).
 *
 * `badge` is null for an ordinary merchant selling the brand, which is the
 * normal, non-exceptional answer and carries no relationship row at all.
 */
export interface OfficialChannelVerdict {
  merchantId: string;
  brandId: string;
  /** The ISO 3166-1 alpha-2 market the question was asked for, if any. */
  market: string | null;
  badge: PublicRelationshipBadge | null;
  /** The relationship the badge came from; null when there is no badge. */
  relationship: PublicCommerceRelationship | null;
}

/**
 * A brand's verified channels, the two kinds kept in SEPARATE lists (issue
 * product behaviour 3) rather than one list with a discriminator: a caller that
 * forgets to switch on the discriminator renders a reseller as a brand store,
 * and two fields make that mistake impossible to make silently.
 */
export interface BrandChannelDirectory {
  brandId: string;
  market: string | null;
  officialChannels: PublicCommerceRelationship[];
  authorizedResellers: PublicCommerceRelationship[];
}
