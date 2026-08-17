/**
 * What a vertical package actually put in the database (#367 Workstream 14).
 *
 * ## The failure this exists for
 *
 * A seed that silently did not run reports the same zeros as a clean pass, and
 * a report that sums its own steps is satisfied by `0 = 0 + 0 + 0`. So none of
 * the numbers here come from the run: every one is a `count(*)` against
 * Postgres, scoped by the namespace, and every one is compared against a count
 * the PACKAGE declares — which `verticals-package-controls.test.ts` in turn
 * re-derives from the package value, so a fixture edit that forgets to update
 * an expectation fails the build rather than quietly lowering the bar.
 *
 * ## The three layers, and why each is needed
 *
 * 1. **The vacuity floor.** `total === 0` is refused outright, before any
 *    comparison. Without it a namespace nobody applied compares fourteen zeros
 *    against fourteen zeros and passes — which is the whole class of bug.
 *    It is a separate answer (`vacuous`) rather than a mismatch, because
 *    "nothing ran" and "one table is short" lead an operator to opposite
 *    actions.
 * 2. **Per-entity equality.** Exact, never `>=`. A floor a later edit can
 *    satisfy by adding rows anywhere is a floor that ends at `>= 0`.
 * 3. **The positive control.** Every declared expectation must itself be
 *    positive for the entity kinds the package uses. A package declaring
 *    `variants: 0` and finding zero would otherwise "match".
 *
 * ## Why it counts by NAMESPACE and not by id list
 *
 * An id list is what the run produced, so a census over it can only find what
 * the run already knew about — it cannot notice a row the run failed to write,
 * because that row has no id to look up. Counting `where key like '<ns>_%'`
 * asks the database what is there, which is a different question and the only
 * one worth asking.
 */

import { sql } from 'drizzle-orm';

import type { DatabaseOrTransaction } from '../../db/postgres.js';
import type { VerticalNamespace } from './apply.js';
import type { VerticalExpectation, VerticalPackage } from './types.js';

/** One row of the census: what was declared, what Postgres holds. */
export interface CensusLine {
  readonly entity: keyof VerticalExpectation;
  readonly expected: number;
  readonly found: number;
}

export type CensusVerdict =
  /** Every expectation matched and the package is not empty. */
  | { readonly outcome: 'matched'; readonly lines: readonly CensusLine[]; readonly total: number }
  /**
   * Nothing at all was found under the namespace.
   *
   * A distinct verdict from `mismatched` on purpose: the remedy is "run the
   * seed", not "look at which table is short", and a census that reported this
   * as fourteen mismatches would bury that.
   */
  | { readonly outcome: 'vacuous'; readonly lines: readonly CensusLine[] }
  | {
      readonly outcome: 'mismatched';
      readonly lines: readonly CensusLine[];
      readonly total: number;
      readonly failures: readonly CensusLine[];
    }
  /**
   * The package declares zero of something it uses, so a matching zero would
   * prove nothing. Refused before the comparison runs.
   */
  | { readonly outcome: 'unmeasurable'; readonly entities: readonly (keyof VerticalExpectation)[] };

/**
 * The entity kinds every package must declare a POSITIVE count for.
 *
 * Deliberately not all fourteen: `vehicleConfigurations`, `fitments` and
 * `compatibilityClaims` are legitimately zero for footwear and smartphones, and
 * demanding them would force a fixture to invent a vehicle to satisfy a gate.
 * The seven below are what a "reference vertical package" means — a
 * classification, a vocabulary, a schema and identity — and a package with zero
 * of any of them is not one.
 */
export const CENSUS_POSITIVE_CONTROL_ENTITIES: readonly (keyof VerticalExpectation)[] = [
  'categories',
  'attributes',
  'productTypes',
  'productTypeFields',
  'brands',
  'products',
  'variants',
];

/**
 * The JUDGEMENT, separated from the counting so it can be tested directly.
 *
 * The three layers in the header all live here, and none of them can be
 * exercised through a database: proving that all-zero counts answer `vacuous`
 * means supplying all-zero counts, which a real seeded namespace by definition
 * cannot. `verticals-package-controls.test.ts` calls this with hand-built
 * numbers, which is the only arrangement in which the vacuity floor has a
 * control at all.
 */
