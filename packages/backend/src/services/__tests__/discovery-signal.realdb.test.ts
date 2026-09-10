/**
 * `getDiscoverySignalPage` — the "see all" a discovery shelf's heading links
 * to — against a REAL Postgres database.
 *
 * `discovery-feed.realdb.test.ts` proves the feed's own one-page shelves;
 * nothing here re-drives that. What is new is pagination itself, and the
 * escapes a SECOND read path over the same rows can re-open even though the
 * feed already closes them:
 *
 *  - **`hasMore` is read off the query, never predicted.** Every pagination
 *    test below pages to the ACTUAL end of a fixture it built, rather than
 *    computing where the end "should" be and asserting against that number —
 *    the property `signal.service.ts`'s own docblock states.
 *  - **status is filtered at READ TIME.** A listing counted while it sold can
 *    be archived afterward; `discovery_signals` keeps no status column of its
 *    own, so only the join predicate can still keep it off this page.
 *  - **a suppressed category's listings are unreachable through EITHER
 *    scope** — `category:<handle>`'s subtree walk and `root`'s "every active
 *    category" both read off `findActiveCategories()`, so this is one
 *    property proven two ways rather than two unrelated claims.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every category, listing and signal row this file creates carries a per-run
 * suffix and is deleted in `afterEach` — the same discipline
 * `discovery-feed.realdb.test.ts` documents. `best-selling` fixtures write
 * `discovery_signals` directly (the sweep's own output shape, Task 4's sweep
 * being a separate concern) and hold `discovery-signals-slot.ts`'s mutex for
 * the file's whole run, because `discovery_signals`' window is a GLOBAL
 * resource shared with every sibling file that writes one.
 *
 * A `root`-scope test cannot rely on being the newest thing in an otherwise
 * empty table — the shared database always holds other files' concurrent
 * rows — so every `root` fixture below sets `publishedAt` far in the future,
 * which nothing else in this suite ever does, to win the `new` signal's
 * ordering deterministically regardless of what else is live at the same
 * moment.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { discoverySignals } from '../../db/schema/discovery.js';
import { getDiscoverySignalPage } from '../discovery/signal.service.js';
import {
  acquireDiscoverySignalsSlot,
  type DiscoverySignalsSlot,
} from '../../db/__tests__/discovery-signals-slot.js';

let db: Database;
let slot: DiscoverySignalsSlot | undefined;

const createdCategoryIds: string[] = [];
const createdListingIds: string[] = [];
const createdUserIds: string[] = [];

/** A date nothing else in this suite (or any concurrent one) plausibly uses. */
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

function makeUserId(role: string): string {
  const id = `realdb-discovery-signal-${role}-${uuidv7()}`;
  createdUserIds.push(id);
  return id;
}

async function makeCategory(
  overrides: { parentId?: string; ancestorIds?: string[]; isActive?: boolean; position?: number } = {},
): Promise<{ id: string; slug: string; name: string }> {
  const suffix = uuidv7().slice(-12);
  const [category] = await db
    .insert(categories)
    .values({
      key: `discovery-signal-${suffix}`,
      name: `Discovery signal ${suffix}`,
      slug: `discovery-signal-${suffix}`,
      parentId: overrides.parentId ?? null,
      ancestorIds: overrides.ancestorIds ?? [],
      position: overrides.position ?? 0,
      isActive: overrides.isActive ?? true,
    })
    .returning({ id: categories.id, slug: categories.slug, name: categories.name });
  createdCategoryIds.push(category.id);
  return category;
}

async function makeListing(
  categoryId: string,
  overrides: { rating?: number; reviewCount?: number; publishedAt?: Date } = {},
): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: makeUserId('seller'),
      title: 'Realdb discovery signal listing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      categoryId,
      status: 'active',
      rating: overrides.rating ?? 0,
      reviewCount: overrides.reviewCount ?? 0,
      publishedAt: overrides.publishedAt ?? new Date(),
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  return listing.id;
}

/** One `discovery_signals` row for a listing — the sweep's own output shape. */
async function seedSignal(values: { subjectId: string; categoryId: string; unitsSold: number }): Promise<void> {
  await db.insert(discoverySignals).values({
    subjectType: 'listing',
    subjectId: values.subjectId,
    categoryId: values.categoryId,
    window: '30d',
    unitsSold: values.unitsSold,
    orderCount: 0,
    viewCount: 0,
    computedAt: new Date(),
  });
}

async function archiveListing(id: string): Promise<void> {
  await db.update(listings).set({ status: 'archived' }).where(eq(listings.id, id));
}

beforeAll(async () => {
  db = await connectPostgres();
  slot = await acquireDiscoverySignalsSlot(db);
}, 120_000);

