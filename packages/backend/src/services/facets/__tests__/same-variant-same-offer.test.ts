/**
 * The two semantics, asserted on the SQL the repository actually builds
 * (#367 Workstream 10).
 *
 * `facets.realdb.test.ts` proves the BEHAVIOUR against a real server — that a
 * product whose red variant is a 41 and whose black variant is a 43 is not
 * returned for "red AND 43". This file proves the STRUCTURE, and the two catch
 * different regressions.
 *
 * A behavioural test can pass on a wrong statement that happens to be right for
 * the fixture: with one variant per product, "any variant is red AND any variant
 * is 43" and "one variant is red and 43" agree exactly. A structural test cannot
 * be fooled that way, because it asserts the NESTING — that there is one
 * `canonical_variants` existence claim carrying both requirements, and not two
 * carrying one each. That is the difference between the correct statement and
 * the bug, and it is visible in the text whatever the data looks like.
 *
 * `PgDialect().sqlToQuery` renders the fragment with its bound parameters, so
 * this file needs no database and the rendered text is exactly what postgres.js
 * would be handed.
 */

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildEntityPredicate,
  hasOfferRequirement,
  NO_FACET_REQUIREMENTS,
  type FacetQueryContext,
} from '../../../db/facets/facetRepository.js';

const dialect = new PgDialect();
const NOW = new Date('2026-01-01T00:00:00.000Z');

function render(context: FacetQueryContext): string {
  return dialect.sqlToQuery(buildEntityPredicate(context)).sql;
}

