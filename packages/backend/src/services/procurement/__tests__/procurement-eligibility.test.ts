/**
 * Derived eligibility and the #57 seam projection, table-tested.
 *
 * Two of #118's acceptance criteria live here: criterion 3 (no approved
 * agreement, no eligibility — affiliate access alone can never produce an
 * eligible offer) and the offer-expiry half of criterion 8. The projection
 * tests are the structural half of "public APIs can never see wholesale cost":
 * the seam's key set is pinned EXACTLY, so a new field reaching it is a
 * failing test before it is a leak.
 */

import { describe, expect, it } from 'vitest';
import type { AgreementScopeFacts } from '../agreement-scope.js';
import {
  deriveOfferFreshness,
  deriveProcurementEligibility,
  projectRetailOfferSourcingSeam,
  type EligibilityAccountFacts,
  type EligibilityInput,
  type EligibilityOfferFacts,
  type EligibilitySupplierFacts,
} from '../procurement-eligibility.js';

const NOW = new Date('2026-08-09T12:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');

function supplier(overrides: Partial<EligibilitySupplierFacts> = {}): EligibilitySupplierFacts {
  return { status: 'active', riskLevel: 'low', ...overrides };
}

function account(overrides: Partial<EligibilityAccountFacts> = {}): EligibilityAccountFacts {
  return { state: 'active', ...overrides };
}

