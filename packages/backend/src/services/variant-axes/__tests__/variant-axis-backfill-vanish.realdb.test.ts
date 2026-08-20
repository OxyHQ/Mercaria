/**
 * A listing deleted MID-PASS costs one listing, never the resume cursor (#612 B).
 *
 * ## The race, and why it is a real one rather than two sequential calls
 *
 * `runVariantAxisBackfill` reads its page on the ROOT connection and then opens
 * one transaction PER LISTING. So there is a real window between "the pager saw
 * this listing" and "this listing's writes run", and in production a seller
 * deleting a listing lands in it. Every child write then fails its foreign key,
 * and before #612 the loop rethrew — which loses the whole REPORT, and with it
 * `resumeAfterListingId`. The operator loses the CURSOR rather than one listing,
 * and a resumed pass cannot tell that from a completed one.
 *
 * The window is pinned by LOCK ORDERING, not by a sleep:
 *
 *  1. A transaction on one pooled connection DELETEs the listing and is then
 *     held open. Uncommitted, so the pager still sees the row — which is exactly
 *     the production state.
 *  2. The pass starts. Its first write for that listing is a
 *     `native_listing_attribute_claims` insert, whose foreign key takes a lock on
 *     the parent row — and BLOCKS against the uncommitted delete.
 *  3. The test waits until Postgres itself reports a session waiting on a lock,
 *     then commits the delete. The blocked insert re-checks and fails `23503`.
 *
 * Step 3 is the POSITIVE CONTROL on the race. A `Promise.all` over two calls that
 * did not actually overlap passes for the same reason a working lock does, so
 * without observing the block this file would be green whether or not the race
 * ever happened. `waitForBlockedSession` FAILS the test if nothing ever blocked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  listingOptions,
  listings,
  productVariantOptionValues,
  productVariants,
} from '../../../db/schema/catalog.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
  attributeEnumValues,
  attributeReindexRequests,
  attributeValueAliases,
} from '../../../db/schema/attributeRegistry.js';
import { listListingIdsWithLegacyOptions } from '../../../db/variantAxes/legacyOptionRepository.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import { runVariantAxisBackfill } from '../backfill.service.js';
import { reportPopulation } from '../../../__tests__/report-population.js';

let db: Database;

const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `axis-vanish-operator-${RUN}`;

/**
 * Sorts after every id a sibling can mint — `generatedId()` is a uuid v7 whose
 * leading field is the current millisecond, so every real id begins `0…`. The
 * `variant-axis-backfill-apply.realdb.test.ts` device, for the same reason: an
 * apply pass writes to every listing on its page.
 */
const TAIL_PREFIX = 'ffffffff-ffff-7fff-8fff-';
const PAGE_CURSOR = `${TAIL_PREFIX}${RUN.slice(0, 11)}0`;
const LISTING_ID = `${TAIL_PREFIX}${RUN.slice(0, 11)}1`;

const COLOR_KEY = `axis_vanish_${RUN}`.toLowerCase();
const COLOR_NAME = `Axis Vanish ${RUN}`;
const CREATED_KEYS = [COLOR_KEY];

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // The listing is deleted BY the test; this is the belt-and-braces path for a
  // run that failed before the delete committed.
  await db.delete(listings).where(eq(listings.id, LISTING_ID));
  const definitionIds = (
    await db
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(inArray(attributeDefinitions.key, CREATED_KEYS))
  ).map((row) => row.id);
  if (definitionIds.length > 0) {
    await db
      .delete(attributeReindexRequests)
      .where(inArray(attributeReindexRequests.attributeKey, CREATED_KEYS));
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
      .where(inArray(attributeDefinitions.id, definitionIds));
    await db
      .delete(attributeValueAliases)
      .where(inArray(attributeValueAliases.attributeDefinitionId, definitionIds));
    await db
      .delete(attributeEnumValues)
      .where(inArray(attributeEnumValues.attributeDefinitionId, definitionIds));
    await db
      .delete(attributeDefinitionCategories)
      .where(inArray(attributeDefinitionCategories.attributeDefinitionId, definitionIds));
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, definitionIds));
  }
  await closePostgres();
});

