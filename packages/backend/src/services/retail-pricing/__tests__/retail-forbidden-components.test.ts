/**
 * #120 test cases 13 and 14: "attempts to configure markup/margin fail" and
 * "referral expense cannot enter the retail price".
 *
 * Four independent walls, tested independently, because any one of them alone
 * would be a rule somebody could route around:
 *
 *  1. The DTO/column vocabulary — no allowed component kind is a markup, and no
 *     column in any of the four retail tables is named for one.
 *  2. The zod schema — `.strict()`, so a markup-shaped field is a 400 rather
 *     than a silently ignored key.
 *  3. The detector — the refusal NAMES the prohibited component, so an operator
 *     learns the policy rather than reading "unrecognized key".
 *  4. The formula — no parameter through which anything could be added, and
 *     `markupMinor` is measured at zero for every input (its own test file).
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  RETAIL_COST_COMPONENT_KINDS,
  RETAIL_FORBIDDEN_COMPONENT_KINDS,
  RETAIL_FORBIDDEN_COMPONENT_LABELS,
} from '@mercaria/shared-types';
import {
  retailCostQuoteAcceptances,
  retailCostQuoteComponents,
  retailCostQuotes,
  retailPricingPolicies,
} from '../../../db/schema/retailPricing.js';
import { retailPricingPolicyCreateSchema } from '../../../middleware/retail-pricing-schemas.js';
import {
  assertNoForbiddenPricingComponent,
  detectForbiddenPricingComponents,
} from '../forbidden-components.js';
import { assertRetailPolicyBodyIsCostOnly } from '../retail-pricing-policy.service.js';

/** A valid draft body — the thing an operator would then try to bend. */
const VALID_POLICY_BODY = {
  policyKey: 'mercaria-retail-cost-only',
  version: 1,
  name: 'Cost-only retail',
  summary: 'Zero markup, zero intended item profit.',
  effectiveStart: '2026-08-09T00:00:00.000Z',
  allowedComponentKinds: ['supplier_item', 'destination_shipping', 'tax_duty'],
};

