/**
 * Request schemas for the referral partner DASHBOARD and the operator's program
 * management (#147).
 *
 * `.strict()` throughout, and every value tuple comes from
 * `@mercaria/shared-types`.
 *
 * ## What the partner-facing shapes deliberately CANNOT carry
 *
 *  - **No `partnerId`, `ownerType` or `ownerId`.** #146's rule, unchanged: the
 *    owner is established by the MOUNT, and a body able to name one is a body
 *    able to act for somebody else. It is the whole of how "a partner may see
 *    their own numbers and nobody else's" is enforced, and no amount of
 *    checking afterwards is as strong as there being no field.
 *  - **No `destinationUrl`, `url`, `redirect` or `href` on the instrument
 *    schemas.** #143's redirect takes no URL from a request and neither does
 *    this: an instrument names a destination TYPE and the destination's own id,
 *    and `resolveReferralDestination` composes the URL from a configured
 *    origin. An arbitrary-redirect injector is unrepresentable rather than
 *    filtered.
 *  - **No amount, count, state or currency anywhere.** #147 acceptance 2 —
 *    dashboard totals cannot be forged by a client — held by there being no
 *    field a forged figure could arrive in.
 *  - **No `disclosureText`.** The wording is Mercaria's published term
 *    (`disclosure-text.ts`), not something a partner submits; a partner-supplied
 *    disclosure is a disclosure nobody reviewed.
 *
 * ## And what the operator shapes cannot carry
 *
 *  - **No `status`, `publishedAt`, `approvedByOxyUserId` or `version`.** A
 *    program's status moves through the lifecycle service, whose CAS is what
 *    makes "no operator can edit an active rule version in place" (#147
 *    acceptance 4) true. A body carrying `status: 'active'` would be a second
 *    way to publish, and the one that skips the checks.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  REFERRAL_CHANNELS,
  REFERRAL_COMMERCIAL_MODES,
  REFERRAL_CONVERSION_TYPES,
  REFERRAL_DESTINATION_TYPES,
  REFERRAL_PARTNER_OWNER_TYPES,
  REFERRAL_PERFORMANCE_DIMENSIONS,
  REFERRAL_PROGRAM_FAMILIES,
  REFERRAL_SUBJECT_KINDS,
  type CurrencyCode,
  type ReferralChannel,
  type ReferralCommercialMode,
  type ReferralConversionType,
  type ReferralDestinationType,
  type ReferralPartnerOwnerType,
  type ReferralPerformanceDimension,
  type ReferralProgramFamily,
  type ReferralSubjectKind,
} from '@mercaria/shared-types';
import { MAX_PERFORMANCE_WINDOW_DAYS } from '../services/referrals/dashboard/performance.service.js';

/** A readonly array as a non-empty tuple, which `z.enum` requires. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

/** `YYYY-MM-DD`, and a real date rather than a shape that looks like one. */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a YYYY-MM-DD date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Not a calendar date');

/**
 * The performance query.
 *
 * ONE dimension and no array, which is where "no cross-tabs" is enforced: a
 * market × date cell at count one is a person even when both margins clear the
 * floor, so the request cannot express the question.
 */
export const referralPerformanceQuerySchema = z
  .object({
    dimension: z.enum(tuple(REFERRAL_PERFORMANCE_DIMENSIONS)),
    from: isoDay,
    through: isoDay,
  })
  .strict()
  .superRefine((value, ctx) => {
    const from = Date.parse(`${value.from}T00:00:00.000Z`);
    const through = Date.parse(`${value.through}T00:00:00.000Z`);
    if (through < from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['through'],
        message: 'The window ends before it starts',
      });
      return;
    }
    const days = Math.round((through - from) / 86_400_000) + 1;
    if (days > MAX_PERFORMANCE_WINDOW_DAYS) {
      // REFUSED rather than truncated: a truncated window reports figures for a
      // period the caller did not ask about, and a partner reconciling their
      // own earnings against it would find numbers that do not add up with
      // nothing saying why.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['through'],
        message: `A performance window may cover at most ${MAX_PERFORMANCE_WINDOW_DAYS} days`,
      });
    }
  });

export type ReferralPerformanceQueryBody = z.infer<typeof referralPerformanceQuerySchema>;

/**
 * Issue a code.
 *
 * `requestedCode` is a REQUEST — ADR 0005 D3 makes codes globally unique
 * case-insensitively, so the service may mint a different one, and a schema
 * calling it `code` would promise what the uniqueness policy cannot.
 */
export const referralIssueCodeSchema = z
  .object({
    programId: z.string().min(1).max(200),
    requestedCode: z.string().min(3).max(64).optional(),
    destinationType: z.enum(tuple(REFERRAL_DESTINATION_TYPES)).optional(),
    /** The destination's own id — a listing, a collection, a store. Never a URL. */
    destinationRef: z.string().min(1).max(200).optional(),
    campaignRef: z.string().min(1).max(120).optional(),
    contentKey: z.string().min(1).max(120).optional(),
    market: z
      .string()
      .regex(/^[A-Z]{2}$/u, 'Expected an upper-case ISO-3166-1 alpha-2 market')
      .optional(),
    locale: z.string().min(2).max(20).optional(),
  })
  .strict();

