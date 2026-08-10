/**
 * The #74 seam and the shadow comparison — the two small modules whose whole
 * value is a DEFAULT, which is exactly the kind of thing a suite forgets to
 * pin.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Offer } from '@mercaria/shared-types';
import {
  registerSearchOfferSelector,
  resetSearchOfferSelector,
  selectSearchOffer,
} from '../selected-offer.port.js';
import {
  classifyShadowComparison,
  readShadowComparisons,
  recordShadowComparison,
  resetShadowComparisons,
} from '../shadow.js';

afterEach(() => {
  resetSearchOfferSelector();
  resetShadowComparisons();
});

/** The narrowest thing that type-checks as an `Offer` for a selector's input. */
function fakeOffer(id: string): Offer {
  return { id } as unknown as Offer;
}

describe('the #74 offer-selection seam', () => {
  it('FAILS CLOSED — no selector registered means no lead offer', () => {
    // The property the whole module exists for. A default that picked "the
    // cheapest" would be a ranking decision made under a name that does not say
    // so, and it would look exactly like #74 having shipped.
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })).toBeUndefined();
  });

  it('asks a registered selector and returns its answer', () => {
    registerSearchOfferSelector((input) => ({
      offerId: input.offers[0]?.id ?? '',
      kind: 'external',
      availability: 'in_stock',
      rankingPolicyVersion: 'rp-test',
    }));
    const selected = selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] });
    expect(selected?.offerId).toBe('o1');
    expect(selected?.rankingPolicyVersion).toBe('rp-test');
  });

  it('lets a selector DECLINE without emptying the result', () => {
    registerSearchOfferSelector(() => undefined);
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })).toBeUndefined();
  });

  it('a throwing selector degrades the result instead of failing the page', () => {
    // A ranking fault must cost a lead offer, never a search.
    registerSearchOfferSelector(() => {
      throw new Error('selector exploded');
    });
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })).toBeUndefined();
  });

  it('a second registration REPLACES the first rather than stacking', () => {
    // Two selectors would be two rankings. Asserted through the observable
    // effect — the second one answers — rather than through a spy on the log
    // line: a `vi.fn()` that is never wired into the code under test always
    // "passes", which is the check-that-cannot-fail shape (`~/Oxy/AGENTS.md`).
    registerSearchOfferSelector(() => ({
      offerId: 'first',
      kind: 'external',
      availability: 'in_stock',
      rankingPolicyVersion: 'rp-first',
    }));
    registerSearchOfferSelector(() => ({
      offerId: 'second',
      kind: 'external',
      availability: 'in_stock',
      rankingPolicyVersion: 'rp-second',
    }));
    expect(selectSearchOffer({ canonicalProductId: 'p1', offers: [fakeOffer('o1')] })?.offerId).toBe(
      'second',
    );
  });
});

describe('the shadow comparison', () => {
  it('classifies the four ways two answers can differ', () => {
    expect(classifyShadowComparison(3, 2)).toBe('both_returned');
    expect(classifyShadowComparison(3, 0)).toBe('canonical_only');
    // The direction a rollout must not regress in: the old path found
    // something the new one did not.
    expect(classifyShadowComparison(0, 2)).toBe('listing_only');
    expect(classifyShadowComparison(0, 0)).toBe('both_empty');
  });

  it('accumulates counts and result totals', () => {
    recordShadowComparison(3, 2);
    recordShadowComparison(0, 1);
    const counters = readShadowComparisons();
    expect(counters.queries).toBe(2);
    expect(counters.bothReturned).toBe(1);
    expect(counters.listingOnly).toBe(1);
    expect(counters.canonicalResults).toBe(3);
    expect(counters.listingResults).toBe(3);
  });
});
