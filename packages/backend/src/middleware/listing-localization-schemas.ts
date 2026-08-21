/**
 * Request schemas for a seller's own listing translations (#814).
 *
 * `.strict()`, this repository's standing decision everywhere a surface takes
 * input: an undeclared key is REFUSED rather than stripped, because a stripped
 * key is a caller believing it asked for something it did not get.
 *
 * Here that is doing more than tidiness. `status`, `provenance`,
 * `reviewedByOxyUserId` and `reviewedAt` are all real columns on the row this
 * body writes, and all four are SERVER decisions. Because the schema is strict
 * and declares none of them, a request carrying one is a 400 naming the key —
 * there is no branch anywhere that could weigh a client's opinion about whether
 * its own translation was reviewed. `checkoutSchema` refuses `amount` and
 * `paid` in the same way and for the same reason.
 */

import { z } from 'zod';

/**
 * One listing's text in one locale.
 *
 * `title` is required, trimmed and non-empty. The database says the same thing
 * twice — `listing_localizations_missing_text_check` ties `status = 'missing'`
 * to a NULL title, and `_text_not_blank_check` refuses whitespace — so this is
 * the honest 400 in front of two constraints rather than the only defence.
 *
 * `description` accepts `null` explicitly. Omitting the key and sending `null`
 * mean the same thing here (no localized description), which is safe precisely
 * because the write names every column: there is no "leave what was there"
 * reading for a caller to expect and not get.
 */
export const upsertListingLocalizationSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(20_000).nullable().optional(),
  })
  .strict();
