/**
 * Maintenance reads and writes for media owned by the MERCARIA APPLICATION (Oxy
 * ADR 0041 D1): canonical images, category art and brand logos. Content no
 * account owns, which until ADR 0041 was imported under whichever operator made
 * the request — or not imported at all and kept as a supplier URL.
 *
 * The import runs outside any transaction; every apply is a compare-and-swap on
 * the value the preview read, so an edit made while the network was in flight
 * wins and the row is reported `changed` for an explicit retry.
 */

import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { replaceCanonicalImageFile } from '../canonical/attributeRepository.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { replaceCategoryImageFile } from '../taxonomy/taxonomyRepository.js';
import { categories } from '../schema/catalog.js';
import { canonicalImages } from '../schema/canonicalCatalog.js';
import { brands } from '../schema/organizations.js';

export type ApplicationMediaTarget = 'canonical_image' | 'category_image' | 'brand_logo';

/** One holding value and what the backfill would do with it. */
export interface ApplicationMediaRow {
  readonly id: string;
  readonly kind: 'image' | 'video';
  /** The file the row holds now, or `null`. */
  readonly fileId: string | null;
  /** A supplier or legacy URL the row holds instead of a file, or `null`. */
  readonly sourceUrl: string | null;
}

export async function findApplicationMediaPage(
  target: ApplicationMediaTarget,
  options: { after?: string; id?: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<ApplicationMediaRow[]> {
  switch (target) {
    case 'canonical_image':
      return db
        .select({
          id: canonicalImages.id,
          kind: canonicalImages.kind,
          fileId: canonicalImages.fileId,
          sourceUrl: canonicalImages.sourceUrl,
        })
        .from(canonicalImages)
        .where(
          and(
            eq(canonicalImages.status, 'active'),
            options.after ? gt(canonicalImages.id, options.after) : undefined,
            options.id ? eq(canonicalImages.id, options.id) : undefined,
          ),
        )
        .orderBy(asc(canonicalImages.id))
        .limit(options.limit);
    case 'category_image': {
      const rows = await db
        .select({
          id: categories.id,
          fileId: categories.imageFileId,
          sourceUrl: categories.imageUrl,
        })
        .from(categories)
        .where(
          and(
            or(isNotNull(categories.imageFileId), isNotNull(categories.imageUrl)),
            options.after ? gt(categories.id, options.after) : undefined,
            options.id ? eq(categories.id, options.id) : undefined,
          ),
        )
        .orderBy(asc(categories.id))
        .limit(options.limit);
      return rows.map((row) => ({ ...row, kind: 'image' as const }));
    }
    case 'brand_logo': {
      const rows = await db
        .select({ id: brands.id, fileId: brands.logoFileId })
        .from(brands)
        .where(
          and(
            isNotNull(brands.logoFileId),
            options.after ? gt(brands.id, options.after) : undefined,
            options.id ? eq(brands.id, options.id) : undefined,
          ),
        )
        .orderBy(asc(brands.id))
        .limit(options.limit);
      return rows.map((row) => ({ ...row, kind: 'image' as const, sourceUrl: null }));
    }
  }
}

/**
 * Point the row at the application-owned file, only if it still holds exactly
 * what the preview read. Each table is written by its owning repository (the
 * taxonomy and canonical write censuses name them); brands are written here.
 */
export async function applyApplicationMediaFile(
  target: ApplicationMediaTarget,
  row: ApplicationMediaRow,
  fileId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<'applied' | 'changed'> {
  switch (target) {
    case 'canonical_image':
      return (await replaceCanonicalImageFile(db, row.id, row.fileId, fileId))
        ? 'applied'
        : 'changed';
    case 'category_image':
      return (await replaceCategoryImageFile(
        row.id,
        { imageFileId: row.fileId, imageUrl: row.sourceUrl },
        fileId,
        db,
      ))
        ? 'applied'
        : 'changed';
    case 'brand_logo': {
      const updated = await db
        .update(brands)
        .set({ logoFileId: fileId })
        .where(
          and(
            eq(brands.id, row.id),
            row.fileId === null ? isNull(brands.logoFileId) : eq(brands.logoFileId, row.fileId),
          ),
        )
        .returning({ id: brands.id });
      return updated.length === 1 ? 'applied' : 'changed';
    }
  }
}
