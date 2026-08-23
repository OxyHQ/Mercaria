/**
 * Two publications of ONE draft, arriving at once, against a REAL PostgreSQL
 * database (#367 Workstream 18, "test concurrent draft/publish behavior").
 *
 * `lockDraftForPublish` (`db/catalogAuthoring/draftRepository.ts:111`) takes
 * `FOR UPDATE` on the draft row and its docblock states exactly why: a publish
 * reads the draft, composes a schema, validates it, writes a listing and only
 * then stamps the draft, so a second publish arriving mid-way must WAIT rather
 * than act on a comparison it made against a state that has since changed.
 *
 * **Nothing exercised that lock.** `lockDraftForPublish` had exactly two
 * references in the repository before this file — its definition and its one
 * call site — so the row lock was a convention, and removing `.for('update')`
 * left the whole suite green. Two concurrent publications of one draft produce
 * two listings, two `native_listing_link` rows and one draft pointing at the
 * loser, which is not a state anything downstream can be made consistent from.
 *
 * ## Why this is a real-server file, and why it opens its own connections
 *
 * A row lock has no mocked counterpart, and neither does the wait. It also
 * cannot be observed through ONE drizzle handle: postgres.js PIPELINES
 * statements onto a single connection, so `Promise.all([publish(), publish()])`
 * on the shared `db` runs them in sequence and passes for the wrong reason —
 * with or without the lock. Each publisher therefore gets its own
 * `max: 1` pool, and a third connection reads `pg_blocking_pids` and is never a
 * participant.
 *
 * ## The barrier THROWS when it never opens
 *
 * `waitUntilBlockedBy` is the non-vacuity control, borrowed from
 * `db/__tests__/canonical-teardown.realdb.test.ts`: every case here rests on one
 * publisher having genuinely waited on another, and a barrier that never closed
 * would leave the two running sequentially — the arrangement that passes however
 * the lock is spelled. `pg_blocking_pids` rather than a `pg_locks` predicate on
 * the relation, because a row-lock wait queues on the HOLDER's `transactionid`
 * and a relation-scoped query reports "they never overlapped" beside a result
 * only an overlap can produce.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row carries a per-run namespace token, every assertion is scoped to ids
 * this file inserted, and nothing counts a whole table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@oxyhq/db';
import type postgres from 'postgres';

import * as schema from '../../../db/schema/index.js';
import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { publishDraft, type DraftPublication } from '../publish.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, enumValueId } from '../../../__tests__/vertical-e2e/journey.js';

const TOKEN = verticalRunToken('cpub');

/** How long a barrier may take to close before the case is declared vacuous. */
const BLOCK_WAIT_MS = 15_000;

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let storeId: string;

interface SoloConnection {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly pid: number;
}

const soloConnections: SoloConnection[] = [];

/** A publisher. */
let alpha: SoloConnection;
/** A second publisher, for the true-race case. */
let beta: SoloConnection;
/** Holds the draft row so a publisher stops exactly where a case needs it. */
let holder: SoloConnection;
/** Reads `pg_blocking_pids`, and is never itself a participant. */
let probe: SoloConnection;

/**
 * One connection with a pool of exactly one, so a statement issued on it cannot
 * be pipelined behind another test's.
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
          `${String(BLOCK_WAIT_MS)}ms, so this case measured a sequential run rather than a wait. ` +
          'If `lockDraftForPublish` has stopped taking `FOR UPDATE`, this is the assertion that says so.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Concurrency warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
  alpha = await openSolo();
  beta = await openSolo();
  holder = await openSolo();
  probe = await openSolo();
}, 300_000);

afterAll(async () => {
  // The solo pools first: `teardownVertical` deletes rows these connections may
  // still hold a snapshot of, and a pool left open outlives the run and holds a
  // backend on a server ~70 worktrees share.
  for (const solo of soloConnections) {
    await solo.client.end({ timeout: 5 });
  }
  await teardownVertical(db, TOKEN);
}, 300_000);

/** Author one publishable draft and return its id. */
async function authorDraft(suffix: string): Promise<string> {
  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    idempotencyKey: null,
    title: `Concurrency phone ${suffix}`,
  });

  await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A phone published twice at once, to prove only one listing results.',
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
    ],
    variants: [
      {
        sku: `${TOKEN}-${suffix}-256`,
        inventoryAvailable: 2,
        price: { amount: 99900, currency: 'EUR' },
        axes: [
          { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] },
          {
            attributeKey: nsKey(ns, 'phone_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
          },
        ],
      },
    ],
  });

  const validation = await validateStoreDraft(db, {
    storeId,
    draftId: draft.id,
    permissions: E2E_PERMISSIONS,
  });
  expect(
    validation.publishable,
    `the draft is not publishable: ${JSON.stringify(validation.findings)}`,
  ).toBe(true);
  return draft.id;
}

