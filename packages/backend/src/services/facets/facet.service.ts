/**
 * The facet rail, composed (#367 Workstream 10).
 *
 * This module owns the ORDER OF OPERATIONS and nothing else — every decision it
 * makes was made in a pure module beside it (`metadata`, `selection`,
 * `ordering`, `suppression`, `sorting`, `suggestions`, `price`, `labels`) and
 * every statement it issues lives in `db/facets/`. That split is what lets the
 * two semantics be tested without a database and the two aggregates be measured
 * without a service.
 *
 * ## The statement budget is CONSTANT in the size of the scope
 *
 * A first load costs a fixed set of aggregates whether the category holds forty
 * products or four hundred thousand, because every one of them is a `group by`
 * over an indexed predicate rather than a per-product read. It grows by ONE
 * statement per SELECTED facet, and only per selected facet, because a facet's
 * counts must be taken with its own selection lifted (`selection.liftFacet`) and
 * every facet that is not selected shares the unlifted requirement set. `docs/facets.md`
 * carries the count.
 *
 * ## What this domain does not do
 *
 * It returns no products, in any shape, ever. `matchedProductCount` is a number
 * and the facets are counts. Listing and ordering the results is #70's and
 * #74's, and a module here that returned a page would be a second answer to
 * "what matches" and a second place an ordering could be decided. It is also why
 * `resolveFacetSort` hands back a DIRECTIVE rather than sorted rows.
 */

import type {
  CurrencyCode,
  Facet,
  FacetBucket,
  FacetLabel,
  FacetLevel,
  FacetRangeDisplay,
  FacetResponse,
  FacetScope,
  FacetSelectionEntry,
  FacetSortResolution,
  FacetSuppression,
  FacetValues,
  ResolvedFacetScope,
  ResolvedFacetSelectionEntry,
} from '@mercaria/shared-types';
import {
  CONDITION_KEY_GROUP,
  FACET_COMMERCE_DIMENSIONS,
  FACET_MAX_BUCKETS,
  FACET_MAX_OBSERVED_LABELS,
  FACET_TAXONOMY_KEY,
} from '@mercaria/shared-types';
import type { ItemConditionKey } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countCategoryBuckets,
  countFacetMatchedProducts,
  countOfferAvailabilityBuckets,
  countOfferChannelBuckets,
  countOfferConditionBuckets,
  countOfferMarketBuckets,
  countProductAttributeBuckets,
  countProductsWithAttribute,
  countVariantAttributeBuckets,
  findFacetCategoryScope,
  findFacetChildCategories,
  listObservedValueLabels,
  listScopeOfferCurrencies,
  measureOfferPriceSpans,
  measureProductAttributeRanges,
  measureVariantAttributeRanges,
  type FacetQueryContext,
  type FacetRequirements,
  type FacetScopeInput,
} from '../../db/facets/facetRepository.js';
import {
  findProductTypeForCategory,
  listFacetAttributeLabels,
  listFacetEnumValues,
  listProductTypeFacetFields,
} from '../../db/facets/facetMetadataRepository.js';
import { resolveDefinitionsForCategory } from '../attributes/definition-registry.service.js';
import {
  renderMeasurement,
  type MeasurementSystem,
} from '../canonical/display-units.js';
import { readLocalizedAttributeValues, readLocalizedCategories } from '../catalog-localization/read.service.js';
import { attributeNameLabel, facetLocaleChain, labelFromResolution, stableKeyLabel } from './labels.js';
import { planFacets, type FacetPlanEntry } from './metadata.js';
import {
  compareAvailabilityBuckets,
  compareByCount,
  compareByRegistryPosition,
  compareChannelBuckets,
  compareConditionBuckets,
  compareFacets,
  compareMarketBuckets,
  type OrderableBucket,
} from './ordering.js';
import { composePriceSpan, convertPriceBound } from './price.js';
import { projectCurrencyExclusions } from '../fx-exclusions.js';
import { liftFacet, partitionSelection, withPriceBounds } from './selection.js';
import { buildSortOptions, resolveFacetSort } from './sorting.js';
import { composeEmptyState, emptyStateReason, type MeasuredRelaxation } from './suggestions.js';
import { suppressBuckets, suppressFacet } from './suppression.js';

/** What a facet run is asked. */
export interface FacetRequest {
  readonly scope: FacetScope;
  readonly selection: readonly FacetSelectionEntry[];
  readonly locale: string;
  /**
   * The currency price figures are expressed in. Display only — the catalogue
   * stores native currency and this domain converts nothing on the way in.
   */
  readonly displayCurrency: CurrencyCode;
  /**
   * How measurements are SHOWN, or `null` for "the request stated nothing"
   * (#367 line 598).
   *
   * Already RESOLVED by the caller through `catalog-attributes.controller.ts`'s
   * own rule — an explicit `unitSystem` beats a `market` — so this domain holds
   * one answer and never a pair it could combine differently. `null` is a real
   * value and not a missing one: with no preference every range is served in its
   * base unit exactly as it was before this existed, which is also what a market
   * `measurementSystemForMarket` cannot place resolves to.
   */
  readonly measurementSystem?: MeasurementSystem | null;
  readonly sort?: { readonly key: string; readonly direction: string };
  readonly now?: Date;
}

