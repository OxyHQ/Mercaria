/**
 * Request schemas for the bounded referral pilot's operator surface (#149).
 *
 * `.strict()` throughout, and every value tuple comes from
 * `@mercaria/shared-types` — so a cohort naming an excluded pilot subject, a
 * threshold on a metric nobody defined or a review with a decision outside the
 * closed five is refused at the door rather than stored.
 *
 * What these shapes deliberately CANNOT carry:
 *
 *  - **No `programId` on anything but the draft.** A cohort is looked up by the
 *    PROGRAMME it bounds, and every other route names a cohort ROW — so there
 *    is no shape in which one request could move bounds from one programme to
 *    another.
 *  - **No `status`, `publishedAt` or `publishedByOxyUserId`.** Publishing is a
 *    separate act with its own route and its own refusals; a draft that could
 *    arrive `active` would walk around all three of them.
 *  - **No `reviewedByOxyUserId` and no `addedByOxyUserId`.** Both come off the
 *    credential. An operator who could type somebody else's id into a review is
 *    an operator whose dated decision names the wrong person.
 *  - **No buyer, order, email, phone or amount-paid field.** A pilot bound is a
 *    decision about a programme; a shape able to name a purchase would be one a
 *    bound could be written against.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  MAX_MONEY_MINOR_UNITS,
  REFERRAL_PILOT_REVIEW_DECISIONS,
  REFERRAL_PILOT_STOP_METRICS,
  REFERRAL_PILOT_STOP_SCOPES,
  REFERRAL_PILOT_SUBJECTS,
  REFERRAL_PILOT_THRESHOLD_UNITS,
} from '@mercaria/shared-types';

const enumOf = (values: readonly string[]) => z.enum(values as unknown as [string, ...string[]]);

/** A bounded free-text field. Read by a person, never matched on. */
const prose = z.string().trim().min(1).max(2_000);

/** A non-negative integer bounded by the money ceiling every amount obeys. */
const boundedAmount = z.number().int().min(0).max(MAX_MONEY_MINOR_UNITS);

/** POST /internal/referrals/pilot/cohorts — draft a version. */
export const referralPilotCohortSchema = z
  .object({
    /** The operator's own label for this pilot; its version chain shares it. */
    cohortKey: z.string().trim().min(1).max(120),
    version: z.number().int().min(1),
    subject: enumOf(REFERRAL_PILOT_SUBJECTS),
    legalEntity: z.string().trim().min(1).max(200),
    programOwnerOxyUserId: z.string().trim().min(1).max(200),
    programId: z.string().trim().min(1).max(200),
    programVersionId: z.string().trim().min(1).max(200),
    // ISO-3166-1 alpha-2, non-empty, and the same shape the row CHECK enforces.
    markets: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
    payoutCurrency: enumOf(ALL_CURRENCY_CODES),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    maxAttributionsPerPartner: z.number().int().min(1).max(1_000_000),
    maxAttributionsTotal: z.number().int().min(1).max(10_000_000),
    rewardBudgetMinor: boundedAmount.refine((value) => value > 0, {
      message: 'A pilot with no reward budget could pay nobody.',
    }),
    manualReviewRequired: z.boolean().optional(),
    supersedesCohortId: z.string().trim().min(1).max(200).optional(),
    rationale: prose,
  })
  .strict();

/** POST .../cohorts/:cohortId/partners — allow-list one partner. */
export const referralPilotPartnerSchema = z
  .object({
    partnerId: z.string().trim().min(1).max(200),
    note: prose,
  })
  .strict();

/** POST .../cohorts/:cohortId/thresholds — publish one stop condition. */
export const referralPilotThresholdSchema = z
  .object({
    metric: enumOf(REFERRAL_PILOT_STOP_METRICS),
    unit: enumOf(REFERRAL_PILOT_THRESHOLD_UNITS),
    // Zero is legitimate and load-bearing: a breach is `observed > threshold`,
    // so a one-occurrence stop is written with a threshold of ZERO.
    thresholdValue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    windowHours: z.number().int().min(0).max(8_760),
    scope: enumOf(REFERRAL_PILOT_STOP_SCOPES),
  })
  .strict();

/** POST .../cohorts/:cohortId/review — the dated expansion decision. */
export const referralPilotReviewSchema = z
  .object({
    decision: enumOf(REFERRAL_PILOT_REVIEW_DECISIONS),
    rationale: prose,
    /** Whether this review ENDS the version, as opposed to recording a finding. */
    closes: z.boolean().optional(),
  })
  .strict();

/** POST .../cohorts/:cohortId/threshold-evaluation — supply measurements. */
export const referralPilotMeasurementsSchema = z
  .object({
    measurements: z
      .array(
        z
          .object({
            metric: enumOf(REFERRAL_PILOT_STOP_METRICS),
            unit: enumOf(REFERRAL_PILOT_THRESHOLD_UNITS),
            value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            scopeRef: z.string().trim().max(200).optional(),
            // The vacuity floor arrives WITH the value: a measurement that does
            // not say how many observations it rests on is one the evaluator
            // cannot refuse as an empty sample.
            sampleSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

/** POST .../cohorts/:cohortId/stops — an operator raises one by hand. */
export const referralPilotStopSchema = z
  .object({
    metric: enumOf(REFERRAL_PILOT_STOP_METRICS),
    scope: enumOf(REFERRAL_PILOT_STOP_SCOPES),
    scopeRef: z.string().trim().max(200).optional(),
    observedValue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    thresholdValue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    detail: prose,
  })
  .strict();

/** POST .../stops/:stopId/lift — attributable, dated and explained. */
export const referralPilotLiftSchema = z.object({ reason: prose }).strict();
