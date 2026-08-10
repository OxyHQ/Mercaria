/**
 * Request schemas for the "Sell yours" flow (#91).
 *
 * Its own module rather than more of `schemas.ts`, for the reason
 * `payments-schemas.ts` is its own: the proof-field refusal below has to run
 * BEFORE the `.strict()` parse, and mixing a pre-parse gate into the shared
 * schema file would put it out of reach of every other endpoint that legitimately
 * strips unknown keys.
 *
 * Every schema is `.strict()`. A body that carried a field this flow does not
 * know about is a client asserting something nobody agreed to store, and
 * silently dropping it is how a serial number ends up in a log line rather than
 * in a refusal.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_DETAIL_KINDS,
  CONDITION_DETAIL_SEVERITIES,
  CONDITION_PHOTO_PROVENANCES,
  ITEM_CONDITION_KEYS,
  MAX_MONEY_MINOR_UNITS,
  SELLER_DRAFT_ENTRY_PATHS,
  SELLER_DRAFT_STEPS,
  SELLER_PICKUP_AVAILABILITIES,
} from '@mercaria/shared-types';

/** A shared tuple, narrowed to the non-empty form `z.enum` requires. */
function enumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('A z.enum of no values rejects every request.');
  }
  return [first, ...rest];
}

const currency = z.enum(enumValues(ALL_CURRENCY_CODES));

/**
 * A money amount, bounded.
 *
 * `z.number().int()` alone accepts `1e300`; the ceiling is what makes the check
 * real, and a draft is where a seller's typo first reaches a money column.
 */
const money = z
  .object({
    amount: z.number().int().min(0).max(MAX_MONEY_MINOR_UNITS),
    currency,
  })
  .strict();

export const startSellerDraftSchema = z
  .object({
    /**
     * The client's own idempotency key for the FLOW.
     *
     * A retried "start selling" tap resumes rather than opening a second draft,
     * which is what makes the resume list show one entry instead of a column of
     * abandoned attempts after a flaky connection.
     */
    clientDraftKey: z.string().min(8).max(128),
    entryPath: z.enum(enumValues(SELLER_DRAFT_ENTRY_PATHS)),
    canonicalProductId: z.string().min(1).optional(),
    canonicalVariantId: z.string().min(1).optional(),
  })
  .strict();

const conditionDetail = z
  .object({
    kind: z.enum(enumValues(CONDITION_DETAIL_KINDS)),
    severity: z.enum(enumValues(CONDITION_DETAIL_SEVERITIES)).optional(),
    note: z.string().max(2_000).optional(),
  })
  .strict();

const draftImage = z
  .object({
    /** A bare Oxy media file id — never a URL, and never a canonical asset. */
    fileId: z.string().min(1),
    alt: z.string().max(500).optional(),
    /**
     * #90's provenance vocabulary, which has only seller-owned members.
     *
     * There is no value here meaning "the catalogue's picture", so a client
     * cannot record one as evidence — and the file id of one is refused
     * separately, by a database trigger and by a read that names it.
     */
    provenance: z.enum(enumValues(CONDITION_PHOTO_PROVENANCES)),
    showsDefect: z.boolean().optional(),
    /** Which disclosure IN THIS REQUEST the photograph evidences. */
    detailIndex: z.number().int().min(0).optional(),
  })
  .strict();

export const patchSellerDraftSchema = z
  .object({
    currentStep: z.enum(enumValues(SELLER_DRAFT_STEPS)).optional(),
    completedSteps: z.array(z.enum(enumValues(SELLER_DRAFT_STEPS))).max(12).optional(),
    /** `null` REMOVES the match. An explicit null is the documented remedy. */
    canonicalProductId: z.string().min(1).nullable().optional(),
    canonicalVariantId: z.string().min(1).nullable().optional(),
    matchConfirmed: z.boolean().optional(),
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20_000).optional(),
    category: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    conditionKey: z.enum(enumValues(ITEM_CONDITION_KEYS)).optional(),
    conditionDetails: z.array(conditionDetail).max(50).optional(),
    /**
     * Literally `true` is consent; anything else clears it.
     *
     * #90's rule that a missing field is not an acknowledgement, carried into
     * the flow that collects it.
     */
    defectsAcknowledged: z.boolean().optional(),
    includedAccessories: z.array(z.string().min(1).max(120)).max(30).optional(),
    images: z.array(draftImage).max(20).optional(),
    quantity: z.number().int().min(1).max(1_000).optional(),
    price: money.optional(),
    pickup: z.enum(enumValues(SELLER_PICKUP_AVAILABILITIES)).optional(),
    /**
     * The coarse public location, or `null` to withdraw the opt-in.
     *
     * What is stored is ROUNDED at the write boundary — see
     * `SELLER_LOCATION_PRECISION_DECIMALS`. The schema accepts full precision
     * because a device reports full precision; refusing it would make clients
     * round, and a client-side privacy guarantee is not one.
     */
    location: z
      .object({
        longitude: z.number().min(-180).max(180),
        latitude: z.number().min(-90).max(90),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const sellerDraftPreviewQuerySchema = z
  .object({
    /** The currency guidance is composed in. Display only; never a price. */
    currency: currency.optional(),
    /** ISO 3166-1 alpha-2, the market guidance is about. */
    market: z.string().length(2).optional(),
  })
  .strict();

export const sellerMatchCandidateQuerySchema = z
  .object({
    /** A barcode or other identifier, exactly as scanned. */
    identifier: z.string().min(1).max(120).optional(),
    /** Free text, for the search entry path. */
    q: z.string().min(2).max(200).optional(),
  })
  .strict();
