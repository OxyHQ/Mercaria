/**
 * `product_type_localizations` — the only writer of a product-type version's
 * localized text (ADR 0007 D4, and D5's freeze).
 *
 * ## Why a version bump needs a copy forward, and why it is not inheritance
 *
 * A published product-type version is immutable and a v2 is a NEW row, so its
 * localizations start empty. Left there, every version bump ships untranslated
 * in every market — and the fix somebody reaches for is "read the previous
 * version's text when this one has none", which is exactly the inheritance the
 * freeze exists to prevent. It would let a v2 that changed what a field asks
 * for present v1's help text describing the old question, and it would look
 * completely fine on the screen.
 *
 * {@link copyForwardProductTypeLocalizations} is the shape that gives both: the
 * rows are COPIED, so each version owns its own text and nothing is read
 * through a pointer at another version, and the ones whose text no longer
 * describes the version are marked `stale` — which already means "still the
 * best text available, needs review".
 *
 * The caller supplies WHAT CHANGED. This domain cannot compute it: a diff of
 * two product-type versions is D5's, and a copy forward that guessed would
 * either mark everything stale (making every bump a full re-translation, the
 * symptom) or nothing (the inheritance). `ProductTypeSemanticChange` has an
 * `unknown` member so "I cannot diff these" is sayable, and saying it means
 * everything is stale — the safe direction for a claim about somebody else's
 * text.
 */

