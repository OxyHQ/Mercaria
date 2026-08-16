/**
 * Reading whether a Mercaria concept a mapping names actually exists
 * (#367 Workstream 11).
 *
 * READ ONLY, entirely. Every function here is a `select`, and
 * `external-mapping-isolation.test.ts` fails the build if any module in this
 * domain reaches a canonical write service, the matcher or an offer writer. That
 * is what makes "source records stay idempotent and must not create duplicate
 * canonical entities" a property of the import graph rather than a rule somebody
 * follows: an external mapping RESOLVES a Mercaria concept and has no way to
 * mint one.
 *
 * ## Why the attribute lookups go through the ACTIVE version
 *
 * `attribute_definitions` identity is `(key, version)` and each row is ONE
 * version, so a mapping targets the stable KEY (see the doc on
 * `catalog_external_mappings`). Resolution therefore reads
 * `attribute_definitions_one_active_per_key` — the partial unique that makes
 * "the active version of this attribute" a single row rather than a query with a
 * bug in it — and answers "no" when there is none. That is fail-closed: a
 * deployment part-way through publishing a new attribute version resolves
 * nothing for that key rather than resolving against a draft.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { attributeDefinitions, attributeEnumValues } from '../schema/attributeRegistry.js';

/*
 * There is no `categoryIsResolvable` here, and the absence is the point.
 *
 * `category_external_mappings` belongs to the taxonomy module (ADR 0007 D2) and
 * the taxonomy workstream built it, so this domain carries no `category`
 * dimension — which means it also has no reason to read `categories`. A reader
 * kept "for when we fold that dimension in" would be a live import of another
 * module's table with no caller, and the fold-in is an ADR amendment plus a move
 * migration rather than something a stray function should be waiting for.
 */

/** The active version of an attribute key, or `null` when there is none. */
export async function findActiveAttributeVersion(
  attributeKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ readonly id: string; readonly version: number } | null> {
  const [row] = await db
    .select({ id: attributeDefinitions.id, version: attributeDefinitions.version })
    .from(attributeDefinitions)
    .where(
      and(
        eq(attributeDefinitions.key, attributeKey),
        eq(attributeDefinitions.lifecycleState, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether a controlled value exists on the ACTIVE version of an attribute.
 *
 * Two statements would race a version publication between them, so this is one
 * join. The comparison on `value` needs no normalization on the query side:
 * `attribute_enum_values_normalized_check` already forces every stored value to
 * be `lower(btrim(...))` of itself, and
 * `catalog_external_mappings_controlled_value_shape_check` forces the mapping's
 * target into the same form — so both sides are already normalized by their own
 * constraints and a mismatch is a genuine absence rather than a spelling.
 */
export async function controlledValueIsResolvable(
  attributeKey: string,
  controlledValue: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(attributeEnumValues)
    .innerJoin(
      attributeDefinitions,
      eq(attributeEnumValues.attributeDefinitionId, attributeDefinitions.id),
    )
    .where(
      and(
        eq(attributeDefinitions.key, attributeKey),
        eq(attributeDefinitions.lifecycleState, 'active'),
        eq(attributeEnumValues.value, controlledValue),
      ),
    )
    .limit(1);
  return row !== undefined;
}
