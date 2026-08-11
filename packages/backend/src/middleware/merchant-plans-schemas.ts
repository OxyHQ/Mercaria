/**
 * Request schemas for merchant plans, entitlements and billing (#89).
 *
 * Every schema is `.strict()`, and here that is a security property rather than
 * tidiness. Two of them decide what a merchant is ENTITLED to, so a field the
 * schema does not declare — a capability nobody reviewed, a limit on something
 * ungateable, a plan naming a fee schedule — must be REFUSED rather than
 * stripped, because stripping it means the caller thought they had asked for
 * something and the server silently did not.
 *
 * ## An ungateable capability is refused BY NAME
 *
 * `MERCHANT_ENTITLEMENT_CAPABILITIES` and `MERCHANT_UNGATEABLE_CAPABILITIES` are
 * disjoint, so a bare enum would answer "invalid value" for `data_export` — true
 * and useless. {@link entitlementCapability} checks the prohibition FIRST and
 * says which one was reached for, the `forbidden-evidence.ts` device (#121). The
 * refusal is pinned by MESSAGE in a test, because a message is the whole point.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  assertSafeMoneyAmount,
  BILLING_INTERVALS,
  ENTITLEMENT_GRANT_REASONS,
  ENTITLEMENT_LIMIT_KINDS,
  MERCHANT_ENTITLEMENT_CAPABILITIES,
  MERCHANT_PLAN_TIERS,
  MERCHANT_UNGATEABLE_CAPABILITIES,
  type BillingInterval,
  type CurrencyCode,
  type EntitlementGrantReason,
  type EntitlementLimitKind,
  type MerchantEntitlementCapability,
  type MerchantPlanTier,
} from '@mercaria/shared-types';

const CURRENCY_CODE_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const BILLING_INTERVAL_VALUES = BILLING_INTERVALS as readonly [BillingInterval, ...BillingInterval[]];
const PLAN_TIER_VALUES = MERCHANT_PLAN_TIERS as readonly [MerchantPlanTier, ...MerchantPlanTier[]];
const LIMIT_KIND_VALUES = ENTITLEMENT_LIMIT_KINDS as readonly [
  EntitlementLimitKind,
  ...EntitlementLimitKind[],
];
const GRANT_REASON_VALUES = ENTITLEMENT_GRANT_REASONS as readonly [
  EntitlementGrantReason,
  ...EntitlementGrantReason[],
];

const CAPABILITY_VALUES = MERCHANT_ENTITLEMENT_CAPABILITIES as readonly [
  MerchantEntitlementCapability,
  ...MerchantEntitlementCapability[],
];

/**
 * A capability an entitlement may name, refusing an UNGATEABLE one by name.
 *
 * The order is load-bearing: the prohibition is checked before the membership
 * test, so `order_management` gets a sentence that says it can never be gated
 * rather than one that says it is not a recognised value.
 */
const entitlementCapability = z
  .string()
  .superRefine((value, ctx) => {
    if ((MERCHANT_UNGATEABLE_CAPABILITIES as readonly string[]).includes(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `'${value}' can never be gated by a plan. Maintaining a catalogue, fulfilling orders, ` +
          'issuing refunds, reading financial records and exporting data stay free for every ' +
          'merchant, so no entitlement can name them.',
      });
    }
  })
  // The pipe is what NARROWS the parsed value to the union, with no cast: the
  // refinement above owns the message and this owns the type.
  .pipe(z.enum(CAPABILITY_VALUES));

