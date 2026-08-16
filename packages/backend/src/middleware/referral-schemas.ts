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
  ALL_CURRENCY_CODES,
  MAX_MONEY_MINOR_UNITS,
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
 * `PUT /internal/referrals/programs/:programId/controls` — all three levers,
 * plus a mandatory reason.
 *
 * Every boolean is REQUIRED. A partial update would let an operator who typed
 * one field inherit whatever the last incident left down, and "which levers am
 * I actually setting" is not a question to answer by omission at 3am.
 * `payoutEnabled` is #145's and joined this schema rather than getting one of
 * its own, so an incident sets the whole switchboard in one attributable act.
 */
export const referralProgramControlsSchema = z
  .object({
    redirectEnabled: z.boolean(),
    attributionEnabled: z.boolean(),
    payoutEnabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

// ─── The earnings ledger's operator surface (#145) ───────────────────────────
//
// Every one of these is `.strict()` and none of them can carry an AMOUNT that
// decides what is owed. A batch's total is the sum of the rewards it claims and
// is computed server-side; a settlement takes no figure at all. The two places
// a number IS accepted are a withholding (which #145 field 6 requires and which
// settlement then refuses until #141/#146 decide where withheld money sits) and
// a recovery (which is money that ARRIVED, so an operator is recording a fact
// rather than deciding one).

/**
 * `POST /internal/referrals/partners/:partnerId/payout-batches` — open a batch
 * by hand.
 *
 * `finalPayout` is ADR 0005 D14's own exception to the minimum, stated as a
 * field rather than inferred: "on voluntary program exit or non-fraud
 * termination, the final vested balance is paid in the next batch regardless of
 * the minimum", and whether a payout is final is a decision only a person makes.
 */
export const referralPayoutBatchOpenSchema = z
  .object({
    programId: z.string().trim().min(1).max(200),
    currency: z.enum(tuple(ALL_CURRENCY_CODES)),
    finalPayout: z.boolean().optional(),
    withholdingMinor: z.number().int().min(0).max(MAX_MONEY_MINOR_UNITS).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** An approval, a cancellation or a freeze — an actor's decision plus why. */
export const referralOperatorReasonSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

/**
 * Terminating a partner (#146 increment 2, review rule 1's terminal state).
 *
 * The reason schema plus ONE flag, and it is deliberately its own schema rather
 * than `confirmedFraud` being optional on the shared one: suspension and
 * reinstatement have no fraud finding to record, and a field they silently
 * ignored would be one somebody eventually sends expecting it to do something.
 *
 * The flag sets `risk_state` and NOTHING else. It voids no reward, reverses no
 * accrual and reduces no balance — ADR 0005 D15's "a partner failing a gate is
 * skipped, not voided", and #144's `reverseReward` is the only thing that
 * touches a reward, reachable from no route here.
 */
export const referralPartnerTerminationSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    confirmedFraud: z.boolean().optional(),
  })
  .strict();

/**
 * `POST /internal/referrals/partners/:partnerId/recoveries` — ADR 0005 R7's
 * explicit, recorded operator recovery.
 *
 * `recoveryRef` is the operator's own handle for the money that arrived and is
 * the idempotency subject, so recording one twice converges and two genuinely
 * different recoveries are two rows.
 */
export const referralRecoverySchema = z
  .object({
    recoveryRef: z.string().trim().min(1).max(200),
    amountMinor: z.number().int().positive().max(MAX_MONEY_MINOR_UNITS),
    currency: z.enum(tuple(ALL_CURRENCY_CODES)),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** `POST /internal/referrals/earnings/discrepancies/:id/resolve`. */
export const referralDiscrepancyResolutionSchema = z
  .object({
    status: z.enum(['acknowledged', 'resolved']),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();
