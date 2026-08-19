/**
 * The shape every member of the localization family carries (ADR 0007 D4).
 *
 * A THIRD module rather than a helper exported from `catalogLocalization.ts`,
 * and the reason is a cycle: `catalogLocalization.ts` imports
 * `attributeEnumValues` from `attributeRegistry.ts`, so `attributeRegistry.ts`
 * importing the helper back would close a loop between two schema modules. A
 * circular import in this directory does not fail loudly — it leaves one side's
 * binding `undefined` at module-init time, and the symptom is
 * `asEnumValues(undefined)` throwing from a table declaration that reads
 * perfectly. This module imports nothing from either side, so there is no loop.
 *
 * It exists at all because the family is per-entity rather than polymorphic:
 * five tables, one shape, and a hand-copied fifth copy is where the drift
 * starts. `catalog-localization.test.ts` asserts every member carries
 * `LOCALIZATION_FAMILY_COLUMNS`; this is what makes that true by construction.
 *
 * ## The checks come in two halves, and the split is load-bearing
 *
 * {@link localizationTextChecks} constrains the columns the family ADDS.
 * {@link localizationLocaleChecks} narrows the `locale` column: to
 * `SUPPORTED_LOCALES`, and away from the base locale.
 *
 * The four tables born into the family take both through
 * {@link localizationChecks}. `attribute_labels` predates D4 and takes only the
 * first, because the second NARROWS a column that already holds production
 * data — and a narrowing CHECK is validated against every existing row when it
 * is added, so it can abort a deploy on data nobody has looked at. That is not a
 * hypothetical: the identical shape was measured on #632. The narrowing is owed
 * and is named in `attributeRegistry.ts` beside the call.
 */

