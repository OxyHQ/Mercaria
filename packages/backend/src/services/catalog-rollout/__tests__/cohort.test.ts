/**
 * The catalog rollout cohort vocabulary, as behaviour (ADR 0007 D12, #367
 * Workstream 0 line 117).
 *
 * This file measures the PURE half: the parser, the dimension→field
 * correspondence and the matcher. That the five dimensions are actually reachable
 * from an HTTP surface — the half a pure test can never establish — is
 * `routes/__tests__/catalog-rollout-cohorts.test.ts`, which drives the real
 * Express chain.
 *
 * ## Every per-dimension case is DERIVED from the tuple
 *
 * `CATALOG_ROLLOUT_DIMENSIONS` is iterated rather than transcribed, so a sixth
 * dimension is measured here the moment it is added — and, because the fixtures
 * below are a `Record` keyed on the dimension type, one added without a fixture
 * fails `tsc` rather than being silently unmeasured. A hand list of five would
 * have gone green forever on a sixth.
 */

import { describe, expect, it } from 'vitest';
import type { CatalogRolloutDimension, CatalogRolloutSubject } from '@mercaria/shared-types';
import { CATALOG_ROLLOUT_DIMENSIONS } from '@mercaria/shared-types';
import {
  catalogRolloutAllowedFor,
  catalogRolloutCohortCovers,
  catalogRolloutCohortLabel,
  catalogRolloutSubjectValue,
  parseCatalogRolloutCohort,
  parseCatalogRolloutCohorts,
} from '../cohort.js';

/**
 * One dimension's fixtures: a value the cohort names, a DIFFERENT value of the
 * same dimension, and the subject that states each.
 *
 * A `Record` over the union rather than an array, which is what makes the
 * "adding a dimension without a fixture fails the build" property real.
 */
interface DimensionFixture {
  /** The value a cohort entry carries. */
  readonly inside: string;
  /** A different value of the SAME dimension — the discriminating case. */
  readonly outside: string;
  /** A subject stating exactly one dimension. */
  readonly subject: (value: string) => CatalogRolloutSubject;
}

const FIXTURES: Record<CatalogRolloutDimension, DimensionFixture> = {
  market: {
    inside: 'ES',
    outside: 'PT',
    subject: (market) => ({ market }),
  },
  locale: {
    inside: 'es',
    outside: 'de',
    subject: (locale) => ({ locale }),
  },
  store: {
    inside: 'store-alpha',
    outside: 'store-beta',
    subject: (storeId) => ({ storeId }),
  },
  category: {
    inside: 'cat-alpha',
    outside: 'cat-beta',
    subject: (categoryId) => ({ categoryId }),
  },
  product_type: {
    inside: 'footwear.sneaker',
    outside: 'phone.smartphone',
    subject: (productTypeKey) => ({ productTypeKey }),
  },
};

/** Nothing at all — the subject a surface hands over when it can state no dimension. */
const SILENT_SUBJECT: CatalogRolloutSubject = {};

describe('the dimension tuple is the population, and it is not empty', () => {
  it('names the five #367 line 117 dimensions and has a fixture for each', () => {
    // A floor AND an exact membership assertion. The floor alone would pass on a
    // tuple that lost `product_type` and gained something else; the membership
    // alone would pass on an EMPTY tuple if it were written as a subset check.
    expect(CATALOG_ROLLOUT_DIMENSIONS.length).toBeGreaterThanOrEqual(5);
    expect([...CATALOG_ROLLOUT_DIMENSIONS].sort()).toEqual(
      ['category', 'locale', 'market', 'product_type', 'store'].sort(),
    );
    expect(Object.keys(FIXTURES).sort()).toEqual([...CATALOG_ROLLOUT_DIMENSIONS].sort());
  });

  it('no fixture can pass by accident — inside and outside differ everywhere', () => {
    // A fixture whose two values were equal could not distinguish "the matcher
    // works" from "the matcher admits everything", and it would do so silently.
    for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
      expect(FIXTURES[dimension].inside, dimension).not.toEqual(FIXTURES[dimension].outside);
    }
  });
});

