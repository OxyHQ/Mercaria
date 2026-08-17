/**
 * The pure policy modules (#367 Workstream 10): generation, partition,
 * suppression, ordering, sorting and the empty state.
 *
 * Every decision the facet rail makes lives in one of these, none of them
 * touches a database, and each is tested for the case that would be WRONG
 * rather than for the happy path — a facet rail's failures are all silent, so a
 * test that only proves the good case proves nothing about the bad one.
 */

import { describe, expect, it } from 'vitest';
import {
  FACET_MIN_DISTINCT_VALUES,
  FACET_TAXONOMY_KEY,
  type FacetSelectionEntry,
} from '@mercaria/shared-types';
import {
  FACET_SHAPE_BY_VALUE_TYPE,
  FACET_UNTYPED_GROUP_POSITION,
  planFacets,
  type FacetDefinitionInput,
  type FacetProductTypeFieldInput,
} from '../metadata.js';
import { liftFacet, partitionSelection } from '../selection.js';
import { suppressBuckets, suppressFacet } from '../suppression.js';
import {
  compareByCount,
  compareByRegistryPosition,
  compareConditionBuckets,
  compareFacets,
} from '../ordering.js';
import { buildSortOptions, resolveFacetSort } from '../sorting.js';
import { composeEmptyState, emptyStateReason } from '../suggestions.js';
import { composePriceSpan, convertPriceBound } from '../price.js';
import { projectCurrencyExclusions } from '../../fx-exclusions.js';

function definition(overrides: Partial<FacetDefinitionInput> = {}): FacetDefinitionInput {
  return {
    definitionId: 'def-colour',
    key: 'colour',
    version: 3,
    baseLabel: 'Colour',
    valueType: 'enum',
    cardinality: 'single',
    baseUnit: null,
    filterable: true,
    sortable: false,
    hardConstraintCapable: true,
    variantDefining: true,
    ...overrides,
  };
}

function field(overrides: Partial<FacetProductTypeFieldInput> = {}): FacetProductTypeFieldInput {
  return {
    attributeKey: 'colour',
    scope: 'variant',
    requirement: 'required',
    variantCapable: true,
    fieldPosition: 2,
    groupKey: 'appearance',
    groupLabel: 'Appearance',
    groupPosition: 1,
    ...overrides,
  };
}

