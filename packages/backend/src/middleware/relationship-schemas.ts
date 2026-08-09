/**
 * Request schemas for the relationship surfaces (#55).
 *
 * Its own file beside `commerce-graph-schemas.ts`, following the same rules:
 * every body schema is `.strict()`, and every value tuple comes from
 * `@mercaria/shared-types` rather than being retyped, so a schema cannot accept
 * a value the database CHECK then refuses.
 *
 * `.strict()` is doing real work here and not just tidiness. No schema in this
 * file carries a `status`, `verified`, `badge` or `confidence` field, so no HTTP
 * caller can propose a verdict or a match score at all — confidence reaches the
 * column only through an in-process ingestion call (#58/#62), never over the
 * wire. A public badge has no request shape that could produce it.
 */

import { z } from 'zod';
import {
  RELATIONSHIP_EVIDENCE_KINDS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_VERIFICATION_METHODS,
  RELATIONSHIP_VERIFICATION_STATES,
  type RelationshipEvidenceKind,
  type RelationshipKind,
  type RelationshipVerificationMethod,
  type RelationshipVerificationState,
} from '@mercaria/shared-types';

const KIND_VALUES = RELATIONSHIP_KINDS as readonly [RelationshipKind, ...RelationshipKind[]];
const METHOD_VALUES = RELATIONSHIP_VERIFICATION_METHODS as readonly [
  RelationshipVerificationMethod,
  ...RelationshipVerificationMethod[],
];
const EVIDENCE_KIND_VALUES = RELATIONSHIP_EVIDENCE_KINDS as readonly [
  RelationshipEvidenceKind,
  ...RelationshipEvidenceKind[],
];
const STATUS_VALUES = RELATIONSHIP_VERIFICATION_STATES as readonly [
  RelationshipVerificationState,
  ...RelationshipVerificationState[],
];

const entityId = z.string().trim().min(1).max(64);
/** ISO 3166-1 alpha-2, matching the column's own CHECK rather than approximating it. */
const territory = z.string().trim().regex(/^[A-Za-z]{2}$/);
const language = z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
const reason = z.string().trim().min(10).max(2_000);

/** `POST /internal/commerce-graph/relationships` — assert a CLAIM, never a verdict. */
export const relationshipAssertSchema = z
  .object({
    kind: z.enum(KIND_VALUES),
    organizationId: entityId.optional(),
    brandId: entityId.optional(),
    merchantId: entityId.optional(),
    productFamilyId: entityId.optional(),
    relatedBrandId: entityId.optional(),
    storefrontId: entityId.optional(),
    territories: z.array(territory).max(250).optional(),
    languages: z.array(language).max(100).optional(),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().optional(),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

/** `POST …/relationships/:id/evidence` — attach one durable piece of proof. */
export const relationshipEvidenceSchema = z
  .object({
    kind: z.enum(EVIDENCE_KIND_VALUES),
    observedFact: z.string().trim().min(3).max(4_000),
    subjectDomain: z.string().trim().min(3).max(253).optional(),
    sourceUrl: z.string().url().max(2_000).optional(),
    oxyFileId: z.string().trim().min(1).max(64).optional(),
    contentSha256: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    sourceRecordId: z.string().trim().min(1).max(64).optional(),
    locale: language.optional(),
    observedAt: z.string().datetime().optional(),
    reviewerNote: z.string().trim().min(1).max(4_000).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

/** `POST …/evidence/:evidenceId/revoke` — the proof lapses, the history does not. */
export const relationshipEvidenceRevokeSchema = z.object({ reason }).strict();

/**
 * `POST …/relationships/:id/verify` — the only path to a public badge.
 *
 * There is no `skipEvidence`, no `force` and no `approvedBy`: the evidence gate
 * and the four-eyes gate read stored rows, so nothing a caller can put in a body
 * influences either.
 */
export const relationshipVerifySchema = z
  .object({
    method: z.enum(METHOD_VALUES),
    reason,
    validTo: z.string().datetime().optional(),
  })
  .strict();

/** `POST …/relationships/:id/approve` — one operator's endorsement, no verdict. */
export const relationshipApproveSchema = z.object({ reason }).strict();

/** `POST …/relationships/:id/reject` and `…/request-evidence`. */
export const relationshipReviewSchema = z.object({ reason }).strict();

/** `POST …/relationships/:id/expire` and `…/revoke`. */
export const relationshipEndSchema = z
  .object({
    reason,
    at: z.string().datetime().optional(),
  })
  .strict();

/** `POST …/relationships/:id/correct` — closes this row and opens its successor. */
export const relationshipCorrectSchema = z
  .object({
    reason,
    territories: z.array(territory).max(250).optional(),
    languages: z.array(language).max(100).optional(),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().optional(),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

/** `GET /internal/commerce-graph/relationships` — the candidate queue. */
export const relationshipQueueQuerySchema = z
  .object({
    status: z.array(z.enum(STATUS_VALUES)).or(z.enum(STATUS_VALUES)).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * `GET /brand-relationships/official-channel` — the product page's question.
 *
 * `.strict()` again for a reason worth naming: there is no `includeCandidates`
 * and no `minConfidence` parameter, so a caller cannot widen a public badge read
 * into the candidate space from the query string.
 */
export const officialChannelQuerySchema = z
  .object({
    merchantId: entityId,
    brandId: entityId,
    market: territory.optional(),
  })
  .strict();

/** `GET /brand-relationships/brands/:brandId/channels`. */
export const brandChannelsQuerySchema = z
  .object({
    market: territory.optional(),
  })
  .strict();
