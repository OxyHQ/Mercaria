/**
 * `provision-taxonomy.ts` installs the taxonomy into an empty database, and a
 * SECOND run changes nothing at all.
 *
 * ## Why "creates no rows" is not the assertion
 *
 * A second run that inserted nothing but rewrote every row would satisfy a row
 * count exactly as a genuine no-op does, and the damage — an `updated_at` moved
 * on thirty-five rows, an operator's deliberate edit reverted — is invisible to
 * one. So the idempotence case captures the FULL row set before the second run
 * and compares it column by column afterwards, `updated_at` and `xmin`
 * included: `xmin` is the tuple's transaction id, so it moves on any write that
 * touches the row even one that leaves every column identical, which is the one
 * check a careful `DO UPDATE` could not slip past.
 *
 * ## It gets its OWN throwaway database
 *
 * Not for `seed.realdb.test.ts`'s reason — this script deletes nothing — but for
 * the mirror of it. The assertions here are census-shaped (`count(*)` over
 * `categories`, and the whole table read back), and the shared suite database
 * carries every other `*.realdb` file's fixtures. A sibling seeding one category
 * would fail this file while naming nothing about the cause.
 *
 * The script is driven as a SUBPROCESS rather than imported, which is forced
 * rather than stylistic: it calls `main()` at module scope, so an import would
 * run it against whatever `DATABASE_URL` the suite happened to carry. Shelling
 * out is also what makes the exit code a real observation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@oxyhq/db';
import { asc, sql } from 'drizzle-orm';
import type postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import type { Database } from '../../db/postgres.js';
import { categories } from '../../db/schema/catalog.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../../db/testDatabase.js';
import {
  categorySlugExists,
  findActiveCategories,
  findCategoryBySlug,
} from '../../db/catalog/categoryRepository.js';
import { IMPORT_HOLDING_CATEGORY_SLUG, TAXONOMY } from '../taxonomy.js';

/** `packages/backend` — where the script's own relative imports resolve from. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(PACKAGE_ROOT, 'src', 'scripts', 'provision-taxonomy.ts');

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

/**
 * The rows the taxonomy describes, counted HERE rather than by importing
 * `taxonomySize`. The script measures its own counters against that function, so
 * a test reusing it would check one derivation against itself; this is the
 * independent second count.
 */
const EXPECTED_ROWS = TAXONOMY.reduce(
  (total, entry) => total + 1 + (entry.listing === 'shopper_facing' ? entry.children.length : 0),
  0,
);

/** The shopper-facing entries — the only ones with children or imagery. */
const SHOPPER_FACING = TAXONOMY.filter((entry) => entry.listing === 'shopper_facing');

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;
let firstRun: { code: number | null; text: string };
let secondRun: { code: number | null; text: string };
/** Every category row as it stood after the FIRST run, including `xmin`. */
let afterFirstRun: CategorySnapshot[];

/** One category row plus the tuple's transaction id — a write moves `xmin`. */
interface CategorySnapshot {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  ancestorSlugs: string[];
  imageUrl: string | null;
  position: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  xmin: string;
}

/**
 * The logger's colour codes, matched without writing a control character into a
 * regex literal. The dev transport pretty-prints and colourises its keys, so the
 * counters arrive as `<esc>[35mcreated<esc>[39m: 0` rather than as JSON.
 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** One `key: value` pair in the script's completion log, whatever the transport. */
function reportsCount(text: string, key: string, value: number): boolean {
  return new RegExp(`"?${key}"?:\\s*${value}\\b`).test(text.replace(ANSI_ESCAPE, ''));
}

/** Run the script exactly as an operator does, against one named database. */
async function runProvision(targetUrl: string): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', SCRIPT], {
      cwd: PACKAGE_ROOT,
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

/** The whole `categories` table, in a stable order, with each tuple's `xmin`. */
async function snapshotCategories(): Promise<CategorySnapshot[]> {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      parentId: categories.parentId,
      ancestorSlugs: categories.ancestorSlugs,
      imageUrl: categories.imageUrl,
      position: categories.position,
      isActive: categories.isActive,
      createdAt: categories.createdAt,
      updatedAt: categories.updatedAt,
      xmin: sql<string>`${categories}.xmin::text`,
    })
    .from(categories)
    .orderBy(asc(categories.slug));
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

  firstRun = await runProvision(databaseUrl);
  afterFirstRun = await snapshotCategories();
  // A second apart, so a rewritten `updated_at` would be measurably different
  // rather than landing in the same millisecond as the value it replaced.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  secondRun = await runProvision(databaseUrl);
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