describe('facets are generated from metadata, never from a list', () => {
  it('takes the GRAIN from the product type field, not from the data', () => {
    const [entry] = planFacets([definition({ variantDefining: false })], [field()]);
    // The definition says this is not variant-defining; the TYPE says the field
    // is variant-scoped. The type wins, because eligibility for THIS kind of
    // product is exactly what a product type version states.
    expect(entry?.level).toBe('variant');
  });

  it('falls back to the registry when no product type names the attribute', () => {
    const [entry] = planFacets([definition({ variantDefining: true })], []);
    expect(entry?.level).toBe('variant');
    // …and it sorts after everything the type DID name, rather than at 0 where
    // it would jump the published order.
    expect(entry?.groupPosition).toBe(FACET_UNTYPED_GROUP_POSITION);
  });

  it('withholds an attribute the registry says is not filterable', () => {
    const [entry] = planFacets([definition({ filterable: false })], [field()]);
    expect(entry?.suppression).toBe('not_filterable');
  });

  it('withholds a field the product type hides or forbids', () => {
    for (const requirement of ['hidden', 'forbidden']) {
      const [entry] = planFacets([definition()], [field({ requirement })]);
      expect(entry?.suppression).toBe('hidden_by_product_type');
    }
    // …and admits every other requirement, so the check is not vacuous.
    for (const requirement of ['required', 'recommended', 'optional']) {
      const [entry] = planFacets([definition()], [field({ requirement })]);
      expect(entry?.suppression).toBeUndefined();
    }
  });

  it('refuses a compatibility-scoped field rather than treating it as a product fact', () => {
    const [entry] = planFacets([definition()], [field({ scope: 'compatibility' })]);
    // ADR 0007 D8: a year range is a relationship, and one brake pad fits a
    // thousand vehicles as ONE variant. Mapping it onto `product` would put a
    // fitment in a facet whose count is over products.
    expect(entry?.suppression).toBe('compatibility_scope');
  });

  it('names a shape for every value type, and refuses the two it cannot face', () => {
    // A `Record` over the whole union, so a value type added to #94 without a
    // decision here is a compile error rather than a silent default.
    const shapes = Object.values(FACET_SHAPE_BY_VALUE_TYPE);
    expect(shapes.length).toBe(9);
    expect(FACET_SHAPE_BY_VALUE_TYPE.date).toBeNull();
    expect(FACET_SHAPE_BY_VALUE_TYPE.structured).toBeNull();
    expect(FACET_SHAPE_BY_VALUE_TYPE.money).toBe('money_range');
    expect(FACET_SHAPE_BY_VALUE_TYPE.measurement).toBe('range');

    const [entry] = planFacets([definition({ valueType: 'date' })], []);
    expect(entry?.suppression).toBe('unsupported_value_type');
  });

  it('reports the registrys own capability flags rather than deriving them', () => {
    const [entry] = planFacets(
      [definition({ sortable: true, hardConstraintCapable: false })],
      [field()],
    );
    expect(entry?.sortable).toBe(true);
    expect(entry?.hardConstraintCapable).toBe(false);
    // …and the policy for absence is #94's own vocabulary, not a third value.
    expect(entry?.missingDataPolicy).toBe('exclude_when_unknown');
  });

  it('produces exactly one entry per definition, offered or refused', () => {
    const plan = planFacets(
      [
        definition(),
        definition({ key: 'material', definitionId: 'def-material', filterable: false }),
        definition({ key: 'released', definitionId: 'def-released', valueType: 'date' }),
      ],
      [],
    );
    // Returning fewer would make "no facet" and "never looked at" the same
    // observation, which is the vacuity the suppression list exists to prevent.
    expect(plan).toHaveLength(3);
    expect(plan.filter((entry) => entry.suppression !== undefined)).toHaveLength(2);
  });
});

describe('a selection lands at the grain its facet binds at', () => {
  const lookup = {
    levelOf: (key: string) =>
      key === 'colour' ? ('variant' as const) : key === 'material' ? ('product' as const) : undefined,
  };

  it('partitions attribute selections by level', () => {
    const { requirements } = partitionSelection(
      [
        { origin: 'attribute', facetKey: 'colour', values: ['red'] },
        { origin: 'attribute', facetKey: 'material', values: ['leather'] },
      ],
      lookup,
    );
    expect(requirements.variant.map((r) => r.key)).toEqual(['colour']);
    expect(requirements.product.map((r) => r.key)).toEqual(['material']);
  });

  it('folds every commerce dimension onto ONE offer requirement set', () => {
    const { requirements } = partitionSelection(
      [
        { origin: 'commerce', facetKey: 'availability', values: ['in_stock'] },
        { origin: 'commerce', facetKey: 'condition', values: ['new'] },
        { origin: 'commerce', facetKey: 'offer_channel', values: ['native'] },
      ],
      lookup,
    );
    // One object, so there is no per-dimension requirement the repository could
    // evaluate independently — which is what makes same-offer unavoidable.
    expect(requirements.offer.availability).toEqual(['in_stock']);
    expect(requirements.offer.conditionGroups).toEqual(['new']);
    expect(requirements.offer.channels).toEqual(['native']);
  });

  it('reports a selection naming a facet nothing generated', () => {
    const { unknownFacetKeys } = partitionSelection(
      [{ origin: 'attribute', facetKey: 'invented', values: ['x'] }],
      lookup,
    );
    expect(unknownFacetKeys).toEqual(['invented']);
  });

  it('carries a price bound separately, because it needs FX before it is a predicate', () => {
    const { requestedPrice, requirements } = partitionSelection(
      [{ origin: 'commerce', facetKey: 'offer_price', maxMinor: 50_000, currency: 'EUR' }],
      lookup,
    );
    expect(requestedPrice).toEqual({ currency: 'EUR', maxMinor: 50_000 });
    expect(requirements.offer.priceBounds).toBeUndefined();
  });

  it('lifts exactly ONE facets own contribution and leaves the rest', () => {
    const { requirements } = partitionSelection(
      [
        { origin: 'attribute', facetKey: 'colour', values: ['red'] },
        { origin: 'attribute', facetKey: 'material', values: ['leather'] },
        { origin: 'commerce', facetKey: 'availability', values: ['in_stock'] },
        { origin: 'commerce', facetKey: 'condition', values: ['new'] },
      ],
      lookup,
    );

    const withoutColour = liftFacet(requirements, 'colour', 'variant');
    expect(withoutColour.variant).toEqual([]);
    expect(withoutColour.product.map((r) => r.key)).toEqual(['material']);
    expect(withoutColour.offer.availability).toEqual(['in_stock']);

    const withoutAvailability = liftFacet(requirements, 'availability', 'offer');
    expect(withoutAvailability.offer.availability).toBeUndefined();
    // The OTHER offer dimension stays — lifting all of them would answer "how
    // many offers exist at all", which is a different number.
    expect(withoutAvailability.offer.conditionGroups).toEqual(['new']);
  });

  it('lifts the taxonomy refinement too', () => {
    const { requirements } = partitionSelection(
      [{ origin: 'taxonomy', facetKey: FACET_TAXONOMY_KEY, values: ['cat-1'] }],
      lookup,
    );
    expect(requirements.categoryIds).toEqual(['cat-1']);
    expect(liftFacet(requirements, FACET_TAXONOMY_KEY, 'product').categoryIds).toBeUndefined();
  });
});

