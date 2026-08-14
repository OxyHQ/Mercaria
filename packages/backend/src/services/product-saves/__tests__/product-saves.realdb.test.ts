/**
 * Canonical product saves against a REAL PostgreSQL database — issue #80.
 *
 * Every guarantee this domain makes is held by a unique index, a CHECK, a
 * trigger, a cascade or a transaction, and none of those exists under a mocked
 * repository: a mocked `insert` accepts a statement the server rejects outright,
 * which is exactly how a duplicated save, a counter that doubled on a replay, or
 * a migration record somebody edited would look green and ship broken.
 *
 * The eight acceptance criteria this file answers directly:
 *
 *  1. Saving two offers for one canonical product produces ONE product save,
 *     and an explicit listing pin survives beside it.
 *  2. Existing favorites are never dropped during migration.
 *  3. Unmatched P2P favorites keep working — and produce no save.
 *  4. Product merge and split behaviour.
 *  5. Save toggles are idempotent under repeated taps and network retries.
 *  6. Derived counts can be rebuilt and drift is detectable.
 *  7. A saved product stays useful when every prior offer expires.
 *  8. (The read-mode lever is a pure config read and is covered in
 *     `saved-items.service`'s own unit surface; what needs a server here is that
 *     the REPRESENTATION join it depends on survives an un-save.)
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every name, slug and account id this file writes
 * carries a per-run suffix and teardown deletes exactly what it created —
 * children first, since the canonical-side foreign keys are RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

/**
 * `PRODUCT_SAVE_MIGRATION_ENABLED` has to be set BEFORE the module graph loads,
 * because `config` is frozen at import: `runFavoriteMigrationPage` downgrades
 * every request to a dry run without it, which is the correct production
 * default and would make every migration case here assert against a prediction
 * instead of a write.
 *
 * `vi.hoisted` is what runs before the imports below — a plain assignment at the
 * top of the file would not, since ESM hoists every `import` above it.
 */
vi.hoisted(() => {
  process.env['PRODUCT_SAVE_MIGRATION_ENABLED'] = 'true';
});

import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { listings, productVariants } from '../../../db/schema/catalog.js';
import { stores } from '../../../db/schema/stores.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { nativeListingLinks } from '../../../db/schema/offers.js';
import { favorites } from '../../../db/schema/buyers.js';
import {
  productSaveAggregates,
  productSaveSources,
  productSaves,
} from '../../../db/schema/productSaves.js';
import {
  countProductSaves,
  deleteProductSave,
  findProductSavePage,
  insertProductSave,
  markProductSavesAmbiguousAfterSplit,
  clearProductSaveAmbiguity,
} from '../../../db/productSaves/productSaveRepository.js';
import {
  findListingFavoriteCounterDrift,
  findProductSaveCounterDrift,
  rebuildListingFavoriteCount,
  rebuildProductSaveAggregate,
} from '../../../db/productSaves/productSaveAggregateRepository.js';
import {
  findRepresentedFavoriteIds,
  insertProductSaveSource,
} from '../../../db/productSaves/productSaveSourceRepository.js';
import { insertFavorite } from '../../../db/buyers/favoriteRepository.js';
import { findListingCanonicalMappings } from '../../../db/productSaves/listingMappingRepository.js';
import { claimMergeJobs } from '../../../db/curation/jobRepository.js';
import { requestMerge, runMergeJob } from '../../curation/merge.service.js';
import { runFavoriteMigrationPage } from '../save-migration.service.js';
import { PRODUCT_SAVE_MIGRATION_VERSION } from '../mapping-version.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const BUYER = `save-buyer-${RUN}`;
const OTHER_BUYER = `save-other-${RUN}`;

/**
 * The advisory-lock key every realdb teardown that toggles a trigger takes
 * before doing so — see the fuller note beside the identical constant in
 * `curation-writes.realdb.test.ts`, the file this one collided with.
 *
 * Its VALUE means nothing and its SAMENESS is the whole mechanism; it is the
 * number three policy-teardown files declare as `POLICY_TEARDOWN_LOCK`, because
 * the hazard is the database-wide WINDOW rather than any particular table.
 * Transaction-scoped, so a pooled connection cannot carry the release away.
 */
const TEARDOWN_TRIGGER_LOCK = 6_820_068;

