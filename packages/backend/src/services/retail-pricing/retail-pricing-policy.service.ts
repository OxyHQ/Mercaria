/**
 * Retail pricing policy versions — the operator-facing seam (#120).
 *
 * A thin layer over `retailPricingPolicyRepository`, and it exists for exactly
 * two reasons the repository should not carry: the DTO projection, and the
 * refusal that NAMES a forbidden pricing component.
 *
 * ## Why the refusal lives here rather than only in the zod schema
 *
 * The `.strict()` schema already refuses an undeclared field. What it answers
 * is "unrecognized key" — which reads as a typo rather than as an attempt at
 * something the commercial model forbids. `assertNoForbiddenPricingComponent`
 * runs FIRST, over the raw body's own keys, so an operator who sends
 * `markupBps` is told it is a percentage markup, that retail carries zero
 * markup by construction, and that the customer amount is the sum of the
 * approved direct-cost components. The schema is the wall; this is the sign on
 * it.
 */

import type {
  RetailCostComponentKind,
  RetailPricingPolicySummary,
} from '@mercaria/shared-types';
import type { RetailPricingPolicyRecord } from '../../db/retailPricing/retailPricingPolicyRepository.js';
import { assertNoForbiddenPricingComponent } from './forbidden-components.js';

/** `retail_pricing_policies` row → the operator-facing DTO. */
export function toRetailPricingPolicySummary(
  row: RetailPricingPolicyRecord,
): RetailPricingPolicySummary {
  return {
    policyKey: row.policyKey,
    version: row.version,
    name: row.name,
    summary: row.summary,
    status: row.status,
    effectiveStart: row.effectiveStart.toISOString(),
    ...(row.effectiveEnd ? { effectiveEnd: row.effectiveEnd.toISOString() } : {}),
    allowedComponentKinds: row.allowedComponentKinds as RetailCostComponentKind[],
    paymentCostPassthroughEnabled: row.paymentCostPassthroughEnabled,
    ...(row.paymentCostPassthroughBasis
      ? { paymentCostPassthroughBasis: row.paymentCostPassthroughBasis }
      : {}),
    absorptionCapBps: row.absorptionCapBps,
    absorptionCapFloor: {
      amount: row.absorptionCapFloorAmount,
      currency: row.absorptionCapFloorCurrency,
    },
    roundingToleranceMinor: row.roundingToleranceMinor,
    quoteTtlSeconds: row.quoteTtlSeconds,
    createdAt: row.createdAt.toISOString(),
    ...(row.activatedAt ? { activatedAt: row.activatedAt.toISOString() } : {}),
  };
}

/**
 * Refuse a policy body that reaches for any of the fourteen forbidden pricing
 * components, naming which one and why.
 *
 * Takes the RAW body so the keys it inspects are the ones the caller actually
 * sent — reading a parsed object would only ever see the fields the schema
 * already allows, which is precisely the set that contains none of them.
 */
export function assertRetailPolicyBodyIsCostOnly(body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    return;
  }
  assertNoForbiddenPricingComponent(Object.keys(body), 'Retail pricing policy');
}