describe('suppression never withdraws what the shopper chose', () => {
  it('drops a zero-count bucket', () => {
    const { kept } = suppressBuckets(
      [
        { key: 'red', count: 3, selected: false },
        { key: 'teal', count: 0, selected: false },
      ],
      50,
    );
    expect(kept.map((bucket) => bucket.key)).toEqual(['red']);
  });

  it('KEEPS a zero-count bucket the shopper selected', () => {
    const { kept } = suppressBuckets(
      [
        { key: 'red', count: 3, selected: false },
        { key: 'teal', count: 0, selected: true },
      ],
      50,
    );
    // Their filter is still applied; removing the chip would leave the page
    // narrowed with nothing explaining why, and no way back except clearing all.
    expect(kept.map((bucket) => bucket.key)).toEqual(['red', 'teal']);
  });

  it('never drops a selected bucket to the size cap', () => {
    const buckets = Array.from({ length: 10 }, (_, index) => ({
      key: `v${String(index)}`,
      count: 10 - index,
      selected: index === 9,
    }));
    const { kept } = suppressBuckets(buckets, 3);
    expect(kept.some((bucket) => bucket.key === 'v9')).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(3);
  });

  it('withholds a facet that cannot narrow anything', () => {
    const single = suppressFacet({
      key: 'colour',
      shape: 'buckets',
      buckets: [{ key: 'red', count: 4, selected: false }],
      hasSelection: false,
    });
    expect(single).toBe('single_value');
    expect(FACET_MIN_DISTINCT_VALUES).toBe(2);

    const none = suppressFacet({ key: 'colour', shape: 'buckets', buckets: [], hasSelection: false });
    expect(none).toBe('no_values');

    const degenerate = suppressFacet({
      key: 'weight',
      shape: 'range',
      buckets: [],
      rangeMin: 900,
      rangeMax: 900,
      hasSelection: false,
    });
    expect(degenerate).toBe('degenerate_range');
  });

  it('offers a degenerate facet anyway when the shopper is using it', () => {
    expect(
      suppressFacet({
        key: 'colour',
        shape: 'buckets',
        buckets: [{ key: 'red', count: 0, selected: true }],
        hasSelection: true,
      }),
    ).toBeUndefined();
  });

  it('but a METADATA refusal survives a selection', () => {
    // A stale client sending a selection must not be able to summon a control
    // the registry or the product type deliberately withheld.
    expect(
      suppressFacet({
        key: 'colour',
        metadataSuppression: 'not_filterable',
        shape: 'buckets',
        buckets: [{ key: 'red', count: 5, selected: true }],
        hasSelection: true,
      }),
    ).toBe('not_filterable');
  });
});