export function judgeCensus(
  pkg: VerticalPackage,
  found: Record<keyof VerticalExpectation, number>,
): CensusVerdict {
  const missingControls = CENSUS_POSITIVE_CONTROL_ENTITIES.filter(
    (entity) => pkg.expect[entity] <= 0,
  );
  if (missingControls.length > 0) {
    return { outcome: 'unmeasurable', entities: missingControls };
  }

  const lines: CensusLine[] = (Object.keys(pkg.expect) as (keyof VerticalExpectation)[]).map(
    (entity) => ({ entity, expected: pkg.expect[entity], found: found[entity] }),
  );
  const total = lines.reduce((sum, line) => sum + line.found, 0);
  if (total === 0) return { outcome: 'vacuous', lines };

  const failures = lines.filter((line) => line.expected !== line.found);
  if (failures.length > 0) return { outcome: 'mismatched', lines, total, failures };
  return { outcome: 'matched', lines, total };
}

/** Count everything one namespace owns, and judge it against the package. */
export async function censusVerticalPackage(
  db: DatabaseOrTransaction,
  pkg: VerticalPackage,
  ns: VerticalNamespace,
): Promise<CensusVerdict> {
  return judgeCensus(pkg, await countNamespace(db, ns));
}

/**
 * The raw counts, with no judgement.
 *
 * Every predicate is a `like '<namespace>%'` on a column the seed CONTROLS the
 * value of, and never on a display name — a name is presentation and can be
 * edited in the database without the seed's knowledge, which would make the
 * census silently under-report exactly when somebody had been editing.
 */
export async function countNamespace(
  db: DatabaseOrTransaction,
  ns: VerticalNamespace,
): Promise<Record<keyof VerticalExpectation, number>> {
  const attrPrefix = `${ns.snake}_%`;
  const categoryPrefix = `${ns.kebab}.%`;
  const slugPrefix = `${ns.kebab}-%`;

  const rows = await db.execute<{
    categories: number;
    attributes: number;
    enum_values: number;
    product_types: number;
    product_type_fields: number;
    brands: number;
    families: number;
    products: number;
    variants: number;
    identifiers: number;
    facts: number;
    vehicle_configurations: number;
    fitments: number;
    compatibility_claims: number;
  }>(sql`
    select
      (select count(*)::int from categories where key like ${categoryPrefix}) as categories,
      (select count(*)::int from attribute_definitions
         where key like ${attrPrefix} and lifecycle_state = 'active') as attributes,
      (select count(*)::int from attribute_enum_values v
         join attribute_definitions d on d.id = v.attribute_definition_id
        where d.key like ${attrPrefix}) as enum_values,
      (select count(*)::int from product_type_definitions
         where key like ${attrPrefix} and lifecycle = 'published') as product_types,
      (select count(*)::int from product_type_fields f
         join product_type_definitions t on t.id = f.product_type_definition_id
        where t.key like ${attrPrefix}) as product_type_fields,
      (select count(*)::int from brands where slug like ${slugPrefix}) as brands,
      (select count(*)::int from canonical_product_families where slug like ${slugPrefix}) as families,
      (select count(*)::int from canonical_products where slug like ${slugPrefix}) as products,
      (select count(*)::int from canonical_variants v
         join canonical_products p on p.id = v.product_id
        where p.slug like ${slugPrefix}) as variants,
      (select count(*)::int from product_identifiers i
         join canonical_variants v on v.id = i.variant_id
         join canonical_products p on p.id = v.product_id
        where p.slug like ${slugPrefix}) as identifiers,
      (select count(*)::int from canonical_attribute_values a
        where a.attribute_key like ${attrPrefix}) as facts,
      (select count(*)::int from vehicle_configurations c
         join vehicle_generations g on g.id = c.generation_id
         join vehicle_models m on m.id = g.model_id
         join vehicle_makes k on k.id = m.make_id
        where k.key like ${attrPrefix}) as vehicle_configurations,
      (select count(*)::int from automotive_fitments f
         join canonical_variants v on v.id = f.subject_variant_id
         join canonical_products p on p.id = v.product_id
        where p.slug like ${slugPrefix} and f.valid_to is null) as fitments,
      (select count(*)::int from compatibility_claims c
         join canonical_variants v on v.id = c.subject_variant_id
         join canonical_products p on p.id = v.product_id
        where p.slug like ${slugPrefix}) as compatibility_claims
  `);

  const row = [...rows][0];
  if (row === undefined) {
    throw new Error('The vertical census returned no row, which its own aggregates make impossible.');
  }
  return {
    categories: row.categories,
    attributes: row.attributes,
    enumValues: row.enum_values,
    productTypes: row.product_types,
    productTypeFields: row.product_type_fields,
    brands: row.brands,
    families: row.families,
    products: row.products,
    variants: row.variants,
    identifiers: row.identifiers,
    facts: row.facts,
    vehicleConfigurations: row.vehicle_configurations,
    fitments: row.fitments,
    compatibilityClaims: row.compatibility_claims,
  };
}