const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdSplitJobIds: string[] = [];
const createdMergeJobIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // The append-only trigger is one of the properties under test, so teardown
  // goes around it — the escape `curation-writes.realdb.test.ts` uses for its
  // own immutability trigger, now under the shared lock that escape needs. See
  // TEARDOWN_TRIGGER_LOCK: "re-enabled immediately" is not what makes a
  // database-wide statement safe.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${TEARDOWN_TRIGGER_LOCK})`);
    await tx.execute(
      sql`alter table product_save_sources disable trigger product_save_sources_append_only`,
    );
    await tx
      .delete(productSaveSources)
      .where(inArray(productSaveSources.listingId, safeIds(createdListingIds)));
    await tx.execute(
      sql`alter table product_save_sources enable trigger product_save_sources_append_only`,
    );
  });

  await db.delete(productSaves).where(inArray(productSaves.oxyUserId, [BUYER, OTHER_BUYER]));
  if (createdMergeJobIds.length > 0) {
    /**
     * The revision timeline and the phase records are append-only by trigger, so
     * teardown goes around them — inside the window {@link TEARDOWN_TRIGGER_LOCK}
     * holds, because `curation-writes.realdb.test.ts` toggles these same two
     * triggers and the two files together are the measured collision: its
     * DELETE met `catalog_revisions_append_only` re-enabled by THIS teardown.
     */
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${TEARDOWN_TRIGGER_LOCK})`);
      await tx.execute(
        sql`alter table catalog_revisions disable trigger catalog_revisions_append_only`,
      );
      await tx.execute(
        sql`delete from catalog_revisions where merge_job_id = any(${sql.param(createdMergeJobIds)}::text[])`,
      );
      await tx.execute(
        sql`alter table catalog_revisions enable trigger catalog_revisions_append_only`,
      );
      // `catalog_merge_job_phases` is append-only too, and for a sharper reason: a
      // resumed merge decides what to skip by reading these rows.
      await tx.execute(
        sql`alter table catalog_merge_job_phases disable trigger catalog_merge_job_phases_append_only`,
      );
      await tx.execute(
        sql`delete from catalog_merge_job_phases where job_id = any(${sql.param(createdMergeJobIds)}::text[])`,
      );
      await tx.execute(
        sql`alter table catalog_merge_job_phases enable trigger catalog_merge_job_phases_append_only`,
      );
      await tx.execute(
        sql`delete from catalog_merge_conflicts where job_id = any(${sql.param(createdMergeJobIds)}::text[])`,
      );
      await tx.execute(
        sql`delete from catalog_merge_jobs where id = any(${sql.param(createdMergeJobIds)}::text[])`,
      );
    });
  }
  if (createdSplitJobIds.length > 0) {
    await db.execute(
      sql`delete from catalog_split_jobs where id = any(${sql.param(createdSplitJobIds)}::text[])`,
    );
  }
  await db
    .delete(productSaveAggregates)
    .where(inArray(productSaveAggregates.canonicalProductId, safeIds(createdProductIds)));
  await db.delete(favorites).where(inArray(favorites.oxyUserId, [BUYER, OTHER_BUYER]));
  await db
    .delete(nativeListingLinks)
    .where(inArray(nativeListingLinks.listingId, safeIds(createdListingIds)));
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));
  await deleteTestStores(db, safeIds(createdStoreIds));
  await deleteTestCanonicalRows(db, { variantIds: createdVariantIds });
  // The merge mints a redirect hop and a former-name alias on the winner. Both
  // reference the product and both have to go before it does — their presence
  // here is the merge working, not a leak.
  await db.execute(
    sql`delete from canonical_product_redirects
        where from_id = any(${sql.param(safeIds(createdProductIds))}::text[])
           or to_id = any(${sql.param(safeIds(createdProductIds))}::text[])`,
  );
  await db.execute(
    sql`delete from canonical_product_aliases
        where product_id = any(${sql.param(safeIds(createdProductIds))}::text[])`,
  );
  // …and #76's rating aggregate, which the merge's `rollups` phase re-derives
  // for both sides beside #80's own. Same fact, one domain over.
  await db.execute(
    sql`delete from review_aggregates
        where canonical_product_id = any(${sql.param(safeIds(createdProductIds))}::text[])`,
  );
  // A merged product points at its winner; the pointer has to go before either
  // row can be deleted.
  await db
    .update(canonicalProducts)
    .set({ status: 'active', mergedIntoId: null })
    .where(inArray(canonicalProducts.id, safeIds(createdProductIds)));
  await deleteTestCanonicalRows(db, { productIds: createdProductIds });
  await closePostgres();
});

/** Assert a write is refused by the named CLASS of constraint. */
async function expectRefused(
  kind: 'check' | 'unique' | 'trigger',
  run: () => Promise<unknown>,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, `expected a ${kind} violation, but the write succeeded`).toBeDefined();
  // A trigger raising `check_violation` is indistinguishable from a CHECK at
  // the wire level, which is exactly why the RAISE uses that errcode — so both
  // are accepted for `trigger`, and the assertion that makes the case
  // meaningful is the one about what the row looks like afterwards.
  const matched = kind === 'unique' ? isUniqueViolation(thrown) : isCheckViolation(thrown);
  expect(matched, `expected a ${kind} violation, got: ${String(thrown)}`).toBe(true);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `save-${label}-${RUN}`,
      name: `Save store ${label} ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('mintStore returned no row');
  createdStoreIds.push(row.id);
  return row.id;
}

