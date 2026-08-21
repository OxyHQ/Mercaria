/**
 * The legacy-catalogue classification, reconciliation and path repair, against a
 * REAL Postgres server (#367 workstream 13).
 *
 * ## It runs on the SHARED suite database, and the cohort is what makes that work
 *
 * The first version of this file created its own throwaway database, because
 * every assertion here is census-shaped and the shared database carries every
 * sibling `*.realdb` file's fixtures. That was measured and rejected: it would
 * have been the SIXTH suite file to migrate a private database, the migrator
 * applies the whole 102-migration chain in one transaction holding a lock per
 * object it creates, and `max_locks_per_transaction × max_connections` on
 * `postgis/postgis:17-3.5`'s defaults is 64 × 100. Three full-suite runs with
 * the private database: one green, two with four files failing together on `out
 * of shared memory`. A control run with this file removed: 534/534 green, zero
 * lock failures. The private database was the tipping point.
 *
 * So the pass takes a COHORT — #60's, reused rather than redefined — and this
 * file files every fixture listing under one fixture STORE. The listing-grain
 * counts are then EXACT rather than floored, which matters more here than usual:
 * the subject of this suite is a report whose numbers somebody will act on, and
 * `>= 1` assertions would pass on a classifier that put every row in one bucket.
 *
 * Where a subject genuinely cannot be cohort-scoped, the assertion says so
 * rather than pretending:
 *
 * - **The vendor pass** is whole-catalogue by design (its grain is the
 *   normalized value, and a cohort-scoped aggregate produces groups that are not
 *   the real groups), so under a cohort it reports `not_in_this_pass` and the
 *   one `all` run below asserts FLOORS plus the presence of this file's own
 *   run-suffixed values.
 * - **`category_is_active_projection`** compares two columns of `categories`,
 *   which a listing predicate cannot narrow. It is asserted as a DELTA against
 *   the same probe moments earlier — and BOTH readings are taken inside one
 *   rolled-back `repeatable read` transaction, which is what makes the delta
 *   causal rather than merely adjacent. This paragraph used to claim the delta
 *   was "immune to whatever a sibling is doing" on the strength of the two
 *   readings being close together; that is not a property `read committed`
 *   has, and #843 is the measured counter-example.
 * - **`category_browse_count_agreement`** examines every published selectable
 *   category, but COUNTS through the cohort — so a category with none of this
 *   file's listings answers 0 = 0 and agrees. Its `diverged` is therefore exact
 *   while its `examined` is a floor.
 *
 * ## The fixture builds each state the way production reaches it
 *
 * A listing cannot be inserted onto a non-selectable node —
 * `mercaria_category_assignment_selectable` refuses it — so the fixture files
 * every listing under a live shelf and THEN changes the shelf: merges it,
 * deprecates it, suppresses it, un-publishes it, closes its window, or makes it
 * structural. That is exactly the sequence a real catalogue goes through, and it
 * means the fixture cannot accidentally create a state the database would not
 * allow.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { LegacyMappingReason } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { brandAliases, brands } from '../../../db/schema/organizations.js';
import { categories, listings } from '../../../db/schema/catalog.js';
import { stores } from '../../../db/schema/stores.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
} from '../../../db/schema/productTypes.js';
import {
  insertCategory,
  mergeCategory,
  moveCategory,
  setCategoryLifecycle,
} from '../../../db/taxonomy/taxonomyRepository.js';
import { normalizeEntityName } from '../../canonical/normalization.js';
import type { BackfillCohort } from '../../backfill/cohort.js';
import { ALL_COHORT } from '../../backfill/cohort.js';
import { countListingsBothWays } from '../../../db/catalogBackfill/legacyCatalogRepository.js';
import { runLegacyCatalogClassification } from '../classify.service.js';
import { runLegacyCatalogReconciliation } from '../reconciliation.service.js';
import { runLegacyCategoryPathRepair } from '../repair.service.js';

let db: Database;

/**
 * A per-run suffix on every key, slug, vendor string and product-type key.
 *
 * The database is shared and vitest runs files in parallel workers, so an
 * unsuffixed slug collides with a sibling's on a unique index and an unsuffixed
 * VENDOR string would let a sibling's brand turn this file's
 * `vendor_brand_no_candidate` into `vendor_brand_single_candidate` — a failure
 * that would name this file and be caused by another.
 */
const RUN = uuidv7().slice(-10).replace(/-/gu, '');