export type ReferralIssueCodeBody = z.infer<typeof referralIssueCodeSchema>;

/** Issue a link under a code the caller already owns. */
export const referralIssueLinkSchema = z
  .object({
    codeId: z.string().min(1).max(200),
    destinationType: z.enum(tuple(REFERRAL_DESTINATION_TYPES)).optional(),
    destinationRef: z.string().min(1).max(200).optional(),
    campaignRef: z.string().min(1).max(120).optional(),
    contentKey: z.string().min(1).max(120).optional(),
  })
  .strict();

export type ReferralIssueLinkBody = z.infer<typeof referralIssueLinkSchema>;

/**
 * Retire a code or revoke a link.
 *
 * A REASON is mandatory, on a partner's own instrument, because #142's
 * transition records one on every event and the alternative is a trail of
 * retirements with no explanation for the operator who later asks why a
 * partner's attribution stopped.
 */
export const referralInstrumentRetireSchema = z
  .object({ reason: z.string().min(3).max(500) })
  .strict();

export type ReferralInstrumentRetireBody = z.infer<typeof referralInstrumentRetireSchema>;

// ─── Operator: program management ────────────────────────────────────────────

const marketList = z
  .array(z.string().regex(/^[A-Z]{2}$/u, 'Expected an upper-case ISO-3166-1 alpha-2 market'))
  .max(250);

/**
 * A program DRAFT.
 *
 * Every scope array defaults to empty, which the schema documents as
 * UNRESTRICTED for the four scope arrays and as NOTHING for the two eligibility
 * arrays — the `supplier_agreements` versus `commerce_relationships` split #121
 * put in one file. The two eligibility arrays are therefore `min(1)`: a program
 * naming nobody who may enroll and nothing that may be referred is not a
 * program, which is also the CHECK the table carries.
 */
export const referralProgramDraftSchema = z
  .object({
    // No `programId`: `createProgramDraft` mints the stable identity itself
    // (a uuid v7), because a program id is what every version of a program
    // SHARES and a caller-supplied one is a caller-supplied collision with
    // somebody else's version chain. A program is named by `name`.
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    publicTermsSummary: z.string().min(1).max(4000),
    family: z.enum(tuple(REFERRAL_PROGRAM_FAMILIES)),
    eligiblePartnerTypes: z.array(z.enum(tuple(REFERRAL_PARTNER_OWNER_TYPES))).min(1),
    eligibleSubjectKinds: z.array(z.enum(tuple(REFERRAL_SUBJECT_KINDS))).min(1),
    markets: marketList.optional(),
    currencies: z.array(z.enum(tuple(ALL_CURRENCY_CODES))).max(50).optional(),
    channels: z.array(z.enum(tuple(REFERRAL_CHANNELS))).max(10).optional(),
    commercialModes: z.array(z.enum(tuple(REFERRAL_COMMERCIAL_MODES))).max(10).optional(),
    attributionWindowDays: z.number().int().positive().max(3650),
    activationWindowDays: z.number().int().positive().max(3650).optional(),
    qualifyingEventPolicy: z.enum(tuple(REFERRAL_CONVERSION_TYPES)),
    commissionRuleRef: z.string().min(1).max(200),
    holdDays: z.number().int().min(0).max(3650),
    capPolicyRef: z.string().min(1).max(200).optional(),
    payoutPolicyRef: z.string().min(1).max(200),
    termsVersion: z.string().min(1).max(120),
    disclosureVersion: z.string().min(1).max(120),
    featureFlagKey: z.string().min(1).max(120).optional(),
    cohortKeys: z.array(z.string().min(1).max(120)).max(50).optional(),
    effectiveStartAt: z.string().datetime().optional(),
    effectiveEndAt: z.string().datetime().optional(),
  })
  .strict();

export type ReferralProgramDraftBody = z.infer<typeof referralProgramDraftSchema>;

/**
 * An EDIT to a draft.
 *
 * Every field optional, and `programId` is absent here for the reason it is
 * absent from the draft schema: a program's identity is what every version of
 * it shares, so an edit that could move it would move a draft into another
 * program's version chain.
 */
export const referralProgramDraftPatchSchema = referralProgramDraftSchema.partial().strict();

export type ReferralProgramDraftPatchBody = z.infer<typeof referralProgramDraftPatchSchema>;

/** Publishing takes nothing but the approver, which comes off the credential. */
export const referralProgramPublishSchema = z.object({}).strict();

/** Pausing, resuming, ending and retiring each record a reason. */
export const referralProgramLifecycleSchema = z
  .object({ reason: z.string().min(3).max(500) })
  .strict();

export type ReferralProgramLifecycleBody = z.infer<typeof referralProgramLifecycleSchema>;

/** The typed re-exports a controller needs, so it imports one module. */
export type {
  CurrencyCode,
  ReferralChannel,
  ReferralCommercialMode,
  ReferralConversionType,
  ReferralDestinationType,
  ReferralPartnerOwnerType,
  ReferralPerformanceDimension,
  ReferralProgramFamily,
  ReferralSubjectKind,
};