describe('provision-taxonomy installs the taxonomy into an empty database', () => {
  it('exits 0', () => {
    expect(
      firstRun.code,
      `the first run did not complete. Its output was:\n${firstRun.text}`,
    ).toBe(0);
  });

  it('writes every category the taxonomy describes, and no others', () => {
    // The vacuity floor: an empty taxonomy would satisfy every per-slug
    // assertion below by having nothing to check, and an empty taxonomy is
    // exactly what a broken import of the data module produces.
    expect(EXPECTED_ROWS, 'the taxonomy describes no categories at all').toBeGreaterThan(0);
    expect(afterFirstRun).toHaveLength(EXPECTED_ROWS);
  });

  it('parents every child on its top-level category, with the ancestor slug set', () => {
    const bySlug = new Map(afterFirstRun.map((row) => [row.slug, row]));

    for (const top of SHOPPER_FACING) {
      const parent = bySlug.get(top.slug);
      expect(parent, `top-level category "${top.slug}" is missing`).toBeDefined();
      if (!parent) continue;
      expect(parent.parentId, `"${top.slug}" is top-level and must have no parent`).toBeNull();
      expect(parent.ancestorSlugs).toEqual([]);

      for (const child of top.children) {
        const row = bySlug.get(child.slug);
        expect(row, `child category "${child.slug}" is missing`).toBeDefined();
        if (!row) continue;
        expect(row.parentId, `"${child.slug}" must hang off "${top.slug}"`).toBe(parent.id);
        expect(row.ancestorSlugs).toEqual([top.slug]);
      }
    }
  });
});

describe('the import holding category is reachable by a write and never by a browse', () => {
  it('is stored INACTIVE, top-level, with no imagery and no children', () => {
    const row = afterFirstRun.find((r) => r.slug === IMPORT_HOLDING_CATEGORY_SLUG);
    expect(row, `"${IMPORT_HOLDING_CATEGORY_SLUG}" was not created`).toBeDefined();
    if (!row) return;

    expect(row.isActive, 'an ACTIVE holding category is on a shelf shoppers browse').toBe(false);
    expect(row.parentId).toBeNull();
    expect(row.imageUrl).toBeNull();
    expect(afterFirstRun.filter((r) => r.parentId === row.id)).toHaveLength(0);
  });

  it('satisfies the connector guard, which is the whole reason it exists', async () => {
    // `categorySlugExists` is what `resolveImportCategorySlug` calls before a
    // connector backfill will import anything. This is the production function,
    // not a re-spelling of its query.
    await expect(categorySlugExists(IMPORT_HOLDING_CATEGORY_SLUG, db)).resolves.toBe(true);
  });

  it('resolves for a catalogue WRITE despite being inactive', async () => {
    // `findCategoryBySlug` is `catalog-write.service`'s resolver, and it reads
    // `is_active`-blind on purpose. If this ever starts filtering, an imported
    // product has nowhere to be filed and the connector breaks.
    const resolved = await findCategoryBySlug(IMPORT_HOLDING_CATEGORY_SLUG, db);
    expect(resolved, 'the catalogue write resolver could not see the holding category').not.toBeNull();
  });

  it('is ABSENT from the shopper-visible tree, which the browse route serves', async () => {
    // The load-bearing case. `findActiveCategories` is what `GET /categories`
    // and `feed.service` read, so this is the assertion that would fail if
    // somebody made the category active or taught that reader to ignore
    // `is_active`.
    const active = await findActiveCategories(db);

    // Vacuity floor first: an empty result satisfies "the holding category is
    // not in it" without measuring anything, and an empty result is exactly
    // what a broken read returns.
    expect(active.length, 'the active tree is empty — this case would pass vacuously').toBe(
      EXPECTED_ROWS - 1,
    );
    expect(active.map((c) => c.slug)).not.toContain(IMPORT_HOLDING_CATEGORY_SLUG);
  });
});

describe('a second run is a genuine no-op', () => {
  it('exits 0', () => {
    expect(
      secondRun.code,
      `the second run did not complete. Its output was:\n${secondRun.text}`,
    ).toBe(0);
  });

  it('creates no rows and rewrites none — same columns, same timestamps, same xmin', async () => {
    const afterSecondRun = await snapshotCategories();

    expect(afterSecondRun).toHaveLength(EXPECTED_ROWS);
    // `toEqual` over the full row set covers `updated_at` and `xmin` together
    // with every column, so an UPDATE that carefully left the data alone still
    // fails here on the tuple id.
    expect(afterSecondRun).toEqual(afterFirstRun);
  });

  it('reports every category as unchanged rather than created', () => {
    // The counters are the script's own account of what it did, asserted BESIDE
    // the database rather than instead of it: a run that wrote nothing because
    // it never reached the taxonomy would leave the table identical too.
    expect(
      reportsCount(secondRun.text, 'created', 0),
      `the second run did not report 0 created. Its output was:\n${secondRun.text}`,
    ).toBe(true);
    expect(reportsCount(secondRun.text, 'unchanged', EXPECTED_ROWS)).toBe(true);
    expect(reportsCount(secondRun.text, 'divergent', 0)).toBe(true);

    // The positive control: the same matcher against the FIRST run, which
    // created every row. Without it "created: 0" would also be what a matcher
    // that never matches anything reports.
    expect(
      reportsCount(firstRun.text, 'created', EXPECTED_ROWS),
      'the matcher found no counters in the first run either — it measures nothing',
    ).toBe(true);
  });
});
