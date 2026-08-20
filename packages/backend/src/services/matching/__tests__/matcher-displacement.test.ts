/**
 * Which attachments a matcher may replace (#367 step 5, ADR 0007 D10; #91).
 *
 * This file pins the TABLE. It cannot pin the branch that reads it — a table
 * with no reader is a convention — so `matching-writes.realdb.test.ts` runs a
 * real evaluation against a real `merchant_declared` link and asserts the row
 * does not move. Both are needed and neither is redundant: deleting the `if` in
 * `attachIfAutomatic` leaves this file entirely green, and rewriting the table
 * as `{ ...everything: true }` leaves the realdb case red for one method only.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_LISTING_LINK_METHODS } from '@mercaria/shared-types';
import { MATCHER_MAY_DISPLACE } from '../match.service.js';
import { reportPopulation } from '../../../__tests__/report-population.js';

/** Derived from the vocabulary, never listed — the population, and its floor. */
const METHODS = [...NATIVE_LISTING_LINK_METHODS];

describe('the displacement table covers the whole vocabulary', () => {
  it('names every link method exactly once, and no other key', () => {
    const keys = Object.keys(MATCHER_MAY_DISPLACE).sort();
    expect(keys).toEqual([...METHODS].sort());
    // The vacuity floor. An empty vocabulary would satisfy the equality above
    // and would mean the table governs nothing; seven is what exists today and
    // an eighth method has to arrive with a decision beside it.
    expect(METHODS.length, 'the link-method vocabulary is empty').toBeGreaterThanOrEqual(7);
    reportPopulation(`[census] link methods scanned: ${METHODS.length}`);
  });

  it('every entry is a real boolean rather than a missing key read as undefined', () => {
    for (const method of METHODS) {
      expect(typeof MATCHER_MAY_DISPLACE[method], `${method} is not a boolean`).toBe('boolean');
    }
  });
});

describe('a person’s declaration is protected and a machine’s is not', () => {
  it('`merchant_declared` may NOT be displaced — ADR 0007 D10', () => {
    expect(
      MATCHER_MAY_DISPLACE.merchant_declared,
      'a store member selected this canonical product from a search that showed them the ' +
        'identifiers; a confidence score may not overrule it',
    ).toBe(false);
  });

  it('`seller_declared` may NOT be displaced — #91', () => {
    expect(MATCHER_MAY_DISPLACE.seller_declared).toBe(false);
  });

  it('the protected set is exactly those two, and the rest are displaceable', () => {
    const protectedMethods = METHODS.filter((method) => !MATCHER_MAY_DISPLACE[method]).sort();
    expect(protectedMethods).toEqual(['merchant_declared', 'seller_declared']);
    const displaceable = METHODS.filter((method) => MATCHER_MAY_DISPLACE[method]).sort();
    // Named rather than counted: a count is satisfied by any five, and the one
    // that matters is `operator` — deliberately displaceable, unchanged by #367,
    // and the entry a later reader is most likely to assume was an oversight.
    expect(displaceable).toEqual([
      'backfill',
      'barcode_gtin',
      'connector_declared',
      'matcher',
      'operator',
    ]);
    reportPopulation(
      `[census] protected: ${protectedMethods.length}, displaceable: ${displaceable.length}`,
    );
  });
});
