/**
 * The pure half of the navigation domain: the locale fallback, the projection's
 * withholding rules, and the ETag (#367 step 7, ADR 0007 D3/D4/D10).
 *
 * No database, because none of this needs one — and that is the property under
 * test as much as the outputs are: the operator preview and the public read
 * share this code, so a preview cannot show a menu that publishing would not
 * produce.
 */

import { describe, expect, it } from 'vitest';
import { navigationLocaleFallbackChain } from '@mercaria/shared-types';
import { navigationEtag, navigationEtagMatches } from '../etag.js';
import {
  NAVIGATION_BASE_LOCALE,
  navigationFallbackChain,
  resolveNavigationPresentation,
  type NavigationLabelRow,
} from '../localization.js';
import {
  projectNavigationNodes,
  type NavigationProjectionContext,
  type ProjectableNode,
  type ResolvedTarget,
} from '../projection.js';

/**
 * A fixed instant safely in the PAST.
 *
 * Not today's date: a fixture pinned to the current day passes today, keeps
 * passing, and breaks CI for whoever pushes on the day it arrives — in a file
 * they did not touch (#253). Every other instant below is derived as an OFFSET
 * from this one rather than written as a second literal, so the window cases
 * stay the same distance apart however long this test lives.
 */
const AT = new Date('2020-06-15T12:00:00.000Z');
const HOUR = 3_600_000;

function label(overrides: Partial<NavigationLabelRow> & { locale: string }): NavigationLabelRow {
  return {
    label: `label-${overrides.locale}`,
    description: null,
    accessibilityLabel: null,
    status: 'approved',
    provenance: 'mercaria',
    ...overrides,
  };
}

function node(overrides: Partial<ProjectableNode> & { id: string; key: string }): ProjectableNode {
  return {
    parentId: null,
    position: 0,
    targetKind: 'category',
    categoryId: 'cat-1',
    savedQueryId: null,
    productTypeKey: null,
    brandId: null,
    productFamilyId: null,
    collectionId: null,
    campaignUrl: null,
    visibility: 'visible',
    visibleFrom: null,
    visibleTo: null,
    ...overrides,
  };
}

function context(
  overrides: Partial<NavigationProjectionContext> = {},
): NavigationProjectionContext {
  const visible: ResolvedTarget = { identifier: 'phones', publiclyVisible: true };
  return {
    requestedLocale: 'es-es',
    localeChain: navigationFallbackChain('es-es'),
    at: AT,
    labelsByNodeId: new Map(),
    categories: new Map([['cat-1', visible]]),
    brands: new Map(),
    families: new Map(),
    collections: new Map(),
    savedQueries: new Map(),
    ...overrides,
  };
}

describe('the locale fallback chain (ADR 0007 D4)', () => {
  it('is exact, then the language, then the base locale', () => {
    expect(navigationLocaleFallbackChain('es-MX', 'en')).toEqual(['es-mx', 'es', 'en']);
  });

  it('de-duplicates, so a base-locale request is one entry and not three', () => {
    expect(navigationLocaleFallbackChain('en', 'en')).toEqual(['en']);
    expect(navigationLocaleFallbackChain('en-GB', 'en')).toEqual(['en-gb', 'en']);
  });

  it('normalizes case, because the column stores the tag lower-cased', () => {
    expect(navigationFallbackChain('PT-BR')).toEqual(['pt-br', 'pt', NAVIGATION_BASE_LOCALE]);
  });
});

describe('resolving a label', () => {
  it('takes the exact locale and reports no fallback', () => {
    const presentation = resolveNavigationPresentation(
      [label({ locale: 'es-es' }), label({ locale: 'en' })],
      'es-es',
      navigationFallbackChain('es-es'),
    );
    expect(presentation?.locale).toBe('es-es');
    expect(presentation?.fallbackApplied).toBe(false);
  });

  it('falls back to the language, then to the base, and SAYS which answered', () => {
    const language = resolveNavigationPresentation(
      [label({ locale: 'es' }), label({ locale: 'en' })],
      'es-es',
      navigationFallbackChain('es-es'),
    );
    expect(language?.locale).toBe('es');
    expect(language?.fallbackApplied).toBe(true);

    const base = resolveNavigationPresentation(
      [label({ locale: 'en' })],
      'es-es',
      navigationFallbackChain('es-es'),
    );
    expect(base?.locale).toBe('en');
    expect(base?.fallbackApplied).toBe(true);
  });

  it('serves a STALE translation rather than nothing (D4)', () => {
    // A stale translation is still the best text available; withdrawing it would
    // show a raw key to a shopper, which is what the whole chain exists to stop.
    const presentation = resolveNavigationPresentation(
      [label({ locale: 'es-es', status: 'stale' })],
      'es-es',
    );
    expect(presentation?.label).toBe('label-es-es');
    expect(presentation?.status).toBe('stale');
  });

  it('answers UNDEFINED rather than inventing a string', () => {
    expect(resolveNavigationPresentation([label({ locale: 'fr' })], 'es-es')).toBeUndefined();
  });
});

