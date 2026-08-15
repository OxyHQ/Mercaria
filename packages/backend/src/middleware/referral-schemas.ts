/**
 * Request schemas for the referral edge (#143).
 *
 * `.strict()` throughout, and every value tuple comes from
 * `@mercaria/shared-types`.
 *
 * What these shapes deliberately CANNOT carry is the point:
 *
 *  - **No destination, URL, path, host or origin.** The redirect composes its
 *    target from a configured allow-listed origin and a closed template
 *    (`services/referrals/destinations.ts`); a body able to carry a URL is
 *    where one would eventually be trusted (acceptance 2).
 *  - **No `partnerId`, `programId`, `campaignRef`, `contentKey` or
 *    `attributionId`.** Web rule 10 asks that client-side code cannot forge the
 *    winning partner, and the strongest form of that is a request that has no
 *    field to put one in. Every one of those is read from the ROW the signed
 *    token names.
 *  - **No `touchId`, `trafficClass` or `occurredAt`.** A client that could
 *    declare itself organic, or backdate a click into somebody else's window,
 *    would be deciding the two things attribution turns on. Both come from the
 *    server: the classifier, and the signed carrier.
 *  - **No email, phone, address, card, payment-method or device field.**
 *    ADR 0005 A2 — and here it is the absence of a parameter rather than a
 *    rejected one.
 *
 * `surface` and `consent` ARE accepted, and both are DESCRIPTIVE: the first is
 * recorded on the touch and decides nothing at all; the second decides exactly
 * one thing, whether a web carrier is written.
 */

import { z } from 'zod';
import {
  REFERRAL_CLIENT_SURFACES,
  REFERRAL_CODE_ENTRY_MOMENTS,
  REFERRAL_CONSENT_DECLARATIONS,
  type ReferralClientSurface,
  type ReferralCodeEntryMoment,
  type ReferralConsentDeclaration,
} from '@mercaria/shared-types';

/** A readonly array as a non-empty tuple, which `z.enum` requires. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

const surface = z
  .enum(tuple(REFERRAL_CLIENT_SURFACES as readonly ReferralClientSurface[]))
  .optional();

const consent = z
  .enum(tuple(REFERRAL_CONSENT_DECLARATIONS as readonly ReferralConsentDeclaration[]))
  .optional();

/**
 * `POST /referrals/bind` — redeem a carried click for the resolved actor.
 *
 * The carrier itself is NOT in the body: it arrives on the cookie or the
 * `X-Mercaria-Referral-State` request header, so a page's JavaScript cannot
 * read it (the cookie is `HttpOnly`) and therefore cannot replay somebody
 * else's into its own session.
 */
export const referralBindSchema = z.object({ surface, consent }).strict();

/**
 * `POST /referrals/code-entry` — the buyer typed a code.
 *
 * The code is bounded hard: instrument codes are short human-typed strings, and
 * an unbounded field here is a way to make the server hash and index-scan
 * megabytes per request. Case and surrounding space are normalised by
 * `findCodeByCode` against the stored `lower(code)` unique — the DISPLAYED
 * spelling is never changed (#143 code rule 2).
 */
export const referralCodeEntrySchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    moment: z.enum(tuple(REFERRAL_CODE_ENTRY_MOMENTS as readonly ReferralCodeEntryMoment[])),
    surface,
    consent,
  })
  .strict();

/**
 * `POST /referrals/merchant-binding` — bind a carried click to a merchant
 * candidate the CALLER already holds a claim on.
 *
 * `merchantId` is the only field, and it is checked against the caller's own
 * `merchant_claims` rows before anything is written: a body that could name any
 * merchant would let anybody attach a partner to somebody else's shop.
 */
export const referralMerchantBindingSchema = z
  .object({
    merchantId: z.string().trim().min(1).max(64),
    surface,
    consent,
  })
  .strict();

/**
 * `PUT /internal/referrals/programs/:programId/controls` — both levers, plus a
 * mandatory reason.
 *
 * Both booleans are REQUIRED. A partial update would let an operator who typed
 * one field inherit whatever the last incident left down, and "which levers am
 * I actually setting" is not a question to answer by omission at 3am.
 */
export const referralProgramControlsSchema = z
  .object({
    redirectEnabled: z.boolean(),
    attributionEnabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
