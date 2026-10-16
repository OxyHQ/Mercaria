/**
 * What a blocked or deleted Oxy file does to the rows that hold it (ADR 0043
 * D9/D10) — one function per holding shape, each run inside the file event's
 * transaction and each returning the ids of the ENTITIES it changed (the same
 * entity ids the reference registry uses), so the event can audit them.
 *
 * Only presentation is touched. A gallery image, an artwork column or an
 * `<img>` is removed; a canonical image or a condition photo, whose row is
 * evidence of something, keeps its row in a state that no longer shows the file.
 * Evidence, order snapshots and private deliverables are not here at all: they
 * are history, and the registry records them as `retained`.
 *
 * Category art and canonical images are written by their owning repositories
 * (`taxonomyRepository.clearCategoryImagesByFile`,
 * `attributeRepository.suppressCanonicalImagesByFile`), whose write censuses
 * name them; the registry calls those directly.
 *
 * Every write here also fires the reference triggers of migration `0170`, so the
 * references Oxy holds for the removed usage are withdrawn by the same outbox
 * that registered them.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { listingImages } from '../schema/catalog.js';
import { catalogAuthoringDrafts } from '../schema/catalogAuthoring.js';
import { listingConditionPhotos } from '../schema/condition.js';
import { collections } from '../schema/merchandising.js';
import { brands } from '../schema/organizations.js';
import { reviewMedia } from '../schema/reviews.js';
import { sellerDraftImages } from '../schema/sellYours.js';
import { stores } from '../schema/stores.js';

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Remove a file from every gallery that shows it. Variant assignments cascade. */
export async function removeListingImagesByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<string[]> {
  const rows = await tx
    .delete(listingImages)
    .where(eq(listingImages.fileId, fileId))
    .returning({ listingId: listingImages.listingId });
  return unique(rows.map((row) => row.listingId));
}

/**
 * A condition photo is the seller's EVIDENCE of a condition claim, so its row
 * stays; it leaves the evidential states (`EVIDENTIAL_CONDITION_PHOTO_STATES`),
 * which is what makes a listing whose condition needed it stop meeting its own
 * requirement rather than keep a stale pass.
 */
export async function suppressConditionPhotosByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
  state: 'rejected' | 'withdrawn',
): Promise<string[]> {
  const rows = await tx
    .update(listingConditionPhotos)
    .set({ moderationState: state, moderatedAt: new Date() })
    .where(
      and(
        eq(listingConditionPhotos.fileId, fileId),
        inArray(listingConditionPhotos.moderationState, ['pending', 'approved']),
      ),
    )
    .returning({ id: listingConditionPhotos.id });
  return unique(rows.map((row) => row.id));
}

export async function clearStoreArtworkByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
  target: 'logo' | 'cover',
): Promise<string[]> {
  const column = target === 'logo' ? stores.logoFileId : stores.coverFileId;
  const rows = await tx
    .update(stores)
    .set(target === 'logo' ? { logoFileId: null } : { coverFileId: null })
    .where(eq(column, fileId))
    .returning({ id: stores.id });
  return unique(rows.map((row) => row.id));
}

export async function clearCollectionImagesByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<string[]> {
  const rows = await tx
    .update(collections)
    .set({ imageFileId: null })
    .where(eq(collections.imageFileId, fileId))
    .returning({ id: collections.id });
  return unique(rows.map((row) => row.id));
}

export async function removeSellerDraftImagesByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<string[]> {
  const rows = await tx
    .delete(sellerDraftImages)
    .where(eq(sellerDraftImages.fileId, fileId))
    .returning({ draftId: sellerDraftImages.draftId });
  return unique(rows.map((row) => row.draftId));
}

/**
 * Only an OPEN draft loses the image. A published draft is the record of what a
 * product was authored from, and a discarded one shows nothing to anybody.
 * `version` moves, so an author's stale editor cannot write the image back.
 */
export async function removeAuthoringDraftImagesByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<string[]> {
  const rows = await tx
    .update(catalogAuthoringDrafts)
    .set({
      imageFileIds: sql`array_remove(${catalogAuthoringDrafts.imageFileIds}, ${fileId})`,
      version: sql`${catalogAuthoringDrafts.version} + 1`,
    })
    .where(
      and(
        eq(catalogAuthoringDrafts.status, 'open'),
        sql`${fileId} = any(${catalogAuthoringDrafts.imageFileIds})`,
      ),
    )
    .returning({ id: catalogAuthoringDrafts.id });
  return unique(rows.map((row) => row.id));
}

export async function clearBrandLogosByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<string[]> {
  const rows = await tx
    .update(brands)
    .set({ logoFileId: null })
    .where(eq(brands.logoFileId, fileId))
    .returning({ id: brands.id });
  return unique(rows.map((row) => row.id));
}

export async function removeReviewMediaByFile(
  tx: DatabaseOrTransaction,
  fileId: string,
): Promise<string[]> {
  const rows = await tx
    .delete(reviewMedia)
    .where(eq(reviewMedia.fileId, fileId))
    .returning({ reviewId: reviewMedia.reviewId });
  return unique(rows.map((row) => row.reviewId));
}

/**
 * Rewrite an HTML column of every row that may show the file. `rewrite` answers
 * the new HTML, or `undefined` when the row does not actually show it (the
 * `strpos` pre-filter is a superset). Locked, so a concurrent edit is not lost.
 */
export async function rewriteHtmlColumnsByFile(
  tx: DatabaseOrTransaction,
  input: {
    table: string;
    entityColumn: string;
    columns: readonly string[];
    fileId: string;
    rewrite: (html: string) => string | undefined;
  },
): Promise<string[]> {
  const table = sql.identifier(input.table);
  const changed: string[] = [];
  for (const name of input.columns) {
    const column = sql.identifier(name);
    const rows = await tx.execute<{ id: string; entity_id: string; html: string }>(sql`
      select id, ${sql.identifier(input.entityColumn)}::text as entity_id, ${column} as html
      from ${table}
      where strpos(${column}, ${input.fileId}) > 0
      for update`);
    for (const row of rows) {
      const next = input.rewrite(row.html);
      if (next === undefined) continue;
      await tx.execute(sql`update ${table} set ${column} = ${next} where id = ${row.id}`);
      changed.push(String(row.entity_id));
    }
  }
  return unique(changed);
}
