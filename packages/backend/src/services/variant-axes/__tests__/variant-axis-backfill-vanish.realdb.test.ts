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
 *  1. A transaction on a backend of its OWN DELETEs the listing and is then held
 *     open. Uncommitted, so the pager still sees the row — which is exactly the
 *     production state. Its own backend so that its pid is knowable; see step 3.
 *  2. The pass starts. Its first write for that listing is a
 *     `native_listing_attribute_claims` insert, whose foreign key takes a lock on
 *     the parent row — and BLOCKS against the uncommitted delete.
 *  3. The test waits until Postgres reports a session blocked BY THIS FILE'S OWN
 *     delete, then commits it. The blocked insert re-checks and fails `23503`.
 *
 * Step 3 is the POSITIVE CONTROL on the race, and its SCOPE is the whole of it
 * (#795). A `Promise.all` over two calls that did not actually overlap passes for
 * the same reason a working lock does, so without observing a block this file
 * would be green whether or not the race ever happened — but an observation that
 * counts ANY lock wait in the database is satisfied by a STRANGER. The test
 * database is shared by every parallel file, and a sampler over one full run
 * measured a session in `wait_event_type = 'Lock'` for 22.8% of its wall clock
 * (304 of 1331 samples at 50ms), 432 of those observations on
 * `select pg_advisory_lock($1)` — #63's global matching-policy slot, held for a
 * whole file's run while the next file queues behind it.
 *
 * What a stranger costs is not the failure anybody would guess. The commit lands
 * EARLY, between the pass's PAGE read and its read of that listing's children:
 * the listing is still scanned, the cascade has already removed
 * `listing_options` and `product_variants`, so the pass finds nothing to write,
 * violates no foreign key, and returns a perfectly consistent report whose
 * `listingsVanishedDuringPass` is 0. Measured signature: `expected +0 to be 1`.
 *
 * So the wait NAMES ITS OWN HOLDER — `pg_blocking_pids` against the delete's own
 * backend, the `canonical-teardown` / `concurrent-publish` idiom — and it tells
 * the two failures apart, because only one of them is a bug in the code under
 * test: a pass that FINISHED without ever blocking is a race that did not happen,
 * and a deadline reached while the pass is still running is a loaded server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase, uuidv7 } from '@oxyhq/db';
import type postgres from 'postgres';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import * as schema from '../../../db/schema/index.js';
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

/**
 * A handle whose every statement runs on ONE backend, so its pid is knowable and
 * `pg_blocking_pids` can be asked about it by name.
 *
 * `max: 1` is what makes that true, and it also keeps this file's own two
 * long-lived sessions off the pooled `db` the pass itself has to draw from —
 * the test contributing to the contention it is sensitive to.
 */
interface SoloConnection {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly pid: number;
}

const soloConnections: SoloConnection[] = [];

/** Holds the DELETE open. Its pid is what the wait below is scoped to. */
let deleter: SoloConnection;
/** Reads `pg_blocking_pids`, and is never itself a participant. */
let probe: SoloConnection;

async function openSolo(): Promise<SoloConnection> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('vitest.pg.globalSetup did not publish DATABASE_URL');
  }
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 1, onnotice: () => undefined },
  });
  const rows = await instance.client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('the solo connection did not report a backend pid');
  const solo: SoloConnection = { db: instance.db, client: instance.client, pid };
  soloConnections.push(solo);
  return solo;
}

/**
 * How long the pass is given to reach its first child insert and block.
 *
 * Generous rather than tuned: with the wait scoped to this file's own delete,
 * the only thing that can consume it is a server too loaded to run five round
 * trips, and the ceiling exists so that case arrives as a NAMED failure well
 * inside the 120s test timeout rather than as vitest's generic one.
 */
const BLOCK_WAIT_MS = 60_000;

