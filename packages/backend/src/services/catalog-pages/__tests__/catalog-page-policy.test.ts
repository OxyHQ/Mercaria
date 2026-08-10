/**
 * The pure decisions a catalogue page makes (#72).
 *
 * Every fixture here is chosen to exercise the distinction its assertion exists
 * to make, rather than to be tidy: a cursor is re-read under the OTHER
 * ordering, a logo is `withheld` rather than merely absent, and a condition set
 * is empty rather than `['new']`. A fixture on the same side of a distinction
 * as every other one cannot tell the strict version of a check from the loose
 * one, which is how a green suite ends up measuring nothing.
 */

import { describe, expect, it } from 'vitest';
import type { CatalogPageAsset, CatalogPageText } from '@mercaria/shared-types';
import { conditionScopeOf, foldConditionScopes } from '../condition-scope.js';
import {
  brandBreadcrumbs,
  brandIndexability,
  brandStructuredData,
  familyBreadcrumbs,
  familyIndexability,
  FAMILY_PUBLISHABLE_MIN_PRODUCTS,
} from '../page-policy.js';
import {
  asCatalogBrowseOrdering,
  catalogBrowseFingerprint,
  decodeCatalogBrowseCursor,
  encodeCatalogBrowseCursor,
} from '../cursor.js';

const DISPLAYABLE_LOGO: CatalogPageAsset = {
  state: 'displayable',
  fileId: 'file_logo',
  rightsBasis: 'operator_uploaded',
};
const WITHHELD_LOGO: CatalogPageAsset = { state: 'withheld', reason: 'no_display_right' };
const DISPLAYABLE_TEXT: CatalogPageText = {
  state: 'displayable',
  text: 'A brand.',
  rightsBasis: 'source_licensed',
};
const WITHHELD_TEXT: CatalogPageText = { state: 'withheld', reason: 'no_display_right' };

describe('#72 a price summary states what it is about', () => {
  it('answers unknown for a set with no segments, never new', () => {
    // The fixture that matters: an offer whose source said nothing about
    // condition contributes NO segment (#90 never asserts one), and reading an
    // empty set as "new" is the single most misleading thing a catalogue page
    // can print above a price.
    expect(conditionScopeOf([])).toBe('unknown');
  });

  it('tells a sealed unit from a refurbished one', () => {
    expect(conditionScopeOf(['new'])).toBe('new');
    expect(conditionScopeOf(['refurbished'])).toBe('used');
    expect(conditionScopeOf(['open_box'])).toBe('used');
    expect(conditionScopeOf(['new', 'used'])).toBe('mixed');
  });

  it('folds a page: one unknown among knowns makes the whole thing mixed', () => {
    expect(foldConditionScopes(['new', 'unknown'])).toBe('mixed');
    expect(foldConditionScopes(['new', 'new'])).toBe('new');
    expect(foldConditionScopes(['unknown', 'unknown'])).toBe('unknown');
    expect(foldConditionScopes([])).toBe('unknown');
  });
});

describe('#72 indexability', () => {
  it('puts a tombstone ahead of a rights refusal ahead of thinness', () => {
    // The severity ordering, exercised with a fixture that satisfies ALL THREE
    // conditions at once — the only shape that can tell an ordered check from
    // an unordered one.
    expect(brandIndexability({ merged: true, mayIndex: false, productCount: 0 })).toBe('merged');
    expect(brandIndexability({ merged: false, mayIndex: false, productCount: 0 })).toBe(
      'no_index_right',
    );
    expect(brandIndexability({ merged: false, mayIndex: true, productCount: 0 })).toBe('thin');
    expect(brandIndexability({ merged: false, mayIndex: true, productCount: 1 })).toBe('indexable');
  });

  it('holds a family to a higher floor than a brand', () => {
    // A family with one member says exactly what that product's page says; a
    // brand with one product still publishes its verified channels, which
    // nothing else in Mercaria does.
    const one = { merged: false, mayIndex: true, productCount: 1 };
    expect(brandIndexability(one)).toBe('indexable');
    expect(familyIndexability(one)).toBe('thin');
    expect(
      familyIndexability({ ...one, productCount: FAMILY_PUBLISHABLE_MIN_PRODUCTS }),
    ).toBe('indexable');
  });
});

