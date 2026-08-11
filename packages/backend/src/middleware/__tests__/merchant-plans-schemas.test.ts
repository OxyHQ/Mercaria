/**
 * The merchant-plan request schemas (#89) — and the refusal that has to say
 * WHICH prohibition a caller reached for.
 *
 * The message is pinned deliberately. `MERCHANT_ENTITLEMENT_CAPABILITIES` and
 * `MERCHANT_UNGATEABLE_CAPABILITIES` are disjoint, so a bare enum would answer
 * "invalid value" for `data_export` — true, and useless to whoever wrote the
 * request. Naming the prohibition is the whole point of the refinement, so the
 * test asserts the text rather than only the failure.
 */

import { describe, expect, it } from 'vitest';
import {
  entitlementGrantCreateSchema,
  merchantPlanCheckoutSchema,
  merchantPlanCreateSchema,
  planEntitlementCreateSchema,
} from '../merchant-plans-schemas.js';

describe('an ungateable capability is refused BY NAME', () => {
  it('says a plan can never gate order management', () => {
    const result = planEntitlementCreateSchema.safeParse({
      capability: 'order_management',
      limitKind: 'flag',
    });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
    expect(message).toMatch(/can never be gated/i);
    expect(message).toMatch(/order_management/);
  });

  it('says the same on a GRANT, which is the other way in', () => {
    const result = entitlementGrantCreateSchema.safeParse({
      storeId: 'store-1',
      grantKey: 'g-1',
      capability: 'data_export',
      limitKind: 'flag',
      reason: 'partnership',
      note: 'a partnership',
    });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
    expect(message).toMatch(/can never be gated/i);
    expect(message).toMatch(/data_export/);
  });

  it('answers a genuinely unknown key differently, because it is a different problem', () => {
    const result = planEntitlementCreateSchema.safeParse({
      capability: 'teleportation',
      limitKind: 'flag',
    });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
    expect(message).not.toMatch(/can never be gated/i);
  });

  it('accepts a real capability, and NARROWS it', () => {
    const result = planEntitlementCreateSchema.safeParse({
      capability: 'scheduled_exports',
      limitKind: 'per_period',
      limit: 20,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.capability).toBe('scheduled_exports');
  });
});

describe('a merchant cannot name a price', () => {
  it('refuses an amount, a price id or a trial on the checkout body', () => {
    // The server resolves every one of them from the plan version. A body able
    // to carry a money word is where one would eventually be trusted
    // (`checkoutSchema`'s rule, one domain over).
    for (const smuggled of [
      { amount: 1 },
      { providerPriceId: 'price_x' },
      { trialDays: 999 },
      { paid: true },
    ]) {
      const result = merchantPlanCheckoutSchema.safeParse({
        planId: 'plan-1',
        interval: 'monthly',
        currency: 'EUR',
        ...smuggled,
      });
      expect(result.success, `${JSON.stringify(smuggled)} was not refused`).toBe(false);
    }
  });

  it('accepts the three fields it declares', () => {
    expect(
      merchantPlanCheckoutSchema.safeParse({
        planId: 'plan-1',
        interval: 'annual',
        currency: 'EUR',
      }).success,
    ).toBe(true);
  });
});

describe('a plan cannot select a marketplace fee schedule', () => {
  it('refuses a fee-schedule field on the draft body', () => {
    // There is no such field, and `.strict()` is what makes adding one a
    // decision rather than an accident. #88's schedule scope is the seller type
    // and the currency and nothing else — a plan scope belongs to THAT domain.
    for (const smuggled of [
      { feeScheduleKey: 'connected-marketplace-standard' },
      { percentageBps: 0 },
      { organicRankBoost: 2 },
    ]) {
      const result = merchantPlanCreateSchema.safeParse({
        planKey: 'pro',
        version: 1,
        tier: 'paid',
        name: 'Pro',
        summary: 'a plan',
        termsVersion: 'terms-1',
        ...smuggled,
      });
      expect(result.success, `${JSON.stringify(smuggled)} was not refused`).toBe(false);
    }
  });
});
