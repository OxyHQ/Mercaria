/**
 * The storefront's PURE catalog composition, executed (#367 workstream 9).
 *
 * ## Why this package gained a runner
 *
 * The backend suite carries every other storefront check —
 * `route-reachability.test.ts`, `seller-identity-isolation.test.ts` (#92),
 * `product-page-isolation.test.ts` (#71) — and all of them SCAN storefront
 * source as TEXT. That is not an aesthetic choice: the backend's `rootDir` is
 * its own package root by an explicit decision recorded in its `tsconfig.json`,
 * so a backend test file cannot IMPORT a file from another package at all
 * (TS6059). Excluding one test from that program to get around it makes
 * `parserOptions.project` unable to parse it either, so the file ends up
 * neither typechecked nor linted — two holes for one test, measured.
 *
 * So the cases live here, where the modules they exercise already are: the
 * app's own `tsc --noEmit` typechecks this file, and vitest runs it. The
 * config is deliberately narrow — `lib/**` only, node environment, no jsdom,
 * no React — because what is testable without a renderer is exactly the pure
 * composition, and a runner that could mount a component would invite tests
 * this package has no business shape for yet.
 *
 * ## What a gate cannot see
 *
 * `scripts/validate-storefront-catalog-driven.mjs` checks SHAPE — that nothing
 * branches on a category by name, that no vocabulary is re-listed. Every case
 * below is about BEHAVIOUR, and the distinction is not academic:
 * `parseComparisonSubjects` trimmed the whole `?p=` entry instead of each half,
 * so `?p= a-handle :var` kept a trailing space inside the handle and would have
 * 404'd — and `tsc`, ESLint, `expo export` and all five walls of that gate were
 * green on it. Running the function is what found it, and the case is the last
 * one in the comparison block below.
 *
 * ## Only the pure modules
 *
 * `facet-selection.ts`, `variant-axes.ts` and `comparison.ts` import types and
 * closed tuples from `@mercaria/shared-types` and nothing else — no React, no
 * `expo-localization`, no `@mercaria/ui`. `lib/catalog/locale.ts` exists as a
 * leaf precisely so `variant-axes.ts` can stay that way. A module that grows a
 * renderer import drops out of this file, loudly, at import time — which is a
 * property worth keeping, because it is what makes this logic testable at all.
 */

import { describe, expect, it } from 'vitest';
import type { FacetSelectionEntry } from '@mercaria/shared-types';
import {
  parseFacetSelection,
  serializeFacetSelection,
  toggleFacetValue,
} from '../facet-selection';
import { applyVariantChoice, composeVariantMatrix } from '../variant-axes';
import { assessComparability, parseComparisonSubjects } from '../comparison';

/* ────────────────────────────────────────────────────────────────────────── */
/* Filter state and its URL grammar                                           */
/* ────────────────────────────────────────────────────────────────────────── */