describe('#72 structured data asserts only what the page shows', () => {
  const canonicalUrl = '/brands/acme';

  it('omits a WITHHELD logo and a WITHHELD description', () => {
    // Withheld rather than absent, deliberately: an absent logo would pass a
    // check that simply forwards whatever it is given, and the property under
    // test is that a logo Mercaria HOLDS but may not display cannot reach a
    // crawler through the JSON-LD side door.
    const data = brandStructuredData({
      page: {
        name: 'Acme',
        description: WITHHELD_TEXT,
        logo: WITHHELD_LOGO,
        websiteUrl: 'https://acme.example',
      },
      canonicalUrl,
      indexability: 'indexable',
    });
    expect(data.kind).toBe('brand');
    expect(data).not.toHaveProperty('logoFileId');
    expect(data).not.toHaveProperty('description');
    // The website is the brand's OWN and is a fact the page shows, so it stays.
    expect(data).toHaveProperty('sameAs', ['https://acme.example']);
  });

  it('carries a displayable logo and description', () => {
    const data = brandStructuredData({
      page: { name: 'Acme', description: DISPLAYABLE_TEXT, logo: DISPLAYABLE_LOGO },
      canonicalUrl,
      indexability: 'indexable',
    });
    expect(data).toMatchObject({ kind: 'brand', logoFileId: 'file_logo', description: 'A brand.' });
  });

  it('emits the organization shape ONLY from a verified ownership relationship', () => {
    const data = brandStructuredData({
      page: {
        name: 'Acme',
        description: DISPLAYABLE_TEXT,
        logo: DISPLAYABLE_LOGO,
        owningOrganization: {
          organizationId: 'org_1',
          name: 'Acme Holdings SA',
          slug: 'acme-holdings',
          relationshipId: 'rel_1',
          evidence: 'verified_relationship',
          validFrom: '2020-01-01T00:00:00.000Z',
        },
      },
      canonicalUrl,
      indexability: 'indexable',
    });
    expect(data).toMatchObject({ kind: 'organization', name: 'Acme Holdings SA', brandName: 'Acme' });
  });

  it('emits nothing at all for a page that may not be indexed', () => {
    for (const indexability of ['thin', 'no_index_right', 'merged'] as const) {
      const data = brandStructuredData({
        page: { name: 'Acme', description: DISPLAYABLE_TEXT, logo: DISPLAYABLE_LOGO },
        canonicalUrl,
        indexability,
      });
      expect(data, `structured data leaked from a ${indexability} page`).toEqual({ kind: 'none' });
    }
  });
});

describe('#72 breadcrumbs', () => {
  it('makes a brand a root and a family a child of its brand', () => {
    // A brand sells across categories, so putting it under the biggest one
    // would tell a crawler its other categories are a subsection of that.
    expect(brandBreadcrumbs({ id: 'b1', slug: 'acme', name: 'Acme' })).toEqual([
      { kind: 'brand', id: 'b1', slug: 'acme', name: 'Acme' },
    ]);
    expect(
      familyBreadcrumbs({ id: 'f1', slug: 'widget', name: 'Widget' }, {
        id: 'b1',
        slug: 'acme',
        name: 'Acme',
      }),
    ).toEqual([
      { kind: 'brand', id: 'b1', slug: 'acme', name: 'Acme' },
      { kind: 'product_family', id: 'f1', slug: 'widget', name: 'Widget' },
    ]);
  });

  it('leaves a brandless family with a one-hop trail', () => {
    expect(familyBreadcrumbs({ id: 'f1', slug: 'widget', name: 'Widget' }, undefined)).toEqual([
      { kind: 'product_family', id: 'f1', slug: 'widget', name: 'Widget' },
    ]);
  });
});

