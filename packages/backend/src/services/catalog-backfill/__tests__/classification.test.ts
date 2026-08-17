/**
 * The legacy-catalogue classifier, and the vocabulary it answers in
 * (#367 workstream 13).
 *
 * Everything under test here is PURE, so every branch is reachable from a plain
 * object and none of these assertions needs a server. That is the point of
 * putting the whole decision in `classification.ts`: a test that had to build a
 * database fixture to reach a branch would be measuring the fixture's idea of
 * the rule, and this file measures the rule.
 *
 * The vocabulary census below is the half worth reading twice. A closed set of
 * reasons is only useful if every member can actually be produced and every
 * class can actually be counted — a class no reason maps to would sit in every
 * report as a permanent zero and read exactly like "we checked and found none".
 */

import { describe, expect, it } from 'vitest';
import type {
  LegacyCatalogSubjectKind,
  LegacyMappingClass,
  LegacyMappingReason,
} from '@mercaria/shared-types';
import {
  LEGACY_CATALOG_BACKFILL_POLICY,
  LEGACY_CATALOG_CANDIDATE_SIGNALS,
  LEGACY_CATALOG_FORBIDDEN_SIGNALS,
  LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE,
  LEGACY_CATALOG_SUBJECT_CLASSIFIERS,
  LEGACY_CATALOG_SUBJECT_GRAINS,
  LEGACY_CATALOG_SUBJECT_KINDS,
  LEGACY_CATALOG_WRITE_OWNERS,
  LEGACY_MAPPING_CLASSES,
  LEGACY_MAPPING_REASON_CLASSES,
  LEGACY_MAPPING_REASONS,
} from '@mercaria/shared-types';
import type { CategoryFacts, ProductTypeFacts } from '../classification.js';
import {
  categoryPathsAgree,
  classifyCategoryAssignment,
  classifyCategoryPath,
  classifyProductTypeText,
  classifyVendorValue,
  derivedCategoryPath,
  isProductTypeEligible,
  MERGE_CHAIN_MAX_DEPTH,
  resolveMergeTarget,
} from '../classification.js';
import {
  LEGACY_PRODUCT_TYPE_FOLDS,
  LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS,
  legacyProductTypeTextToKey,
} from '../product-type-text.js';

/**
 * The clock every effective-window case is measured against.
 *
 * Safely in the PAST, and the two window boundaries below are derived as OFFSETS
 * from it rather than written as second literals — `fixture-date-census.test.ts`
 * refuses a fixture pinned to today or later, because the real clock keeps moving
 * toward it and the failure lands on whoever pushes on the day it arrives.
 */
