/**
 * Request schemas for `/internal/offer-freshness/*` (#68).
 *
 * Every one is `.strict()`, for the reason `tracePayment`'s is: it stops an
 * HTTP caller getting around a service signature. Here that matters twice over.
 *
 * 1. **A freshness policy names ONE source, and the source comes from the
 *    PATH.** There is deliberately no `sourceId` in any body and no way to
 *    address several sources at once — a bulk endpoint would be the closest
 *    thing to a global TTL this codebase could offer, and the whole domain is
 *    built so that no such value can exist.
 * 2. **The durations are bounded HERE as well as at the row**, so a reviewer
 *    publishing a policy gets a sentence naming the rule rather than a 23514.
 *    The bounds match `catalog_source_freshness_policies_durations_check`
 *    exactly, and the ordering rule (`warning < expiry`) is stated as a refine
 *    so the message can say which way round it goes.
 */

import { z } from 'zod';
import { CATALOG_REFRESH_MODES } from '@mercaria/shared-types';

/** Ninety days, matching `configureSourceSchema.freshnessTtlSeconds`. */
const MAX_FRESHNESS_SECONDS = 90 * 24 * 60 * 60;

export const publishFreshnessPolicySchema = z
  .object({
    expectedRefreshIntervalSeconds: z.number().int().min(60).max(MAX_FRESHNESS_SECONDS),
    warningAfterSeconds: z.number().int().min(60).max(MAX_FRESHNESS_SECONDS),
    expiryAfterSeconds: z.number().int().min(60).max(MAX_FRESHNESS_SECONDS),
    outageGraceSeconds: z.number().int().min(0).max(MAX_FRESHNESS_SECONDS),
    retireOnSourceUnavailable: z.boolean(),
    /**
     * EMPTY or absent means UNRESTRICTED — the `territories` semantics.
     *
     * It NARROWS what the adapter declares and can never widen it, so listing
     * `full_snapshot` for an adapter that cannot enumerate does nothing at all.
     * That is enforced in the scheduler rather than here, because this schema
     * cannot know which adapter a source will have when the policy is read.
     */
    permittedRefreshModes: z
      .array(z.enum(CATALOG_REFRESH_MODES as [string, ...string[]]))
      .max(CATALOG_REFRESH_MODES.length)
      .optional(),
    anomalyMinimumSampleSize: z.number().int().min(1).max(1_000_000),
    anomalyZeroPriceShareBps: z.number().int().min(1).max(10_000),
    anomalyPriceScaleFactor: z.number().int().min(2).max(10_000),
    anomalyDisappearanceShareBps: z.number().int().min(1).max(10_000),
    reviewNote: z.string().trim().max(2_000).optional(),
  })
  .strict()
  .refine((value) => value.warningAfterSeconds < value.expiryAfterSeconds, {
    message: 'The warning threshold must come BEFORE the expiry, or no offer ever reaches it',
    path: ['warningAfterSeconds'],
  });

/**
 * Ask for a refresh.
 *
 * `externalObjectKey` present ⇒ a TARGETED re-read of one object;
 * absent ⇒ a whole-source pass. `wantsSnapshot` is a preference and not an
 * instruction: the scheduler answers with the best mode the adapter actually
 * declares, because a snapshot nobody's API can perform would either lie about
 * its completeness or retire a catalogue on a search result.
 */
export const requestRefreshSchema = z
  .object({
    externalObjectKey: z.string().trim().min(1).max(400).optional(),
    wantsSnapshot: z.boolean().optional(),
  })
  .strict();