describe('every dimension parses, names a subject field, and discriminates', () => {
  for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
    const fixture = FIXTURES[dimension];

    it(`${dimension}: parses out of a <dimension>:<value> entry`, () => {
      const cohort = parseCatalogRolloutCohort(`${dimension}:${fixture.inside}`);
      expect(cohort).not.toBeNull();
      expect(cohort?.kind).toBe('dimension');
      if (cohort?.kind !== 'dimension') throw new Error('unreachable');
      expect(cohort.dimension).toBe(dimension);
      expect(catalogRolloutCohortLabel(cohort)).toBe(`${dimension}:${cohort.value}`);
    });

    it(`${dimension}: a subject has a field that states it`, () => {
      // The half that catches a dimension added to the tuple with no field
      // behind it: the value would read `null` and the dimension would silently
      // refuse every request instead of scoping anything.
      const stated = catalogRolloutSubjectValue(dimension, fixture.subject(fixture.inside));
      expect(stated, dimension).not.toBeNull();
      expect(catalogRolloutSubjectValue(dimension, SILENT_SUBJECT), dimension).toBeNull();
    });

    it(`${dimension}: admits its own value, refuses another, refuses silence`, () => {
      const cohorts = parseCatalogRolloutCohorts([`${dimension}:${fixture.inside}`]);
      expect(cohorts).toHaveLength(1);

      expect(catalogRolloutAllowedFor(cohorts, fixture.subject(fixture.inside))).toBe(true);
      expect(catalogRolloutAllowedFor(cohorts, fixture.subject(fixture.outside))).toBe(false);
      expect(catalogRolloutAllowedFor(cohorts, SILENT_SUBJECT)).toBe(false);
    });

    it(`${dimension}: is not answered by ANOTHER dimension's subject`, () => {
      // The cross-check that catches a `catalogRolloutSubjectValue` case reading
      // the wrong field — which a same-dimension test cannot see, because a
      // `market` case reading `subject.locale` still admits and refuses
      // correctly whenever only one field is ever set.
      const cohorts = parseCatalogRolloutCohorts([`${dimension}:${fixture.inside}`]);
      for (const other of CATALOG_ROLLOUT_DIMENSIONS) {
        if (other === dimension) continue;
        const foreign = FIXTURES[other].subject(fixture.inside);
        expect(
          catalogRolloutAllowedFor(cohorts, foreign),
          `${dimension} was answered by a ${other} subject carrying its value`,
        ).toBe(false);
      }
    });
  }
});

describe('the whole-list semantics', () => {
  it('an EMPTY list admits everything, including a subject that states nothing', () => {
    // Today's behaviour, and the reason introducing the variable withdraws
    // nothing. A regression here is a silent outage on every catalog surface.
    expect(catalogRolloutAllowedFor([], SILENT_SUBJECT)).toBe(true);
    expect(catalogRolloutAllowedFor([], { market: 'ES' })).toBe(true);
  });

  it('`all` admits everything, and a silent subject with it', () => {
    const cohorts = parseCatalogRolloutCohorts(['all']);
    expect(cohorts).toEqual([{ kind: 'all' }]);
    expect(catalogRolloutAllowedFor(cohorts, SILENT_SUBJECT)).toBe(true);
  });

  it('entries are OR-ed, so a stage is the previous stage plus more', () => {
    const stage2 = parseCatalogRolloutCohorts(['store:store-alpha']);
    const stage4 = parseCatalogRolloutCohorts(['store:store-alpha', 'market:ES', 'locale:es']);

    expect(catalogRolloutAllowedFor(stage2, { storeId: 'store-alpha' })).toBe(true);
    expect(catalogRolloutAllowedFor(stage2, { market: 'ES', locale: 'es' })).toBe(false);

    // The property that makes the ADR's stages executable: widening the list
    // never withdraws what an earlier stage admitted.
    expect(catalogRolloutAllowedFor(stage4, { storeId: 'store-alpha' })).toBe(true);
    expect(catalogRolloutAllowedFor(stage4, { market: 'ES', locale: 'es' })).toBe(true);
  });

});

describe('a malformed entry NARROWS and can never widen', () => {
  const REFUSED = [
    '',
    '   ',
    'store',
    ':store-alpha',
    'store:',
    'store:   ',
    'unknown_dimension:value',
    'ALL',
    'markets:ES',
  ] as const;

  it('drops every shape that is not a cohort', () => {
    // A floor on the list, for `docs/isolation-gates.md`'s reason: the loop is
    // this array's only reader, so emptying it would leave the case asserting
    // nothing while staying green.
    expect(REFUSED.length).toBeGreaterThanOrEqual(9);
    for (const entry of REFUSED) {
      expect(parseCatalogRolloutCohort(entry), entry).toBeNull();
    }
    expect(parseCatalogRolloutCohorts([...REFUSED])).toEqual([]);
  });

  it('a list of nothing but typos refuses every subject rather than admitting one', () => {
    // The direction that matters. A permissive parse would leave this list
    // EMPTY, and an empty list means everything — so a mistyped variable would
    // ship the whole rollout to everybody. Here the typos are dropped, the
    // parsed list is empty, and the caller sees the same "no cohorts" state it
    // would see with the variable unset. That is the ONE case where dropping is
    // not enough on its own, which is why the config resolver ALSO shape-filters
    // and why `resolveCatalogRolloutCohorts` keeps `<lowercase>:<something>`
    // rather than accepting free text.
    expect(parseCatalogRolloutCohorts(['stores:store-alpha'])).toEqual([]);
  });

  it('a positive control: the same shapes with a real dimension DO parse', () => {
    // Without this the case above would pass against a parser that returned
    // `null` for everything.
    expect(parseCatalogRolloutCohort('store:store-alpha')).not.toBeNull();
    expect(parseCatalogRolloutCohort('  market:es  ')).not.toBeNull();
  });
});

