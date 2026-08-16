/**
 * Draft rows — the header, its variants and its typed answers (#367 step 5,
 * ADR 0007 D10).
 *
 * Every mutating function here takes a `DatabaseOrTransaction` and defaults to
 * none of them: publication is ONE transaction, so a repository that opened its
 * own would silently commit half of it. `insertDraft` is the single exception
 * and it is not one — it takes the handle too.
 *
 * ## The compare-and-swap is the concurrency model, and it is ONE statement
 *
 * `updateDraftIfVersion` is a conditional UPDATE whose predicate carries the
 * store, the id, the status and the version, and which bumps the version in the
 * same statement. A read-then-write would let two tabs both see version 4 and
 * both write 5, and the loser's answers would silently replace the winner's —
 * the failure `CONVENTIONS.md` names for the order status machine, in a domain
 * where the losing tab is a person who typed for twenty minutes.
 *
 * The empty result set IS the refusal. Nothing here throws on a lost CAS; the
 * service turns `null` into a 409 that names the version the caller should
 * re-read.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthoringDraftStatus, AuthoringSchema } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  catalogAuthoringDraftValues,
  catalogAuthoringDraftVariants,
  catalogAuthoringDrafts,
} from '../schema/catalogAuthoring.js';

export type CatalogAuthoringDraftRow = typeof catalogAuthoringDrafts.$inferSelect;
export type CatalogAuthoringDraftVariantRow = typeof catalogAuthoringDraftVariants.$inferSelect;
export type CatalogAuthoringDraftValueRow = typeof catalogAuthoringDraftValues.$inferSelect;

/** Everything a new draft states. Nothing is defaulted that a caller could mean. */
export interface NewCatalogAuthoringDraft {
  readonly storeId: string;
  readonly createdByOxyUserId: string;
  readonly categoryId: string;
  readonly productTypeDefinitionId: string;
  readonly flow: CatalogAuthoringDraftRow['flow'];
  readonly locale: string;
  readonly market: string;
  readonly schemaHash: string;
  readonly schemaSnapshot: AuthoringSchema;
  readonly expiresAt: Date;
  readonly title?: string | null;
  readonly description?: string | null;
}

export async function insertDraft(
  db: DatabaseOrTransaction,
  values: NewCatalogAuthoringDraft,
): Promise<CatalogAuthoringDraftRow> {
  const rows = await db
    .insert(catalogAuthoringDrafts)
    .values({
      storeId: values.storeId,
      createdByOxyUserId: values.createdByOxyUserId,
      status: 'open',
      categoryId: values.categoryId,
      productTypeDefinitionId: values.productTypeDefinitionId,
      flow: values.flow,
      locale: values.locale,
      market: values.market,
      schemaHash: values.schemaHash,
      schemaSnapshot: values.schemaSnapshot,
      version: 1,
      title: values.title ?? null,
      description: values.description ?? null,
      expiresAt: values.expiresAt,
    })
    .returning();
  // A single-row insert either produced a row or raised. Reading `[0]` without
  // asserting it is the shape every repository here uses; the non-null assertion
  // this codebase forbids would be the alternative.
  const [row] = rows;
  if (row === undefined) {
    throw new Error('insertDraft: the insert returned no row');
  }
  return row;
}