describe('#72 the browse cursor is bound to what produced it', () => {
  const scope = { kind: 'brand', brandId: 'b1' } as const;
  const nameFingerprint = catalogBrowseFingerprint({
    scope,
    ordering: 'catalog_name',
    filters: {},
  });

  it('round-trips a position, including a name full of punctuation', () => {
    // A product legitimately called `Model | Pro` would split a `|`-joined
    // payload into the wrong number of fields. The fixture IS the punctuation.
    const encoded = encodeCatalogBrowseCursor(nameFingerprint, {
      name: 'Model | Pro (2024) — "Ultra"',
      id: 'p_1',
    });
    expect(decodeCatalogBrowseCursor(encoded, nameFingerprint, 'catalog_name')).toEqual({
      name: 'Model | Pro (2024) — "Ultra"',
      id: 'p_1',
    });
  });

  it('is UNREADABLE under the other ordering', () => {
    // The distinction this binding exists for: the two orderings sort by
    // different columns in different directions, so resuming one from the
    // other's boundary would skip or repeat an arbitrary run of rows and report
    // neither. Unreadable costs one duplicated first page and cannot lose a row.
    const encoded = encodeCatalogBrowseCursor(nameFingerprint, { name: 'Model', id: 'p_1' });
    expect(decodeCatalogBrowseCursor(encoded, nameFingerprint, 'release_desc')).toBeNull();
  });

  it('is UNREADABLE under a different scope or a different filter set', () => {
    const encoded = encodeCatalogBrowseCursor(nameFingerprint, { name: 'Model', id: 'p_1' });
    const otherScope = catalogBrowseFingerprint({
      scope: { kind: 'family', familyId: 'f1' },
      ordering: 'catalog_name',
      filters: {},
    });
    const otherFilters = catalogBrowseFingerprint({
      scope,
      ordering: 'catalog_name',
      filters: { categorySlugs: ['phones'] },
    });
    expect(decodeCatalogBrowseCursor(encoded, otherScope, 'catalog_name')).toBeNull();
    expect(decodeCatalogBrowseCursor(encoded, otherFilters, 'catalog_name')).toBeNull();
  });

  it('treats two requests that only reordered their filter lists as one browse', () => {
    // Invalidating a cursor for a difference a client cannot see would look
    // like the tail of the list simply ending.
    const left = catalogBrowseFingerprint({
      scope,
      ordering: 'catalog_name',
      filters: { categorySlugs: ['phones', 'tablets'] },
    });
    const right = catalogBrowseFingerprint({
      scope,
      ordering: 'catalog_name',
      filters: { categorySlugs: ['tablets', 'phones'] },
    });
    expect(left).toBe(right);
  });

  it('refuses a release cursor with no release instant', () => {
    const releaseFingerprint = catalogBrowseFingerprint({
      scope,
      ordering: 'release_desc',
      filters: {},
    });
    const missing = encodeCatalogBrowseCursor(releaseFingerprint, { name: 'Model', id: 'p_1' });
    expect(decodeCatalogBrowseCursor(missing, releaseFingerprint, 'release_desc')).toBeNull();

    const present = encodeCatalogBrowseCursor(releaseFingerprint, {
      name: 'Model',
      id: 'p_1',
      releasedAt: '2024-05-01T00:00:00.000Z',
    });
    expect(decodeCatalogBrowseCursor(present, releaseFingerprint, 'release_desc')).toEqual({
      name: 'Model',
      id: 'p_1',
      releasedAt: '2024-05-01T00:00:00.000Z',
    });
  });

  it('answers null for garbage rather than throwing', () => {
    expect(decodeCatalogBrowseCursor('', nameFingerprint, 'catalog_name')).toBeNull();
    expect(decodeCatalogBrowseCursor('not-base64!!', nameFingerprint, 'catalog_name')).toBeNull();
    expect(
      decodeCatalogBrowseCursor(
        Buffer.from('wrong|shape', 'utf8').toString('base64url'),
        nameFingerprint,
        'catalog_name',
      ),
    ).toBeNull();
  });

  it('narrows a wire ordering to the set this surface serves', () => {
    expect(asCatalogBrowseOrdering('catalog_name')).toBe('catalog_name');
    expect(asCatalogBrowseOrdering('release_desc')).toBe('release_desc');
    expect(asCatalogBrowseOrdering('price_asc')).toBeNull();
  });
});
