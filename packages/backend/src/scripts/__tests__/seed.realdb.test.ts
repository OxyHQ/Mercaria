/**
 * `seed.ts` runs to completion against an empty migrated database, and produces
 * BOTH halves of the catalogue (#307).
 *
 * ## Why a count of listings would not have caught this
 *
 * The bug this pins was not a seed that produced nothing. It was a seed that
 * produced three stores, seven store listings and a thirty-five row taxonomy and
 * then aborted in `assertConditionEvidence` while creating the first P2P
 * listing — so the storefront rendered, `select count(*) from listings` returned
 * seven, and the entire `owner_type = 'user'` half was missing. Anybody seeding
 * a dev database to exercise a P2P path got an empty result and no reason to
 * suspect the fixture rather than their own code.
 *
 * So the assertion is per OWNER TYPE and is driven off `LISTING_OWNER_TYPES`
 * rather than a hand-written pair: a third owner type would have to be
 * represented or explicitly reckoned with, instead of being silently unchecked.
 *
 * ## This file measures the DATABASE, not the seed's own opinion of itself
 *
 * `seed.ts` now carries its own completion census, which refuses a run that
 * produced no listings of some owner type. Asserting that here by reading the
 * seed's exit code alone would be measuring one check twice: a census with a
 * broken query and a genuinely empty half both exit 0 if the census is what
 * decides. The queries below are therefore this file's own, deliberately
 * independent of the seed's, and the exit code is asserted BESIDE them rather
 * than instead of them.
 *
 * ## It gets its OWN throwaway database, and that is not optional
 *
 * `seed.ts` opens with `clearMarketplace`, which deletes every listing, store,
 * order, review and category in the database it is pointed at. Running it
 * against the shared suite database would destroy every other `*.realdb` file's
 * fixtures mid-run. `graph-plan-regression.realdb.test.ts` takes its own
 * database for the same reason (its generator truncates), and this follows it.
 *
 * The seed is driven as a SUBPROCESS rather than imported, and that is forced
 * rather than stylistic: `seed.ts` calls `seed()` at module scope, so an import
 * would run it — against whatever `DATABASE_URL` the suite happened to carry.
 * Shelling out is also what makes the exit code a real observation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@oxyhq/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import type { Database } from '../../db/postgres.js';
import { LISTING_OWNER_TYPES, listings } from '../../db/schema/catalog.js';
import { listingConditionPhotos } from '../../db/schema/condition.js';
import {
  createMercariaTestDatabase,
  dropMercariaTestDatabase,
} from '../../db/testDatabase.js';

/** `packages/backend` — where the seed's own relative imports resolve from. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SEED_SCRIPT = join(PACKAGE_ROOT, 'src', 'scripts', 'seed.ts');

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;
let seedRun: { code: number | null; text: string };

/** Run `seed.ts` exactly as a developer does, against one named database. */
async function runSeed(targetUrl: string): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', SEED_SCRIPT], {
      cwd: PACKAGE_ROOT,
      // The seed reads DATABASE_URL from the environment, and the throwaway's
      // own URL is the only one it may see here. NODE_ENV is stated because the
      // seed refuses to run under `production` without an explicit opt-in.
      env: { ...process.env, DATABASE_URL: targetUrl, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, text }));
  });
}

/** Listings per owner type, as the database has them. */
async function listingCountsByOwnerType(): Promise<Map<string, number>> {
  const rows = await db
    .select({ ownerType: listings.ownerType, seeded: sql<string>`count(*)` })
    .from(listings)
    .groupBy(listings.ownerType);

  // `count()` comes back from postgres.js as a STRING.
  return new Map(rows.map((row) => [row.ownerType, Number(row.seeded)]));
}

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 2, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
  seedRun = await runSeed(databaseUrl);
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