describe('the facet selection URL grammar', () => {
  const selection: readonly FacetSelectionEntry[] = [
    { origin: 'attribute', facetKey: 'color', values: ['black', 'white'] },
    {
      origin: 'commerce',
      facetKey: 'offer_price',
      minMinor: 1000,
      maxMinor: 5000,
      currency: 'EUR',
    },
    { origin: 'attribute', facetKey: 'screen_size', min: 5, max: 7 },
    { origin: 'taxonomy', facetKey: 'category', values: ['cat-1'] },
  ];

  it('round-trips every entry shape without changing one', () => {
    const encoded = serializeFacetSelection(selection);
    expect(encoded).toBeDefined();
    const decoded = parseFacetSelection(encoded);
    expect(decoded.entries).toEqual(selection);
    expect(decoded.droppedEntryCount).toBe(0);
  });

  it('survives every separator appearing inside a bucket key', () => {
    // A bucket key is an arbitrary string the registry chose, so the grammar's
    // own separators are not reserved in it. Percent-encoding is what makes the
    // parse total rather than dependent on the registry's naming taste.
    const values = ['a;b', 'c|d', 'e~f', 'g=h'];
    const encoded = serializeFacetSelection([
      { origin: 'attribute', facetKey: 'color', values },
    ]);
    expect(parseFacetSelection(encoded).entries[0]?.values).toEqual(values);
  });

  it('DROPS an unreadable entry and counts it rather than guessing', () => {
    const parsed = parseFacetSelection(
      'nonsense;attribute~=x;bogus~color=black;attribute~color=black',
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.droppedEntryCount).toBe(3);
  });

  it('refuses a currency the server does not price in, never coercing it', () => {
    // A money bound whose currency is refused is a 400; a bound applied under
    // some other currency would be a filter the shopper never asked for.
    const parsed = parseFacetSelection('commerce~offer_price=1..2@XXX');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.droppedEntryCount).toBe(1);
  });

  it('refuses a range on a taxonomy entry, which has no range shape', () => {
    const parsed = parseFacetSelection('taxonomy~category=1..2');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.droppedEntryCount).toBe(1);
  });

  it('reads an empty parameter as an empty selection, not as a fault', () => {
    expect(parseFacetSelection('')).toEqual({ entries: [], droppedEntryCount: 0 });
  });

  it('toggles one value off without disturbing the other entries', () => {
    const next = toggleFacetValue(selection, 'attribute', 'color', 'black', true);
    expect(next).toHaveLength(4);
    expect(next.find((entry) => entry.facetKey === 'color')?.values).toEqual(['white']);
  });

  it('replaces rather than appends when the facet is single-select', () => {
    const first = toggleFacetValue([], 'attribute', 'color', 'black', false);
    const second = toggleFacetValue(first, 'attribute', 'color', 'white', false);
    expect(second[0]?.values).toEqual(['white']);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Variant axes and availability                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/** storage × colour, SPARSE: no 512 GB in white, and 256 GB black is unstocked. */
const VARIANTS = [
  {
    id: 'v1',
    isDefault: true,
    options: [
      { key: 'storage', displayValue: '256 GB', normalizedValue: '256', position: 0 },
      { key: 'colour', displayValue: 'Black', normalizedValue: 'black', position: 1 },
    ],
    offerCount: 0,
  },
  {
    id: 'v2',
    isDefault: false,
    options: [
      { key: 'storage', displayValue: '256 GB', normalizedValue: '256', position: 0 },
      { key: 'colour', displayValue: 'White', normalizedValue: 'white', position: 1 },
    ],
    offerCount: 3,
  },
  {
    id: 'v3',
    isDefault: false,
    options: [
      { key: 'storage', displayValue: '512 GB', normalizedValue: '512', position: 0 },
      { key: 'colour', displayValue: 'Black', normalizedValue: 'black', position: 1 },
    ],
    offerCount: 2,
  },
];

function matrix(selection: Readonly<Record<string, string>>, declared = ['storage', 'colour']) {
  return composeVariantMatrix({
    product: { variantDefiningAttributeKeys: declared },
    variants: VARIANTS,
    definitions: [],
    locale: 'en-GB',
    selection,
  });
}

describe('the variant matrix', () => {
  it('takes the axes the PRODUCT declares, in the order it declares them', () => {
    const composed = matrix({ storage: '512' });
    expect(composed.axisSource).toBe('product_declared');
    expect(composed.axes.map((axis) => axis.key)).toEqual(['storage', 'colour']);
  });

  it('marks a combination no configuration carries IMPOSSIBLE and unselectable', () => {
    const colour = matrix({ storage: '512' }).axes.find((axis) => axis.key === 'colour');
    const white = colour?.values.find((value) => value.normalizedValue === 'white');
    expect(white?.availability).toBe('impossible');
    expect(white?.selectable).toBe(false);
  });

  it('marks a configuration with zero offers UNAVAILABLE, which is a different fact', () => {
    // "We do not make that one" and "that one is out of stock" lead a shopper
    // to opposite next actions, so the two states are never collapsed.
    const storage = matrix({ colour: 'black' }).axes.find((axis) => axis.key === 'storage');
    const small = storage?.values.find((value) => value.normalizedValue === '256');
    expect(small?.availability).toBe('unavailable');
    expect(small?.selectable).toBe(false);
  });

  it('keeps every value of an axis reachable by ignoring that axis own selection', () => {
    // Evaluating against the FULL selection would leave each axis with exactly
    // one enabled value — its own — which is a selector nobody can move.
    const storage = matrix({ storage: '512' }).axes.find((axis) => axis.key === 'storage');
    expect(storage?.values.every((value) => value.availability !== 'impossible')).toBe(true);
  });

  it('disables NOTHING when the offers half was withheld', () => {
    // `offerCount` is absent when a canonical read lever is off. Reading absence
    // as "no offers" would present a withheld comparison as a discontinued
    // product — unknown is never a soft no.
    const withheld = composeVariantMatrix({
      product: { variantDefiningAttributeKeys: ['storage', 'colour'] },
      variants: VARIANTS.map(({ offerCount: _dropped, ...rest }) => rest),
      definitions: [],
      locale: 'en-GB',
      selection: {},
    });
    expect(withheld.availabilityKnown).toBe(false);
    expect(
      withheld.axes.every((axis) => axis.values.every((value) => value.selectable)),
    ).toBe(true);
  });

  it('resolves a complete selection to exactly one configuration', () => {
    expect(matrix({ storage: '512', colour: 'black' }).selectedVariantId).toBe('v3');
  });

  it('applies a choice always, clearing only what it invalidates', () => {
    const next = applyVariantChoice(
      matrix({ storage: '512', colour: 'black' }),
      VARIANTS,
      'storage',
      '256',
    );
    expect(next).toEqual({ storage: '256', colour: 'black' });
  });

  it('clears the conflicting axis when the chosen value makes it impossible', () => {
    const next = applyVariantChoice(matrix({ storage: '512' }), VARIANTS, 'colour', 'white');
    expect(next.colour).toBe('white');
    expect(next.storage).toBeUndefined();
  });

  it('deselects when the already-selected value is pressed again', () => {
    const next = applyVariantChoice(
      matrix({ storage: '512', colour: 'black' }),
      VARIANTS,
      'storage',
      '512',
    );
    expect(next.storage).toBeUndefined();
    expect(next.colour).toBe('black');
  });

  it('falls back to the observed axes when the product declares none', () => {
    const observed = matrix({}, []);
    expect(observed.axisSource).toBe('observed_from_configurations');
    expect(observed.axes.map((axis) => axis.key)).toEqual(['storage', 'colour']);
  });

  it('produces NO axes when the configurations differ on nothing recorded', () => {
    const none = composeVariantMatrix({
      product: { variantDefiningAttributeKeys: [] },
      variants: [{ id: 'x', isDefault: true, options: [], offerCount: 1 }],
      definitions: [],
      locale: 'en-GB',
      selection: {},
    });
    expect(none.axes).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Comparability                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function statedCell(text: string) {
  return {
    state: 'source_backed' as const,
    value: { type: 'text' as const, text, rendered: text },
    recordRefs: [],
  };
}

function comparisonInput(options: {
  readonly categoryIds: readonly (string | undefined)[];
  readonly cells: Record<string, ReturnType<typeof statedCell> | { state: 'conflicting' }>;
}) {
  const refs = options.categoryIds.map((_value, index) => `s${String(index)}`);
  return {
    subjects: refs.map((ref, index) => ({
      ref,
      name: ref.toUpperCase(),
      ...(options.categoryIds[index] === undefined
        ? {}
        : { categoryId: options.categoryIds[index] }),
      acquisition: { kind: 'purchasable' },
      offerRefs: [],
    })),
    table: {
      subjectRefs: refs,
      rows: [
        {
          key: 'weight',
          label: 'Weight',
          direction: 'not_comparable' as const,
          cells: options.cells,
          differs: true,
        },
      ],
      constraints: [],
      tradeoffs: [],
      differences: [],
    },
  } as unknown as Parameters<typeof assessComparability>[0];
}

describe('assessComparability', () => {
  it('calls two products in one category with a shared row comparable', () => {
    const verdict = assessComparability(
      comparisonInput({
        categoryIds: ['c1', 'c1'],
        cells: { s0: statedCell('1'), s1: statedCell('2') },
      }),
    );
    expect(verdict.kind).toBe('comparable');
  });

  it('does NOT count a conflicting cell as shared ground', () => {
    // #94 selects NEITHER candidate when two sources disagree, so counting it
    // would let a comparison claim common ground resting on a disagreement
    // nobody resolved.
    const verdict = assessComparability(
      comparisonInput({
        categoryIds: ['c1', 'c1'],
        cells: { s0: statedCell('1'), s1: { state: 'conflicting' } },
      }),
    );
    expect(verdict.kind).toBe('no_shared_facts');
  });

  it('flags a cross-category comparison rather than refusing it', () => {
    const verdict = assessComparability(
      comparisonInput({
        categoryIds: ['c1', 'c2'],
        cells: { s0: statedCell('1'), s1: statedCell('2') },
      }),
    );
    expect(verdict.kind).toBe('comparable_across_categories');
  });

  it('answers `too_few_subjects` below two, as its own verdict', () => {
    const verdict = assessComparability(
      comparisonInput({ categoryIds: ['c1'], cells: { s0: statedCell('1') } }),
    );
    expect(verdict.kind).toBe('too_few_subjects');
  });
});

describe('parseComparisonSubjects', () => {
  it('reads a bare handle and a handle:variant in one list', () => {
    expect(parseComparisonSubjects('iphone-16:var-256,pixel-9')).toEqual([
      { handle: 'iphone-16', canonicalVariantId: 'var-256' },
      { handle: 'pixel-9' },
    ]);
  });

  it('trims BOTH halves and drops an entry with no handle', () => {
    // The regression this file exists for. Trimming the whole entry leaves
    // `"  a-handle :var"` with a trailing space INSIDE the handle, which the
    // server answers 404 for — invisible to tsc, lint, the build and every
    // wall of the storefront's own gate.
    expect(parseComparisonSubjects(': ,:v, a : b ,x:')).toEqual([
      { handle: 'a', canonicalVariantId: 'b' },
      { handle: 'x' },
    ]);
  });
});
