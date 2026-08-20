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
  /**
   * Never NULL, unlike the column (#771).
   *
   * The table permits NULL and no writer has ever produced one — see
   * {@link replaceDraftVariants}, which reconciles on this and writes no null
   * branch. Typing it `string | null` here made the guarantee look optional
   * to every caller and would have forced a branch with no producer.
   */
  readonly axisSignature: string;
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
 * Reconcile a draft's whole variant matrix (#771).
 *
 * ## Why this is not delete-then-reinsert any more
 *
 * It was, and it deleted EVERY variant row on any variants patch.
 * `catalog_authoring_draft_values.draft_variant_id` carries `ON DELETE cascade`,
 * so every variant-scope answer was destroyed and a
 * `catalog_proposal_references.draft_value_id` pointing at one cascaded away
 * with it — #729's defect on the variant side, and worse than the product-scope
 * case it mirrors: that one was at least scoped to the fields the client
 * re-sent, while this fired for every variant answer whether or not the patch
 * mentioned it.
 *
 * The cascade is NOT the bug and is left alone. A re-save is not an answer
 * going away.
 *
 * ## Identity is `axis_signature`, and the objection this replaces was real
 *
 * The previous docblock argued against exactly this: reconciling on
 * `axis_signature` "would need a rule for a row whose axes moved onto another
 * row's, and there is no such rule that is not arbitrary." That is true and it
 * is worth keeping rather than deleting, because whoever meets the swap case
 * later deserves the reasoning instead of finding an apparent oversight.
 *
 * What it missed is the denominator. It bites ONLY when an author swaps axis
 * sets between two rows — and under signature identity a row IS its axes
 * (ADR 0007 D6, enforced by `catalog_authoring_draft_variants_signature_key`),
 * so re-attaching each row's answers to the axis set they describe is
 * defensible. It does not bite re-saving, editing a price or editing a title at
 * all, and under the old behaviour every one of those destroyed every variant
 * answer. So delete-and-reinsert was worse in all cases in exchange for being
 * arbitrary in one.
 *
 * `axis_signature` is never NULL and no branch here pretends otherwise.
 * MEASURED while closing #771: one INSERT statement into this table has ever
 * existed (`c712613d`), its one production caller passes `signatureFor(...)`,
 * and that function returns `string` at all five commits that ever touched the
 * column — zero axes yields `defaultTypedVariantSignature()` and a failure
 * throws. The column is nullable, which is a statement about the table and not
 * about the writer.
 *
 * ## The position two-step, and why parking must go UP
 *
 * `catalog_authoring_draft_variants_position_key` is a plain
 * `CREATE UNIQUE INDEX` (`0098:143`), and Postgres can only defer a
 * CONSTRAINT — never an INDEX. So an in-place reorder collides mid-update: a
 * 0↔1 swap writes a position another row still holds.
 *
 * Survivors are therefore parked ABOVE every current and target position and
 * settled afterwards. Not below: `catalog_authoring_draft_variants_position_check`
 * is `position >= 0` (`0098:67`), so the natural reading of "park out of range"
 * is refused by the server. The offset is computed rather than a constant,
 * because `position` is a 32-bit integer and a constant is a ceiling somebody
 * eventually reaches.
 *
 * A surviving row's SIGNATURE never moves — it is the match key — so only
 * `position` needs this. Deletes still run before inserts, or a fresh row could
 * collide with a stale row still holding its signature.
 *
 * Returns one row per input variant, IN INPUT ORDER: `patchDraft` pairs the
 * result with `axesByPosition` by index.
 */
