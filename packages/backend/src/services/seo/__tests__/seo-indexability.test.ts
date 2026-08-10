/**
 * The indexability policy (#75 §"Indexability policy").
 *
 * Two properties this file exists to hold:
 *
 *  1. **Every refusal reason is REACHABLE.** A vocabulary member no input can
 *     produce is a value nobody can act on, and the ones this domain cannot
 *     produce from a live route today (`locale_incomplete`,
 *     `filter_combination_not_unique`) are exercised here directly, so the day
 *     a localized route or a browse page ships the branch is already tested.
 *  2. **The ORDER is the answer.** A page that fails several conditions gets
 *     the FIRST one, and the order runs mechanical → identity → rights →
 *     content, so `thin_content` implies the page is live, canonical, clear of
 *     moderation and permitted by its sources.
 */

import { describe, expect, it } from 'vitest';
import type { SeoVisibleFacts } from '@mercaria/shared-types';
import { SEO_NON_INDEXABLE_REASONS } from '@mercaria/shared-types';
import {
  assessCatalogueContent,
  assessVisibleContent,
  decideIndexability,
  MIN_CATALOGUE_ENTRIES,
  MIN_DESCRIPTION_CHARACTERS,
  robotsDirectiveFor,
  type SeoIndexabilityFacts,
} from '../indexability.js';

/** Everything permitted — the base every case narrows from one field at a time. */
const PERMITTED: SeoIndexabilityFacts = {
  routeAvailability: 'live',
  indexingPermitted: true,
  identity: 'canonical',
  moderation: 'clear',
  sourceIndexRight: 'granted',
  content: 'sufficient',
  offerInformation: 'current',
  locale: 'complete',
  filterUniqueness: 'not_a_filter_page',
};

function refusalFor(overrides: Partial<SeoIndexabilityFacts>): string {
  const verdict = decideIndexability({ ...PERMITTED, ...overrides });
  return verdict.outcome === 'refused' ? verdict.reason : 'indexable';
}

describe('a page that satisfies every input is indexable', () => {
  it('answers `indexable` with no reason to read', () => {
    expect(decideIndexability(PERMITTED)).toEqual({ outcome: 'indexable' });
  });
});

describe('every refusal reason is reachable', () => {
  /**
   * One input per reason, in the policy's own order. The list is compared
   * against the tuple below, so a reason ADDED to the vocabulary without a case
   * here fails the build.
   */
  const cases: readonly [string, Partial<SeoIndexabilityFacts>][] = [
    ['indexing_disabled', { indexingPermitted: false }],
    ['route_not_live', { routeAvailability: 'planned' }],
    ['merged_or_duplicate', { identity: 'merged' }],
    ['suppressed', { moderation: 'suppressed' }],
    ['source_withholds_index_right', { sourceIndexRight: 'withheld' }],
    ['thin_content', { content: 'thin' }],
    ['no_offer_information', { offerInformation: 'none' }],
    ['locale_incomplete', { locale: 'incomplete' }],
    ['filter_combination_not_unique', { filterUniqueness: 'not_unique' }],
  ];

  it.each(cases)('%s', (reason, overrides) => {
    expect(refusalFor(overrides)).toBe(reason);
  });

  it('covers the whole vocabulary', () => {
    expect(cases.map(([reason]) => reason).sort()).toEqual([...SEO_NON_INDEXABLE_REASONS].sort());
  });

  it('`duplicate` refuses under the same reason as `merged`', () => {
    expect(refusalFor({ identity: 'duplicate' })).toBe('merged_or_duplicate');
  });
});

describe('the evaluation ORDER is the answer', () => {
  it('a page failing everything reports the mechanical reason first', () => {
    expect(
      refusalFor({
        indexingPermitted: false,
        routeAvailability: 'planned',
        identity: 'merged',
        moderation: 'suppressed',
        sourceIndexRight: 'withheld',
        content: 'thin',
        offerInformation: 'none',
        locale: 'incomplete',
        filterUniqueness: 'not_unique',
      }),
    ).toBe('indexing_disabled');
  });

  it('`thin_content` implies live, canonical, clear and permitted', () => {
    // The property that makes the reason actionable: an operator reading it
    // knows the other four questions were already answered yes.
    expect(refusalFor({ content: 'thin', moderation: 'suppressed' })).toBe('suppressed');
    expect(refusalFor({ content: 'thin', sourceIndexRight: 'withheld' })).toBe(
      'source_withholds_index_right',
    );
  });
});

