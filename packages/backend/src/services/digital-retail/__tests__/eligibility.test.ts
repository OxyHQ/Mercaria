/**
 * The digital procurement eligibility derivation (#1016, ADR 0011 D4).
 *
 * Driven against FIXTURES rather than rows, which is the whole point of the
 * function being pure: every combination below is one a database would take
 * minutes to arrange and which no realistic seed would ever produce by accident.
 *
 * The base fixture is deliberately ELIGIBLE, so every case here is one mutation
 * away from a pass and the reason it produces is attributable to that mutation.
 */

import { describe, expect, it } from 'vitest';
import { DIGITAL_PROCUREMENT_INELIGIBILITY_REASONS } from '@mercaria/shared-types';
import {
  deriveDigitalOfferFreshness,
  deriveDigitalProcurementEligibility,
  type DigitalEligibilityInput,
} from '../eligibility.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const HOUR = 3_600_000;

/** An eligible everything. Each test mutates exactly one part of it. */
function base(): DigitalEligibilityInput {
  return {
    supplier: { status: 'active', riskLevel: 'low' },
    account: { state: 'active', purchaseCapabilityState: 'enabled' },
    terms: {
      provenance: 'authorized_distributor',
      agreementApprovalState: 'approved',
      agreementEffectiveAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
      agreementExpiresAt: new Date(NOW.getTime() + 365 * 24 * HOUR),
      termsExpiresAt: null,
      resaleRightsGranted: true,
      permittedProductClasses: ['digital_game'],
      permittedFulfilmentCapabilities: ['activation_key'],
      permittedTerritories: ['ES', 'FR'],
      excludedBrands: [],
      maxOrderCostAmount: null,
      maxOrderCostCurrency: null,
    },
    offer: {
      id: 'offer-1',
      status: 'active',
      mappingStatus: 'exact',
      availability: 'in_stock',
      canonicalProductId: 'prod-1',
      canonicalVariantId: 'var-1',
      productClass: 'digital_game',
      fulfilmentCapability: 'activation_key',
      brandSlug: 'studio-x',
      activationTerritories: ['ES', 'FR'],
      costAmount: 1_800,
      costCurrency: 'EUR',
      quoteTtlSeconds: 900,
      expiresAt: null,
      lastConfirmedAt: new Date(NOW.getTime() - 60_000),
      expectedFulfilmentSeconds: 10,
    },
    activationTerritory: 'ES',
    requiredCapability: 'activation_key',
    maxAcceptedCostAmount: 2_000,
    procurementEnabled: true,
    now: NOW,
  };
}

describe('the base fixture', () => {
  it('is eligible, so every refusal below is attributable to its own mutation', () => {
    expect(deriveDigitalProcurementEligibility(base())).toEqual({ eligible: true, reasons: [] });
  });
});

describe('the mapping gate — ADR 0011 D4', () => {
  it('refuses an AMBIGUOUS mapping, which is the reason this domain exists', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      offer: { ...input.offer, mappingStatus: 'ambiguous' },
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain('offer_mapping_ambiguous');
  });

  it('refuses an unmapped offer, and says so as `offer_unmapped`', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      offer: { ...input.offer, mappingStatus: 'unmapped', canonicalVariantId: null },
    });
    expect(verdict.reasons).toContain('offer_unmapped');
    expect(verdict.reasons).not.toContain('offer_mapping_ambiguous');
  });
});

