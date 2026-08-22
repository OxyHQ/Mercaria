/**
 * The translation revision trail's reads, and the one write that is not a
 * trigger's (#367 merge-order step 10, box 4).
 *
 * ## There is no `recordRevision` here, deliberately
 *
 * The trail is written by database triggers and nothing else — one on each
 * COVERED text table, enumerated and DERIVED in
 * `services/catalog-event-contracts.ts` (`CATALOG_EVENT_CONTRACTS.translation_change`),
 * because this line said "four" long after there were eight. Three of the
 * eleven localized tables are deliberately not covered; the reasons are in
 * `LOCALIZED_TABLE_TRAIL_COVERAGE` beside it. A repository
 * function that inserted a revision would be a SECOND writer, and the two would
 * disagree the first time somebody wrote a translation through a path that
 * forgot to call it — which is every path that is not this service: a backfill
 * script, an operator at a `psql` prompt, and the stale triggers the schema
 * already installs. A missing revision looks exactly like a field nobody
 * edited, so the gap would be invisible.
 *
 * What IS here is the rollback, and even that does not write the trail: it
 * writes the LOCALIZATION row, having told the trigger what the update undoes.
 *
 * ## Nothing in the running service imports this module
 *
 * Measured, and recorded as an open gap on the `translation_change` contract:
 * all three exports below are reachable only from
 * `db/__tests__/localization-revisions.realdb.test.ts`. The trail is therefore
 * WRITE-ONLY in production — eight triggers fill it and no route, service or
 * controller can show a translator what a string used to say or roll one back.
 * `copyForwardProductTypeLocalizations` was in exactly this state until #650, so
 * the shape is a known one here: a real, correct, realdb-tested surface that
 * nothing reaches, cited in a disposition as though it worked.
 *
 * The gate asserts the absence rather than the presence, in the direction a list
 * of gaps can never report on its own: the moment a production module imports
 * this file, `catalog-event-contracts.test.ts` goes red and the contract's
 * `consumer` has to be changed from `absent` to `reads`.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  CATALOG_LOCALIZED_FIELDS,
  LOCALIZATION_ROLLBACK_SETTING,
  type LocalizationFieldHistory,
  type LocalizationRevision,
  type LocalizationRevisionDiff,
  type LocalizedEntityKind,
  type LocalizedFieldKey,
  type SupportedLocale,
} from '@mercaria/shared-types';
import { catalogLocalizationRevisions } from '../schema/catalogLocalization.js';

type RevisionRow = typeof catalogLocalizationRevisions.$inferSelect;

function toRevision(row: RevisionRow): LocalizationRevision {
  return {
    id: row.id,
    action: row.action,
    entityKind: row.entityKind,
    entityId: row.entityId,
    locale: row.locale,
    fieldKey: row.fieldKey,
    value: row.value,
    status: row.status,
    provenance: row.provenance,
    creditedOxyUserId: row.creditedOxyUserId,
    rollbackOfRevisionId: row.rollbackOfRevisionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One field's whole history, newest first, with each step's predecessor.
 *
 * Served by `catalog_localization_revisions_field_idx`, whose column order IS
 * this query's shape.
 *
 * `previousValue` is read off the ADJACENT ROW rather than from a stored
 * `before` column. Storing both sides of every change is two representations of
 * one fact, and if they ever disagreed nobody could say which was the text. The
 * oldest step's predecessor is `null`, which is correct: before the first
 * revision the field had no recorded value.
 */