/** A minor-unit amount within the representable ceiling — the money-boundary rule. */
const minorUnits = z
  .number()
  .int()
  .nonnegative()
  .superRefine((value, ctx) => {
    try {
      assertSafeMoneyAmount(value, 'merchantPlans.request');
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

/**
 * Drafting a plan version.
 *
 * There is deliberately NO field by which a plan selects a marketplace fee
 * schedule. #88's schedule scope is the seller type and the currency and nothing
 * else, which is what makes guest and authenticated checkouts fee-equivalent
 * structurally; a plan scope would have to be added to THAT domain's table under
 * its own decision. `docs/merchant-plans.md` records the answer and the
 * mechanism by which one ever could.
 */
export const merchantPlanCreateSchema = z
  .object({
    planKey: z.string().trim().min(1).max(64),
    version: z.number().int().min(1),
    tier: z.enum(PLAN_TIER_VALUES),
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    termsVersion: z.string().trim().min(1).max(64),
    trialDays: z.number().int().min(0).max(365).optional(),
    gracePeriodDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

/** {@link merchantPlanCreateSchema}'s parsed body. */
export type MerchantPlanCreateBody = z.infer<typeof merchantPlanCreateSchema>;

/** Publishing one provider price for one plan version, in one mode. */
export const merchantPlanPriceCreateSchema = z
  .object({
    livemode: z.boolean(),
    interval: z.enum(BILLING_INTERVAL_VALUES),
    amount: minorUnits,
    currency: z.enum(CURRENCY_CODE_VALUES),
    providerPriceId: z.string().trim().min(1).max(255),
  })
  .strict();

/** {@link merchantPlanPriceCreateSchema}'s parsed body. */
export type MerchantPlanPriceCreateBody = z.infer<typeof merchantPlanPriceCreateSchema>;

/**
 * Adding one capability to a DRAFT plan version.
 *
 * `limit` is nullable and optional, and the two mean the same thing —
 * UNLIMITED for a quantified kind, and nothing at all for a `flag`, which the
 * database CHECK refuses a number on.
 */
export const planEntitlementCreateSchema = z
  .object({
    capability: entitlementCapability,
    limitKind: z.enum(LIMIT_KIND_VALUES),
    limit: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

/** {@link planEntitlementCreateSchema}'s parsed body. */
export type PlanEntitlementCreateBody = z.infer<typeof planEntitlementCreateSchema>;

/**
 * Granting a capability outside a plan.
 *
 * `grantKey` is the caller's own idempotency handle, and it is REQUIRED: a
 * retried operator request must converge on one grant rather than stack a
 * second, and a server-minted key could not do that.
 */
export const entitlementGrantCreateSchema = z
  .object({
    storeId: z.string().trim().min(1),
    grantKey: z.string().trim().min(1).max(120),
    capability: entitlementCapability,
    limitKind: z.enum(LIMIT_KIND_VALUES),
    limit: z.number().int().nonnegative().nullable().optional(),
    reason: z.enum(GRANT_REASON_VALUES),
    note: z.string().trim().min(1).max(500),
    startsAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

/** {@link entitlementGrantCreateSchema}'s parsed body. */
export type EntitlementGrantCreateBody = z.infer<typeof entitlementGrantCreateSchema>;

/** Revoking a grant — attributable, dated and explained, or not recorded. */
export const entitlementGrantRevokeSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

/** {@link entitlementGrantRevokeSchema}'s parsed body. */
export type EntitlementGrantRevokeBody = z.infer<typeof entitlementGrantRevokeSchema>;

/**
 * Starting a paid plan from the merchant surface.
 *
 * It names a plan, a cadence and a currency and NOTHING about money. There is no
 * `amount`, no `price`, no `providerPriceId` and no `trialDays` — the server
 * resolves every one of them from the plan version, so a client cannot ask to be
 * charged a figure it chose (`checkoutSchema`'s rule, one domain over).
 */
export const merchantPlanCheckoutSchema = z
  .object({
    planId: z.string().trim().min(1),
    interval: z.enum(BILLING_INTERVAL_VALUES),
    currency: z.enum(CURRENCY_CODE_VALUES),
  })
  .strict();

/** {@link merchantPlanCheckoutSchema}'s parsed body. */
export type MerchantPlanCheckoutBody = z.infer<typeof merchantPlanCheckoutSchema>;
