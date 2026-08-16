/**
 * Request schemas for the referral PARTNER surface (#146 increment 2).
 *
 * `.strict()` throughout, and every value tuple comes from
 * `@mercaria/shared-types`, so a member added there is accepted here and a
 * value nobody published is refused by the schema rather than by a CHECK three
 * layers down.
 *
 * ## What these shapes deliberately CANNOT carry
 *
 *  - **No `partnerId`, `ownerType` or `ownerId`.** Every one of them is
 *    established by the MOUNT — the store half from `req.store` after
 *    `requireStorePermission('store:manage')`, the self half from
 *    `getRequiredOxyUserId(req)`. A body able to name an owner is a body able
 *    to act for somebody else, and no amount of checking afterwards is as
 *    strong as there being no field.
 *  - **No `state`, `approved`, `readiness` or `payoutBeneficiaryRef`.** A
 *    client cannot declare its own standing or its own payout readiness; those
 *    come from a review and from #146's readiness machinery.
 *  - **No tax identifier, VAT number or bank detail.**
 *    `REFERRAL_TAX_FORBIDDEN_FIELDS` names the prohibition and `.strict()` is
 *    what makes sending one a refusal rather than a silently stripped key.
 *  - **No `accepted: boolean` on the terms schema.** #146 terms rule 9 says do
 *    not preselect acceptance, and a boolean that could arrive `true` by
 *    default is exactly the shape that would. The schema takes a VERSION, so
 *    sending nothing accepts nothing.
 *  - **No `enrollmentMode` an applicant may not name.** The field exists — an
 *    applicant chooses between the self-serve modes — but the service refuses
 *    every `selfServe: false` member BY NAME, so the schema deliberately does
 *    not narrow the enum: a refusal that says "staff_test is created by an
 *    operator" is a better answer than "unrecognized value", and it is the
 *    sentence somebody deletes if they ever make one self-serve.
 */

import { z } from 'zod';
import {
  REFERRAL_APPLICATION_DECISIONS,
  REFERRAL_APPLICATION_REJECTION_CODES,
  REFERRAL_AUDIENCE_BANDS,
  REFERRAL_ENROLLMENT_MODES,
  REFERRAL_PARTNER_OWNER_TYPES,
  REFERRAL_PARTNER_STATES,
  REFERRAL_PROMOTION_METHODS,
  REFERRAL_TERMS_SCOPES,
  type ReferralApplicationDecision,
  type ReferralApplicationRejectionCode,
  type ReferralAudienceBand,
  type ReferralEnrollmentMode,
  type ReferralPartnerOwnerType,
  type ReferralPartnerState,
  type ReferralPromotionMethod,
  type ReferralTermsScope,
} from '@mercaria/shared-types';

/** A readonly array as a non-empty tuple, which `z.enum` requires. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

/**
 * The application answers, all optional, because a DRAFT is allowed to be
 * incomplete.
 *
 * What makes a SUBMISSION complete is `missingSubmissionRequirements` plus
 * `referral_partner_applications_consent_check`, not this schema — a schema
 * that demanded everything would make saving a half-finished form impossible,
 * which is the whole point of having a draft state.
 */
export const referralApplicationSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    enrollmentMode: z.enum(tuple(REFERRAL_ENROLLMENT_MODES as readonly ReferralEnrollmentMode[])).optional(),
    programId: z.string().trim().min(1).max(200).optional(),
    promotionMethods: z
      .array(z.enum(tuple(REFERRAL_PROMOTION_METHODS as readonly ReferralPromotionMethod[])))
      .max(8)
      .optional(),
    // Bounded here AND by the CHECK. The count is refused before a 2 000-URL
    // array is normalized one element at a time, which is the DoS the bound is
    // actually for; the CHECK is what holds against a caller that is not this
    // route.
    promotionUrls: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    audienceBand: z.enum(tuple(REFERRAL_AUDIENCE_BANDS as readonly ReferralAudienceBand[])).optional(),
    markets: z.array(z.string().trim().min(2).max(2)).max(50).optional(),
    prohibitedMethodsAcknowledged: z.boolean().optional(),
    hasRelatedParty: z.boolean().optional(),
    relatedPartyDisclosure: z.string().trim().min(1).max(2_000).optional(),
    reviewConsent: z.boolean().optional(),
    communicationConsent: z.boolean().optional(),
  })
  .strict();

export type ReferralApplicationBody = z.infer<typeof referralApplicationSchema>;

