/**
 * `product_type_field_localizations` — carrying ONE FIELD's authoring copy onto
 * the version that supersedes it (#650, ADR 0007 D10).
 *
 * ## Why this is a second copy forward rather than a wider first one
 *
 * `productTypeLocalizationRepository.copyForwardProductTypeLocalizations`
 * carries the VERSION-level text — what a smartphone schema is and what it is
 * for. It reads and writes `product_type_localizations` and nothing else, so a
 * publish that called only it still loses every per-field translation: a
 * localization here hangs off a `product_type_fields` ROW, a new version's
 * fields are new rows, and `product_type_field_localizations.product_type_field_id`
 * is `ON DELETE cascade`. Nothing errors and nothing is reported — the second
 * grain `impact-plan.ts` records as the gap this census cannot see.
 *
 * ## The join is the ATTRIBUTE KEY, never the row id
 *
 * A field's id is minted per version, so a copy joined on it matches nothing
 * and silently carries nothing — which looks exactly like a version that had no
 * translations. The identity that survives a bump is `(flow, scope,
 * attribute_key)`, and it is not a new invention here:
 * `services/catalog-governance/diff.ts`'s own `fieldKey` diffs two versions on
 * precisely that triple, for precisely this reason ("diffing on ids reports
 * every field as removed-and-added and the diff says nothing"). Two spellings
 * of one identity can disagree, so `product-type-field-identity.test.ts` pins
 * them against each other.
 *
 * `flow` is in the triple because a P2P form and a merchant form ask different
 * questions in a different order, and `scope` because the same attribute may be
 * a product fact on one field and a variant axis on another.
 *
 * ## Why this grain needs no caller-supplied diff, where the version grain does
 *
 * The version-level copy forward takes a `ProductTypeSemanticChange` because it
 * CANNOT compute one: `product_type.help_text` has no base column on
 * `product_type_definitions` at all (`name` and `description` are the only two
 * there), so nothing in that transaction holds the two strings to compare.
 *
 * All four of this grain's localized columns DO have a base on
 * `product_type_fields` — `label`, `help_text`, `placeholder` and `example`,
 * added in the same change that created this table. So the comparison here is a
 * direct read of the two values rather than a guess about them, and asking a
 * caller for a hint would be asking them to restate something already in hand.
 *
 * ## What it deliberately does NOT reach
 *
 * A field whose own base text is absent inherits the CITED ATTRIBUTE's text
 * (`attribute_labels`). That table is the localization family's one exemption —
 * it carries no `status` and no `provenance` — so there is no staleness there
 * to propagate, and inventing one from `attribute_definition_version` moving
 * would stale a translation on the strength of a bound that changed. The
 * boundary is stated rather than silently crossed.
 */

import { inArray, type InferSelectModel } from 'drizzle-orm';
import type { LocalizationCopyForwardResult, LocalizationStatus } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { productTypeFieldLocalizations } from '../schema/catalogLocalization.js';
import { productTypeFields } from '../schema/productTypes.js';

/** One row of `product_type_field_localizations`. */
export type ProductTypeFieldLocalizationRow = InferSelectModel<typeof productTypeFieldLocalizations>;

/**
 * The four base columns a translation of this grain describes, paired with the
 * localization column that translates each.
 *
 * A `Record` over the base columns rather than two parallel lists: a column
 * added to one and forgotten in the other is how a copy forward starts carrying
 * a translation of text nobody compared.
 */
const TRANSLATED_BASE_COLUMNS = {
  label: 'label',
  helpText: 'helpText',
  placeholder: 'placeholder',
  example: 'example',
} as const;

type TranslatedBaseColumn = keyof typeof TRANSLATED_BASE_COLUMNS;

/** The base-locale columns of one field, as the identity match compares them. */
interface FieldIdentityRow {
  readonly id: string;
  readonly flow: string;
  readonly scope: string;
  readonly attributeKey: string;
  readonly label: string | null;
  readonly helpText: string | null;
  readonly placeholder: string | null;
  readonly example: string | null;
}

/**
 * The identity of one field ACROSS versions.
 *
 * Exported so the gate that pins it against `diff.ts`'s `fieldKey` compares two
 * real callers rather than two copies of a string in a test.
 */
export function productTypeFieldIdentity(field: {
  readonly flow: string;
  readonly scope: string;
  readonly attributeKey: string;
}): string {
  return `${field.flow}:${field.scope}:${field.attributeKey}`;
}

/**
 * Index one version's fields by the identity that survives a bump.
 *
 * A repeated identity is REFUSED rather than resolved by picking one. It means
 * one version asks the same question twice in one flow under two attribute
 * versions — representable, because `product_type_fields_flow_attribute_key` is
 * unique on the attribute DEFINITION id rather than on its key — and there is no
 * non-arbitrary answer to which of the two a translation belongs on. Choosing
 * either would move somebody's text onto a question they did not translate,
 * which is worse than a loud refusal and is the failure this whole copy forward
 * exists to prevent, one level down.
 */
function indexByIdentity(
  fields: readonly FieldIdentityRow[],
  versionId: string,
): Map<string, FieldIdentityRow> {
  const byIdentity = new Map<string, FieldIdentityRow>();
  for (const field of fields) {
    const identity = productTypeFieldIdentity(field);
    if (byIdentity.has(identity)) {
      throw new Error(
        `product_type_definitions ${versionId} declares "${identity}" twice, so a field ` +
          `localization copy forward has no unambiguous target. Two fields in one flow citing ` +
          `two versions of one attribute is the only shape that reaches this.`,
      );
    }
    byIdentity.set(identity, field);
  }
  return byIdentity;
}

