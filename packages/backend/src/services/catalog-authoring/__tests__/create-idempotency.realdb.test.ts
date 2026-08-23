/**
 * One `Idempotency-Key`, one draft — against a REAL PostgreSQL database
 * (#367 line 432, "Add idempotency keys for create/publish mutations").
 *
 * PUBLISH already converged before this file existed: a key, a partial unique,
 * a pre-read and a `FOR UPDATE` re-check, covered by seven test files. CREATE
 * had none of it — `createProductDraftHandler` read no header, `createDraft`
 * took no key, and `insertDraft` was a bare `.insert().returning()`. A lost
 * response or a double-tap left a merchant two half-filled drafts with no way
 * to tell which one they had been typing into.
 *
 * ## What is actually under test, and what a weaker file would measure
 *
 * The mechanism is `catalog_authoring_drafts_create_idempotency_key` — a PARTIAL
 * unique — reached through `insertDraft`'s `ON CONFLICT DO NOTHING … RETURNING`,
 * whose EMPTY result set is what says "somebody else's create won". The service
 * also pre-reads by key, and that pre-read is an OPTIMISATION that can lose a
 * race.
 *
 * **A sequential pair cannot tell the two apart.** Call `createDraft` twice in a
 * row and the pre-read answers the second one; the unique index is never
 * consulted, and the case passes identically against an implementation with no
 * index at all. That is why `converges under a genuine race` below does not use
 * `Promise.all` on the shared handle either — postgres.js PIPELINES statements
 * onto one connection, so two "concurrent" calls on `db` run in sequence and
 * pass for exactly the same wrong reason (the finding `concurrent-publish.realdb.test.ts`
 * records for the publish lock, which cost that file its own first draft).
 *
 * So the race is STAGED and OBSERVED: a holder connection inserts the key's row
 * and does not commit, a second connection calls the real `createDraft`, and
 * `pg_blocking_pids` is polled until it reports the second genuinely waiting on
 * the first. `waitUntilBlockedBy` THROWS when that never happens, so a case that
 * degenerated into a sequential run fails loudly rather than passing quietly.
 *
 * ## Scoping, because this database is SHARED across parallel files
 *
 * Every row carries a per-run token, every assertion is scoped to this file's
 * own store, and nothing counts a whole table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@oxyhq/db';
import type postgres from 'postgres';

import * as schema from '../../../db/schema/index.js';
import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft } from '../draft.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS } from '../../../__tests__/vertical-e2e/journey.js';

const TOKEN = verticalRunToken('cidem');

/** How long a barrier may take to close before the case is declared vacuous. */
const BLOCK_WAIT_MS = 15_000;

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let storeId: string;
/** A SECOND store, so the index's store-scoping can be shown to matter. */
let otherStoreId: string;

interface SoloConnection {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly pid: number;
}

const soloConnections: SoloConnection[] = [];

/** Calls the real `createDraft` while the holder sits on the key. */
let racer: SoloConnection;
/** Holds an uncommitted row carrying the key, so the racer must wait. */
let holder: SoloConnection;
/** Reads `pg_blocking_pids`, and is never itself a participant. */
let probe: SoloConnection;

/**
 * One connection with a pool of exactly one, so a statement issued on it cannot
 * be pipelined behind another's. Borrowed from `concurrent-publish.realdb.test.ts`,
 * where the same shape is what makes a wait observable at all.
 */
async function openSolo(): Promise<SoloConnection> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('vitest.pg.globalSetup did not publish DATABASE_URL');
  }
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 1, onnotice: () => undefined },
  });
  const rows = await instance.client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('the solo connection did not report a backend pid');
  const solo: SoloConnection = { db: instance.db, client: instance.client, pid };
  soloConnections.push(solo);
  return solo;
}

async function waitUntilBlockedBy(waiterPid: number, holderPid: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  for (;;) {
    const rows = await probe.client<
      { blockers: number[] }[]
    >`select pg_blocking_pids(${waiterPid}) as blockers`;
    if ((rows[0]?.blockers ?? []).includes(holderPid)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${what}: backend ${String(waiterPid)} was never blocked by ${String(holderPid)} within ` +
          `${String(BLOCK_WAIT_MS)}ms, so this case measured a sequential run rather than a race. ` +
          'If `catalog_authoring_drafts_create_idempotency_key` has stopped being a unique index, ' +
          'this is the assertion that says so.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Start a draft on the shared handle. Every field but the key is fixed. */
async function create(
  idempotencyKey: string | null,
  options: { title?: string; store?: string } = {},
): Promise<{ id: string; title: string | null }> {
  const draft = await createDraft(db, {
    storeId: options.store ?? storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    idempotencyKey,
    title: options.title ?? `Idempotent phone ${TOKEN}`,
  });
  return { id: draft.id, title: draft.title };
}

/** How many drafts this file's store holds under one key. Never a whole table. */
async function countByKey(key: string, store: string = storeId): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from catalog_authoring_drafts
    where store_id = ${store} and create_idempotency_key = ${key}
  `);
  return [...rows][0]?.n ?? 0;
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  storeId = await createTestStore(db, TOKEN);
  otherStoreId = await createTestStore(db, `${TOKEN}b`);
  racer = await openSolo();
  holder = await openSolo();
  probe = await openSolo();
}, 300_000);

afterAll(async () => {
  // The solo pools first: `teardownVertical` deletes rows these connections may
  // still hold a snapshot of, and a pool left open outlives the run and holds a
  // backend on a server many worktrees share.
  for (const solo of soloConnections) {
    await solo.client.end({ timeout: 5 });
  }
  await teardownVertical(db, TOKEN);
}, 300_000);

