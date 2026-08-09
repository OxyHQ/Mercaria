/**
 * Request schemas for the merchant-claim surfaces (#83).
 *
 * Its own file, following `commerce-graph-schemas.ts` and `payments-schemas.ts`.
 * Every body schema is `.strict()`, and here that is load-bearing rather than
 * tidy: it is what makes "the request cannot carry an email address", "the
 * request cannot carry a state", and "a claimant cannot name a reviewer"
 * checkable at the schema instead of being a habit at every handler.
 *
 * Value tuples come from `@mercaria/shared-types`, never retyped — a
 * hand-copied list here could accept a value the database CHECK then refuses.
 */

import { z } from 'zod';
import {
  MERCHANT_CLAIM_METHODS,
  MERCHANT_CLAIM_REVOKE_REASONS,
  type MerchantClaimMethod,
  type MerchantClaimRevokeReason,
} from '@mercaria/shared-types';

const METHOD_VALUES = MERCHANT_CLAIM_METHODS as readonly [
  MerchantClaimMethod,
  ...MerchantClaimMethod[],
];

const REVOKE_REASON_VALUES = MERCHANT_CLAIM_REVOKE_REASONS as readonly [
  MerchantClaimRevokeReason,
  ...MerchantClaimRevokeReason[],
];

/** A plausible hostname; the service normalizes and re-validates. */
const domainSchema = z.string().trim().min(3).max(253);

/** An entity id in either shape this schema stores (24-hex ObjectId or uuid v7). */
const entityIdSchema = z.string().trim().min(1).max(64);

/**
 * One evidence reference. A file id, a URL, a note — never a document: files
 * belong to Oxy and Mercaria stores only the id, so there is no field here a
 * document could arrive through.
 */
const evidenceSchema = z
  .object({
    oxyFileId: z.string().trim().min(1).max(128).optional(),
    /** A sha-256 in the form the column's CHECK requires. */
    sha256: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters')
      .optional(),
    note: z.string().trim().min(1).max(4_000).optional(),
    url: z.string().trim().url().max(2_048).optional(),
  })
  .strict()
  .refine(
    (item) => item.oxyFileId !== undefined || item.url !== undefined || item.note !== undefined,
    { message: 'Evidence must reference a file, a URL or a note' },
  );

/**
 * `POST /merchant-claims` — open a claim.
 *
 * There is deliberately no `state`, no `assurance`, no `verifiedAt` and no
 * email field. The subject is `domain` XOR `connectionId` and the service
 * refuses the one the chosen method does not take; expressing that here as
 * well would put the method registry's knowledge in two places.
 */
export const openMerchantClaimSchema = z
  .object({
    merchantId: entityIdSchema,
    method: z.enum(METHOD_VALUES),
    domain: domainSchema.optional(),
    connectionId: entityIdSchema.optional(),
    /** Channels this proof should cover. Empty means "the merchant only". */
    storefrontIds: z.array(entityIdSchema).max(50).optional(),
    /** The native store this claim intends to link to once verified (#84). */
    nativeStoreId: entityIdSchema.optional(),
  })
  .strict()
  .refine((body) => !(body.domain !== undefined && body.connectionId !== undefined), {
    message: 'A claim has one subject: provide a domain or a connection, not both',
  });

/**
 * `POST /merchant-claims/:id/verify`.
 *
 * `token` for the methods whose proof IS the token; `channelKey` for the
 * WooCommerce plugin proof. Both are secrets in a request body and neither is
 * ever logged: the handlers pass them straight into the service, and the
 * service compares them in constant time and drops them.
 */
export const verifyMerchantClaimSchema = z
  .object({
    token: z.string().trim().min(1).max(200).optional(),
    channelKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** `POST /merchant-claims/:id/submit` — a business-document claim's evidence. */
export const submitMerchantClaimSchema = z
  .object({
    evidence: z.array(evidenceSchema).min(1).max(20),
  })
  .strict();

/**
 * `POST /merchant-claims/contest` — contest an incorrect existing claim.
 *
 * The reason has a real minimum length: a contest is read by a human who must
 * decide between two parties, and "wrong" is not something they can act on.
 */
export const contestMerchantClaimSchema = z
  .object({
    merchantId: entityIdSchema,
    reason: z.string().trim().min(20).max(4_000),
    evidence: z.array(evidenceSchema).max(20).optional(),
  })
  .strict();

/** `POST /internal/commerce-graph/claims/:id/decision`. */
export const merchantClaimDecisionSchema = z
  .object({
    decision: z.enum(['verify', 'reject']),
    reason: z.string().trim().min(10).max(4_000),
  })
  .strict();

/** `POST /internal/commerce-graph/claims/:id/revoke`. */
export const merchantClaimRevokeSchema = z
  .object({
    reason: z.enum(REVOKE_REASON_VALUES),
    note: z.string().trim().min(10).max(4_000),
  })
  .strict();

/** `GET /internal/commerce-graph/claims?state=` — the review queue filter. */
export const merchantClaimQueueQuerySchema = z
  .object({
    state: z.enum(['review_pending', 'disputed']).optional(),
  })
  .strict();
