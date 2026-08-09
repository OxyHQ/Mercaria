/**
 * Reads and writes for `commerce_relationships`, `relationship_evidence` and
 * `relationship_reviews` (#55).
 *
 * The database holds the properties this file only interprets: the partial
 * unique on `(kind, endpoint_key) WHERE valid_to IS NULL` is what makes a
 * duplicate open claim impossible, the partial unique on
 * `(relationship_id, review_round, actor_oxy_user_id) WHERE action = 'approve'`
 * is what makes a second endorsement by the same operator impossible, and the
 * append-only trigger is what makes a review row immutable. A service-side check
 * beside each of them is a friendlier ERROR MESSAGE, never the enforcement.
 *
 * Every status change is a single-statement CAS (`WHERE id AND status = …`), the
 * `order.service.transition` shape: the row is locked for the statement, so the
 * loser of a race re-checks its predicate against the winner's write and learns
 * from an empty `RETURNING` set instead of overwriting a decision.
 */

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type {
  RelationshipAssertedByKind,
  RelationshipEvidenceKind,
  RelationshipKind,
  RelationshipReviewAction,
  RelationshipVerificationMethod,
  RelationshipVerificationState,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  commerceRelationships,
  relationshipEvidence,
  relationshipReviews,
} from '../schema/relationships.js';

export type CommerceRelationshipRow = typeof commerceRelationships.$inferSelect;
export type RelationshipEvidenceRow = typeof relationshipEvidence.$inferSelect;
export type RelationshipReviewRow = typeof relationshipReviews.$inferSelect;

/** The endpoint columns a kind may set. Absent means NULL — the CHECK decides. */
export interface RelationshipEndpoints {
  organizationId?: string;
  brandId?: string;
  merchantId?: string;
  productFamilyId?: string;
  relatedBrandId?: string;
}

export interface CreateRelationshipInput extends RelationshipEndpoints {
  kind: RelationshipKind;
  territories: string[];
  languages: string[];
  storefrontId?: string;
  validFrom: Date;
  validTo?: Date;
  status: RelationshipVerificationState;
  assertedByKind: RelationshipAssertedByKind;
  assertedBySourceId?: string;
  confidence?: number;
  createdByOxyUserId?: string;
  note?: string;
}

/**
 * Claim an open relationship row, or return `undefined` when one already holds
 * this (kind, endpoints, storefront scope).
 *
 * `onConflictDoNothing` names no arbiter: two partial uniques cover this table
 * and either may be the one that fires (a second verified brand owner trips the
 * ownership index, not the open-claim one). An empty `RETURNING` set means "some
 * index refused it" and the SERVICE reads back to say which — the
 * `insertNativeStoreLink` shape, for the same reason.
 */
