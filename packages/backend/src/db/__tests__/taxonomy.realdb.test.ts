/**
 * The taxonomy against a REAL Postgres server (#367 step 1, ADR 0007 D1/D2).
 *
 * Everything here is a property the DATABASE holds and a mocked repository
 * cannot: the frozen `key` trigger, the hierarchy guard's two chain walks, the
 * biconditional merge CHECK, the append-only redirect trigger, the redirect
 * cycle guard, the partial uniques, and the assignment trigger that refuses a
 * product under a structural node. A mocked `insert` accepts any statement,
 * including one the server rejects outright — which is exactly the class of bug
 * this file exists to catch.
 *
 * The subtree-move case is the other kind: `moveCategory` rewrites every
 * descendant's ancestry in one statement, using `array_position` over a real
 * `text[]`. There is no mock of that; either the arrays come back right or they
 * do not.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories, listings } from '../schema/catalog.js';
import { categoryAliases, categoryRedirects } from '../schema/taxonomy.js';
import {
  findCategoryAncestors,
  findCategoryBreadcrumb,
  findCategoryByKey,
  findCategoryDescendants,
  findChildCategories,
  findRootCategories,
  insertCategory,
  insertCategoryAlias,
  insertCategoryRedirect,
  mergeCategory,
  moveCategory,
  resolveCategoryRedirect,
  setCategoryLifecycle,
  updateCategoryPresentation,
} from '../taxonomy/taxonomyRepository.js';
import { withTriggerToggleLock } from './trigger-toggle-lock.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

const createdCategoryIds: string[] = [];
const createdListingIds: string[] = [];

/** A key and a slug this file owns. Lowercase, so it clears the key CHECK. */
function handle(name: string): string {
  return `tax-${name}-${RUN}`;
}

/** Create a category and remember it for teardown. */
async function makeCategory(
  name: string,
  options: { parentId?: string | null; selectable?: boolean } = {},
): Promise<string> {
  const row = await insertCategory({
    key: handle(name),
    name: `Taxonomy ${name}`,
    slug: handle(name),
    parentId: options.parentId ?? null,
    ...(options.selectable === undefined ? {} : { selectable: options.selectable }),
  });
  createdCategoryIds.push(row.id);
  return row.id;
}

/**
 * Assert a TRIGGER refused, by its own message.
 *
 * The `RAISE` text lives on the error's CAUSE: drizzle wraps a driver failure
 * in a `Failed query: …` message, so matching only the top-level message would
 * pass against ANY refusal — including a foreign key, or a typo in a column
 * name — which is exactly the check that cannot tell success from failure.
 */