let storeId: string;
let cohort: BackfillCohort;
const categoryIds = new Map<string, string>();
const listingIds = new Map<string, string>();
/**
 * The one product-type version this file can delete afterwards.
 *
 * The two PUBLISHED ones cannot be — see {@link UNDELETABLE_CATEGORIES} — so
 * tracking all three in one list would produce a teardown that always fails.
 */
let draftProductTypeId: string | undefined;
const brandIds: string[] = [];

function categoryId(name: string): string {
  const id = categoryIds.get(name);
  if (id === undefined) throw new Error(`fixture category '${name}' was never created`);
  return id;
}

/** Insert one listing directly. The fixture is allowed to; production is not. */
async function seedListing(input: {
  readonly label: string;
  readonly categoryId?: string | null;
  readonly categorySlugs?: readonly string[];
  readonly productType?: string | null;
  readonly vendor?: string | null;
}): Promise<void> {
  const [row] = await db
    .insert(listings)
    .values({
      // Store-owned, because the cohort this file scopes every assertion by is
      // `store:<id>` — the slice a staged rollout actually addresses.
      ownerType: 'store',
      storeId,
      oxyUserId: null,
      title: `fixture ${input.label} ${RUN}`,
      description: 'fixture',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categoryId: input.categoryId ?? null,
      categorySlugs: [...(input.categorySlugs ?? [])],
      productType: input.productType ?? null,
      vendor: input.vendor ?? null,
    })
    .returning({ id: listings.id });
  if (!row) throw new Error(`seedListing('${input.label}') returned no row`);
  listingIds.set(input.label, row.id);
}

/** The reason tally, named so an assertion reads as the report an operator sees. */
function reasonsOf(tally: {
  readonly byReason: Readonly<Partial<Record<LegacyMappingReason, number>>>;
}): Readonly<Partial<Record<LegacyMappingReason, number>>> {
  return tally.byReason;
}

/** This file's fixture slugs, which are what its stored paths are built from. */
function slug(name: string): string {
  return `cbf-${RUN}-${name}`;
}

