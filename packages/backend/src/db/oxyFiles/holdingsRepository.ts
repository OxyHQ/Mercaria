/**
 * Generic reads of the rows that HOLD an Oxy file id — what the reference
 * registry (`services/catalog-media/file-reference-registry.ts`) declares per
 * entity type, rendered here as SQL.
 *
 * A source is one table, the column whose value is the entity id, and the
 * columns that can hold a file. How a column holds one is its `kind`:
 *
 * - `file_id` — the value IS a file id (`listing_images.file_id`).
 * - `file_id_array` — each element is (`catalog_authoring_drafts.image_file_ids`).
 * - `stored_url` — a public Oxy URL naming the file (`order_items.image_url`,
 *   legacy `categories.image_url`); anything else names no file.
 * - `html` — every content `<img src>` naming one (an imported description).
 *
 * These functions return RAW values; turning a value into file ids (and
 * refusing a legacy supplier URL that is not one) is the registry's, in one
 * place, because the `stored_url` and `html` parsers are not SQL.
 *
 * Identifiers are compile-time constants of the registry, never request data;
 * they go through `sql.identifier` all the same.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';

export type HoldingValueKind = 'file_id' | 'file_id_array' | 'stored_url' | 'html';

export interface HoldingColumn {
  readonly name: string;
  readonly kind: HoldingValueKind;
}

export interface HoldingSource {
  readonly table: string;
  readonly entityColumn: string;
  readonly columns: readonly HoldingColumn[];
}

/** One source row: its entity id and the raw value of each holding column, in order. */
export interface HoldingRow {
  readonly entityId: string;
  readonly values: readonly unknown[];
}

function column(name: string): SQL {
  return sql`${sql.identifier(name)}`;
}

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** "This column could hold a file" — the filter an inventory page uses. */
function mayHold(holding: HoldingColumn): SQL {
  const name = column(holding.name);
  switch (holding.kind) {
    case 'file_id':
    case 'stored_url':
      return sql`(${name} is not null and ${name} <> '')`;
    case 'file_id_array':
      return sql`cardinality(${name}) >= 1`;
    case 'html':
      return sql`(${name} ilike '%<img%')`;
  }
}

/** "This column may hold THIS file" — a superset the registry narrows in TS. */
function mayHoldFile(holding: HoldingColumn, fileId: string): SQL {
  const name = column(holding.name);
  switch (holding.kind) {
    case 'file_id':
      return sql`${name} = ${fileId}`;
    case 'file_id_array':
      return sql`${fileId} = any(${name})`;
    case 'stored_url':
    case 'html':
      // `strpos`, not `like`: a file id is `[A-Za-z0-9_-]+`, and `_` is a
      // `like` wildcard.
      return sql`strpos(${name}, ${fileId}) > 0`;
  }
}

function selection(source: HoldingSource): SQL {
  return sql.join(
    [
      sql`${column(source.entityColumn)}::text as entity_id`,
      ...source.columns.map(
        (holding, index) => sql`${column(holding.name)} as ${sql.raw(`v${index}`)}`,
      ),
    ],
    sql`, `,
  );
}

function toRows(source: HoldingSource, rows: readonly Record<string, unknown>[]): HoldingRow[] {
  return rows.map((row) => ({
    entityId: String(row.entity_id),
    values: source.columns.map((_, index) => row[`v${index}`]),
  }));
}

/** Every row of `source` belonging to these entities. */
export async function readHoldingRows(
  source: HoldingSource,
  entityIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<HoldingRow[]> {
  if (entityIds.length === 0) return [];
  const rows = await db.execute<Record<string, unknown>>(sql`
    select ${selection(source)}
    from ${column(source.table)}
    where ${column(source.entityColumn)} in (${list(entityIds)})`);
  return toRows(source, rows);
}

/**
 * One keyset page of the entity ids any of `sources` may hold a file for,
 * ascending, strictly after `after`. A page of ENTITIES, not rows, and over the
 * UNION of the sources, so an entity's rows are never split across two pages of
 * an inventory and an entity two sources share is listed once.
 */
export async function readHoldingEntityPage(
  sources: readonly HoldingSource[],
  after: string | undefined,
  limit: number,
  db: DatabaseOrTransaction,
): Promise<string[]> {
  if (sources.length === 0) return [];
  const branches = sources.map((source) => {
    const entity = column(source.entityColumn);
    return sql`
      select ${entity}::text as entity_id
      from ${column(source.table)}
      where ${entity} is not null
        and (${sql.join(source.columns.map(mayHold), sql` or `)})
        ${after === undefined ? sql`` : sql`and ${entity}::text > ${after}`}`;
  });
  const rows = await db.execute<{ entity_id: string }>(sql`
    select entity_id from (${sql.join(branches, sql` union `)}) as holders
    order by 1
    limit ${limit}`);
  return rows.map((row) => String(row.entity_id));
}

/** Every row of `source` that may hold `fileId` (a superset; see `mayHoldFile`). */
export async function readHoldingRowsForFile(
  source: HoldingSource,
  fileId: string,
  db: DatabaseOrTransaction,
): Promise<HoldingRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select ${selection(source)}
    from ${column(source.table)}
    where ${sql.join(
      source.columns.map((holding) => mayHoldFile(holding, fileId)),
      sql` or `,
    )}`);
  return toRows(source, rows);
}
