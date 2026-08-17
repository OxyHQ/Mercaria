/**
 * Data quality: completeness metrics and duplicate detection
 * (#367 Workstream 12).
 *
 * ## `0 / 0` is not 100%
 *
 * Every completeness cell carries `eligible` — the denominator — and omits
 * `ratio` entirely when it is zero. A dashboard that rendered an empty locale
 * as complete would tell an operator a market is ready when nothing was ever
 * measured, and that is the same vacuity the impact report and the review desk
 * guard against, arriving through the one door where it looks like arithmetic
 * rather than like a missing read.
 *
 * ## Duplicate detection answers the epic's own example
 *
 * #367 names `Color`, `Colour`, `color ` and `Tono` as the concrete failure.
 * Two of the three detectors here find exactly that: two ACTIVE attribute
 * definitions under different keys whose labels normalize to one string, and
 * two controlled values under one attribute whose labels do. The third finds
 * two published categories with one name — different parents, one concept,
 * which is how a taxonomy grows a second copy of itself.
 *
 * Normalization is accent-folding plus case-folding plus whitespace collapse,
 * which catches `color `/`Color`/`COLOR` and `Tono`/`tono`. It does NOT catch
 * `Colour`, and that is stated rather than papered over: cross-language and
 * spelling-variant detection is a dictionary problem, the localization domain
 * owns the vocabulary it would need, and a fuzzy detector that reported
 * `Color`/`Colour` would also report `Cover`/`Colour` and be switched off within
 * a week.
 *
 * ## Every scan reports its POPULATION
 *
 * A detector that read nothing finds nothing, and so does one that read
 * everything and found a clean catalogue. `population` is what tells them
 * apart, and `CatalogGovernanceDuplicateScan` has no shape without it.
 */

import { sql } from 'drizzle-orm';
import type {
  CatalogGovernanceCompletenessCell,
  CatalogGovernanceCompletenessDimension,
  CatalogGovernanceDuplicateFinding,
  CatalogGovernanceDuplicateScan,
} from '@mercaria/shared-types';
import { SUPPORTED_LOCALES } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';

/**
 * The statuses that count as a translation being PRESENT.
 *
 * `machine_translated` is deliberately excluded from the numerator and included
 * in `stale`'s sibling column instead: an unreviewed machine translation is
 * work outstanding, and counting it as coverage is how a locale reports 98%
 * complete while a shopper reads a machine's guess at a legal category name.
 * The localization domain's own `HUMAN_SETTLED_LOCALIZATION_STATUSES` says the
 * same thing one layer down; this restates the two members rather than
 * importing them because the METRIC's definition must not silently change when
 * that tuple is widened for a serving decision.
 */
const PRESENT_LOCALIZATION_STATUSES = ['reviewed', 'approved'] as const;

/** Build a cell, omitting `ratio` when there is no denominator. */
function cell(
  dimension: CatalogGovernanceCompletenessDimension,
  key: string,
  eligible: number,
  present: number,
  stale: number,
): CatalogGovernanceCompletenessCell {
  if (eligible === 0) {
    // No `ratio` property at all, rather than `0` or `1`. A consumer that wants
    // to render a bar has to notice there is nothing to render.
    return { dimension, key, eligible, present, stale };
  }
  return { dimension, key, eligible, present, stale, ratio: present / eligible };
}

/**
 * Translation completeness per locale, over published categories.
 *
 * The denominator is PUBLISHED categories rather than all of them: a draft
 * category nobody has released is not a translation gap, and counting it makes
 * every locale look permanently incomplete, which is the fastest way to make a
 * completeness metric ignored.
 */
