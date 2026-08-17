/**
 * The reads duplicate detection is built from (#367 step 6, ADR 0007 D9).
 *
 * ADR 0007 D9 asks for duplicate detection BEFORE submission. The failure this
 * module is shaped around is not a missed duplicate — it is a scan that returned
 * nothing because it looked at nothing, which is indistinguishable from a clean
 * result and reads as diligence in every report.
 *
 * So **every function here returns a POPULATION beside its candidates**. The
 * population is the size of the set the scan actually read, counted from the
 * database rather than from the scan's own output, and it is the positive
 * control the whole gate rests on: `population: 0` says there was nothing to be a
 * duplicate of, and `population: 900` with no candidates says nine hundred labels
 * were compared and none matched. A caller cannot fabricate it, because a caller
 * never supplies it.
 *
 * ## The near probe is `ORDER BY x <-> $1 LIMIT n`, and never a `similarity(…)`
 * filter
 *
 * #61 measured exactly this shape on `canonical_products.normalized_name`: the
 * distance operator with a limit ran at 16.6 ms scanning 25 rows where the
 * `similarity(...) DESC` spelling ran at 81.6 ms scanning 31,094, because
 * `ORDER BY x <-> $1` can be served by a GiST trigram index and no index can
 * serve the other. A `WHERE similarity(...) >= t` predicate has the same problem
 * for the same reason, so the threshold is applied to the LIMITED result in the
 * service rather than in SQL. Do not "tidy" the distance operator back into a
 * `similarity` call — it compiles, returns the same rows, and costs 6.6× more.
 *
 * ## One probe per proposal type, and the two that deliberately measure nothing
 *
 * A `controlled_value` is probed against the enum values of ONE attribute
 * definition plus their recorded aliases — the smallest population here and the
 * only one where an exact hit is a certainty rather than a strong hint. A
 * `canonical_variant` is probed against NOTHING and says so with a population of
 * zero, because a variant's identity is its option assignments and comparing
 * display names would report `256 GB, Black` under one phone as a duplicate of
 * the identically-named configuration of another.
 */

import { and, count, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CatalogProposalType } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  attributeDefinitions,
  attributeEnumValues,
  attributeValueAliases,
} from '../schema/attributeRegistry.js';
import { categories } from '../schema/catalog.js';
import { productTypeDefinitions } from '../schema/productTypes.js';
import { brands } from '../schema/organizations.js';
import { canonicalProductFamilies, canonicalProducts } from '../schema/canonicalCatalog.js';

/** One label the scan compared against. */
export interface DuplicateSubject {
  readonly ref: string;
  readonly label: string;
  /** The normalized form the exact probe compares in. */
  readonly normalized: string;
}

/** A near match, with the score that made it one. */
export interface DuplicateNearMatch extends DuplicateSubject {
  readonly similarity: number;
}

/** What a probe found, with its population beside it. */
export interface DuplicateProbe {
  readonly population: number;
  readonly exact: DuplicateSubject | null;
  readonly near: readonly DuplicateNearMatch[];
}

/** An empty probe over an empty population — stated once so it is never a literal. */
export const EMPTY_DUPLICATE_PROBE: DuplicateProbe = { population: 0, exact: null, near: [] };

/**
 * The controlled values of ONE attribute definition.
 *
 * The exact probe compares against `attribute_enum_values.value`, which
 * `attribute_enum_values_normalized_check` already holds to `lower(btrim(...))`
 * — so the comparison happens in the space the unique index lives in rather than
 * in one this module invented.
 */
export async function probeControlledValues(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  normalizedLabel: string,
  searchLabel: string,
  nearLimit: number,
): Promise<DuplicateProbe> {
  const populationRows = await db
    .select({ total: count() })
    .from(attributeEnumValues)
    .where(eq(attributeEnumValues.attributeDefinitionId, attributeDefinitionId));
  const population = populationRows[0]?.total ?? 0;

  const exactRows = await db
    .select({
      id: attributeEnumValues.id,
      label: attributeEnumValues.label,
      value: attributeEnumValues.value,
    })
    .from(attributeEnumValues)
    .where(
      and(
        eq(attributeEnumValues.attributeDefinitionId, attributeDefinitionId),
        eq(attributeEnumValues.value, normalizedLabel),
      ),
    )
    .limit(1);

  const nearRows = await db
    .select({
      id: attributeEnumValues.id,
      label: attributeEnumValues.label,
      value: attributeEnumValues.value,
      similarity: sql<number>`similarity(${attributeEnumValues.value}, ${searchLabel})`,
    })
    .from(attributeEnumValues)
    .where(eq(attributeEnumValues.attributeDefinitionId, attributeDefinitionId))
    .orderBy(sql`${attributeEnumValues.value} <-> ${searchLabel}`)
    .limit(nearLimit);

  const exactRow = exactRows[0];
  return {
    population,
    exact: exactRow
      ? { ref: exactRow.id, label: exactRow.label, normalized: exactRow.value }
      : null,
    near: nearRows
      .filter((row) => row.value !== normalizedLabel)
      .map((row) => ({
        ref: row.id,
        label: row.label,
        normalized: row.value,
        similarity: Number(row.similarity),
      })),
  };
}

/**
 * A recorded ALIAS resolving to an existing controlled value.
 *
 * A separate DETECTOR from {@link probeControlledValues}, and the operator record
 * says which one fired: "there is already a value spelled that way" and "somebody
 * has already recorded that spelling as meaning something else" lead a submitter
 * to different next actions, and collapsing them loses the second entirely.
 *
 * `normalized_alias` is GENERATED (`lower(btrim(...))`), so the comparison
 * happens in exactly the space `attribute_value_aliases`' unique index lives in.
 */