describe('ordering reads a published position and nothing else', () => {
  it('orders the rail by group, then field, then key', () => {
    const rail = [
      { key: 'zeta', groupPosition: 1, fieldPosition: 0 },
      { key: 'alpha', groupPosition: 0, fieldPosition: 9 },
      { key: 'beta', groupPosition: 1, fieldPosition: 0 },
    ];
    expect([...rail].sort(compareFacets).map((facet) => facet.key)).toEqual([
      'alpha',
      'beta',
      'zeta',
    ]);
  });

  it('orders enum values by the registrys position, never by popularity', () => {
    const sizes = [
      { key: 'xl', count: 90, registryPosition: 3 },
      { key: 's', count: 2, registryPosition: 0 },
      { key: 'm', count: 100, registryPosition: 1 },
      { key: 'l', count: 50, registryPosition: 2 },
    ];
    // `S, M, L, XL` — the count order would be `M, XL, L, S`, which is how a
    // size picker becomes unreadable.
    expect([...sizes].sort(compareByRegistryPosition).map((v) => v.key)).toEqual([
      's',
      'm',
      'l',
      'xl',
    ]);
    expect([...sizes].sort(compareByCount).map((v) => v.key)).toEqual(['m', 'xl', 'l', 's']);
  });

  it('orders condition segments by the taxonomy, best first', () => {
    const groups = [
      { key: 'for_parts', count: 1 },
      { key: 'new', count: 1 },
      { key: 'used', count: 1 },
    ];
    expect([...groups].sort(compareConditionBuckets).map((v) => v.key)).toEqual([
      'new',
      'used',
      'for_parts',
    ]);
  });

  it('every comparator is TOTAL, so a shuffle cannot change the order', () => {
    const values = [
      { key: 'a', count: 5, registryPosition: 1 },
      { key: 'b', count: 5, registryPosition: 1 },
      { key: 'c', count: 5, registryPosition: 1 },
    ];
    // Identical on every input but the key. Without the key tiebreak, `sort`'s
    // stability leaks the order the planner returned the rows in.
    for (const shuffled of [
      [values[0], values[1], values[2]],
      [values[2], values[0], values[1]],
      [values[1], values[2], values[0]],
    ]) {
      expect(
        [...(shuffled as typeof values)].sort(compareByRegistryPosition).map((v) => v.key),
      ).toEqual(['a', 'b', 'c']);
    }
  });
});

describe('sorting is offered only where the metadata says so', () => {
  const priceLabel = { text: 'offer_price', source: 'stable_key' as const };

  it('generates a sort only for a sortable, offered attribute', () => {
    const options = buildSortOptions(
      [
        { key: 'weight', sortable: true, label: priceLabel, suppressed: false },
        { key: 'colour', sortable: false, label: priceLabel, suppressed: false },
        { key: 'secret', sortable: true, label: priceLabel, suppressed: true },
      ],
      priceLabel,
    );
    const keys = new Set(options.map((option) => option.key));
    expect(keys.has('weight')).toBe(true);
    // Not sortable: no option.
    expect(keys.has('colour')).toBe(false);
    // Sortable but withheld: offering the sort would expose the hidden field
    // through the ordering, which is the same disclosure by another control.
    expect(keys.has('secret')).toBe(false);
    expect(keys.has('offer_price')).toBe(true);
  });

  it('refuses an unsortable key by NAME and an unknown one differently', () => {
    const options = buildSortOptions(
      [{ key: 'weight', sortable: true, label: priceLabel, suppressed: false }],
      priceLabel,
    );
    expect(resolveFacetSort({ key: 'colour', direction: 'asc' }, options)).toEqual({
      outcome: 'refused',
      refusal: 'unknown_key',
      key: 'colour',
    });
    expect(resolveFacetSort({ key: 'weight', direction: 'sideways' }, options)).toEqual({
      outcome: 'refused',
      refusal: 'unsupported_direction',
      key: 'weight',
    });
  });

  it('resolves a sortable key with a MANDATORY total-order tiebreak', () => {
    const options = buildSortOptions(
      [{ key: 'weight', sortable: true, label: priceLabel, suppressed: false }],
      priceLabel,
    );
    const resolution = resolveFacetSort({ key: 'weight', direction: 'desc' }, options);
    expect(resolution).toEqual({
      outcome: 'resolved',
      directive: {
        key: 'weight',
        origin: 'attribute',
        direction: 'desc',
        // Without it a keyset page over a non-total order repeats and drops
        // rows, silently.
        tiebreak: 'canonical_product_id',
      },
    });
  });
});

