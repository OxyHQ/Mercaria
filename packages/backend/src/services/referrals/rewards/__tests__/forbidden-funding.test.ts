/**
 * #144 test case 13: "attempt to use `mercaria_retail` margin/cost variance as
 * funding fails", and the eleven sibling prohibitions beside it.
 *
 * Four independent walls, tested independently, because any one of them alone
 * would be a rule somebody could route around:
 *
 *  1. The VOCABULARY — the allowed and forbidden unions are disjoint, and no
 *     allowed member is a retail, supplier, tax, refund or ranking anything.
 *  2. The SCHEMA — no column in the four reward tables is named for one, so a
 *     hand-written `UPDATE` has nowhere to put it. (The CHECK that refuses a
 *     forbidden VALUE needs a real server and lives in the realdb file.)
 *  3. The `.strict()` schema — a forbidden field is a refusal rather than a
 *     silently dropped key.
 *  4. The DETECTOR — the refusal NAMES the prohibition and explains it, so an
 *     operator learns the model rather than reading "unrecognized key".
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  REFERRAL_FORBIDDEN_FUNDING_KINDS,
  REFERRAL_FORBIDDEN_FUNDING_LABELS,
  REFERRAL_FUNDING_SOURCE_IDS,
} from '@mercaria/shared-types';
import {
  referralCampaignBudgets,
  referralRewardAdjustments,
  referralRewardRules,
  referralRewards,
} from '../../../../db/schema/referralRewards.js';
import { referralRewardRuleDraftSchema } from '../rule-schema.js';
import { validateRewardRuleDraftBody } from '../rule.service.js';
import {
  assertNoForbiddenReferralFunding,
  detectForbiddenReferralFunding,
} from '../forbidden-funding.js';
import { REFERRAL_FUNDING_ADAPTERS, resolveFundingAdapter } from '../funding.js';

/** A valid draft — the thing an operator would then try to bend. */
const VALID_DRAFT = {
  ruleId: 'buyer-referral-commission-share',
  name: 'Buyer referral, 20% of realized commission',
  programId: 'buyer-referral',
  conversionType: 'first_qualifying_paid_order' as const,
  fundingSourceId: 'connected_marketplace' as const,
  formula: 'percentage_of_realized_base' as const,
  rateBps: 2_000,
  currencyMode: 'fixed_currency' as const,
  rewardCurrency: 'EUR' as const,
  effectiveStartAt: '2026-08-01T00:00:00.000Z',
  holdPolicyRef: 'buyer-hold-60d',
  holdDays: 60,
  maxRewardPerConversionMinor: 5_000,
  reversalPolicy: 'proportional_to_realized_base' as const,
  termsVersion: 'referral-terms-v1',
  createdByOxyUserId: 'operator-1',
};

describe('the two unions are disjoint, and neither leaks into the other', () => {
  it('shares no member', () => {
    const allowed = new Set<string>(REFERRAL_FUNDING_SOURCE_IDS);
    for (const forbidden of REFERRAL_FORBIDDEN_FUNDING_KINDS) {
      expect(allowed.has(forbidden), `${forbidden} is also an allowed source`).toBe(false);
    }
    // Counted in both directions: one quietly removed would stop being
    // enforceable, one quietly added would be enforced by nothing.
    expect(REFERRAL_FUNDING_SOURCE_IDS).toHaveLength(4);
    expect(new Set(REFERRAL_FUNDING_SOURCE_IDS).size).toBe(4);
    expect(REFERRAL_FORBIDDEN_FUNDING_KINDS).toHaveLength(12);
    expect(new Set(REFERRAL_FORBIDDEN_FUNDING_KINDS).size).toBe(12);
  });

  it('names no retail, supplier, tax, refund or ranking source among the four allowed', () => {
    const forbiddenShape =
      /retail|supplier|margin|markup|tax|duty|refund|credit|ranking|sponsored|variance|surcharge/i;
    for (const source of REFERRAL_FUNDING_SOURCE_IDS) {
      expect(forbiddenShape.test(source), `${source} names a prohibited base`).toBe(false);
    }
    // The mutation self-test: the same regex against a seeded positive must
    // fire, so a rotted pattern cannot pass the loop above vacuously.
    expect(forbiddenShape.test('mercaria_retail_margin')).toBe(true);
    expect(forbiddenShape.test('connected_marketplace')).toBe(false);
  });

  it('gives every prohibition a sentence that explains the model', () => {
    for (const kind of REFERRAL_FORBIDDEN_FUNDING_KINDS) {
      expect(REFERRAL_FORBIDDEN_FUNDING_LABELS[kind]?.length ?? 0).toBeGreaterThan(30);
    }
  });

  it('has an adapter for every allowed source and none for anything else', () => {
    expect(Object.keys(REFERRAL_FUNDING_ADAPTERS).sort()).toEqual(
      [...REFERRAL_FUNDING_SOURCE_IDS].sort(),
    );
    for (const source of REFERRAL_FUNDING_SOURCE_IDS) {
      expect(resolveFundingAdapter(source).sourceId).toBe(source);
    }
    for (const forbidden of REFERRAL_FORBIDDEN_FUNDING_KINDS) {
      expect(Object.keys(REFERRAL_FUNDING_ADAPTERS)).not.toContain(forbidden);
    }
  });
});