export async function probeValueAliases(
  db: DatabaseOrTransaction,
  attributeDefinitionId: string,
  normalizedLabel: string,
): Promise<DuplicateProbe> {
  const populationRows = await db
    .select({ total: count() })
    .from(attributeValueAliases)
    .where(eq(attributeValueAliases.attributeDefinitionId, attributeDefinitionId));
  const population = populationRows[0]?.total ?? 0;

  const rows = await db
    .select({
      enumValueId: attributeValueAliases.enumValueId,
      value: attributeEnumValues.value,
      label: attributeEnumValues.label,
    })
    .from(attributeValueAliases)
    .innerJoin(attributeEnumValues, eq(attributeEnumValues.id, attributeValueAliases.enumValueId))
    .where(
      and(
        eq(attributeValueAliases.attributeDefinitionId, attributeDefinitionId),
        eq(attributeValueAliases.normalizedAlias, normalizedLabel),
      ),
    )
    .limit(1);

  const row = rows[0];
  return {
    population,
    exact: row ? { ref: row.enumValueId, label: row.label, normalized: row.value } : null,
    near: [],
  };
}

/**
 * The named-entity probe the other proposal types share.
 *
 * The dispatch is a `switch` over `CatalogProposalType` rather than a map keyed
 * by a string, so adding a proposal type fails `tsc` here until somebody decides
 * what a duplicate of it is — instead of silently answering an empty probe, which
 * is the shape that reads as a clean scan.
 */
export async function probeNamedEntities(
  db: DatabaseOrTransaction,
  type: CatalogProposalType,
  normalizedLabel: string,
  searchLabel: string,
  nearLimit: number,
): Promise<DuplicateProbe> {
  switch (type) {
    case 'category':
      return probeTable(db, categories, categories.id, categories.name, lowerBtrim(categories.name), normalizedLabel, searchLabel, nearLimit);
    case 'product_type':
      return probeTable(
        db,
        productTypeDefinitions,
        productTypeDefinitions.id,
        productTypeDefinitions.name,
        lowerBtrim(productTypeDefinitions.name),
        normalizedLabel,
        searchLabel,
        nearLimit,
      );
    case 'brand':
      return probeTable(db, brands, brands.id, brands.name, asText(brands.normalizedName), normalizedLabel, searchLabel, nearLimit);
    case 'product_family':
      return probeTable(
        db,
        canonicalProductFamilies,
        canonicalProductFamilies.id,
        canonicalProductFamilies.name,
        asText(canonicalProductFamilies.normalizedName),
        normalizedLabel,
        searchLabel,
        nearLimit,
      );
    case 'canonical_product':
      return probeTable(
        db,
        canonicalProducts,
        canonicalProducts.id,
        canonicalProducts.name,
        asText(canonicalProducts.normalizedName),
        normalizedLabel,
        searchLabel,
        nearLimit,
      );
    case 'attribute':
      // The registry's KEY and not a name: an attribute definition's identity is
      // its key (ADR 0007 D1) and its localized labels live in
      // `attribute_labels`, so a name probe would compare one locale's spelling
      // against a submitter working in another.
      return probeTable(
        db,
        attributeDefinitions,
        attributeDefinitions.id,
        attributeDefinitions.key,
        asText(attributeDefinitions.key),
        normalizedLabel,
        searchLabel,
        nearLimit,
      );
    case 'canonical_variant':
    case 'controlled_value':
      // `controlled_value` has its own probes above; a variant has no comparable
      // label at all. Both answer an EMPTY POPULATION rather than an empty
      // candidate list, which is the difference between "nothing was compared"
      // and "nothing matched".
      return EMPTY_DUPLICATE_PROBE;
    default:
      return EMPTY_DUPLICATE_PROBE;
  }
}

/** `lower(btrim(col))` for a table with no service-maintained normalization. */
function lowerBtrim(column: PgColumn): SQL<string> {
  return sql<string>`lower(btrim(${column}))`;
}

/** A column already stored normalized, as the same expression type. */
function asText(column: PgColumn): SQL<string> {
  return sql<string>`${column}`;
}

/**
 * One table's exact-and-near probe.
 *
 * The normalized EXPRESSION is passed in rather than inferred from a column
 * name, because three of these tables carry a service-maintained
 * `normalized_name` and three do not — and a rule that guessed which from a name
 * would start being wrong the day somebody adds a seventh, silently, in the
 * direction that reports no duplicates.
 */
async function probeTable(
  db: DatabaseOrTransaction,
  table: PgTable,
  idColumn: PgColumn,
  labelColumn: PgColumn,
  normalized: SQL<string>,
  normalizedLabel: string,
  searchLabel: string,
  nearLimit: number,
): Promise<DuplicateProbe> {
  const populationRows = await db.select({ total: count() }).from(table);
  const population = populationRows[0]?.total ?? 0;

  const exactRows = await db
    .select({ id: idColumn, label: labelColumn, normalized })
    .from(table)
    .where(sql`${normalized} = ${normalizedLabel}`)
    .limit(1);

  const nearRows = await db
    .select({
      id: idColumn,
      label: labelColumn,
      normalized,
      similarity: sql<number>`similarity(${normalized}, ${searchLabel})`,
    })
    .from(table)
    .orderBy(sql`${normalized} <-> ${searchLabel}`)
    .limit(nearLimit);

  const exactRow = exactRows[0];
  return {
    population,
    exact: exactRow
      ? {
          ref: String(exactRow.id),
          label: String(exactRow.label),
          normalized: String(exactRow.normalized),
        }
      : null,
    near: nearRows
      .filter((row) => String(row.normalized) !== normalizedLabel)
      .map((row) => ({
        ref: String(row.id),
        label: String(row.label),
        normalized: String(row.normalized),
        similarity: Number(row.similarity),
      })),
  };
}
