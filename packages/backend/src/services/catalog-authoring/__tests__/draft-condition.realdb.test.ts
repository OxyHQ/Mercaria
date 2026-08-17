/**
 * The draft's condition columns, against a REAL PostgreSQL database (#572).
 *
 * Four CHECKs and the migration that adds them. Every property here is one a
 * mocked repository cannot have — a mocked `insert` accepts a statement the
 * server rejects outright — and the whole point of #572's shape is that the
 * refusals are structural rather than remembered:
 *
 *  - the vocabularies are RENDERED from `@mercaria/shared-types` into the
 *    CHECKs, so the tuple the type system states and the tuple the database
 *    enforces are one list;
 *  - a key with no assertion (or the reverse) is unrepresentable;
 *  - #90 migration rule 2 holds at the DRAFT grain, so an unrefined assertion
 *    can never carry a refined key — and the refusal arrives where an author can
 *    act on it rather than at publication, naming a table they never touched.
 *
 * ## The one thing every case here has to prove first
 *
 * That the row it is mutating would otherwise be ACCEPTED. A CHECK test whose
 * fixture is refused for an unrelated reason passes without exercising the
 * constraint at all, so `insertDraft` runs a clean baseline before each refusal
 * and every refusal is asserted BY CONSTRAINT NAME.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row carries this run's token and teardown removes exactly what it made.
 * Nothing here counts a table a sibling also writes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  CONDITION_ASSERTIONS,
  ITEM_CONDITION_KEYS,
  UNREFINED_CONDITION_ASSERTIONS,
  UNREFINED_CONDITION_KEYS,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';

const RUN = uuidv7().slice(-12);
const STORE_ID = `cond-${RUN}-store`;

let db: Database;
/** The category and product-type version every draft below pins. */
let categoryId = '';
let productTypeDefinitionId = '';

beforeAll(async () => {
  db = await connectPostgres();
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${STORE_ID}, ${`cond ${RUN}`}, ${`cond-${RUN}`}, '', '#101010')
  `);
  const [category] = [
    ...(await db.execute<{ id: string }>(sql`
      insert into categories (id, key, slug, name, lifecycle, selectable)
      values (${`cond-${RUN}-cat`}, ${`cond.${RUN}`}, ${`cond-${RUN}`}, 'Condition fixture',
              'published', true)
      returning id
    `)),
  ];
  categoryId = category?.id ?? '';

  /**
   * A DRAFT lifecycle, deliberately.
   *
   * `product_type_definitions_immutable_once_published` refuses DELETE from
   * `published` onward, so a published fixture would be a row this file could
   * never clean up — the residue `vertical-fixture.ts` documents and accepts
   * because its own cases need one. Nothing here does: every case inserts a
   * draft ROW directly to reach a CHECK, rather than going through `createDraft`
   * (which is what requires a published version). So the fixture is fully
   * deletable and this file leaves nothing behind.
   */
  const [definition] = [
    ...(await db.execute<{ id: string }>(sql`
      insert into product_type_definitions (id, key, version, lifecycle, name)
      values (${`cond-${RUN}-ptd`}, ${`cond_${RUN}`}, 1, 'draft', 'Condition fixture')
      returning id
    `)),
  ];
  productTypeDefinitionId = definition?.id ?? '';
}, 120_000);

afterAll(async () => {
  // Children first: the drafts reference both pins with `ON DELETE restrict`.
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${STORE_ID}`);
  await db.execute(sql`delete from product_type_definitions where id = ${productTypeDefinitionId}`);
  await db.execute(sql`delete from categories where id = ${categoryId}`);
  await db.execute(sql`delete from stores where id = ${STORE_ID}`);
  await closePostgres();
}, 120_000);

