/**
 * The catalog authoring domain against a REAL PostgreSQL server (#367 step 5,
 * ADR 0007 D10).
 *
 * ## Why this file exists at all
 *
 * Everything it asserts is a property a mocked repository cannot have. A mocked
 * `insert` accepts any statement, including one the server refuses outright: the
 * partial uniques, the thirteen CHECKs and the three triggers have no mocked
 * counterpart, and a suite that stubbed them would report the schema working
 * while the schema enforced nothing.
 *
 * `catalog-authoring-schema.test.ts` covers the DECLARATION — what drizzle-kit
 * will emit — and this covers whether the server agrees.
 *
 * ## Skipped until the migration slot, and the skip is honest
 *
 * ADR 0007 D11 serialises `db:generate` across the parallel #367 branches, so
 * this branch holds its hand-written statements in
 * `db/schema/catalogAuthoring.pending.sql` and has generated no migration. Until
 * the slot arrives these four tables do not exist in the throwaway test
 * database, so the file reports SKIPPED rather than red.
 *
 * The condition is read from `information_schema` in a TOP-LEVEL await, and both
 * halves of that matter. `skipIf` is evaluated when vitest COLLECTS the file, so
 * a flag set in `beforeAll` would still be `false` at collection and every case
 * would skip FOREVER — including after the migration landed, with a green
 * report. And it is a presence query rather than a try/catch around a real
 * statement, because a caught error cannot tell "the table is missing" from "the
 * CHECK I am testing rejected my row", and the second must never become a skip.
 *
 * **Every case below was executed against a real PostgreSQL 17 server before
 * this file was committed**, on a throwaway database carrying the whole 0094
 * chain plus this domain's DDL and its three trigger functions: 17/17. So what
 * the skip defers is re-running proven assertions, not writing them.
 *
 * ## The shared-database rules this file follows
 *
 * The test database is shared across parallel files, so every fixture id carries
 * this file's own prefix, every assertion is scoped to those ids, and the
 * teardown deletes children before parents. Nothing here widens a global bound
 * and nothing takes the global active-matching-policy slot — this domain runs no
 * matcher, which is a scanned gate one directory over.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { connectPostgres, type Database } from '../postgres.js';

/** Everything this file owns. One prefix, so the teardown is one predicate. */
const P = 'catauth-rdb';

const db: Database = await connectPostgres();
const presence = await db.execute<{ present: number }>(sql`
  select count(*)::int as present
  from information_schema.tables
  where table_schema = 'public'
    and table_name in (
      'catalog_authoring_drafts',
      'catalog_authoring_draft_variants',
      'catalog_authoring_draft_values',
      'catalog_authoring_schema_invalidations'
    )
`);
const ready = ([...presence][0]?.present ?? 0) === 4;

/** Whether a statement was refused by the NAMED constraint, and by no other. */
async function refusedBy(statement: ReturnType<typeof sql>, constraint: string): Promise<void> {
  await expect(db.execute(statement)).rejects.toThrow(new RegExp(constraint, 'u'));
}