describe('case 13: attempts to configure markup or margin FAIL', () => {
  it('the schema refuses every markup-shaped field — it is `.strict()`', () => {
    const attempts = [
      { markupBps: 500 },
      { markupPercent: 5 },
      { marginTargetBps: 1_200 },
      { minGrossProfitMinor: 500 },
      { fixedProfitMinor: 200 },
      { operatorPaddingMinor: 50 },
      { overheadAllocationBps: 300 },
      { psychologicalRounding: 'charm' },
    ];
    for (const attempt of attempts) {
      const parsed = retailPricingPolicyCreateSchema.safeParse({
        ...VALID_POLICY_BODY,
        ...attempt,
      });
      expect(parsed.success, `${Object.keys(attempt)[0]} was accepted by the schema`).toBe(false);
    }
    // The vacuity floor: the body WITHOUT any of them parses, so the failures
    // above are the extra field and not a broken fixture.
    expect(retailPricingPolicyCreateSchema.safeParse(VALID_POLICY_BODY).success).toBe(true);
  });

  it('the refusal NAMES the prohibited component rather than saying "unknown field"', () => {
    expect(() =>
      assertRetailPolicyBodyIsCostOnly({ ...VALID_POLICY_BODY, markupBps: 500 }),
    ).toThrow(/percentage_markup/);
    expect(() =>
      assertRetailPolicyBodyIsCostOnly({ ...VALID_POLICY_BODY, marginTargetBps: 500 }),
    ).toThrow(/percentage_margin_target/);
    expect(() =>
      assertRetailPolicyBodyIsCostOnly({ ...VALID_POLICY_BODY, minimumGrossProfitMinor: 500 }),
    ).toThrow(/minimum_gross_profit_floor/);
    // And it explains the model, not just the rule.
    expect(() => assertRetailPolicyBodyIsCostOnly({ markupBps: 1 })).toThrow(
      /zero markup and zero intended item profit/,
    );
  });

  it('the detector recognises the SHAPE, not one spelling', () => {
    for (const key of ['markupBps', 'markup_percent', 'MARKUP', 'priceMarkup', 'price-markup']) {
      const matches = detectForbiddenPricingComponents([key]);
      expect(matches, `${key} was not detected`).toHaveLength(1);
      expect(matches[0].kind).toBe('percentage_markup');
    }
  });

  it('every one of the fourteen forbidden components has a detectable shape and a reason', () => {
    // The mutation defence: a pattern table that rotted would leave a kind with
    // no key that reaches it, and this is where that shows up. Each probe is a
    // field name an operator would plausibly send.
    const probes: Record<string, string> = {
      percentage_markup: 'markupBps',
      percentage_margin_target: 'marginTargetBps',
      fixed_profit: 'fixedProfitMinor',
      minimum_gross_profit_floor: 'minGrossProfitMinor',
      overhead_allocation: 'overheadAllocationBps',
      expected_support_cost: 'supportCostMinor',
      fraud_chargeback_reserve: 'fraudReserveBps',
      return_defect_reserve: 'returnReserveBps',
      referral_commission: 'referralCommissionBps',
      affiliate_economics: 'affiliateShareBps',
      merchant_subscription_economics: 'subscriptionOffsetMinor',
      paid_ranking_economics: 'sponsoredPlacementBps',
      psychological_rounding: 'charmRounding',
      operator_padding: 'operatorPaddingMinor',
    };
    for (const kind of RETAIL_FORBIDDEN_COMPONENT_KINDS) {
      const probe = probes[kind];
      expect(probe, `no probe for ${kind}`).toBeDefined();
      const matches = detectForbiddenPricingComponents([probe]);
      expect(matches, `${probe} did not match anything`).toHaveLength(1);
      expect(matches[0].kind, `${probe} matched ${matches[0].kind}, expected ${kind}`).toBe(kind);
      expect(RETAIL_FORBIDDEN_COMPONENT_LABELS[kind].length).toBeGreaterThan(20);
    }
  });

  it('the detector does NOT fire on the legitimate policy fields', () => {
    // A gate that cried wolf would be disabled by whoever hit it next. Every
    // field the real schema declares must pass cleanly, `absorptionCapBps`
    // included — it bounds a Mercaria LOSS and cannot raise a price.
    expect(detectForbiddenPricingComponents(Object.keys(VALID_POLICY_BODY))).toEqual([]);
    expect(
      detectForbiddenPricingComponents([
        'absorptionCapBps',
        'absorptionCapFloorMinor',
        'absorptionCapFloorCurrency',
        'roundingToleranceMinor',
        'quoteTtlSeconds',
        'paymentCostPassthroughEnabled',
        'paymentCostPassthroughBasis',
        'allowedComponentKinds',
        'effectiveStart',
        'effectiveEnd',
      ]),
    ).toEqual([]);
  });

  it('NO COLUMN in the retail pricing domain is named for a markup, margin or profit', () => {
    // The structural wall: even a hand-written UPDATE has nowhere to put one.
    const tables = {
      retail_pricing_policies: retailPricingPolicies,
      retail_cost_quotes: retailCostQuotes,
      retail_cost_quote_components: retailCostQuoteComponents,
      retail_cost_quote_acceptances: retailCostQuoteAcceptances,
    };
    const forbiddenShape =
      /markup|margin|profit|uplift|padding|overhead|reserve|commission|affiliate|subscription|ranking|sponsored/i;

    let scanned = 0;
    for (const [name, table] of Object.entries(tables)) {
      const columns = Object.keys(getTableColumns(table));
      // Vacuity floor: a table whose columns did not enumerate would pass this
      // scan by having nothing to match.
      expect(columns.length, `${name} enumerated no columns`).toBeGreaterThan(8);
      for (const column of columns) {
        expect(
          forbiddenShape.test(column),
          `${name}.${column} is named for a forbidden pricing component`,
        ).toBe(false);
      }
      scanned += 1;
    }
    expect(scanned).toBe(4);

    // The mutation self-test: the same scan against a seeded positive must fail,
    // so a rotted regex cannot pass the loop above vacuously.
    expect(forbiddenShape.test('markupBps')).toBe(true);
    expect(forbiddenShape.test('minMarginBps')).toBe(true);
    expect(forbiddenShape.test('absorptionCapBps')).toBe(false);
  });

  it('the eight allowed component kinds contain no profit-shaped member', () => {
    for (const kind of RETAIL_COST_COMPONENT_KINDS) {
      expect(/markup|margin|profit/.test(kind), `${kind} is not a direct cost`).toBe(false);
    }
  });
});

describe('case 14: referral expense cannot enter the retail price', () => {
  it('a referral or ambassador field on a policy body is refused BY NAME', () => {
    for (const key of ['referralCommissionBps', 'ambassadorBountyMinor', 'referral_share']) {
      expect(() => assertNoForbiddenPricingComponent([key], 'Retail pricing policy')).toThrow(
        /referral_commission/,
      );
    }
    expect(() => assertNoForbiddenPricingComponent(['affiliateShareBps'], 'x')).toThrow(
      /affiliate_economics/,
    );
  });

  it('the refusal explains that a referral reward is Mercaria’s own acquisition expense', () => {
    expect(RETAIL_FORBIDDEN_COMPONENT_LABELS.referral_commission).toContain(
      'acquisition expense of Mercaria',
    );
  });

  it('there is no allowed component kind a referral reward could be booked as', () => {
    expect(RETAIL_COST_COMPONENT_KINDS).not.toContain('referral_commission');
    // `other_direct_fulfilment` is the only open-ended kind, and a policy version
    // must NAME it before it can be used — which is an operator decision on the
    // record, not a place a referral expense slips into.
    expect(RETAIL_COST_COMPONENT_KINDS).toContain('other_direct_fulfilment');
  });
});
