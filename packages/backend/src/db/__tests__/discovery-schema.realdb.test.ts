/**
 * The discovery tables against a REAL server. Every assertion here is about
 * something no mock has a counterpart for: a CHECK, a unique index, and the
 * lease pair.
 *
 * The two enum-CHECK cases below insert through raw SQL rather than
 * `@ts-expect-error`: `subjectType`/`window` are already unrepresentable in
 * application code once typed against `DISCOVERY_SUBJECT_TYPES`/
 * `DISCOVERY_WINDOWS`, so the only way to exercise the CHECK — a *database*
 * property — is to go around the type system entirely, the same way a stray
 * `psql` statement would.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { discoverySignals, discoverySweepCursors } from '../schema/discovery.js';
import {
  acquireDiscoverySignalsSlot,
  type DiscoverySignalsSlot,
} from './discovery-signals-slot.js';

let db: Database;
let slot: DiscoverySignalsSlot | undefined;

/** Category scopes this file invented. The database is SHARED — never widen. */
const ownedCategoryIds: string[] = [];
const ownedCursorIds: string[] = [];

function makeCategoryId(): string {
  const id = `realdb-discovery-cat-${uuidv7()}`;
  ownedCategoryIds.push(id);
  return id;
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
  if (ownedCursorIds.length > 0) {
    await db.delete(discoverySweepCursors).where(inArray(discoverySweepCursors.id, ownedCursorIds));
    ownedCursorIds.length = 0;
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

describe('discovery_signals', () => {
  it('accepts a counted row', async () => {
    const categoryId = makeCategoryId();
    const [row] = await db
      .insert(discoverySignals)
      .values({
        subjectType: 'listing',
        subjectId: `listing-${uuidv7()}`,
        categoryId,
        window: '30d',
        unitsSold: 12,
        orderCount: 9,
        viewCount: 400,
        computedAt: new Date(),
      })
      .returning({ id: discoverySignals.id, unitsSold: discoverySignals.unitsSold });
    expect(row.unitsSold).toBe(12);
  });

  it('refuses a subject type outside the vocabulary', async () => {
    const categoryId = makeCategoryId();
    const subjectId = `x-${uuidv7()}`;
    // The CHECK is what is under test, not the type — `subjectType` is already
    // unrepresentable in application code, so this goes around drizzle entirely.
    // `id` is supplied explicitly (drizzle's `generatedId()` fills it via
    // `$defaultFn` at the application layer, not a database default) and
    // `computed_at` is an ISO string — postgres.js's raw-parameter path does
    // not accept a bare `Date` the way a typed `timestamptz` column does.
    await expect(
      db.execute(
        sql`insert into discovery_signals (id, subject_type, subject_id, category_id, "window", computed_at)
            values (${uuidv7()}, ${'merchant'}, ${subjectId}, ${categoryId}, ${'30d'}, ${new Date().toISOString()})`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a window outside the vocabulary', async () => {
    const categoryId = makeCategoryId();
    const subjectId = `x-${uuidv7()}`;
    // The CHECK is under test — same raw-SQL route as the subject-type case.
    // `"window"` is quoted: unquoted, it collides with the SQL reserved word.
    await expect(
      db.execute(
        sql`insert into discovery_signals (id, subject_type, subject_id, category_id, "window", computed_at)
            values (${uuidv7()}, ${'listing'}, ${subjectId}, ${categoryId}, ${'7d'}, ${new Date().toISOString()})`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a negative count', async () => {
    const categoryId = makeCategoryId();
    await expect(
      db.insert(discoverySignals).values({
        subjectType: 'listing',
        subjectId: `x-${uuidv7()}`,
        categoryId,
        window: '30d',
        unitsSold: -1,
        computedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('holds one row per subject per scope per window', async () => {
    const categoryId = makeCategoryId();
    const subjectId = `listing-${uuidv7()}`;
    const values = {
      subjectType: 'listing' as const,
      subjectId,
      categoryId,
      window: '30d' as const,
      computedAt: new Date(),
    };
    await db.insert(discoverySignals).values(values);
    await expect(db.insert(discoverySignals).values(values)).rejects.toSatisfy(isUniqueViolation);
  });

  it('lets one subject be counted under several scopes — the ancestor chain', async () => {
    // The sweep writes a subject once per category on its ancestor chain, so a
    // shelf at any depth is one indexed read. Two rows for one subject is the
    // DESIGN, and a unique index written without `category_id` would refuse it.
    const leaf = makeCategoryId();
    const parent = makeCategoryId();
    const subjectId = `listing-${uuidv7()}`;
    await db.insert(discoverySignals).values([
      { subjectType: 'listing', subjectId, categoryId: leaf, window: '30d', computedAt: new Date() },
      { subjectType: 'listing', subjectId, categoryId: parent, window: '30d', computedAt: new Date() },
    ]);
    const rows = await db
      .select({ id: discoverySignals.id })
      .from(discoverySignals)
      .where(eq(discoverySignals.subjectId, subjectId));
    expect(rows).toHaveLength(2);
  });

  it('accepts the root scope, which is the empty string and not NULL', async () => {
    // A NULLable dimension breaks the unique index — Postgres treats NULLs as
    // distinct — and would let a row be written that belongs to no scope.
    const subjectId = `listing-${uuidv7()}`;
    await db.insert(discoverySignals).values({
      subjectType: 'listing',
      subjectId,
      categoryId: '',
      window: '30d',
      computedAt: new Date(),
    });
    await db.delete(discoverySignals).where(eq(discoverySignals.subjectId, subjectId));
  });
});

describe('discovery_sweep_cursors', () => {
  it('refuses a lease owner with no deadline', async () => {
    // An owner with no deadline can never be reclaimed; a deadline with no
    // owner names nobody. The pair is the invariant, not either half.
    const id = `realdb-discovery-job-${uuidv7()}`;
    ownedCursorIds.push(id);
    await expect(
      db.insert(discoverySweepCursors).values({ id, leaseOwner: 'someone', leaseExpiresAt: null }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('accepts an unleased cursor and a fully leased one', async () => {
    const idle = `realdb-discovery-job-${uuidv7()}`;
    const leased = `realdb-discovery-job-${uuidv7()}`;
    ownedCursorIds.push(idle, leased);
    await db.insert(discoverySweepCursors).values([
      { id: idle },
      { id: leased, leaseOwner: 'owner', leaseExpiresAt: new Date(Date.now() + 60_000) },
    ]);
    const rows = await db
      .select({ id: discoverySweepCursors.id })
      .from(discoverySweepCursors)
      .where(inArray(discoverySweepCursors.id, [idle, leased]));
    expect(rows).toHaveLength(2);
  });
});