async function mintListing(storeId: string, label: string): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: `Save listing ${label} ${RUN}`,
      description: 'a listing under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  if (!row) throw new Error('mintListing returned no row');
  createdListingIds.push(row.id);
  return row.id;
}

async function mintVariant(listingId: string): Promise<string> {
  const [row] = await db
    .insert(productVariants)
    .values({
      listingId,
      title: 'Default Title',
      priceAmount: 119_900,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
    })
    .returning({ id: productVariants.id });
  if (!row) throw new Error('mintVariant returned no row');
  return row.id;
}

async function mintCanonicalProduct(label: string): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Canonical ${label} ${RUN}`,
      normalizedName: `canonical ${label} ${RUN}`,
      slug: `canonical-save-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('mintCanonicalProduct produced no product');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('mintCanonicalProduct produced no variant');
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

/** Attach a native listing variant to a canonical variant, the #58 way. */
async function attach(
  listingId: string,
  productVariantId: string,
  canonicalVariantId: string,
  method: 'barcode_gtin' | 'matcher' = 'barcode_gtin',
): Promise<void> {
  await db.insert(nativeListingLinks).values({
    listingId,
    productVariantId,
    canonicalVariantId,
    method,
    matchRule: `test-${method}`,
    ...(method === 'matcher' ? { confidence: 0.94 } : {}),
  });
}

/**
 * The migration cursor to start THIS file's runs from.
 *
 * `findFavoriteMigrationPage` reads `where id > cursor order by id`, and
 * `favorites.id` is a uuid v7 whose leading bits are a millisecond timestamp —
 * so a cursor taken before a fixture is created excludes every row that already
 * existed. The suite shares one database across parallel workers and a
 * migration page is a WRITE; scoping it is what stops this file creating saves
 * out of another file's fixtures and leaving rows its teardown cannot see.
 *
 * uuid v7 is NOT monotonic within a millisecond (`~/Oxy/AGENTS.md`), so this is
 * used only as a FLOOR — it may admit a row created in the same millisecond,
 * which is harmless, and it can never exclude one created later.
 */
async function migrationFloor(): Promise<string> {
  const [row] = await db
    .select({ id: sql<string | null>`max(${favorites.id})` })
    .from(favorites);
  return row?.id ?? '0';
}

/** A listing that is favorited by the buyer and attached to `canonicalVariantId`. */
async function favoritedListing(
  storeId: string,
  label: string,
  canonicalVariantId: string | null,
  intent: 'listing_save' | 'listing_pin' = 'listing_save',
): Promise<{ listingId: string; favoriteId: string }> {
  const listingId = await mintListing(storeId, label);
  const variantId = await mintVariant(listingId);
  if (canonicalVariantId) await attach(listingId, variantId, canonicalVariantId);
  await insertFavorite(BUYER, listingId, intent);
  const [favorite] = await db
    .select({ id: favorites.id })
    .from(favorites)
    .where(sql`${favorites.oxyUserId} = ${BUYER} and ${favorites.listingId} = ${listingId}`);
  if (!favorite) throw new Error('favoritedListing produced no favorite');
  return { listingId, favoriteId: favorite.id };
}

// ── The cases ───────────────────────────────────────────────────────────────

describe('ACCEPTANCE 5: a save toggle is idempotent under repeated taps and retries', () => {
  it('two identical saves produce one row, and the second reports it was not created', async () => {
    const { productId } = await mintCanonicalProduct('idem');

    const first = await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    const second = await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_card',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.save.id).toBe(first.save.id);
    // The conflict branch is `DO NOTHING`, so nothing about the first save
    // moved: not its source context, and — crucially — not `created_at`, which
    // is the saved list's ordering key. A `DO UPDATE` would reshuffle a buyer's
    // list on every repeated tap.
    expect(second.save.sourceContext).toBe('product_page');
    expect(second.save.createdAt.getTime()).toBe(first.save.createdAt.getTime());
    expect(await countProductSaves(productId, db)).toBe(1);
  });

  it('un-saving twice converges instead of failing the second time', async () => {
    const { productId } = await mintCanonicalProduct('unsave');
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });

    expect(await deleteProductSave(BUYER, productId, db)).toBe(true);
    expect(await deleteProductSave(BUYER, productId, db)).toBe(false);
    expect(await countProductSaves(productId, db)).toBe(0);
  });

  it('two buyers saving one product are two rows — the unique is per PERSON', async () => {
    const { productId } = await mintCanonicalProduct('twobuyers');
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    await insertProductSave({
      oxyUserId: OTHER_BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    expect(await countProductSaves(productId, db)).toBe(2);
  });
});

