/**
 * Releasing a connector field pin, against a REAL Postgres database (#427).
 *
 * A mocked repository would accept any statement and return whatever the test
 * said, and every property this file exists for is one only a server can
 * answer:
 *
 *  - the removal is computed INSIDE the locked UPDATE, so two dashboards
 *    releasing two different fields at the same moment both win. A
 *    read-then-write passes every mocked test and loses one of them — and the
 *    symptom is a pin that came back, which is indistinguishable from the
 *    merchant having re-edited the field;
 *  - `listing_pin_releases` is append-only by TRIGGER, which has no mocked
 *    counterpart at all;
 *  - a converging repeat writes NO second row, which is a fact about what the
 *    statement removed rather than about what was asked for.
 *
 * Everything here is scoped to stores this file created: the test database is
 * shared with every other file running in parallel.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { partitionPinnedFields } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { listingPinReleases } from '../../db/schema/connectorPins.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { findListingById, insertListing } from '../../db/catalog/listingRepository.js';
import { releasePinnedFields } from '../catalog-write.service.js';

let db: Database;

/** Store ids this file created, dropped afterwards so the shared database stays clean. */
const createdStoreIds: string[] = [];

const ACTOR = { oxyUserId: 'oxy-release-actor' };

async function makeStore(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `pin-release-${suffix}`,
      name: 'Pin release realdb store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A store-owned listing carrying exactly the pin set a case needs. */
async function makeListing(storeId: string, overriddenFields: string[]): Promise<string> {
  const row = await insertListing(
    {
      ownerType: 'store',
      oxyUserId: null,
      storeId,
      title: 'Pinned product',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      conditionSourceLabel: null,
      conditionAcknowledgedAt: null,
      status: 'active',
      categoryId: null,
      categorySlugs: [],
      tags: [],
      priceRangeMinAmount: null,
      priceRangeMinCurrency: null,
      priceRangeMaxAmount: null,
      priceRangeMaxCurrency: null,
      hasInventory: false,
      variantCount: 0,
      longitude: null,
      latitude: null,
      vendor: null,
      productType: null,
      handle: null,
      seoTitle: null,
      seoDescription: null,
      sourceConnectionId: null,
      sourceProvider: null,
      sourceExternalId: null,
      sourceExternalUpdatedAt: null,
      overriddenFields,
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      publishedAt: new Date(),
    },
    [],
    [],
  );
  return row.id;
}

async function storedPins(listingId: string): Promise<string[]> {
  const listing = await findListingById(listingId);
  return listing ? listing.overriddenFields : [];
}

async function releaseRows(listingId: string) {
  return db.select().from(listingPinReleases).where(eq(listingPinReleases.listingId, listingId));
}

/**
 * Assert that a statement was refused by a TRIGGER carrying a given message.
 *
 * drizzle WRAPS the driver error, so the obvious `rejects.toThrow(/append-only/)`
 * matches against `"Failed query: update …"` and fails, while
 * `rejects.toThrow()` alone passes on any error at all — including a typo in the
 * fixture. Walking the cause chain is what makes the assertion name the trigger
 * it means (`store-linkage.realdb.test.ts`'s helper, for the same reason).
 */
async function expectTriggerRefusal(operation: Promise<unknown>, message: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the statement was not refused at all').toBeDefined();

  const messages: string[] = [];
  for (let error = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
  }
  expect(messages.join('\n'), `no error in the cause chain matched ${message}`).toMatch(message);
}

/**
 * Wait until `expected` backends are queued behind `blockerPid`, TRANSITIVELY.
 *
 * Two things this cannot be. It cannot be a global count of blocked backends:
 * the test database is shared with every suite running in parallel, so a
 * stranger's contention would satisfy it and this file's own racers would never
 * have had to reach the row.
 *
 * And it cannot be a ONE-HOP `pg_blocking_pids(pid) @> array[blocker]` count,
 * which is what the first version was. Row-lock waiters CHAIN: the first racer
 * queues behind the holder and the second queues behind the FIRST RACER, so one
 * hop reports exactly one waiter however many are lined up, and asking it for
 * two waits forever. Measured here — the wait timed out at every poll while
 * `pg_stat_activity` plainly showed both racers in `wait_event_type = 'Lock'`.
 *
 * It polls on the POOL, and that turns out to be load-bearing rather than
 * incidental: measured here, moving the poll onto the holder's own reserved
 * connection left the two racers queued in postgres.js and NEVER connected —
 * `pg_stat_activity` showed one backend for the whole wait, the poller's own.
 * A query submitted to the pool is what makes it open the connections the
 * racers are waiting for.
 */
async function waitForWaiters(blockerPid: number, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = await db.execute<{ waiting: number }>(sql`
      with recursive blocked(pid) as (
        select a.pid from pg_stat_activity a
        where pg_blocking_pids(a.pid) @> array[${blockerPid}]::int[]
        union
        select a.pid from pg_stat_activity a
        join blocked b on pg_blocking_pids(a.pid) @> array[b.pid]::int[]
      )
      select count(*)::int as waiting from blocked
    `);
    if ([...rows][0].waiting >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${expected} backends queued behind pid ${blockerPid}`);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // `listings.store_id` is RESTRICT, so the listings go first — and the
    // release rows cascade with them, which is the whole reason the trigger's
    // DELETE branch has its "only with the listing" exception.
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await deleteTestStores(db, [storeId]);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('releasing a pinned field', () => {
  it('removes exactly the named key and leaves every other held key', async () => {
    const listingId = await makeListing(await makeStore(), [
      'title',
      'description',
      'seo',
      // A key no merchant EDIT writes, held by the connector merge all the same.
      'price',
      'something_a_later_issue_added',
    ]);

    const released = await releasePinnedFields(listingId, ['title'], ACTOR);

    expect(released).toEqual(['title']);
    expect(await storedPins(listingId)).toEqual([
      'description',
      'seo',
      'price',
      'something_a_later_issue_added',
    ]);
  });

  it('reaches a key the merchant surface cannot NAME', async () => {
    // #427's requirement, and the reason the wire type is `string[]`: a release
    // limited to the seven named keys would leave these stuck permanently, which
    // is worse than not offering a release at all.
    const listingId = await makeListing(await makeStore(), [
      'title',
      'price',
      'something_a_later_issue_added',
    ]);
    const unnamed = partitionPinnedFields(await storedPins(listingId)).unnamed;
    expect(unnamed).toEqual(['price', 'something_a_later_issue_added']);

    const released = await releasePinnedFields(listingId, unnamed, ACTOR);

    expect(released.sort()).toEqual(['price', 'something_a_later_issue_added']);
    expect(await storedPins(listingId)).toEqual(['title']);
    expect(partitionPinnedFields(await storedPins(listingId))).toEqual({
      pinned: ['title'],
      unnamed: [],
    });
  });

  it('CONVERGES on a repeat rather than erroring, and records nothing the second time', async () => {
    const listingId = await makeListing(await makeStore(), ['title', 'handle']);

    const first = await releasePinnedFields(listingId, ['title'], ACTOR);
    const second = await releasePinnedFields(listingId, ['title'], ACTOR);

    expect(first).toEqual(['title']);
    // Not an error and not a second decision: the trail records what the
    // statement REMOVED, so a retry, a double tap and a second dashboard all end
    // in one state with one row.
    expect(second).toEqual([]);
    expect(await storedPins(listingId)).toEqual(['handle']);
    expect(await releaseRows(listingId)).toHaveLength(1);
  });

  it('succeeds on a key that was never held, and changes nothing', async () => {
    const listingId = await makeListing(await makeStore(), ['title']);

    const released = await releasePinnedFields(listingId, ['vendor', 'seo'], ACTOR);

    expect(released).toEqual([]);
    expect(await storedPins(listingId)).toEqual(['title']);
    expect(await releaseRows(listingId)).toHaveLength(0);
  });

  it('cannot ADD a key, which is what keeps `status` unpinnable', async () => {
    // The direction #416 refused. A release is subtractive, so naming a key that
    // is not held — including one of `UNPINNED_CONNECTOR_KEYS` — removes nothing
    // and adds nothing; there is no spelling of this call that makes a fourth
    // key pinnable.
    const listingId = await makeListing(await makeStore(), ['title']);

    await releasePinnedFields(listingId, ['status', 'collections'], ACTOR);

    expect(await storedPins(listingId)).toEqual(['title']);
  });

  it('records one attributable row per key actually removed', async () => {
    const listingId = await makeListing(await makeStore(), ['title', 'images', 'vendor']);

    await releasePinnedFields(listingId, ['title', 'vendor', 'handle'], ACTOR);

    const rows = await releaseRows(listingId);
    expect(rows.map((row) => row.field).sort()).toEqual(['title', 'vendor']);
    for (const row of rows) {
      expect(row.releasedByOxyUserId).toBe(ACTOR.oxyUserId);
      expect(row.createdAt).toBeInstanceOf(Date);
    }
  });

  it('is 404 for a listing that does not exist', async () => {
    await expect(releasePinnedFields(uuidv7(), ['title'], ACTOR)).rejects.toThrow(/not found/i);
  });

  it('keeps the trail append-only against an UPDATE', async () => {
    const listingId = await makeListing(await makeStore(), ['title']);
    await releasePinnedFields(listingId, ['title'], ACTOR);
    const [row] = await releaseRows(listingId);
    expect(row, 'nothing to mutate — the release above wrote no row').toBeDefined();

    await expectTriggerRefusal(
      db
        .update(listingPinReleases)
        .set({ field: 'description' })
        .where(eq(listingPinReleases.id, row.id)),
      /append-only/i,
    );
  });

  it('refuses a DELETE while the listing it explains still exists', async () => {
    const listingId = await makeListing(await makeStore(), ['title']);
    await releasePinnedFields(listingId, ['title'], ACTOR);
    const [row] = await releaseRows(listingId);

    await expectTriggerRefusal(
      db.delete(listingPinReleases).where(eq(listingPinReleases.id, row.id)),
      /only be removed with the listing/i,
    );
  });
});

describe('two dashboards releasing at the same moment', () => {
  it('keeps BOTH removals when two different fields are released concurrently', async () => {
    // The load-bearing case, and the one a `Promise.all` alone cannot produce:
    // postgres.js pipelines, so two calls issued together can serialise
    // perfectly by accident. The competitor here is a transaction that HOLDS the
    // row lock until both racers are provably queued behind it, so both of them
    // read and write across the same contended window.
    //
    // With the removal computed inside the locked UPDATE, the second racer
    // re-evaluates against what the first committed and both keys go. Read the
    // array out, filter it in JavaScript and write it back, and the loser's
    // `before` is the value it fetched OUTSIDE the lock — so it puts the
    // winner's key straight back.
    //
    // The case needs FOUR connections at once — the holder, two racers and the
    // poller — and `vitest.pg.globalSetup.ts` forces `PG_MAX_POOL_SIZE` to
    // exactly 4. Asserted rather than assumed, because running out mid-race
    // presents as a hang until the hook timeout rather than as an error, and the
    // report that lands names the teardown.
    expect(
      config.postgres.maxPoolSize,
      'this race needs a connection for the holder, both racers and the poller',
    ).toBeGreaterThanOrEqual(4);
    const listingId = await makeListing(await makeStore(), ['title', 'description', 'seo']);

    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let holderPid = 0;
    let pidReady = (): void => {};
    const pidKnown = new Promise<void>((resolve) => {
      pidReady = resolve;
    });

    const holder = db.transaction(async (tx) => {
      const pidRows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holderPid = [...pidRows][0].pid;
      await tx.execute(sql`select 1 from listings where id = ${listingId} for update`);
      pidReady();
      await gate;
    });

    await pidKnown;
    const racers = [
      releasePinnedFields(listingId, ['title'], ACTOR),
      releasePinnedFields(listingId, ['description'], ACTOR),
    ];
    // `finally`, because a wait that threw with the gate still shut would leave
    // this transaction holding the listing's row lock — and the first thing to
    // block on it is this file's own `afterEach`, so the run would hang until
    // the hook timed out and report a teardown failure instead of the real one.
    try {
      await waitForWaiters(holderPid, 2);
    } finally {
      openGate();
    }
    await holder;
    const [first, second] = await Promise.all(racers);

    expect([...first, ...second].sort()).toEqual(['description', 'title']);
    expect(await storedPins(listingId)).toEqual(['seo']);
    expect((await releaseRows(listingId)).map((row) => row.field).sort()).toEqual([
      'description',
      'title',
    ]);
  }, 60_000);
});