export async function insertRelationship(
  db: DatabaseOrTransaction,
  input: CreateRelationshipInput,
): Promise<CommerceRelationshipRow | undefined> {
  const [row] = await db
    .insert(commerceRelationships)
    .values({
      kind: input.kind,
      organizationId: input.organizationId ?? null,
      brandId: input.brandId ?? null,
      merchantId: input.merchantId ?? null,
      productFamilyId: input.productFamilyId ?? null,
      relatedBrandId: input.relatedBrandId ?? null,
      territories: input.territories,
      languages: input.languages,
      storefrontId: input.storefrontId ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      status: input.status,
      assertedByKind: input.assertedByKind,
      assertedBySourceId: input.assertedBySourceId ?? null,
      confidence: input.confidence ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function findRelationshipById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CommerceRelationshipRow | undefined> {
  const [row] = await db
    .select()
    .from(commerceRelationships)
    .where(eq(commerceRelationships.id, id));
  return row;
}

/** The OPEN row holding this claim, if any — the duplicate the index refused. */
export async function findOpenRelationship(
  db: DatabaseOrTransaction,
  input: { kind: RelationshipKind; endpoints: RelationshipEndpoints; storefrontId?: string },
): Promise<CommerceRelationshipRow | undefined> {
  const { endpoints } = input;
  const [row] = await db
    .select()
    .from(commerceRelationships)
    .where(
      and(
        eq(commerceRelationships.kind, input.kind),
        isNull(commerceRelationships.validTo),
        endpointMatches(commerceRelationships.organizationId, endpoints.organizationId),
        endpointMatches(commerceRelationships.brandId, endpoints.brandId),
        endpointMatches(commerceRelationships.merchantId, endpoints.merchantId),
        endpointMatches(commerceRelationships.productFamilyId, endpoints.productFamilyId),
        endpointMatches(commerceRelationships.relatedBrandId, endpoints.relatedBrandId),
        endpointMatches(commerceRelationships.storefrontId, input.storefrontId),
      ),
    );
  return row;
}

/**
 * `column = value`, or `column IS NULL` when the endpoint is absent.
 *
 * `eq(column, undefined)` is not the same predicate and Postgres would never
 * match a NULL with `=` anyway — which is exactly the NULL-distinctness trap the
 * generated `endpoint_key` exists to route around on the index side.
 */
function endpointMatches(column: PgColumn, value?: string) {
  return value === undefined ? isNull(column) : eq(column, value);
}

/** Every relationship naming this entity in any endpoint position. */
export async function listRelationshipsForEntity(
  db: DatabaseOrTransaction,
  input: {
    organizationId?: string;
    brandId?: string;
    merchantId?: string;
    productFamilyId?: string;
    kinds?: readonly RelationshipKind[];
    statuses?: readonly RelationshipVerificationState[];
  },
): Promise<CommerceRelationshipRow[]> {
  const endpointFilters = [
    input.organizationId === undefined
      ? undefined
      : eq(commerceRelationships.organizationId, input.organizationId),
    input.brandId === undefined
      ? undefined
      : or(
          eq(commerceRelationships.brandId, input.brandId),
          eq(commerceRelationships.relatedBrandId, input.brandId),
        ),
    input.merchantId === undefined
      ? undefined
      : eq(commerceRelationships.merchantId, input.merchantId),
    input.productFamilyId === undefined
      ? undefined
      : eq(commerceRelationships.productFamilyId, input.productFamilyId),
  ].filter((filter) => filter !== undefined);

  const filters = [
    ...endpointFilters,
    input.kinds === undefined
      ? undefined
      : inArray(commerceRelationships.kind, [...input.kinds]),
    input.statuses === undefined
      ? undefined
      : inArray(commerceRelationships.status, [...input.statuses]),
  ].filter((filter) => filter !== undefined);

  return db
    .select()
    .from(commerceRelationships)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(commerceRelationships.createdAt));
}

/**
 * The relationships that are CURRENT at an instant: verified, inside their
 * validity window, and covering the market if one was asked for.
 *
 * The temporal predicate is evaluated here rather than trusted from `status`,
 * and the difference is not academic: a row whose `valid_to` passed an hour ago
 * still carries `status = 'verified'` until something sweeps it, and this is the
 * read a product page's badge comes from. Requiring BOTH means the badge
 * disappears when the claim lapses, whether or not anyone ran the sweep.
 *
 * Market matching: `'{}'` territories means WORLDWIDE and matches every market;
 * a non-empty list must contain the requested code. A market-less question
 * matches any scope.
 */
export async function findCurrentRelationships(
  db: DatabaseOrTransaction,
  input: {
    kinds: readonly RelationshipKind[];
    brandId?: string;
    merchantId?: string;
    market?: string;
    at: Date;
  },
): Promise<CommerceRelationshipRow[]> {
  const at = input.at.toISOString();
  const filters = [
    inArray(commerceRelationships.kind, [...input.kinds]),
    eq(commerceRelationships.status, 'verified'),
    sql`${commerceRelationships.validFrom} <= ${at}::timestamptz`,
    or(
      isNull(commerceRelationships.validTo),
      sql`${commerceRelationships.validTo} > ${at}::timestamptz`,
    ),
    input.brandId === undefined ? undefined : eq(commerceRelationships.brandId, input.brandId),
    input.merchantId === undefined
      ? undefined
      : eq(commerceRelationships.merchantId, input.merchantId),
    input.market === undefined
      ? undefined
      : sql`(cardinality(${commerceRelationships.territories}) = 0 or ${input.market} = any(${commerceRelationships.territories}))`,
  ].filter((filter) => filter !== undefined);

  return db
    .select()
    .from(commerceRelationships)
    .where(and(...filters))
    .orderBy(desc(commerceRelationships.verifiedAt));
}

/** The operator candidate queue, oldest first — the review-queue index's order. */
export async function listRelationshipsByStatus(
  db: DatabaseOrTransaction,
  input: { statuses: readonly RelationshipVerificationState[]; limit: number; offset: number },
): Promise<CommerceRelationshipRow[]> {
  return db
    .select()
    .from(commerceRelationships)
    .where(inArray(commerceRelationships.status, [...input.statuses]))
    .orderBy(asc(commerceRelationships.createdAt))
    .limit(input.limit)
    .offset(input.offset);
}

/** Fields a status change may write. Every one of them is part of the audit. */
export interface RelationshipStatusChange {
  toStatus: RelationshipVerificationState;
  verificationMethod?: RelationshipVerificationMethod;
  verifiedAt?: Date;
  verifiedByOxyUserId?: string;
  rejectedAt?: Date;
  expiredAt?: Date;
  revokedAt?: Date;
  revokedByOxyUserId?: string;
  revokeReason?: string;
  validTo?: Date;
  lastCheckedAt?: Date;
}

/**
 * Move the status, guarded on the status the caller read — one statement, so a
 * concurrent decision produces exactly ONE winner.
 *
 * `review_round` advances with every terminal move, which is what stops an
 * approval given for one decision from counting towards the next.
 */
export async function transitionRelationship(
  db: DatabaseOrTransaction,
  input: { id: string; expectedStatus: RelationshipVerificationState } & RelationshipStatusChange,
): Promise<CommerceRelationshipRow | undefined> {
  const [row] = await db
    .update(commerceRelationships)
    .set({
      status: input.toStatus,
      verificationMethod: input.verificationMethod ?? null,
      verifiedAt: input.verifiedAt ?? null,
      verifiedByOxyUserId: input.verifiedByOxyUserId ?? null,
      rejectedAt: input.rejectedAt ?? null,
      expiredAt: input.expiredAt ?? null,
      revokedAt: input.revokedAt ?? null,
      revokedByOxyUserId: input.revokedByOxyUserId ?? null,
      revokeReason: input.revokeReason ?? null,
      validTo: input.validTo ?? null,
      lastCheckedAt: input.lastCheckedAt ?? null,
      reviewRound: sql`${commerceRelationships.reviewRound} + 1`,
    })
    .where(
      and(
        eq(commerceRelationships.id, input.id),
        eq(commerceRelationships.status, input.expectedStatus),
      ),
    )
    .returning();
  return row;
}

/**
 * A status change that PRESERVES the verified facts already on the row.
 *
 * `transitionRelationship` writes every audit column, so it clears the ones the
 * caller did not supply — correct for a move OUT of `verified`, and destructive
 * for expiry and revocation, which must keep `verified_at`, the method and the
 * verifying operator. Those two go through here: the `verified` columns are
 * simply not in the `set`, so the row keeps saying who verified it and how,
 * beside the record of it ending. Splitting the two is what stops "the claim
 * lapsed" from erasing "a person verified it in March".
 */
export async function closeRelationship(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expectedStatus: RelationshipVerificationState;
    toStatus: Extract<RelationshipVerificationState, 'expired' | 'revoked'>;
    validTo: Date;
    expiredAt?: Date;
    revokedAt?: Date;
    revokedByOxyUserId?: string;
    revokeReason?: string;
  },
): Promise<CommerceRelationshipRow | undefined> {
  const [row] = await db
    .update(commerceRelationships)
    .set({
      status: input.toStatus,
      validTo: input.validTo,
      expiredAt: input.expiredAt ?? null,
      revokedAt: input.revokedAt ?? null,
      revokedByOxyUserId: input.revokedByOxyUserId ?? null,
      revokeReason: input.revokeReason ?? null,
      reviewRound: sql`${commerceRelationships.reviewRound} + 1`,
    })
    .where(
      and(
        eq(commerceRelationships.id, input.id),
        eq(commerceRelationships.status, input.expectedStatus),
      ),
    )
    .returning();
  return row;
}

/** Link a corrected row to the one that replaces it. Set once, never rewritten. */
export async function markSuperseded(
  db: DatabaseOrTransaction,
  input: { id: string; supersededById: string },
): Promise<CommerceRelationshipRow | undefined> {
  const [row] = await db
    .update(commerceRelationships)
    .set({ supersededById: input.supersededById })
    .where(
      and(
        eq(commerceRelationships.id, input.id),
        isNull(commerceRelationships.supersededById),
      ),
    )
    .returning();
  return row;
}

/** The row this one corrected, if any — the reverse of `superseded_by_id`. */
export async function findPredecessor(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CommerceRelationshipRow | undefined> {
  const [row] = await db
    .select()
    .from(commerceRelationships)
    .where(eq(commerceRelationships.supersededById, id));
  return row;
}

/** Record that the claim was re-checked against its evidence. */
export async function touchLastChecked(
  db: DatabaseOrTransaction,
  input: { id: string; at: Date },
): Promise<void> {
  await db
    .update(commerceRelationships)
    .set({ lastCheckedAt: input.at })
    .where(eq(commerceRelationships.id, input.id));
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface CreateEvidenceInput {
  relationshipId: string;
  kind: RelationshipEvidenceKind;
  observedFact: string;
  subjectDomain?: string;
  sourceUrl?: string;
  oxyFileId?: string;
  contentSha256?: string;
  sourceRecordId?: string;
  locale?: string;
  observedAt: Date;
  collectedByOxyUserId?: string;
  reviewerNote?: string;
  expiresAt?: Date;
}

export async function insertEvidence(
  db: DatabaseOrTransaction,
  input: CreateEvidenceInput,
): Promise<RelationshipEvidenceRow> {
  const [row] = await db
    .insert(relationshipEvidence)
    .values({
      relationshipId: input.relationshipId,
      kind: input.kind,
      observedFact: input.observedFact,
      subjectDomain: input.subjectDomain ?? null,
      sourceUrl: input.sourceUrl ?? null,
      oxyFileId: input.oxyFileId ?? null,
      contentSha256: input.contentSha256 ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      locale: input.locale ?? null,
      observedAt: input.observedAt,
      collectedByOxyUserId: input.collectedByOxyUserId ?? null,
      reviewerNote: input.reviewerNote ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('Inserting relationship evidence returned no row.');
  }
  return row;
}

export async function listEvidence(
  db: DatabaseOrTransaction,
  relationshipId: string,
): Promise<RelationshipEvidenceRow[]> {
  return db
    .select()
    .from(relationshipEvidence)
    .where(eq(relationshipEvidence.relationshipId, relationshipId))
    .orderBy(desc(relationshipEvidence.observedAt));
}

export async function listEvidenceForRelationships(
  db: DatabaseOrTransaction,
  relationshipIds: readonly string[],
): Promise<RelationshipEvidenceRow[]> {
  if (relationshipIds.length === 0) return [];
  return db
    .select()
    .from(relationshipEvidence)
    .where(inArray(relationshipEvidence.relationshipId, [...relationshipIds]));
}

/**
 * Revoke a piece of proof. The row STAYS — status moves and the revocation is
 * stamped, so a relationship that was once verified keeps a readable account of
 * what it was verified on, and the conflict detector can report "verified with
 * no active evidence" rather than the evidence simply being gone.
 */
export async function revokeEvidence(
  db: DatabaseOrTransaction,
  input: { id: string; revokedByOxyUserId: string; revokedAt: Date; reason: string },
): Promise<RelationshipEvidenceRow | undefined> {
  const [row] = await db
    .update(relationshipEvidence)
    .set({
      status: 'revoked',
      revokedAt: input.revokedAt,
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokeReason: input.reason,
    })
    .where(and(eq(relationshipEvidence.id, input.id), eq(relationshipEvidence.status, 'active')))
    .returning();
  return row;
}

/** Mark evidence whose own `expires_at` has passed. Never deletes. */
export async function expireLapsedEvidence(
  db: DatabaseOrTransaction,
  at: Date,
): Promise<RelationshipEvidenceRow[]> {
  return db
    .update(relationshipEvidence)
    .set({ status: 'expired' })
    .where(
      and(
        eq(relationshipEvidence.status, 'active'),
        sql`${relationshipEvidence.expiresAt} is not null and ${relationshipEvidence.expiresAt} <= ${at.toISOString()}::timestamptz`,
      ),
    )
    .returning();
}

// ── Reviews ─────────────────────────────────────────────────────────────────

export interface CreateReviewInput {
  relationshipId: string;
  action: RelationshipReviewAction;
  actorOxyUserId: string;
  reason: string;
  reviewRound: number;
  fromStatus: RelationshipVerificationState;
  toStatus?: RelationshipVerificationState;
}

/**
 * Append one review row.
 *
 * `onConflictDoNothing` matters only for `approve`, whose partial unique holds
 * the four-eyes rule: an empty `RETURNING` set means this operator has already
 * endorsed this round, which the service reports as a refusal rather than
 * silently counting one person twice.
 */
export async function insertReview(
  db: DatabaseOrTransaction,
  input: CreateReviewInput,
): Promise<RelationshipReviewRow | undefined> {
  const [row] = await db
    .insert(relationshipReviews)
    .values({
      relationshipId: input.relationshipId,
      action: input.action,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      reviewRound: input.reviewRound,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** The operators who have endorsed the CURRENT round — the four-eyes tally. */
export async function listApprovalsForRound(
  db: DatabaseOrTransaction,
  input: { relationshipId: string; reviewRound: number },
): Promise<RelationshipReviewRow[]> {
  return db
    .select()
    .from(relationshipReviews)
    .where(
      and(
        eq(relationshipReviews.relationshipId, input.relationshipId),
        eq(relationshipReviews.reviewRound, input.reviewRound),
        eq(relationshipReviews.action, 'approve'),
      ),
    );
}

export async function listReviews(
  db: DatabaseOrTransaction,
  relationshipId: string,
): Promise<RelationshipReviewRow[]> {
  return db
    .select()
    .from(relationshipReviews)
    .where(eq(relationshipReviews.relationshipId, relationshipId))
    .orderBy(asc(relationshipReviews.createdAt));
}

export async function listApprovalsForRelationships(
  db: DatabaseOrTransaction,
  relationshipIds: readonly string[],
): Promise<RelationshipReviewRow[]> {
  if (relationshipIds.length === 0) return [];
  return db
    .select()
    .from(relationshipReviews)
    .where(
      and(
        inArray(relationshipReviews.relationshipId, [...relationshipIds]),
        eq(relationshipReviews.action, 'approve'),
      ),
    );
}
