/**
 * The request bodies #110's surface accepts, and nothing else.
 *
 * `.strict()` throughout — the `checkoutSchema` decision. A body able to carry
 * an order status, a refund amount, a payment provider, a scope or an actor id
 * is where one would eventually be trusted, so none of them can reach a
 * handler: an unknown key is a 400 rather than a silently stripped field.
 *
 * The absences are the enforcement and they mirror
 * `BUYER_REQUEST_FORBIDDEN_IDENTIFIERS`: there is no `email`, no `phone`, no
 * `orderNumber`, no `guestSessionId`, no `paymentMethod` and no `amount`
 * anywhere below. `buyer-request-isolation.test.ts` asserts it by parsing a
 * body carrying each one and requiring a refusal, which is the half a reading
 * of this file cannot give — a schema that had quietly gained a key would still
 * look tidy.
 */

import { z } from 'zod';
import {
  BUYER_REQUEST_NOTE_MAX_LENGTH,
  CANCELLATION_REQUEST_REASONS,
  RETURN_EVIDENCE_KINDS,
  RETURN_EVIDENCE_MAX_COUNT,
  RETURN_REQUEST_REASONS,
  RETURN_RESOLUTIONS,
  SUPPORT_MESSAGE_MAX_LENGTH,
} from '@mercaria/shared-types';

/** One line a buyer or a seller names. Quantities only — never a price. */
const lineSchema = z
  .object({
    variantId: z.string().trim().min(1).max(64),
    quantity: z.number().int().min(0).max(10_000),
  })
  .strict();

/** A declared piece of evidence: a bare Oxy file id and what it shows. */
const evidenceSchema = z
  .object({
    fileId: z.string().trim().min(1).max(128),
    kind: z.enum(RETURN_EVIDENCE_KINDS),
  })
  .strict();

const submitCancellation = z
  .object({
    reason: z.enum(CANCELLATION_REQUEST_REASONS),
    note: z.string().trim().max(BUYER_REQUEST_NOTE_MAX_LENGTH).optional(),
    lines: z.array(lineSchema).min(1).max(200).optional(),
  })
  .strict();

const submitReturn = z
  .object({
    reason: z.enum(RETURN_REQUEST_REASONS),
    resolution: z.enum(RETURN_RESOLUTIONS),
    note: z.string().trim().max(BUYER_REQUEST_NOTE_MAX_LENGTH).optional(),
    lines: z.array(lineSchema).min(1).max(200),
    evidence: z.array(evidenceSchema).max(RETURN_EVIDENCE_MAX_COUNT).optional(),
  })
  .strict();

const decision = z
  .object({
    decision: z.enum(['accept', 'reject']),
    note: z.string().trim().max(BUYER_REQUEST_NOTE_MAX_LENGTH).optional(),
    lines: z.array(lineSchema).max(200).optional(),
  })
  .strict();

const instructions = z
  .object({
    instructions: z.string().trim().min(3).max(BUYER_REQUEST_NOTE_MAX_LENGTH),
    /** ISO-8601. A deadline the seller chooses; Mercaria computes none. */
    shipBackDeadlineAt: z.string().datetime().optional(),
  })
  .strict();

const supportMessage = z
  .object({
    body: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
    /** Narrows the thread to one return. Verified to belong to the order. */
    returnRequestId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** Every body this surface accepts. */
export const buyerRequestBodySchemas = {
  submitCancellation,
  submitReturn,
  decision,
  instructions,
  supportMessage,
} as const;

/** What a seller sends to decide a request. */
export type DecisionBody = z.infer<typeof decision>;

/** What a seller sends to issue return instructions. */
export type InstructionsBody = z.infer<typeof instructions>;

/** What either side sends to write into a support thread. */
export type SupportMessageBody = z.infer<typeof supportMessage>;