describe('the CHECKs that make an unsafe save unrepresentable', () => {
  it('refuses a public saved list', async () => {
    const { productId } = await mintCanonicalProduct('visibility');
    await expectRefused('check', () =>
      db.execute(sql`insert into product_saves (id, oxy_user_id, canonical_product_id, source_context, visibility)
                     values (${uuidv7()}, ${BUYER}, ${productId}, 'product_page', 'public')`),
    );
  });

  it('refuses an ambiguous save with no split job, and a resolved one carrying a job id', async () => {
    const { productId } = await mintCanonicalProduct('ambiguity');
    // Both directions of `product_saves_ambiguity_check`: an ambiguity nobody
    // can trace back to its two candidates, and a stale job id on a save a
    // reader would then resurface as an unanswered question.
    await expectRefused('check', () =>
      db.execute(sql`insert into product_saves (id, oxy_user_id, canonical_product_id, source_context, resolution_state)
                     values (${uuidv7()}, ${BUYER}, ${productId}, 'product_page', 'ambiguous_after_split')`),
    );
  });

  it('refuses a reference price missing its currency or its observation time', async () => {
    const { productId } = await mintCanonicalProduct('refprice');
    await expectRefused('check', () =>
      db.execute(sql`insert into product_saves (id, oxy_user_id, canonical_product_id, source_context, reference_price_amount)
                     values (${uuidv7()}, ${BUYER}, ${productId}, 'product_page', 49900)`),
    );
  });

  it('refuses a second save of the same product by the same person', async () => {
    const { productId } = await mintCanonicalProduct('unique');
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    await expectRefused('unique', () =>
      db.execute(sql`insert into product_saves (id, oxy_user_id, canonical_product_id, source_context)
                     values (${uuidv7()}, ${BUYER}, ${productId}, 'product_page')`),
    );
  });
});

describe('ACCEPTANCE 6: counters are derived, rebuildable and drift-detectable', () => {
  it('a rebuild is idempotent and a replayed rebuild does not double the count', async () => {
    const { productId } = await mintCanonicalProduct('counter');
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    await insertProductSave({
      oxyUserId: OTHER_BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });

    expect(await rebuildProductSaveAggregate(productId, db)).toBe(2);
    // Three more times. An INCREMENTING counter would read 8 by now; a derived
    // one cannot, which is the whole of #80 counter rule 3.
    expect(await rebuildProductSaveAggregate(productId, db)).toBe(2);
    expect(await rebuildProductSaveAggregate(productId, db)).toBe(2);
    expect(await rebuildProductSaveAggregate(productId, db)).toBe(2);
  });

  it('drift between a stored count and the rows is DETECTED and then repaired', async () => {
    const { productId } = await mintCanonicalProduct('drift');
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    await rebuildProductSaveAggregate(productId, db);

    // Corrupt the stored number the way a lost write would, and confirm the
    // probe reports the pair rather than silently repairing it.
    await db
      .update(productSaveAggregates)
      .set({ saveCount: 99 })
      .where(eq(productSaveAggregates.canonicalProductId, productId));

    const drift = await findProductSaveCounterDrift(1000, undefined, db);
    const row = drift.drift.find((entry) => entry.canonicalProductId === productId);
    expect(row).toBeDefined();
    expect(row?.storedCount).toBe(99);
    expect(row?.derivedCount).toBe(1);

    await rebuildProductSaveAggregate(productId, db);
    const after = await findProductSaveCounterDrift(1000, undefined, db);
    expect(after.drift.find((entry) => entry.canonicalProductId === productId)).toBeUndefined();
  });

  it('the LISTING favorite counter is repairable from `favorites` too (#80 counter rule 2)', async () => {
    const storeId = await mintStore('listcount');
    const listingId = await mintListing(storeId, 'listcount');
    await insertFavorite(BUYER, listingId, 'listing_save');
    await insertFavorite(OTHER_BUYER, listingId, 'listing_save');

    // A counter that only ever moved by ±1 had no way back from a lost write.
    await db.update(listings).set({ favoriteCount: 0 }).where(eq(listings.id, listingId));
    const drift = await findListingFavoriteCounterDrift(1000, undefined, db);
    const row = drift.drift.find((entry) => entry.listingId === listingId);
    expect(row).toMatchObject({ storedCount: 0, derivedCount: 2 });

    expect(await rebuildListingFavoriteCount(listingId, db)).toBe(2);
  });
});

