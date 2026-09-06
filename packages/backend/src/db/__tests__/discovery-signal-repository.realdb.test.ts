/**
 * The per-window replace, against a real server.
 *
 * The property under test is ATOMICITY plus SCOPE: the replace must remove the
 * previous run's rows for the window it owns and nothing else, in one
 * transaction, so a reader never sees a half-written window.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { discoverySignals } from '../schema/discovery.js';
import {
  replaceWindow,
  type DiscoverySignalInput,
} from '../discovery/discoverySignalRepository.js';

let db: Database;
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
});

afterEach(async () => {
  if (ownedCategoryIds.length > 0) {
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, ownedCategoryIds));
    ownedCategoryIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('replaceWindow', () => {
  it('writes the rows it is given', async () => {
    const categoryId = makeCategoryId();
    const written = await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
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
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 5), row(categoryId, 'listing-b', 3)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 9)],
    });

    const remaining = await db
      .select({ subjectId: discoverySignals.subjectId, unitsSold: discoverySignals.unitsSold })
      .from(discoverySignals)
      .where(eq(discoverySignals.categoryId, categoryId));

    expect(remaining).toEqual([{ subjectId: 'listing-a', unitsSold: 9 }]);
  });

  it('touches no scope outside the ones it was given', async () => {
    // The shared test database makes this load-bearing, and so does production:
    // a replace written as `delete where window = $1` takes every category with
    // it, which no single-category assertion would notice.
    const mine = makeCategoryId();
    const neighbour = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [neighbour],
      rows: [row(neighbour, 'listing-n', 7)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [mine],
      rows: [row(mine, 'listing-m', 1)],
    });

    const survivors = await db
      .select({ subjectId: discoverySignals.subjectId })
      .from(discoverySignals)
      .where(
        and(eq(discoverySignals.categoryId, neighbour), eq(discoverySignals.window, '30d')),
      );
    expect(survivors).toEqual([{ subjectId: 'listing-n' }]);
  });

  it('an empty input clears the scope rather than being a no-op', async () => {
    // A category whose last listing was archived must EMPTY, not freeze. An
    // early `if (rows.length === 0) return 0` is the bug this pins.
    const categoryId = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 5)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [],
    });
    const remaining = await db
      .select({ subjectId: discoverySignals.subjectId })
      .from(discoverySignals)
      .where(eq(discoverySignals.categoryId, categoryId));
    expect(remaining).toEqual([]);
  });
});