function agreement(overrides: Partial<AgreementScopeFacts> = {}): AgreementScopeFacts {
  return {
    approvalState: 'approved',
    effectiveAt: PAST,
    expiresAt: null,
    permittedDestinationCountries: ['ES'],
    permittedChannels: ['mercaria_marketplace', 'mercaria_branded_checkout'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
    ...overrides,
  };
}

function offer(overrides: Partial<EligibilityOfferFacts> = {}): EligibilityOfferFacts {
  return {
    id: 'offer-1',
    status: 'active',
    availability: 'in_stock',
    canonicalProductId: 'canonical-product-1',
    canonicalVariantId: 'canonical-variant-1',
    eligibleDestinationCountries: ['ES'],
    lastConfirmedAt: new Date(NOW.getTime() - 60_000),
    quoteTtlSeconds: 3_600,
    expiresAt: null,
    deliveryDaysMin: 2,
    deliveryDaysMax: 5,
    ...overrides,
  };
}

function derive(overrides: Partial<EligibilityInput> = {}) {
  return deriveProcurementEligibility({
    supplier: supplier(),
    account: account(),
    agreement: agreement(),
    offer: offer(),
    destinationCountry: 'ES',
    channel: 'mercaria_marketplace',
    now: NOW,
    ...overrides,
  });
}

describe('deriveProcurementEligibility', () => {
  it('is eligible when every fact holds — and the reason list is EMPTY, not merely falsy', () => {
    expect(derive()).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ['supplier_not_active', { supplier: supplier({ status: 'suspended' as const }) }],
    ['supplier_risk_blocked', { supplier: supplier({ riskLevel: 'blocked' as const }) }],
    ['account_not_active', { account: account({ state: 'inactive' as const }) }],
    ['account_kill_switched', { account: account({ state: 'killed' as const }) }],
    ['agreement_not_approved', { agreement: agreement({ approvalState: 'draft' as const }) }],
    ['agreement_expired', { agreement: agreement({ expiresAt: PAST }) }],
    ['agreement_not_effective', { agreement: agreement({ effectiveAt: FUTURE }) }],
    [
      'agreement_rights_insufficient',
      { agreement: agreement({ blindDropshipVerified: false }) },
    ],
    [
      'destination_not_permitted',
      { agreement: agreement({ permittedDestinationCountries: ['FR'] }) },
    ],
    ['channel_not_permitted', { agreement: agreement({ permittedChannels: [] }) }],
    ['offer_retired', { offer: offer({ status: 'retired' as const }) }],
    ['offer_expired', { offer: offer({ expiresAt: PAST }) }],
    [
      'offer_quote_stale',
      { offer: offer({ lastConfirmedAt: new Date(NOW.getTime() - 7_200_000) }) },
    ],
    ['offer_unmapped', { offer: offer({ canonicalVariantId: null }) }],
    ['offer_out_of_stock', { offer: offer({ availability: 'out_of_stock' as const }) }],
    [
      'destination_not_permitted',
      { offer: offer({ eligibleDestinationCountries: ['FR'] }) },
    ],
  ] as const)('reports %s when that fact alone fails', (reason, overrides) => {
    const verdict = derive(overrides);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain(reason);
    // ONE broken fact, one reason — the fixture isolates its conjunct, and a
    // derivation that dumped unrelated reasons would fail here.
    expect(verdict.reasons).toEqual([reason]);
  });

  it('NO agreement can never be eligible — affiliate access alone produces nothing (#118 acceptance 3)', () => {
    const verdict = derive({ agreement: null });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toEqual(['agreement_missing']);
  });

  it('collects EVERY failing reason, sorted and deduped', () => {
    const verdict = derive({
      supplier: supplier({ status: 'deactivated' }),
      account: account({ state: 'killed' }),
      agreement: null,
      offer: offer({ status: 'retired', canonicalVariantId: null }),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toEqual([
      'account_kill_switched',
      'agreement_missing',
      'offer_retired',
      'offer_unmapped',
      'supplier_not_active',
    ]);
  });

  it('discounted availability values do not read as out of stock', () => {
    for (const availability of ['in_stock', 'limited', 'unknown'] as const) {
      expect(derive({ offer: offer({ availability }) }).eligible).toBe(true);
    }
    for (const availability of ['out_of_stock', 'discontinued'] as const) {
      expect(derive({ offer: offer({ availability }) }).reasons).toEqual(['offer_out_of_stock']);
    }
  });

  it('asks about no destination or channel when the question has none', () => {
    // Without a concrete destination the agreement/offer destination scopes are
    // not evaluated — the caller is asking "could this source anything at all".
    const verdict = derive({
      destinationCountry: undefined,
      channel: undefined,
      agreement: agreement({ permittedDestinationCountries: [] }),
      offer: offer({ eligibleDestinationCountries: [] }),
    });
    expect(verdict.eligible).toBe(true);
  });
});

describe('deriveOfferFreshness', () => {
  it('expired beats stale, and the expiry boundary is inclusive', () => {
    expect(
      deriveOfferFreshness(
        { lastConfirmedAt: new Date(NOW.getTime() - 7_200_000), quoteTtlSeconds: 60, expiresAt: NOW },
        NOW,
      ),
    ).toBe('expired');
    expect(
      deriveOfferFreshness({ lastConfirmedAt: NOW, quoteTtlSeconds: null, expiresAt: FUTURE }, NOW),
    ).toBe('fresh');
  });

  it('a passed quote TTL is stale; no TTL never goes stale', () => {
    const anHourAgo = new Date(NOW.getTime() - 3_600_000);
    expect(
      deriveOfferFreshness(
        { lastConfirmedAt: anHourAgo, quoteTtlSeconds: 1_800, expiresAt: null },
        NOW,
      ),
    ).toBe('stale');
    expect(
      deriveOfferFreshness({ lastConfirmedAt: anHourAgo, quoteTtlSeconds: null, expiresAt: null }, NOW),
    ).toBe('fresh');
  });
});

describe('projectRetailOfferSourcingSeam — the structural leak gate', () => {
  it('carries EXACTLY the seam fields, nothing else', () => {
    const seam = projectRetailOfferSourcingSeam(offer(), { eligible: true, reasons: [] });
    expect(Object.keys(seam).sort()).toEqual([
      'availability',
      'canonicalProductId',
      'canonicalVariantId',
      'eligibility',
      'estimatedDeliveryDaysMin',
      'estimatedDeliveryDaysMax',
      'procurementOfferId',
    ].sort());
  });

  it('has no property that could carry a cost, a currency of cost or a credential', () => {
    // The negative space is the point: `RetailOfferSourcingSeam` must be
    // STRUCTURALLY unable to leak (#118: "must never leak wholesale cost,
    // supplier credentials or contract terms to public product APIs").
    const seam = projectRetailOfferSourcingSeam(offer(), {
      eligible: false,
      reasons: ['offer_unmapped'],
    });
    for (const forbidden of [
      'unitCostAmount',
      'unitCostCurrency',
      'credentialReference',
      'supplierId',
      'supplierAccountId',
      'agreementId',
      'supplierSku',
    ]) {
      expect(seam, `seam must not carry ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });
});