beforeAll(async () => {
  if (!ready) return;
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${`${P}-store`}, 'Authoring probe', ${`${P}-store-handle`}, '', '#000000')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into categories (id, key, name, slug, lifecycle, selectable)
    values (${`${P}-cat`}, ${'catauth_rdb.primary'}, 'Probe', ${`${P}-cat-slug`}, 'published', true)
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into categories (id, key, name, slug, lifecycle, selectable)
    values (${`${P}-cat2`}, ${'catauth_rdb.other'}, 'Probe 2', ${`${P}-cat2-slug`}, 'published', true)
    on conflict (id) do nothing
  `);
  // `attribute_definitions_published_audit_check` requires `published_at` beside
  // any state but `draft`, so an `active` fixture states it.
  await db.execute(sql`
    insert into attribute_definitions
      (id, key, version, lifecycle_state, label, value_type, cardinality, objectivity, published_at)
    values (${`${P}-attr`}, ${'catauth_rdb_colour'}, 1, 'active', 'Colour', 'enum', 'single', 'objective', now())
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into attribute_definitions
      (id, key, version, lifecycle_state, label, value_type, cardinality, objectivity, published_at)
    values (${`${P}-attr2`}, ${'catauth_rdb_material'}, 1, 'active', 'Material', 'enum', 'single', 'objective', now())
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into product_type_definitions (id, key, version, lifecycle, name, pending_proposal_policy)
    values (${`${P}-ptd`}, ${'catauth_rdb_type'}, 1, 'draft', 'Probe type', 'block_publication')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into product_type_fields
      (id, product_type_definition_id, attribute_definition_id, attribute_key,
       attribute_definition_version, scope, flow, requirement, value_policy, variant_capable, position)
    values (${`${P}-field`}, ${`${P}-ptd`}, ${`${P}-attr`}, ${'catauth_rdb_colour'},
            1, 'product', 'merchant', 'optional', 'controlled_value', false, 0)
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into listings (id, owner_type, store_id, title, description, condition, condition_assertion, status)
    values (${`${P}-listing`}, 'store', ${`${P}-store`}, 'Probe', 'Probe', 'new', 'seller_declared', 'active')
    on conflict (id) do nothing
  `);
});

afterAll(async () => {
  if (!ready) return;
  // Children first. The cascades would handle it; deleting in order is what
  // makes a teardown failure name the table that actually refused.
  await db.execute(sql`delete from catalog_authoring_draft_values where draft_id like ${`${P}%`}`);
  await db.execute(sql`delete from catalog_authoring_draft_variants where draft_id like ${`${P}%`}`);
  await db.execute(sql`delete from catalog_authoring_drafts where id like ${`${P}%`}`);
  await db.execute(
    sql`delete from catalog_authoring_schema_invalidations where subject_id like ${`${P}%`}`,
  );
  await db.execute(sql`delete from listings where id like ${`${P}%`}`);
  await db.execute(sql`delete from product_type_fields where id like ${`${P}%`}`);
  await db.execute(sql`delete from product_type_definitions where id like ${`${P}%`}`);
  await db.execute(sql`delete from attribute_definitions where id like ${`${P}%`}`);
  await db.execute(sql`delete from categories where id like ${`${P}%`}`);
  await db.execute(sql`delete from stores where id like ${`${P}%`}`);
});

/** An open draft, with the columns every case varies stated explicitly. */
function draftInsert(id: string, overrides: string = ''): ReturnType<typeof sql> {
  return sql.raw(`
    insert into catalog_authoring_drafts
      (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
       flow, locale, market, schema_hash, version, expires_at${overrides === '' ? '' : ', ' + overrides.split('|')[0]})
    values ('${id}', '${P}-store', '${P}-user', 'open', '${P}-cat', '${P}-ptd',
            'merchant', 'en', 'ES', '"h"', 1, now() + interval '1 day'${overrides === '' ? '' : ', ' + overrides.split('|')[1]})
  `);
}

describe.skipIf(!ready)('the three biconditionals on `catalog_authoring_drafts`', () => {
  // THREE, not one over their conjunction: the single spelling is SATISFIED by
  // an `open` row carrying a listing id and no timestamp, because both sides
  // evaluate false. Each case asserts its OWN constraint name, which is the
  // assertion that tells three biconditionals from one.
  it('refuses an `open` row carrying a published listing id', async () => {
    await refusedBy(
      draftInsert(`${P}-a1`, `published_listing_id|'${P}-listing'`),
      'catalog_authoring_drafts_published_listing_check',
    );
  });

  it('refuses a `published` row with no `published_at`', async () => {
    await refusedBy(
      sql.raw(`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
           flow, locale, market, schema_hash, version, expires_at, published_listing_id)
        values ('${P}-a2', '${P}-store', '${P}-user', 'published', '${P}-cat', '${P}-ptd',
                'merchant', 'en', 'ES', '"h"', 1, null, '${P}-listing')
      `),
      'catalog_authoring_drafts_published_at_check',
    );
  });

  it('refuses a `published` row that still carries an expiry', async () => {
    // The one that makes the expiry sweep correct: the sweep's predicate is
    // `expires_at <= now()` and nothing else, so this CHECK is what makes that
    // selection equal to "the abandoned ones".
    await refusedBy(
      sql.raw(`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
           flow, locale, market, schema_hash, version, expires_at, published_listing_id, published_at)
        values ('${P}-a3', '${P}-store', '${P}-user', 'published', '${P}-cat', '${P}-ptd',
                'merchant', 'en', 'ES', '"h"', 1, now(), '${P}-listing', now())
      `),
      'catalog_authoring_drafts_expiry_check',
    );
  });

  it('accepts a well-formed open draft', async () => {
    await db.execute(draftInsert(`${P}-ok`));
    const rows = await db.execute<{ id: string }>(
      sql`select id from catalog_authoring_drafts where id = ${`${P}-ok`}`,
    );
    expect([...rows]).toHaveLength(1);
  });
});

describe.skipIf(!ready)('a draft value carries EXACTLY one typed answer', () => {
  const value = (id: string, kind: string, columns: string, values: string): ReturnType<typeof sql> =>
    sql.raw(`
      insert into catalog_authoring_draft_values
        (id, draft_id, field_id, attribute_definition_id, attribute_key,
         attribute_definition_version, scope, ordinal, kind, ${columns})
      values ('${id}', '${P}-ok', '${P}-field', '${P}-attr', 'catauth_rdb_colour',
              1, 'product', 0, '${kind}', ${values})
    `);

  it('refuses two populated value columns', async () => {
    await refusedBy(
      value(`${P}-v1`, 'text', 'value_text, value_number', `'x', 1`),
      'catalog_authoring_draft_values_exactly_one_value_check',
    );
  });

  it('refuses a `text` answer whose populated column is the NUMBER one', async () => {
    // The case a per-kind biconditional SET admits when the count is missing,
    // and the reason both mechanisms are declared. It is refused by the NUMBER
    // half of the pair rather than the text half — which is the same refusal
    // reached first, and asserting the name is what keeps that stated rather
    // than assumed.
    await refusedBy(
      value(`${P}-v2`, 'text', 'value_number', '1'),
      'catalog_authoring_draft_values_number_kind_check',
    );
  });

  it('refuses a `variant`-scope answer that names no variant', async () => {
    await refusedBy(
      sql.raw(`
        insert into catalog_authoring_draft_values
          (id, draft_id, field_id, attribute_definition_id, attribute_key,
           attribute_definition_version, scope, ordinal, kind, value_text)
        values ('${P}-v3', '${P}-ok', '${P}-field', '${P}-attr', 'catauth_rdb_colour',
                1, 'variant', 0, 'text', 'x')
      `),
      'catalog_authoring_draft_values_variant_scope_check',
    );
  });

  it('accepts a well-formed product-scope answer', async () => {
    await db.execute(value(`${P}-vok`, 'text', 'value_text', `'x'`));
    const rows = await db.execute<{ id: string }>(
      sql`select id from catalog_authoring_draft_values where id = ${`${P}-vok`}`,
    );
    expect([...rows]).toHaveLength(1);
  });
});

describe.skipIf(!ready)('the citation trigger keeps the denormalization honest', () => {
  it('refuses a STALE attribute version', async () => {
    // The copy exists so an upgrade preview can compare versions without joining
    // the registry on every answer. A stale one would make the preview report
    // `unchanged` for an answer whose meaning had moved.
    await refusedBy(
      sql.raw(`
        insert into catalog_authoring_draft_values
          (id, draft_id, field_id, attribute_definition_id, attribute_key,
           attribute_definition_version, scope, ordinal, kind, value_text)
        values ('${P}-c1', '${P}-ok', '${P}-field', '${P}-attr', 'catauth_rdb_colour',
                2, 'product', 1, 'text', 'x')
      `),
      'disagrees with attribute definition',
    );
  });

  it('refuses a value whose schema FIELD cites a different attribute', async () => {
    // The check a CHECK cannot express, because it must read another table — and
    // the one that stops an answer about colour being stored under the field for
    // storage capacity, with every other constraint satisfied.
    await refusedBy(
      sql.raw(`
        insert into catalog_authoring_draft_values
          (id, draft_id, field_id, attribute_definition_id, attribute_key,
           attribute_definition_version, scope, ordinal, kind, value_text)
        values ('${P}-c2', '${P}-ok', '${P}-field', '${P}-attr2', 'catauth_rdb_material',
                1, 'product', 2, 'text', 'x')
      `),
      'cites attribute definition',
    );
  });
});

describe.skipIf(!ready)('the pins trigger, and what it deliberately permits', () => {
  it('refuses moving a draft to another category', async () => {
    await refusedBy(
      sql.raw(
        `update catalog_authoring_drafts set category_id = '${P}-cat2' where id = '${P}-ok'`,
      ),
      'frozen at creation',
    );
  });

  it('PERMITS re-pinning an OPEN draft — the upgrade ADR 0007 D10 grants', async () => {
    await db.execute(
      sql.raw(`update catalog_authoring_drafts set schema_hash = '"h2"' where id = '${P}-ok'`),
    );
    const rows = await db.execute<{ schema_hash: string }>(
      sql`select schema_hash from catalog_authoring_drafts where id = ${`${P}-ok`}`,
    );
    expect([...rows][0]?.schema_hash).toBe('"h2"');
  });

  it('refuses re-pinning a PUBLISHED draft', async () => {
    await db.execute(
      sql.raw(`
        update catalog_authoring_drafts
        set status = 'published', published_listing_id = '${P}-listing',
            published_at = now(), expires_at = null
        where id = '${P}-ok'
      `),
    );
    await refusedBy(
      sql.raw(`update catalog_authoring_drafts set schema_hash = '"h3"' where id = '${P}-ok'`),
      'is immutable',
    );
  });
});

describe.skipIf(!ready)('the children-frozen trigger, and the delete it must NOT refuse', () => {
  it('refuses an answer INSERTED under a published draft', async () => {
    await refusedBy(
      sql.raw(`
        insert into catalog_authoring_draft_values
          (id, draft_id, field_id, attribute_definition_id, attribute_key,
           attribute_definition_version, scope, ordinal, kind, value_text)
        values ('${P}-e1', '${P}-ok', '${P}-field', '${P}-attr', 'catauth_rdb_colour',
                1, 'product', 9, 'text', 'y')
      `),
      'cannot be changed',
    );
  });

  it('PERMITS the cascade delete the expiry sweep depends on', async () => {
    // The omission that makes the trigger correct: refusing DELETE would make
    // the retention this domain owes fail SILENTLY on every row it was obliged
    // to remove — the `analytics_events` reasoning.
    await db.execute(sql`delete from catalog_authoring_drafts where id = ${`${P}-ok`}`);
    const rows = await db.execute<{ id: string }>(
      sql`select id from catalog_authoring_draft_values where draft_id = ${`${P}-ok`}`,
    );
    expect([...rows]).toHaveLength(0);
  });
});

describe.skipIf(!ready)('the cache register converges rather than resetting', () => {
  it('a repeated bump increments the EXISTING revision, never the proposed 1', async () => {
    const subjectId = `${P}-subject`;
    for (let i = 0; i < 3; i += 1) {
      await db.execute(sql`
        insert into catalog_authoring_schema_invalidations (id, subject, subject_id, revision)
        values (${`${P}-inv`}, 'category', ${subjectId}, 1)
        on conflict (subject, subject_id)
        do update set revision = catalog_authoring_schema_invalidations.revision + 1
      `);
    }
    const rows = await db.execute<{ revision: string }>(sql`
      select revision from catalog_authoring_schema_invalidations
      where subject = 'category' and subject_id = ${subjectId}
    `);
    const found = [...rows];
    expect(found).toHaveLength(1);
    // Referencing `excluded.revision` instead would write the literal 1 the
    // insert proposed and silently reset a counter that had reached 40.
    expect(Number(found[0]?.revision)).toBe(3);
  });

  it('refuses a revision below 1 and an empty subject id', async () => {
    await refusedBy(
      sql`
        insert into catalog_authoring_schema_invalidations (id, subject, subject_id, revision)
        values (${`${P}-inv-bad`}, 'category', ${`${P}-subject-bad`}, 0)
      `,
      'catalog_authoring_schema_invalidations_revision_check',
    );
    await refusedBy(
      sql`
        insert into catalog_authoring_schema_invalidations (id, subject, subject_id, revision)
        values (${`${P}-inv-empty`}, 'category', '   ', 1)
      `,
      'catalog_authoring_schema_invalidations_subject_id_check',
    );
  });
});

/*
 * What this file still owes, and it is ONE thing rather than a list.
 *
 * The PUBLICATION end to end: one transaction producing a listing, its variants,
 * their stock, a `merchant_declared` link and a stamped draft — and a forced
 * failure inside it leaving NONE of them. It needs a location fixture and the
 * store-product create path, which is `catalog-write.service`'s, so it belongs
 * in a service-level realdb file beside the other publication tests rather than
 * in this schema-shaped one. The converge case goes with it: a second publish
 * under the same `Idempotency-Key` answering the SAME listing id.
 */