/**
 * Accepting terms.
 *
 * The version is REQUIRED and there is no boolean beside it: this is #146 terms
 * rule 9 as a shape. `locale` is required too — rule 3 asks that it be stored,
 * and a defaulted one would record that somebody accepted in a language nobody
 * chose.
 */
export const referralTermsAcceptanceSchema = z
  .object({
    scope: z.enum(tuple(REFERRAL_TERMS_SCOPES as readonly ReferralTermsScope[])),
    termsVersion: z.string().trim().min(1).max(100),
    programId: z.string().trim().min(1).max(200).optional(),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      // The same shape the column's CHECK states. Refusing a whole
      // `Accept-Language` header here gives the client a usable message; the
      // CHECK is what holds against a caller that is not this route.
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Not a language tag'),
  })
  .strict();

export type ReferralTermsAcceptanceBody = z.infer<typeof referralTermsAcceptanceSchema>;

/** Marketing consent — its own request, because it is its own fact. */
export const referralMarketingConsentSchema = z.object({ granted: z.boolean() }).strict();

export type ReferralMarketingConsentBody = z.infer<typeof referralMarketingConsentSchema>;

/**
 * The tax questionnaire (ADR 0005 D15 gate 2).
 *
 * `questionnaireVersion` is NOT a field, deliberately: `declareTaxProfile`
 * stamps whatever Mercaria is currently asking, because a caller able to name
 * one could satisfy the gate by citing a version it prefers, and a client
 * shipped before a bump would answer the old questions forever while reading
 * as ready.
 *
 * No tax identifier, VAT number, TIN or national identifier is accepted, and
 * `.strict()` makes sending one a refusal. Only residency and VAT STATUS —
 * a status is what invoicing needs and the NUMBER is what Mercaria has every
 * reason not to hold.
 */
export const referralTaxProfileSchema = z
  .object({
    participantType: z.enum(['individual', 'business']),
    residencyCountry: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/, 'Not an ISO 3166-1 alpha-2 country code'),
    vatStatus: z.enum(['not_registered', 'registered', 'exempt']),
  })
  .strict();

export type ReferralTaxProfileBody = z.infer<typeof referralTaxProfileSchema>;

/** Opening an appeal against a suspension or a termination. */
export const referralAppealSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000) })
  .strict();

export type ReferralAppealBody = z.infer<typeof referralAppealSchema>;

// ─── Operator ───────────────────────────────────────────────────────────────

/**
 * One review decision.
 *
 * `partnerMessage` and `reviewerNote` are SEPARATE fields with separate bounds
 * because they have separate audiences — #146 review rule 9. The service
 * refuses a refusal with no `rejectionCode` and an approval that carries one,
 * so neither can be omitted or smuggled in by a caller filling the wrong field.
 */
export const referralApplicationDecisionSchema = z
  .object({
    decision: z.enum(tuple(REFERRAL_APPLICATION_DECISIONS as readonly ReferralApplicationDecision[])),
    rejectionCode: z
      .enum(tuple(REFERRAL_APPLICATION_REJECTION_CODES as readonly ReferralApplicationRejectionCode[]))
      .optional(),
    partnerMessage: z.string().trim().min(1).max(500).optional(),
    reviewerNote: z.string().trim().min(1).max(2_000).optional(),
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();

export type ReferralApplicationDecisionBody = z.infer<typeof referralApplicationDecisionSchema>;

/** Creating a partner in an operator-only enrollment mode. */
export const referralOperatorPartnerSchema = z
  .object({
    ownerType: z.enum(tuple(REFERRAL_PARTNER_OWNER_TYPES as readonly ReferralPartnerOwnerType[])),
    ownerId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    enrollmentMode: z.enum(tuple(REFERRAL_ENROLLMENT_MODES as readonly ReferralEnrollmentMode[])),
    reason: z.string().trim().min(1).max(2_000),
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();

export type ReferralOperatorPartnerBody = z.infer<typeof referralOperatorPartnerSchema>;

/** Resolving an appeal. */
export const referralAppealResolutionSchema = z
  .object({
    accepted: z.boolean(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ReferralAppealResolutionBody = z.infer<typeof referralAppealResolutionSchema>;

/** The review inbox filter. States only — there is no free-text search. */
export const referralPartnerInboxQuerySchema = z
  .object({
    state: z
      .union([
        z.enum(tuple(REFERRAL_PARTNER_STATES as readonly ReferralPartnerState[])),
        z.array(z.enum(tuple(REFERRAL_PARTNER_STATES as readonly ReferralPartnerState[]))),
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type ReferralPartnerInboxQuery = z.infer<typeof referralPartnerInboxQuerySchema>;