/**
 * Block until Postgres reports a session waiting on a lock, or FAIL.
 *
 * Asking the server rather than sleeping is what makes the window deterministic:
 * the commit below happens because the pass is provably blocked, not because a
 * timeout guessed that it might be.
 */
async function waitForBlockedSession(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting
      from pg_stat_activity
      where wait_event_type = 'Lock'
        and datname = current_database()
        and pid <> pg_backend_pid()
    `);
    if (([...rows][0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'variant-axis vanish test: no session ever blocked on a lock, so the pass and the delete ' +
      'never overlapped. The race did not happen and this file would be measuring nothing.',
  );
}

describe('a listing deleted mid-pass', () => {
  it('costs one listing and NOT the resume cursor', async () => {
    await draftAttributeDefinition({
      key: COLOR_KEY,
      label: 'Axis vanish colour',
      valueType: 'enum',
      variantDefining: true,
      enumValues: [{ value: 'red', label: 'Red', aliases: ['Rojo'] }],
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(COLOR_KEY, 1, OPERATOR);

    await db.insert(listings).values({
      id: LISTING_ID,
      ownerType: 'user',
      oxyUserId: `axis-vanish-seller-${RUN}`,
      storeId: null,
      title: `Axis vanish ${RUN}`,
      description: 'A fixture listing this test deletes while the pass is running.',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categorySlugs: [],
      tags: [],
    });
    await db
      .insert(listingOptions)
      .values([{ listingId: LISTING_ID, name: COLOR_NAME, values: ['Rojo'], position: 0 }]);
    const inserted = await db
      .insert(productVariants)
      .values([{ listingId: LISTING_ID, title: 'Rojo', position: 0 }])
      .returning({ id: productVariants.id });
    await db
      .insert(productVariantOptionValues)
      .values([{ variantId: inserted[0].id, name: COLOR_NAME, value: 'Rojo', position: 0 }]);

    // The pager's own answer, before anything is written — this is what aims the
    // pass at this file's listing and nothing else.
    const page = await listListingIdsWithLegacyOptions(db, {
      afterListingId: PAGE_CURSOR,
      limit: 1,
    });
    expect(page.listingIds, 'the test is not aimed at its own listing').toEqual([LISTING_ID]);

    // 1. Delete the listing and HOLD the transaction open. Uncommitted, so the
    //    pager below still sees the row.
    let commitDelete!: () => void;
    const held = new Promise<void>((resolve) => {
      commitDelete = resolve;
    });
    const deleteTransaction = db.transaction(async (tx) => {
      await tx.delete(listings).where(eq(listings.id, LISTING_ID));
      await held;
    });

    // 2. Start the pass. Its first write for this listing blocks on the lock.
    const pass = runVariantAxisBackfill(db, {
      mode: 'apply',
      afterListingId: PAGE_CURSOR,
      listingLimit: 1,
    });

    // 3. Only once the server says something is waiting.
    await waitForBlockedSession();
    commitDelete();
    await deleteTransaction;

    // The property: the pass RESOLVES rather than throwing, and the report — the
    // only carrier of the cursor — comes back.
    const report = await pass;
    reportPopulation(
      `[vanish] listingsVanishedDuringPass=${report.diagnostics.listingsVanishedDuringPass} ` +
        `scanned.listings=${report.scanned.listings} ` +
        `resumeAfterListingId=${String(report.resumeAfterListingId)}`,
    );

    expect(report.diagnostics.listingsVanishedDuringPass).toBe(1);
    // It WAS on the page, so it is scanned — which is also what keeps
    // `assertReportSums`' pager positive control from being defeated by a vanish.
    expect(report.scanned.listings).toBe(1);
    // And it contributed NO outcomes, so the sums hold. `assertReportSums` runs
    // inside the call above and would have thrown otherwise; these pin the
    // restore rather than trusting that.
    expect(report.scanned.listingOptions).toBe(0);
    expect(report.scanned.variantOptionValues).toBe(0);
    expect(report.axes).toEqual({ declared: 0, alreadyDeclared: 0, unresolved: 0 });
  }, 120_000);
});