beforeAll(async () => {
  db = await connectPostgres();

  const [store] = await db
    .insert(stores)
    .values({
      handle: `cbf-${RUN}`,
      name: `Catalog backfill fixture ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!store) throw new Error('fixture store was not created');
  storeId = store.id;
  cohort = { kind: 'store', value: storeId };

  // --- the taxonomy -------------------------------------------------------
  // Every node starts published and selectable, because that is the only state
  // a listing may be filed under. The states under test are reached afterwards.
  for (const [name, parent] of [
    ['root', null],
    ['shelf', 'root'],
    ['structural', 'root'],
    ['mergedSrc', 'root'],
    ['mergedDead', 'root'],
    ['deprecated', 'root'],
    ['suppressed', 'root'],
    ['unpublished', 'root'],
    ['expired', 'root'],
    ['otherShelf', 'root'],
    ['movedParent', 'root'],
    ['movedChild', 'movedParent'],
    ['newParent', 'root'],
  ] as const) {
    const row = await insertCategory(
      {
        key: `cbf_${RUN}.${name.toLowerCase()}`,
        name: `${name} ${RUN}`,
        slug: slug(name),
        parentId: parent === null ? null : categoryId(parent),
      },
      db,
    );
    categoryIds.set(name, row.id);
  }

  // --- product types ------------------------------------------------------
  // Drafted, scoped, THEN published: a published version's authoring contract is
  // frozen by `mercaria_product_type_child_frozen`, so a scope added afterwards
  // is refused. That is the sequence an operator goes through too.
  const [smartphone] = await db
    .insert(productTypeDefinitions)
    .values({ key: `cbf_${RUN}_smartphone`, version: 1, lifecycle: 'draft', name: 'Smartphone' })
    .returning({ id: productTypeDefinitions.id });
  const [footwear] = await db
    .insert(productTypeDefinitions)
    .values({ key: `cbf_${RUN}_footwear`, version: 1, lifecycle: 'draft', name: 'Footwear' })
    .returning({ id: productTypeDefinitions.id });
  const [drafted] = await db
    .insert(productTypeDefinitions)
    .values({ key: `cbf_${RUN}_drafted`, version: 1, lifecycle: 'draft', name: 'Drafted' })
    .returning({ id: productTypeDefinitions.id });
  draftProductTypeId = drafted?.id;

  await db.insert(productTypeCategoryScopes).values([
    // Scoped to the shelf's PARENT with descendants, so the eligible case also
    // exercises the ancestry branch rather than only the direct one.
    { productTypeDefinitionId: smartphone?.id ?? '', categoryId: categoryId('root'), includeDescendants: true },
    // Scoped somewhere this file's listings are not.
    { productTypeDefinitionId: footwear?.id ?? '', categoryId: categoryId('otherShelf'), includeDescendants: false },
  ]);

  for (const version of [smartphone, footwear]) {
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'operator-1' })
      .where(eq(productTypeDefinitions.id, version?.id ?? ''));
  }

  // --- brands -------------------------------------------------------------
  const acmeName = `Acme ${RUN}`;
  const dupName = `Dup ${RUN}`;
  const aliasedName = `Aliased ${RUN}`;
  const inserted = await db
    .insert(brands)
    .values([
      { slug: `cbf-${RUN}-acme`, name: acmeName, normalizedName: normalizeEntityName(acmeName) },
      { slug: `cbf-${RUN}-dup-a`, name: dupName, normalizedName: normalizeEntityName(dupName) },
      { slug: `cbf-${RUN}-dup-b`, name: dupName, normalizedName: normalizeEntityName(dupName) },
      { slug: `cbf-${RUN}-aliased`, name: aliasedName, normalizedName: normalizeEntityName(aliasedName) },
    ])
    .returning({ id: brands.id });
  brandIds.push(...inserted.map((row) => row.id));
  // An ALIAS, so the alias lookup is exercised independently of the name one.
  await db
    .insert(brandAliases)
    .values({ brandId: inserted[3]?.id ?? '', alias: `OldName ${RUN}`, kind: 'former_name' });

  // --- listings -----------------------------------------------------------
  const shelfPath = [slug('root'), slug('shelf')];
  await seedListing({ label: 'current', categoryId: categoryId('shelf'), categorySlugs: shelfPath, productType: `cbf_${RUN}_Smartphone`, vendor: acmeName });
  await seedListing({ label: 'drifted', categoryId: categoryId('shelf'), categorySlugs: [slug('stale'), slug('shelf')], productType: 'Knitwear', vendor: `Nobody ${RUN} Ltd` });
  await seedListing({ label: 'structural', categoryId: categoryId('structural'), categorySlugs: [slug('root'), slug('structural')] });
  await seedListing({ label: 'mergedLive', categoryId: categoryId('mergedSrc'), categorySlugs: [slug('root'), slug('mergedSrc')] });
  await seedListing({ label: 'mergedDead', categoryId: categoryId('mergedDead'), categorySlugs: [slug('root'), slug('mergedDead')] });
  await seedListing({ label: 'deprecated', categoryId: categoryId('deprecated'), categorySlugs: [slug('root'), slug('deprecated')] });
  await seedListing({ label: 'suppressed', categoryId: categoryId('suppressed'), categorySlugs: [slug('root'), slug('suppressed')] });
  await seedListing({ label: 'unpublished', categoryId: categoryId('unpublished'), categorySlugs: [slug('root'), slug('unpublished')] });
  await seedListing({ label: 'expired', categoryId: categoryId('expired'), categorySlugs: [slug('root'), slug('expired')] });
  await seedListing({ label: 'uncategorized', categorySlugs: [] });
  await seedListing({ label: 'orphanPath', categorySlugs: [slug('ghost')] });
  await seedListing({ label: 'notEligible', categoryId: categoryId('shelf'), categorySlugs: shelfPath, productType: `cbf_${RUN}_Footwear` });
  await seedListing({ label: 'unpublishedType', categoryId: categoryId('shelf'), categorySlugs: shelfPath, productType: `cbf_${RUN}_Drafted` });
  await seedListing({ label: 'typeNoCategory', productType: `cbf_${RUN}_Smartphone`, vendor: dupName });
  await seedListing({ label: 'moved', categoryId: categoryId('movedChild'), categorySlugs: [slug('root'), slug('movedParent'), slug('movedChild')] });
  await seedListing({ label: 'aliasVendor', categoryId: categoryId('shelf'), categorySlugs: shelfPath, vendor: `OldName ${RUN}` });
  await seedListing({ label: 'punctuationVendor', categoryId: categoryId('shelf'), categorySlugs: shelfPath, vendor: '!!!' });

  // --- and only now, the states the classifier is about -------------------
  await mergeCategory(categoryId('mergedSrc'), categoryId('shelf'), db);
  await mergeCategory(categoryId('mergedDead'), categoryId('deprecated'), db);
  await setCategoryLifecycle(categoryId('deprecated'), 'deprecated', db);
  await setCategoryLifecycle(categoryId('suppressed'), 'suppressed', db);
  await setCategoryLifecycle(categoryId('unpublished'), 'draft', db);
  await db
    .update(categories)
    .set({ selectable: false })
    .where(eq(categories.id, categoryId('structural')));
  await db
    .update(categories)
    .set({ effectiveTo: new Date('2020-01-01T00:00:00.000Z') })
    .where(eq(categories.id, categoryId('expired')));
}, 180_000);

/**
 * The taxonomy nodes this file can delete, LEAF-FIRST.
 *
 * `categories.parent_id`, `merged_into_category_id` and both of
 * `category_redirects`' foreign keys are all `restrict`, so the order is a real
 * dependency order rather than a tidy one, and nothing here is wrapped in a
 * `catch` — a swallowed `23503` would hide a genuine children-first mistake as
 * surely as it hides this file's known ones.
 */
const DELETABLE_CATEGORIES = [
  'movedChild',
  'movedParent',
  'newParent',
  'structural',
  'suppressed',
  'unpublished',
  'expired',
] as const;

/**
 * The six that CANNOT be deleted, and why — stated rather than left to look like
 * an oversight. Each is pinned by a rule this epic put there ON PURPOSE:
 *
 * - `mergedSrc` and `mergedDead` are `category_redirects` SUBJECTS and `shelf`
 *   and `deprecated` are its TARGETS. `mergeCategory` writes that row in the
 *   same transaction, the table is append-only by trigger, and both of its
 *   foreign keys are `restrict` — a merge that could be un-merged by deleting a
 *   redirect would be a 404 for every link anybody published.
 * - `otherShelf` is cited by a PUBLISHED product-type version's category scope,
 *   and `root` by another. `mercaria_product_type_definition_immutable` refuses
 *   to delete a published version at all ("authored records cite this version"),
 *   so its scopes outlive it and pin their categories.
 * - `root` is additionally the parent of the four above.
 *
 * They survive the file; the shared suite database is thrown away when the run
 * ends, every one of them carries this file's run suffix, and no sibling asserts
 * an exact census over `categories` (the one that reads roots uses `toContain`).
 */
const UNDELETABLE_CATEGORIES = [
  'mergedSrc',
  'mergedDead',
  'shelf',
  'deprecated',
  'otherShelf',
  'root',
] as const;

afterAll(async () => {
  // Exactly what this file created, children first. A `delete from listings`
  // here would empty a sibling's fixture mid-run.
  if (db === undefined) return;
  const ids = [...listingIds.values()];
  if (ids.length > 0) await db.delete(listings).where(inArray(listings.id, ids));

  // Only the DRAFT product type: `mercaria_product_type_definition_immutable`
  // refuses to delete a published version, which is ADR 0007 D5's whole point —
  // a published schema is what an author's answers were recorded against.
  if (draftProductTypeId !== undefined) {
    await db
      .delete(productTypeDefinitions)
      .where(eq(productTypeDefinitions.id, draftProductTypeId));
  }
  if (brandIds.length > 0) await db.delete(brands).where(inArray(brands.id, brandIds));

  for (const name of DELETABLE_CATEGORIES) {
    await db.delete(categories).where(eq(categories.id, categoryId(name)));
  }
  // The partition is total: every fixture node is in exactly one of the two
  // lists, so a node added to the fixture later fails here rather than being
  // silently left behind.
  expect(DELETABLE_CATEGORIES.length + UNDELETABLE_CATEGORIES.length).toBe(categoryIds.size);

  // Through the shared helper rather than a direct deletion of the store table:
  // a backfill pass links EVERY active store in the shared database and
  // `native_store_links.store_id` is `ON DELETE RESTRICT`, so a bare deletion
  // here can be refused by a row another file's fixture caused.
  // `store-teardown-census.test.ts` fails the build on any other spelling — and
  // it does NOT strip comments, so the statement shape is described here rather
  // than quoted, which is how this comment first named its own file as an
  // offender.
  if (storeId !== undefined) await deleteTestStores(db, [storeId]);
  await closePostgres();
}, 120_000);

describe('the classification pass', () => {
  it('classifies every category assignment state exactly once', async () => {
    const report = await runLegacyCatalogClassification(db, { cohort, listingLimit: 500 });

    // Exact, because the cohort is this file's own store.
    expect(report.coverage.listingsTotal).toBe(17);
    expect(report.coverage.withCategory).toBe(14);
    expect(report.coverage.withoutCategory).toBe(3);
    expect(report.coverage.withProductTypeText).toBe(5);
    expect(report.coverage.withVendorText).toBe(5);
    expect(report.scannedListings).toBe(17);
    expect(report.resumeAfterListingId).toBeNull();

    const assignment = report.bySubject.listing_category_assignment;
    expect(assignment.state).toBe('tallied');
    if (assignment.state !== 'tallied') return;

    expect(reasonsOf(assignment.tally)).toEqual({
      category_assignment_current: 7,
      category_assignment_merged_target_live: 1,
      category_assignment_merge_chain_unresolved: 1,
      category_assignment_not_selectable: 1,
      category_assignment_deprecated: 1,
      category_assignment_suppressed: 1,
      category_assignment_unpublished_node: 1,
      category_assignment_outside_effective_window: 1,
      category_assignment_absent: 3,
    });
    expect(assignment.tally.scanned).toBe(17);
    // 7 current + 1 merged-with-a-live-target are deterministic; the five
    // no-successor states plus the unresolved chain are ambiguous; the three
    // uncategorized listings have nothing to map.
    expect(assignment.tally.byClass).toEqual({
      deterministic: 8,
      high_confidence: 0,
      ambiguous: 6,
      invalid: 0,
      not_applicable: 3,
    });
    expect(assignment.tally.actionable).toBe(7);
    expect(assignment.tally.awaitingReview).toEqual({
      automatic: 1,
      catalog_operator: 5,
      merchant: 1,
      none: 10,
    });
  });

  it('finds exactly the paths that drifted', async () => {
    const report = await runLegacyCatalogClassification(db, { cohort, listingLimit: 500 });
    const path = report.bySubject.listing_category_path;
    expect(path.state).toBe('tallied');
    if (path.state !== 'tallied') return;

    expect(reasonsOf(path.tally)).toEqual({
      category_path_agrees: 13,
      category_path_drifted: 1,
      category_path_absent_without_category: 2,
      category_path_present_without_category: 1,
    });
  });

  it('classifies legacy product-type text without inventing a key', async () => {
    const report = await runLegacyCatalogClassification(db, { cohort, listingLimit: 500 });
    const productType = report.bySubject.listing_product_type_text;
    expect(productType.state).toBe('tallied');
    if (productType.state !== 'tallied') return;

    expect(reasonsOf(productType.tally)).toEqual({
      product_type_text_absent: 12,
      product_type_key_published_and_eligible: 1,
      product_type_key_published_not_eligible: 1,
      product_type_key_unpublished: 1,
      product_type_key_category_unknown: 1,
      // `Knitwear` folds to `knitwear`, which no version answers to. That is the
      // correct outcome and the backlog IS the deliverable — resolving it would
      // be the false merge ADR 0007 D6 names.
      product_type_no_registered_key: 1,
    });
  });

  it('reports the vendor pass as out of scope under a cohort, and classifies it under `all`', async () => {
    const scoped = await runLegacyCatalogClassification(db, { cohort, listingLimit: 500 });
    expect(scoped.bySubject.listing_vendor_text.state).toBe('not_in_this_pass');

    // Whole-catalogue, so the assertions are FLOORS plus this file's own
    // run-suffixed values. Every vendor string here carries `RUN`, so a sibling
    // cannot turn one of these verdicts into another.
    const all = await runLegacyCatalogClassification(db, { cohort: ALL_COHORT, listingLimit: 1 });
    const vendor = all.bySubject.listing_vendor_text;
    expect(vendor.state).toBe('tallied');
    if (vendor.state !== 'tallied') return;

    // Five distinct vendor strings across seventeen listings — the grain is the
    // value, so one name on two listings is still one decision.
    expect(vendor.tally.scanned).toBeGreaterThanOrEqual(5);
    expect(vendor.tally.byReason.vendor_brand_single_candidate ?? 0).toBeGreaterThanOrEqual(2);
    expect(vendor.tally.byReason.vendor_brand_multiple_candidates ?? 0).toBeGreaterThanOrEqual(1);
    expect(vendor.tally.byReason.vendor_brand_no_candidate ?? 0).toBeGreaterThanOrEqual(1);
    expect(vendor.tally.byReason.vendor_text_unnormalizable ?? 0).toBeGreaterThanOrEqual(1);
    expect(vendor.tally.byClass.high_confidence).toBeGreaterThanOrEqual(2);
    // Every one of them waits for a person. A normalized-name match is a
    // candidate, never identity — so this bucket is exactly zero whatever else
    // is in the catalogue.
    expect(vendor.tally.awaitingReview.automatic).toBe(0);
  });

  it('names the option subjects as classified elsewhere rather than tallying them', async () => {
    const report = await runLegacyCatalogClassification(db, { cohort, listingLimit: 500 });
    expect(report.bySubject.listing_option_name).toEqual({
      state: 'classified_elsewhere',
      classifier: 'variant_axes',
    });
    expect(report.bySubject.variant_option_value).toEqual({
      state: 'classified_elsewhere',
      classifier: 'variant_axes',
    });
    // The backlog is QUOTED from step 4's own queue rather than recomputed, and
    // it is whole-catalogue by design — so the assertion is on its SHAPE (every
    // bucket of both vocabularies present) rather than on a sibling's numbers.
    expect(Object.keys(report.retainedClaims.byAttributeRefusal).length).toBeGreaterThan(0);
    expect(Object.keys(report.retainedClaims.byValueRefusal).length).toBeGreaterThan(0);
    expect(report.retainedClaims.queued).toBeGreaterThanOrEqual(0);
  });

  it('pages, and reaches every listing in the cohort exactly once', async () => {
    const first = await runLegacyCatalogClassification(db, { cohort, listingLimit: 5 });
    expect(first.scannedListings).toBe(5);
    expect(first.resumeAfterListingId).not.toBeNull();

    // Walking the cohort five at a time reaches every listing exactly once — the
    // independent check on the keyset, taken from the pager rather than from the
    // same expression the pager used.
    let cursor: string | null = null;
    let seen = 0;
    for (let page = 0; page < 20; page += 1) {
      const report: Awaited<ReturnType<typeof runLegacyCatalogClassification>> =
        await runLegacyCatalogClassification(db, {
          cohort,
          listingLimit: 5,
          afterListingId: cursor,
        });
      seen += report.scannedListings;
      cursor = report.resumeAfterListingId;
      if (cursor === null) break;
    }
    expect(seen).toBe(17);
  });
});

describe('the vacuity floor', () => {
  it('THROWS when a first page classifies nothing over a non-empty cohort', async () => {
    // The positive control, and the one that matters: a pager that returned
    // nothing prints the same zeros as a finished migration, and
    // `resumeAfterListingId: null` then tells an operator there is nothing left
    // to do. Driven with a zero limit, which is what a broken keyset looks like
    // from outside the service.
    await expect(
      runLegacyCatalogClassification(db, { cohort, listingLimit: 0 }),
    ).rejects.toThrow(/the pager is broken/iu);
    await expect(runLegacyCategoryPathRepair(db, { cohort, listingLimit: 0 })).rejects.toThrow(
      /the pager is broken/iu,
    );
    await expect(
      runLegacyCatalogReconciliation(db, { cohort, listingLimit: 0 }),
    ).rejects.toThrow(/the pager is broken/iu);
  });

  it('does not throw on a resumed page, or on a cohort that is genuinely empty', async () => {
    const [last] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.storeId, storeId))
      .orderBy(sql`${listings.id} desc`)
      .limit(1);
    expect(last, 'the fixture wrote no listings').toBeDefined();

    // With a cursor, the pass is NOT a first page and is allowed to be empty —
    // that is a finished walk, not a broken one.
    const resumed = await runLegacyCatalogClassification(db, {
      cohort,
      afterListingId: last?.id ?? '',
      listingLimit: 5,
    });
    expect(resumed.scannedListings).toBe(0);

    // The negative control on the control: over a cohort that genuinely holds
    // nothing, a first page of zero is correct and must NOT throw. Without this,
    // a floor that fired unconditionally would look identical from out here.
    const emptyCohort: BackfillCohort = { kind: 'store', value: uuidv7() };
    const empty = await runLegacyCatalogClassification(db, {
      cohort: emptyCohort,
      listingLimit: 5,
    });
    expect(empty.coverage.listingsTotal).toBe(0);
    expect(empty.scannedListings).toBe(0);
  });
});

describe('the reconciliation probes', () => {
  it('finds the drift a category MOVE leaves behind, from both sides', async () => {
    const before = await runLegacyCatalogReconciliation(db, { cohort, listingLimit: 500 });
    const beforePath = before.probes.find(
      (probe) => probe.probe === 'listing_category_path_projection',
    );
    expect(beforePath?.examined, 'the probe measured nothing').toBe(14);
    // The one deliberately-drifted fixture listing, and nothing else yet.
    expect(beforePath?.diverged).toBe(1);

    const browseBefore = before.probes.find(
      (probe) => probe.probe === 'category_browse_count_agreement',
    );
    // `examined` is whole-catalogue and therefore a FLOOR; `diverged` is exact,
    // because the counts run through the cohort and a category holding none of
    // this file's listings answers 0 = 0.
    expect(browseBefore?.examined, 'the browse probe measured nothing').toBeGreaterThanOrEqual(7);
    expect(browseBefore?.diverged).toBe(1);

    // `moveCategory` rewrites `categories.ancestor_slugs` for the whole subtree
    // and touches no listing. This is the silent failure the probe exists for.
    await moveCategory(categoryId('movedParent'), categoryId('newParent'), db);

    const after = await runLegacyCatalogReconciliation(db, { cohort, listingLimit: 500 });
    const afterPath = after.probes.find(
      (probe) => probe.probe === 'listing_category_path_projection',
    );
    expect(afterPath?.diverged, 'a move must leave its subtree’s listings stale').toBe(2);
    expect(afterPath?.sample).toContain(listingIds.get('moved'));

    const browseAfter = after.probes.find(
      (probe) => probe.probe === 'category_browse_count_agreement',
    );
    expect(browseAfter?.diverged).toBe(2);
    expect(browseAfter?.sample).toContain(categoryId('newParent'));

    // And the comparison the probe makes, taken directly on the moved node, so
    // the assertion does not rest on this file's row landing inside a bounded
    // sample.
    const counts = await countListingsBothWays(
      db,
      { id: categoryId('newParent'), slug: slug('newParent') },
      cohort,
    );
    expect(counts).toEqual({ viaSlugPath: 0, viaCategoryTree: 1 });
  });

  it('finds `is_active` and `lifecycle` in step, and notices when they are not', async () => {
    // Mutation-tested: the repository keeps these in step and NOTHING in the
    // database does, so a second writer would produce exactly this row. The
    // mutation is asserted to have LANDED before the detector is asserted to
    // fire, and the detector's result is asserted outside the rollback — a
    // `rejects.toThrow()` around the whole transaction would make a failed inner
    // assertion indistinguishable from the deliberate rollback.
    //
    // ## Both readings share ONE snapshot, and that is load-bearing (#843)
    //
    // `category_is_active_projection` is deliberately WHOLE-CATALOGUE: a listing
    // predicate cannot narrow a comparison between two columns of `categories`,
    // so the mutation is asserted as a DELTA rather than as an absolute. A delta
    // over the whole catalogue is only a measurement of what THIS file did if
    // nothing else moves between the two readings, and the test database is
    // shared across parallel files. At PostgreSQL's default `read committed`
    // every statement takes a fresh snapshot, so a sibling committing a
    // divergent `categories` row between the readings lands in the delta —
    // measured, as `expected 2 to be 1`, once in three consecutive full-suite
    // runs on an unchanged tree. The concrete second writer was
    // `search-intent/__tests__/category-alias.realdb.test.ts`, which commits
    // `is_active = false` against a row whose `lifecycle` stays `'published'`
    // for the width of one `try`; but naming that file is not the fix, because
    // the next such writer has not been written yet.
    //
    // At `repeatable read` every statement in the transaction reads the snapshot
    // taken by the first one, so everybody else's catalogue is frozen for the
    // duration while this transaction's own write stays visible to it. The delta
    // is then exactly what this file did. Write conflicts cannot arise — the row
    // touched carries a per-run id no other file can mint — and the transaction
    // is rolled back regardless. This is the idiom the five
    // `catalog-observability` realdb files already use for the same reason.
    const target = categoryId('shelf');
    let clean: Awaited<ReturnType<typeof runLegacyCatalogReconciliation>> | undefined;
    let dirty: Awaited<ReturnType<typeof runLegacyCatalogReconciliation>> | undefined;
    try {
      await db.transaction(
        async (tx) => {
          // The snapshot IS the mechanism, so it is asserted from the SERVER
          // rather than trusted from the argument below. Dropping
          // `isolationLevel` makes this line fail on every run, instead of
          // making the delta pass two runs in three — which is how it got here.
          const [isolation] = await tx.execute<{ readonly transaction_isolation: string }>(
            sql`show transaction_isolation`,
          );
          expect(
            isolation?.transaction_isolation,
            'both readings must be taken in ONE snapshot',
          ).toBe('repeatable read');

          clean = await runLegacyCatalogReconciliation(tx, { cohort, listingLimit: 500 });
          const updated = await tx
            .update(categories)
            .set({ isActive: false })
            .where(eq(categories.id, target))
            .returning({ id: categories.id });
          if (updated.length !== 1) throw new Error('the mutation did not land');
          dirty = await runLegacyCatalogReconciliation(tx, { cohort, listingLimit: 500 });
          tx.rollback();
        },
        { isolationLevel: 'repeatable read' },
      );
      throw new Error('the transaction did not roll back');
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
    const cleanProbe = clean?.probes.find((p) => p.probe === 'category_is_active_projection');
    const dirtyProbe = dirty?.probes.find((p) => p.probe === 'category_is_active_projection');
    expect(cleanProbe?.examined, 'the probe measured nothing').toBeGreaterThanOrEqual(13);
    // The POPULATION must not move either, or the delta could have come from a
    // scan that grew rather than from the mutation. Under `read committed` this
    // is exactly what a sibling inserting a category between the readings does;
    // under one snapshot it cannot happen, so this asserts the snapshot itself.
    expect(dirtyProbe?.examined, 'the catalogue moved between the two readings').toBe(
      cleanProbe?.examined,
    );
    expect((dirtyProbe?.diverged ?? 0) - (cleanProbe?.diverged ?? 0)).toBe(1);
  });
});

describe('the category-path repair', () => {
  it('changes nothing in a dry run, and reports what an apply would do', async () => {
    const before = await db
      .select({ id: listings.id, categorySlugs: listings.categorySlugs })
      .from(listings)
      .where(eq(listings.id, listingIds.get('drifted') ?? ''));

    const dry = await runLegacyCategoryPathRepair(db, { cohort, listingLimit: 500 });
    expect(dry.mode).toBe('dry_run');
    // Two drifted (the fixture's own, plus the moved subtree from the probe
    // above) and one orphaned path to clear.
    expect(dry.pathsRewritten).toBe(2);
    expect(dry.pathsCleared).toBe(1);
    expect(dry.scannedListings).toBe(17);

    const after = await db
      .select({ id: listings.id, categorySlugs: listings.categorySlugs })
      .from(listings)
      .where(eq(listings.id, listingIds.get('drifted') ?? ''));
    expect(after, 'a dry run wrote something').toEqual(before);
  });

  it('re-derives the drifted paths, and converges on a second pass', async () => {
    const applied = await runLegacyCategoryPathRepair(db, {
      mode: 'apply',
      cohort,
      listingLimit: 500,
    });
    expect(applied.pathsRewritten).toBe(2);
    expect(applied.pathsCleared).toBe(1);

    const [repaired] = await db
      .select({ categorySlugs: listings.categorySlugs })
      .from(listings)
      .where(eq(listings.id, listingIds.get('drifted') ?? ''));
    expect(repaired?.categorySlugs).toEqual([slug('root'), slug('shelf')]);

    const [moved] = await db
      .select({ categorySlugs: listings.categorySlugs })
      .from(listings)
      .where(eq(listings.id, listingIds.get('moved') ?? ''));
    expect(moved?.categorySlugs).toEqual([
      slug('root'),
      slug('newParent'),
      slug('movedParent'),
      slug('movedChild'),
    ]);

    const [orphan] = await db
      .select({ categorySlugs: listings.categorySlugs })
      .from(listings)
      .where(eq(listings.id, listingIds.get('orphanPath') ?? ''));
    expect(orphan?.categorySlugs).toEqual([]);

    // Idempotent: a second pass issues no statements and says so. This is what
    // makes "roll it back by running it again" true rather than hoped for.
    const second = await runLegacyCategoryPathRepair(db, {
      mode: 'apply',
      cohort,
      listingLimit: 500,
    });
    expect(second.pathsRewritten).toBe(0);
    expect(second.pathsCleared).toBe(0);
    expect(second.pathsAgreed).toBe(14);

    // And the reconciliation probes agree, taken independently of the repair's
    // own counters.
    const reconciled = await runLegacyCatalogReconciliation(db, { cohort, listingLimit: 500 });
    const path = reconciled.probes.find(
      (probe) => probe.probe === 'listing_category_path_projection',
    );
    expect(path?.diverged).toBe(0);
    expect(path?.examined).toBe(14);
    const browse = reconciled.probes.find(
      (probe) => probe.probe === 'category_browse_count_agreement',
    );
    expect(browse?.diverged).toBe(0);
  });
});