afterEach(async () => {
  const listingIds = createdListingIds.splice(0);
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  const categoryIds = createdCategoryIds.splice(0);
  if (categoryIds.length > 0) {
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, categoryIds));
    for (const id of [...categoryIds].reverse()) {
      await db.delete(categories).where(eq(categories.id, id));
    }
  }
  createdUserIds.length = 0;
});

afterAll(async () => {
  try {
    if (slot) await slot.release();
  } finally {
    await closePostgres();
  }
});

describe('getDiscoverySignalPage', () => {
  it('a category scope pages `new`, reporting categoryHandle/categoryName and pageDepth complete', async () => {
    const category = await makeCategory();
    const oldest = await makeListing(category.id, { publishedAt: new Date('2020-01-01') });
    const middle = await makeListing(category.id, { publishedAt: new Date('2021-01-01') });
    const newest = await makeListing(category.id, { publishedAt: new Date('2022-01-01') });

    const first = await getDiscoverySignalPage({
      signal: 'new',
      scope: { kind: 'category', handle: category.slug },
      limit: 2,
      offset: 0,
    });
    expect(first.categoryHandle).toBe(category.slug);
    expect(first.categoryName).toBe(category.name);
    expect(first.pageDepth).toBe('complete');
    expect(first.products.map((p) => p.id)).toEqual([newest, middle]);
    expect(first.hasMore).toBe(true);

    const second = await getDiscoverySignalPage({
      signal: 'new',
      scope: { kind: 'category', handle: category.slug },
      limit: 2,
      offset: 2,
    });
    expect(second.products.map((p) => p.id)).toEqual([oldest]);
    expect(second.hasMore).toBe(false);
  });

  it('hasMore goes false at the REAL edge of a CAPPED signal, not a predicted count', async () => {
    // `best-selling` is `DISCOVERY_SIGNALS_FROM_COUNTS` — the signal ranks
    // only within what the sweep counted. Paging past the exact edge of a
    // fixture with a KNOWN, small population is what proves `hasMore` comes
    // from the query exhausting itself rather than arithmetic against a total
    // this file never told the service.
    const category = await makeCategory();
    const first = await makeListing(category.id);
    const second = await makeListing(category.id);
    const third = await makeListing(category.id);
    await seedSignal({ subjectId: first, categoryId: category.id, unitsSold: 30 });
    await seedSignal({ subjectId: second, categoryId: category.id, unitsSold: 20 });
    await seedSignal({ subjectId: third, categoryId: category.id, unitsSold: 10 });

    const scope = { kind: 'category', handle: category.slug } as const;

    const page1 = await getDiscoverySignalPage({ signal: 'best-selling', scope, limit: 1, offset: 0 });
    expect(page1.products.map((p) => p.id)).toEqual([first]);
    expect(page1.pageDepth).toBe('capped');
    expect(page1.hasMore).toBe(true);

    const page2 = await getDiscoverySignalPage({ signal: 'best-selling', scope, limit: 1, offset: 1 });
    expect(page2.products.map((p) => p.id)).toEqual([second]);
    expect(page2.hasMore).toBe(true);

    const page3 = await getDiscoverySignalPage({ signal: 'best-selling', scope, limit: 1, offset: 2 });
    expect(page3.products.map((p) => p.id)).toEqual([third]);
    expect(page3.hasMore).toBe(false);
  });

  it('root counts a listing once even though it earns a discovery_signals row at every one of its ancestor scopes', async () => {
    // `sweep.ts` writes one row per subject PER ANCESTOR (leaf, every
    // ancestor, and root), all carrying the SAME units_sold. `root`'s
    // `categoryIds` is every active category id, so a listing two levels
    // below any one of them (`top`/`mid`/`leaf` here) matches three rows —
    // the exact fanout `discoveryReadRepository.ts` now collapses. This is
    // the ROOT-scope half of that fix, proven through the service rather than
    // the repository directly.
    const top = await makeCategory({ position: -2_000_000_000 });
    const mid = await makeCategory({ parentId: top.id, ancestorIds: [top.id] });
    const leaf = await makeCategory({ parentId: mid.id, ancestorIds: [top.id, mid.id] });
    const deepId = await makeListing(leaf.id);
    const shallowId = await makeListing(top.id);
    await seedSignal({ subjectId: deepId, categoryId: leaf.id, unitsSold: 60 });
    await seedSignal({ subjectId: deepId, categoryId: mid.id, unitsSold: 60 });
    await seedSignal({ subjectId: deepId, categoryId: top.id, unitsSold: 60 });
    await seedSignal({ subjectId: shallowId, categoryId: top.id, unitsSold: 100 });

    const page = await getDiscoverySignalPage({
      signal: 'best-selling',
      scope: { kind: 'root' },
      limit: 50,
      offset: 0,
    });

    const ids = page.products.map((p) => p.id);
    expect(ids.filter((id) => id === deepId)).toHaveLength(1);
    // Ranking, not just de-duplication: summed across its three duplicate
    // rows `deepId` would read 180 and wrongly outrank `shallowId`'s real 100.
    expect(ids.indexOf(shallowId)).toBeLessThan(ids.indexOf(deepId));
  });

  it('a listing archived after being counted is unreachable through this route', async () => {
    // The non-negotiable this test exists for: `discovery_signals` carries no
    // status of its own, so a listing counted while it sold and archived
    // since is reachable here for the rest of the sweep's window unless the
    // read filters CURRENT status. Adverse by construction: the archived
    // listing outranks the surviving one (30 vs 10 units sold), so a leak
    // puts it FIRST rather than merely present.
    const category = await makeCategory();
    const willArchive = await makeListing(category.id);
    const staysActive = await makeListing(category.id);
    await seedSignal({ subjectId: willArchive, categoryId: category.id, unitsSold: 30 });
    await seedSignal({ subjectId: staysActive, categoryId: category.id, unitsSold: 10 });
    await archiveListing(willArchive);

    const page = await getDiscoverySignalPage({
      signal: 'best-selling',
      scope: { kind: 'category', handle: category.slug },
      limit: 10,
      offset: 0,
    });

    expect(page.products.map((p) => p.id)).toEqual([staysActive]);
    expect(page.hasMore).toBe(false);
  });

  it('a suppressed subcategory is unreachable through its parent category scope', async () => {
    const parent = await makeCategory();
    const suppressed = await makeCategory({ parentId: parent.id, ancestorIds: [parent.id], isActive: false });
    const visible = await makeListing(parent.id, { publishedAt: new Date('2021-06-01') });
    // Adverse: the hidden listing is newer, so it wins `new`'s ordering if it leaks.
    const hidden = await makeListing(suppressed.id, { publishedAt: new Date('2022-06-01') });

    const page = await getDiscoverySignalPage({
      signal: 'new',
      scope: { kind: 'category', handle: parent.slug },
      limit: 10,
      offset: 0,
    });

    const ids = page.products.map((p) => p.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(hidden);
  });

  it('a suppressed category is unreachable through the root scope too', async () => {
    const suppressed = await makeCategory({ isActive: false });
    // Adverse: a `FAR_FUTURE` publication date wins `new`'s ordering outright
    // if `root` ever reads a suppressed category's id.
    const hidden = await makeListing(suppressed.id, { publishedAt: FAR_FUTURE });

    const page = await getDiscoverySignalPage({
      signal: 'new',
      scope: { kind: 'root' },
      limit: 1,
      offset: 0,
    });

    expect(page.products.map((p) => p.id)).not.toContain(hidden);
  });

  it('the root scope carries no categoryHandle/categoryName — no one category to name', async () => {
    const category = await makeCategory();
    const listing = await makeListing(category.id, { publishedAt: FAR_FUTURE });

    const page = await getDiscoverySignalPage({
      signal: 'new',
      scope: { kind: 'root' },
      limit: 1,
      offset: 0,
    });

    expect(page.scope).toEqual({ kind: 'root' });
    expect(page.categoryHandle).toBeUndefined();
    expect(page.categoryName).toBeUndefined();
    // Deterministic: `FAR_FUTURE` outranks anything any concurrent file seeds.
    expect(page.products[0]?.id).toBe(listing);
  });

  it('an unknown category handle is refused', async () => {
    await expect(
      getDiscoverySignalPage({
        signal: 'new',
        scope: { kind: 'category', handle: `no-such-discovery-signal-category-${uuidv7()}` },
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a category scope resolves by ID too, matching the feed\'s own id-or-slug rule', async () => {
    const category = await makeCategory();
    const listing = await makeListing(category.id, { publishedAt: new Date('2022-01-01') });

    const page = await getDiscoverySignalPage({
      signal: 'new',
      scope: { kind: 'category', handle: category.id },
      limit: 10,
      offset: 0,
    });

    expect(page.categoryHandle).toBe(category.slug);
    expect(page.categoryName).toBe(category.name);
    expect(page.products.map((p) => p.id)).toContain(listing);
  });

  it('a suppressed category 404s by id exactly like it does by slug', async () => {
    const suppressed = await makeCategory({ isActive: false });

    await expect(
      getDiscoverySignalPage({
        signal: 'new',
        scope: { kind: 'category', handle: suppressed.id },
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
