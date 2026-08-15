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
    // #85 shipped the P2P acceptance surface, so this is now a fact a record
    // CAN satisfy. The best case accepts; the case below un-accepts it.
    sellerPoliciesAccepted: known(true),
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

  it('evaluates policy acceptance now that #85 supplies it, and refuses without one', () => {
    // CLOSED: the criterion was `unevaluable`/`#85` until #85 shipped
    // `POST /seller/activation/policies`. It is now answered from
    // `merchant_activation_policy_acceptances` with `owner_type = 'user'`.
    expect(outcomeOf(bestCaseFacts(), 'policies_accepted')).toBe('satisfied');
    expect(
      outcomeOf(bestCaseFacts({ sellerPoliciesAccepted: known(false) }), 'policies_accepted'),
    ).toBe('refused');
    // An acceptance is not a licence: #112's verdict is a recorded no-go and the
    // three criteria below still refuse, so a seller who accepts everything
    // still cannot sell to a guest.
    expect(eligibility.verdict).not.toBe('eligible');
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
  it('REFUSES a pickup destination — #93 landed, so it is no longer unevaluable', () => {
    // This case used to sit in the `unevaluable` block naming #93 as the owner,
    // because a collection had no publication, freshness or hours to check
    // against. #93 supplies all three, and supplies them for a STORE's
    // `locations` row: an individual has no publication and cannot acquire one,
    // and `derivePickupEligibility` refuses a `user` seller for every actor.
    //
    // So the answer moved from "we cannot tell" to "no". Both block, which is
    // why no guest checkout changes; what changes is that an operator trace no
    // longer reports a missing capability that has since arrived.
    const facts = bestCaseFacts({ context: { ...CONTEXT, fulfilment: 'pickup' } });
    const entry = deriveGuestP2PEligibility(facts).criteria.find(
      (c) => c.criterion === 'fulfilment_method_permitted',
    );
    expect(entry?.outcome).toBe('refused');
    // The whole verdict still blocks, which is the property that matters.
    expect(deriveGuestP2PEligibility(facts).verdict).toBe('ineligible');
  });

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
  it('no criterion is unevaluable by AVAILABILITY any more — only an unknown fact is', () => {
    // This case has now outlived its premise TWICE, which is the point of
    // re-deriving it rather than editing the citation. #112 wrote it as "one is
    // unevaluable and names #85"; #85 closed `policies_accepted`, so it became
    // "one is unevaluable and names #93" against the pickup context; #93 then
    // shipped and moved `fulfilment_method_permitted` from `unevaluable` to
    // `refused`, because a collection from an individual has no publication and
    // cannot acquire one — "no" rather than "we cannot tell".
    //
    // So the honest claim today is the ABSENCE: with both seams filled, no
    // criterion is unevaluable by its registry availability, in EITHER
    // fulfilment context. The only route left is an unknown FACT.
    for (const fulfilment of ['shipping', 'pickup'] as const) {
      const facts = bestCaseFacts({
        context: {
          ...CONTEXT,
          fulfilment,
          shippingMethod: fulfilment === 'pickup' ? 'pickup' : CONTEXT.shippingMethod,
        },
      });
      const eligibility = deriveGuestP2PEligibility(facts);
      expect(
        eligibility.criteria.filter((entry) => entry.outcome === 'unevaluable'),
        `a criterion is unevaluable for ${fulfilment} — re-derive the citation`,
      ).toEqual([]);
      // Every criterion is still ANSWERED, which is what stops the assertion
      // above passing against a derivation that returned nothing at all.
      expect(eligibility.criteria.length).toBe(GUEST_P2P_CRITERIA.length);
      // Both seams BLOCK either way, so nothing about the verdict moved.
      expect(eligibility.verdict).toBe('ineligible');
    }
  });

  it('an unknown FACT is the one remaining route to unevaluable, and it names its owner', () => {
    // The positive control for the case above: without it, a derivation that
    // could never answer `unevaluable` at all would pass, and the absence would
    // be measuring nothing.
    // `payoutReady` unknown is the deployment's gap — a rail that is off cannot
    // answer whether anybody is ready for it — and it is the fact `facts.ts`
    // marks `deployment` rather than blaming a seller who has done nothing.
    const facts = bestCaseFacts({ payoutReady: unknown('deployment') });
    const unevaluable = deriveGuestP2PEligibility(facts).criteria.filter(
      (entry) => entry.outcome === 'unevaluable',
    );
    expect(unevaluable.map((entry) => entry.criterion)).toEqual(['stripe_payout_ready']);
    for (const entry of unevaluable) {
      if (entry.outcome === 'unevaluable') expect(entry.owner).toBe('deployment');
    }
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