async function expectTriggerRefusal(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a trigger to refuse, but the write succeeded').toBeDefined();
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? thrown)).toMatch(pattern);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (db) {
    // Aliases first. They would CASCADE with their category anyway, but naming
    // them is cheaper than a cascade and states the order this teardown relies on.
    if (createdCategoryIds.length > 0) {
      await db
        .delete(categoryAliases)
        .where(inArray(categoryAliases.categoryId, createdCategoryIds));
    }
    if (createdListingIds.length > 0) {
      await db.delete(listings).where(inArray(listings.id, createdListingIds));
    }

    // `category_redirects` refuses a DELETE outright, so the teardown has to
    // stand its trigger down. ONE table in the window and nothing else in it:
    // `alter table … disable trigger` takes ShareRowExclusive, which conflicts
    // with the RowExclusive every ordinary write holds, and a window holding two
    // tables' locks deadlocks against any writer taking that pair the other way
    // round. The transaction is what makes a throw safe — on the pool the DDL
    // autocommits and would leave the trigger off for the rest of the run, every
    // later assertion that it refuses a write then passing vacuously.
    if (createdCategoryIds.length > 0) {
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table category_redirects disable trigger mercaria_category_redirects_append_only`,
        );
        await tx
          .delete(categoryRedirects)
          .where(inArray(categoryRedirects.targetCategoryId, createdCategoryIds));
        await tx.execute(
          sql`alter table category_redirects enable trigger mercaria_category_redirects_append_only`,
        );
      });

      // ONE statement for every category, parents and children together. A
      // `restrict` foreign key settles per STATEMENT, so deleting both ends at
      // once succeeds where partitioning the id set raises 23503.
      await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
    }

    await closePostgres();
  }
});

describe('identity: the key is stable and frozen (ADR 0007 D1)', () => {
  it('freezes `key` after insert, and leaves every other column editable', async () => {
    const id = await makeCategory('frozen');

    await expectTriggerRefusal(/frozen after insert/iu, () =>
      db.update(categories).set({ key: handle('frozen-renamed') }).where(eq(categories.id, id)),
    );

    // The positive control for the trigger's precision. A `BEFORE UPDATE`
    // trigger that raised on every update would pass the assertion above while
    // making the row uneditable, and nothing in that assertion can tell the two
    // apart.
    const renamed = await updateCategoryPresentation(id, { name: 'Renamed but not re-keyed' });
    expect(renamed.name).toBe('Renamed but not re-keyed');
    expect(renamed.key).toBe(handle('frozen'));
  });

  it('refuses a second category claiming one key', async () => {
    await makeCategory('unique-key');
    await expect(
      db.insert(categories).values({
        key: handle('unique-key'),
        name: 'Impostor',
        slug: handle('unique-key-other'),
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a key that is not a lowercase dotted path', async () => {
    for (const bad of ['Electronics.Phones', 'electronics phones', '.leading', 'trailing.']) {
      await expect(
        db.insert(categories).values({
          key: bad,
          name: 'Malformed',
          slug: `${handle('malformed')}-${bad.length.toString()}`,
        }),
      ).rejects.toSatisfy(isCheckViolation);
    }

    // The control: the shape the CHECK is supposed to ADMIT. Without it a CHECK
    // that rejected everything would pass every assertion above.
    const ok = await makeCategory('well-formed.child');
    expect(ok).toBeTruthy();
  });

  it('finds a category by its key', async () => {
    const id = await makeCategory('by-key');
    const found = await findCategoryByKey(handle('by-key'));
    expect(found?.id).toBe(id);
  });
});

describe('hierarchy: cycles and self-parenting are unrepresentable (ADR 0007 D2)', () => {
  it('refuses a category parented under itself', async () => {
    const id = await makeCategory('self-parent');
    await expect(
      db.update(categories).set({ parentId: id }).where(eq(categories.id, id)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a cycle of length two, which no CHECK could see', async () => {
    const top = await makeCategory('cycle-top');
    const child = await makeCategory('cycle-child', { parentId: top });

    // `top` under its own child closes the loop. The row-level CHECK cannot
    // detect this — it reads one row and the offending fact is on another.
    await expectTriggerRefusal(/closes a cycle/iu, () => moveCategory(top, child));
  });

  it('refuses a cycle of length three', async () => {
    const a = await makeCategory('cycle3-a');
    const b = await makeCategory('cycle3-b', { parentId: a });
    const c = await makeCategory('cycle3-c', { parentId: b });
    await expectTriggerRefusal(/closes a cycle/iu, () => moveCategory(a, c));
  });
});

describe('lifecycle and merging (ADR 0007 D2/D13)', () => {
  it('derives `is_active` from the lifecycle in every direction', async () => {
    const id = await makeCategory('lifecycle');
    const published = await db.select().from(categories).where(eq(categories.id, id));
    expect(published[0].lifecycle).toBe('published');
    expect(published[0].isActive).toBe(true);

    const suppressed = await setCategoryLifecycle(id, 'suppressed');
    expect(suppressed.isActive).toBe(false);

    const draft = await setCategoryLifecycle(id, 'draft');
    expect(draft.isActive).toBe(false);

    const back = await setCategoryLifecycle(id, 'published');
    expect(back.isActive).toBe(true);
  });

  it('makes a merge state its successor, and a successor state its merge', async () => {
    const loser = await makeCategory('merge-biconditional-loser');
    const winner = await makeCategory('merge-biconditional-winner');

    // `merged` with no successor.
    await expect(
      db.update(categories).set({ lifecycle: 'merged' }).where(eq(categories.id, loser)),
    ).rejects.toSatisfy(isCheckViolation);

    // A successor on a row that is not `merged`.
    await expect(
      db
        .update(categories)
        .set({ mergedIntoCategoryId: winner })
        .where(eq(categories.id, loser)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses merging into a descendant', async () => {
    const parent = await makeCategory('merge-desc-parent');
    const child = await makeCategory('merge-desc-child', { parentId: parent });
    const grandchild = await makeCategory('merge-desc-grandchild', { parentId: child });

    await expectTriggerRefusal(/its own descendants/iu, () => mergeCategory(parent, grandchild));

    // The control: merging the OTHER way is legitimate and must still work, or
    // the assertion above would pass against a trigger that refused every merge.
    const merged = await mergeCategory(grandchild, parent);
    expect(merged.lifecycle).toBe('merged');
    expect(merged.mergedIntoCategoryId).toBe(parent);
    expect(merged.isActive).toBe(false);
  });

  it('refuses merging into itself', async () => {
    const id = await makeCategory('merge-self');
    await expect(
      db
        .update(categories)
        .set({ lifecycle: 'merged', mergedIntoCategoryId: id })
        .where(eq(categories.id, id)),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('ancestry: the materialized path survives a subtree move (ADR 0007 D2)', () => {
  it('rewrites every descendant’s ancestry, ids and slugs together', async () => {
    // oldRoot > mid > leaf, and a newRoot to move `mid` under.
    const oldRoot = await makeCategory('move-old-root');
    const newRoot = await makeCategory('move-new-root');
    const mid = await makeCategory('move-mid', { parentId: oldRoot });
    const leaf = await makeCategory('move-leaf', { parentId: mid });
    const deepLeaf = await makeCategory('move-deep-leaf', { parentId: leaf });

    const before = await db.select().from(categories).where(eq(categories.id, deepLeaf));
    expect(before[0].ancestorIds).toEqual([oldRoot, mid, leaf]);
    expect(before[0].ancestorSlugs).toEqual([
      handle('move-old-root'),
      handle('move-mid'),
      handle('move-leaf'),
    ]);

    await moveCategory(mid, newRoot);

    const moved = await db.select().from(categories).where(eq(categories.id, mid));
    expect(moved[0].parentId).toBe(newRoot);
    expect(moved[0].ancestorIds).toEqual([newRoot]);

    // The whole subtree, at both depths — one statement rewrote both of them.
    const after = await db.select().from(categories).where(eq(categories.id, deepLeaf));
    expect(after[0].ancestorIds).toEqual([newRoot, mid, leaf]);
    expect(after[0].ancestorSlugs).toEqual([
      handle('move-new-root'),
      handle('move-mid'),
      handle('move-leaf'),
    ]);

    const midLeaf = await db.select().from(categories).where(eq(categories.id, leaf));
    expect(midLeaf[0].ancestorIds).toEqual([newRoot, mid]);

    // `oldRoot` keeps nothing, which is what makes the GIN'd descendants read
    // correct rather than merely populated.
    const orphanedSubtree = await findCategoryDescendants(oldRoot);
    expect(orphanedSubtree.map((row) => row.id)).toEqual([]);

    const newSubtree = await findCategoryDescendants(newRoot);
    expect(new Set(newSubtree.map((row) => row.id))).toEqual(new Set([mid, leaf, deepLeaf]));
  });

  it('moves a category to the root and empties its ancestry', async () => {
    const root = await makeCategory('to-root-parent');
    const child = await makeCategory('to-root-child', { parentId: root });

    await moveCategory(child, null);
    const moved = await db.select().from(categories).where(eq(categories.id, child));
    expect(moved[0].parentId).toBeNull();
    expect(moved[0].ancestorIds).toEqual([]);
    expect(moved[0].ancestorSlugs).toEqual([]);
  });

  it('rewrites the subtree’s slug path when an ancestor is renamed', async () => {
    const root = await makeCategory('rename-root');
    const child = await makeCategory('rename-child', { parentId: root });

    await updateCategoryPresentation(root, { slug: handle('rename-root-v2') });

    const after = await db.select().from(categories).where(eq(categories.id, child));
    expect(after[0].ancestorSlugs).toEqual([handle('rename-root-v2')]);
    // The id path is untouched — a rename is presentation, never identity.
    expect(after[0].ancestorIds).toEqual([root]);
  });

  it('reads roots, children, ancestors and a breadcrumb', async () => {
    const root = await makeCategory('read-root');
    const child = await makeCategory('read-child', { parentId: root });
    const grandchild = await makeCategory('read-grandchild', { parentId: child });

    const roots = await findRootCategories();
    expect(roots.map((row) => row.id)).toContain(root);

    const children = await findChildCategories(root);
    expect(children.map((row) => row.id)).toEqual([child]);

    const ancestors = await findCategoryAncestors(grandchild);
    expect(ancestors.map((row) => row.id)).toEqual([root, child]);

    const breadcrumb = await findCategoryBreadcrumb(grandchild);
    expect(breadcrumb.map((step) => step.key)).toEqual([
      handle('read-root'),
      handle('read-child'),
      handle('read-grandchild'),
    ]);
  });
});

describe('redirects (ADR 0007 D2)', () => {
  it('resolves an old localized slug to the category it now names', async () => {
    const target = await makeCategory('redirect-target');
    await insertCategoryRedirect({
      subject: { kind: 'localized_slug', locale: 'en', slug: 'retired-shelf-slug' },
      targetCategoryId: target,
      reason: 'renamed',
    });

    const resolved = await resolveCategoryRedirect({
      kind: 'localized_slug',
      locale: 'en',
      slug: 'retired-shelf-slug',
    });
    expect(resolved.outcome).toBe('redirected');
    if (resolved.outcome === 'redirected') {
      expect(resolved.category.id).toBe(target);
      expect(resolved.reason).toBe('renamed');
      expect(resolved.hops).toBe(1);
    }

    // A slug nobody redirected and nobody owns.
    const missing = await resolveCategoryRedirect({
      kind: 'localized_slug',
      locale: 'en',
      slug: `never-existed-${RUN}`,
    });
    expect(missing.outcome).toBe('unresolved');

    // A slug that IS a live category answers `current`, not `redirected` — the
    // control that distinguishes the resolver from one that always redirects.
    const live = await resolveCategoryRedirect({
      kind: 'localized_slug',
      locale: 'en',
      slug: handle('redirect-target'),
    });
    expect(live.outcome).toBe('current');
  });

  it('follows a chain, and reports the FIRST hop’s reason', async () => {
    const wrong = await makeCategory('chain-wrong');
    const right = await makeCategory('chain-right');
    const subject = await makeCategory('chain-subject');

    await mergeCategory(subject, wrong);
    // The correction: a redirect FROM the wrong target onward, because the
    // first redirect can never be edited.
    await insertCategoryRedirect({
      subject: { kind: 'category_id', categoryId: wrong },
      targetCategoryId: right,
      reason: 'operator',
    });

    const resolved = await resolveCategoryRedirect({ kind: 'category_id', categoryId: subject });
    expect(resolved.outcome).toBe('redirected');
    if (resolved.outcome === 'redirected') {
      expect(resolved.category.id).toBe(right);
      expect(resolved.hops).toBe(2);
      expect(resolved.reason).toBe('merged');
    }
  });

  it('reports a chain it cannot follow to the end, and names no category for it', async () => {
    // TEN categories chained one redirect at a time, which is exactly the
    // documented correction pattern: every insert's target is a category that
    // has never been a redirect subject, so the cycle guard's forward walk is
    // one hop and it passes each of them. The trigger never sees the chain it
    // is building — that blindness is real, and this is the case that shows it.
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      ids.push(await makeCategory(`long-chain-${index.toString()}`));
    }
    for (let index = 0; index < ids.length - 1; index += 1) {
      await insertCategoryRedirect({
        subject: { kind: 'category_id', categoryId: ids[index] },
        targetCategoryId: ids[index + 1],
        reason: 'operator',
      });
    }

    const resolved = await resolveCategoryRedirect({ kind: 'category_id', categoryId: ids[0] });
    expect(resolved.outcome).toBe('chain_exhausted');
    // A `chain_exhausted` result has no `category` property at all, so the
    // shape is what stops a caller rendering the category the walk stopped on —
    // which is itself redirected. Asserted here as well as in the type, because
    // a serializer widening the union is the way that guarantee would be lost.
    expect(Object.hasOwn(resolved, 'category')).toBe(false);

    // The control, three hops in from the tail: a chain the resolver CAN follow
    // still resolves, and resolves to the end. Without it this case would pass
    // against a resolver that had simply stopped following chains at all.
    const shortEnough = await resolveCategoryRedirect({
      kind: 'category_id',
      categoryId: ids[6],
    });
    expect(shortEnough.outcome).toBe('redirected');
    if (shortEnough.outcome === 'redirected') {
      expect(shortEnough.category.id).toBe(ids[9]);
      expect(shortEnough.hops).toBe(3);
    }
  });

  it('is append-only against UPDATE and DELETE', async () => {
    const target = await makeCategory('append-only-target');
    const other = await makeCategory('append-only-other');
    const row = await insertCategoryRedirect({
      subject: { kind: 'localized_slug', locale: 'en', slug: `append-only-${RUN}` },
      targetCategoryId: target,
      reason: 'deprecated',
    });

    await expectTriggerRefusal(/append-only/iu, () =>
      db
        .update(categoryRedirects)
        .set({ targetCategoryId: other })
        .where(eq(categoryRedirects.id, row.id)),
    );

    await expectTriggerRefusal(/append-only/iu, () =>
      db.delete(categoryRedirects).where(eq(categoryRedirects.id, row.id)),
    );
  });

  it('refuses a redirect cycle, so the resolver’s walk always terminates', async () => {
    const a = await makeCategory('rcycle-a');
    const b = await makeCategory('rcycle-b');

    await insertCategoryRedirect({
      subject: { kind: 'category_id', categoryId: a },
      targetCategoryId: b,
      reason: 'deprecated',
    });
    await expectTriggerRefusal(/closes a redirect cycle/iu, () =>
      insertCategoryRedirect({
        subject: { kind: 'category_id', categoryId: b },
        targetCategoryId: a,
        reason: 'deprecated',
      }),
    );
  });

  it('permits one redirect per subject and no more', async () => {
    const target = await makeCategory('one-redirect-target');
    const rival = await makeCategory('one-redirect-rival');
    const subject = await makeCategory('one-redirect-subject');

    await insertCategoryRedirect({
      subject: { kind: 'category_id', categoryId: subject },
      targetCategoryId: target,
      reason: 'deprecated',
    });
    await expect(
      insertCategoryRedirect({
        subject: { kind: 'category_id', categoryId: subject },
        targetCategoryId: rival,
        reason: 'operator',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses a subject that names two things, or neither', async () => {
    const target = await makeCategory('shape-target');
    const subject = await makeCategory('shape-subject');

    // `category_id` carrying a slug's columns.
    await expect(
      db.insert(categoryRedirects).values({
        subjectKind: 'category_id',
        subjectCategoryId: subject,
        subjectLocale: 'en',
        subjectSlug: `mixed-${RUN}`,
        targetCategoryId: target,
        reason: 'operator',
      }),
    ).rejects.toSatisfy(isCheckViolation);

    // The row shape a single CHECK over the conjunction would have ADMITTED: a
    // `category_id` subject carrying a locale and no slug.
    await expect(
      db.insert(categoryRedirects).values({
        subjectKind: 'category_id',
        subjectCategoryId: subject,
        subjectLocale: 'en',
        targetCategoryId: target,
        reason: 'operator',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('selectability: a structural node takes no product (ADR 0007 D2)', () => {
  it('refuses a listing filed under a non-selectable category, and admits one under a selectable one', async () => {
    const structural = await makeCategory('structural', { selectable: false });
    const leaf = await makeCategory('leafy', { selectable: true });

    const listingValues = {
      ownerType: 'user' as const,
      oxyUserId: `seller-${RUN}`,
      title: 'Taxonomy assignment fixture',
      description: 'A listing used to prove the selectability trigger fires.',
      condition: 'new' as const,
      conditionAssertion: 'seller_declared' as const,
    };

    await expectTriggerRefusal(/not selectable/iu, () =>
      db.insert(listings).values({ ...listingValues, categoryId: structural }),
    );

    // The control. Without it, a trigger that refused EVERY assignment would
    // pass the assertion above and delist the whole catalogue.
    const [ok] = await db
      .insert(listings)
      .values({ ...listingValues, categoryId: leaf })
      .returning();
    createdListingIds.push(ok.id);
    expect(ok.categoryId).toBe(leaf);

    // And on UPDATE, not only on INSERT: moving an existing listing onto a
    // structural node is the same mistake one statement later.
    await expectTriggerRefusal(/not selectable/iu, () =>
      db.update(listings).set({ categoryId: structural }).where(eq(listings.id, ok.id)),
    );

    // A listing with no category at all is untouched by the trigger.
    const [uncategorized] = await db.insert(listings).values(listingValues).returning();
    createdListingIds.push(uncategorized.id);
    expect(uncategorized.categoryId).toBeNull();
  });
});

describe('aliases (ADR 0007 D1/D2)', () => {
  it('permits one alias under several categories and refuses a duplicate under one', async () => {
    const first = await makeCategory('alias-first');
    const second = await makeCategory('alias-second');

    await insertCategoryAlias({
      categoryId: first,
      locale: 'en',
      alias: 'Phone',
      normalizedAlias: `phone-${RUN}`,
      kind: 'synonym',
    });
    // The SAME normalized alias under a different category is legitimate.
    await insertCategoryAlias({
      categoryId: second,
      locale: 'en',
      alias: 'phone',
      normalizedAlias: `phone-${RUN}`,
      kind: 'search_term',
    });

    await expect(
      insertCategoryAlias({
        categoryId: first,
        locale: 'en',
        alias: 'PHONE',
        normalizedAlias: `phone-${RUN}`,
        kind: 'misspelling',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses an empty alias', async () => {
    const id = await makeCategory('alias-empty');
    await expect(
      insertCategoryAlias({
        categoryId: id,
        locale: 'en',
        alias: '   ',
        normalizedAlias: `blank-${RUN}`,
        kind: 'synonym',
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});