describe('a repeated create under one key', () => {
  it('returns the FIRST draft and writes no second row', async () => {
    const key = `${TOKEN}-retry`;
    const first = await create(key);
    const second = await create(key);

    expect(second.id).toBe(first.id);
    expect(await countByKey(key)).toBe(1);
  });

  it('does NOT let a retry carrying a different body replace what was committed', async () => {
    // `ensureGuestCheckout`'s ruling, one domain over: the draft an author has
    // been typing into must not be replaced by a stale retry of the request that
    // created it. The second call names a different title and a different
    // market; the first draft comes back untouched.
    const key = `${TOKEN}-different-body`;
    const first = await create(key, { title: `Original ${TOKEN}` });
    const second = await create(key, { title: `Replacement ${TOKEN}` });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe(`Original ${TOKEN}`);
    expect(await countByKey(key)).toBe(1);

    // …and the stored row agrees with what was returned, so this is a fact about
    // the table rather than about the projection.
    const rows = await db.execute<{ title: string | null }>(sql`
      select title from catalog_authoring_drafts
      where store_id = ${storeId} and create_idempotency_key = ${key}
    `);
    expect([...rows].map((row) => row.title)).toEqual([`Original ${TOKEN}`]);
  });

  it('converges under a genuine race, which the sequential cases cannot show', async () => {
    // The mechanism, isolated from the pre-read that usually hides it.
    //
    // The holder inserts the key's row and does NOT commit, so the racer's
    // pre-read MISSES — exactly the interleaving a sequential pair can never
    // produce — and its insert then blocks on the uncommitted tuple. Once the
    // holder commits, `ON CONFLICT DO NOTHING` returns nothing and the service
    // reads the winner back.
    const key = `${TOKEN}-race`;

    // A seed draft under a DIFFERENT key, purely so the holder's row can be
    // copied from a real one and inherit every NOT NULL column. Nothing about
    // this row is under test.
    const seed = await create(`${TOKEN}-race-seed`);
    const holderDraftId = `${TOKEN}-race-holder`;

    // Declared outside the transaction ON PURPOSE. Returning the racer's promise
    // from inside `begin` deadlocks the case: postgres.js commits only once the
    // callback resolves, and the racer cannot resolve until that commit lands.
    // Measured — it hung for the full timeout with the barrier already closed.
    let racing: Promise<{ id: string; title: string | null }> | undefined;

    await holder.client.begin(async (tx) => {
      await tx`
        insert into catalog_authoring_drafts
          (id, store_id, created_by_oxy_user_id, create_idempotency_key, status, category_id,
           product_type_definition_id, flow, locale, market, schema_hash, version, expires_at, title)
        select ${holderDraftId}, store_id, created_by_oxy_user_id, ${key}, 'open', category_id,
               product_type_definition_id, flow, locale, market, schema_hash, 1, expires_at,
               ${`Holder ${TOKEN}`}
        from catalog_authoring_drafts where id = ${seed.id}
      `;

      // The racer runs the REAL service on its own connection. Not awaited: it
      // is about to block on the uncommitted tuple above.
      racing = createDraft(racer.db, {
        storeId,
        actorOxyUserId: phones.actorOxyUserId,
        categoryId,
        productTypeKey: nsKey(ns, 'smartphone'),
        flow: 'merchant',
        locale: 'en',
        market: 'ES',
        permissions: E2E_PERMISSIONS,
        ttlSeconds: 3600,
        idempotencyKey: key,
        title: `Racer ${TOKEN}`,
      }).then((draft) => ({ id: draft.id, title: draft.title }));

      // The non-vacuity control. Without this the two could run in sequence and
      // the case would pass however the mechanism is spelled.
      await waitUntilBlockedBy(racer.pid, holder.pid, 'the create race');

      // Resolving the callback is what commits, and the commit is what turns the
      // racer's WAIT into a conflict it has to converge on.
    });

    if (racing === undefined) throw new Error('the racer never started');
    const converged = await racing;

    // What the SERVICE returned — the assertion a table read cannot make, and
    // the one a caller actually depends on.
    expect(converged.id).toBe(holderDraftId);
    expect(converged.title).toBe(`Holder ${TOKEN}`);

    // The holder's row won, and the racer converged on it rather than minting a
    // second draft or raising a 23505.
    const winner = await db.execute<{ id: string; title: string | null }>(sql`
      select id, title from catalog_authoring_drafts
      where store_id = ${storeId} and create_idempotency_key = ${key}
    `);
    const found = [...winner];
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(holderDraftId);
    expect(found[0]?.title).toBe(`Holder ${TOKEN}`);
    expect(await countByKey(key)).toBe(1);
  }, 120_000);
});

describe('what the key does NOT do', () => {
  it('creates a fresh draft every time when no key is sent — the control', async () => {
    // The negative control, and it is what stops every case above passing
    // against an implementation that converged on ANY repeat. Today's behaviour
    // for a client that sends no header is unchanged.
    const first = await create(null, { title: `Keyless one ${TOKEN}` });
    const second = await create(null, { title: `Keyless two ${TOKEN}` });

    expect(second.id).not.toBe(first.id);

    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from catalog_authoring_drafts
      where store_id = ${storeId} and create_idempotency_key is null
    `);
    expect([...rows][0]?.n ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('does not let one store’s key reach another store’s draft', async () => {
    // The security property the partial unique carries: it is scoped to the
    // STORE, so two merchants generating the same client-side key get their own
    // drafts rather than one being answered with the other's.
    const key = `${TOKEN}-shared-key`;
    const mine = await create(key, { title: `Mine ${TOKEN}` });
    const theirs = await create(key, { title: `Theirs ${TOKEN}`, store: otherStoreId });

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.title).toBe(`Theirs ${TOKEN}`);
    expect(await countByKey(key)).toBe(1);
    expect(await countByKey(key, otherStoreId)).toBe(1);
  });
});