/** Poll interval for that wait. */
const BLOCK_POLL_MS = 25;

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
  deleter = await openSolo();
  probe = await openSolo();
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
  for (const solo of soloConnections) await solo.client.end({ timeout: 5 });
  await closePostgres();
});

/**
 * Block until Postgres reports a session blocked BY the held delete, or FAIL.
 *
 * Asking the server rather than sleeping is what makes the window deterministic:
 * the commit below happens because the pass is provably blocked, not because a
 * timeout guessed that it might be. `pg_blocking_pids` and not a bare
 * `wait_event_type = 'Lock'` count, because the second is a question about the
 * whole shared database and this file may only act on an answer about itself.
 *
 * The waiter cannot be named the way `canonical-teardown.realdb.test.ts` names
 * one: the pass runs on the pooled `db`, so which backend serves its per-listing
 * transaction is not knowable in advance. The HOLDER is, which is the direction
 * that scopes the observation — nothing else in the database contends for this
 * fixture's row, whose id is minted per run.
 *
 * ONE HOP is enough HERE and is not enough in general, which is worth stating
 * because `connector-pin-release.realdb.test.ts` measured the other half and a
 * reader who knows that file will ask. Row-lock waiters CHAIN — the second
 * queues behind the FIRST WAITER rather than behind the holder — so a one-hop
 * containment count reports the head of the queue however many are lined up.
 * Re-measured for this file: holder plus two waiters gives one hop = 1 and the
 * recursive form = 2. This wait asks `> 0` and the head of the queue is always
 * blocked by the holder directly, and only one session ever contends for this
 * fixture's row anyway. A barrier that must see TWO waiters needs
 * `connector-pin-release`'s recursive CTE; do not copy this shape into one.
 *
 * `passSettled` is what separates the two failures the old unscoped wait
 * collapsed onto one red. A pass cannot finish while it is blocked, so a settled
 * pass is proof the race never happened; a deadline reached with the pass still
 * running is a loaded server and says so.
 */
async function waitUntilPassBlocksOnTheHeldDelete(passSettled: () => boolean): Promise<void> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  for (;;) {
    const rows = await probe.client<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and ${deleter.pid}::int = any(pg_blocking_pids(pid))
    `;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    if (passSettled()) {
      throw new Error(
        'variant-axis vanish test: the pass finished without ever blocking on the held delete, ' +
          'so the two never overlapped. The race did not happen and this file would be ' +
          'measuring nothing.',
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `variant-axis vanish test: the pass was still running after ${String(BLOCK_WAIT_MS)}ms ` +
          `but was never seen blocked by backend ${String(deleter.pid)}, which is holding the ` +
          'delete. That is a LOADED SERVER, not a race that failed to happen — the two are ' +
          'different failures and this file will not report them as one.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
  }
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

    // 1. Delete the listing and HOLD the transaction open, on a backend of its
    //    own so the wait below can name it. Uncommitted, so the pager still sees
    //    the row.
    let commitDelete!: () => void;
    const held = new Promise<void>((resolve) => {
      commitDelete = resolve;
    });
    const deleteTransaction = deleter.db.transaction(async (tx) => {
      await tx.delete(listings).where(eq(listings.id, LISTING_ID));
      await held;
    });
    // The release-on-failure path below does not await it; the happy path does,
    // and an awaited rejection is still reported there.
    void deleteTransaction.catch(() => undefined);

    // 2. Start the pass. Its first write for this listing blocks on the lock.
    const pass = runVariantAxisBackfill(db, {
      mode: 'apply',
      afterListingId: PAGE_CURSOR,
      listingLimit: 1,
    });
    let settled = false;
    void pass.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // 3. Only once the server says the pass is blocked by THIS file's delete.
    try {
      await waitUntilPassBlocksOnTheHeldDelete(() => settled);
    } finally {
      // Released on EVERY path. A named failure that also left the delete open
      // would arrive as `afterAll`'s generic hook timeout, on a listing row this
      // file is holding against itself.
      commitDelete();
    }
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