/** The expectation a package's own DATA implies, recomputed rather than repeated. */
export function deriveExpectation(pkg: VerticalPackage): VerticalExpectation {
  const enumValues = pkg.attributes.reduce(
    (sum, attribute) => sum + (attribute.enumValues?.length ?? 0),
    0,
  );
  const productTypeFields = pkg.productTypes.reduce((sum, type) => sum + type.fields.length, 0);
  const variants = pkg.products.reduce((sum, product) => sum + product.variants.length, 0);
  const identifiers = pkg.products.reduce(
    (sum, product) =>
      sum +
      product.variants.reduce(
        (variantSum, variant) => variantSum + (variant.identifiers?.length ?? 0),
        0,
      ),
    0,
  );
  // A STRUCTURED fact writes one `canonical_attribute_values` row per declared
  // component axis — `160.5 x 75.2 x 8.3 mm` is three rows, each carrying its
  // own `component_axis` and `position`. Counting declarations would understate
  // it by two per dimensions field, and the census would then report a
  // mismatch on a package that seeded correctly.
  const rowsPerFact = new Map(
    pkg.attributes.map((attribute) => [
      attribute.key,
      attribute.valueType === 'structured' ? (attribute.componentAxes?.length ?? 1) : 1,
    ]),
  );
  const countFacts = (facts: readonly { readonly attributeKey: string }[] | undefined): number =>
    (facts ?? []).reduce((sum, fact) => sum + (rowsPerFact.get(fact.attributeKey) ?? 1), 0);
  const facts = pkg.products.reduce(
    (sum, product) =>
      sum +
      countFacts(product.facts) +
      product.variants.reduce((variantSum, variant) => variantSum + countFacts(variant.facts), 0),
    0,
  );
  const vehicleConfigurations = pkg.vehicleMakes.reduce(
    (sum, make) =>
      sum +
      make.models.reduce(
        (modelSum, model) =>
          modelSum +
          model.generations.reduce(
            (generationSum, generation) => generationSum + generation.configurations.length,
            0,
          ),
        0,
      ),
    0,
  );

  return {
    categories: pkg.categories.length,
    attributes: pkg.attributes.length,
    enumValues,
    productTypes: pkg.productTypes.length,
    productTypeFields,
    brands: pkg.brands.length,
    families: pkg.families.length,
    products: pkg.products.length,
    variants,
    identifiers,
    facts,
    vehicleConfigurations,
    fitments: pkg.fitments.length,
    compatibilityClaims: pkg.compatibilityClaims.length,
  };
}

/** One line per entity, for a terminal. */
export function formatCensus(verdict: CensusVerdict): string {
  if (verdict.outcome === 'unmeasurable') {
    return (
      `UNMEASURABLE — the package declares zero of: ${verdict.entities.join(', ')}.\n` +
      'A census that compares zero against zero reports a clean pass for a seed that never ran.'
    );
  }
  const lines = verdict.lines
    .map(
      (line) =>
        `  ${line.expected === line.found ? 'ok  ' : 'FAIL'} ${line.entity.padEnd(22)} expected ${String(line.expected).padStart(4)}  found ${String(line.found).padStart(4)}`,
    )
    .join('\n');
  if (verdict.outcome === 'vacuous') {
    return `${lines}\n\nTHIS CENSUS MEASURED NOTHING — the namespace holds zero rows of every kind.`;
  }
  if (verdict.outcome === 'mismatched') {
    return `${lines}\n\nMISMATCHED — ${verdict.failures.length} of ${verdict.lines.length} entity counts disagree.`;
  }
  return `${lines}\n\nMATCHED — ${verdict.total} rows across ${verdict.lines.length} entity kinds.`;
}