describe('the supply rider — the epic invariant 4', () => {
  it('refuses everything when there is NO rider: an account is not a grant', () => {
    const verdict = deriveDigitalProcurementEligibility({ ...base(), terms: null });
    expect(verdict.reasons).toEqual(['terms_missing']);
  });

  it('refuses a product class the rider does not name', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, permittedProductClasses: ['software_licence'] },
    });
    expect(verdict.reasons).toContain('product_class_not_permitted');
  });

  it('refuses a capability the rider does not name', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, permittedFulfilmentCapabilities: ['licence_file'] },
    });
    expect(verdict.reasons).toContain('capability_not_permitted');
  });

  it('reads an EMPTY territory list as NONE, never as worldwide', () => {
    // The `supplier_agreements` semantics: an agreement GRANTS, and a grant that
    // names no territory grants none. The opposite reading is what
    // `commerce_relationships.territories` uses, and confusing the two would
    // publish everything a supplier never authorized.
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, permittedTerritories: [] },
    });
    expect(verdict.reasons).toContain('territory_not_permitted');
  });

  it('refuses a brand the rider carves out', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, excludedBrands: ['studio-x'] },
    });
    expect(verdict.reasons).toContain('brand_excluded');
  });

  it('refuses a rider that grants no resale rights, however approved it is', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, resaleRightsGranted: false },
    });
    expect(verdict.eligible).toBe(false);
  });

  it('distinguishes an expired agreement from one that has not started', () => {
    const input = base();
    const expired = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, agreementExpiresAt: new Date(NOW.getTime() - HOUR) },
    });
    expect(expired.reasons).toContain('agreement_expired');

    const future = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, agreementEffectiveAt: new Date(NOW.getTime() + HOUR) },
    });
    expect(future.reasons).toContain('agreement_not_effective');
  });

  it('expires on the RIDER’s own end date, not only the agreement’s', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, termsExpiresAt: new Date(NOW.getTime() - HOUR) },
    });
    expect(verdict.reasons).toContain('agreement_expired');
  });
});

describe('the account and its capability', () => {
  it('tells a MISSING purchase capability from a PAUSED one', () => {
    const input = base();
    const missing = deriveDigitalProcurementEligibility({
      ...input,
      account: { ...input.account, purchaseCapabilityState: null },
    });
    expect(missing.reasons).toContain('capability_missing');

    const paused = deriveDigitalProcurementEligibility({
      ...input,
      account: { ...input.account, purchaseCapabilityState: 'paused' },
    });
    expect(paused.reasons).toContain('capability_paused');
    expect(paused.reasons).not.toContain('capability_missing');
  });

  it('tells a kill switch from an inactive account', () => {
    const input = base();
    expect(
      deriveDigitalProcurementEligibility({
        ...input,
        account: { ...input.account, state: 'killed' },
      }).reasons,
    ).toContain('account_kill_switched');
    expect(
      deriveDigitalProcurementEligibility({
        ...input,
        account: { ...input.account, state: 'inactive' },
      }).reasons,
    ).toContain('account_not_active');
  });
});

describe('the cost bound — ADR 0011 D7', () => {
  it('refuses a cost above the order’s ceiling', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({ ...input, maxAcceptedCostAmount: 1_500 });
    expect(verdict.reasons).toContain('cost_above_bound');
  });

  it('refuses a cost above the RIDER’s per-order ceiling, in the same currency', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, maxOrderCostAmount: 1_000, maxOrderCostCurrency: 'EUR' },
    });
    expect(verdict.reasons).toContain('cost_above_bound');
  });

  it('does NOT compare two amounts in different currencies', () => {
    // A ceiling in USD says nothing about a cost in EUR, and comparing them would
    // refuse or admit by accident depending on the exchange rate nobody applied.
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, maxOrderCostAmount: 1, maxOrderCostCurrency: 'USD' },
    });
    expect(verdict.reasons).not.toContain('cost_above_bound');
  });
});