describe('the dev seed runs to completion against an empty migrated database', () => {
  it('exits 0', () => {
    expect(
      seedRun.code,
      `the seed did not complete. Its output was:\n${seedRun.text}`,
    ).toBe(0);
  });

  it('produces listings of EVERY declared owner type, not just the store half', async () => {
    const counts = await listingCountsByOwnerType();

    // The vacuity floor first: an empty database satisfies "no half is
    // over-represented" and every per-type assertion below by having nothing to
    // check, and an empty database is exactly what a seed that died in its first
    // stage leaves.
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(total, 'the seed wrote no listings at all').toBeGreaterThan(0);

    for (const ownerType of LISTING_OWNER_TYPES) {
      expect(
        counts.get(ownerType) ?? 0,
        `the seed produced no \`${ownerType}\` listings — that is #307: a database that ` +
          'looks seeded while a whole half of the catalogue is missing',
      ).toBeGreaterThan(0);
    }
  });

  it('publishes its P2P listings with the #90 evidence a used condition requires', async () => {
    // The half that broke, measured at the grain it broke on. A P2P listing
    // reaching `active` is the whole of what `assertConditionEvidence` gates, so
    // this asserts the evidence rows exist rather than only that a row does —
    // a listing seeded past the gate by weakening the fixture's condition would
    // pass the owner-type case above and fail here.
    //
    // The photo count is a SECOND statement rather than a correlated subquery,
    // and that is not a style preference. Drizzle renders a column object inside
    // a `sql` template in the SELECT LIST of a SINGLE-TABLE query as a BARE
    // `"id"` — so `where p.listing_id = ${listings.id}` emits
    // `p.listing_id = "id"`, which binds to the SUBQUERY's own `id` and
    // silently answers 0 for every row. It reads correctly, it raises nothing,
    // and the number it returns is exactly the number a genuinely photo-less
    // listing would produce.
    //
    // #313 measured the mechanism this comment first stated too broadly: the
    // rewrite is `buildSelection`'s, and it applies only when `isSingleTable`
    // is true — so a JOIN would have hidden it and a `.where()` is never
    // affected. `qualified()` from `@oxyhq/db` is the one-call alternative to
    // the second statement; both are correct and the second statement stays,
    // because it is what was measured against this fixture. Full reasoning and
    // the gate: `db/schema/CONVENTIONS.md` §Naming and
    // `db/__tests__/sql-column-binding.test.ts`.
    const p2p = await db
      .select({
        id: listings.id,
        condition: listings.condition,
        assertion: listings.conditionAssertion,
        acknowledgedAt: listings.conditionAcknowledgedAt,
      })
      .from(listings)
      .where(eq(listings.ownerType, 'user'));

    expect(p2p.length, 'no P2P listings to check').toBeGreaterThan(0);

    const photoRows = await db
      .select({ listingId: listingConditionPhotos.listingId, seeded: sql<string>`count(*)` })
      .from(listingConditionPhotos)
      .where(
        and(
          inArray(
            listingConditionPhotos.listingId,
            p2p.map((row) => row.id),
          ),
          eq(listingConditionPhotos.provenance, 'seller_uploaded'),
        ),
      )
      .groupBy(listingConditionPhotos.listingId);

    const photos = new Map(photoRows.map((row) => [row.listingId, Number(row.seeded)]));

    for (const row of p2p) {
      expect(row.assertion, 'a seeded P2P listing states its own condition').toBe(
        'seller_declared',
      );
      expect(
        row.acknowledgedAt,
        'a used condition needs an affirmative acknowledgement',
      ).not.toBeNull();
      expect(
        photos.get(row.id) ?? 0,
        `a \`${String(row.condition)}\` listing carries its seller-owned photographs`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('would REPORT an owner type as missing — the assertion can fail', async () => {
    // The positive control, in the same currency as the measurement and run
    // LAST, because it destroys the P2P half of this file's own throwaway
    // database (which `afterAll` drops seconds later). Without it, "every owner
    // type is present" is also what a broken query over an unreadable column
    // reports.
    //
    // It asserts its OWN PRECONDITION first, and that is not ceremony: measured
    // during review, with the seed's P2P stage removed this case still passed —
    // it deleted an already-empty half and observed it was empty, which is the
    // control passing for exactly the reason it exists to detect.
    const before = await listingCountsByOwnerType();
    expect(
      before.get('user') ?? 0,
      'the control has nothing to remove — it would pass without measuring anything',
    ).toBeGreaterThan(0);

    await db.delete(listings).where(eq(listings.ownerType, 'user'));

    const counts = await listingCountsByOwnerType();
    const empty = LISTING_OWNER_TYPES.filter((ownerType) => (counts.get(ownerType) ?? 0) === 0);

    expect(empty, 'removing the P2P half must be visible to this file’s own query').toEqual([
      'user',
    ]);
    expect(counts.get('store') ?? 0, 'and the store half is untouched').toBeGreaterThan(0);
  });
});