/** One draft, scoped to the store that owns it — never by id alone. */
export async function findDraft(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .select()
    .from(catalogAuthoringDrafts)
    .where(
      and(eq(catalogAuthoringDrafts.id, draftId), eq(catalogAuthoringDrafts.storeId, storeId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One draft, locked for the duration of a publication.
 *
 * `FOR UPDATE` rather than a CAS, because a publish reads the draft, composes a
 * schema, validates, writes a listing and only then stamps the draft — and a
 * second publish arriving mid-way must WAIT rather than lose a comparison it
 * made against a state that has since changed. The idempotency unique converges
 * the retry that arrives afterwards; the lock is what stops the two overlapping.
 */
export async function lockDraftForPublish(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .select()
    .from(catalogAuthoringDrafts)
    .where(
      and(eq(catalogAuthoringDrafts.id, draftId), eq(catalogAuthoringDrafts.storeId, storeId)),
    )
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/** A store's drafts, newest activity first. */
export async function listDrafts(
  db: DatabaseOrTransaction,
  storeId: string,
  options: { status?: AuthoringDraftStatus; limit: number; offset: number },
): Promise<CatalogAuthoringDraftRow[]> {
  return db
    .select()
    .from(catalogAuthoringDrafts)
    .where(
      options.status === undefined
        ? eq(catalogAuthoringDrafts.storeId, storeId)
        : and(
            eq(catalogAuthoringDrafts.storeId, storeId),
            eq(catalogAuthoringDrafts.status, options.status),
          ),
    )
    .orderBy(desc(catalogAuthoringDrafts.updatedAt))
    .limit(options.limit)
    .offset(options.offset);
}

/** The columns a PATCH may move. Deliberately no status and no schema pin. */
export interface DraftPatch {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageFileIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly selectedCanonicalProductId?: string | null;
}

/**
 * Apply a patch if the caller's `version` still holds, bumping it.
 *
 * The predicate ALSO requires `status = 'open'`, so an edit arriving after a
 * publish is refused by the same mechanism as a stale one rather than by a
 * separate check somebody could forget. A published draft is the audit record of
 * what was published and nothing may edit it.
 */
export async function updateDraftIfVersion(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
  expectedVersion: number,
  patch: DraftPatch,
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .update(catalogAuthoringDrafts)
    .set({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.imageFileIds === undefined ? {} : { imageFileIds: [...patch.imageFileIds] }),
      ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
      ...(patch.selectedCanonicalProductId === undefined
        ? {}
        : { selectedCanonicalProductId: patch.selectedCanonicalProductId }),
      version: sql`${catalogAuthoringDrafts.version} + 1`,
    })
    .where(
      and(
        eq(catalogAuthoringDrafts.id, draftId),
        eq(catalogAuthoringDrafts.storeId, storeId),
        eq(catalogAuthoringDrafts.status, 'open'),
        eq(catalogAuthoringDrafts.version, expectedVersion),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Re-pin a draft to a newer product-type version, after an operator's explicit
 * upgrade.
 *
 * Its own function rather than a member of {@link DraftPatch}, because ADR 0007
 * D10 makes the upgrade a deliberate act: putting the pin in the ordinary patch
 * shape would let an autosave carry one, which is the silent rewrite the preview
 * exists to prevent.
 */
export async function repinDraftIfVersion(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
  expectedVersion: number,
  pin: { productTypeDefinitionId: string; schemaHash: string; schemaSnapshot: AuthoringSchema },
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .update(catalogAuthoringDrafts)
    .set({
      productTypeDefinitionId: pin.productTypeDefinitionId,
      schemaHash: pin.schemaHash,
      schemaSnapshot: pin.schemaSnapshot,
      version: sql`${catalogAuthoringDrafts.version} + 1`,
    })
    .where(
      and(
        eq(catalogAuthoringDrafts.id, draftId),
        eq(catalogAuthoringDrafts.storeId, storeId),
        eq(catalogAuthoringDrafts.status, 'open'),
        eq(catalogAuthoringDrafts.version, expectedVersion),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Stamp a draft `published`.
 *
 * One statement, predicated on `open`, so a second publish in the same
 * transaction window loses the CAS rather than double-stamping. `expires_at` is
 * cleared in the same `set`, which is what the biconditional CHECK requires and
 * what takes the row out of the expiry sweep's population — the two are one edit
 * precisely so they cannot be done separately.
 */
export async function markDraftPublished(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
  outcome: { listingId: string; idempotencyKey: string | null; now: Date },
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .update(catalogAuthoringDrafts)
    .set({
      status: 'published',
      publishedListingId: outcome.listingId,
      publishedAt: outcome.now,
      publishIdempotencyKey: outcome.idempotencyKey,
      expiresAt: null,
      version: sql`${catalogAuthoringDrafts.version} + 1`,
    })
    .where(
      and(
        eq(catalogAuthoringDrafts.id, draftId),
        eq(catalogAuthoringDrafts.storeId, storeId),
        eq(catalogAuthoringDrafts.status, 'open'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Discard an open draft. Its rows stay until the expiry sweep takes them. */
export async function discardDraft(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
  expectedVersion: number,
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .update(catalogAuthoringDrafts)
    .set({ status: 'discarded', version: sql`${catalogAuthoringDrafts.version} + 1` })
    .where(
      and(
        eq(catalogAuthoringDrafts.id, draftId),
        eq(catalogAuthoringDrafts.storeId, storeId),
        eq(catalogAuthoringDrafts.status, 'open'),
        eq(catalogAuthoringDrafts.version, expectedVersion),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * The draft this idempotency key already published, if any.
 *
 * Read on the converge path BEFORE anything is composed, so a retry costs one
 * indexed statement rather than a whole re-validation — and answers with the
 * SAME listing rather than a second one.
 */
export async function findDraftByPublishIdempotencyKey(
  db: DatabaseOrTransaction,
  storeId: string,
  idempotencyKey: string,
): Promise<CatalogAuthoringDraftRow | null> {
  const rows = await db
    .select()
    .from(catalogAuthoringDrafts)
    .where(
      and(
        eq(catalogAuthoringDrafts.storeId, storeId),
        eq(catalogAuthoringDrafts.publishIdempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Variants                                                                    */
/* -------------------------------------------------------------------------- */

export interface NewDraftVariant {
  readonly position: number;
  readonly title: string | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly priceAmount: number | null;
  readonly priceCurrency: CatalogAuthoringDraftVariantRow['priceCurrency'];
  readonly compareAtPriceAmount: number | null;
  readonly compareAtPriceCurrency: CatalogAuthoringDraftVariantRow['compareAtPriceCurrency'];
  readonly inventoryTracked: boolean;
  readonly inventoryAvailable: number;
  readonly axisSignature: string | null;
  readonly selectedCanonicalVariantId: string | null;
}

export async function listDraftVariants(
  db: DatabaseOrTransaction,
  draftId: string,
): Promise<CatalogAuthoringDraftVariantRow[]> {
  return db
    .select()
    .from(catalogAuthoringDraftVariants)
    .where(eq(catalogAuthoringDraftVariants.draftId, draftId))
    .orderBy(asc(catalogAuthoringDraftVariants.position));
}

/**
 * Replace a draft's whole variant matrix.
 *
 * DELETE then INSERT, never an upsert, and never a partial patch. A variant
 * matrix is submitted as a WHOLE because its axes are: reconciling a partial
 * update against `axis_signature` would need a rule for a row whose axes moved
 * onto another row's, and there is no such rule that is not arbitrary. The
 * values pointing at the old rows CASCADE with them, so the caller writes the
 * new ones afterwards in the same transaction.
 *
 * `catalog_authoring_draft_variants_position_key` makes the ordinal a real
 * constraint rather than a convention, which is what lets a validation path
 * refer to `variants[2]` and mean one row.
 */
export async function replaceDraftVariants(
  db: DatabaseOrTransaction,
  draftId: string,
  variants: readonly NewDraftVariant[],
): Promise<CatalogAuthoringDraftVariantRow[]> {
  await db
    .delete(catalogAuthoringDraftVariants)
    .where(eq(catalogAuthoringDraftVariants.draftId, draftId));
  if (variants.length === 0) return [];
  return db
    .insert(catalogAuthoringDraftVariants)
    .values(variants.map((variant) => ({ draftId, ...variant })))
    .returning();
}

/* -------------------------------------------------------------------------- */
/* Values                                                                      */
/* -------------------------------------------------------------------------- */

export interface NewDraftValue {
  readonly draftVariantId: string | null;
  readonly fieldId: string;
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  readonly attributeDefinitionVersion: number;
  readonly scope: CatalogAuthoringDraftValueRow['scope'];
  readonly ordinal: number;
  readonly componentAxis: CatalogAuthoringDraftValueRow['componentAxis'];
  readonly kind: CatalogAuthoringDraftValueRow['kind'];
  readonly valueText: string | null;
  readonly valueNumber: number | null;
  readonly valueBoolean: boolean | null;
  readonly valueEnumValueId: string | null;
  readonly canonicalRefKind: CatalogAuthoringDraftValueRow['canonicalRefKind'];
  readonly canonicalRefId: string | null;
  readonly unit: string | null;
}

export async function listDraftValues(
  db: DatabaseOrTransaction,
  draftId: string,
): Promise<CatalogAuthoringDraftValueRow[]> {
  return db
    .select()
    .from(catalogAuthoringDraftValues)
    .where(eq(catalogAuthoringDraftValues.draftId, draftId))
    .orderBy(
      asc(catalogAuthoringDraftValues.attributeKey),
      asc(catalogAuthoringDraftValues.ordinal),
    );
}

/**
 * Replace the PRODUCT-scope answers for a named set of fields.
 *
 * Scoped to the fields the caller actually sent, so an autosave of one section
 * cannot clear another's — the whole reason this is not a blanket
 * delete-and-insert over the draft. Sending a field with an empty value list is
 * how an author clears it, which is a different request from not mentioning it.
 */
export async function replaceProductScopeValues(
  db: DatabaseOrTransaction,
  draftId: string,
  fieldIds: readonly string[],
  values: readonly NewDraftValue[],
): Promise<void> {
  if (fieldIds.length > 0) {
    await db
      .delete(catalogAuthoringDraftValues)
      .where(
        and(
          eq(catalogAuthoringDraftValues.draftId, draftId),
          isNull(catalogAuthoringDraftValues.draftVariantId),
          inArray(catalogAuthoringDraftValues.fieldId, [...fieldIds]),
        ),
      );
  }
  if (values.length === 0) return;
  await db.insert(catalogAuthoringDraftValues).values(values.map((value) => ({ draftId, ...value })));
}

/**
 * Insert the VARIANT-scope answers for variants that were just created.
 *
 * No delete: {@link replaceDraftVariants} has already removed the previous rows
 * by cascade, so a delete here would be a second statement asserting something
 * already true — and one whose predicate could drift from the cascade's.
 */
export async function insertVariantScopeValues(
  db: DatabaseOrTransaction,
  draftId: string,
  values: readonly NewDraftValue[],
): Promise<void> {
  if (values.length === 0) return;
  await db.insert(catalogAuthoringDraftValues).values(values.map((value) => ({ draftId, ...value })));
}

/** Every value of several drafts at once — the list surface's one statement. */
export async function listDraftValuesForDrafts(
  db: DatabaseOrTransaction = getDb(),
  draftIds: readonly string[] = [],
): Promise<CatalogAuthoringDraftValueRow[]> {
  if (draftIds.length === 0) return [];
  return db
    .select()
    .from(catalogAuthoringDraftValues)
    .where(inArray(catalogAuthoringDraftValues.draftId, [...draftIds]));
}
