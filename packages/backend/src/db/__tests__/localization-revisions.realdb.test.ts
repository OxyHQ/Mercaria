/**
 * The translation revision trail, against a REAL server (#367 step 10, box 4).
 *
 * Every property under test is a TRIGGER or a CONSTRAINT, and neither exists
 * without a server: a mocked insert accepts a statement Postgres rejects
 * outright, and a trigger nothing ever fires is a comment. The whole point of
 * writing this trail at the row rather than in a repository is that it records
 * writes the service never made — so the cases below write through raw SQL and
 * through sibling triggers, not only through the repository.
 *
 * Its own throwaway database: the trail is written by triggers on tables every
 * other realdb file also writes, so on the shared database a count of revisions
 * would be a function of whichever siblings had committed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@oxyhq/db';
import { and, eq, sql } from 'drizzle-orm';
import type postgres from 'postgres';
import * as schema from '../schema/index.js';
import type { Database } from '../postgres.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../testDatabase.js';
import { categories } from '../schema/catalog.js';
import {
  catalogLocalizationRevisions,
  categoryLocalizations,
} from '../schema/catalogLocalization.js';
import {
  findLocalizationRevision,
  readLocalizationFieldHistory,
  rollbackLocalizationField,
} from '../catalogLocalization/revisionRepository.js';
import {
  LOCALIZATION_REVISION_FIELD_PAIRS,
  type LocalizedFieldKey,
} from '@mercaria/shared-types';

const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

let counter = 0;
async function newCategory(name: string): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(categories)
    .values({
      key: `rev.${counter}`,
      name,
      slug: `rev-${counter}`,
      lifecycle: 'published',
      isActive: true,
    })
    .returning();
  return row.id;
}

async function revisionsFor(categoryId: string, fieldKey: LocalizedFieldKey) {
  return db
    .select()
    .from(catalogLocalizationRevisions)
    .where(
      and(
        eq(catalogLocalizationRevisions.entityId, categoryId),
        eq(catalogLocalizationRevisions.fieldKey, fieldKey),
      ),
    );
}


/**
 * The reason Postgres actually gave.
 *
 * A drizzle error's message is the wrapper `Failed query: ...`; the server's own
 * message and SQLSTATE live on `cause`. Asserting against the wrapper would pass
 * for ANY failing statement — a typo, a missing column, a constraint nobody
 * meant to hit — which is exactly the check that cannot fail.
 */