export async function measureLocaleCompleteness(
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogGovernanceCompletenessCell[]> {
  const rows = await db.execute<{
    locale: string;
    eligible: number;
    present: number;
    stale: number;
  }>(sql`
    with published as (select id from categories where lifecycle = 'published'),
         locales as (select unnest(${sql.raw(
           `array[${SUPPORTED_LOCALES.map((locale) => `'${locale}'`).join(', ')}]::text[]`,
         )}) as locale)
    select l.locale,
           (select count(*) from published) as eligible,
           count(*) filter (
             where cl.status in ${sql.raw(
               `(${PRESENT_LOCALIZATION_STATUSES.map((status) => `'${status}'`).join(', ')})`,
             )}
           ) as present,
           count(*) filter (where cl.status = 'stale') as stale
      from locales l
      left join category_localizations cl
        on cl.locale = l.locale
       and cl.category_id in (select id from published)
     group by l.locale
     order by l.locale
  `);

  return rows.map((row) =>
    cell('locale', row.locale, Number(row.eligible), Number(row.present), Number(row.stale)),
  );
}

/**
 * Attribute completeness per category — how much of what a category's product
 * types ASK for is actually defined.
 *
 * Eligible is the number of published product-type fields scoped to the
 * category; present is those whose attribute definition is `active`. A field
 * citing a deprecated or retired definition is a real authoring hole and it is
 * invisible everywhere else, because the row is valid and the FK resolves.
 */
export async function measureCategoryCompleteness(
  db: DatabaseOrTransaction = getDb(),
  limit = 200,
): Promise<CatalogGovernanceCompletenessCell[]> {
  const rows = await db.execute<{
    category_id: string;
    eligible: number;
    present: number;
  }>(sql`
    select s.category_id,
           count(f.id) as eligible,
           count(f.id) filter (where a.lifecycle_state = 'active') as present
      from product_type_category_scopes s
      join product_type_definitions d
        on d.id = s.product_type_definition_id and d.lifecycle = 'published'
      join product_type_fields f on f.product_type_definition_id = d.id
      join attribute_definitions a on a.id = f.attribute_definition_id
     group by s.category_id
     order by s.category_id
     limit ${limit}
  `);

  return rows.map((row) =>
    cell('category', row.category_id, Number(row.eligible), Number(row.present), 0),
  );
}

/** Localization completeness per published product-type version. */
export async function measureProductTypeCompleteness(
  db: DatabaseOrTransaction = getDb(),
  limit = 200,
): Promise<CatalogGovernanceCompletenessCell[]> {
  const localeCount = SUPPORTED_LOCALES.length;
  const rows = await db.execute<{
    key: string;
    present: number;
    stale: number;
  }>(sql`
    select d.key,
           count(l.id) filter (
             where l.status in ${sql.raw(
               `(${PRESENT_LOCALIZATION_STATUSES.map((status) => `'${status}'`).join(', ')})`,
             )}
           ) as present,
           count(l.id) filter (where l.status = 'stale') as stale
      from product_type_definitions d
      left join product_type_localizations l on l.product_type_definition_id = d.id
     where d.lifecycle = 'published'
     group by d.key
     order by d.key
     limit ${limit}
  `);

  return rows.map((row) =>
    cell('product_type', row.key, localeCount, Number(row.present), Number(row.stale)),
  );
}

/**
 * Mapping completeness per external source.
 *
 * Eligible is every token this source has been OBSERVED to publish; present is
 * those with a live approved mapping. A source with no observations reports
 * `eligible: 0` and no ratio — because "100% mapped" over a source nobody has
 * ingested is the exact claim `hasRecordedObservations` exists to refuse one
 * domain down.
 */
export async function measureSourceCompleteness(
  db: DatabaseOrTransaction = getDb(),
  limit = 200,
): Promise<CatalogGovernanceCompletenessCell[]> {
  const rows = await db.execute<{
    catalog_source_id: string;
    eligible: number;
    present: number;
  }>(sql`
    select o.catalog_source_id,
           count(*) as eligible,
           count(*) filter (where o.resolution_outcome = 'resolved') as present
      from catalog_external_token_observations o
     group by o.catalog_source_id
     order by o.catalog_source_id
     limit ${limit}
  `);

  return rows.map((row) =>
    cell('source', row.catalog_source_id, Number(row.eligible), Number(row.present), 0),
  );
}

/**
 * Two published categories whose names normalize to one string.
 *
 * `unaccent` is not assumed — it is an extension this deployment may not have —
 * so the fold is `lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))`, which
 * catches case and whitespace and not accents. Stating the limit is the point:
 * a detector whose reach is unclear gets trusted past it.
 */
export async function scanDuplicateCategories(
  db: DatabaseOrTransaction = getDb(),
  limit = 100,
): Promise<CatalogGovernanceDuplicateScan> {
  const [population] = await db.execute<{ total: number }>(
    sql`select count(*) as total from categories where lifecycle = 'published'`,
  );

  const rows = await db.execute<{ normalized: string; ids: string[] }>(sql`
    select lower(btrim(regexp_replace(name, '\\s+', ' ', 'g'))) as normalized,
           array_agg(id order by id) as ids
      from categories
     where lifecycle = 'published'
     group by 1
    having count(*) > 1
     order by 1
     limit ${limit}
  `);

  const findings: CatalogGovernanceDuplicateFinding[] = rows.map((row) => ({
    subjectKind: 'category',
    detector: 'normalized_name',
    normalizedValue: row.normalized,
    subjectIds: row.ids,
  }));

  return { population: Number(population?.total ?? 0), findings };
}

/**
 * Two ACTIVE attribute definitions under different keys with one label — the
 * epic's `Color` / `color ` case, and the one that matters most because a
 * second definition of one concept splits every filter built on it.
 */
export async function scanDuplicateAttributes(
  db: DatabaseOrTransaction = getDb(),
  limit = 100,
): Promise<CatalogGovernanceDuplicateScan> {
  const [population] = await db.execute<{ total: number }>(
    sql`select count(*) as total from attribute_definitions where lifecycle_state = 'active'`,
  );

  const rows = await db.execute<{ normalized: string; ids: string[] }>(sql`
    select lower(btrim(regexp_replace(label, '\\s+', ' ', 'g'))) as normalized,
           array_agg(id order by id) as ids
      from attribute_definitions
     where lifecycle_state = 'active'
     group by 1
    having count(distinct key) > 1
     order by 1
     limit ${limit}
  `);

  const findings: CatalogGovernanceDuplicateFinding[] = rows.map((row) => ({
    subjectKind: 'attribute_definition',
    detector: 'normalized_label',
    normalizedValue: row.normalized,
    subjectIds: row.ids,
  }));

  return { population: Number(population?.total ?? 0), findings };
}

/**
 * Two controlled values under ONE attribute whose labels normalize together.
 *
 * Scoped to one attribute deliberately: `black` under `color` and `black` under
 * `strap_colour` are two correct facts, and a detector that reported them would
 * bury the real finding under every colour in the catalogue.
 */
export async function scanDuplicateControlledValues(
  db: DatabaseOrTransaction = getDb(),
  limit = 100,
): Promise<CatalogGovernanceDuplicateScan> {
  const [population] = await db.execute<{ total: number }>(
    sql`select count(*) as total from attribute_enum_values`,
  );

  const rows = await db.execute<{
    attribute_definition_id: string;
    normalized: string;
    ids: string[];
  }>(sql`
    select v.attribute_definition_id,
           lower(btrim(regexp_replace(v.label, '\\s+', ' ', 'g'))) as normalized,
           array_agg(v.id order by v.id) as ids
      from attribute_enum_values v
     group by 1, 2
    having count(*) > 1
     order by 1, 2
     limit ${limit}
  `);

  const findings: CatalogGovernanceDuplicateFinding[] = rows.map((row) => ({
    subjectKind: 'attribute_definition',
    detector: 'normalized_controlled_value_label',
    normalizedValue: `${row.attribute_definition_id}:${row.normalized}`,
    subjectIds: row.ids,
  }));

  return { population: Number(population?.total ?? 0), findings };
}

/** Everything the data-quality dashboard reads, in one call. */
export interface CatalogQualityReport {
  readonly completeness: readonly CatalogGovernanceCompletenessCell[];
  readonly duplicateCategories: CatalogGovernanceDuplicateScan;
  readonly duplicateAttributes: CatalogGovernanceDuplicateScan;
  readonly duplicateControlledValues: CatalogGovernanceDuplicateScan;
}

/** The dashboard. */
export async function readCatalogQuality(
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogQualityReport> {
  const [locales, categories, productTypes, sources] = await Promise.all([
    measureLocaleCompleteness(db),
    measureCategoryCompleteness(db),
    measureProductTypeCompleteness(db),
    measureSourceCompleteness(db),
  ]);

  return {
    completeness: [...locales, ...categories, ...productTypes, ...sources],
    duplicateCategories: await scanDuplicateCategories(db),
    duplicateAttributes: await scanDuplicateAttributes(db),
    duplicateControlledValues: await scanDuplicateControlledValues(db),
  };
}
