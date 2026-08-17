/**
 * `listings.product_type_definition_id` — the pin's DATABASE guarantees
 * (#367 box 11, ADR 0007 D5/D10/D13).
 *
 * Three properties, and none of them exists anywhere but the server:
 *
 * 1. **A pin may be SET** (NULL → a value) — a first publication.
 * 2. **A pin may be MOVED** (value → value) — which IS the deliberate migration
 *    D10 describes and box 12 owes for a published listing. If this direction
 *    were refused, the migration would be unimplementable without dropping the
 *    trigger, so it is asserted rather than assumed.
 * 3. **A pin may NEVER be cleared** (value → NULL), by
 *    `mercaria_listing_product_type_pin_not_cleared`. The column is the only
 *    evidence of which rules a stored answer was recorded under; clearing it
 *    destroys that evidence and leaves a row that looks entirely normal. That is
 *    the direction a well-meant "tidy up the nulls" migration, or a serializer
 *    round-trip that omits the field, would take — neither of which any service
 *    test would catch, because neither goes through a service.
 *
 * Plus the two referential guarantees the migration declares: the foreign key
 * refuses a pin naming no version, and `ON DELETE restrict` refuses deleting a
 * version a listing cites.
 *
 * ## Why a REAL database
 *
 * Every property here is a trigger or a constraint. A mocked insert accepts a
 * statement the server rejects outright, so a mocked version of this file would
 * assert that the code calls a rule it wrote itself.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row is created by this file with a per-run token, every assertion names
 * ids it inserted, and teardown deletes exactly what it created — the listing
 * FIRST, because the product-type version it cites is `ON DELETE restrict` and
 * is precisely what case 5 proves. Nothing here counts a table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';

let db: Database;

/** Per-run, so parallel workers and reruns cannot collide. */
const TOKEN = `ptpin_${uuidv7().slice(0, 8)}`;

const definitionA = uuidv7();
const definitionB = uuidv7();
const listingId = uuidv7();

async function pinOf(id: string): Promise<string | null> {
  const [row] = await db.execute<{ product_type_definition_id: string | null }>(
    sql`select product_type_definition_id from listings where id = ${id}`,
  );
  return row?.product_type_definition_id ?? null;
}

async function setPin(id: string, value: string | null): Promise<void> {
  await db.execute(
    sql`update listings set product_type_definition_id = ${value} where id = ${id}`,
  );
}

/**
 * The refusal a statement produced, read off `cause`.
 *
 * A drizzle/postgres.js rejection's own `message` is the statement dump
 * (`Failed query: update listings set …`); the server's own message and its
 * SQLSTATE live on `cause`. Asserting the wrapper would pass for ANY failure —
 * a typo, a missing column, a dead connection — which is a test that cannot
 * tell the trigger firing from the trigger being absent and the column
 * misspelled.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<{
  message: string;
  code: string | undefined;
}> {
  try {
    await run();
  } catch (error) {
    const wrapper = error as { message?: string; cause?: { message?: string; code?: string } };
    return {
      message: `${wrapper.message ?? ''} ${wrapper.cause?.message ?? ''}`,
      code: wrapper.cause?.code,
    };
  }
  throw new Error('expected the statement to be refused, and it succeeded');
}

beforeAll(async () => {
  db = await connectPostgres();

  // Two DRAFT versions of one key. Draft, so nothing here trips the
  // one-published-per-key partial unique that siblings also contend for.
  for (const [id, version] of [
    [definitionA, 1],
    [definitionB, 2],
  ] as const) {
    await db.execute(sql`
      insert into product_type_definitions (id, key, version, lifecycle, name)
      values (${id}, ${`${TOKEN}.thing`}, ${version}, 'draft', ${`Thing v${version}`})
    `);
  }

  await db.execute(sql`
    insert into listings (
      id, owner_type, oxy_user_id, store_id, title, description,
      condition, condition_assertion, status, category_slugs, tags
    ) values (
      ${listingId}, 'user', ${`${TOKEN}_seller`}, null, ${`${TOKEN} listing`}, '',
      'new', 'seller_declared', 'active', '{}', '{}'
    )
  `);
}, 120_000);

afterAll(async () => {
  // The listing FIRST: `restrict` is what case 5 proves, so the reverse order
  // would fail teardown for the reason the suite exists to demonstrate.
  await db.execute(sql`delete from listings where id = ${listingId}`);
  await db.execute(
    sql`delete from product_type_definitions where id in (${definitionA}, ${definitionB})`,
  );
  await closePostgres();
});

describe('the pin may be set and moved', () => {
  it('accepts NULL -> a value, which is a first publication', async () => {
    expect(await pinOf(listingId), 'the fixture should start unpinned').toBeNull();

    await setPin(listingId, definitionA);

    expect(await pinOf(listingId)).toBe(definitionA);
  });

  it('accepts value -> value, which IS the deliberate migration', async () => {
    // Box 12's published-listing migration is unimplementable if the trigger
    // refuses this, so it is asserted rather than assumed.
    await setPin(listingId, definitionB);

    expect(await pinOf(listingId)).toBe(definitionB);
  });

  it('accepts an unrelated UPDATE that leaves the pin alone', async () => {
    // The trigger runs on EVERY update of the table. Without this case, a
    // trigger that raised on any update at all would still pass every other
    // assertion here, and would break every listing write in the product.
    await db.execute(
      sql`update listings set title = ${`${TOKEN} listing edited`} where id = ${listingId}`,
    );

    expect(await pinOf(listingId)).toBe(definitionB);
  });
});

describe('the pin may never be cleared', () => {
  it('REFUSES value -> NULL', async () => {
    const refusal = await refusalOf(() => setPin(listingId, null));

    // The server's OWN message and SQLSTATE, not the driver's statement dump.
    expect(refusal.message).toMatch(/cannot be cleared once set/i);
    expect(refusal.code, 'the trigger raises check_violation').toBe('23514');

    // …and the stored value is untouched, which is the property that matters:
    // a trigger that raised AFTER writing would satisfy the rejection above.
    expect(await pinOf(listingId)).toBe(definitionB);
  });
});

describe('the reference is real', () => {
  it('REFUSES a pin naming no version', async () => {
    const refusal = await refusalOf(() => setPin(listingId, uuidv7()));

    // 23503, so this case cannot pass because of the trigger above or a typo.
    expect(refusal.code, 'a foreign key violation').toBe('23503');

    expect(await pinOf(listingId)).toBe(definitionB);
  });

  it('REFUSES deleting a version a listing cites', async () => {
    // `ON DELETE restrict`, and the reason the teardown above is ordered.
    const refusal = await refusalOf(() =>
      db.execute(sql`delete from product_type_definitions where id = ${definitionB}`),
    );

    expect(refusal.code, 'ON DELETE restrict is a foreign key violation').toBe('23503');

    // The uncited sibling still deletes, which is the negative control: without
    // it this case would also pass against a table nothing could ever delete.
    await db.execute(sql`delete from product_type_definitions where id = ${definitionA}`);
    const [row] = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from product_type_definitions where id = ${definitionA}`,
    );
    expect(row?.total).toBe(0);
  });
});