describe('value normalisation matches the spelling a subject carries', () => {
  it('a market is compared upper-cased on both sides', () => {
    const cohorts = parseCatalogRolloutCohorts(['market:es']);
    expect(catalogRolloutAllowedFor(cohorts, { market: 'ES' })).toBe(true);
    expect(catalogRolloutAllowedFor(cohorts, { market: ' es ' })).toBe(true);
    expect(catalogRolloutAllowedFor(cohorts, { market: 'PT' })).toBe(false);
  });

  it('a locale is compared lower-cased on both sides', () => {
    const cohorts = parseCatalogRolloutCohorts(['locale:ES-es']);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es-ES' })).toBe(true);
  });

  it('a store, category and product type are case-SENSITIVE identifiers', () => {
    // An id is an id. Folding one would make two different rows one cohort.
    expect(catalogRolloutAllowedFor(parseCatalogRolloutCohorts(['store:Store-Alpha']), {
      storeId: 'store-alpha',
    })).toBe(false);
    expect(catalogRolloutAllowedFor(parseCatalogRolloutCohorts(['category:Cat-Alpha']), {
      categoryId: 'cat-alpha',
    })).toBe(false);
    expect(catalogRolloutAllowedFor(parseCatalogRolloutCohorts(['product_type:Footwear']), {
      productTypeKey: 'footwear',
    })).toBe(false);
  });
});

describe('locale matches on the SUBTAG BOUNDARY, never on a bare prefix', () => {
  it('a language covers its regional variants', () => {
    const cohorts = parseCatalogRolloutCohorts(['locale:es']);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es' })).toBe(true);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es-ES' })).toBe(true);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es-MX' })).toBe(true);
  });

  it('a regional variant covers only itself', () => {
    const cohorts = parseCatalogRolloutCohorts(['locale:es-es']);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es-ES' })).toBe(true);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es-MX' })).toBe(false);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es' })).toBe(false);
  });

  it('a TRUNCATED value narrows instead of admitting every language beside it', () => {
    // The whole reason the rule is a boundary and not `startsWith`. Under a bare
    // prefix rule `locale:e` would cover `en`, `es` and `et` — a typo that
    // silently ships a rollout to every European language at once.
    const cohorts = parseCatalogRolloutCohorts(['locale:e']);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'en' })).toBe(false);
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'es' })).toBe(false);
    // And the control that proves the rule is a boundary rather than "refuse
    // everything short": a genuine `e-…` tag is still covered.
    expect(catalogRolloutAllowedFor(cohorts, { locale: 'e-XX' })).toBe(true);
  });

  it('the boundary rule applies to locale ONLY', () => {
    // A store or category id that merely PREFIXES another must not be covered by
    // it: ids are opaque and `cat-1` is not an ancestor of `cat-10`.
    for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
      if (dimension === 'locale') continue;
      const cohort = parseCatalogRolloutCohort(`${dimension}:alpha`);
      expect(cohort).not.toBeNull();
      if (cohort === null) throw new Error('unreachable');
      expect(
        catalogRolloutCohortCovers(cohort, FIXTURES[dimension].subject('alpha-beta')),
        `${dimension} matched a value that merely starts with the cohort's`,
      ).toBe(false);
    }
  });
});

describe('a category cohort is EXACT and does not cover a subtree', () => {
  it('names the id it names, and nothing beneath it', () => {
    // Stated as a test because it is the property somebody will reach for. A
    // subtree needs a database read and this module is pure; listing the ids is
    // the documented answer, and `SEO_CANARY_CATEGORY_IDS` made the same choice.
    const cohorts = parseCatalogRolloutCohorts(['category:cat-parent']);
    expect(catalogRolloutAllowedFor(cohorts, { categoryId: 'cat-parent' })).toBe(true);
    expect(catalogRolloutAllowedFor(cohorts, { categoryId: 'cat-child' })).toBe(false);
  });
});