describe('NO COLUMN in the reward domain is named for a forbidden source', () => {
  it('holds across all four tables, with a floor on what was scanned', () => {
    const tables = {
      referral_reward_rules: referralRewardRules,
      referral_campaign_budgets: referralCampaignBudgets,
      referral_rewards: referralRewards,
      referral_reward_adjustments: referralRewardAdjustments,
    };
    const forbiddenShape =
      /retail|supplier|markup|margin|profit|dropship|sponsored|ranking|vatshare|taxshare|surcharge/i;

    let scanned = 0;
    for (const [name, table] of Object.entries(tables)) {
      const columns = Object.keys(getTableColumns(table));
      // Vacuity floor: a table whose columns did not enumerate would pass by
      // having nothing to match.
      expect(columns.length, `${name} enumerated no columns`).toBeGreaterThan(8);
      for (const column of columns) {
        expect(
          forbiddenShape.test(column),
          `${name}.${column} is named for a forbidden funding source`,
        ).toBe(false);
      }
      scanned += 1;
    }
    expect(scanned).toBe(4);

    // The mutation self-test.
    expect(forbiddenShape.test('retailMarginShareMinor')).toBe(true);
    expect(forbiddenShape.test('supplierCostShareMinor')).toBe(true);
    expect(forbiddenShape.test('fundingAmountMinor')).toBe(false);
  });
});

describe('the .strict() schema refuses every forbidden-shaped field', () => {
  it('is `.strict()`, so an extra key is a refusal rather than a dropped one', () => {
    const attempts = [
      { retailMarginShareBps: 500 },
      { retailCostVarianceMinor: 400 },
      { supplierCostShareBps: 300 },
      { supplierShippingShareMinor: 200 },
      { customerTaxAmountShareBps: 100 },
      { fxCostShareMinor: 50 },
      { refundCreditShareMinor: 25 },
      { dropshipMarkupBps: 120 },
      { buyerServiceChargeMinor: 199 },
      { merchantFeeIncreaseBps: 75 },
      { itemPriceIncreaseMinor: 250 },
      { sponsoredPlacementBps: 400 },
    ];
    for (const attempt of attempts) {
      const parsed = referralRewardRuleDraftSchema.safeParse({ ...VALID_DRAFT, ...attempt });
      expect(parsed.success, `${Object.keys(attempt)[0]} was accepted by the schema`).toBe(false);
    }
    // The vacuity floor: the body WITHOUT any of them parses, so the failures
    // above are the extra field and not a broken fixture.
    expect(referralRewardRuleDraftSchema.safeParse(VALID_DRAFT).success).toBe(true);
  });

  it('refuses a funding source outside the four approved ones', () => {
    for (const value of REFERRAL_FORBIDDEN_FUNDING_KINDS) {
      const parsed = referralRewardRuleDraftSchema.safeParse({
        ...VALID_DRAFT,
        fundingSourceId: value,
      });
      expect(parsed.success, `${value} was accepted as a funding source`).toBe(false);
    }
  });
});

