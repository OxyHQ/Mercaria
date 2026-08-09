/**
 * Request schemas for the marketplace fee surface (#88).
 *
 * Its own file beside `payments-schemas.ts` for the same reason that one exists:
 * a self-contained surface whose validation reads better beside the issue that
 * decides it.
 *
 * Every schema here is `.strict()`. The merchant accept body must not be able to
 * smuggle a field into an audit record, and the operator create body reaches
 * code that decides COMMISSION — a field the schema does not declare (a buyer
 * scope, a claim flag, a payment-method discriminator) must be REFUSED, never
 * stripped. That refusal is also half of "#88's invalid scopes are
 * unrepresentable": `feeScheduleCreateSchema` below enumerates the COMPLETE set
 * of scope fields a schedule can carry, and it is two long.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  assertSafeMoneyAmount,
  FEE_REFUND_POLICIES,
  FEE_TAX_TREATMENTS,
  type CurrencyCode,
  type FeeRefundPolicy,
  type FeeTaxTreatment,
} from '@mercaria/shared-types';

const CURRENCY_CODE_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const FEE_TAX_TREATMENT_VALUES = FEE_TAX_TREATMENTS as readonly [
  FeeTaxTreatment,
  ...FeeTaxTreatment[],
];
const FEE_REFUND_POLICY_VALUES = FEE_REFUND_POLICIES as readonly [
  FeeRefundPolicy,
  ...FeeRefundPolicy[],
];

/**
 * A minor-unit amount: a non-negative integer WITHIN the representable ceiling.
 * `z.number().int()` alone accepts `1e300` — the `assertSafeMoneyAmount` refine
 * is what makes the bound real (the same rule every money boundary follows).
 */
const minorUnits = z
  .number()
  .int()
  .nonnegative()
  .superRefine((value, ctx) => {
    try {
      assertSafeMoneyAmount(value, 'fees.request');
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * Accepting the current schedule's terms. The body ECHOES what the owner saw —
 * key, version and terms version — so an acceptance recorded against a stale
 * screen (the schedule moved while the dialog was open) is refused with the
 * current one rather than silently recorded against the wrong version.
 */
export const acceptFeeScheduleSchema = z
  .object({
    scheduleKey: z.string().trim().min(1),
    version: z.number().int().min(1),
    termsVersion: z.string().trim().min(1),
  })
  .strict();

/** The validated body of a terms acceptance. */
export type AcceptFeeScheduleBody = z.infer<typeof acceptFeeScheduleSchema>;

/** Previewing the fee/net on a hypothetical discounted item subtotal. */
export const feePreviewSchema = z
  .object({
    basisAmount: minorUnits,
    currency: z.enum(CURRENCY_CODE_VALUES),
  })
  .strict();

/** The validated body of a fee preview. */
export type FeePreviewBody = z.infer<typeof feePreviewSchema>;

/**
 * Drafting a new schedule version (operator surface).
 *
 * The scope fields are `eligibleSellerType` and `eligibleCurrency`, and that is
 * the COMPLETE set — buyer authentication state, guest origin, claim status,
 * payment-method identity and contact data have no field here and no column in
 * `fee_schedules`, so a schedule that priced by any of them cannot be written
 * down. The database CHECKs re-verify every cross-field rule below; the schema
 * repeats them only so an operator gets a 400 naming the field instead of a
 * constraint name.
 */
export const feeScheduleCreateSchema = z
  .object({
    scheduleKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'scheduleKey must be a lowercase slug'),
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(200),
    merchantSummary: z.string().trim().min(1).max(2000),
    effectiveStart: z.string().datetime(),
    effectiveEnd: z.string().datetime().optional(),
    eligibleSellerType: z.enum(['store', 'user']).optional(),
    eligibleCurrency: z.enum(CURRENCY_CODE_VALUES).optional(),
    percentageBps: z.number().int().min(0).max(10_000),
    fixedFeeMinor: minorUnits.optional(),
    minFeeMinor: minorUnits.optional(),
    maxFeeMinor: minorUnits.optional(),
    taxTreatment: z.enum(FEE_TAX_TREATMENT_VALUES).optional(),
    refundPolicy: z.enum(FEE_REFUND_POLICY_VALUES).optional(),
    termsVersion: z.string().trim().min(1).max(100),
  })
  .strict()
  .superRefine((body, ctx) => {
    const hasAbsolute =
      body.fixedFeeMinor !== undefined ||
      body.minFeeMinor !== undefined ||
      body.maxFeeMinor !== undefined;
    if (hasAbsolute && body.eligibleCurrency === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A fixed component or min/max clamp is an amount in a named currency; ' +
          'eligibleCurrency must be set so the fee never mixes currencies.',
      });
    }
    if (
      body.minFeeMinor !== undefined &&
      body.maxFeeMinor !== undefined &&
      body.minFeeMinor > body.maxFeeMinor
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'minFeeMinor must not exceed maxFeeMinor.' });
    }
    if (
      body.effectiveEnd !== undefined &&
      new Date(body.effectiveEnd).getTime() <= new Date(body.effectiveStart).getTime()
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'effectiveEnd must be after effectiveStart.' });
    }
  });

/** The validated body of a draft-schedule creation. */
export type FeeScheduleCreateBody = z.infer<typeof feeScheduleCreateSchema>;