describe('the empty state never relaxes anything', () => {
  it('carries no results, as a SHAPE', () => {
    const state = composeEmptyState('selection_excludes_everything', [
      { facetKey: 'colour', origin: 'attribute', resultCount: 12, relaxesHardConstraint: true },
    ]);
    const suggestion = state.suggestions[0];
    expect(suggestion).toBeDefined();
    // There is no field a relaxed page could arrive in. The client asks again,
    // with the shopper having pressed something.
    expect(Object.keys(suggestion ?? {}).sort()).toEqual([
      'facetKey',
      'origin',
      'relaxesHardConstraint',
      'resultCount',
    ]);
  });

  it('drops a suggestion that would still leave nothing', () => {
    const state = composeEmptyState('selection_excludes_everything', [
      { facetKey: 'colour', origin: 'attribute', resultCount: 0, relaxesHardConstraint: true },
      { facetKey: 'material', origin: 'attribute', resultCount: 4, relaxesHardConstraint: true },
    ]);
    // A control offering to remove a filter and then showing an empty page is
    // worse than no control.
    expect(state.suggestions.map((s) => s.facetKey)).toEqual(['material']);
  });

  it('orders by what each relaxation recovers, then by the stable key', () => {
    const state = composeEmptyState('selection_excludes_everything', [
      { facetKey: 'zeta', origin: 'attribute', resultCount: 5, relaxesHardConstraint: true },
      { facetKey: 'alpha', origin: 'attribute', resultCount: 5, relaxesHardConstraint: true },
      { facetKey: 'best', origin: 'commerce', resultCount: 40, relaxesHardConstraint: true },
    ]);
    expect(state.suggestions.map((s) => s.facetKey)).toEqual(['best', 'alpha', 'zeta']);
  });

  it('tells an empty SCOPE apart from an over-narrowed selection', () => {
    // Different next actions: one says "there is nothing here", the other says
    // "your chips are the problem".
    expect(emptyStateReason(true)).toBe('no_products_in_scope');
    expect(emptyStateReason(false)).toBe('selection_excludes_everything');
  });
});

describe('a price bound is converted, never the amounts', () => {
  it('needs no rate at all when the bound is already in the only currency present', async () => {
    const converted = await convertPriceBound(
      { currency: 'EUR', minMinor: 1_000, maxMinor: 50_000 },
      ['EUR'],
    );
    expect(converted.bounds).toEqual([{ currency: 'EUR', minMinor: 1_000, maxMinor: 50_000 }]);
    expect(converted.unconvertible).toEqual([]);
  });

  it('emits no bound for a currency nothing in scope is priced in', async () => {
    // A bound for a currency no offer uses is not "everything excluded" — there
    // is simply nothing to compare, and emitting a predicate for it would make
    // the aggregate scan for rows that cannot exist.
    const converted = await convertPriceBound({ currency: 'EUR', maxMinor: 50_000 }, []);
    expect(converted.bounds).toEqual([]);
  });

  it('NAMES a present currency Mercaria does not model, and emits no bound for it', async () => {
    // `XTS` is ISO 4217's reserved testing code and is deliberately outside
    // `ALL_CURRENCY_CODES`, so `offers.price_currency`'s shape-only CHECK
    // (ADR 0002 D18) admits it while nothing can price it.
    const converted = await convertPriceBound({ currency: 'EUR', maxMinor: 50_000 }, [
      'EUR',
      'XTS',
    ]);
    // Named — this is the fix. It used to be dropped before it could be
    // reported, and the field's type made reporting it impossible (#450).
    expect(converted.unconvertible).toContain('XTS');
    // And still excluded: no bound means its offers satisfy no price filter.
    expect(converted.bounds.map((bound) => bound.currency)).not.toContain('XTS');
  });
});

