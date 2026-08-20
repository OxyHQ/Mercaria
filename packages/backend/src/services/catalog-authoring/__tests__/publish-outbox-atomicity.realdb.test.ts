/**
 * The offer-convergence outbox row commits WITH the listing it describes
 * (#367 Workstream 18, "test transactional outbox atomicity"), against a REAL
 * PostgreSQL database.
 *
 * ADR 0007 D10 puts the enqueue inside the publication's transaction, and
 * `publish.service.ts:294-309` states what that buys: **a listing can never be
 * committed with no convergence requested.** A listing on sale whose offers were
 * never converged is a buyable row claiming nothing, and nothing downstream
 * repairs it until an unrelated write to that listing happens to enqueue again.
 *
 * ## The direction that matters here is the opposite of moderation's
 *
 * `enqueueOfferConvergence` REQUIRES its handle and accepts either kind, which
 * sits between `enqueueModerationOutboxEvent` — whose `requireTransaction`
 * refuses the root connection outright — and the defaulted
 * `db: DatabaseOrTransaction = getDb()` this repository carried until #584. The
 * middle position is deliberate and the repository's own docblock gives the
 * reason: a moderation row committing alone LOSES or duplicates an abuse report,
 * while a convergence row is a request for a recomputation that re-reads live
 * state when it runs, so one left behind by a rolled-back write converges
 * against live state and finds nothing to do. Escaping the transaction is
 * therefore benign here, and this file does not treat it as a defect — it uses
 * it as a CONTROL, by naming the root connection explicitly.
 *
 * What #584 removed was the ability to reach that connection by ACCIDENT. The
 * two handles share one `DatabaseOrTransaction` type, so a default made
 * forgetting to thread `tx` compile; requiring the parameter makes the same
 * mistake a compile error while leaving the root connection a legitimate thing
 * to ask for.
 *
 * What is NOT benign is the other direction: the listing committing without the
 * row. That is what these cases pin, and it rests on one property nothing
 * exercised — that `enqueueOfferConvergence` writes on the handle it is GIVEN
 * rather than reaching for a connection of its own. If it did the latter, the
 * publication's "in the same transaction as the listing" guarantee would be a
 * sentence in a comment with nothing under it.
 *
 * ## One structural finding, measured while mutation-testing this file
 *
 * For the PUBLISH path specifically, the database already refuses the mistake:
 * mutating `enqueueOfferConvergence` to ignore its handle and use `getDb()`
 * unconditionally does not merely leak a row past a rollback — it fails the
 * publication outright with `23503` on
 * `offer_outboxes_listing_id_listings_id_fk` ("Key (listing_id)=… is not present
 * in table listings"), because the root connection cannot see a listing the
 * transaction has not committed. So the foreign key, not the call site, is what
 * makes the publish's enqueue transactional. That is worth knowing in both
 * directions: it is stronger than a convention, and it holds ONLY where the
 * enqueue names a row created in the same transaction — a caller enqueueing for
 * an already-committed listing (moderation enforcement, `syncListingFacets`) gets
 * no such protection, which is exactly the case the assertions below cover.
 *
 * ## Why the negative control is the load-bearing half
 *
 * Case 1 alone is also what a test of PostgreSQL's rollback semantics looks
 * like — it would pass against any function at all, including one that never
 * wrote anything. Case 2 runs the identical sequence naming the ROOT CONNECTION
 * and asserts the write SURVIVES the rollback. Two facts follow that one assertion
 * cannot give: the fixture really does roll back, and case 1 is measuring the
 * handle rather than the transaction.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row belongs to a listing this file published under a per-run namespace
 * token, every read is keyed on that listing's id, and nothing counts a whole
 * table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { getDb, connectPostgres, type Database } from '../../../db/postgres.js';
import { enqueueOfferConvergence } from '../../../db/offers/offerOutboxRepository.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { publishDraft } from '../publish.service.js';
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
import { reportPopulation } from '../../../__tests__/report-population.js';

const TOKEN = verticalRunToken('outbox');

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let listingId: string;

/**
 * The one outbox row for this file's published listing.
 *
 * `requested_revision` is `bigint`, and postgres.js decodes `int8` as a STRING
 * while drizzle TYPES it `number` — and `mode: 'number'` is applied by the
 * result MAPPER, so it does not reach a raw `db.execute`. The first version of
 * this file compared `before.revision + 1` and got `"21"` from `"2" + 1`, which
 * failed loudly here and would have been a silently wrong comparison in any
 * assertion using `>=`. Cast in SQL and coerce in JS, so neither layer is
 * trusted to have done it.
 */
