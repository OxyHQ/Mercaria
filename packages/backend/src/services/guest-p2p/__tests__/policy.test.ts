/**
 * The guest-P2P policy: the census, the prohibitions, and the derivation over
 * every criterion (#112 acceptance 4 — "server-authoritative and explainable").
 *
 * The census is the load-bearing part. A criterion published but never
 * evaluated, or evaluated but never published, is exactly how a policy becomes
 * a document that describes a system nobody built — the `merge-plan-census`
 * device, applied to twenty rules.
 */

import { describe, expect, it } from 'vitest';
import {
  GUEST_P2P_CRITERIA,
  GUEST_P2P_FORBIDDEN_CRITERIA,
  GUEST_P2P_LISTING_CRITERIA,
  GUEST_P2P_MISSING_INPUT_OWNERS,
  GUEST_P2P_SELLER_CRITERIA,
  type GuestP2PCriterion,
} from '@mercaria/shared-types';
import {
  deriveGuestP2PEligibility,
  known,
  unknown,
  type GuestP2PCheckoutContext,
  type GuestP2PFacts,
} from '../eligibility.js';
import {
  GUEST_P2P_BOUNDED_SCOPE,
  GUEST_P2P_POLICY_VERSION,
  publishedGuestP2PCriteria,
  registeredGuestP2PCriteria,
} from '../policy.js';

const CONTEXT: GuestP2PCheckoutContext = {
  quantity: 1,
  destinationCountry: 'ES',
  presentmentCurrency: 'EUR',
  fulfilment: 'shipping',
  shippingMethod: 'standard',
  checkoutContainsNonP2PSeller: false,
};

/**
 * A seller and listing that satisfy everything a record CAN satisfy.
 *
 * Deliberately the best case: the criteria that still come out short are the
 * ones no record can answer, which is the point the decision document rests on.
 */
function bestCaseFacts(overrides: Partial<GuestP2PFacts> = {}): GuestP2PFacts {
  return {
    sellerKey: 'user:seller-9',
    listingId: 'listing-1',
    payoutReady: known(true),
    sellerVisibility: known('visible'),
    trustTier: known('trusted'),
    completedSales: known(50),
    sellerPayoutCountry: known('ES'),
    listingActive: true,
    listingRestricted: false,
    categorySlugs: ['books'],
    conditionRefined: true,
    conditionAcknowledged: true,
    conditionDetailCount: 2,
    evidentialPhotoCount: 5,
    unitPrice: known({ amount: 1_000, currency: 'EUR' }),
    context: CONTEXT,
    ...overrides,
  };
}

/** The outcome recorded for one criterion. */
function outcomeOf(facts: GuestP2PFacts, criterion: GuestP2PCriterion): string {
  const entry = deriveGuestP2PEligibility(facts).criteria.find(
    (candidate) => candidate.criterion === criterion,
  );
  if (!entry) throw new Error(`criterion ${criterion} was not evaluated`);
  return entry.outcome;
}

describe('the census: every criterion is published and every one is evaluated', () => {
  it('has a registry entry for every criterion and no others', () => {
    expect([...registeredGuestP2PCriteria()].sort()).toEqual([...GUEST_P2P_CRITERIA].sort());
  });

  it('publishes exactly the vocabulary, in the issue order', () => {
    expect(publishedGuestP2PCriteria().map((entry) => entry.criterion)).toEqual([
      ...GUEST_P2P_SELLER_CRITERIA,
      ...GUEST_P2P_LISTING_CRITERIA,
    ]);
  });

  it('evaluates every criterion — no member is silently skipped', () => {
    const evaluated = deriveGuestP2PEligibility(bestCaseFacts()).criteria.map(
      (entry) => entry.criterion,
    );
    expect([...evaluated].sort()).toEqual([...GUEST_P2P_CRITERIA].sort());
    // A vacuity floor: an empty vocabulary would satisfy the equality above.
    expect(GUEST_P2P_SELLER_CRITERIA.length).toBe(10);
    expect(GUEST_P2P_LISTING_CRITERIA.length).toBe(10);
  });

  it('keeps the seller and listing tuples disjoint', () => {
    const overlap = GUEST_P2P_SELLER_CRITERIA.filter((criterion) =>
      (GUEST_P2P_LISTING_CRITERIA as readonly string[]).includes(criterion),
    );
    expect(overlap).toEqual([]);
  });

  it('publishes a requirement sentence for every criterion', () => {
    for (const entry of publishedGuestP2PCriteria()) {
      expect(entry.requirement.length).toBeGreaterThan(10);
    }
  });

  it('names a real owner on every criterion whose input or capability is missing', () => {
    for (const entry of publishedGuestP2PCriteria()) {
      if (entry.availability.state === 'evaluated') continue;
      if (entry.availability.state === 'nothing_to_restrict') {
        expect(entry.availability.reason.length).toBeGreaterThan(10);
        continue;
      }
      expect(GUEST_P2P_MISSING_INPUT_OWNERS).toContain(entry.availability.owner);
    }
  });
});

