/**
 * Request schemas for the retail pricing policy surface (#120).
 *
 * `.strict()`, like every schema in the fee surface beside it, and here the
 * strictness is doing MORE than refusing a smuggled audit field: this body is
 * the one place in Mercaria where an operator would type a markup. The schema
 * below enumerates the COMPLETE set of levers a retail pricing policy version
 * has, and it contains no percentage, no margin, no profit floor and no
 * padding — so a cost-only policy that charged a markup cannot be written down.
 *
 * `absorptionCapBps` is the one basis-point field, and it bounds what Mercaria
 * ABSORBS before cancelling and refunding (ADR 0004 D3). It can only ever cost
 * Mercaria money; there is no arithmetic path from it to a customer amount.
 *
 * The controller runs `assertRetailPolicyBodyIsCostOnly` over the RAW body
 * before this schema, so a rejected `markupBps` is answered with what it is
 * rather than with "unrecognized key".
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  assertSafeMoneyAmount,
  RETAIL_COST_COMPONENT_KINDS,
  RETAIL_MAX_ROUNDING_TOLERANCE_MINOR,
  type CurrencyCode,
  type RetailCostComponentKind,
} from '@mercaria/shared-types';

const CURRENCY_CODE_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const COMPONENT_KIND_VALUES = RETAIL_COST_COMPONENT_KINDS as readonly [
  RetailCostComponentKind,
  ...RetailCostComponentKind[],
];

/**
 * A minor-unit amount: a non-negative integer WITHIN the representable ceiling.
 * `z.number().int()` alone accepts `1e300` — `assertSafeMoneyAmount` is what
 * makes the bound real, the rule every money boundary in this codebase follows.
 */
const minorUnits = z
  .number()
  .int()
  .nonnegative()
  .superRefine((value, ctx) => {
    try {
      assertSafeMoneyAmount(value, 'retailPricing.request');
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

/**
 * Drafting a new retail pricing policy version.
 *
 * Read the field list as the answer to "what CAN a retail pricing policy do":
 * approve component kinds, permit payment-cost pass-through with its lawful
 * basis, bound Mercaria's own absorption, set a tiny rounding tolerance and set
 * a quote TTL. That is the complete set of levers, and none of them raises a
 * price.
 */
export const retailPricingPolicyCreateSchema = z
  .object({
    policyKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'policyKey must be a lowercase slug'),
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2000),
    effectiveStart: z.string().datetime(),
    effectiveEnd: z.string().datetime().optional(),
    /** The approved subset of the eight direct-cost components. */
    allowedComponentKinds: z.array(z.enum(COMPONENT_KIND_VALUES)).min(1).max(8),
    paymentCostPassthroughEnabled: z.boolean().optional(),
    paymentCostPassthroughBasis: z.string().trim().min(1).max(2000).optional(),
    absorptionCapBps: z.number().int().min(0).max(10_000).optional(),
    absorptionCapFloorMinor: minorUnits.optional(),
    absorptionCapFloorCurrency: z.enum(CURRENCY_CODE_VALUES).optional(),
    roundingToleranceMinor: z
      .number()
      .int()
      .min(0)
      .max(RETAIL_MAX_ROUNDING_TOLERANCE_MINOR)
      .optional(),
    quoteTtlSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.allowedComponentKinds.includes('supplier_item')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'allowedComponentKinds must include supplier_item: a policy that cannot include ' +
          'the item cost prices nothing.',
      });
    }
    if (new Set(body.allowedComponentKinds).size !== body.allowedComponentKinds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'allowedComponentKinds must not repeat a kind.',
      });
    }
    // Pass-through is a decision WITH its lawful basis, or it is off — the same
    // biconditional the column CHECK holds, restated so an operator gets a 400
    // naming the field instead of a constraint name.
    if (body.paymentCostPassthroughEnabled === true) {
      if (body.paymentCostPassthroughBasis === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'paymentCostPassthroughBasis is required when the payment-processing cost is ' +
            'passed through: it must be lawful, approved and disclosed (ADR 0004 D3.5).',
        });
      }
      if (!body.allowedComponentKinds.includes('payment_processing')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'payment_processing must be in allowedComponentKinds for pass-through to mean ' +
            'anything.',
        });
      }
    } else if (body.paymentCostPassthroughBasis !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'paymentCostPassthroughBasis without paymentCostPassthroughEnabled records a ' +
          'justification for something that does not happen.',
      });
    }
    // An absolute floor is an amount in a named currency.
    if (
      (body.absorptionCapFloorMinor === undefined) !==
      (body.absorptionCapFloorCurrency === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'absorptionCapFloorMinor and absorptionCapFloorCurrency are set together or not at all.',
      });
    }
    if (
      body.effectiveEnd !== undefined &&
      new Date(body.effectiveEnd).getTime() <= new Date(body.effectiveStart).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'effectiveEnd must be after effectiveStart.',
      });
    }
  });

/** The validated body of a draft-policy creation. */
export type RetailPricingPolicyCreateBody = z.infer<typeof retailPricingPolicyCreateSchema>;