describe('an unmodelled currency is NAMED rather than dropped (#450)', () => {
  const modelled = { currency: 'EUR', minMinor: 1_000, maxMinor: 5_000, productCount: 2 };
  const unmodelled = { currency: 'XTS', minMinor: 9_000, maxMinor: 9_000, productCount: 1 };
  const spans = [modelled, unmodelled];

  it('reports it beside a span it could still compose', async () => {
    // POSITIVE CONTROL first: the modelled row really did produce a span, so the
    // assertions below are about a composition that ran rather than about one
    // that never happened. Without this, an empty result would satisfy "XTS did
    // not silently contribute" just as well as the fix does.
    const composed = await composePriceSpan(spans, 'EUR');
    expect(composed.span).not.toBeNull();
    expect(composed.span?.minMinor).toBe(1_000);
    expect(composed.span?.maxMinor).toBe(5_000);

    // The load-bearing assertion: the excluded currency is NAMED.
    expect(composed.span?.unconvertible).toContain('XTS');
    expect(composed.unconvertible).toContain('XTS');

    // And it was genuinely left out rather than folded in at face value — 9_000
    // would have moved the ceiling had the raw minor units been compared.
    expect(composed.span?.maxMinor).not.toBe(9_000);
  });

  it('reports it even when there is NO span to report it on', async () => {
    // The case a bare `null` return could not express, and the one that matters
    // most: a scope priced entirely in a currency Mercaria cannot read has no
    // span AND the longest exclusion list there is. Reporting `no_values` for it
    // would tell a shopper the catalogue has no prices.
    const composed = await composePriceSpan([unmodelled], 'EUR');
    expect(composed.span).toBeNull();
    expect(composed.unconvertible).toEqual(['XTS']);
  });

  it('projects the two reported lists so the subset relation cannot break', () => {
    const report = projectCurrencyExclusions(['XTS', 'JPY', 'EUR', 'XTS']);
    // Complete: both reasons, deduplicated and sorted.
    expect(report.unconvertibleCurrencies).toEqual(['EUR', 'JPY', 'XTS']);
    // The permanent subset — only the code Mercaria has no precision entry for.
    expect(report.unmodelledCurrencies).toEqual(['XTS']);
    // Containment, which is what makes a reader of the complete list alone
    // correct. It holds by construction (one filter over one set), so this
    // asserts the construction rather than a rule somebody has to remember.
    for (const code of report.unmodelledCurrencies) {
      expect(report.unconvertibleCurrencies).toContain(code);
    }
  });
});

/** The selection union is discriminated on a STRING, which `strict: false` needs. */
describe('the selection union narrows', () => {
  it('discriminates on a string, never on a boolean literal', () => {
    const entries: FacetSelectionEntry[] = [
      { origin: 'attribute', facetKey: 'colour', values: ['red'] },
      { origin: 'commerce', facetKey: 'availability', values: ['in_stock'] },
      { origin: 'taxonomy', facetKey: FACET_TAXONOMY_KEY, values: ['cat-1'] },
    ];
    // Without `strictNullChecks` TypeScript does not narrow on the truthiness
    // of a boolean-literal discriminant — measured in #68 and again in #110.
    // This compiles only because `origin` is a string.
    const kinds = entries.map((entry) =>
      entry.origin === 'attribute'
        ? entry.facetKey
        : entry.origin === 'commerce'
          ? entry.facetKey
          : entry.values.length,
    );
    expect(kinds).toEqual(['colour', 'availability', 1]);
  });
});