describe('the refusal NAMES the prohibition rather than saying "unknown field"', () => {
  it('answers a retail margin attempt with the zero-profit reason', () => {
    expect(() => validateRewardRuleDraftBody({ ...VALID_DRAFT, retailMarginShareBps: 500 })).toThrow(
      /mercaria_retail_margin/,
    );
    expect(() => validateRewardRuleDraftBody({ ...VALID_DRAFT, retailMarginShareBps: 500 })).toThrow(
      /zero by construction .*zero intended item profit/,
    );
  });

  it('tells a retail COST VARIANCE apart from a retail margin', () => {
    // Two genuinely different reasons — one is zero by construction, the other
    // is the customer's money — so a refusal naming the wrong one teaches the
    // wrong lesson.
    expect(() =>
      validateRewardRuleDraftBody({ ...VALID_DRAFT, retailCostVarianceShareMinor: 400 }),
    ).toThrow(/mercaria_retail_cost_variance/);
    expect(() =>
      validateRewardRuleDraftBody({ ...VALID_DRAFT, retailCostVarianceShareMinor: 400 }),
    ).toThrow(/awaiting return/);
  });

  it('answers the VALUE form, not only the key form', () => {
    // `{ fundingSourceId: 'mercaria_retail_margin' }` is the same attempt as
    // `{ retailMarginBps: 500 }` and deserves the same sentence rather than an
    // enum error listing four members it is not.
    expect(() =>
      validateRewardRuleDraftBody({ ...VALID_DRAFT, fundingSourceId: 'mercaria_retail_margin' }),
    ).toThrow(/mercaria_retail_margin/);
    expect(() =>
      validateRewardRuleDraftBody({ ...VALID_DRAFT, fundingSourceId: 'retail_cost_variance' }),
    ).toThrow(/mercaria_retail_cost_variance/);
  });

  it('recognises the SHAPE, not one spelling', () => {
    for (const key of ['retailMargin', 'retail_margin', 'RETAIL-MARGIN', 'mercariaRetailShare']) {
      const matches = detectForbiddenReferralFunding([key]);
      expect(matches, `${key} was not detected`).toHaveLength(1);
      expect(matches[0].kind).toBe('mercaria_retail_margin');
    }
  });

  it('has a detectable shape and a reason for every one of the twelve', () => {
    // The mutation defence: a pattern table that rotted would leave a kind with
    // no input that reaches it, and this is where that shows up. Each probe is
    // a field name somebody would plausibly send.
    const probes: Record<string, string> = {
      mercaria_retail_margin: 'retailMarginShareBps',
      mercaria_retail_cost_variance: 'retailCostVarianceMinor',
      supplier_acquisition_cost: 'supplierCostShareBps',
      supplier_shipping_handling: 'supplierShippingShareMinor',
      customer_tax_duty: 'customerTaxAmountShareBps',
      direct_payment_fx_cost: 'fxCostShareMinor',
      customer_refund_credit: 'refundCreditShareMinor',
      dropship_markup: 'dropshipMarkupBps',
      buyer_service_charge: 'buyerServiceChargeMinor',
      merchant_fee_increase: 'merchantFeeIncreaseBps',
      item_price_increase: 'itemPriceIncreaseMinor',
      paid_ranking: 'sponsoredPlacementBps',
    };
    for (const kind of REFERRAL_FORBIDDEN_FUNDING_KINDS) {
      const probe = probes[kind];
      expect(probe, `no probe for ${kind}`).toBeDefined();
      const matches = detectForbiddenReferralFunding([probe]);
      expect(matches, `${probe} matched nothing`).toHaveLength(1);
      expect(matches[0].kind, `${probe} matched ${matches[0].kind}, expected ${kind}`).toBe(kind);
    }
  });

  it('does NOT fire on the legitimate rule fields or the four allowed sources', () => {
    // A gate that cried wolf would be disabled by whoever hit it next. Every
    // field the real schema declares must pass cleanly — `activatedAt` in
    // particular, which contains the letters of `vat`.
    expect(detectForbiddenReferralFunding(Object.keys(VALID_DRAFT))).toEqual([]);
    expect(
      detectForbiddenReferralFunding([
        'activatedAt',
        'supersededAt',
        'retiredAt',
        'minAccrualMinor',
        'maxRewardPerPartnerPeriodMinor',
        'partnerCapPeriod',
        'maxRewardPerCampaignMinor',
        'campaignRef',
        'holdPolicyRef',
        'reversalPolicy',
        'taxonomy',
        'private',
        ...REFERRAL_FUNDING_SOURCE_IDS,
      ]),
    ).toEqual([]);
  });

  it('explains that a referral reward is Mercaria’s own acquisition expense', () => {
    expect(() => assertNoForbiddenReferralFunding(['retailMarginBps'], 'x')).toThrow(
      /realized eligible Mercaria revenue or an explicit marketing budget/,
    );
    expect(() => assertNoForbiddenReferralFunding(['merchantFeeIncreaseBps'], 'x')).toThrow(
      /never change a buyer price, a merchant fee or an organic ranking/,
    );
  });
});