async function reasonFor(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

/* -------------------------------------------------------------------------- */

describe('the trail is written by the trigger, not by a caller', () => {
  it('records every registered field on INSERT, establishing the baseline', async () => {
    const id = await newCategory('Shoes');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      name: 'Zapatos',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    const all = await db
      .select()
      .from(catalogLocalizationRevisions)
      .where(eq(catalogLocalizationRevisions.entityId, id));
    // Both registered category fields, one row each — one row per FIELD is what
    // makes a per-field diff possible at all.
    expect(all.map((r) => r.fieldKey).sort()).toEqual([
      'category.description',
      'category.name',
    ]);
    expect(all.every((r) => r.action === 'create')).toBe(true);
    const name = all.find((r) => r.fieldKey === 'category.name');
    expect(name.value).toBe('Zapatos');
    expect(name.creditedOxyUserId).toBe('rev-user');
  });

  it('records a write made by RAW SQL, which a repository-written trail could not', async () => {
    // The property the whole design rests on. This statement never touches the
    // service, and it is what a backfill script or an operator at a psql prompt
    // looks like.
    const id = await newCategory('Hats');
    await db.execute(sql`
      insert into category_localizations
        (id, category_id, locale, status, provenance, name)
      values (gen_random_uuid()::text, ${id}, 'fr', 'machine_translated', 'machine', 'Chapeaux')
    `);
    const rows = await revisionsFor(id, 'category.name');
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('Chapeaux');
    expect(rows[0].provenance).toBe('machine');
    // The machine-credit CHECK carried onto the trail.
    expect(rows[0].creditedOxyUserId).toBeNull();
  });

  it('records a status change made by the SIBLING stale trigger', async () => {
    // A translation going stale is part of that sentence's history, and nothing
    // in the service performs this write — the source edit does, through a
    // different trigger entirely.
    const id = await newCategory('Coats');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'de',
      status: 'approved',
      provenance: 'mercaria',
      name: 'Mäntel',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    await db.update(categories).set({ name: 'Overcoats' }).where(eq(categories.id, id));

    const rows = await revisionsFor(id, 'category.name');
    expect(rows).toHaveLength(2);
    const latest = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    expect(latest.status).toBe('stale');
    // The TEXT did not change — only the status did — and that is exactly the
    // transition a reviewer needs to see.
    expect(latest.value).toBe('Mäntel');
  });

  it('writes one row per CHANGED field, not one per save', async () => {
    const id = await newCategory('Bags');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'ja',
      status: 'approved',
      provenance: 'mercaria',
      name: 'バッグ',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    // Change ONLY the description. The name must not gain a revision.
    await db
      .update(categoryLocalizations)
      .set({ description: 'かばん' })
      .where(
        and(
          eq(categoryLocalizations.categoryId, id),
          eq(categoryLocalizations.locale, 'ja'),
        ),
      );
    expect(await revisionsFor(id, 'category.name')).toHaveLength(1);
    expect(await revisionsFor(id, 'category.description')).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('the trail is append-only', () => {
  it('refuses an UPDATE and a DELETE', async () => {
    const id = await newCategory('Socks');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'es',
      status: 'approved',
      provenance: 'mercaria',
      name: 'Calcetines',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    const [row] = await revisionsFor(id, 'category.name');
    expect(row).toBeDefined();

    expect(
      await reasonFor(() =>
        db
          .update(catalogLocalizationRevisions)
          .set({ value: 'rewritten' })
          .where(eq(catalogLocalizationRevisions.id, row.id)),
      ),
    ).toMatch(/append-only/u);

    expect(
      await reasonFor(() =>
        db
          .delete(catalogLocalizationRevisions)
          .where(eq(catalogLocalizationRevisions.id, row.id)),
      ),
    ).toMatch(/append-only/u);

    // Positive control: the row is still there and still says what it said, so
    // the two refusals above are refusals rather than silent no-ops.
    const [after] = await revisionsFor(id, 'category.name');
    expect(after.value).toBe('Calcetines');
  });
});

/* -------------------------------------------------------------------------- */

describe('the field-pair CHECK', () => {
  it('refuses an entity kind and a field key that describe different fields', async () => {
    // The prefix trap: `product_type_field.label` BEGINS with `product_type`, so
    // a "the key starts with the kind" rule would admit this row.
    expect(
      await reasonFor(() =>
        db.execute(sql`
          insert into catalog_localization_revisions
            (id, action, entity_kind, entity_id, locale, field_key, value, status, provenance)
          values (gen_random_uuid()::text, 'create', 'product_type', 'x', 'es',
                  'product_type_field.label', 'v', 'approved', 'mercaria')
        `),
      ),
    ).toMatch(/field_pair_check/u);
  });

  it('positive control: the correctly paired row is accepted', async () => {
    // Without this the refusal above could be caused by anything at all in the
    // statement rather than by the pair.
    await db.execute(sql`
      insert into catalog_localization_revisions
        (id, action, entity_kind, entity_id, locale, field_key, value, status, provenance)
      values (gen_random_uuid()::text, 'create', 'product_type_field', 'x', 'es',
              'product_type_field.label', 'v', 'approved', 'mercaria')
    `);
    const [row] = await db
      .select()
      .from(catalogLocalizationRevisions)
      .where(eq(catalogLocalizationRevisions.entityId, 'x'));
    expect(row.fieldKey).toBe('product_type_field.label');
  });

  it('the rendered pair list covers every registered field', () => {
    // Vacuity floor on the CHECK's own source tuple: an empty list would render
    // `in ()`, which no row satisfies, and every insert would fail for a reason
    // nobody could read.
    expect(LOCALIZATION_REVISION_FIELD_PAIRS.length).toBeGreaterThan(1);
    expect(LOCALIZATION_REVISION_FIELD_PAIRS).toContain('product_type_field|product_type_field.label');
    expect(LOCALIZATION_REVISION_FIELD_PAIRS).not.toContain('product_type|product_type_field.label');
  });
});

/* -------------------------------------------------------------------------- */

describe('rollback is a NEW revision that names what it undoes', () => {
  it('restores the earlier wording and records the reversal', async () => {
    const id = await newCategory('Gloves');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'es',
      status: 'approved',
      provenance: 'mercaria',
      name: 'Guantes',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    await db
      .update(categoryLocalizations)
      .set({ name: 'Manoplas' })
      .where(
        and(eq(categoryLocalizations.categoryId, id), eq(categoryLocalizations.locale, 'es')),
      );

    const history = await readLocalizationFieldHistory(
      'category',
      id,
      'es',
      'category.name',
      100,
      db,
    );
    expect(history.steps).toHaveLength(2);
    // Newest first, and each step's predecessor read off the adjacent row.
    expect(history.steps[0].revision.value).toBe('Manoplas');
    expect(history.steps[0].previousValue).toBe('Guantes');
    expect(history.steps[0].textChanged).toBe(true);
    expect(history.steps[1].previousValue).toBeNull();

    const original = history.steps[1].revision;
    const written = await rollbackLocalizationField(original, db);
    expect(written).toBeDefined();
    expect(written.action).toBe('rollback');
    expect(written.rollbackOfRevisionId).toBe(original.id);
    expect(written.value).toBe('Guantes');

    // The LIVE row moved too — a rollback that recorded an intention and changed
    // nothing would be the worst possible outcome here.
    const [live] = await db
      .select()
      .from(categoryLocalizations)
      .where(
        and(eq(categoryLocalizations.categoryId, id), eq(categoryLocalizations.locale, 'es')),
      );
    expect(live.name).toBe('Guantes');

    // …and the ORIGINAL revision is untouched: a rollback adds history, it does
    // not rewrite it.
    const stillThere = await findLocalizationRevision(original.id, db);
    expect(stillThere.value).toBe('Guantes');
    expect(stillThere.action).toBe('create');
  });

  it('does not leak the rollback marker onto a later ordinary edit', async () => {
    // `set local` is what makes this true; a plain `set` would stamp the next
    // statement this pooled connection serves as a rollback of a revision it has
    // nothing to do with.
    const id = await newCategory('Scarves');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'es',
      status: 'approved',
      provenance: 'mercaria',
      name: 'Bufandas',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    const [first] = await revisionsFor(id, 'category.name');
    await db
      .update(categoryLocalizations)
      .set({ name: 'Pañuelos' })
      .where(
        and(eq(categoryLocalizations.categoryId, id), eq(categoryLocalizations.locale, 'es')),
      );
    await rollbackLocalizationField(
      { ...first, createdAt: first.createdAt.toISOString() },
      db,
    );

    // An ordinary edit AFTER the rollback transaction committed.
    await db
      .update(categoryLocalizations)
      .set({ name: 'Chales' })
      .where(
        and(eq(categoryLocalizations.categoryId, id), eq(categoryLocalizations.locale, 'es')),
      );
    const rows = await revisionsFor(id, 'category.name');
    const latest = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    expect(latest.value).toBe('Chales');
    expect(latest.action).toBe('update');
    expect(latest.rollbackOfRevisionId).toBeNull();
  });

  it('reports `undefined` when the rollback would change nothing', async () => {
    // "Restored" and "it already said that" are different answers, and the
    // trigger writes no revision for an UPDATE that changes nothing.
    const id = await newCategory('Belts');
    await db.insert(categoryLocalizations).values({
      categoryId: id,
      locale: 'es',
      status: 'approved',
      provenance: 'mercaria',
      name: 'Cinturones',
      reviewedByOxyUserId: 'rev-user',
      reviewedAt: new Date(),
    });
    const [only] = await revisionsFor(id, 'category.name');
    const written = await rollbackLocalizationField(
      { ...only, createdAt: only.createdAt.toISOString() },
      db,
    );
    expect(written).toBeUndefined();
  });
});