describe('projecting a tree', () => {
  it('orders siblings by position and then by key, and nests children', () => {
    const nodes = [
      node({ id: 'b', key: 'beta', position: 1 }),
      node({ id: 'a', key: 'alpha', position: 0 }),
      node({ id: 'a2', key: 'alpha-two', position: 0, parentId: 'a' }),
      node({ id: 'a1', key: 'alpha-one', position: 0, parentId: 'a' }),
    ];
    const projection = projectNavigationNodes(
      nodes,
      context({
        labelsByNodeId: new Map(nodes.map((row) => [row.id, [label({ locale: 'es-es' })]])),
      }),
    );
    expect(projection.nodes.map((view) => view.key)).toEqual(['alpha', 'beta']);
    // Two siblings sharing a position is unwritable (two partial unique
    // indexes), and the key tiebreak is what gives a total order anyway.
    expect(projection.nodes[0].children.map((view) => view.key)).toEqual([
      'alpha-one',
      'alpha-two',
    ]);
  });

  it('withholds a hidden node AND its subtree, under two different reasons', () => {
    const nodes = [
      node({ id: 'p', key: 'parent', visibility: 'hidden' }),
      node({ id: 'c', key: 'child', parentId: 'p' }),
    ];
    const projection = projectNavigationNodes(
      nodes,
      context({
        labelsByNodeId: new Map(nodes.map((row) => [row.id, [label({ locale: 'es-es' })]])),
      }),
    );
    expect(projection.nodes).toEqual([]);
    expect(projection.withheld).toEqual([
      { nodeKey: 'parent', reason: 'node_hidden' },
      { nodeKey: 'child', reason: 'parent_withheld' },
    ]);
  });

  it('withholds a node whose window has not started or has ended', () => {
    const future = node({
      id: 'f',
      key: 'future',
      visibleFrom: new Date(AT.getTime() + HOUR),
    });
    const past = node({ id: 'p', key: 'past', visibleTo: new Date(AT.getTime() - HOUR) });
    const projection = projectNavigationNodes(
      [future, past],
      context({
        labelsByNodeId: new Map([
          ['f', [label({ locale: 'es-es' })]],
          ['p', [label({ locale: 'es-es' })]],
        ]),
      }),
    );
    expect(projection.nodes).toEqual([]);
    expect(projection.withheld.map((entry) => entry.reason)).toEqual([
      'outside_visibility_window',
      'outside_visibility_window',
    ]);
  });

  it('withholds a node whose collection is UNPUBLISHED — linking cannot publish', () => {
    // ADR 0007 D3: a collection stays merchandising, and a menu pointing at it
    // gives it nothing. The reason is distinct from `target_missing`, because
    // "somebody unpublished it" and "somebody deleted it" lead an operator to
    // different places.
    const nodes = [
      node({ id: 'c', key: 'sale', targetKind: 'collection', categoryId: null, collectionId: 'col-1' }),
    ];
    const projection = projectNavigationNodes(
      nodes,
      context({
        labelsByNodeId: new Map([['c', [label({ locale: 'es-es' })]]]),
        collections: new Map([['col-1', { identifier: 'sale', publiclyVisible: false }]]),
      }),
    );
    expect(projection.withheld).toEqual([
      { nodeKey: 'sale', reason: 'target_not_publicly_visible' },
    ]);
  });

  it('withholds a node with no label in the chain rather than rendering its key', () => {
    const projection = projectNavigationNodes(
      [node({ id: 'n', key: 'electronics.phones' })],
      context({ labelsByNodeId: new Map([['n', [label({ locale: 'fr' })]]]) }),
    );
    expect(projection.nodes).toEqual([]);
    expect(projection.withheld).toEqual([
      { nodeKey: 'electronics.phones', reason: 'no_label_in_fallback_chain' },
    ]);
  });

  it('returns the target IDENTITY beside the localized presentation, never one alone', () => {
    const projection = projectNavigationNodes(
      [node({ id: 'n', key: 'phones' })],
      context({ labelsByNodeId: new Map([['n', [label({ locale: 'es-es' })]]]) }),
    );
    const view = projection.nodes[0];
    expect(view.id).toBe('n');
    expect(view.key).toBe('phones');
    expect(view.target).toEqual({
      kind: 'category',
      categoryId: 'cat-1',
      categorySlug: 'phones',
    });
    expect(view.presentation.label).toBe('label-es-es');
  });

  it('carries a campaign URL out verbatim, with nothing appended', () => {
    const url = 'https://example.test/back-to-school?utm_source=partner';
    const projection = projectNavigationNodes(
      [
        node({
          id: 'n',
          key: 'campaign',
          targetKind: 'campaign',
          categoryId: null,
          campaignUrl: url,
        }),
      ],
      context({ labelsByNodeId: new Map([['n', [label({ locale: 'es-es' })]]]) }),
    );
    expect(projection.nodes[0].target).toEqual({ kind: 'campaign', url });
  });
});

describe('the ETag', () => {
  it('is stable across key order, so a refactor does not invalidate every cache', () => {
    expect(navigationEtag({ a: 1, b: [2, 3] })).toBe(navigationEtag({ b: [2, 3], a: 1 }));
  });

  it('changes when the content changes, including inside an array', () => {
    expect(navigationEtag({ a: [1, 2] })).not.toBe(navigationEtag({ a: [2, 1] }));
    expect(navigationEtag({ a: 1 })).not.toBe(navigationEtag({ a: 2 }));
  });

  it('treats an absent field and an undefined one as the same payload', () => {
    expect(navigationEtag({ a: 1, b: undefined })).toBe(navigationEtag({ a: 1 }));
  });

  it('matches a list, a weak form and a wildcard', () => {
    const etag = navigationEtag({ a: 1 });
    expect(navigationEtagMatches(etag, etag)).toBe(true);
    expect(navigationEtagMatches(`W/${etag}`, etag)).toBe(true);
    expect(navigationEtagMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(navigationEtagMatches('*', etag)).toBe(true);
    expect(navigationEtagMatches('"other"', etag)).toBe(false);
    expect(navigationEtagMatches(undefined, etag)).toBe(false);
  });
});