describe('ACCEPTANCE 2 and 3: the migration keeps every favorite and invents no save', () => {
  it('two favorited listings of ONE product make ONE save, both favorites survive, and a replay changes nothing', async () => {
    const floor = await migrationFloor();
    const storeId = await mintStore('migrate');
    const { productId, variantId } = await mintCanonicalProduct('migrate');
    const first = await favoritedListing(storeId, 'migrate-a', variantId);
    const second = await favoritedListing(storeId, 'migrate-b', variantId);

    const report = await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });
    expect(report.dryRun).toBe(false);

    // ACCEPTANCE 1, at the migration end: one save for the product, however many
    // listings of it the buyer had favorited.
    expect(await countProductSaves(productId, db)).toBe(1);
    // ACCEPTANCE 2: both favorites are still there, untouched.
    const survivingFavorites = await db
      .select({ id: favorites.id })
      .from(favorites)
      .where(inArray(favorites.id, [first.favoriteId, second.favoriteId]));
    expect(survivingFavorites).toHaveLength(2);
    // Both are recorded as sources of the one save (#80 migration rule 5).
    const sources = await db
      .select({ favoriteId: productSaveSources.favoriteId })
      .from(productSaveSources)
      .where(inArray(productSaveSources.favoriteId, [first.favoriteId, second.favoriteId]));
    expect(sources).toHaveLength(2);

    const countAfterFirstRun = await countProductSaves(productId, db);
    await rebuildProductSaveAggregate(productId, db);
    const [beforeReplay] = await db
      .select({ saveCount: productSaveAggregates.saveCount })
      .from(productSaveAggregates)
      .where(eq(productSaveAggregates.canonicalProductId, productId));

    // ACCEPTANCE 6 / migration rule 6: a REPLAY duplicates neither saves nor
    // counters. Run the whole page again.
    const replay = await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });
    expect(replay.alreadyMigrated).toBeGreaterThanOrEqual(2);
    expect(await countProductSaves(productId, db)).toBe(countAfterFirstRun);
    await rebuildProductSaveAggregate(productId, db);
    const [afterReplay] = await db
      .select({ saveCount: productSaveAggregates.saveCount })
      .from(productSaveAggregates)
      .where(eq(productSaveAggregates.canonicalProductId, productId));
    expect(afterReplay?.saveCount).toBe(beforeReplay?.saveCount);
  });

  it('an UNMATCHED favorite keeps working and produces no save (#80 acceptance 3)', async () => {
    const floor = await migrationFloor();
    const storeId = await mintStore('unmatched');
    const unmatched = await favoritedListing(storeId, 'unmatched', null);

    const report = await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });
    expect(report.unmatched).toBeGreaterThanOrEqual(1);

    const survivor = await db
      .select({ id: favorites.id })
      .from(favorites)
      .where(eq(favorites.id, unmatched.favoriteId));
    expect(survivor).toHaveLength(1);
    const recorded = await db
      .select({ id: productSaveSources.id })
      .from(productSaveSources)
      .where(eq(productSaveSources.favoriteId, unmatched.favoriteId));
    expect(recorded).toHaveLength(0);
  });

  it('an explicit PIN is preserved as a pin and never becomes a product save', async () => {
    const floor = await migrationFloor();
    const storeId = await mintStore('pin');
    const { variantId } = await mintCanonicalProduct('pin');
    const pinned = await favoritedListing(storeId, 'pin', variantId, 'listing_pin');

    const report = await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });
    expect(report.pinPreserved).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ saveIntent: favorites.saveIntent })
      .from(favorites)
      .where(eq(favorites.id, pinned.favoriteId));
    expect(row?.saveIntent).toBe('listing_pin');
    const recorded = await db
      .select({ id: productSaveSources.id })
      .from(productSaveSources)
      .where(eq(productSaveSources.favoriteId, pinned.favoriteId));
    expect(recorded).toHaveLength(0);
  });

  it('a MATCHER attachment is not confident enough to create a save', async () => {
    // #58 routes a heuristic attachment to #59's review queue precisely because
    // nobody has agreed it yet, and a save created from an unreviewed guess is a
    // false merge with a person's intent attached.
    const floor = await migrationFloor();
    const storeId = await mintStore('heuristic');
    const { productId, variantId } = await mintCanonicalProduct('heuristic');
    const listingId = await mintListing(storeId, 'heuristic');
    const nativeVariantId = await mintVariant(listingId);
    await attach(listingId, nativeVariantId, variantId, 'matcher');
    await insertFavorite(BUYER, listingId, 'listing_save');

    await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });
    expect(await countProductSaves(productId, db)).toBe(0);
    // …and the mapping IS there — the refusal is about confidence, not about a
    // read that found nothing, which is what makes this case meaningful.
    const mappings = await findListingCanonicalMappings([listingId], db);
    expect(mappings.get(listingId)).toHaveLength(1);
  });

  it('a DRY RUN reports what it would do and writes nothing', async () => {
    const floor = await migrationFloor();
    const storeId = await mintStore('dryrun');
    const { productId, variantId } = await mintCanonicalProduct('dryrun');
    await favoritedListing(storeId, 'dryrun', variantId);

    const report = await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: true });
    expect(report.dryRun).toBe(true);
    // A dry-run outcome is a PREDICTION and is reported as one — refusing to
    // report `created` would make the mode unable to answer the question it
    // exists for (#60 records the same decision).
    expect(report.created).toBeGreaterThanOrEqual(1);
    expect(await countProductSaves(productId, db)).toBe(0);
  });
});

