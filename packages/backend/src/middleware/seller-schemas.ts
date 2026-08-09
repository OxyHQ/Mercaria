/**
 * Request schemas for the PUBLIC seller surfaces (#92).
 *
 * `.strict()` is doing real work: no schema here carries a `visibility`,
 * `indexable`, `trustTier` or `includeRestricted` field, so no HTTP caller can
 * propose one. All four are DERIVED — from Oxy's privacy flags, from Oxy
 * Trust's verdict, from the listing count — and a request shape able to carry
 * one would be the second authority `seller-visibility.ts` exists without.
 *
 * There is no schema for WRITING a public seller profile, and there is nothing
 * to write: the seller's own preferences live behind `PATCH /seller/me`
 * (authenticated, the seller themself), display identity belongs to Oxy, and
 * every aggregate on the page is derived from rows this surface does not own.
 */

import { z } from 'zod';

/**
 * `GET /sellers/:oxyUserId/listings` — the keyset page.
 *
 * The cursor is opaque and bounded rather than parsed here: the service decodes
 * it and answers a malformed one with a 400, which keeps the cursor's FORMAT in
 * one place instead of split between a schema and a decoder that could drift.
 */
export const sellerListingsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(48).optional(),
    cursor: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