import { sql } from 'drizzle-orm';
import { check, text, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { timestamptz } from '@oxyhq/db';
import {
  LOCALIZATION_PROVENANCES,
  LOCALIZATION_STATUSES,
  MERCARIA_BASE_LOCALE,
  SUPPORTED_LOCALES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/** `SUPPORTED_LOCALES` as the tuple both the column type and its CHECK read. */
export const LOCALE_VALUES = asEnumValues(SUPPORTED_LOCALES);

/**
 * The seven columns every text member of the family carries.
 *
 * A helper for the same reason `money()` is one: the shape is repeated four
 * times and a hand-copied fourth copy is where the drift starts. The keys are
 * literal rather than generated from a prefix, so TypeScript infers the return
 * type exactly and no assertion is needed — the trap `money()`'s doc comment
 * records does not reach this one.
 *
 * `reviewed_by_oxy_user_id` rather than D4's `reviewed_by`: it is an Oxy account
 * id, Oxy owns identity, and the suffix is what makes it classifiable in
 * `deferredForeignKeys.ts` beside the other ninety.
 */
export function localizationColumns() {
  return {
    /** Lowercase BCP 47, never the base locale. See the file header. */
    locale: text({ enum: LOCALE_VALUES }).notNull(),
    status: text({ enum: asEnumValues(LOCALIZATION_STATUSES) }).notNull(),
    provenance: text({ enum: asEnumValues(LOCALIZATION_PROVENANCES) }).notNull(),
    /**
     * The locale this text was translated FROM. Usually the base locale; not
     * always, since a Catalan translation is more usefully made from Spanish.
     */
    sourceLocale: text({ enum: LOCALE_VALUES }),
    /**
     * The source content's revision marker, as its owner spells it — a digest, a
     * version, an `updated_at`. Opaque here, and deliberately NOT what the stale
     * trigger compares: `categories` carries no revision column, so a comparison
     * against it would be a check that can never fire. The trigger watches the
     * source TEXT instead, and this column is what a reviewer reads afterwards
     * to see which revision the translation was made against.
     */
    sourceRevision: text(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
  };
}

export interface LocalizationCheckColumns {
  locale: AnyPgColumn;
  status: AnyPgColumn;
  provenance: AnyPgColumn;
  sourceLocale: AnyPgColumn;
  reviewedByOxyUserId: AnyPgColumn;
  reviewedAt: AnyPgColumn;
  primaryText: AnyPgColumn;
}

/**
 * The CHECKs over the columns the family ADDS.
 *
 * Safe to add to a table that already holds rows: every column named here is
 * one this family introduces, so the constraint is validated against values the
 * same migration wrote.
 */
export function localizationTextChecks(table: string, columns: LocalizationCheckColumns) {
  return [
    checkOneOf(`${table}_status_check`, columns.status, LOCALIZATION_STATUSES),
    checkOneOf(`${table}_provenance_check`, columns.provenance, LOCALIZATION_PROVENANCES),
    // `source_locale` is a column the family ADDS, so narrowing it is validated
    // against values this migration wrote and cannot fail on existing rows —
    // which is why it belongs on this side of the split and `locale` does not.
    checkOneOf(`${table}_source_locale_check`, columns.sourceLocale, SUPPORTED_LOCALES),
    // A `missing` row is one somebody opened to say a translation is owed; it is
    // not a row with text nobody classified, and it is not the absence of a row.
    check(
      `${table}_missing_text_check`,
      sql`(${columns.status} = 'missing') = (${columns.primaryText} is null)`,
    ),
    // …and an empty string is not text. Without this the CHECK above is
    // satisfied by `status = 'approved'` beside `name = ''`, which is a row
    // claiming a human approved a blank category name — and the resolver would
    // have to guess whether to serve it.
    check(
      `${table}_text_not_blank_check`,
      sql`${columns.primaryText} is null or btrim(${columns.primaryText}) <> ''`,
    ),
    // Machine translation is a SUGGESTION. The trigger refuses the transition;
    // this refuses the resulting row, which an INSERT never gives the trigger a
    // chance to see.
    check(
      `${table}_machine_status_check`,
      sql`${columns.provenance} <> 'machine' or ${columns.status} not in ('reviewed', 'approved')`,
    ),
    // …and it may not wear somebody else's review either. Without this, a
    // machine write that also downgraded the status would keep the human
    // reviewer's name on text they never saw.
    check(
      `${table}_machine_reviewer_check`,
      sql`${columns.provenance} <> 'machine' or (${columns.reviewedByOxyUserId} is null and ${columns.reviewedAt} is null)`,
    ),
    // A reviewer and a review instant travel together; neither means anything
    // alone. The `attribute_value_reviews` resolution shape.
    check(
      `${table}_reviewer_pair_check`,
      sql`(${columns.reviewedByOxyUserId} is null) = (${columns.reviewedAt} is null)`,
    ),
    // Settled text names who settled it. One-way rather than a biconditional, so
    // a row that WAS approved and has since gone `stale` keeps its audit — which
    // is the whole reason `stale` does not blank anything.
    check(
      `${table}_reviewed_audit_check`,
      sql`${columns.status} not in ('reviewed', 'approved') or ${columns.reviewedByOxyUserId} is not null`,
    ),
  ];
}

/**
 * The CHECKs that NARROW the pre-existing `locale` column.
 *
 * Separate because adding one to a populated table validates it against every
 * existing row, so it can abort a deploy. A table joining the family later takes
 * these only once somebody has counted the rows that would fail.
 */
export function localizationLocaleChecks(table: string, columns: LocalizationCheckColumns) {
  return [
    checkOneOf(`${table}_locale_check`, columns.locale, SUPPORTED_LOCALES),
    // The base-locale string lives on the entity's own column. See the header.
    //
    // `sql.raw` and not an interpolated JS string: a value interpolated normally
    // renders as a BOUND PARAMETER, and drizzle-kit writes the literal `$1` into
    // the migration — which generates cleanly and fails at APPLY time.
    check(
      `${table}_locale_not_base_check`,
      sql`${columns.locale} <> ${sql.raw(`'${MERCARIA_BASE_LOCALE}'`)}`,
    ),
  ];
}

/** Both halves — what a table born into the family takes. */
export function localizationChecks(table: string, columns: LocalizationCheckColumns) {
  return [...localizationLocaleChecks(table, columns), ...localizationTextChecks(table, columns)];
}