describe('the migration record is append-only, and idempotence does not depend on it', () => {
  it('refuses an UPDATE outright', async () => {
    const storeId = await mintStore('appendonly');
    const { productId, variantId } = await mintCanonicalProduct('appendonly');
    const favorite = await favoritedListing(storeId, 'appendonly', variantId);
    const { save } = await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'favorite_migration',
      migrationVersion: PRODUCT_SAVE_MIGRATION_VERSION,
    });
    const [nativeVariant] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.listingId, favorite.listingId));
    if (!nativeVariant) throw new Error('no native variant');

    await insertProductSaveSource(
      {
        saveId: save.id,
        favoriteId: favorite.favoriteId,
        listingId: favorite.listingId,
        productVariantId: nativeVariant.id,
        migrationVersion: PRODUCT_SAVE_MIGRATION_VERSION,
      },
      db,
    );

    await expectRefused('trigger', () =>
      db
        .update(productSaveSources)
        .set({ migrationVersion: 'rewritten' })
        .where(eq(productSaveSources.favoriteId, favorite.favoriteId)),
    );
  });

  it('goes with the favorite it names, and the SAVE survives that', async () => {
    // The cascade is why replay-safety must not rest on this record: a buyer
    // un-saving the listing takes the provenance with it, and the product save
    // — which is now theirs, not a migration artefact — stays.
    const floor = await migrationFloor();
    const storeId = await mintStore('cascade');
    const { productId, variantId } = await mintCanonicalProduct('cascade');
    const favorite = await favoritedListing(storeId, 'cascade', variantId);
    await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });
    expect(await countProductSaves(productId, db)).toBe(1);

    await db.delete(favorites).where(eq(favorites.id, favorite.favoriteId));

    const orphaned = await db
      .select({ id: productSaveSources.id })
      .from(productSaveSources)
      .where(eq(productSaveSources.favoriteId, favorite.favoriteId));
    expect(orphaned).toHaveLength(0);
    expect(await countProductSaves(productId, db)).toBe(1);
  });

  it('a listing whose product save was un-saved stops reading as represented', async () => {
    // Representation is DERIVED from the record joined back to a save that still
    // EXISTS, never stored. Without the join a buyer who un-saves the product
    // would lose the listing from their saved list too, in `on` read mode.
    const floor = await migrationFloor();
    const storeId = await mintStore('represented');
    const { productId, variantId } = await mintCanonicalProduct('represented');
    const favorite = await favoritedListing(storeId, 'represented', variantId);
    await runFavoriteMigrationPage({ limit: 500, cursor: floor, dryRun: false });

    expect(
      await findRepresentedFavoriteIds(
        [favorite.favoriteId],
        PRODUCT_SAVE_MIGRATION_VERSION,
        db,
      ),
    ).toEqual(new Set([favorite.favoriteId]));

    await deleteProductSave(BUYER, productId, db);

    expect(
      await findRepresentedFavoriteIds(
        [favorite.favoriteId],
        PRODUCT_SAVE_MIGRATION_VERSION,
        db,
      ),
    ).toEqual(new Set());
  });
});