/** The rail, plus the verdict on any requested sort. */
export interface FacetOutcome {
  readonly response: FacetResponse;
  readonly sort?: FacetSortResolution;
}

/** A generated facet before its counts are attached. */
interface PendingFacet {
  readonly plan: FacetPlanEntry;
  readonly label: FacetLabel;
  readonly groupLabel?: FacetLabel;
}

/** Resolve the whole rail. */
export async function resolveFacets(
  request: FacetRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<FacetOutcome> {
  const now = request.now ?? new Date();
  const chain = facetLocaleChain(request.locale);

  const { scopeInput, resolvedScope, rootCategoryId } = await resolveScope(db, request.scope);

  // ---- Metadata: what may be faceted, at which grain, in which order --------
  const productType =
    rootCategoryId === undefined ? null : await findProductTypeForCategory(db, rootCategoryId);
  const fields =
    productType === null ? [] : await listProductTypeFacetFields(db, productType.id);
  const definitions =
    rootCategoryId === undefined ? [] : await resolveDefinitionsForCategory(db, rootCategoryId);

  const plan = planFacets(
    definitions.map((definition) => ({
      definitionId: definition.row.id,
      key: definition.row.key,
      version: definition.row.version,
      baseLabel: definition.row.label,
      valueType: definition.row.valueType,
      cardinality: definition.row.cardinality,
      baseUnit: definition.row.baseUnit,
      filterable: definition.row.filterable,
      publiclyDisplayable: definition.row.displayPolicy === 'public',
      sortable: definition.row.sortable,
      hardConstraintCapable: definition.row.hardConstraintCapable,
      variantDefining: definition.row.variantDefining,
    })),
    fields.map((field) => ({
      attributeKey: field.attributeKey,
      scope: field.scope,
      requirement: field.requirement,
      variantCapable: field.variantCapable,
      fieldPosition: field.fieldPosition,
      groupKey: field.groupKey,
      groupLabel: field.groupLabel,
      groupPosition: field.groupPosition,
    })),
  );
  const planByKey = new Map(plan.map((entry) => [entry.key, entry]));

  // ---- The selection, partitioned by grain ---------------------------------
  const partition = partitionSelection(request.selection, {
    levelOf: (key) => planByKey.get(key)?.level,
  });
  let requirements: FacetRequirements = partition.requirements;
  let priceUnconvertible: readonly string[] = [];

  if (partition.requestedPrice !== undefined) {
    const present = await listScopeOfferCurrencies(db, { scope: scopeInput, requirements, now });
    const converted = await convertPriceBound(partition.requestedPrice, present);
    priceUnconvertible = converted.unconvertible;
    requirements = { ...requirements, offer: withPriceBounds(requirements.offer, converted.bounds) };
  }

  const context: FacetQueryContext = { scope: scopeInput, requirements, now };
  const matchedProductCount = await countFacetMatchedProducts(db, context);

  // ---- Labels ---------------------------------------------------------------
  const offeredPlan = plan.filter((entry) => entry.suppression === undefined);
  const labelRows = await listFacetAttributeLabels(
    db,
    offeredPlan.map((entry) => entry.definitionId),
    chain,
  );
  const labelsByKey = new Map<string, Map<string, string>>();
  for (const row of labelRows) {
    const bucket = labelsByKey.get(row.attributeKey) ?? new Map<string, string>();
    bucket.set(row.locale, row.label);
    labelsByKey.set(row.attributeKey, bucket);
  }

  const pending: PendingFacet[] = plan.map((entry) => ({
    plan: entry,
    label: attributeNameLabel(
      labelsByKey.get(entry.key) ?? new Map<string, string>(),
      chain,
      entry.baseLabel,
    ),
    ...(entry.groupLabel === undefined
      ? {}
      : { groupLabel: { text: entry.groupLabel, source: 'registry_base' as const } }),
  }));

  // ---- Counts ---------------------------------------------------------------
  const selectedKeys = new Set(
    request.selection.map((entry) => entry.facetKey as string),
  );
  const facets: Facet[] = [];
  const suppressed: FacetSuppression[] = [];

  const enumValues = await listFacetEnumValues(
    db,
    offeredPlan.filter((entry) => entry.valueType === 'enum').map((entry) => entry.definitionId),
  );
  const localizedValues = await readLocalizedAttributeValues(
    enumValues.map((row) => row.enumValueId),
    request.locale,
    db,
  );
  const localizedValueById = new Map(
    localizedValues.map((value) => [value.attributeEnumValueId, value.label]),
  );

  const attributeCounts = await countAttributeFacets({
    db,
    context,
    plan: offeredPlan,
    selectedKeys,
    matchedProductCount,
  });
  const observedLabels = await loadObservedLabels(db, context, offeredPlan);

  for (const entry of pending) {
    const built = buildAttributeFacet({
      pending: entry,
      counts: attributeCounts,
      enumValues,
      localizedValueById,
      observedLabels,
      selection: request.selection,
      hasSelection: selectedKeys.has(entry.plan.key),
      measurementSystem: request.measurementSystem ?? null,
    });
    if (built.suppression !== undefined) {
      suppressed.push({ facetKey: entry.plan.key, origin: 'attribute', reason: built.suppression });
      continue;
    }
    if (built.facet !== undefined) facets.push(built.facet);
  }

  // ---- The taxonomy facet ---------------------------------------------------
  if (rootCategoryId !== undefined) {
    const taxonomy = await buildTaxonomyFacet({
      db,
      context,
      rootCategoryId,
      locale: request.locale,
      selection: request.selection,
    });
    if (taxonomy.suppression !== undefined) {
      suppressed.push({
        facetKey: FACET_TAXONOMY_KEY,
        origin: 'taxonomy',
        reason: taxonomy.suppression,
      });
    } else if (taxonomy.facet !== undefined) {
      facets.push(taxonomy.facet);
    }
  }

  // ---- Commerce facets ------------------------------------------------------
  for (const dimension of FACET_COMMERCE_DIMENSIONS) {
    const built = await buildCommerceFacet({
      db,
      scopeInput,
      requirements,
      now,
      dimension,
      displayCurrency: request.displayCurrency,
      matchedProductCount,
      selection: request.selection,
      hasSelection: selectedKeys.has(dimension),
      priceUnconvertible,
    });
    if (built.suppression !== undefined) {
      suppressed.push({ facetKey: dimension, origin: 'commerce', reason: built.suppression });
      continue;
    }
    if (built.facet !== undefined) facets.push(built.facet);
  }

  facets.sort((left, right) =>
    compareFacets(
      { key: left.key, ...positionOf(planByKey, left) },
      { key: right.key, ...positionOf(planByKey, right) },
    ),
  );

  // ---- Sorting and the empty state -----------------------------------------
  const sortOptions = buildSortOptions(
    pending.map((entry) => ({
      key: entry.plan.key,
      sortable: entry.plan.sortable,
      label: entry.label,
      suppressed: suppressed.some((row) => row.facetKey === entry.plan.key),
    })),
    stableKeyLabel('offer_price'),
  );
  const sort = resolveFacetSort(request.sort, sortOptions);

  const emptyState =
    matchedProductCount > 0
      ? undefined
      : composeEmptyState(
          emptyStateReason(request.selection.length === 0),
          await measureRelaxations(db, scopeInput, requirements, request.selection, planByKey, now),
        );

  const response: FacetResponse = {
    scope: {
      ...resolvedScope,
      ...(productType === null
        ? {}
        : { productTypeKey: productType.key, productTypeVersion: productType.version }),
    },
    locale: request.locale,
    facets,
    selection: echoSelection(request.selection, planByKey, facets),
    sortOptions,
    matchedProductCount,
    suppressed,
    ...(emptyState === undefined ? {} : { emptyState }),
  };
  return { response, ...(sort === undefined ? {} : { sort }) };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

async function resolveScope(
  db: DatabaseOrTransaction,
  scope: FacetScope,
): Promise<{
  scopeInput: FacetScopeInput;
  resolvedScope: ResolvedFacetScope;
  rootCategoryId?: string;
}> {
  if (scope.kind === 'canonical_products') {
    return {
      scopeInput: { kind: 'products', canonicalProductIds: scope.canonicalProductIds },
      resolvedScope: {
        kind: 'canonical_products',
        productIdCount: scope.canonicalProductIds.length,
      },
    };
  }
  const categoryIds = await findFacetCategoryScope(
    db,
    scope.categoryId,
    scope.includeDescendants !== false,
  );
  return {
    scopeInput: { kind: 'categories', categoryIds },
    resolvedScope: { kind: 'category', categoryId: scope.categoryId, categoryIds },
    rootCategoryId: scope.categoryId,
  };
}

// ---------------------------------------------------------------------------
// Attribute counts
// ---------------------------------------------------------------------------

interface AttributeCounts {
  readonly buckets: Map<string, Map<string, number>>;
  readonly ranges: Map<string, { min: number | null; max: number | null }>;
  readonly unknown: Map<string, number>;
}

/**
 * Every attribute facet's counts.
 *
 * ONE statement per grain for every UNSELECTED facet, plus one per SELECTED
 * facet with its own requirement lifted. Batching the unselected ones is safe
 * precisely because they share a requirement set; batching a selected one with
 * them would answer "how many are left if I pick blue AS WELL AS red", which is
 * not the question a multi-select rail is asking.
 */
async function countAttributeFacets(input: {
  db: DatabaseOrTransaction;
  context: FacetQueryContext;
  plan: readonly FacetPlanEntry[];
  selectedKeys: ReadonlySet<string>;
  /** The matched count of the UNLIFTED context, already taken by the caller. */
  matchedProductCount: number;
}): Promise<AttributeCounts> {
  const buckets = new Map<string, Map<string, number>>();
  const ranges = new Map<string, { min: number | null; max: number | null }>();
  const unknown = new Map<string, number>();

  const groups: {
    context: FacetQueryContext;
    entries: readonly FacetPlanEntry[];
  }[] = [];
  const unselected = input.plan.filter((entry) => !input.selectedKeys.has(entry.key));
  if (unselected.length > 0) groups.push({ context: input.context, entries: unselected });
  for (const entry of input.plan) {
    if (!input.selectedKeys.has(entry.key)) continue;
    groups.push({
      context: {
        ...input.context,
        requirements: liftFacet(input.context.requirements, entry.key, entry.level),
      },
      entries: [entry],
    });
  }

  for (const group of groups) {
    // `unknown = matched − present`, and BOTH sides must be taken over this
    // group's own requirement set. The unselected group's is the unlifted one,
    // whose count the caller already has; a selected facet's is a different
    // predicate and needs its own count. Pairing them is what makes the
    // subtraction exact — see `countProductsWithAttribute`'s own note, which
    // records the 1.6-second read this replaced.
    const groupMatched =
      group.context === input.context
        ? input.matchedProductCount
        : await countFacetMatchedProducts(input.db, group.context);
    const productBucketKeys = keysOf(group.entries, 'product', 'buckets');
    const variantBucketKeys = keysOf(group.entries, 'variant', 'buckets');
    const productRangeKeys = keysOf(group.entries, 'product', 'range');
    const variantRangeKeys = keysOf(group.entries, 'variant', 'range');

    const [productBuckets, variantBuckets, productRanges, variantRanges, present] =
      await Promise.all([
        countProductAttributeBuckets(input.db, group.context, productBucketKeys),
        countVariantAttributeBuckets(input.db, group.context, variantBucketKeys),
        measureProductAttributeRanges(input.db, group.context, productRangeKeys),
        measureVariantAttributeRanges(input.db, group.context, variantRangeKeys),
        countProductsWithAttribute(
          input.db,
          group.context,
          group.entries.map((entry) => entry.key),
        ),
      ]);

    for (const row of [...productBuckets, ...variantBuckets]) {
      const bucket = buckets.get(row.attributeKey) ?? new Map<string, number>();
      bucket.set(row.bucketValue, (bucket.get(row.bucketValue) ?? 0) + row.productCount);
      buckets.set(row.attributeKey, bucket);
    }
    for (const row of [...productRanges, ...variantRanges]) {
      ranges.set(row.attributeKey, { min: row.minValue, max: row.maxValue });
    }
    const presentByKey = new Map(present.map((row) => [row.attributeKey, row.productCount]));
    for (const entry of group.entries) {
      unknown.set(entry.key, Math.max(0, groupMatched - (presentByKey.get(entry.key) ?? 0)));
    }
  }

  return { buckets, ranges, unknown };
}

/** The keys of one grain and shape, so an empty list costs no statement. */
function keysOf(
  entries: readonly FacetPlanEntry[],
  level: FacetLevel,
  shape: 'buckets' | 'range',
): string[] {
  return entries
    .filter(
      (entry) =>
        entry.level === level &&
        (shape === 'buckets' ? entry.shape === 'buckets' : entry.shape !== 'buckets'),
    )
    .map((entry) => entry.key);
}

/** The commercial spellings behind each canonical value, for bucket display. */
async function loadObservedLabels(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  plan: readonly FacetPlanEntry[],
): Promise<Map<string, Map<string, string[]>>> {
  const keys = plan
    .filter((entry) => entry.shape === 'buckets' && entry.valueType === 'enum')
    .map((entry) => entry.key);
  const rows = await listObservedValueLabels(db, context, keys, FACET_MAX_OBSERVED_LABELS);
  const byKey = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const perValue = byKey.get(row.attributeKey) ?? new Map<string, string[]>();
    const labels = perValue.get(row.bucketValue) ?? [];
    labels.push(row.observedLabel);
    perValue.set(row.bucketValue, labels);
    byKey.set(row.attributeKey, perValue);
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// Facet construction
// ---------------------------------------------------------------------------

interface BuiltFacet {
  readonly facet?: Facet;
  readonly suppression?: ReturnType<typeof suppressFacet>;
}

function buildAttributeFacet(input: {
  pending: PendingFacet;
  counts: AttributeCounts;
  enumValues: readonly {
    attributeKey: string;
    enumValueId: string;
    value: string;
    label: string;
    position: number;
  }[];
  localizedValueById: ReadonlyMap<string, Parameters<typeof labelFromResolution>[0]>;
  observedLabels: ReadonlyMap<string, ReadonlyMap<string, string[]>>;
  selection: readonly FacetSelectionEntry[];
  hasSelection: boolean;
  measurementSystem: MeasurementSystem | null;
}): BuiltFacet {
  const { plan } = input.pending;
  if (plan.suppression !== undefined) return { suppression: plan.suppression };

  const selectedValues = new Set(
    input.selection
      .filter((entry) => entry.origin === 'attribute' && entry.facetKey === plan.key)
      .flatMap((entry) => (entry.origin === 'attribute' ? (entry.values ?? []) : [])),
  );
  const counts = input.counts.buckets.get(plan.key) ?? new Map<string, number>();
  const range = input.counts.ranges.get(plan.key);

  if (plan.shape === 'buckets') {
    const registry = input.enumValues.filter((value) => value.attributeKey === plan.key);
    // An enum's answers come from the REGISTRY, so a controlled value with no
    // in-scope product still has a row (count zero) and gets suppressed by the
    // rule rather than by never having been considered. A free-text `string`
    // attribute has no registry list, so its answers are what the data holds.
    const source: { key: string; label: string; position?: number; enumValueId?: string }[] =
      registry.length > 0
        ? registry.map((value) => ({
            key: value.value,
            label: value.label,
            position: value.position,
            enumValueId: value.enumValueId,
          }))
        : [...counts.keys()].map((key) => ({ key, label: key }));

    const orderable: (OrderableBucket & { label: string; enumValueId?: string })[] = source.map(
      (value) => ({
        key: value.key,
        count: counts.get(value.key) ?? 0,
        ...(value.position === undefined ? {} : { registryPosition: value.position }),
        label: value.label,
        ...(value.enumValueId === undefined ? {} : { enumValueId: value.enumValueId }),
      }),
    );
    orderable.sort(registry.length > 0 ? compareByRegistryPosition : compareByCount);

    const suppressible = orderable.map((value) => ({
      key: value.key,
      count: value.count,
      selected: selectedValues.has(value.key),
    }));
    const suppression = suppressFacet({
      key: plan.key,
      shape: 'buckets',
      buckets: suppressible,
      hasSelection: input.hasSelection,
    });
    if (suppression !== undefined) return { suppression };

    const { kept } = suppressBuckets(suppressible, FACET_MAX_BUCKETS);
    const keptKeys = new Set(kept.map((value) => value.key));
    const observed = input.observedLabels.get(plan.key);

    const buckets: FacetBucket[] = orderable
      .filter((value) => keptKeys.has(value.key))
      .map((value) => {
        const localized =
          value.enumValueId === undefined
            ? undefined
            : input.localizedValueById.get(value.enumValueId);
        const spellings = observed?.get(value.key);
        return {
          key: value.key,
          label:
            localized === undefined
              ? { text: value.label, source: 'registry_base' as const }
              : labelFromResolution(localized, value.label),
          count: value.count,
          selected: selectedValues.has(value.key),
          ...(spellings === undefined || spellings.length === 0
            ? {}
            : { observedLabels: [...new Set(spellings)].slice(0, FACET_MAX_OBSERVED_LABELS) }),
        };
      });

    return { facet: assembleFacet(input.pending, { shape: 'buckets', buckets }, input.counts) };
  }

  const bound = input.selection.find(
    (entry) => entry.origin === 'attribute' && entry.facetKey === plan.key,
  );
  const selectedMin = bound !== undefined && bound.origin === 'attribute' ? bound.min : undefined;
  const selectedMax = bound !== undefined && bound.origin === 'attribute' ? bound.max : undefined;

  const suppression = suppressFacet({
    key: plan.key,
    shape: plan.shape,
    buckets: [],
    ...(range?.min == null ? {} : { rangeMin: range.min }),
    ...(range?.max == null ? {} : { rangeMax: range.max }),
    hasSelection: input.hasSelection,
  });
  if (suppression !== undefined) return { suppression };

  const rangeMin = range?.min ?? 0;
  const rangeMax = range?.max ?? 0;
  const display = rangeDisplay(rangeMin, rangeMax, plan.baseUnit, input.measurementSystem);
  const values: FacetValues = {
    shape: 'range',
    range: {
      min: rangeMin,
      max: rangeMax,
      ...(plan.baseUnit === null ? {} : { unit: plan.baseUnit }),
      ...(selectedMin === undefined ? {} : { selectedMin }),
      ...(selectedMax === undefined ? {} : { selectedMax }),
      ...(display === null ? {} : { display }),
    },
  };
  return { facet: assembleFacet(input.pending, values, input.counts) };
}

/**
 * The same span in the shopper's own measurement system, or `null` (#367 line 598).
 *
 * FOUR ways this answers `null`, and each is a decision rather than a guard:
 *
 * 1. **The request stated no preference.** `measurementSystemForMarket` returns
 *    `null` for an absent or malformed market rather than `metric`, and this
 *    carries that through — "this shopper told us nothing" is not "this shopper
 *    is metric", and converting for somebody who never asked is the one outcome
 *    `display-units.ts` was written to refuse. The response is then
 *    byte-identical to what it was before this existed.
 * 2. **The attribute has no unit.** Nothing to convert and no unit to name.
 * 3. **`renderMeasurement` REFUSES** — an unknown or non-convertible stored
 *    unit. It does not fall back to the base unit, and neither does this: a
 *    refusal means no display, never a guess.
 * 4. **The converted span is not two finite numbers.** A range needs both ends.
 *
 * NOTHING is converted here. `renderMeasurement` picks the unit and calls
 * `units.ts`, which is the one conversion authority `unit-authority.test.ts`
 * gates — a factor in this file would be a second answer to what a millimetre
 * is. `baseMagnitudeMax` is passed because that parameter exists for exactly
 * this: its own docblock calls it "the upper bound of a range".
 *
 * And it deliberately touches only the DISPLAY. `FacetRange.min`/`.max` stay in
 * the base unit because they are the vocabulary a SELECTION comes back in —
 * `facet-schemas.ts` says "a magnitude in an attribute's BASE unit" — so
 * converting them in place would make a shopper's slider drag mean a different
 * measurement, silently, with every request still well-formed.
 *
 * EXPORTED because it is the decision #367 line 598 turns on and it is not
 * reachable through `resolveFacets` without a database — no fixture in this
 * repository produces a range facet carrying a unit, so the four `null` branches
 * would otherwise be unexercised, and branch 1 is the one that is wrong
 * silently. Not a test hatch: it is a named decision with its own reasons, and
 * the alternative was a test that re-implements it and therefore measures the
 * re-implementation.
 */
export function rangeDisplay(
  min: number,
  max: number,
  baseUnit: string | null,
  system: MeasurementSystem | null,
): FacetRangeDisplay | null {
  if (system === null || baseUnit === null) return null;
  const rendered = renderMeasurement({ baseMagnitude: min, baseMagnitudeMax: max, baseUnit }, system);
  if (rendered.outcome !== 'rendered') return null;
  if (rendered.magnitudeMax === undefined) return null;
  if (!Number.isFinite(rendered.magnitude) || !Number.isFinite(rendered.magnitudeMax)) return null;
  return {
    min: rendered.magnitude,
    max: rendered.magnitudeMax,
    unit: rendered.unit,
    decimals: rendered.decimals,
  };
}

/** Wrap the plan, the label and the values into the DTO. */
function assembleFacet(
  pending: PendingFacet,
  values: FacetValues,
  counts: AttributeCounts,
): Facet {
  const { plan } = pending;
  return {
    key: plan.key,
    origin: 'attribute',
    level: plan.level,
    label: pending.label,
    definitionVersion: plan.definitionVersion,
    valueType: plan.valueType,
    cardinality: plan.cardinality,
    ...(plan.groupKey === undefined ? {} : { groupKey: plan.groupKey }),
    ...(pending.groupLabel === undefined ? {} : { groupLabel: pending.groupLabel }),
    multiSelect: plan.multiSelect,
    hardConstraintCapable: plan.hardConstraintCapable,
    sortable: plan.sortable,
    missingDataPolicy: plan.missingDataPolicy,
    unknownCount: counts.unknown.get(plan.key) ?? 0,
    values,
  };
}

/**
 * The category refinement facet.
 *
 * Generated from the taxonomy's own children, in the taxonomy's own
 * `position` order — not a curated list, which is what ADR 0007 D3 assigns to
 * navigation configuration. `unknownCount` is 0 by construction: every product
 * in scope is filed under some category, and one filed directly at the scope
 * root is simply not under any child.
 */
async function buildTaxonomyFacet(input: {
  db: DatabaseOrTransaction;
  context: FacetQueryContext;
  rootCategoryId: string;
  locale: string;
  selection: readonly FacetSelectionEntry[];
}): Promise<BuiltFacet> {
  const children = await findFacetChildCategories(input.db, input.rootCategoryId);
  if (children.length === 0) return { suppression: 'no_values' };

  const lifted: FacetQueryContext = {
    ...input.context,
    requirements: liftFacet(input.context.requirements, FACET_TAXONOMY_KEY, 'product'),
  };
  const counts = await countCategoryBuckets(
    input.db,
    lifted,
    children.map((child) => child.id),
  );
  const countById = new Map(counts.map((row) => [row.bucketValue, row.productCount]));

  const selectedIds = new Set(
    input.selection
      .filter((entry) => entry.origin === 'taxonomy')
      .flatMap((entry) => (entry.origin === 'taxonomy' ? entry.values : [])),
  );
  const localized = await readLocalizedCategories(
    children.map((child) => child.id),
    input.locale,
    input.db,
  );
  const localizedById = new Map(localized.map((row) => [row.categoryId, row.name]));

  const suppressible = children.map((child) => ({
    key: child.id,
    count: countById.get(child.id) ?? 0,
    selected: selectedIds.has(child.id),
  }));
  const suppression = suppressFacet({
    key: FACET_TAXONOMY_KEY,
    shape: 'buckets',
    buckets: suppressible,
    hasSelection: selectedIds.size > 0,
  });
  if (suppression !== undefined) return { suppression };

  const { kept } = suppressBuckets(suppressible, FACET_MAX_BUCKETS);
  const keptIds = new Set(kept.map((value) => value.key));
  const buckets: FacetBucket[] = children
    .filter((child) => keptIds.has(child.id))
    .map((child) => {
      const name = localizedById.get(child.id);
      return {
        key: child.id,
        label: name === undefined ? { text: child.name, source: 'registry_base' as const } : labelFromResolution(name, child.name),
        count: countById.get(child.id) ?? 0,
        selected: selectedIds.has(child.id),
      };
    });

  return {
    facet: {
      key: FACET_TAXONOMY_KEY,
      origin: 'taxonomy',
      level: 'product',
      label: stableKeyLabel(FACET_TAXONOMY_KEY),
      multiSelect: true,
      hardConstraintCapable: true,
      sortable: false,
      missingDataPolicy: 'exclude_when_unknown',
      unknownCount: 0,
      values: { shape: 'buckets', buckets },
    },
  };
}

/**
 * One commerce facet, counted over offers that satisfy every OTHER offer
 * requirement on the same row.
 *
 * `unknownCount` is `matchedProductCount − (products with any qualifying offer
 * carrying a value)`: a product with no live offer at all has no availability, no
 * condition and no price, and reporting it as anything else would let a filter
 * silently drop it while the rail claimed it was covered.
 */
async function buildCommerceFacet(input: {
  db: DatabaseOrTransaction;
  scopeInput: FacetScopeInput;
  requirements: FacetRequirements;
  now: Date;
  dimension: (typeof FACET_COMMERCE_DIMENSIONS)[number];
  displayCurrency: CurrencyCode;
  matchedProductCount: number;
  selection: readonly FacetSelectionEntry[];
  hasSelection: boolean;
  priceUnconvertible: readonly string[];
}): Promise<BuiltFacet> {
  const context: FacetQueryContext = {
    scope: input.scopeInput,
    requirements: liftFacet(input.requirements, input.dimension, 'offer'),
    now: input.now,
  };
  const entry = input.selection.find(
    (row) => row.origin === 'commerce' && row.facetKey === input.dimension,
  );
  const selectedValues = new Set(
    entry !== undefined && entry.origin === 'commerce' ? (entry.values ?? []) : [],
  );

  if (input.dimension === 'offer_price') {
    const spans = await measureOfferPriceSpans(input.db, context);
    const { span, unconvertible } = await composePriceSpan(spans, input.displayCurrency);
    const covered = spans.reduce((total, row) => total + row.productCount, 0);
    // The span's OWN exclusions count towards the suppression reason, not just
    // the selected bound's. A scope priced entirely in a currency Mercaria
    // cannot convert has no span, and reporting `no_values` for it says the
    // catalogue has no prices when what happened is that none could be read
    // (#450). `priceUnconvertible` alone could not see this, because it is only
    // populated when the shopper has already selected a price bound.
    const excluded = [...new Set([...input.priceUnconvertible, ...unconvertible])];
    const suppression = suppressFacet({
      key: input.dimension,
      shape: 'money_range',
      buckets: [],
      ...(span === null ? {} : { rangeMin: span.minMinor, rangeMax: span.maxMinor }),
      hasSelection: input.hasSelection,
      ...(span === null && excluded.length > 0 ? { unconvertible: true } : {}),
    });
    if (suppression !== undefined || span === null) {
      return { suppression: suppression ?? 'no_values' };
    }
    const selectedMinMinor =
      entry !== undefined && entry.origin === 'commerce' ? entry.minMinor : undefined;
    const selectedMaxMinor =
      entry !== undefined && entry.origin === 'commerce' ? entry.maxMinor : undefined;
    // Both fields projected from ONE set by the shared classifier, so the
    // permanent subset can never name a currency the complete list omits (#450).
    // Each is omitted when empty, which is what this facet has always done.
    const exclusions = projectCurrencyExclusions(span.unconvertible);
    return {
      facet: {
        key: input.dimension,
        origin: 'commerce',
        level: 'offer',
        label: stableKeyLabel(input.dimension),
        multiSelect: false,
        hardConstraintCapable: true,
        sortable: true,
        missingDataPolicy: 'exclude_when_unknown',
        unknownCount: Math.max(0, input.matchedProductCount - covered),
        values: {
          shape: 'money_range',
          range: {
            minMinor: span.minMinor,
            maxMinor: span.maxMinor,
            currency: span.currency,
            ...(selectedMinMinor === undefined ? {} : { selectedMinMinor }),
            ...(selectedMaxMinor === undefined ? {} : { selectedMaxMinor }),
            ...(exclusions.unconvertibleCurrencies.length === 0
              ? {}
              : { unconvertibleCurrencies: exclusions.unconvertibleCurrencies }),
            ...(exclusions.unmodelledCurrencies.length === 0
              ? {}
              : { unmodelledCurrencies: exclusions.unmodelledCurrencies }),
          },
        },
      },
    };
  }

  const rows = await commerceBucketRows(input.db, context, input.dimension);
  const counts = new Map<string, number>();
  for (const row of rows) {
    // Condition arrives as #90's KEY and is reported as its SEGMENT.
    // `CONDITION_KEY_GROUP` is shared-types' own total map, applied here rather
    // than as a `CASE` in SQL: a second copy of it would come apart the first
    // time a key is added, and the aggregate cannot see that happen.
    const key =
      input.dimension === 'condition'
        ? (CONDITION_KEY_GROUP[row.bucketValue as ItemConditionKey] ?? row.bucketValue)
        : row.bucketValue;
    counts.set(key, (counts.get(key) ?? 0) + row.productCount);
  }

  const orderable: OrderableBucket[] = [...counts.entries()].map(([key, count]) => ({
    key,
    count,
  }));
  orderable.sort(commerceComparator(input.dimension));

  const suppressible = orderable.map((value) => ({
    key: value.key,
    count: value.count,
    selected: selectedValues.has(value.key),
  }));
  const suppression = suppressFacet({
    key: input.dimension,
    shape: 'buckets',
    buckets: suppressible,
    hasSelection: input.hasSelection,
  });
  if (suppression !== undefined) return { suppression };

  const { kept } = suppressBuckets(suppressible, FACET_MAX_BUCKETS);
  const covered = [...counts.values()].reduce((total, value) => Math.max(total, value), 0);
  return {
    facet: {
      key: input.dimension,
      origin: 'commerce',
      level: 'offer',
      label: stableKeyLabel(input.dimension),
      multiSelect: true,
      hardConstraintCapable: true,
      sortable: false,
      missingDataPolicy: 'exclude_when_unknown',
      unknownCount: Math.max(0, input.matchedProductCount - covered),
      values: {
        shape: 'buckets',
        buckets: kept.map((value) => ({
          key: value.key,
          label: stableKeyLabel(value.key),
          count: value.count,
          selected: value.selected,
        })),
      },
    },
  };
}

function commerceBucketRows(
  db: DatabaseOrTransaction,
  context: FacetQueryContext,
  dimension: (typeof FACET_COMMERCE_DIMENSIONS)[number],
): Promise<{ bucketValue: string; productCount: number }[]> {
  switch (dimension) {
    case 'availability':
      return countOfferAvailabilityBuckets(db, context);
    case 'condition':
      return countOfferConditionBuckets(db, context);
    case 'market':
      return countOfferMarketBuckets(db, context);
    case 'offer_channel':
      return countOfferChannelBuckets(db, context);
    default:
      return Promise.resolve([]);
  }
}

function commerceComparator(
  dimension: (typeof FACET_COMMERCE_DIMENSIONS)[number],
): (left: OrderableBucket, right: OrderableBucket) => number {
  switch (dimension) {
    case 'availability':
      return compareAvailabilityBuckets;
    case 'condition':
      return compareConditionBuckets;
    case 'offer_channel':
      return compareChannelBuckets;
    default:
      return compareMarketBuckets;
  }
}

// ---------------------------------------------------------------------------
// Echo, ordering position and the empty state's measurements
// ---------------------------------------------------------------------------

function positionOf(
  planByKey: ReadonlyMap<string, FacetPlanEntry>,
  facet: Facet,
): { groupPosition: number; fieldPosition: number } {
  const plan = planByKey.get(facet.key);
  if (plan !== undefined) {
    return { groupPosition: plan.groupPosition, fieldPosition: plan.fieldPosition };
  }
  // The taxonomy refinement leads the rail and the commerce dimensions close
  // it. Both are constants of the SURFACE rather than of any category, which is
  // why they are expressible here and a per-category order is not.
  return facet.origin === 'taxonomy'
    ? { groupPosition: -1, fieldPosition: 0 }
    : { groupPosition: Number.MAX_SAFE_INTEGER, fieldPosition: 1 };
}

/** Echo the selection with stable keys, saying whether its facet is still offered. */
function echoSelection(
  selection: readonly FacetSelectionEntry[],
  planByKey: ReadonlyMap<string, FacetPlanEntry>,
  facets: readonly Facet[],
): ResolvedFacetSelectionEntry[] {
  const offered = new Set(facets.map((facet) => facet.key));
  return selection.map((entry) => {
    const level: FacetLevel =
      entry.origin === 'commerce'
        ? 'offer'
        : entry.origin === 'taxonomy'
          ? 'product'
          : (planByKey.get(entry.facetKey)?.level ?? 'product');
    return {
      facetKey: entry.facetKey,
      origin: entry.origin,
      level,
      values: entry.origin === 'taxonomy' ? entry.values : (entry.values ?? []),
      ...(entry.origin === 'attribute' && entry.min !== undefined ? { min: entry.min } : {}),
      ...(entry.origin === 'attribute' && entry.max !== undefined ? { max: entry.max } : {}),
      ...(entry.origin === 'commerce' && entry.currency !== undefined
        ? { currency: entry.currency }
        : {}),
      facetOffered: offered.has(entry.facetKey),
    };
  });
}

/**
 * How many products each single relaxation would recover.
 *
 * One count per selection, each with exactly THAT selection lifted and every
 * other one still applied. Deriving them from the facet counts instead would be
 * wrong in a way that is hard to see: a bucket's count is already taken with its
 * own facet lifted, so it answers "how many if I swap my choice within this
 * facet", not "how many if I abandon this facet".
 */
async function measureRelaxations(
  db: DatabaseOrTransaction,
  scope: FacetScopeInput,
  requirements: FacetRequirements,
  selection: readonly FacetSelectionEntry[],
  planByKey: ReadonlyMap<string, FacetPlanEntry>,
  now: Date,
): Promise<MeasuredRelaxation[]> {
  const measured: MeasuredRelaxation[] = [];
  for (const entry of selection) {
    const level: FacetLevel =
      entry.origin === 'commerce'
        ? 'offer'
        : entry.origin === 'taxonomy'
          ? 'product'
          : (planByKey.get(entry.facetKey)?.level ?? 'product');
    const count = await countFacetMatchedProducts(db, {
      scope,
      requirements: liftFacet(requirements, entry.facetKey, level),
      now,
    });
    measured.push({
      facetKey: entry.facetKey,
      origin: entry.origin,
      resultCount: count,
      // Every filter on this rail is applied as a hard requirement — a shopper
      // ticking a box means "only these". So dropping any of them relaxes one,
      // and saying otherwise for some would be a distinction the surface does
      // not have.
      relaxesHardConstraint: true,
    });
  }
  return measured;
}