/**
 * Which of the four translated columns stopped describing the new version.
 *
 * A NULL→text move counts, and that is the case a naive `both non-null and
 * different` test misses: absent means "use the cited attribute's own wording"
 * and present means "this product type asks it differently", so a field that
 * gained an override is asking a different question in the same box.
 */
function changedBaseColumns(
  previous: FieldIdentityRow,
  next: FieldIdentityRow,
): ReadonlySet<TranslatedBaseColumn> {
  const changed = new Set<TranslatedBaseColumn>();
  for (const column of Object.keys(TRANSLATED_BASE_COLUMNS) as TranslatedBaseColumn[]) {
    if (previous[column] !== next[column]) changed.add(column);
  }
  return changed;
}

/**
 * Whether one copied row's text still describes the new version's field.
 *
 * The granularity rule `staleAfterChange` states one grain up, applied here: a
 * row is stale when it HOLDS TEXT for a column whose base moved. A locale with
 * no placeholder is not made stale by the placeholder being rewritten, because
 * nothing it carries has stopped being true.
 *
 * A `missing` row is never staled. It holds nothing to be stale, and
 * `product_type_field_localizations_missing_text_check` ties `missing` to a NULL
 * `label` — so restating it would refuse the write rather than mislead anybody.
 */
function staleAfterFieldChange(
  row: ProductTypeFieldLocalizationRow,
  changed: ReadonlySet<TranslatedBaseColumn>,
): boolean {
  if (row.status === 'missing') return false;
  for (const column of changed) {
    if (row[column] !== null) return true;
  }
  return false;
}

/**
 * Carry a superseded version's per-field localizations onto its successor.
 *
 * `ON CONFLICT DO NOTHING`, for the reason the version grain uses it: by a
 * publish retry a translator may already have written the new version's
 * Spanish, and a copy forward that overwrote it would destroy fresh work with
 * older text. A field/locale the successor already has is left alone and
 * COUNTED.
 *
 * `deprecated` rows are NOT carried — a withdrawal was a decision about the old
 * wording, and the successor simply having no row reads correctly as "not
 * translated".
 *
 * Runs in the caller's transaction so it commits with the publish that caused
 * it. `product_type_field_localizations` is deliberately OUTSIDE
 * `mercaria_product_type_child_frozen`, so writing these rows for a version
 * that has just been published is exactly what that split permits.
 */
export async function copyForwardProductTypeFieldLocalizations(
  supersededVersionId: string,
  newVersionId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationCopyForwardResult> {
  const empty: LocalizationCopyForwardResult = { copied: 0, staleOnArrival: 0, skippedExisting: 0 };

  const fields = await db
    .select({
      id: productTypeFields.id,
      productTypeDefinitionId: productTypeFields.productTypeDefinitionId,
      flow: productTypeFields.flow,
      scope: productTypeFields.scope,
      attributeKey: productTypeFields.attributeKey,
      label: productTypeFields.label,
      helpText: productTypeFields.helpText,
      placeholder: productTypeFields.placeholder,
      example: productTypeFields.example,
    })
    .from(productTypeFields)
    .where(
      inArray(productTypeFields.productTypeDefinitionId, [supersededVersionId, newVersionId]),
    );

  const previous = indexByIdentity(
    fields.filter((field) => field.productTypeDefinitionId === supersededVersionId),
    supersededVersionId,
  );
  const next = indexByIdentity(
    fields.filter((field) => field.productTypeDefinitionId === newVersionId),
    newVersionId,
  );
  if (previous.size === 0 || next.size === 0) return empty;

  // Only fields that exist on BOTH sides. A field the new version dropped has
  // nowhere for its text to go, and one it added has no text to receive.
  const matched = new Map<string, { targetFieldId: string; changed: ReadonlySet<TranslatedBaseColumn> }>();
  for (const [identity, before] of previous) {
    const after = next.get(identity);
    if (after === undefined) continue;
    matched.set(before.id, {
      targetFieldId: after.id,
      changed: changedBaseColumns(before, after),
    });
  }
  if (matched.size === 0) return empty;

  const source = await db
    .select()
    .from(productTypeFieldLocalizations)
    .where(inArray(productTypeFieldLocalizations.productTypeFieldId, [...matched.keys()]));

  const carried = source.filter((row) => row.status !== 'deprecated');
  if (carried.length === 0) return empty;

  const values = carried.map((row) => {
    const target = matched.get(row.productTypeFieldId);
    const status: LocalizationStatus = staleAfterFieldChange(row, target.changed)
      ? 'stale'
      : row.status;
    return {
      productTypeFieldId: target.targetFieldId,
      locale: row.locale,
      status,
      provenance: row.provenance,
      label: row.label,
      helpText: row.helpText,
      placeholder: row.placeholder,
      example: row.example,
      sourceLocale: row.sourceLocale,
      sourceRevision: row.sourceRevision,
      // The reviewer travels with the text, so a reviewer picking the queue up
      // can see who settled the sentence they are being asked to re-read. The
      // one-way `_reviewed_audit_check` is what makes that representable beside
      // a `stale` status.
      reviewedByOxyUserId: row.reviewedByOxyUserId,
      reviewedAt: row.reviewedAt,
    };
  });

  const inserted = await db
    .insert(productTypeFieldLocalizations)
    .values(values)
    .onConflictDoNothing({
      target: [productTypeFieldLocalizations.productTypeFieldId, productTypeFieldLocalizations.locale],
    })
    .returning({ status: productTypeFieldLocalizations.status });

  // Counted off what was WRITTEN, never off what was planned: the missing half
  // of the returning set IS the "already had one" answer, and re-deriving it
  // from the input would report a copy that never happened.
  return {
    copied: inserted.length,
    staleOnArrival: inserted.filter((row) => row.status === 'stale').length,
    skippedExisting: values.length - inserted.length,
  };
}
