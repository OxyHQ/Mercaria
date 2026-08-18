/**
 * The translation revision trail (#367 merge-order step 10, box 4) — what a
 * localized string used to say, who it was credited to, and how to put an
 * earlier wording back.
 *
 * ## Why this is the localization domain's own table and NOT a governance subject
 *
 * The obvious alternative was to widen `CATALOG_GOVERNANCE_SUBJECT_KINDS` and
 * let `catalog_governance_audit_events` carry translation history. That was
 * considered and REFUSED, for two reasons that point the same way.
 *
 * 1. **It would change the audience.** A governance subject comes with the
 *    operator gate, four eyes and the change-request flow attached to it.
 *    Translations are written by translators and store staff on a different
 *    cadence, and moving their history into governance would smuggle an
 *    audience change in as a side effect of where the rows live — a policy
 *    decision nobody has made.
 * 2. **Governance deliberately does not store the TEXT.**
 *    `services/catalog-governance/review.service.ts` records that a
 *    translation's status changed and omits the body, because "a translation
 *    body in an audit row is a copy of the text a correction can never reach".
 *    That is the right call for an audit trail and it is exactly what makes
 *    governance unable to be the home for a history whose whole purpose is the
 *    text.
 *
 * So this follows `catalog_revisions` (#59) and `review_target_migrations`
 * (#76): an append-only trail owned by the domain whose rows it describes.
 * **Do not "consolidate" this into the governance audit** — the two record
 * different facts for different readers, and only one of them may hold the
 * sentence a translator wrote.
 */

import {
  CATALOG_LOCALIZED_FIELDS,
  LOCALIZED_ENTITY_KINDS,
  LOCALIZED_FIELD_KEYS,
  type LocalizedEntityKind,
  type LocalizedFieldKey,
  type LocalizationProvenance,
  type LocalizationStatus,
  type SupportedLocale,
} from './catalog-localization';

/**
 * How a revision came to be written.
 *
 * `create` and `update` are the ordinary path. `rollback` is the ONLY one that
 * names another revision, and it is a NEW revision rather than a restore in
 * place — the `catalog_revisions` compensating-correction shape. Replaying a
 * stored `before` snapshot would write columns whose meaning may since have
 * moved; naming the revision being undone always resolves, because it points
 * backwards in time.
 *
 * There is deliberately no `delete`. Nothing in the backend deletes a
 * localization row — they vanish only by cascade when their ENTITY is deleted,
 * and "the category was removed" is not a fact about the translation. A
 * translation is withdrawn deliberately by moving it to `deprecated`, which is
 * an ordinary `update` and is recorded as one.
 */
export const LOCALIZATION_REVISION_ACTIONS = ['create', 'update', 'rollback'] as const;

export type LocalizationRevisionAction = (typeof LOCALIZATION_REVISION_ACTIONS)[number];

/**
 * The `(entity_kind, field_key)` pairs a revision may name, rendered for a CHECK.
 *
 * Derived from `CATALOG_LOCALIZED_FIELDS` so a field added to the registry joins
 * this set in the same commit. A pair check rather than a prefix rule, because a
 * prefix rule is WRONG here in a way that is easy to miss: `product_type_field.label`
 * begins with `product_type`, so "the field key starts with the entity kind"
 * admits a `product_type` revision naming a `product_type_field` column.
 *
 * The rendered form is `<entity_kind>|<field_key>`, matched against the same
 * expression built in SQL — one tuple, two spellings that cannot drift because
 * the CHECK is rendered from this constant.
 */
export const LOCALIZATION_REVISION_FIELD_PAIRS: readonly string[] = LOCALIZED_FIELD_KEYS.map(
  (key) => `${CATALOG_LOCALIZED_FIELDS[key].entity}|${key}`,
);

/** Whether an entity kind and a field key describe the same registered field. */
export function isLocalizationRevisionFieldPair(
  entityKind: LocalizedEntityKind,
  fieldKey: LocalizedFieldKey,
): boolean {
  return LOCALIZATION_REVISION_FIELD_PAIRS.includes(`${entityKind}|${fieldKey}`);
}

/**
 * The transaction-local setting a rollback sets before its UPDATE.
 *
 * The revision trail is written by DATABASE TRIGGERS, so that it is complete by
 * construction — an operator at a `psql` prompt, a backfill script and the
 * service all produce history, which is the property a trail written by a
 * repository can never have. That leaves one thing a trigger cannot know: that
 * a particular UPDATE is undoing a particular earlier revision.
 *
 * `set local` carries exactly that one fact into the trigger, for the duration
 * of one transaction, and `current_setting(..., true)` reads it back as NULL
 * when absent. So the trigger stays the single writer and the rollback still
 * names what it undoes. It is `set local`, never `set`, so the value cannot
 * leak onto the next statement a pooled connection serves.
 */
export const LOCALIZATION_ROLLBACK_SETTING = 'mercaria.localization_rollback_of';

/** One recorded state of one localized field. */
export interface LocalizationRevision {
  readonly id: string;
  readonly action: LocalizationRevisionAction;
  readonly entityKind: LocalizedEntityKind;
  readonly entityId: string;
  readonly locale: SupportedLocale;
  readonly fieldKey: LocalizedFieldKey;
  /**
   * What the field said AFTER this revision. `null` is a real value — a field
   * cleared, or a `missing` row that holds no text by construction — and is not
   * the same as the field being absent from the trail.
   */
  readonly value: string | null;
  /** The row's status and provenance at this moment. */
  readonly status: LocalizationStatus;
  readonly provenance: LocalizationProvenance;
  /**
   * The Oxy account the ROW credited at this moment (`reviewed_by_oxy_user_id`).
   *
   * Named `credited` and not `actor` deliberately, and the distinction is not
   * pedantry: a trigger sees the row, not the session, so this is who the
   * translation says settled it — NOT who ran the statement. A machine
   * translation and a `missing` row both carry `null` here by CHECK, and a
   * direct `psql` UPDATE by an operator is credited to whoever the row already
   * named. Reading this as "who made this change" would be a misattribution,
   * which is the thing an audit trail can least afford.
   */
  readonly creditedOxyUserId: string | null;
  /** The revision this one undoes. Present EXACTLY when `action` is `rollback`. */
  readonly rollbackOfRevisionId: string | null;
  readonly createdAt: string;
}

/**
 * One step of a field's history, with what changed at that step.
 *
 * `previousValue` is the value of the PRECEDING revision of the same field, not
 * a stored `before` column. Storing both sides of every change is two
 * representations of one fact: the preceding row already holds it, and a stored
 * `before` that disagreed with the previous row's `after` would leave nobody
 * able to say which was the text.
 */
export interface LocalizationRevisionDiff {
  readonly revision: LocalizationRevision;
  readonly previousValue: string | null;
  /** `true` when this revision changed the text rather than only the status. */
  readonly textChanged: boolean;
}

/** One field's whole recorded history, newest first. */
export interface LocalizationFieldHistory {
  readonly entityKind: LocalizedEntityKind;
  readonly entityId: string;
  readonly locale: SupportedLocale;
  readonly fieldKey: LocalizedFieldKey;
  readonly steps: readonly LocalizationRevisionDiff[];
}

/** Every entity kind, for a caller enumerating the trail's coverage. */
export const LOCALIZATION_REVISION_ENTITY_KINDS: readonly LocalizedEntityKind[] =
  LOCALIZED_ENTITY_KINDS;