describe('the offer’s own facts', () => {
  it('reads an EMPTY activation-territory list as unrestricted, unlike the rider', () => {
    // The asymmetry is deliberate and is the one place the two array semantics
    // differ: a rider AUTHORIZES and an offer DESCRIBES.
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      offer: { ...input.offer, activationTerritories: [] },
    });
    expect(verdict).toEqual({ eligible: true, reasons: [] });
  });

  it('refuses an offer whose activation territories exclude the buyer’s', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      offer: { ...input.offer, activationTerritories: ['DE'] },
    });
    expect(verdict.reasons).toContain('territory_not_permitted');
  });

  it('refuses a stale quote and an expired one, and prefers `expired`', () => {
    const input = base();
    const stale = deriveDigitalProcurementEligibility({
      ...input,
      offer: { ...input.offer, lastConfirmedAt: new Date(NOW.getTime() - 2 * HOUR) },
    });
    expect(stale.reasons).toContain('offer_quote_stale');

    const expired = deriveDigitalProcurementEligibility({
      ...input,
      offer: {
        ...input.offer,
        lastConfirmedAt: new Date(NOW.getTime() - 2 * HOUR),
        expiresAt: new Date(NOW.getTime() - HOUR),
      },
    });
    expect(expired.reasons).toContain('offer_expired');
  });

  it('refuses a capability the LINE did not ask for', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      requiredCapability: 'redemption_code',
    });
    expect(verdict.reasons).toContain('capability_not_permitted');
  });
});

describe('the deployment lever', () => {
  it('refuses everything when procurement is disabled, without hiding the rest', () => {
    const verdict = deriveDigitalProcurementEligibility({ ...base(), procurementEnabled: false });
    expect(verdict.reasons).toEqual(['procurement_disabled']);
  });
});

describe('the reason vocabulary', () => {
  it('only ever produces members of the closed tuple', () => {
    // A reason nobody declared would render as an empty string in an operator
    // surface and would be invisible to a filter.
    const input = base();
    const everything = deriveDigitalProcurementEligibility({
      ...input,
      supplier: { status: 'suspended', riskLevel: 'blocked' },
      account: { state: 'killed', purchaseCapabilityState: null },
      terms: null,
      offer: {
        ...input.offer,
        status: 'retired',
        mappingStatus: 'ambiguous',
        availability: 'out_of_stock',
        canonicalVariantId: null,
      },
      maxAcceptedCostAmount: 1,
      procurementEnabled: false,
    });
    expect(everything.reasons.length).toBeGreaterThan(5);
    for (const reason of everything.reasons) {
      expect(DIGITAL_PROCUREMENT_INELIGIBILITY_REASONS).toContain(reason);
    }
  });

  it('sorts and dedupes, so two surfaces cannot render one verdict differently', () => {
    const input = base();
    const verdict = deriveDigitalProcurementEligibility({
      ...input,
      terms: { ...input.terms!, permittedTerritories: [] },
      offer: { ...input.offer, activationTerritories: ['DE'] },
    });
    // `territory_not_permitted` is reachable from BOTH the rider and the offer.
    expect(verdict.reasons.filter((reason) => reason === 'territory_not_permitted')).toHaveLength(1);
    expect([...verdict.reasons].sort()).toEqual(verdict.reasons);
  });
});

describe('freshness is derived from the clock, never stored', () => {
  it('answers fresh, stale and expired from the same three columns', () => {
    const lastConfirmedAt = new Date(NOW.getTime() - 60_000);
    expect(
      deriveDigitalOfferFreshness({ lastConfirmedAt, quoteTtlSeconds: 900, expiresAt: null }, NOW),
    ).toBe('fresh');
    expect(
      deriveDigitalOfferFreshness({ lastConfirmedAt, quoteTtlSeconds: 30, expiresAt: null }, NOW),
    ).toBe('stale');
    expect(
      deriveDigitalOfferFreshness(
        { lastConfirmedAt, quoteTtlSeconds: 900, expiresAt: new Date(NOW.getTime() - 1) },
        NOW,
      ),
    ).toBe('expired');
  });

  it('treats a NULL ttl as no ttl rather than as zero', () => {
    expect(
      deriveDigitalOfferFreshness(
        { lastConfirmedAt: new Date(0), quoteTtlSeconds: null, expiresAt: null },
        NOW,
      ),
    ).toBe('fresh');
  });
});