export async function readLocalizationFieldHistory(
  entityKind: LocalizedEntityKind,
  entityId: string,
  locale: SupportedLocale,
  fieldKey: LocalizedFieldKey,
  limit = 100,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationFieldHistory> {
  const rows = await db
    .select()
    .from(catalogLocalizationRevisions)
    .where(
      and(
        eq(catalogLocalizationRevisions.entityKind, entityKind),
        eq(catalogLocalizationRevisions.entityId, entityId),
        eq(catalogLocalizationRevisions.locale, locale),
        eq(catalogLocalizationRevisions.fieldKey, fieldKey),
      ),
    )
    .orderBy(desc(catalogLocalizationRevisions.createdAt), desc(catalogLocalizationRevisions.id))
    .limit(limit);

  // Newest first, so a step's predecessor is the NEXT element.
  const steps: LocalizationRevisionDiff[] = rows.map((row, index) => {
    const previous = rows[index + 1];
    const previousValue = previous ? previous.value : null;
    return {
      revision: toRevision(row),
      previousValue,
      // `IS DISTINCT FROM` semantics: a field going from a value to NULL, or the
      // reverse, IS a text change. `!==` alone would read `null` → `null` as a
      // change under `undefined`, which a status-only revision produces.
      textChanged: (row.value ?? null) !== previousValue,
    };
  });

  return { entityKind, entityId, locale, fieldKey, steps };
}

/** One revision by id, or `undefined`. */
export async function findLocalizationRevision(
  revisionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationRevision | undefined> {
  const [row] = await db
    .select()
    .from(catalogLocalizationRevisions)
    .where(eq(catalogLocalizationRevisions.id, revisionId))
    .limit(1);
  return row ? toRevision(row) : undefined;
}

/**
 * The live localization table each entity kind is stored in, and the column each
 * registered field occupies.
 *
 * A `switch` over the kind rather than a lookup keyed on a string, so a kind
 * added to `LocalizedEntityKind` is a compile error here — a rollback silently
 * not covering a domain is the failure this whole table exists to make
 * impossible.
 */
function liveTargetFor(entityKind: LocalizedEntityKind): {
  table: string;
  entityColumn: string;
} {
  switch (entityKind) {
    case 'category':
      return { table: 'category_localizations', entityColumn: 'category_id' };
    case 'product_type':
      return {
        table: 'product_type_localizations',
        entityColumn: 'product_type_definition_id',
      };
    case 'product_type_field':
      return {
        table: 'product_type_field_localizations',
        entityColumn: 'product_type_field_id',
      };
    case 'canonical_product':
      return {
        table: 'canonical_product_localizations',
        entityColumn: 'canonical_product_id',
      };
    case 'canonical_product_family':
      return {
        table: 'canonical_product_family_localizations',
        entityColumn: 'canonical_product_family_id',
      };
    case 'attribute_value':
      return {
        table: 'attribute_value_localizations',
        entityColumn: 'attribute_enum_value_id',
      };
    case 'attribute_definition':
      // The DEFINITION's own copy. `attribute_labels` is the family's one
      // late joiner (migration 0119) and its entity column keeps the name it
      // has had since #94 rather than being renamed to match its siblings.
      return { table: 'attribute_labels', entityColumn: 'attribute_definition_id' };
    case 'listing':
      // A rollback here restores a SELLER's own translation, not Mercaria's
      // copy. The mechanism is unchanged — the trail is trigger-written on
      // this table like every other member, so the rollback UPDATE produces a
      // revision and this function can report what it changed.
      return { table: 'listing_localizations', entityColumn: 'listing_id' };
    default: {
      const unreachable: never = entityKind;
      throw new Error(`unhandled localized entity kind: ${String(unreachable)}`);
    }
  }
}

/** The SQL column one registered field occupies, from the registry. */
function sqlColumnFor(fieldKey: LocalizedFieldKey): string {
  // `CATALOG_LOCALIZED_FIELDS[...].column` is the DRIZZLE property name
  // (`helpText`); the live UPDATE needs the SQL one. Converted rather than
  // re-listed, so a field added to the registry needs no edit here.
  return CATALOG_LOCALIZED_FIELDS[fieldKey].column.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
}

/**
 * Restore one field to the value a named revision recorded, as a NEW revision.
 *
 * Never a restore in place, and never a replay of a stored `before` snapshot:
 * the compensating-correction shape `catalog_revisions` uses. It performs an
 * ordinary UPDATE of the localization row after telling the trigger, through a
 * transaction-local setting, which revision the update undoes — so the trail
 * stays trigger-written and the rollback still names what it reverses.
 *
 * `set local` and not `set`: the value dies with the transaction rather than
 * leaking onto the next statement a pooled connection serves, which would stamp
 * an unrelated later edit as a rollback of this revision.
 *
 * Returns the revision the trigger wrote. A rollback whose UPDATE changed
 * nothing writes NO revision — the trigger's `IS DISTINCT FROM` guard is doing
 * its job — and that is reported as `undefined` rather than as a success,
 * because "restored" and "it already said that" are different answers.
 */
export async function rollbackLocalizationField(
  revision: LocalizationRevision,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationRevision | undefined> {
  const target = liveTargetFor(revision.entityKind);
  const column = sqlColumnFor(revision.fieldKey);

  return db.transaction(async (tx) => {
    // The one fact a trigger cannot see: that this UPDATE is undoing something.
    await tx.execute(
      sql`select set_config(${LOCALIZATION_ROLLBACK_SETTING}, ${revision.id}, true)`,
    );
    await tx.execute(
      sql`update ${sql.raw(`"${target.table}"`)}
             set ${sql.raw(`"${column}"`)} = ${revision.value}
           where ${sql.raw(`"${target.entityColumn}"`)} = ${revision.entityId}
             and locale = ${revision.locale}`,
    );
    const [written] = await tx
      .select()
      .from(catalogLocalizationRevisions)
      .where(eq(catalogLocalizationRevisions.rollbackOfRevisionId, revision.id))
      .orderBy(desc(catalogLocalizationRevisions.createdAt), desc(catalogLocalizationRevisions.id))
      .limit(1);
    return written ? toRevision(written) : undefined;
  });
}