describe('the prohibitions are values, disjoint from the criteria', () => {
  it('shares no member with the criterion vocabulary', () => {
    const criteria = new Set<string>(GUEST_P2P_CRITERIA);
    for (const forbidden of GUEST_P2P_FORBIDDEN_CRITERIA) {
      expect(criteria.has(forbidden)).toBe(false);
    }
  });

  it('names the ten inputs #112 forbids, so an addition is a build failure', () => {
    expect(GUEST_P2P_FORBIDDEN_CRITERIA).toContain('buyer_public_identity');
    expect(GUEST_P2P_FORBIDDEN_CRITERIA).toContain('reusable_buyer_handle');
    expect(GUEST_P2P_FORBIDDEN_CRITERIA).toContain('guest_trust_score');
    expect(GUEST_P2P_FORBIDDEN_CRITERIA).toContain('auto_created_oxy_account');
    expect(GUEST_P2P_FORBIDDEN_CRITERIA).toContain('guest_status_ranking_penalty');
    expect(GUEST_P2P_FORBIDDEN_CRITERIA.length).toBe(10);
  });
});

describe('the best case is still not eligible, and the reasons are the honest ones', () => {
  const eligibility = deriveGuestP2PEligibility(bestCaseFacts());

  it('answers `ineligible`, because two capabilities do not exist', () => {
    expect(eligibility.verdict).toBe('ineligible');
  });

  it('refuses on the P2P refund path and on seller messaging', () => {
    expect(outcomeOf(bestCaseFacts(), 'no_oxy_only_buyer_capability')).toBe('refused');
    expect(outcomeOf(bestCaseFacts(), 'messaging_available')).toBe('refused');
  });

  it('cannot evaluate policy acceptance, and says #85 owes it', () => {
    const entry = eligibility.criteria.find((c) => c.criterion === 'policies_accepted');
    expect(entry?.outcome).toBe('unevaluable');
    if (entry?.outcome === 'unevaluable') expect(entry.owner).toBe('#85');
  });

  it('refuses on the empty category allow-list — an unchosen cohort admits nothing', () => {
    expect(GUEST_P2P_BOUNDED_SCOPE.permittedCategorySlugs).toEqual([]);
    expect(outcomeOf(bestCaseFacts(), 'category_permitted')).toBe('refused');
  });

  it('stamps the policy version on the answer', () => {
    expect(eligibility.policyVersion).toBe(GUEST_P2P_POLICY_VERSION);
  });
});

describe('unknown never passes, and it is not a refusal either', () => {
  it('blocks a pickup destination and names #93 (the not-applicable branch)', () => {
    const facts = bestCaseFacts({ context: { ...CONTEXT, fulfilment: 'pickup' } });
    const entry = deriveGuestP2PEligibility(facts).criteria.find(
      (c) => c.criterion === 'fulfilment_method_permitted',
    );
    expect(entry?.outcome).toBe('unevaluable');
    if (entry?.outcome === 'unevaluable') expect(entry.owner).toBe('#93');
  });

  it('blocks a rail that is off rather than blaming the seller', () => {
    const facts = bestCaseFacts({ payoutReady: unknown('deployment') });
    const entry = deriveGuestP2PEligibility(facts).criteria.find(
      (c) => c.criterion === 'stripe_payout_ready',
    );
    expect(entry?.outcome).toBe('unevaluable');
  });

  it('blocks a price in a currency the cohort does not name, never converting it', () => {
    const facts = bestCaseFacts({ unitPrice: known({ amount: 1_000, currency: 'USD' }) });
    expect(outcomeOf(facts, 'value_within_cap')).toBe('unevaluable');
  });

  it('blocks when Oxy answered nothing at all about the seller', () => {
    const facts = bestCaseFacts({
      trustTier: unknown('oxy'),
      completedSales: unknown('deployment'),
    });
    expect(outcomeOf(facts, 'trust_or_transaction_history')).toBe('unevaluable');
  });

  it('accepts history alone when Trust is silent — a disjunction, not a conjunction', () => {
    const facts = bestCaseFacts({ trustTier: unknown('oxy'), completedSales: known(50) });
    expect(outcomeOf(facts, 'trust_or_transaction_history')).toBe('satisfied');
  });

  it('accepts Trust alone when the seller has sold nothing yet', () => {
    const facts = bestCaseFacts({ completedSales: known(0) });
    expect(outcomeOf(facts, 'trust_or_transaction_history')).toBe('satisfied');
  });

  it('refuses when both sides answered and neither reaches the bar', () => {
    const facts = bestCaseFacts({ trustTier: known('new'), completedSales: known(1) });
    expect(outcomeOf(facts, 'trust_or_transaction_history')).toBe('refused');
  });
});

