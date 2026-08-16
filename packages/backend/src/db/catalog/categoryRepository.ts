/**
 * `categories` — the marketplace taxonomy.
 *
 * A small, read-mostly table: every listing write resolves one slug through
 * {@link findCategoryBySlug} to materialize `listings.category_slugs`, and the
 * browse screens read the active tree. Nothing in the request path writes it —
 * the taxonomy is seeded.
 *
 * `ancestor_slugs` stays a `text[]` with a GIN index rather than becoming a
 * closure table: it is a scalar set queried BY ELEMENT (`categorySlugs @> …`),
 * which is exactly the shape `CONVENTIONS.md` keeps as an array.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { categories } from '../schema/catalog.js';

/** One row of `categories`. */
export type CategoryRecord = InferSelectModel<typeof categories>;

/** One category by slug, whatever its `is_active` — the catalogue write resolver. */
export async function findCategoryBySlug(
  slug: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRecord | null> {
  const [row] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return row ?? null;
}

/**
 * One category by id — the reverse of the resolver above.
 *
 * A canonical product stores a category ID while a listing write and every
 * client speak in SLUGS, so #91's prefill needs this direction to tell a seller
 * which category the catalogue already files their product under.
 */
export async function findCategoryById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRecord | null> {
  const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return row ?? null;
}

/** One ACTIVE category by slug — the public browse read. */
export async function findActiveCategoryBySlug(
  slug: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRecord | null> {
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.slug, slug), eq(categories.isActive, true)))
    .limit(1);
  return row ?? null;
}

/** Whether a slug names a category at all — the connector's category guard. */
export async function categorySlugExists(
  slug: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);
  return rows.length > 0;
}

/**
 * The whole ACTIVE taxonomy, in sibling order.
 *
 * `parent_id` then `position` reproduces the `{parentId: 1, position: 1}` index
 * order the Mongo read used, with `slug` breaking a tie between two siblings
 * sharing a position rather than letting the tree wobble between requests.
 */
export async function findActiveCategories(
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRecord[]> {
  return db
    .select()
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.parentId), asc(categories.position), asc(categories.slug));
}

/** The columns a caller supplies when creating a category (the seed path). */
export interface NewCategory {
  name: string;
  slug: string;
  parentId?: string | null;
  ancestorSlugs?: string[];
  imageUrl?: string | null;
  imageFileId?: string | null;
  position?: number;
  /**
   * Whether the category appears in the shopper-visible tree — the column
   * `findActiveCategories` and `findActiveCategoryBySlug` filter on, and that
   * `findCategoryBySlug`, `findCategoryById` and `categorySlugExists`
   * deliberately ignore.
   *
   * Defaults to true, matching the column default. It is passed explicitly for
   * the import holding category, which must be resolvable by a write and
   * unreachable by a browse (see `scripts/taxonomy.ts`).
   */
  isActive?: boolean;
}

/** Create a category. Used by the seed script; no request path writes the taxonomy. */
export async function insertCategory(
  values: NewCategory,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRecord> {
  const [row] = await db
    .insert(categories)
    .values({
      name: values.name,
      slug: values.slug,
      parentId: values.parentId ?? null,
      ancestorSlugs: values.ancestorSlugs ?? [],
      imageUrl: values.imageUrl ?? null,
      imageFileId: values.imageFileId ?? null,
      position: values.position ?? 0,
      isActive: values.isActive ?? true,
    })
    .returning();
  return row;
}