export async function replaceDraftVariants(
  db: DatabaseOrTransaction,
  draftId: string,
  variants: readonly NewDraftVariant[],
): Promise<CatalogAuthoringDraftVariantRow[]> {
  if (variants.length === 0) {
    await db
      .delete(catalogAuthoringDraftVariants)
      .where(eq(catalogAuthoringDraftVariants.draftId, draftId));
    return [];
  }

  // Two incoming variants carrying ONE axis set are refused, before any
  // statement runs. This is the #770 guard one level up, and it is the same
  // regression in the same shape: delete-and-insert was accidentally safe here
  // because `catalog_authoring_draft_variants_signature_key` refused the second
  // INSERT with a 23505. A reconcile has no such accident — both would resolve
  // to one existing row and update it twice, keeping whichever arrived last, so
  // a malformed matrix would be silently accepted. It is reachable over HTTP:
  // two variants whose axis answers are identical produce identical signatures.
  //
  // Duplicate POSITIONS are deliberately NOT guarded. They still raise a 23505
  // exactly as before, so nothing regresses, and the only caller derives
  // position from an array index — a guard would have no producer.
  const incoming = new Set<string>();
  for (const variant of variants) {
    if (incoming.has(variant.axisSignature)) {
      throw new Error(
        `This patch sends two variants with the same axis set (signature ${variant.axisSignature}). Two variants that vary along nothing are one variant.`,
      );
    }
    incoming.add(variant.axisSignature);
  }

  const existing = await db
    .select({
      id: catalogAuthoringDraftVariants.id,
      position: catalogAuthoringDraftVariants.position,
      axisSignature: catalogAuthoringDraftVariants.axisSignature,
    })
    .from(catalogAuthoringDraftVariants)
    .where(eq(catalogAuthoringDraftVariants.draftId, draftId));

  const bySignature = new Map<string, { id: string; position: number }>();
  for (const row of existing) {
    if (row.axisSignature === null) continue;
    bySignature.set(row.axisSignature, { id: row.id, position: row.position });
  }

  const survivors: { id: string; index: number }[] = [];
  const freshByIndex = new Map<number, NewDraftVariant>();
  const matched = new Set<string>();
  variants.forEach((variant, index) => {
    const hit = bySignature.get(variant.axisSignature);
    if (hit === undefined) {
      freshByIndex.set(index, variant);
      return;
    }
    matched.add(variant.axisSignature);
    survivors.push({ id: hit.id, index });
  });

  // Above every position either side holds, so no parked value can collide with
  // a parked, a surviving or a still-present stale row.
  const offset =
    Math.max(
      0,
      ...existing.map((row) => row.position),
      ...variants.map((variant) => variant.position),
    ) + 1;

  if (survivors.length > 0) {
    await db
      .update(catalogAuthoringDraftVariants)
      .set({ position: sql`${catalogAuthoringDraftVariants.position} + ${offset}` })
      .where(
        inArray(
          catalogAuthoringDraftVariants.id,
          survivors.map((survivor) => survivor.id),
        ),
      );
  }

  // Only what genuinely went away. The answers cascading from these are answers
  // whose variant no longer exists, which is the cascade doing its job.
  const stale = existing
    .filter((row) => row.axisSignature === null || !matched.has(row.axisSignature))
    .map((row) => row.id);
  if (stale.length > 0) {
    await db
      .delete(catalogAuthoringDraftVariants)
      .where(inArray(catalogAuthoringDraftVariants.id, stale));
  }

  const rowByIndex = new Map<number, CatalogAuthoringDraftVariantRow>();

  // Settling each survivor to its FINAL position is safe here: every survivor
  // is parked above the offset, the stale rows are gone, and nothing fresh is
  // inserted yet — so the whole low range is free.
  for (const survivor of survivors) {
    const variant = variants[survivor.index];
    const [row] = await db
      .update(catalogAuthoringDraftVariants)
      .set({ ...variant })
      .where(eq(catalogAuthoringDraftVariants.id, survivor.id))
      .returning();
    rowByIndex.set(survivor.index, row);
  }

  if (freshByIndex.size > 0) {
    const indices = [...freshByIndex.keys()];
    const inserted = await db
      .insert(catalogAuthoringDraftVariants)
      .values(indices.map((index) => ({ draftId, ...(freshByIndex.get(index) as NewDraftVariant) })))
      .returning();
    indices.forEach((index, at) => rowByIndex.set(index, inserted[at]));
  }

  return variants.map((_, index) => rowByIndex.get(index) as CatalogAuthoringDraftVariantRow);
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
/**
 * The identity of a draft value, as the SCHEMA declares it (#729).
 *
 * `catalog_authoring_draft_values` says it in its own words — "ONE answer per
 * (draft, variant, field, component, ordinal)" — and enforces it with four
 * partial unique indexes over exactly those tuples. The `id` is a SURROGATE for
 * a row whose identity is declared elsewhere, and a surrogate for a row with a
 * stable natural key must itself be stable.
 *
 * `JSON.stringify` of the tuple rather than a joined string, because
 * `componentAxis` is nullable and a `??  ''` join makes a null axis collide with
 * an axis literally named the empty string. Nothing names one today; the point
 * is that the key does not depend on that staying true.
 */
function draftValueIdentity(value: {
  readonly fieldId: string;
  readonly componentAxis: string | null;
  readonly ordinal: number;
}): string {
  return JSON.stringify([value.fieldId, value.componentAxis, value.ordinal]);
}

/**
 * Every column an UPDATE must set, so a row changing KIND cannot keep the old
 * kind's value column populated.
 *
 * `catalog_authoring_draft_values_exactly_one_value_check` counts non-nulls
 * across all five value columns, so an update that set only the new column
 * would leave two populated and be refused by the server. Listing them all —
 * including the nulls — is what makes a text answer becoming a number answer a
 * legal write.
 */
function draftValueColumns(value: NewDraftValue) {
  return {
    attributeDefinitionId: value.attributeDefinitionId,
    attributeKey: value.attributeKey,
    attributeDefinitionVersion: value.attributeDefinitionVersion,
    scope: value.scope,
    kind: value.kind,
    valueText: value.valueText,
    valueNumber: value.valueNumber,
    valueBoolean: value.valueBoolean,
    valueEnumValueId: value.valueEnumValueId,
    canonicalRefKind: value.canonicalRefKind,
    canonicalRefId: value.canonicalRefId,
    unit: value.unit,
  };
}

/**
 * Reconcile the PRODUCT-scope answers for a set of fields (#729).
 *
 * ## Why this is not delete-then-reinsert any more
 *
 * It was, and an autosave that merely re-sent an unchanged field therefore
 * destroyed the row and minted a new id for the SAME answer. `catalog_proposal_
 * references.draft_value_id` cascades from that row, so the proposal's whole
 * reference vanished — and `listOpenProposalsBlockingDraft` filters on the
 * reference's `draft_id`, so the publication gate stopped blocking. A draft
 * whose missing concept was still unreviewed became publishable, through the
 * most routine action the wizard performs.
 *
 * The cascade is NOT the bug and is deliberately left alone: when an answer
 * genuinely goes away, the proposal about it is moot and its reference should go
 * with it. What was wrong is that a re-save is not an answer going away.
 *
 * ## Why a diff and not `ON CONFLICT`
 *
 * The four uniques are PARTIAL. Postgres will not infer an arbiter from a
 * partial index unless the statement repeats its predicate, so an upsert here
 * would need four conditional arbiters selected by whether `component_axis` is
 * null and whether the scope is variant — the shape that made `ensureCart` 500.
 * A read-then-diff keyed on the tuple has one spelling and needs no arbiter.
 */
export async function replaceProductScopeValues(
  db: DatabaseOrTransaction,
  draftId: string,
  fieldIds: readonly string[],
  values: readonly NewDraftValue[],
): Promise<void> {
  if (fieldIds.length === 0) {
    if (values.length > 0) {
      await db
        .insert(catalogAuthoringDraftValues)
        .values(values.map((value) => ({ draftId, ...value })));
    }
    return;
  }

  const existing = await db
    .select({
      id: catalogAuthoringDraftValues.id,
      fieldId: catalogAuthoringDraftValues.fieldId,
      componentAxis: catalogAuthoringDraftValues.componentAxis,
      ordinal: catalogAuthoringDraftValues.ordinal,
    })
    .from(catalogAuthoringDraftValues)
    .where(
      and(
        eq(catalogAuthoringDraftValues.draftId, draftId),
        isNull(catalogAuthoringDraftValues.draftVariantId),
        inArray(catalogAuthoringDraftValues.fieldId, [...fieldIds]),
      ),
    );

  // Two incoming answers for ONE slot are refused, before any statement runs.
  //
  // The delete-and-insert this replaced was accidentally safe here: it inserted
  // both rows, and `catalog_authoring_draft_values_product_key` refused the
  // second with a 23505. A reconcile has no such accident — it would update one
  // row twice and keep whichever answer came last, so a malformed payload would
  // be silently accepted and nothing afterwards could say which of the two the
  // author meant. `mapProductScopeValues` restarts `ordinal` at 0 per entry and
  // the request schema does not dedupe `attributeKey`, so this is reachable
  // over HTTP by sending one field twice.
  //
  // Up front rather than inside the loop: the refusal is about the REQUEST, and
  // discovering it halfway through leaves the reason to a rollback to undo.
  const incoming = new Set<string>();
  for (const value of values) {
    const identity = draftValueIdentity(value);
    if (incoming.has(identity)) {
      throw new Error(
        `This patch answers the same slot twice (field ${value.fieldId}, component ${value.componentAxis ?? 'none'}, ordinal ${value.ordinal}). Send one entry per field carrying all of its values.`,
      );
    }
    incoming.add(identity);
  }

  const byIdentity = new Map(existing.map((row) => [draftValueIdentity(row), row.id]));
  const seen = new Set<string>();
  const fresh: NewDraftValue[] = [];

  for (const value of values) {
    const identity = draftValueIdentity(value);
    const id = byIdentity.get(identity);
    if (id === undefined) {
      fresh.push(value);
      continue;
    }
    seen.add(identity);
    // The SAME answer, kept at the SAME id — which is the whole point.
    await db
      .update(catalogAuthoringDraftValues)
      .set(draftValueColumns(value))
      .where(eq(catalogAuthoringDraftValues.id, id));
  }

  // Only what genuinely went away. A reference cascading from one of these is
  // correct: the answer it was about no longer exists.
  const stale = existing.filter((row) => !seen.has(draftValueIdentity(row))).map((row) => row.id);
  if (stale.length > 0) {
    await db
      .delete(catalogAuthoringDraftValues)
      .where(inArray(catalogAuthoringDraftValues.id, stale));
  }

  if (fresh.length > 0) {
    await db.insert(catalogAuthoringDraftValues).values(fresh.map((value) => ({ draftId, ...value })));
  }
}

/**
 * The natural key of a VARIANT-scope answer.
 *
 * The variant id is IN the key rather than around it, because the four partial
 * uniques key variant answers on `draft_variant_id` and not on `draft_id` —
 * `catalog_authoring_draft_values_variant_key` and its component sibling. One
 * flat map over the whole patch therefore matches what the server enforces.
 *
 * `JSON.stringify` rather than a join, for {@link draftValueIdentity}'s reason:
 * `component_axis` is nullable, and a `?? ''` join would collide a null axis
 * with an axis literally named `''`.
 */
function draftVariantValueIdentity(value: {
  readonly draftVariantId: string | null;
  readonly fieldId: string;
  readonly componentAxis: string | null;
  readonly ordinal: number;
}): string {
  return JSON.stringify([
    value.draftVariantId,
    value.fieldId,
    value.componentAxis,
    value.ordinal,
  ]);
}

/**
 * Reconcile the VARIANT-scope answers of a draft (#771).
 *
 * ## Why this had to change with {@link replaceDraftVariants}
 *
 * It was `insertVariantScopeValues`, and it documented its own dependence on
 * the delete: "{@link replaceDraftVariants} has already removed the previous
 * rows by cascade". That is exactly the cascade #771 removes. Left as a blind
 * insert, every surviving variant would keep its old answers AND receive fresh
 * ones, which the four partial uniques refuse with a 23505. The variant
 * reconcile and the variant-VALUE reconcile are one change or neither.
 *
 * Scoped to the variants the patch actually carries. An answer belonging to a
 * variant that went away is already gone by cascade, so widening this to the
 * whole draft would be a second statement asserting something the foreign key
 * has already done.
 */
export async function replaceVariantScopeValues(
  db: DatabaseOrTransaction,
  draftId: string,
  variantIds: readonly string[],
  values: readonly NewDraftValue[],
): Promise<void> {
  if (variantIds.length === 0) {
    if (values.length > 0) {
      await db
        .insert(catalogAuthoringDraftValues)
        .values(values.map((value) => ({ draftId, ...value })));
    }
    return;
  }

  // The #770 guard, in this scope. Delete-and-insert was accidentally safe
  // against a patch answering one variant slot twice, because the partial
  // unique refused the second INSERT; a reconcile would update one row twice
  // and keep the last answer instead. Up front, so a refusal is about the
  // REQUEST rather than something a rollback has to undo halfway through.
  const incoming = new Set<string>();
  for (const value of values) {
    const identity = draftVariantValueIdentity(value);
    if (incoming.has(identity)) {
      throw new Error(
        `This patch answers the same variant slot twice (variant ${value.draftVariantId ?? 'none'}, field ${value.fieldId}, component ${value.componentAxis ?? 'none'}, ordinal ${value.ordinal}). Send one entry per field carrying all of its values.`,
      );
    }
    incoming.add(identity);
  }

  const existing = await db
    .select({
      id: catalogAuthoringDraftValues.id,
      draftVariantId: catalogAuthoringDraftValues.draftVariantId,
      fieldId: catalogAuthoringDraftValues.fieldId,
      componentAxis: catalogAuthoringDraftValues.componentAxis,
      ordinal: catalogAuthoringDraftValues.ordinal,
    })
    .from(catalogAuthoringDraftValues)
    .where(
      and(
        eq(catalogAuthoringDraftValues.draftId, draftId),
        inArray(catalogAuthoringDraftValues.draftVariantId, [...variantIds]),
      ),
    );

  const byIdentity = new Map(existing.map((row) => [draftVariantValueIdentity(row), row.id]));
  const seen = new Set<string>();
  const fresh: NewDraftValue[] = [];

  for (const value of values) {
    const identity = draftVariantValueIdentity(value);
    const id = byIdentity.get(identity);
    if (id === undefined) {
      fresh.push(value);
      continue;
    }
    seen.add(identity);
    // The SAME answer, kept at the SAME id — which is the whole point.
    await db
      .update(catalogAuthoringDraftValues)
      .set(draftValueColumns(value))
      .where(eq(catalogAuthoringDraftValues.id, id));
  }

  const stale = existing
    .filter((row) => !seen.has(draftVariantValueIdentity(row)))
    .map((row) => row.id);
  if (stale.length > 0) {
    await db
      .delete(catalogAuthoringDraftValues)
      .where(inArray(catalogAuthoringDraftValues.id, stale));
  }

  if (fresh.length > 0) {
    await db
      .insert(catalogAuthoringDraftValues)
      .values(fresh.map((value) => ({ draftId, ...value })));
  }
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