describe('the robots directive', () => {
  it('follows in BOTH branches', () => {
    // A non-indexable page is still a navigation surface: a legacy listing
    // leads to its canonical product, a tombstone to its winner. `nofollow`
    // would cut those for no benefit.
    expect(robotsDirectiveFor({ outcome: 'indexable' })).toBe('index,follow,max-image-preview:large');
    expect(robotsDirectiveFor({ outcome: 'refused', reason: 'thin_content' })).toBe(
      'noindex,follow',
    );
  });

  it('never names the reason', () => {
    // The reason is operator-facing. A crawler that could read WHICH input
    // refused could vary one at a time and read the switchboard out of the
    // catalogue.
    for (const reason of SEO_NON_INDEXABLE_REASONS) {
      expect(robotsDirectiveFor({ outcome: 'refused', reason })).not.toContain(reason);
    }
  });
});

/** A product page's facts, with everything present. */
function facts(overrides: Partial<SeoVisibleFacts> = {}): SeoVisibleFacts {
  return {
    title: 'iPhone 16 Pro',
    entityName: 'iPhone 16 Pro',
    description: 'x'.repeat(MIN_DESCRIPTION_CHARACTERS),
    imageUrls: ['https://cdn.example/a.jpg'],
    breadcrumbs: [],
    gtins: ['00190199000000'],
    offers: [],
    variantNames: [],
    ...overrides,
  };
}

describe('assessing what the page DISPLAYS', () => {
  it('a real description is enough on its own', () => {
    expect(assessVisibleContent(facts({ imageUrls: [], gtins: [] }))).toBe('sufficient');
  });

  it('a description one character short is not', () => {
    expect(
      assessVisibleContent(
        facts({
          description: 'x'.repeat(MIN_DESCRIPTION_CHARACTERS - 1),
          imageUrls: [],
          gtins: [],
        }),
      ),
    ).toBe('thin');
  });

  it('an image plus an identifier is enough without one', () => {
    const withoutDescription = facts({ imageUrls: ['https://cdn.example/a.jpg'], gtins: ['1'] });
    const { description: _dropped, ...rest } = withoutDescription;
    expect(assessVisibleContent(rest as SeoVisibleFacts)).toBe('sufficient');
  });

  it('an image alone is not, and an identifier alone is not', () => {
    const base = facts({ imageUrls: [], gtins: [] });
    const { description: _dropped, ...rest } = base;
    const stub = rest as SeoVisibleFacts;
    expect(assessVisibleContent({ ...stub, imageUrls: ['https://cdn.example/a.jpg'] })).toBe('thin');
    expect(assessVisibleContent({ ...stub, gtins: ['1'] })).toBe('thin');
  });

  it('an mpn counts as an identifier', () => {
    const base = facts({ imageUrls: ['https://cdn.example/a.jpg'], gtins: [] });
    const { description: _dropped, ...rest } = base;
    expect(assessVisibleContent({ ...(rest as SeoVisibleFacts), mpn: 'A3102' })).toBe('sufficient');
  });

  it('a nameless page is thin whatever else it carries', () => {
    expect(assessVisibleContent(facts({ entityName: '   ' }))).toBe('thin');
  });

  it('whitespace is not a description', () => {
    expect(
      assessVisibleContent(
        facts({ description: '   '.repeat(MIN_DESCRIPTION_CHARACTERS), imageUrls: [], gtins: [] }),
      ),
    ).toBe('thin');
  });
});

describe('assessing a catalogue page', () => {
  it('needs more than one entry', () => {
    expect(assessCatalogueContent('Acme', MIN_CATALOGUE_ENTRIES)).toBe('sufficient');
    expect(assessCatalogueContent('Acme', MIN_CATALOGUE_ENTRIES - 1)).toBe('thin');
    expect(assessCatalogueContent('Acme', 0)).toBe('thin');
  });

  it('is thin without a name', () => {
    expect(assessCatalogueContent('', 100)).toBe('thin');
  });
});