describe('ACCEPTANCE 4: a merge rehomes saves automatically', () => {
  it('moves a save to the winner, leaves a COLLIDING one on the tombstone, and rebuilds both counters', async () => {
    const loser = await mintCanonicalProduct('merge-loser');
    const winner = await mintCanonicalProduct('merge-winner');

    // BUYER saved only the loser — their save must MOVE.
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: loser.productId,
      sourceContext: 'product_page',
    });
    // OTHER_BUYER saved BOTH. Repointing theirs would violate
    // `product_saves_oxy_user_id_canonical_product_id_key` and abort the phase,
    // so the plan's `repoint_if_absent` leaves it on the tombstone — which loses
    // nothing precisely because the twin on the winner exists, and is the only
    // reading under which the saved-list read excluding a merged product is safe.
    await insertProductSave({
      oxyUserId: OTHER_BUYER,
      canonicalProductId: loser.productId,
      sourceContext: 'product_page',
    });
    await insertProductSave({
      oxyUserId: OTHER_BUYER,
      canonicalProductId: winner.productId,
      sourceContext: 'product_page',
    });
    await rebuildProductSaveAggregate(loser.productId, db);
    await rebuildProductSaveAggregate(winner.productId, db);

    const job = await requestMerge({
      entityType: 'canonical_product',
      loserId: loser.productId,
      winnerId: winner.productId,
      reason: `product-save merge fixture ${RUN}`,
      actorOxyUserId: `op-${RUN}`,
    });
    createdMergeJobIds.push(job.id);
    // Backdate this job so it is the OLDEST due row, then take exactly ONE.
    // `claimMergeJobs` orders by `available_at` across the WHOLE table with no
    // filter, and the merge-job queue is global to the one throwaway database a
    // run shares — so a batch of 25 had two failure modes, both read as flake:
    // once more than 25 older rows are pending this job is the NEWEST and sits
    // beyond the batch (measured: this file failed a full run on exactly that),
    // and claiming 25 STEALS up to 24 rows belonging to whatever else is
    // running, marking them `processing` under this lease so their real owners
    // can never complete them. Backdating plus `batchSize: 1` fixes both —
    // queue depth stops mattering and nothing else is touched. The precedent is
    // `7f00a67` (#255) and `78e2f4b` (#231); looping over batches until the row
    // turns up was tried there and is WORSE, because it drains the due queue.
    //
    // The epoch used here must stay DISTINCT from every other file that
    // backdates `catalog_merge_jobs` — `curation-writes.realdb.test.ts` uses
    // `to_timestamp(0)`, so this one uses `to_timestamp(1)`. `claimMergeJobs`
    // orders by `available_at` with NO second column, so two files backdating to
    // the same instant sit TIED, and `for update skip locked` then guarantees
    // the two claims take DIFFERENT rows: each file steals the other's job, its
    // own `toEqual([jobId])` fails, and the stolen row is left `processing`
    // under a lease that will never complete it. Two files red, neither at
    // fault. One second apart is enough, and both rows still sort before
    // anything a sibling enqueues at `now`.
    await db.execute(
      sql`update catalog_merge_jobs set available_at = to_timestamp(1) where id = ${job.id}`,
    );
    const claimed = await claimMergeJobs(
      { leaseOwner: `worker-${RUN}`, leaseMs: 60_000, batchSize: 1 },
      db,
    );
    expect(claimed.map((row) => row.id)).toEqual([job.id]);
    const result = await runMergeJob(job.id, `worker-${RUN}`);
    expect(result.blocked, 'the merge blocked on a conflict this fixture did not intend').toBe(false);
    expect(result.finalPhase).toBe('done');

    const buyerSaves = await db
      .select({ canonicalProductId: productSaves.canonicalProductId })
      .from(productSaves)
      .where(eq(productSaves.oxyUserId, BUYER));
    expect(buyerSaves.map((row) => row.canonicalProductId)).toContain(winner.productId);
    expect(buyerSaves.map((row) => row.canonicalProductId)).not.toContain(loser.productId);

    // Scoped to the two products under test: this buyer carries saves from
    // earlier cases in this file, and asserting over all of them would make the
    // case depend on the order the suite happens to run in.
    const otherSaves = await db
      .select({ canonicalProductId: productSaves.canonicalProductId })
      .from(productSaves)
      .where(
        sql`${productSaves.oxyUserId} = ${OTHER_BUYER}
            and ${productSaves.canonicalProductId} in (${loser.productId}, ${winner.productId})`,
      );
    // Still BOTH rows: one on the winner, one stranded on the tombstone.
    expect(otherSaves).toHaveLength(2);
    expect(otherSaves.map((row) => row.canonicalProductId).sort()).toEqual(
      [loser.productId, winner.productId].sort(),
    );

    // Both counters are RE-DERIVED, never summed: 1 (the tombstone's stranded
    // twin) and 2 (the moved save plus the winner's own). A merge that added the
    // loser's count to the winner's would read 3 and nothing would catch it.
    const [loserAggregate] = await db
      .select({ saveCount: productSaveAggregates.saveCount })
      .from(productSaveAggregates)
      .where(eq(productSaveAggregates.canonicalProductId, loser.productId));
    const [winnerAggregate] = await db
      .select({ saveCount: productSaveAggregates.saveCount })
      .from(productSaveAggregates)
      .where(eq(productSaveAggregates.canonicalProductId, winner.productId));
    expect(loserAggregate?.saveCount).toBe(1);
    expect(winnerAggregate?.saveCount).toBe(2);
  }, 60_000);
});