function publishOn(connection: SoloConnection, draftId: string): Promise<DraftPublication> {
  return publishDraft(connection.db, {
    storeId,
    draftId,
    actorOxyUserId: phones.actorOxyUserId,
    permissions: E2E_PERMISSIONS,
    idempotencyKey: null,
  });
}

/** Listings this file's store holds that were produced from one draft. */
async function listingsFromDraft(draftId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select l.id
      from listings l
      join catalog_authoring_drafts d on d.published_listing_id = l.id
     where d.id = ${draftId}
     union
    select l.id
      from listings l
     where l.store_id = ${storeId}
       and l.title = (select title from catalog_authoring_drafts where id = ${draftId})
  `);
  return [...rows].map((row) => row.id);
}

describe('a publish WAITS for a publish already in flight', () => {
  let draftId: string;

  beforeAll(async () => {
    draftId = await authorDraft('barrier');
  }, 300_000);

  it('blocks on the draft row, and publishes once the holder lets go', async () => {
    // A transaction holding exactly the row `lockDraftForPublish` locks. It
    // changes nothing — the wait is the whole subject, and a holder that also
    // wrote would confuse "waited" with "read a different value".
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = holder.db.transaction(async (tx) => {
      await tx.execute(sql`select id from catalog_authoring_drafts where id = ${draftId} for update`);
      await held;
    });
    // The holder has to be IN its transaction before the publisher starts, or
    // the publisher can take the lock first and the barrier never closes.
    await waitUntilBlockedByHolderPreflight();

    const publishing = publishOn(alpha, draftId);
    await waitUntilBlockedBy(alpha.pid, holder.pid, 'the second publisher');

    // Still unpublished while the lock is held. This is the assertion that
    // distinguishes "waited" from "ran and happened to finish second".
    const midFlight = await db.execute<{ status: string; published_listing_id: string | null }>(sql`
      select status, published_listing_id from catalog_authoring_drafts where id = ${draftId}
    `);
    expect([...midFlight][0].status).toBe('open');
    expect([...midFlight][0].published_listing_id).toBeNull();

    /**
     * WHERE it blocked, which is the half a wait alone cannot report — and the
     * only assertion in this case that is specific to `lockDraftForPublish`.
     *
     * Measured: with `.for('update')` deleted from the repository the two
     * assertions above still PASS, because `publishDraft` ends by UPDATEing the
     * draft row and that write blocks on the holder just as the read lock would.
     * So a wait proves serialization and says nothing about the lock. What tells
     * them apart is what the waiter has already DONE: taking the lock first, it
     * has issued only `SELECT`s and holds no write lock on `listings`; without
     * it, it has composed, validated and INSERTED a listing before reaching the
     * stamp, so it holds `RowExclusiveLock` on `listings` while it waits — a
     * listing already written against a draft the publication has not yet been
     * allowed to read.
     */
    const writeLocks = await probe.client<{ relation: string }[]>`
      select c.relname as relation
        from pg_locks l
        join pg_class c on c.oid = l.relation
       where l.pid = ${alpha.pid}
         and l.mode = 'RowExclusiveLock'
         and c.relname in ('listings', 'product_variants', 'catalog_authoring_drafts')
       order by c.relname
    `;
    expect(
      writeLocks.map((row) => row.relation),
      'The waiting publication had already written before it blocked, so the draft lock is not ' +
        'being taken FIRST. `lockDraftForPublish` exists so a second publish waits BEFORE it ' +
        'composes a schema and writes a listing against state that is about to change.',
    ).toEqual([]);

    release();
    await holding;
    const outcome = await publishing;
    expect(outcome.outcome).toBe('published');
  }, 120_000);

  /**
   * Wait until the holder's transaction has actually taken the lock.
   *
   * Not a `sleep`: on a loaded server ~70 worktrees share, a fixed delay is
   * either too short (the publisher wins the lock and the barrier never closes)
   * or a permanent tax on every run. `pg_locks` on the holder's own backend is
   * the fact itself.
   */
  async function waitUntilBlockedByHolderPreflight(): Promise<void> {
    const deadline = Date.now() + BLOCK_WAIT_MS;
    for (;;) {
      const rows = await probe.client<{ held: number }[]>`
        select count(*)::int as held
          from pg_locks
         where pid = ${holder.pid}
           and locktype = 'transactionid'
           and granted
      `;
      if ((rows[0]?.held ?? 0) > 0) return;
      if (Date.now() >= deadline) {
        throw new Error('the holder never opened a transaction, so the barrier could not close');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

describe('two publications of one draft, fired at once', () => {
  let draftId: string;
  let outcomes: readonly DraftPublication[];

  beforeAll(async () => {
    draftId = await authorDraft('race');
    // Two INDEPENDENT connections. On one handle postgres.js would pipeline
    // these and the case would pass however the lock is spelled.
    outcomes = await Promise.all([publishOn(alpha, draftId), publishOn(beta, draftId)]);
  }, 300_000);

  it('publishes exactly once and converges the loser on the same listing', () => {
    const published = outcomes.filter((outcome) => outcome.outcome === 'published');
    const converged = outcomes.filter((outcome) => outcome.outcome === 'converged');
    console.info(
      `[concurrent publish] outcomes: ${outcomes.map((outcome) => outcome.outcome).join(', ')}`,
    );
    expect(published).toHaveLength(1);
    expect(converged).toHaveLength(1);
    // The convergence is only worth anything if it names the SAME listing. A
    // loser answering with a listing of its own is the failure this case exists
    // for, and it would satisfy a count of one-published-one-converged.
    const winner = published[0];
    const loser = converged[0];
    if (winner.outcome !== 'published' || loser.outcome !== 'converged') {
      throw new Error('narrowing failed');
    }
    expect(loser.listingId).toBe(winner.listingId);
  });

  it('leaves exactly ONE listing behind', async () => {
    const listings = await listingsFromDraft(draftId);
    console.info(`[concurrent publish] listings traceable to the draft: ${listings.length}`);
    // Scoped to this store and this draft's title, so a sibling file publishing
    // its own listing cannot move the number.
    expect(listings).toHaveLength(1);
  });

  it('stamps the draft once, with the published listing', async () => {
    const rows = await db.execute<{ status: string; published_listing_id: string | null }>(sql`
      select status, published_listing_id from catalog_authoring_drafts where id = ${draftId}
    `);
    const row = [...rows][0];
    expect(row.status).toBe('published');
    const listings = await listingsFromDraft(draftId);
    expect(row.published_listing_id).toBe(listings[0]);
  });

  it('creates ONE canonical link, not one per publisher', async () => {
    // The other half of the damage a lost lock does, and the half nothing else
    // here would notice: the listing count could be one while a second
    // publication had already written its own link row against it.
    const rows = await db.execute<{ links: number }>(sql`
      select count(*)::int as links
        from native_listing_links n
        join catalog_authoring_drafts d on d.published_listing_id = n.listing_id
       where d.id = ${draftId}
    `);
    const links = [...rows][0].links;
    console.info(`[concurrent publish] native_listing_links for the published listing: ${links}`);
    // Zero is also a legitimate answer — this draft declares no canonical
    // selection — so the assertion is "never more than one", and the count is
    // printed so a later reader can see which it was rather than assuming.
    expect(links).toBeLessThanOrEqual(1);
  });

  it('ran the two publications on different backends — the non-vacuity control', () => {
    // Without this the whole describe is satisfied by one connection running
    // both calls in sequence, which is exactly what a shared `db` handle does.
    expect(alpha.pid).not.toBe(beta.pid);
  });
});

/**
 * The other half of "concurrent draft/publish": two EDITS of one draft.
 *
 * `patchDraft` guards with an optimistic version CAS
 * (`db/catalogAuthoring/draftRepository.ts:190`, `eq(version, expectedVersion)`)
 * and answers a mismatch with "This draft changed while you were editing it"
 * (`draft.service.ts:310`). **Nothing asserted the refusal** — a positive control
 * finds that sentence in production code in two files, and in no test — so the
 * CAS was a convention, and a `patchDraft` that dropped the version predicate
 * would silently let a second editor overwrite the first's variant matrix.
 *
 * A CAS needs no barrier, unlike the publish lock: it is ONE statement, so a
 * stale version is sufficient and deterministic. The concurrent case is here as
 * well, because it is what the box actually names and because two editors racing
 * is the situation the CAS exists for.
 */
describe('two edits of one draft', () => {
  let draftId: string;
  let currentVersion: number;

  beforeAll(async () => {
    const draft = await createDraft(db, {
      storeId,
      actorOxyUserId: phones.actorOxyUserId,
      categoryId,
      productTypeKey: nsKey(ns, 'smartphone'),
      flow: 'merchant',
      locale: 'en',
      market: 'ES',
      permissions: E2E_PERMISSIONS,
      ttlSeconds: 3600,
      idempotencyKey: null,
      title: `Concurrency phone edits`,
    });
    draftId = draft.id;
    currentVersion = draft.version;
  }, 300_000);

  it('accepts an edit at the current version, and moves the version on', async () => {
    // The positive control for both cases below: without it, a refusal could be
    // about the PATCH being invalid rather than about the version being stale.
    const patched = await patchDraft(db, {
      storeId,
      draftId,
      expectedVersion: currentVersion,
      permissions: E2E_PERMISSIONS,
      description: 'The first editor wins.',
    });
    expect(patched.version).toBeGreaterThan(currentVersion);
    currentVersion = patched.version;
  });

  it('refuses the SAME version a second time', async () => {
    const stale = currentVersion - 1;
    await expect(
      patchDraft(db, {
        storeId,
        draftId,
        expectedVersion: stale,
        permissions: E2E_PERMISSIONS,
        description: 'The second editor sends a version that has moved on.',
      }),
      'A stale `expectedVersion` was accepted, so the CAS at draftRepository.ts:190 is not being ' +
        'applied — a second editor silently overwrites the first.',
    ).rejects.toThrow(/changed while you were editing it/u);
  });

  it('lets exactly ONE of two concurrent edits at the same version through', async () => {
    const at = currentVersion;
    const results = await Promise.allSettled([
      patchDraft(alpha.db, {
        storeId,
        draftId,
        expectedVersion: at,
        permissions: E2E_PERMISSIONS,
        description: 'Editor alpha.',
      }),
      patchDraft(beta.db, {
        storeId,
        draftId,
        expectedVersion: at,
        permissions: E2E_PERMISSIONS,
        description: 'Editor beta.',
      }),
    ]);
    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    console.log(`[concurrent edit] fulfilled=${won.length} rejected=${lost.length}`);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser is refused for the RIGHT reason. Without this the case is
    // satisfied by any failure at all, including a connection error.
    const rejection = lost[0] as PromiseRejectedResult;
    expect(String(rejection.reason)).toMatch(/changed while you were editing it/u);
    // Two connections, so this is a real overlap rather than a pipelined pair.
    expect(alpha.pid).not.toBe(beta.pid);
  });
});
