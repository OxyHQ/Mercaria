/**
 * `categories` — the v1 READS of the marketplace taxonomy.
 *
 * A small, read-mostly table: every listing write resolves one slug through
 * {@link findCategoryBySlug} to materialize `listings.category_slugs`, and the
 * browse screens read the active tree. Nothing in the request path writes it.
 *
 * ## This module is not a writer, and that is the #367 change
 *
 * `insertCategory` MOVED to `db/taxonomy/taxonomyRepository.ts`, which is the
 * single write chokepoint for `categories` and its three satellite tables
 * (ADR 0007 D2). A clean cut: this module exports it no longer. Three of that
 * module's invariants are DERIVATIONS with no database-side counterpart —
 * `is_active` from `lifecycle`, and both ancestry arrays from the parent's own —
 * so a second writer does not fail, it silently disagrees.
 * `db/__tests__/taxonomy-write-chokepoint.test.ts` fails the build on one.
 *
 * The five reads here stay because five services already call them and they are
 * the v1 contract ADR 0007 D13 retains. `is_active` is now DERIVED from
 * `lifecycle` by the writer, so `findActiveCategories` and
 * `findActiveCategoryBySlug` mean exactly what they always did.
 *
 * `ancestor_slugs` stays a `text[]` with a GIN index rather than becoming a
 * closure table: it is a scalar set queried BY ELEMENT (`categorySlugs @> …`),
 * which is exactly the shape `CONVENTIONS.md` keeps as an array. It is now the
 * v1 spelling of `ancestor_ids`, written from it and retired with it.
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
