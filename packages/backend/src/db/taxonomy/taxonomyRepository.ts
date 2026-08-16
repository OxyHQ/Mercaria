/**
 * The taxonomy — the SINGLE write chokepoint for `categories` and its three
 * satellite tables (#367 step 1, ADR 0007 D1/D2/D13).
 *
 * ## What "single write chokepoint" means here, and what enforces it
 *
 * Every INSERT and UPDATE against `categories`, `category_aliases` and
 * `category_redirects` in production source is issued from this module. `db/__tests__/taxonomy-write-chokepoint.test.ts`
 * fails the build on a second writer, for the reason
 * `listing-publication-chokepoint.test.ts` exists one table over: three of this
 * module's invariants are DERIVATIONS rather than constraints — `is_active` from
 * `lifecycle`, `ancestor_ids` and `ancestor_slugs` from the parent's own arrays —
 * and a derivation has no database-side counterpart, so a second writer does not
 * fail, it silently disagrees.
 *
 * The three the DATABASE holds, and which therefore need no gate: `key` is
 * frozen by `mercaria_category_key_frozen`; cycles, self-parenting, merging into
 * oneself and merging into a descendant are refused by
 * `mercaria_category_hierarchy_guard` and two same-row CHECKs; and a product
 * assignment onto a non-selectable node is refused by
 * `mercaria_category_assignment_selectable` on `listings` and
 * `canonical_products`.
 *
 * ## Reads do not filter by lifecycle unless asked
 *
 * A repository read that filtered `published` by default is exactly what
 * `is_active` became — a hidden authority nobody could see at the call site. The
 * tree reads take an explicit `lifecycles` option and, absent one, return every
 * state. Ancestors and breadcrumbs are never filtered at all: a breadcrumb with
 * a hole in it is worse than one showing a deprecated parent.
 *
 * `db/catalog/categoryRepository.ts` keeps the v1 READS (`findCategoryBySlug`,
 * `findCategoryById`, `findActiveCategories`, …) that five services already
 * call. It is no longer a writer.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import {
  isCategoryLifecycleActive,
  type CategoryAliasKind,
  type CategoryBreadcrumbStep,
  type CategoryLifecycle,
  type CategoryRedirectReason,
  type CategoryRedirectResolution,
  type TaxonomyCategory,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import { categoryAliases, categoryRedirects } from '../schema/taxonomy.js';

/** One row of `categories`. */
export type CategoryRow = InferSelectModel<typeof categories>;
/** One row of `category_aliases`. */
export type CategoryAliasRow = InferSelectModel<typeof categoryAliases>;
/** One row of `category_redirects`. */
export type CategoryRedirectRow = InferSelectModel<typeof categoryRedirects>;

/**
 * How far `resolveCategoryRedirect` follows a chain before answering
 * `chain_exhausted`.
 *
 * This bound is REACHABLE, and saying otherwise is the mistake worth recording.
 * `mercaria_category_redirect_cycle_guard` refuses a cycle absolutely — the walk
 * that closes one always traverses the whole loop — but it bounds only the chain
 * a single insert can see AHEAD of its own target, and the documented correction
 * pattern extends a chain at the TAIL, where every new target is a fresh
 * category whose forward walk is one hop. Nine such inserts, each individually
 * legitimate and each passing the trigger, build a chain of nine.
 *
 * Bounding the real depth would mean walking BACKWARD from the new subject, and
 * the backward direction is a fan-in: one category is the target of any number
 * of redirects, so it is a tree traversal on every insert rather than the linear
 * walk the forward direction gets. That cost is not paid; the resolver reports
 * the truncation instead, which is the honest half of the pair.
 */
const MAX_REDIRECT_HOPS = 8;

/** The columns a caller supplies when creating a category. */
export interface NewCategory {
  /**
   * The stable machine key (D1) — lowercase dotted segments. REQUIRED and never
   * derived from the slug: deriving it would make a rename change a concept's
   * identity, which is the one thing `key` exists to prevent.
   */
  key: string;
  name: string;
  slug: string;
  parentId?: string | null;
  /**
   * Defaults to `published`, matching the column default and today's behaviour
   * for every seeded category.
   */
  lifecycle?: CategoryLifecycle;
  /** Whether a product may be filed here. Defaults to true. */
  selectable?: boolean;
  position?: number;
  imageUrl?: string | null;
  imageFileId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}

/** The presentation columns a category's own row may be edited to say. */
export interface CategoryPresentationPatch {
  name?: string;
  slug?: string;
  position?: number;
  imageUrl?: string | null;
  imageFileId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}

