/**
 * The per-window replace, against a real server.
 *
 * The property under test is ATOMICITY plus REACH: the replace must remove the
 * previous run's rows for the window it owns — ALL of them, not only the
 * scopes the caller happened to fill — in one transaction, so a reader never
 * sees a half-written window and a scope that has gone quiet cannot keep
 * serving last month's figures.
 *
 * The reach half is the one that changed. `replaceWindow` used to take a
 * `scopeCategoryIds` list and delete only those scopes, and the sweep passed
 * the scopes it had TOUCHED — so a category whose every listing fell out of the
 * rolling window contributed no key and was never cleared. The old third case
 * here pinned the narrow behaviour as if it were the requirement; its
 * replacement pins the opposite, which is what the design and this
 * repository's own docblock both state.
 *
 * ## Scoping, because this database is SHARED
 *
 * A window-wide delete cannot be scoped by the caller, so this file holds the
 * `discovery_signals` slot for its whole run — see `discovery-signals-slot.ts`
 * for what collides and why the isolation belongs here rather than in the
 * production predicate. Its own rows still carry file-owned category ids so
 * teardown removes exactly what it made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { discoverySignals } from '../schema/discovery.js';
import {
  replaceWindow,
  type DiscoverySignalInput,
} from '../discovery/discoverySignalRepository.js';
import {
  acquireDiscoverySignalsSlot,
  type DiscoverySignalsSlot,
} from './discovery-signals-slot.js';

let db: Database;
let slot: DiscoverySignalsSlot | undefined;
const ownedCategoryIds: string[] = [];

function makeCategoryId(): string {
  const id = `realdb-discovery-repo-${uuidv7()}`;
  ownedCategoryIds.push(id);
  return id;
}

function row(categoryId: string, subjectId: string, unitsSold: number): DiscoverySignalInput {
  return { subjectType: 'listing', subjectId, categoryId, unitsSold, orderCount: 1, viewCount: 0 };
}

beforeAll(async () => {
  db = await connectPostgres();
  slot = await acquireDiscoverySignalsSlot(db);
}, 120_000);

afterEach(async () => {
  if (ownedCategoryIds.length > 0) {
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, ownedCategoryIds));
    ownedCategoryIds.length = 0;
  }
});

afterAll(async () => {
  // Release BEFORE closing the pool, and NESTED: `release()` can throw and
  // `closePostgres` is what actually ends the hold.
  try {
    if (slot) await slot.release();
  } finally {
    await closePostgres();
  }
});

describe('replaceWindow', () => {
  it('writes the rows it is given', async () => {
    const categoryId = makeCategoryId();
    const written = await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      rows: [row(categoryId, 'listing-a', 5), row(categoryId, 'listing-b', 3)],
    });
    expect(written).toBe(2);
  });

  it('REPLACES rather than accumulates — a subject that fell out is gone', async () => {
    // The failure this catches is an UPSERT-only sweep: `listing-b` stops
    // selling, is no longer in the input, and would otherwise sit on the shelf
    // forever carrying last month's number.
    const categoryId = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      rows: [row(categoryId, 'listing-a', 5), row(categoryId, 'listing-b', 3)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      rows: [row(categoryId, 'listing-a', 9)],
    });

    const remaining = await db
      .select({ subjectId: discoverySignals.subjectId, unitsSold: discoverySignals.unitsSold })
      .from(discoverySignals)
      .where(eq(discoverySignals.categoryId, categoryId));

    expect(remaining).toEqual([{ subjectId: 'listing-a', unitsSold: 9 }]);
  });

  it('clears a scope the new run does not mention at all', async () => {
    // The quiet category. Nothing in `rows` names it, so a delete derived from
    // the input — or from the scopes a sweep touched — cannot reach it, and its
    // stale counts stay on a public shelf past every `> 0` floor the reads
    // apply, with no `computed_at` check anywhere to notice. It is not an edge
    // case: in a marketplace with a long tail of categories it is what happens
    // to most of them most of the time.
    const wentQuiet = makeCategoryId();
    const stillSelling = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      rows: [row(wentQuiet, 'listing-q', 7), row(stillSelling, 'listing-s', 2)],
    });

    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      rows: [row(stillSelling, 'listing-s', 4)],
    });

    expect(
      await db
        .select({ subjectId: discoverySignals.subjectId })
        .from(discoverySignals)
        .where(eq(discoverySignals.categoryId, wentQuiet)),
    ).toEqual([]);
    // The control: the scope the run DID fill is rewritten, not merely spared,
    // so this cannot pass by deleting everything and inserting nothing.
    expect(
      await db
        .select({ subjectId: discoverySignals.subjectId, unitsSold: discoverySignals.unitsSold })
        .from(discoverySignals)
        .where(eq(discoverySignals.categoryId, stillSelling)),
    ).toEqual([{ subjectId: 'listing-s', unitsSold: 4 }]);
  });

  it('an empty input clears the window rather than being a no-op', async () => {
    // Nothing sold and nothing was viewed in the whole rolling window is a real
    // answer, and the previous run's figures are not. An early
    // `if (rows.length === 0) return 0` is the bug this pins.
    const categoryId = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      rows: [row(categoryId, 'listing-a', 5)],
    });
    await replaceWindow({ window: '30d', computedAt: new Date(), rows: [] });
    const remaining = await db
      .select({ subjectId: discoverySignals.subjectId })
      .from(discoverySignals)
      .where(eq(discoverySignals.categoryId, categoryId));
    expect(remaining).toEqual([]);
  });
});
