/**
 * Mercaria's report reasons → the baseline taxonomy, and what the registry
 * actually delivers.
 *
 * Both are things no response body would ever reveal: a shopper gets the same 201
 * whether their report opens a case or sits in a table forever, and a category
 * mapped to the wrong code sends a jury a claim nobody made. So both get pinned
 * here, where changing them is a deliberate act with an argument attached.
 */

import { describe, it, expect } from 'vitest';
import {
  ABUSE_REPORT_CATEGORIES,
  ABUSE_REPORTED_TYPES,
  type AbuseReportCategory,
} from '@mercaria/shared-types';
import { UNIVERSAL_TAXONOMY_CODES } from '@oxyhq/crowdsource-contracts';
import { toTaxonomyCodes } from '../moderation/report-taxonomy.js';
import { deliverableTypes, subjectProviderFor } from '../moderation/subjects/registry.js';

describe('every Mercaria category maps to a REAL baseline code', () => {
  it.each(ABUSE_REPORT_CATEGORIES)('%s', (category) => {
    const codes = toTaxonomyCodes([category]);
    expect(codes).toHaveLength(1);

    /**
     * Checked against the contract's own list rather than a copy. Three codes
     * assumed while writing this mapping (`deception.fraud`, `hate.generic`,
     * `spam.generic`) turned out not to exist; a hand-maintained expectation here
     * would have agreed with the bug.
     */
    expect(UNIVERSAL_TAXONOMY_CODES).toContain(codes[0]);
  });

  it('covers the whole union with no gaps', () => {
    // A category with no mapping would return an empty allegation list, and a
    // report with no allegations is a question a jury cannot be asked.
    for (const category of ABUSE_REPORT_CATEGORIES) {
      expect(toTaxonomyCodes([category])).not.toHaveLength(0);
    }
  });

  it('uses the commerce family for the commerce claims', () => {
    expect(toTaxonomyCodes(['counterfeit'])).toEqual(['commerce.counterfeit']);
    expect(toTaxonomyCodes(['prohibited_item'])).toEqual(['commerce.prohibited_item']);
    expect(toTaxonomyCodes(['misleading_listing'])).toEqual(['commerce.misleading_listing']);
    expect(toTaxonomyCodes(['unsafe_product'])).toEqual(['commerce.unsafe_product']);
  });

  it('treats stolen goods as prohibited, not as deception', () => {
    // The objection is that the item may not be sold at all, however it is
    // described.
    expect(toTaxonomyCodes(['stolen_goods'])).toEqual(['commerce.prohibited_item']);
  });
});

describe('allegations are deterministic across deliveries', () => {
  it('SORTS the codes', () => {
    /**
     * Not cosmetic. Ingress fingerprints the whole envelope, so anything that
     * varies between two deliveries of one report turns a legitimate outbox retry
     * into a permanent 409 — surfacing days later as a report stuck in a queue,
     * with nothing having failed in a test.
     */
    const one = toTaxonomyCodes(['spam', 'counterfeit', 'unsafe_product']);
    const other = toTaxonomyCodes(['unsafe_product', 'spam', 'counterfeit']);
    expect(one).toEqual(other);
    expect(one).toEqual([...one].sort());
  });

  it('DEDUPES categories that mean the same claim', () => {
    // Ticking both must not allege the same thing twice.
    const codes = toTaxonomyCodes(['prohibited_item', 'stolen_goods']);
    expect(codes).toEqual(['commerce.prohibited_item']);
  });

  it('is stable for the same input', () => {
    const input: AbuseReportCategory[] = ['scam', 'hateful_content'];
    expect(toTaxonomyCodes(input)).toEqual(toTaxonomyCodes(input));
  });
});

describe('the delivered surface is pinned', () => {
  it('delivers exactly listing and review', () => {
    /**
     * Widening this set is a real decision — it means a new kind of object starts
     * going in front of a jury — and it is invisible in every response body. If
     * this assertion fails, the fix is to write down the argument for the new
     * provider, not to update the list.
     */
    expect(deliverableTypes().sort()).toEqual(['listing', 'review']);
  });

  it('accepts MORE types than it delivers', () => {
    // The API contract is deliberately wider than the registry. Gating the route
    // on the registry would make adopting CrowdSource a breaking change for every
    // report surface not yet wired to it.
    expect(ABUSE_REPORTED_TYPES.length).toBeGreaterThan(deliverableTypes().length);
  });

  it('has NO provider for seller or store', () => {
    // A SellerProfile stores no user-authored identity to pin — it is read live
    // from Oxy — and a case about an Oxy identity opened in Mercaria's tenant
    // names an object only Oxy can act on.
    expect(subjectProviderFor('seller')).toBeUndefined();
    expect(subjectProviderFor('store')).toBeUndefined();
  });

  it('labels each delivered noun with the contract vocabulary', () => {
    expect(subjectProviderFor('listing')?.subjectType).toBe('commerce.listing');
    expect(subjectProviderFor('review')?.subjectType).toBe('commerce.review');
  });
});
