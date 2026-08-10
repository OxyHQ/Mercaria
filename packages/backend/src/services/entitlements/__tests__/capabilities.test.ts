/**
 * The pure half of the entitlement domain (#89) — the arithmetic, the period
 * keys and the decision.
 *
 * Every case here is a fixture chosen to EXERCISE the distinction the function
 * exists to make, rather than one that happens to be valid: an unlimited limit
 * beside a numeric one (they are the case `mostGenerousLimit` exists for), a
 * capability that is defined-but-postponed beside one that is undefined (they
 * refuse for different reasons and route to different screens), and a limit
 * exactly reached beside one exceeded.
 */

import { describe, expect, it } from 'vitest';
import { MERCHANT_CAPABILITY_CATALOG } from '../catalog.js';
import {
  decideEntitlement,
  entitlementPeriodKey,
  isEntitlementCapability,
  isUngateableCapability,
  mostGenerousLimit,
  type EffectiveEntitlement,
} from '../capabilities.js';
import {
  ENTITLEMENT_ENFORCEMENT_POINTS,
  MERCHANT_ENTITLEMENT_CAPABILITIES,
} from '@mercaria/shared-types';

const FLAG: EffectiveEntitlement = {
  capability: 'advanced_demand_analytics',
  limitKind: 'flag',
  limit: null,
  source: 'plan',
};

const QUANTIFIED: EffectiveEntitlement = {
  capability: 'scheduled_exports',
  limitKind: 'per_period',
  limit: 10,
  source: 'plan',
};

describe('mostGenerousLimit', () => {
  it('lets UNLIMITED win from either side', () => {
    expect(mostGenerousLimit(null, 5)).toBeNull();
    expect(mostGenerousLimit(5, null)).toBeNull();
    expect(mostGenerousLimit(null, null)).toBeNull();
  });

  it('takes the larger of two numbers', () => {
    expect(mostGenerousLimit(3, 9)).toBe(9);
    expect(mostGenerousLimit(9, 3)).toBe(9);
  });
});

describe('entitlementPeriodKey', () => {
  it('keys a TOTAL limit on a single bucket', () => {
    expect(entitlementPeriodKey('total', new Date('2030-03-04T00:00:00Z'))).toBe('total');
  });

  it('keys a PER-PERIOD limit on the subscription s own period when there is one', () => {
    expect(
      entitlementPeriodKey(
        'per_period',
        new Date('2030-03-20T00:00:00Z'),
        new Date('2030-03-14T09:31:00Z'),
      ),
    ).toBe('p:2030-03-14');
  });

  it('falls back to the calendar month for a store with no subscription', () => {
    expect(entitlementPeriodKey('per_period', new Date('2030-03-20T00:00:00Z'))).toBe('m:2030-03');
    expect(entitlementPeriodKey('per_period', new Date('2030-03-20T00:00:00Z'), null)).toBe(
      'm:2030-03',
    );
  });
});

describe('decideEntitlement', () => {
  it('refuses an UNDEFINED capability and a POSTPONED one differently', () => {
    const unknown = decideEntitlement({
      capability: 'scheduled_exports',
      entitlement: QUANTIFIED,
      definitionAvailability: undefined,
      used: 0,
      amount: 1,
    });
    const postponed = decideEntitlement({
      capability: 'scheduled_exports',
      entitlement: QUANTIFIED,
      definitionAvailability: 'postponed',
      used: 0,
      amount: 1,
    });
    expect(unknown).toEqual({
      outcome: 'refused',
      capability: 'scheduled_exports',
      reason: 'capability_unknown',
    });
    expect(postponed).toEqual({
      outcome: 'refused',
      capability: 'scheduled_exports',
      reason: 'capability_postponed',
    });
  });

  it('refuses on ABSENCE rather than granting quietly', () => {
    expect(
      decideEntitlement({
        capability: 'scheduled_exports',
        entitlement: undefined,
        definitionAvailability: 'available',
        used: 0,
        amount: 1,
      }),
    ).toEqual({ outcome: 'refused', capability: 'scheduled_exports', reason: 'not_entitled' });
  });

  it('grants a FLAG with no quantity at all', () => {
    expect(
      decideEntitlement({
        capability: 'advanced_demand_analytics',
        entitlement: FLAG,
        definitionAvailability: 'available',
        used: 999,
        amount: 4,
      }),
    ).toEqual({
      outcome: 'granted',
      capability: 'advanced_demand_analytics',
      limit: null,
      remaining: null,
    });
  });

  it('grants exactly up to the limit and refuses the request that would pass it', () => {
    const exact = decideEntitlement({
      capability: 'scheduled_exports',
      entitlement: QUANTIFIED,
      definitionAvailability: 'available',
      used: 9,
      amount: 1,
    });
    expect(exact).toEqual({
      outcome: 'granted',
      capability: 'scheduled_exports',
      limit: 10,
      remaining: 1,
    });

    const over = decideEntitlement({
      capability: 'scheduled_exports',
      entitlement: QUANTIFIED,
      definitionAvailability: 'available',
      used: 10,
      amount: 1,
    });
    expect(over).toEqual({
      outcome: 'refused',
      capability: 'scheduled_exports',
      reason: 'limit_reached',
    });
  });

  it('the refused branch carries NO remaining, so a caller cannot read one off it', () => {
    const refused = decideEntitlement({
      capability: 'scheduled_exports',
      entitlement: QUANTIFIED,
      definitionAvailability: 'available',
      used: 10,
      amount: 1,
    });
    expect(Object.hasOwn(refused, 'remaining')).toBe(false);
  });
});

describe('the capability vocabulary', () => {
  it('recognises a gateable key and refuses an ungateable one, and the two never overlap', () => {
    expect(isEntitlementCapability('scheduled_exports')).toBe(true);
    expect(isEntitlementCapability('order_management')).toBe(false);
    expect(isUngateableCapability('order_management')).toBe(true);
    expect(isUngateableCapability('scheduled_exports')).toBe(false);
  });
});

describe('the code catalogue', () => {
  it('defines every capability the tuple names, and no others', () => {
    expect(Object.keys(MERCHANT_CAPABILITY_CATALOG).sort()).toEqual(
      [...MERCHANT_ENTITLEMENT_CAPABILITIES].sort(),
    );
  });

  it('ships every capability as POSTPONED, which is what makes a paid plan unactivatable', () => {
    // #89's binding constraint is that this work must not put an EXISTING
    // capability behind a plan. None of the eight exists, so every one is
    // postponed — and `activateMerchantPlan` refuses a version naming one, which
    // is "do not sell a placeholder plan" as a mechanism rather than a promise.
    // When a capability genuinely ships, this test is the thing that has to
    // change in the same diff.
    for (const definition of Object.values(MERCHANT_CAPABILITY_CATALOG)) {
      expect(definition.availability, `${definition.key} claims to be implemented`).toBe(
        'postponed',
      );
    }
    expect(Object.keys(MERCHANT_CAPABILITY_CATALOG).length).toBeGreaterThanOrEqual(8);
  });

  it('has exactly ONE enforcement point, so reading and exporting cannot be gated', () => {
    // Issue #89 entitlement rule 7 as a shape: there is no `read` enforcement
    // point and no `export` one, so a capability that gated reading what a
    // merchant already has cannot be DEFINED.
    expect([...ENTITLEMENT_ENFORCEMENT_POINTS]).toEqual(['create_or_extend']);
  });
});