const NOW = new Date('2026-01-15T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** A live, selectable, published node. Overridden per case. */
function category(overrides: Partial<CategoryFacts> & { id: string }): CategoryFacts {
  return {
    slug: overrides.id,
    ancestorSlugs: [],
    ancestorIds: [],
    lifecycle: 'published',
    selectable: true,
    mergedIntoCategoryId: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

function mapOf(...facts: readonly CategoryFacts[]): ReadonlyMap<string, CategoryFacts> {
  return new Map(facts.map((fact) => [fact.id, fact]));
}

function listing(overrides: Partial<Parameters<typeof classifyCategoryPath>[0]> = {}) {
  return {
    id: 'listing-1',
    categoryId: null,
    categorySlugs: [] as readonly string[],
    productType: null,
    ...overrides,
  };
}

describe('the classification vocabulary', () => {
  it('gives every class at least one reason that produces it', () => {
    // The check this file exists for. A class nothing maps to is a permanent
    // zero in every report and reads exactly like a measurement — the shape of
    // number that gets quoted in a cutover decision. `high_confidence` is the
    // one at risk: it exists because a vendor string matching one brand is real
    // evidence for a person, and it would be quietly unproduceable if that
    // subject were ever handed to another domain.
    const produced = new Set<LegacyMappingClass>(
      LEGACY_MAPPING_REASONS.map((reason) => LEGACY_MAPPING_REASON_CLASSES[reason].mappingClass),
    );
    expect([...produced].sort()).toEqual([...LEGACY_MAPPING_CLASSES].sort());
  });

  it('ties ownership to actionability in both directions', () => {
    for (const reason of LEGACY_MAPPING_REASONS) {
      const meaning = LEGACY_MAPPING_REASON_CLASSES[reason];
      expect(
        meaning.reviewOwner === 'none',
        `${reason}: a row nobody owes anything on must not be actionable, and work must not be owed to nobody`,
      ).toBe(!meaning.actionable);
    }
  });

  it('gives every catalog_backfill subject reasons, and the others none', () => {
    const bySubject = new Map<LegacyCatalogSubjectKind, LegacyMappingReason[]>();
    for (const reason of LEGACY_MAPPING_REASONS) {
      const subject = LEGACY_MAPPING_REASON_CLASSES[reason].subject;
      bySubject.set(subject, [...(bySubject.get(subject) ?? []), reason]);
    }
    for (const subject of LEGACY_CATALOG_SUBJECT_KINDS) {
      const reasons = bySubject.get(subject) ?? [];
      if (LEGACY_CATALOG_SUBJECT_CLASSIFIERS[subject] === 'catalog_backfill') {
        expect(reasons.length, `${subject} is classified here and has no reasons`).toBeGreaterThan(
          0,
        );
      } else {
        // A reason for a subject another domain classifies would be a second
        // authority over one fact, and the two would disagree the first time
        // somebody published an alias.
        expect(reasons, `${subject} is classified elsewhere and must own no reason here`).toEqual(
          [],
        );
      }
    }
  });

  it('keeps the candidate and forbidden signal lists disjoint', () => {
    const candidates = new Set<string>(LEGACY_CATALOG_CANDIDATE_SIGNALS);
    for (const forbidden of LEGACY_CATALOG_FORBIDDEN_SIGNALS) {
      expect(candidates.has(forbidden), `${forbidden} is on both lists`).toBe(false);
    }
    // Both lists are non-empty, or the disjointness above is vacuous.
    expect(LEGACY_CATALOG_CANDIDATE_SIGNALS.length).toBeGreaterThan(5);
    expect(LEGACY_CATALOG_FORBIDDEN_SIGNALS.length).toBeGreaterThan(5);
  });

  it('refuses to let a name match author a write', () => {
    // The two brand signals are legitimate CANDIDATE evidence and may never
    // become an attachment — ADR 0007 D1 makes a label presentation, and #55's
    // `verification_method` has no `name_match` member. Stated as data so it is
    // checkable rather than remembered.
    expect(LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE.brand_normalized_name_exact).toBe(false);
    expect(LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE.brand_alias_normalized_exact).toBe(false);
    expect(LEGACY_CATALOG_BACKFILL_POLICY.listing_vendor_text).toBe('never_backfilled');
  });

  it('names exactly one subject this domain writes', () => {
    const written = LEGACY_CATALOG_SUBJECT_KINDS.filter(
      (subject) => LEGACY_CATALOG_WRITE_OWNERS[subject] === 'catalog_backfill',
    );
    expect(written).toEqual(['listing_category_path']);
    // And it is the one whose grain is a listing, so the repair pager and the
    // classification pager address the same rows.
    expect(LEGACY_CATALOG_SUBJECT_GRAINS.listing_category_path).toBe('listing');
  });
});

describe('classifying a category assignment', () => {
  it('reports an uncategorized listing as having nothing to map', () => {
    expect(classifyCategoryAssignment(listing(), mapOf(), NOW).reason).toBe(
      'category_assignment_absent',
    );
  });

  it('reports a published, selectable, in-window node as current', () => {
    const shelf = category({ id: 'c1' });
    const verdict = classifyCategoryAssignment(
      listing({ categoryId: 'c1' }),
      mapOf(shelf),
      NOW,
    );
    expect(verdict.reason).toBe('category_assignment_current');
    expect(verdict.targetId).toBe('c1');
  });

  it('follows a merge chain to a live node and names it', () => {
    const dead = category({ id: 'c1', lifecycle: 'merged', mergedIntoCategoryId: 'c2' });
    const middle = category({ id: 'c2', lifecycle: 'merged', mergedIntoCategoryId: 'c3' });
    const live = category({ id: 'c3' });
    const verdict = classifyCategoryAssignment(
      listing({ categoryId: 'c1' }),
      mapOf(dead, middle, live),
      NOW,
    );
    expect(verdict.reason).toBe('category_assignment_merged_target_live');
    expect(verdict.targetId).toBe('c3');
  });

  it('refuses a merge chain whose end is not itself assignable', () => {
    const dead = category({ id: 'c1', lifecycle: 'merged', mergedIntoCategoryId: 'c2' });
    const structural = category({ id: 'c2', selectable: false });
    const verdict = classifyCategoryAssignment(
      listing({ categoryId: 'c1' }),
      mapOf(dead, structural),
      NOW,
    );
    // Named as unresolved rather than as "not selectable": the listing's own
    // node is merged, and telling somebody to look at a selectability flag on a
    // node the listing is not filed under is the wrong next action.
    expect(verdict.reason).toBe('category_assignment_merge_chain_unresolved');
    expect(verdict.targetId).toBe('c2');
  });

  it('refuses a merge chain that leaves the loaded map', () => {
    const dead = category({ id: 'c1', lifecycle: 'merged', mergedIntoCategoryId: 'elsewhere' });
    const verdict = classifyCategoryAssignment(listing({ categoryId: 'c1' }), mapOf(dead), NOW);
    expect(verdict.reason).toBe('category_assignment_merge_chain_unresolved');
    expect(verdict.targetId).toBeNull();
  });

  it('refuses a merge cycle rather than looping', () => {
    const a = category({ id: 'a', lifecycle: 'merged', mergedIntoCategoryId: 'b' });
    const b = category({ id: 'b', lifecycle: 'merged', mergedIntoCategoryId: 'a' });
    expect(resolveMergeTarget(a, mapOf(a, b))).toBeNull();
    expect(classifyCategoryAssignment(listing({ categoryId: 'a' }), mapOf(a, b), NOW).reason).toBe(
      'category_assignment_merge_chain_unresolved',
    );
  });

  it('refuses a merge chain deeper than the bound', () => {
    const nodes: CategoryFacts[] = [];
    for (let index = 0; index <= MERGE_CHAIN_MAX_DEPTH + 1; index += 1) {
      nodes.push(
        category({
          id: `n${String(index)}`,
          lifecycle: 'merged',
          mergedIntoCategoryId: `n${String(index + 1)}`,
        }),
      );
    }
    nodes.push(category({ id: `n${String(MERGE_CHAIN_MAX_DEPTH + 2)}` }));
    expect(resolveMergeTarget(nodes[0] as CategoryFacts, mapOf(...nodes))).toBeNull();
  });

  it('tells the three no-successor lifecycles apart', () => {
    for (const [lifecycle, reason] of [
      ['deprecated', 'category_assignment_deprecated'],
      ['suppressed', 'category_assignment_suppressed'],
      ['draft', 'category_assignment_unpublished_node'],
    ] as const) {
      const node = category({ id: 'c1', lifecycle });
      expect(
        classifyCategoryAssignment(listing({ categoryId: 'c1' }), mapOf(node), NOW).reason,
      ).toBe(reason);
    }
  });

  it('reports a structural node as not selectable', () => {
    const node = category({ id: 'c1', selectable: false });
    expect(classifyCategoryAssignment(listing({ categoryId: 'c1' }), mapOf(node), NOW).reason).toBe(
      'category_assignment_not_selectable',
    );
  });

  it('reports both ends of a closed effective window', () => {
    const notYet = category({ id: 'c1', effectiveFrom: new Date(NOW.getTime() + ONE_DAY_MS) });
    const over = category({ id: 'c2', effectiveTo: new Date(NOW.getTime() - ONE_DAY_MS) });
    expect(
      classifyCategoryAssignment(listing({ categoryId: 'c1' }), mapOf(notYet), NOW).reason,
    ).toBe('category_assignment_outside_effective_window');
    expect(classifyCategoryAssignment(listing({ categoryId: 'c2' }), mapOf(over), NOW).reason).toBe(
      'category_assignment_outside_effective_window',
    );
  });

  it('applies the stated precedence when a node is several kinds of wrong', () => {
    // Merged AND structural AND out of window: the merge wins, because the
    // operator already said where this node's identity went.
    const dead = category({
      id: 'c1',
      lifecycle: 'merged',
      mergedIntoCategoryId: 'c2',
      selectable: false,
      effectiveTo: new Date(NOW.getTime() - ONE_DAY_MS),
    });
    const live = category({ id: 'c2' });
    expect(
      classifyCategoryAssignment(listing({ categoryId: 'c1' }), mapOf(dead, live), NOW).reason,
    ).toBe('category_assignment_merged_target_live');

    // Structural AND out of window: selectability wins, because a structural
    // node is never a valid assignment at any time.
    const structural = category({
      id: 'c3',
      selectable: false,
      effectiveTo: new Date(NOW.getTime() - ONE_DAY_MS),
    });
    expect(
      classifyCategoryAssignment(listing({ categoryId: 'c3' }), mapOf(structural), NOW).reason,
    ).toBe('category_assignment_not_selectable');
  });
});

describe('classifying a category path', () => {
  it('derives the path root-first including the node itself', () => {
    expect(
      derivedCategoryPath(
        category({ id: 'c3', slug: 'sneakers', ancestorSlugs: ['clothing', 'shoes'] }),
      ),
    ).toEqual(['clothing', 'shoes', 'sneakers']);
  });

  it('compares paths as ORDERED sequences', () => {
    // A set comparison would call these equal, and the array is a PATH — the
    // order is the ancestry.
    expect(categoryPathsAgree(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(categoryPathsAgree(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(categoryPathsAgree(['a'], ['a', 'b'])).toBe(false);
  });

  it('reports agreement, drift, and both consistent-without-category shapes', () => {
    const node = category({ id: 'c1', slug: 'shoes', ancestorSlugs: ['clothing'] });
    expect(
      classifyCategoryPath(
        listing({ categoryId: 'c1', categorySlugs: ['clothing', 'shoes'] }),
        mapOf(node),
      ).reason,
    ).toBe('category_path_agrees');
    expect(
      classifyCategoryPath(
        listing({ categoryId: 'c1', categorySlugs: ['footwear', 'shoes'] }),
        mapOf(node),
      ).reason,
    ).toBe('category_path_drifted');
    expect(classifyCategoryPath(listing({ categorySlugs: [] }), mapOf()).reason).toBe(
      'category_path_absent_without_category',
    );
    expect(classifyCategoryPath(listing({ categorySlugs: ['orphan'] }), mapOf()).reason).toBe(
      'category_path_present_without_category',
    );
  });

  it('treats a category missing from the map as an orphaned path', () => {
    expect(
      classifyCategoryPath(listing({ categoryId: 'gone', categorySlugs: ['x'] }), mapOf()).reason,
    ).toBe('category_path_present_without_category');
  });
});

describe('folding legacy product-type text', () => {
  it('performs exactly the five declared folds', () => {
    expect(LEGACY_PRODUCT_TYPE_FOLDS).toHaveLength(5);
    expect(legacyProductTypeTextToKey('  Brake Pads  ')).toBe('brake_pads');
    expect(legacyProductTypeTextToKey('Shoe-Size')).toBe('shoe_size');
    expect(legacyProductTypeTextToKey('a   b')).toBe('a_b');
    expect(legacyProductTypeTextToKey('a__b')).toBe('a_b');
    expect(legacyProductTypeTextToKey('SMARTPHONE')).toBe('smartphone');
  });

  it('keeps a dotted namespace, which is why this is not step 4’s fold', () => {
    // `PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN` has no dot, so step 4's
    // `legacyOptionNameToKey` would answer `null` here and the verdict would be
    // `no_registered_key` — a wrong answer that looks exactly like a right one.
    expect(legacyProductTypeTextToKey('electronics.smartphone')).toBe('electronics.smartphone');
  });

  it('refuses text that is not a legal key rather than mangling it', () => {
    expect(legacyProductTypeTextToKey('')).toBeNull();
    expect(legacyProductTypeTextToKey('   ')).toBeNull();
    expect(legacyProductTypeTextToKey('Ropa de niño')).toBeNull();
    expect(legacyProductTypeTextToKey('3D Printers')).toBeNull();
    expect(legacyProductTypeTextToKey('Shoes/Sneakers')).toBeNull();
  });

  it('does not depluralise, transliterate or translate', () => {
    // The three folds somebody will want on this dataset, and the three that
    // turn a backlog into a confident wrong answer.
    expect(legacyProductTypeTextToKey('Shoes')).toBe('shoes');
    expect(legacyProductTypeTextToKey('Zapatos')).toBe('zapatos');
    expect(legacyProductTypeTextToKey('Café')).toBeNull();
  });

  it('keeps the fold lists disjoint and both non-empty', () => {
    const performed = new Set<string>(LEGACY_PRODUCT_TYPE_FOLDS);
    for (const forbidden of LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS) {
      expect(performed.has(forbidden), `${forbidden} is on both lists`).toBe(false);
    }
    expect(LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS).toHaveLength(10);
  });
});

describe('classifying legacy product-type text', () => {
  const shelf = category({ id: 'c-shoes', ancestorIds: ['c-clothing'] });
  const versions = (
    ...facts: readonly Partial<ProductTypeFacts>[]
  ): readonly ProductTypeFacts[] =>
    facts.map((fact) => ({ key: 'footwear', lifecycle: 'published', scopes: [], ...fact }));

  it('reports absent and blank text as nothing to map', () => {
    expect(classifyProductTypeText(listing(), null, [], mapOf()).reason).toBe(
      'product_type_text_absent',
    );
    expect(classifyProductTypeText(listing({ productType: '   ' }), null, [], mapOf()).reason).toBe(
      'product_type_text_absent',
    );
  });

  it('reports text that folds to nothing, and text no key answers to', () => {
    expect(
      classifyProductTypeText(listing({ productType: 'Ropa de niño' }), null, [], mapOf()).reason,
    ).toBe('product_type_no_registered_key');
    expect(
      classifyProductTypeText(listing({ productType: 'Knitwear' }), 'knitwear', [], mapOf()).reason,
    ).toBe('product_type_no_registered_key');
  });

  it('tells a drafted key apart from an unregistered one', () => {
    // Different remedies: one is "publish the version somebody drafted", the
    // other is "draft one". Collapsing them sends an operator to write a product
    // type that already exists.
    expect(
      classifyProductTypeText(
        listing({ productType: 'Footwear', categoryId: 'c-shoes' }),
        'footwear',
        versions({ lifecycle: 'draft' }, { lifecycle: 'deprecated' }),
        mapOf(shelf),
      ).reason,
    ).toBe('product_type_key_unpublished');
  });

  it('refuses to decide eligibility without a category', () => {
    expect(
      classifyProductTypeText(
        listing({ productType: 'Footwear' }),
        'footwear',
        versions({ scopes: [{ categoryId: 'c-shoes', includeDescendants: true }] }),
        mapOf(shelf),
      ).reason,
    ).toBe('product_type_key_category_unknown');
  });

  it('resolves a direct scope and a descendant scope, and refuses a scope that grants nothing', () => {
    const direct = versions({ scopes: [{ categoryId: 'c-shoes', includeDescendants: false }] });
    const ancestor = versions({ scopes: [{ categoryId: 'c-clothing', includeDescendants: true }] });
    const narrowed = versions({ scopes: [{ categoryId: 'c-clothing', includeDescendants: false }] });
    const empty = versions({ scopes: [] });
    const subject = listing({ productType: 'Footwear', categoryId: 'c-shoes' });

    expect(classifyProductTypeText(subject, 'footwear', direct, mapOf(shelf)).reason).toBe(
      'product_type_key_published_and_eligible',
    );
    expect(classifyProductTypeText(subject, 'footwear', ancestor, mapOf(shelf)).reason).toBe(
      'product_type_key_published_and_eligible',
    );
    expect(classifyProductTypeText(subject, 'footwear', narrowed, mapOf(shelf)).reason).toBe(
      'product_type_key_published_not_eligible',
    );
    // An empty scope set GRANTS nothing — the deliberate asymmetry with
    // `attribute_definition_categories`, stated on the table itself.
    expect(classifyProductTypeText(subject, 'footwear', empty, mapOf(shelf)).reason).toBe(
      'product_type_key_published_not_eligible',
    );
    expect(isProductTypeEligible(empty[0] as ProductTypeFacts, shelf)).toBe(false);
  });
});

describe('classifying a vendor value', () => {
  it('reports an unnormalizable value rather than calling it absent', () => {
    expect(classifyVendorValue('', []).reason).toBe('vendor_text_unnormalizable');
    expect(classifyVendorValue('   ', ['b1']).reason).toBe('vendor_text_unnormalizable');
  });

  it('counts candidates and never chooses between them', () => {
    expect(classifyVendorValue('nike', []).reason).toBe('vendor_brand_no_candidate');

    const single = classifyVendorValue('nike', ['b1']);
    expect(single.reason).toBe('vendor_brand_single_candidate');
    expect(single.targetId).toBe('b1');
    expect(LEGACY_MAPPING_REASON_CLASSES.vendor_brand_single_candidate.mappingClass).toBe(
      'high_confidence',
    );

    const several = classifyVendorValue('nike', ['b1', 'b2']);
    expect(several.reason).toBe('vendor_brand_multiple_candidates');
    // No target: picking one is a coin toss with a brand's identity on it.
    expect(several.targetId).toBeNull();
  });
});