describe('the record-backed criteria refuse what the record says', () => {
  it('refuses a restricted listing (a CrowdSource enforcement)', () => {
    const facts = bestCaseFacts({ listingActive: false, listingRestricted: true });
    expect(outcomeOf(facts, 'no_active_restriction')).toBe('refused');
  });

  it('refuses an excluded category even against an allow-list that named it', () => {
    const excluded = GUEST_P2P_BOUNDED_SCOPE.excludedCategorySlugs[0] ?? 'weapons';
    const facts = bestCaseFacts({ categorySlugs: ['books', excluded] });
    expect(outcomeOf(facts, 'category_not_excluded')).toBe('refused');
  });

  it('matches an excluded ANCESTOR slug, so excluding a parent excludes the subtree', () => {
    const facts = bestCaseFacts({ categorySlugs: ['single-malt', 'alcohol'] });
    expect(outcomeOf(facts, 'category_not_excluded')).toBe('refused');
  });

  it('refuses a line above the value cap, and admits one exactly at it', () => {
    const cap = GUEST_P2P_BOUNDED_SCOPE.maxLineValueMinorUnits;
    expect(
      outcomeOf(bestCaseFacts({ unitPrice: known({ amount: cap + 1, currency: 'EUR' }) }), 'value_within_cap'),
    ).toBe('refused');
    expect(
      outcomeOf(bestCaseFacts({ unitPrice: known({ amount: cap, currency: 'EUR' }) }), 'value_within_cap'),
    ).toBe('satisfied');
  });

  it('refuses a quantity above one', () => {
    const facts = bestCaseFacts({ context: { ...CONTEXT, quantity: 2 } });
    expect(outcomeOf(facts, 'quantity_one')).toBe('refused');
  });

  it('refuses a cross-border sale', () => {
    const facts = bestCaseFacts({ context: { ...CONTEXT, destinationCountry: 'FR' } });
    expect(outcomeOf(facts, 'domestic_only')).toBe('refused');
  });

  it('refuses a mixed store-and-P2P checkout, which shares ONE PaymentIntent', () => {
    const facts = bestCaseFacts({
      context: { ...CONTEXT, checkoutContainsNonP2PSeller: true },
    });
    expect(outcomeOf(facts, 'no_mixed_store_and_p2p_payment')).toBe('refused');
  });

  it('refuses too few actual-item photos', () => {
    const facts = bestCaseFacts({ evidentialPhotoCount: 0 });
    expect(outcomeOf(facts, 'actual_item_photos_present')).toBe('refused');
  });

  it('refuses an unrefined condition and a listing with no disclosed defects', () => {
    expect(outcomeOf(bestCaseFacts({ conditionRefined: false }), 'normalized_condition_and_defects')).toBe(
      'refused',
    );
    expect(
      outcomeOf(bestCaseFacts({ conditionDetailCount: 0 }), 'normalized_condition_and_defects'),
    ).toBe('refused');
  });

  it('refuses a seller whose Oxy profile is private or trust-restricted', () => {
    for (const visibility of ['private', 'restricted'] as const) {
      expect(outcomeOf(bestCaseFacts({ sellerVisibility: known(visibility) }), 'oxy_identity_state')).toBe(
        'refused',
      );
    }
  });
});

describe('the verdict severity: ineligible beats unknown beats eligible', () => {
  it('reports `unknown` when nothing is refused but something is unanswered', () => {
    // Every refusal the best case carries is removed by hand, leaving only the
    // #85 gap — which is the shape a verdict of `unknown` describes.
    const facts = bestCaseFacts({
      categorySlugs: ['books'],
    });
    const criteria = deriveGuestP2PEligibility(facts).criteria.filter(
      (entry) => entry.outcome === 'unevaluable',
    );
    expect(criteria.length).toBeGreaterThan(0);
    // With refusals present the verdict is the harsher one, which is the rule.
    expect(deriveGuestP2PEligibility(facts).verdict).toBe('ineligible');
  });

  it('never answers `eligible` today, for any facts a record could produce', () => {
    const variants: GuestP2PFacts[] = [
      bestCaseFacts(),
      bestCaseFacts({ categorySlugs: ['books', 'fiction'] }),
      bestCaseFacts({ completedSales: known(1_000), trustTier: known('established') }),
      bestCaseFacts({ evidentialPhotoCount: 99 }),
    ];
    for (const facts of variants) {
      expect(deriveGuestP2PEligibility(facts).verdict).not.toBe('eligible');
    }
  });
});