afterEach(async () => {
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${STORE_ID}`);
});

/** Insert one draft, optionally stating a condition. Returns the id. */
async function insertDraft(
  condition: { key: string | null; assertion: string | null } = { key: null, assertion: null },
): Promise<string> {
  const id = `cond-${RUN}-${uuidv7().slice(-8)}`;
  await db.execute(sql`
    insert into catalog_authoring_drafts
      (id, store_id, created_by_oxy_user_id, status, category_id, product_type_definition_id,
       flow, locale, market, schema_hash, version, expires_at,
       item_condition_key, item_condition_assertion)
    values
      (${id}, ${STORE_ID}, ${`seller-${RUN}`}, 'open', ${categoryId}, ${productTypeDefinitionId},
       'merchant', 'en', 'ES', 'etag', 1, now() + interval '1 day',
       ${condition.key}, ${condition.assertion})
  `);
  return id;
}

/** The server's own complaint, which postgres.js hides behind `cause`. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

describe('the baseline every refusal below is measured against', () => {
  it('accepts a draft that states NO condition — which is the unstated state', async () => {
    // The whole design rests on this row being legal: NULL means "the author has
    // not said", and a draft is working state that must be creatable empty. If
    // this were refused, every case below would be refused for the wrong reason.
    await expect(insertDraft()).resolves.toBeTruthy();
    const [row] = [
      ...(await db.execute<{ total: number }>(sql`
        select count(*)::int as total from catalog_authoring_drafts
         where store_id = ${STORE_ID} and item_condition_key is null
      `)),
    ];
    expect(row?.total).toBe(1);
  });

  it('accepts a draft that states one', async () => {
    await expect(
      insertDraft({ key: 'used_good', assertion: 'seller_declared' }),
    ).resolves.toBeTruthy();
  });

  it('there is NO column default — an unstated condition stays NULL', async () => {
    // The property that makes `condition_missing` detectable at all. A DEFAULT
    // of `'new'` would merge "the author said new" with "nobody answered", and
    // the p2p rule would have nothing to see.
    const [row] = [
      ...(await db.execute<{ key: string | null; assertion: string | null }>(sql`
        select item_condition_key as key, item_condition_assertion as assertion
          from catalog_authoring_drafts where id = ${await insertDraft()}
      `)),
    ];
    expect(row?.key).toBeNull();
    expect(row?.assertion).toBeNull();
  });
});

describe('the vocabularies are the shared-types tuples, not a hand-copied list', () => {
  it('accepts EVERY key the tuple names — the population, not a sample', async () => {
    for (const key of ITEM_CONDITION_KEYS) {
      await expect(
        insertDraft({ key, assertion: 'seller_declared' }),
        `${key} is in ITEM_CONDITION_KEYS and the CHECK refused it`,
      ).resolves.toBeTruthy();
    }
    console.log(`[census] condition keys accepted: ${ITEM_CONDITION_KEYS.length}`);
    expect(ITEM_CONDITION_KEYS.length).toBe(9);
  });

  it('accepts every assertion the tuple names', async () => {
    for (const assertion of CONDITION_ASSERTIONS) {
      // Paired with an UNREFINED key so the unrefined CHECK cannot be what
      // accepts or refuses these — this case is about the assertion vocabulary
      // alone.
      await expect(
        insertDraft({ key: 'used_good', assertion }),
        `${assertion} is in CONDITION_ASSERTIONS and the CHECK refused it`,
      ).resolves.toBeTruthy();
    }
    console.log(`[census] condition assertions accepted: ${CONDITION_ASSERTIONS.length}`);
    expect(CONDITION_ASSERTIONS.length).toBe(5);
  });

  it('refuses a key outside the tuple, by CONSTRAINT NAME', async () => {
    const message = await refusal(() =>
      insertDraft({ key: 'mint_in_box', assertion: 'seller_declared' }),
    );
    expect(message).toContain('catalog_authoring_drafts_item_condition_key_check');
  });

  it('refuses an assertion outside the tuple, by CONSTRAINT NAME', async () => {
    const message = await refusal(() =>
      insertDraft({ key: 'used_good', assertion: 'vibes' }),
    );
    expect(message).toContain('catalog_authoring_drafts_item_condition_assertion_check');
  });
});

describe('a condition is a key AND who asserted it, or it is neither', () => {
  it('refuses a key with no assertion', async () => {
    const message = await refusal(() => insertDraft({ key: 'used_good', assertion: null }));
    expect(message).toContain('catalog_authoring_drafts_item_condition_pair_check');
  });

  it('refuses an assertion with no key', async () => {
    // The direction a one-way `key implies assertion` requirement would admit:
    // a statement about nothing.
    const message = await refusal(() => insertDraft({ key: null, assertion: 'seller_declared' }));
    expect(message).toContain('catalog_authoring_drafts_item_condition_pair_check');
  });
});

describe('#90 migration rule 2 holds at the DRAFT grain', () => {
  it('refuses every unrefined assertion carrying a REFINED key', async () => {
    const refined = ITEM_CONDITION_KEYS.filter((key) => !UNREFINED_CONDITION_KEYS.includes(key));
    // The victim list is DERIVED by subtraction and its length asserted, so a
    // key promoted into `UNREFINED_CONDITION_KEYS` shrinks it visibly rather
    // than silently leaving this loop testing nothing.
    expect(refined.length).toBe(ITEM_CONDITION_KEYS.length - UNREFINED_CONDITION_KEYS.length);
    expect(refined.length).toBeGreaterThan(0);

    for (const assertion of UNREFINED_CONDITION_ASSERTIONS) {
      for (const key of refined) {
        const message = await refusal(() => insertDraft({ key, assertion }));
        expect(
          message,
          `${assertion} + ${key} was refused by something other than the unrefined CHECK`,
        ).toContain('catalog_authoring_drafts_unrefined_condition_check');
      }
    }
    console.log(
      `[census] unrefined assertions: ${UNREFINED_CONDITION_ASSERTIONS.length}, ` +
        `refined keys refused each: ${refined.length}`,
    );
  });

  it('ACCEPTS an unrefined assertion carrying an unrefined key — the positive control', async () => {
    // Without this, the case above would pass against a CHECK that refused every
    // unrefined assertion outright, which is a different and wrong rule.
    for (const assertion of UNREFINED_CONDITION_ASSERTIONS) {
      for (const key of UNREFINED_CONDITION_KEYS) {
        await expect(insertDraft({ key, assertion })).resolves.toBeTruthy();
      }
    }
  });
});

describe('the four constraints EXIST in the catalogue — the vacuity guard', () => {
  it('finds all four by name', async () => {
    const rows = [
      ...(await db.execute<{ conname: string }>(sql`
        select conname from pg_constraint
         where conrelid = 'catalog_authoring_drafts'::regclass
           and conname like 'catalog_authoring_drafts_%condition%'
         order by conname
      `)),
    ];
    // Named rather than counted: a count is satisfied by any four constraints
    // whose names happen to match the pattern.
    expect(rows.map((row) => row.conname)).toEqual([
      'catalog_authoring_drafts_item_condition_assertion_check',
      'catalog_authoring_drafts_item_condition_key_check',
      'catalog_authoring_drafts_item_condition_pair_check',
      'catalog_authoring_drafts_unrefined_condition_check',
    ]);
  });

  it('all four are VALIDATED, so they govern the rows already there', async () => {
    // A constraint added `NOT VALID` governs new writes only and leaves any
    // pre-existing violator in place and invisible. Nothing here is added that
    // way — the previous image writes NULL into both columns, which every one of
    // the four admits — and this asserts it rather than trusting the generator.
    const rows = [
      ...(await db.execute<{ conname: string; convalidated: boolean }>(sql`
        select conname, convalidated from pg_constraint
         where conrelid = 'catalog_authoring_drafts'::regclass
           and conname like 'catalog_authoring_drafts_%condition%'
      `)),
    ];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.convalidated, `${row.conname} is NOT VALID`).toBe(true);
    }
  });
});