/** What `resolveCategoryRedirect` was asked about. */
export type CategoryRedirectSubject =
  | { readonly kind: 'category_id'; readonly categoryId: string }
  | { readonly kind: 'localized_slug'; readonly locale: string; readonly slug: string };

/** The projection every taxonomy consumer reads. */
export function toTaxonomyCategory(row: CategoryRow): TaxonomyCategory {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId ?? null,
    ancestorIds: row.ancestorIds ?? [],
    ancestorSlugs: row.ancestorSlugs ?? [],
    lifecycle: row.lifecycle,
    selectable: row.selectable,
    mergedIntoCategoryId: row.mergedIntoCategoryId ?? null,
    effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString() : null,
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    position: row.position,
    imageUrl: row.imageUrl ?? null,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Create a category, deriving its ancestry from its parent and `is_active` from
 * its lifecycle.
 *
 * A caller supplies neither array. `ancestor_ids` and `ancestor_slugs` are the
 * parent's own arrays plus the parent, so the two paths describe one path by
 * construction rather than by whoever was editing the seed remembering to keep
 * them aligned — which is what `ancestorSlugs` was before this, a hand-passed
 * field with nothing checking it.
 */
export async function insertCategory(
  values: NewCategory,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow> {
  const lifecycle: CategoryLifecycle = values.lifecycle ?? 'published';
  const parent = values.parentId ? await requireCategory(values.parentId, db) : null;

  const [row] = await db
    .insert(categories)
    .values({
      key: values.key,
      name: values.name,
      slug: values.slug,
      parentId: parent?.id ?? null,
      ancestorIds: parent ? [...(parent.ancestorIds ?? []), parent.id] : [],
      ancestorSlugs: parent ? [...(parent.ancestorSlugs ?? []), parent.slug] : [],
      lifecycle,
      selectable: values.selectable ?? true,
      position: values.position ?? 0,
      imageUrl: values.imageUrl ?? null,
      imageFileId: values.imageFileId ?? null,
      effectiveFrom: values.effectiveFrom ?? null,
      effectiveTo: values.effectiveTo ?? null,
      isActive: isCategoryLifecycleActive(lifecycle),
    })
    .returning();
  if (!row) throw new Error('insertCategory returned no row.');
  return row;
}

/**
 * Edit a category's presentation — name, slug, position, imagery, dated window.
 *
 * `key`, `parent_id`, `lifecycle` and `merged_into_category_id` are absent from
 * the patch type on purpose: the first is frozen by the database, and the other
 * three each have their own function because each has a consequence beyond its
 * own row.
 *
 * A SLUG change rewrites every descendant's `ancestor_slugs`, because that array
 * is a materialized path of slugs and a rename otherwise leaves the subtree
 * claiming an ancestor that no longer answers to that name — a stale value the
 * browse reads would go on matching against.
 */
export async function updateCategoryPresentation(
  categoryId: string,
  patch: CategoryPresentationPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow> {
  const before = await requireCategory(categoryId, db);
  const [row] = await db
    .update(categories)
    .set(patch)
    .where(eq(categories.id, categoryId))
    .returning();
  if (!row) throw new Error('updateCategoryPresentation returned no row.');
  if (patch.slug !== undefined && patch.slug !== before.slug) {
    await rewriteDescendantAncestorSlugs(categoryId, db);
  }
  return row;
}

/**
 * Move a category to a new parent, rewriting the whole subtree's ancestry.
 *
 * Two statements inside one transaction, per ADR 0007 D2: the node's own row,
 * then every descendant in ONE statement that splices the moved node's new
 * ancestry in front of the path from the moved node downward. `array_position`
 * finds where the moved node sits in each descendant's path, and the SAME
 * position is valid for both arrays because they materialize one path.
 *
 * A move into the node's own descendant would build a cycle, and
 * `mercaria_category_hierarchy_guard` refuses it before either statement's
 * effect is visible.
 */
export async function moveCategory(
  categoryId: string,
  newParentId: string | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow> {
  const run = async (tx: DatabaseOrTransaction): Promise<CategoryRow> => {
    const parent = newParentId ? await requireCategory(newParentId, tx) : null;
    const ancestorIds = parent ? [...(parent.ancestorIds ?? []), parent.id] : [];
    const ancestorSlugs = parent ? [...(parent.ancestorSlugs ?? []), parent.slug] : [];

    const [row] = await tx
      .update(categories)
      .set({ parentId: parent?.id ?? null, ancestorIds, ancestorSlugs })
      .where(eq(categories.id, categoryId))
      .returning();
    if (!row) throw new Error(`moveCategory: no category ${categoryId}.`);

    // The descendants, in one statement. The prefix is read back out of the row
    // the statement above just wrote, and the slice runs from just after the
    // moved node's own position — so each descendant keeps every intermediate
    // between itself and the moved node, and gains the moved node's new
    // ancestry in front of it. `array_position` over `ancestor_ids` indexes
    // BOTH arrays, because they materialize one path.
    //
    // The prefix is a SUBQUERY rather than a bound array, and that is not a
    // style choice: a bare JavaScript array interpolated into a drizzle `sql`
    // template renders as a ROW CONSTRUCTOR — `($1, $2)`, and `()` for an empty
    // one, which is a syntax error. Reading it back from the row also means
    // there is one expression producing the new ancestry rather than two that
    // could disagree.
    await tx.execute(sql`
      update categories as d
      set ancestor_ids =
            (select m.ancestor_ids || m.id from categories as m where m.id = ${categoryId})
            || d.ancestor_ids[array_position(d.ancestor_ids, ${categoryId}) + 1:],
          ancestor_slugs =
            (select m.ancestor_slugs || m.slug from categories as m where m.id = ${categoryId})
            || d.ancestor_slugs[array_position(d.ancestor_ids, ${categoryId}) + 1:]
      where d.ancestor_ids @> array[${categoryId}]::text[]
    `);
    return row;
  };

  return isTransaction(db) ? run(db) : (db as ReturnType<typeof getDb>).transaction(run);
}

/**
 * Set a category's lifecycle, keeping the derived `is_active` in step.
 *
 * `merged` is refused here and belongs to {@link mergeCategory}: the
 * biconditional CHECK makes a `merged` row without a successor unrepresentable,
 * so a function that could set the lifecycle without naming one could only ever
 * throw at the database.
 */
export async function setCategoryLifecycle(
  categoryId: string,
  lifecycle: Exclude<CategoryLifecycle, 'merged'>,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow> {
  const [row] = await db
    .update(categories)
    .set({
      lifecycle,
      isActive: isCategoryLifecycleActive(lifecycle),
      mergedIntoCategoryId: null,
    })
    .where(eq(categories.id, categoryId))
    .returning();
  if (!row) throw new Error(`setCategoryLifecycle: no category ${categoryId}.`);
  return row;
}

/**
 * End one category's identity in another, and keep its URLs resolving.
 *
 * ONE function writes both facts in one transaction, because they are two
 * consequences of one decision and two writers of them could disagree: the
 * column `merged_into_category_id` is what the TAXONOMY says, and the
 * `category_redirects` row is what a URL resolves to. A merge with no redirect
 * is a 404 for every link anybody ever published.
 */
export async function mergeCategory(
  categoryId: string,
  intoCategoryId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow> {
  const run = async (tx: DatabaseOrTransaction): Promise<CategoryRow> => {
    const [row] = await tx
      .update(categories)
      .set({ lifecycle: 'merged', mergedIntoCategoryId: intoCategoryId, isActive: false })
      .where(eq(categories.id, categoryId))
      .returning();
    if (!row) throw new Error(`mergeCategory: no category ${categoryId}.`);
    await insertCategoryRedirect(
      {
        subject: { kind: 'category_id', categoryId },
        targetCategoryId: intoCategoryId,
        reason: 'merged',
      },
      tx,
    );
    return row;
  };

  return isTransaction(db) ? run(db) : (db as ReturnType<typeof getDb>).transaction(run);
}

/** An internal or search-time alternate name. Never the category's name. */
export interface NewCategoryAlias {
  categoryId: string;
  locale: string;
  alias: string;
  normalizedAlias: string;
  kind: CategoryAliasKind;
}

/** Record one alias. */
export async function insertCategoryAlias(
  values: NewCategoryAlias,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryAliasRow> {
  const [row] = await db.insert(categoryAliases).values(values).returning();
  if (!row) throw new Error('insertCategoryAlias returned no row.');
  return row;
}

/** Remove one alias. Aliases are editable; only `category_redirects` is not. */
export async function deleteCategoryAlias(
  aliasId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(categoryAliases).where(eq(categoryAliases.id, aliasId));
}

/** What a new redirect says. */
export interface NewCategoryRedirect {
  subject: CategoryRedirectSubject;
  targetCategoryId: string;
  reason: CategoryRedirectReason;
  effectiveFrom?: Date;
}

/**
 * Record one redirect.
 *
 * The table is append-only, so there is deliberately no update and no delete
 * here: a redirect that points at the wrong category is corrected by a redirect
 * FROM that wrong target onward, which the resolver follows.
 */
export async function insertCategoryRedirect(
  values: NewCategoryRedirect,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRedirectRow> {
  const subject = values.subject;
  const [row] = await db
    .insert(categoryRedirects)
    .values({
      subjectKind: subject.kind,
      subjectCategoryId: subject.kind === 'category_id' ? subject.categoryId : null,
      subjectLocale: subject.kind === 'localized_slug' ? subject.locale : null,
      subjectSlug: subject.kind === 'localized_slug' ? subject.slug : null,
      targetCategoryId: values.targetCategoryId,
      reason: values.reason,
      ...(values.effectiveFrom ? { effectiveFrom: values.effectiveFrom } : {}),
    })
    .returning();
  if (!row) throw new Error('insertCategoryRedirect returned no row.');
  return row;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/** One category by its stable machine key — the D1 identity lookup. */
export async function findCategoryByKey(
  key: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow | null> {
  const [row] = await db.select().from(categories).where(eq(categories.key, key)).limit(1);
  return row ?? null;
}

/** Which lifecycles a tree read admits. Omitted means every one of them. */
export interface CategoryLifecycleFilter {
  lifecycles?: readonly CategoryLifecycle[];
}

/** The top-level categories, in sibling order. */
export async function findRootCategories(
  filter: CategoryLifecycleFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow[]> {
  return db
    .select()
    .from(categories)
    .where(and(isNull(categories.parentId), lifecycleClause(filter)))
    .orderBy(asc(categories.position), asc(categories.slug));
}

/** One category's direct children, in sibling order. */
export async function findChildCategories(
  parentId: string,
  filter: CategoryLifecycleFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow[]> {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.parentId, parentId), lifecycleClause(filter)))
    .orderBy(asc(categories.position), asc(categories.slug));
}

/**
 * One category's ancestors, ROOT-FIRST, excluding itself.
 *
 * Never lifecycle-filtered. A breadcrumb missing its middle is not a shorter
 * breadcrumb, it is a wrong one — the caller decides how to render a deprecated
 * ancestor, and cannot decide anything about one it was never given.
 */
export async function findCategoryAncestors(
  categoryId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow[]> {
  const self = await findCategoryRow(categoryId, db);
  const ancestorIds = self?.ancestorIds ?? [];
  if (ancestorIds.length === 0) return [];
  const rows = await db.select().from(categories).where(inArray(categories.id, ancestorIds));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ancestorIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Every category beneath one, at any depth — the GIN'd `ancestor_ids @> [id]`
 * that made the materialized path the choice (ADR 0007 D2).
 */
export async function findCategoryDescendants(
  categoryId: string,
  filter: CategoryLifecycleFilter = {},
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRow[]> {
  return db
    .select()
    .from(categories)
    .where(
      and(
        sql`${categories.ancestorIds} @> array[${categoryId}]::text[]`,
        lifecycleClause(filter),
      ),
    )
    .orderBy(asc(categories.position), asc(categories.slug));
}

/** The breadcrumb for one category: its ancestors root-first, then itself. */
export async function findCategoryBreadcrumb(
  categoryId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryBreadcrumbStep[]> {
  const self = await findCategoryRow(categoryId, db);
  if (!self) return [];
  const ancestors = await findCategoryAncestors(categoryId, db);
  return [...ancestors, self].map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    slug: row.slug,
  }));
}

/**
 * Resolve an old id or an old localized slug to the category it now names.
 *
 * A REDIRECT wins over the subject still existing, and that ordering is the
 * point: a redirect is written precisely because the handle should no longer be
 * used. The chain is followed to its end and `reason` is the FIRST hop's — why
 * this handle stopped resolving, not why some later one did.
 */
export async function resolveCategoryRedirect(
  subject: CategoryRedirectSubject,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryRedirectResolution> {
  const first = await findRedirectForSubject(subject, db);

  if (!first) {
    const row =
      subject.kind === 'category_id'
        ? await findCategoryRow(subject.categoryId, db)
        : await findCategoryBySlugRow(subject.slug, db);
    return row ? { outcome: 'current', category: toTaxonomyCategory(row) } : { outcome: 'unresolved' };
  }

  let targetId = first.targetCategoryId;
  let hops = 1;
  let terminal = false;
  while (hops <= MAX_REDIRECT_HOPS) {
    const next = await findRedirectForSubject({ kind: 'category_id', categoryId: targetId }, db);
    if (!next) {
      terminal = true;
      break;
    }
    targetId = next.targetCategoryId;
    hops += 1;
  }

  // Running out of hops is a DIFFERENT answer, not a shorter walk. Returning
  // the category the walk stopped on would report a still-redirected — possibly
  // merged, possibly deprecated — category as the resolution, in a response
  // shaped exactly like a correct one.
  if (!terminal) return { outcome: 'chain_exhausted', hops };

  const row = await findCategoryRow(targetId, db);
  if (!row) return { outcome: 'unresolved' };
  return { outcome: 'redirected', category: toTaxonomyCategory(row), reason: first.reason, hops };
}

/**
 * Every category one alias points at, in a locale.
 *
 * A LIST, not a row: the unique deliberately permits one normalized alias under
 * several categories, because "phone" legitimately names more than one shelf.
 * Resolving that ambiguity is the caller's, and a repository that picked for
 * them would be picking silently.
 */
export async function findCategoriesByAlias(
  locale: string,
  normalizedAlias: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CategoryAliasRow[]> {
  return db
    .select()
    .from(categoryAliases)
    .where(
      and(eq(categoryAliases.locale, locale), eq(categoryAliases.normalizedAlias, normalizedAlias)),
    );
}

// ─── Internals ─────────────────────────────────────────────────────────────

/** `true` when `lifecycles` was omitted — an unfiltered read is the default. */
function lifecycleClause(filter: CategoryLifecycleFilter) {
  const lifecycles = filter.lifecycles;
  if (!lifecycles || lifecycles.length === 0) return sql`true`;
  return inArray(categories.lifecycle, [...lifecycles]);
}

async function findCategoryRow(
  categoryId: string,
  db: DatabaseOrTransaction,
): Promise<CategoryRow | null> {
  const [row] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
  return row ?? null;
}

async function findCategoryBySlugRow(
  slug: string,
  db: DatabaseOrTransaction,
): Promise<CategoryRow | null> {
  const [row] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return row ?? null;
}

async function requireCategory(
  categoryId: string,
  db: DatabaseOrTransaction,
): Promise<CategoryRow> {
  const row = await findCategoryRow(categoryId, db);
  if (!row) throw new Error(`No category ${categoryId}.`);
  return row;
}

async function findRedirectForSubject(
  subject: CategoryRedirectSubject,
  db: DatabaseOrTransaction,
): Promise<CategoryRedirectRow | null> {
  const where =
    subject.kind === 'category_id'
      ? and(
          eq(categoryRedirects.subjectKind, 'category_id'),
          eq(categoryRedirects.subjectCategoryId, subject.categoryId),
        )
      : and(
          eq(categoryRedirects.subjectKind, 'localized_slug'),
          eq(categoryRedirects.subjectLocale, subject.locale),
          eq(categoryRedirects.subjectSlug, subject.slug),
        );
  const [row] = await db.select().from(categoryRedirects).where(where).limit(1);
  return row ?? null;
}

/**
 * Re-derive every descendant's `ancestor_slugs` from its `ancestor_ids`.
 *
 * Derived rather than spliced: the id path is the authority (D2), so rebuilding
 * the slug path from it cannot produce a pair that disagree, where an index
 * arithmetic that got the position wrong would produce a plausible one.
 */
async function rewriteDescendantAncestorSlugs(
  categoryId: string,
  db: DatabaseOrTransaction,
): Promise<void> {
  await db.execute(sql`
    update categories as d
    set ancestor_slugs = coalesce((
      select array_agg(a.slug order by u.ord)
      from unnest(d.ancestor_ids) with ordinality as u(aid, ord)
      join categories as a on a.id = u.aid
    ), '{}'::text[])
    where d.ancestor_ids @> array[${categoryId}]::text[]
  `);
}

/**
 * Whether the handle is already inside a transaction.
 *
 * The `requireTransaction` discriminator, one domain over: the root `Database`
 * and a `Transaction` share one TypeScript type, so a type test decides nothing
 * and `.rollback` being a function is what tells them apart. Without it a caller
 * who passed their own transaction would have `moveCategory` open a SECOND one
 * and deadlock against the rows the first is holding.
 */
function isTransaction(db: DatabaseOrTransaction): db is Transaction {
  return typeof (db as Transaction).rollback === 'function';
}