import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import type {
  LocalizationCopyForwardResult,
  LocalizationProvenance,
  LocalizationStatus,
  ProductTypeSemanticChange,
  SupportedLocale,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { productTypeLocalizations } from '../schema/catalogLocalization.js';

/** One row of `product_type_localizations`. */
export type ProductTypeLocalizationRow = InferSelectModel<typeof productTypeLocalizations>;

/** Everything a caller may supply when writing one version's localized text. */
export interface ProductTypeLocalizationInput {
  readonly productTypeDefinitionId: string;
  /** Lowercase BCP 47, never the base locale — a CHECK refuses that row. */
  readonly locale: SupportedLocale;
  readonly status: LocalizationStatus;
  readonly provenance: LocalizationProvenance;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly helpText?: string | null;
  readonly sourceLocale?: SupportedLocale | null;
  readonly sourceRevision?: string | null;
  readonly reviewedByOxyUserId?: string | null;
  readonly reviewedAt?: Date | null;
}

/**
 * Read one or more versions' localizations, narrowed to a fallback chain.
 *
 * ONE statement, the `findCategoryLocalizations` shape. An empty id or locale
 * list returns `[]` without issuing SQL — `inArray(col, [])` renders a predicate
 * Postgres evaluates against every row of the table.
 */
export async function findProductTypeLocalizations(
  productTypeDefinitionIds: readonly string[],
  locales: readonly SupportedLocale[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductTypeLocalizationRow[]> {
  if (productTypeDefinitionIds.length === 0 || locales.length === 0) return [];
  return db
    .select()
    .from(productTypeLocalizations)
    .where(
      and(
        inArray(productTypeLocalizations.productTypeDefinitionId, [...productTypeDefinitionIds]),
        inArray(productTypeLocalizations.locale, [...locales]),
      ),
    );
}

/** Write one version's text in one locale, replacing whatever was there. */
export async function upsertProductTypeLocalization(
  input: ProductTypeLocalizationInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductTypeLocalizationRow> {
  const values = {
    productTypeDefinitionId: input.productTypeDefinitionId,
    locale: input.locale,
    status: input.status,
    provenance: input.provenance,
    name: input.name ?? null,
    description: input.description ?? null,
    helpText: input.helpText ?? null,
    sourceLocale: input.sourceLocale ?? null,
    sourceRevision: input.sourceRevision ?? null,
    reviewedByOxyUserId: input.reviewedByOxyUserId ?? null,
    reviewedAt: input.reviewedAt ?? null,
  };
  const [row] = await db
    .insert(productTypeLocalizations)
    .values(values)
    .onConflictDoUpdate({
      target: [
        productTypeLocalizations.productTypeDefinitionId,
        productTypeLocalizations.locale,
      ],
      set: {
        status: values.status,
        provenance: values.provenance,
        name: values.name,
        description: values.description,
        helpText: values.helpText,
        sourceLocale: values.sourceLocale,
        sourceRevision: values.sourceRevision,
        reviewedByOxyUserId: values.reviewedByOxyUserId,
        reviewedAt: values.reviewedAt,
      },
    })
    .returning();
  return row;
}

/**
 * Whether one copied row's text still describes the new version.
 *
 * A row carries all three localized fields, so a naive "any field changed ⇒
 * stale" collapses the whole distinction — every bump that touched any text
 * would stale every locale. What makes the granularity real is asking whether
 * the row carries TEXT for a field that changed: a locale with no help text is
 * not made stale by the help text being rewritten, because nothing it holds has
 * stopped being true.
 *
 * A `missing` row is never made stale. It holds nothing to be stale, and a
 * CHECK ties `missing` to the absence of a name — so restating it would refuse
 * the write rather than mislead anybody, which is a confusing way to learn about
 * a status nobody meant to set.
 */
function staleAfterChange(
  row: ProductTypeLocalizationRow,
  change: ProductTypeSemanticChange,
): boolean {
  if (row.status === 'missing') return false;
  if (change.kind === 'unknown') return true;
  for (const field of change.changedFields) {
    if (field === 'product_type.name' && row.name !== null) return true;
    if (field === 'product_type.description' && row.description !== null) return true;
    if (field === 'product_type.help_text' && row.helpText !== null) return true;
  }
  return false;
}

/**
 * Carry a superseded version's localizations onto its successor.
 *
 * `ON CONFLICT DO NOTHING`, deliberately, and it is the half that makes this
 * safe to call from a publish path that may be retried: by the second attempt a
 * translator may already have written the new version's Spanish, and a copy
 * forward that overwrote it would destroy fresh work with older text. A locale
 * the successor already has is left alone and COUNTED, so a caller can see it
 * happened.
 *
 * `deprecated` rows are NOT carried. A withdrawal was a decision about the old
 * version's text; resurrecting it against a new meaning would re-publish
 * something somebody removed, and the successor simply having no row for that
 * locale reads correctly as "not translated".
 *
 * Runs in the caller's transaction so it commits with the publish that caused
 * it — a version that exists with none of its predecessor's text, because the
 * copy forward failed after the commit, is the state this exists to prevent.
 */
export async function copyForwardProductTypeLocalizations(
  supersededVersionId: string,
  newVersionId: string,
  change: ProductTypeSemanticChange,
  db: DatabaseOrTransaction = getDb(),
): Promise<LocalizationCopyForwardResult> {
  const source = await db
    .select()
    .from(productTypeLocalizations)
    .where(eq(productTypeLocalizations.productTypeDefinitionId, supersededVersionId));

  const carried = source.filter((row) => row.status !== 'deprecated');
  if (carried.length === 0) return { copied: 0, staleOnArrival: 0, skippedExisting: 0 };

  const values = carried.map((row) => {
    const status: LocalizationStatus = staleAfterChange(row, change) ? 'stale' : row.status;
    return {
      productTypeDefinitionId: newVersionId,
      locale: row.locale,
      status,
      provenance: row.provenance,
      name: row.name,
      description: row.description,
      helpText: row.helpText,
      sourceLocale: row.sourceLocale,
      sourceRevision: row.sourceRevision,
      // The reviewer travels with the text. `stale` keeps its audit — which is
      // the whole reason `<table>_reviewed_audit_check` is one-way rather than a
      // biconditional — so a reviewer picking the queue up can see who settled
      // the sentence they are being asked to re-read.
      reviewedByOxyUserId: row.reviewedByOxyUserId,
      reviewedAt: row.reviewedAt,
    };
  });

  const inserted = await db
    .insert(productTypeLocalizations)
    .values(values)
    .onConflictDoNothing({
      target: [
        productTypeLocalizations.productTypeDefinitionId,
        productTypeLocalizations.locale,
      ],
    })
    .returning({ locale: productTypeLocalizations.locale, status: productTypeLocalizations.status });

  // Counted off what was WRITTEN rather than off what was planned: the empty
  // half of the returning set IS the "already had one" answer, and re-deriving
  // it from the input would report a copy that never happened.
  const staleOnArrival = inserted.filter((row) => row.status === 'stale').length;
  return {
    copied: inserted.length,
    staleOnArrival,
    skippedExisting: values.length - inserted.length,
  };
}