async function outboxRow(): Promise<{ revision: number; status: string } | null> {
  const rows = await db.execute<{ requested_revision: number; status: string }>(sql`
    select requested_revision::int as requested_revision, status
      from offer_outboxes where listing_id = ${listingId}
  `);
  const row = [...rows][0];
  return row === undefined ? null : { revision: Number(row.requested_revision), status: row.status };
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  const storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Outbox warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);

  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId: category.id,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    title: `Outbox phone ${TOKEN}`,
  });
  await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A phone whose publication must leave a convergence request behind.',
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
    ],
    variants: [
      {
        sku: `${TOKEN}-256`,
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

  const publication = await publishDraft(db, {
    storeId,
    draftId: draft.id,
    actorOxyUserId: phones.actorOxyUserId,
    permissions: E2E_PERMISSIONS,
    idempotencyKey: null,
  });
  if (publication.outcome !== 'published') {
    throw new Error(`expected a publication, got ${publication.outcome}`);
  }
  listingId = publication.listingId;
}, 300_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 300_000);

describe('a publication leaves a convergence request behind', () => {
  it('wrote exactly one outbox row for the listing it committed', async () => {
    const rows = await db.execute<{ rows: number }>(sql`
      select count(*)::int as rows from offer_outboxes where listing_id = ${listingId}
    `);
    const count = [...rows][0].rows;
    // Printed on success: the whole file reads one row by listing id, and every
    // assertion below is vacuously true against zero rows.
    reportPopulation(`[outbox atomicity] offer_outboxes rows for the published listing: ${count}`);
    expect(count).toBe(1);
  });

  it('left it pending, which is what makes it work rather than merely exist', async () => {
    const row = await outboxRow();
    expect(row).not.toBeNull();
    expect(row.status).toBe('pending');
    expect(row.revision).toBeGreaterThanOrEqual(1);
  });
});

describe('the enqueue writes on the handle it is GIVEN', () => {
  it('rolls back with the transaction that called it', async () => {
    const before = await outboxRow();
    expect(before, 'the fixture published no listing').not.toBeNull();

    let seenInside = -1;
    await db
      .transaction(async (tx) => {
        await enqueueOfferConvergence(listingId, tx);
        const inside = await tx.execute<{ requested_revision: number }>(sql`
          select requested_revision::int as requested_revision
            from offer_outboxes where listing_id = ${listingId}
        `);
        seenInside = Number([...inside][0].requested_revision);
        tx.rollback();
      })
      .catch(() => undefined); // `tx.rollback()` throws to unwind; the abort IS the case.

    // The mutation APPLIED: the enqueue really did bump the revision inside the
    // transaction. Without this the case below is satisfied by an enqueue that
    // did nothing at all.
    expect(
      seenInside,
      'the enqueue did not bump the revision inside the transaction, so the rollback assertion ' +
        'below would be satisfied by a function that wrote nothing',
    ).toBe(before.revision + 1);

    const after = await outboxRow();
    expect(
      after.revision,
      'The enqueue survived a rollback of the transaction it was handed. `publish.service.ts:309` ' +
        'passes `tx` precisely so a listing and its convergence request commit together; if the ' +
        'enqueue reaches for its own connection, that guarantee is a comment with nothing under it.',
    ).toBe(before.revision);
  });

  it('does NOT roll back when the ROOT connection is passed — the control that makes the case above about the handle', async () => {
    // The control, not a defect report. Two things follow from this assertion
    // that the previous case cannot give on its own: the fixture's rollback
    // genuinely rolls back, and the previous case is measuring WHICH CONNECTION
    // the enqueue used rather than PostgreSQL's transaction semantics.
    //
    // It used to make its point by OMITTING the handle, because the parameter
    // defaulted to `getDb()`. #584 removed that default from every `enqueue*` —
    // the root `Database` and a transaction share the `DatabaseOrTransaction`
    // type, so a default made forgetting to thread `tx` compile — and this case
    // now names the root connection instead. The control is unchanged in
    // substance: the same connection, the same write, the same survival. What
    // changed is that reaching it is now a decision a reader can see rather than
    // an argument somebody left out.
    //
    // Escaping the transaction stays BENIGN for this particular row, which is
    // the asymmetry with `enqueueModerationOutboxEvent`'s `requireTransaction`
    // that the header describes: a convergence request re-reads live state when
    // it runs, so one left behind by a rolled-back write converges and finds
    // nothing to do. That is why the root connection is still a legitimate
    // argument here and why #584 required the handle rather than refusing the
    // root connection outright.
    const before = await outboxRow();

    await db
      .transaction(async (tx) => {
        // The ROOT connection, deliberately. Nothing inside `tx` touches this
        // row, so the root-connection write cannot block on a lock the
        // transaction holds.
        await enqueueOfferConvergence(listingId, getDb());
        tx.rollback();
      })
      .catch(() => undefined);

    const after = await outboxRow();
    expect(
      after.revision,
      'An enqueue on the root connection was expected to survive the rollback. If it did not, ' +
        'either the enqueue no longer writes on the handle it is given or the previous case is ' +
        'no longer measuring the handle.',
    ).toBe(before.revision + 1);
  });
});