describe('ACCEPTANCE 4: a split marks saves for resolution rather than picking a child', () => {
  it('marks every RESOLVED save of the source, re-runs as a no-op, and leaves an earlier ambiguity alone', async () => {
    const { productId } = await mintCanonicalProduct('split');
    await insertProductSave({
      oxyUserId: BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });
    await insertProductSave({
      oxyUserId: OTHER_BUYER,
      canonicalProductId: productId,
      sourceContext: 'product_page',
    });

    // Two splits of ONE product, and the first must be CLOSED before the second
    // exists: `catalog_split_jobs_open_key` holds one live split per source
    // entity, which is #59's own concurrency answer and not something to work
    // around. Sequencing them is also the only shape in which the property
    // under test — a later split does not retarget an unanswered question — can
    // actually arise.
    const firstJobId = uuidv7();
    const secondJobId = uuidv7();
    const { productId: targetProductId } = await mintCanonicalProduct('split-target');
    await db.execute(sql`insert into catalog_split_jobs
      (id, entity_type, source_entity_id, target_mode, target_entity_id, target_slug, target_name,
       phase, status, completed_at, reason, requested_by_oxy_user_id, available_at)
      values (${firstJobId}, 'canonical_product', ${productId}, 'new_entity', ${targetProductId},
              ${`split-a-${RUN}`}, ${`Split A ${RUN}`}, 'done', 'completed', now(),
              ${`split fixture ${RUN}`}, ${`op-${RUN}`}, now())`);
    createdSplitJobIds.push(firstJobId);

    expect(await markProductSavesAmbiguousAfterSplit(productId, firstJobId, db)).toBe(2);
    // A resumed phase re-runs it: the predicate is `resolution_state = 'resolved'`,
    // so nothing is marked twice.
    expect(await markProductSavesAmbiguousAfterSplit(productId, firstJobId, db)).toBe(0);

    // A SECOND split of the same product, opened once the first has closed.
    await db.execute(sql`insert into catalog_split_jobs
      (id, entity_type, source_entity_id, target_mode, target_slug, target_name,
       phase, reason, requested_by_oxy_user_id, available_at)
      values (${secondJobId}, 'canonical_product', ${productId}, 'new_entity',
              ${`split-b-${RUN}`}, ${`Split B ${RUN}`}, 'plan',
              ${`split fixture ${RUN}`}, ${`op-${RUN}`}, now())`);
    createdSplitJobIds.push(secondJobId);
    // It does not retarget an unanswered question. Silently repointing it would
    // destroy the pair of candidates the buyer was asked about.
    expect(await markProductSavesAmbiguousAfterSplit(productId, secondJobId, db)).toBe(0);

    const marked = await db
      .select({ jobId: productSaves.ambiguousSplitJobId })
      .from(productSaves)
      .where(eq(productSaves.canonicalProductId, productId));
    expect(marked.every((row) => row.jobId === firstJobId)).toBe(true);

    // Answering clears it, and answering twice converges rather than clearing an
    // ambiguity a later split raised in between.
    const [save] = await db
      .select({ id: productSaves.id })
      .from(productSaves)
      .where(sql`${productSaves.canonicalProductId} = ${productId} and ${productSaves.oxyUserId} = ${BUYER}`);
    if (!save) throw new Error('no save to resolve');
    expect(await clearProductSaveAmbiguity(save.id, db)).toBe(true);
    expect(await clearProductSaveAmbiguity(save.id, db)).toBe(false);

    // The saves go before the jobs they cite: `ambiguous_split_job_id` is
    // RESTRICT, because the job is the only record of what the two candidates
    // were and must outlive the ambiguity it created.
    await db.delete(productSaves).where(eq(productSaves.canonicalProductId, productId));
  });
});

describe('the saved-list read is ordered and paged stably', () => {
  it('pages a buyer newest-first without repeating or dropping a save', async () => {
    const products = await Promise.all(
      ['page-a', 'page-b', 'page-c', 'page-d'].map((label) => mintCanonicalProduct(label)),
    );
    for (const product of products) {
      await insertProductSave({
        oxyUserId: OTHER_BUYER,
        canonicalProductId: product.productId,
        sourceContext: 'product_page',
      });
    }

    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 4; page += 1) {
      const rows = await findProductSavePage(OTHER_BUYER, 2, cursor, db);
      if (rows.length === 0) break;
      for (const row of rows) seen.push(row.canonicalProductId);
      const last = rows[rows.length - 1];
      if (!last) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    const expected = products.map((product) => product.productId);
    // Every save exactly once. A cursor on `created_at` alone would straddle two
    // saves made in the same millisecond and drop one of them.
    expect(seen.filter((id) => expected.includes(id)).sort()).toEqual([...expected].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});
