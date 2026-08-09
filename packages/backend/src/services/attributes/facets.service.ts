/**
 * Filter facets, derived from the REGISTRY (#94 API rule 6).
 *
 * "Based on the same registry" is the requirement, and it is what makes a facet
 * trustworthy: the label a shopper reads, the unit the numbers are in, whether
 * the attribute can be sorted and whether it may be used as a hard requirement
 * all come from the definition version, not from whatever the values happened to
 * look like. A facet assembled from distinct stored strings would advertise
 * "16gb" and "16 GB" as two filters and would not know which of them excludes.
 *
 * Two shapes, decided by the definition rather than by the data:
 *
 * - a BUCKET facet for enums, strings and booleans — the values, with counts;
 * - a RANGE facet for measurements, numbers, money and dates — the span, so a
 *   slider has real endpoints rather than a guess.
 *
 * `missingCount` is on every facet, deliberately. A shopper filtering on a spec
 * that half the catalogue does not record is making a decision about that half,
 * and a facet that hides the gap makes it for them.
 */

import type { AttributeFacet, AttributeFacetBucket } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countProductsInCategory,
  facetBucketsForCategory,
  facetRangesForCategory,
} from '../../db/attributes/attributeOpsRepository.js';
import { resolveDefinitionsForCategory } from './definition-registry.service.js';

/**
 * The facets one category offers.
 *
 * Only `filterable` definitions produce one — an attribute recorded for
 * comparison but not for filtering has no business appearing as a filter chip,
 * and offering it would let a shopper build a constraint validation would then
 * refuse.
 */
export async function facetsForCategory(
  db: DatabaseOrTransaction,
  categoryId: string,
): Promise<AttributeFacet[]> {
  const definitions = (await resolveDefinitionsForCategory(db, categoryId)).filter(
    (definition) => definition.row.filterable,
  );
  if (definitions.length === 0) return [];

  const keys = definitions.map((definition) => definition.row.key);
  const [buckets, ranges, eligible] = await Promise.all([
    facetBucketsForCategory(db, categoryId, keys),
    facetRangesForCategory(db, categoryId, keys),
    countProductsInCategory(db, categoryId),
  ]);

  const bucketsByKey = new Map<string, AttributeFacetBucket[]>();
  for (const row of buckets) {
    const list = bucketsByKey.get(row.attributeKey) ?? [];
    const value =
      row.bucketText ?? (row.bucketBoolean === null ? '' : row.bucketBoolean ? 'true' : 'false');
    if (value === '') continue;
    list.push({ value, label: value, count: row.count });
    bucketsByKey.set(row.attributeKey, list);
  }
  const rangesByKey = new Map(ranges.map((row) => [row.attributeKey, row]));

  return definitions.map((definition) => {
    const { row } = definition;
    const numeric = isNumericFacet(row.valueType);
    const range = rangesByKey.get(row.key);
    const ownBuckets = bucketsByKey.get(row.key) ?? [];

    // An enum's buckets are LABELLED from the registry, in the registry's order.
    // Reading the label off the stored value would show a shopper the machine
    // spelling, and reading the order off the counts would reorder a size filter
    // by popularity — which is how "S, M, L, XL" becomes "M, L, S, XL".
    const labelled: AttributeFacetBucket[] =
      row.valueType === 'enum'
        ? definition.enumValues
            .map((enumValue) => ({
              value: enumValue.value,
              label: enumValue.label,
              count: ownBuckets.find((bucket) => bucket.value === enumValue.value)?.count ?? 0,
            }))
            .filter((bucket) => bucket.count > 0)
        : ownBuckets;

    const present = numeric
      ? (range?.present ?? 0)
      : labelled.reduce((total, bucket) => total + bucket.count, 0);

    return {
      attributeKey: row.key,
      label: row.label,
      definitionVersion: row.version,
      valueType: row.valueType,
      cardinality: row.cardinality,
      ...(row.baseUnit === null ? {} : { unit: row.baseUnit }),
      sortable: row.sortable,
      hardConstraintCapable: row.hardConstraintCapable,
      buckets: numeric ? [] : labelled,
      ...(range?.minValue == null ? {} : { minValue: range.minValue }),
      ...(range?.maxValue == null ? {} : { maxValue: range.maxValue }),
      missingCount: Math.max(0, eligible - present),
    };
  });
}

/** Whether a value type gets a range facet rather than buckets. */
function isNumericFacet(valueType: string): boolean {
  return (
    valueType === 'measurement' ||
    valueType === 'integer' ||
    valueType === 'decimal' ||
    valueType === 'money' ||
    valueType === 'date' ||
    valueType === 'structured'
  );
}