/** How many times a substring occurs — the nesting counter. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SCOPE = { kind: 'categories' as const, categoryIds: ['cat-1'] };

describe('same-variant', () => {
  it('puts EVERY variant requirement inside ONE canonical_variants existence claim', () => {
    const text = render({
      scope: SCOPE,
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        variant: [
          { key: 'colour', values: ['red'] },
          { key: 'shoe_size_eu', values: ['43'] },
        ],
      },
      now: NOW,
    });

    // ONE variant claim. Two would be the false match: "a red one exists AND a
    // 43 exists", satisfied by a product that has no red 43.
    expect(occurrences(text, 'from canonical_variants cv')).toBe(1);
    // …and both requirements inside it, correlated on the SAME alias.
    expect(occurrences(text, 'vav.variant_id = cv.id')).toBe(2);
    expect(occurrences(text, 'vaa.variant_id = cv.id')).toBe(2);
  });

  it('reads a variant requirement from BOTH variant tables, as one OR', () => {
    const text = render({
      scope: SCOPE,
      requirements: { ...NO_FACET_REQUIREMENTS, variant: [{ key: 'colour', values: ['red'] }] },
      now: NOW,
    });
    // A registry value at variant grain, or the axis assignment that defines the
    // variant. Reading only one drops half the catalogue, silently.
    expect(text).toContain('canonical_attribute_values');
    expect(text).toContain('canonical_variant_attributes');
    expect(occurrences(text, ' or exists ')).toBe(1);
  });

  it('leaves a PRODUCT requirement outside the variant claim', () => {
    const text = render({
      scope: SCOPE,
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        product: [{ key: 'screen_size', min: 6 }],
        variant: [{ key: 'colour', values: ['red'] }],
      },
      now: NOW,
    });
    // A product-grain fact is about the product, so correlating it to a variant
    // would refuse every product whose spec is recorded at product grain — which
    // is most of them.
    expect(text).toContain('pav.product_id = p.id');
    expect(occurrences(text, 'from canonical_variants cv')).toBe(1);
  });
});

describe('same-offer', () => {
  it('puts EVERY offer requirement on ONE offers row', () => {
    const text = render({
      scope: SCOPE,
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        offer: {
          availability: ['in_stock'],
          conditionGroups: ['new'],
          priceBounds: [{ currency: 'EUR', maxMinor: 50_000 }],
        },
      },
      now: NOW,
    });

    // ONE offer claim carrying all three. Three claims would let the price come
    // from the cheap seller and the stock from a different one.
    expect(occurrences(text, 'from offers o')).toBe(1);
    expect(text).toContain('o.availability');
    expect(text).toContain('o.condition');
    expect(text).toContain('o.price_amount');
  });

  it('nests the offer claim INSIDE the variant claim when both are present', () => {
    const text = render({
      scope: SCOPE,
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        variant: [{ key: 'colour', values: ['red'] }],
        offer: { availability: ['in_stock'] },
      },
      now: NOW,
    });

    // The correlation is what makes it nested: the offer is on THAT variant.
    expect(text).toContain('o.canonical_variant_id = cv.id');
    expect(occurrences(text, 'from canonical_variants cv')).toBe(1);
    // And the offer claim opens after the variant claim does — a sibling would
    // put "the red one exists" beside "an in-stock one exists".
    expect(text.indexOf('from offers o')).toBeGreaterThan(
      text.indexOf('from canonical_variants cv'),
    );
  });

  it('still binds an offer to a variant when there is no variant requirement', () => {
    const text = render({
      scope: SCOPE,
      requirements: { ...NO_FACET_REQUIREMENTS, offer: { availability: ['in_stock'] } },
      now: NOW,
    });
    // `offers.canonical_variant_id` is the only link an offer has to a product,
    // so the claim goes through the variant table either way.
    expect(text).toContain('cv.product_id = p.id');
    expect(text).toContain('o.canonical_variant_id = cv.id');
  });

  it('collapses condition SEGMENTS into one key membership test', () => {
    const query = dialect.sqlToQuery(
      buildEntityPredicate({
        scope: SCOPE,
        requirements: { ...NO_FACET_REQUIREMENTS, offer: { conditionGroups: ['used', 'new'] } },
        now: NOW,
      }),
    );
    // #90's rule, which `listOffersForComparison` states: two ANDed `IN` lists
    // answer with the empty set for a facet UI that sent both a segment and a
    // key. One `= any(...)` over every key in both segments.
    expect(occurrences(query.sql, 'o.condition = any')).toBe(1);
    const keys = query.params.find(
      (param): param is string[] => Array.isArray(param) && param.includes('used_good'),
    );
    expect(keys).toContain('new');
    expect(keys).toContain('used_like_new');
    expect(keys).toContain('used_poor');
    expect(keys).not.toContain('refurbished_seller');
  });

  it('admits an offer with NO declared market rather than excluding it', () => {
    const text = render({
      scope: SCOPE,
      requirements: { ...NO_FACET_REQUIREMENTS, offer: { markets: ['ES'] } },
      now: NOW,
    });
    // The same reading `searchOfferRepository` uses: an offer that declared no
    // country is available everywhere, not nowhere.
    expect(text).toContain('o.country is null or');
  });

  it('compares each offer against the bound in its OWN currency', () => {
    const text = render({
      scope: SCOPE,
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        offer: {
          priceBounds: [
            { currency: 'EUR', maxMinor: 50_000 },
            { currency: 'USD', maxMinor: 54_000 },
          ],
        },
      },
      now: NOW,
    });
    // Per-currency, OR'd — never a cross-currency comparison of raw minor units,
    // and never float arithmetic in the planner.
    expect(occurrences(text, 'o.price_currency = $')).toBe(2);
    expect(text).not.toContain('*');
  });
});

describe('the empty requirement set', () => {
  it('is just the scope', () => {
    const text = render({ scope: SCOPE, requirements: NO_FACET_REQUIREMENTS, now: NOW });
    expect(text).toContain("p.status = 'active'");
    expect(text).not.toContain('canonical_variants');
    expect(text).not.toContain('offers');
  });

  it('reports itself as carrying no offer requirement', () => {
    expect(hasOfferRequirement({})).toBe(false);
    expect(hasOfferRequirement({ availability: [] })).toBe(false);
    expect(hasOfferRequirement({ availability: ['in_stock'] })).toBe(true);
    expect(hasOfferRequirement({ priceBounds: [{ currency: 'EUR' }] })).toBe(true);
  });

  it('binds a bounded product id list rather than interpolating it', () => {
    const query = dialect.sqlToQuery(
      buildEntityPredicate({
        scope: { kind: 'products', canonicalProductIds: ['p-1', 'p-2'] },
        requirements: NO_FACET_REQUIREMENTS,
        now: NOW,
      }),
    );
    expect(query.sql).toContain('p.id = any($');
    expect(query.params).toContainEqual(['p-1', 'p-2']);
  });
});
