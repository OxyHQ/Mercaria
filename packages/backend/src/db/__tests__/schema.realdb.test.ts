/**
 * The schema, against a REAL migrated PostGIS database.
 *
 * `schema-conventions.test.ts` next door checks everything that can be answered
 * by reading the drizzle table objects and the `.ts` files. This file checks the
 * half that cannot: what the DDL actually LANDED as, and how the server behaves
 * when a row is written. The two halves are not interchangeable — a CHECK that
 * `text({ enum })` never emitted looks perfectly constrained in the editor, and
 * only a rejected INSERT can tell the difference.
 *
 * Every assertion here was verified by hand against PostGIS 17-3.5 when the
 * schema landed (Fase 1); this file is that verification promoted to a test, so
 * a later migration cannot quietly undo any of it.
 *
 * ## What each assertion is actually worth
 *
 * Several are written in a shape that looks redundant and is not:
 *
 *  - The tsvector is checked with THREE queries — a term only in the
 *    description, a term only in the TAGS (which reach the vector through
 *    `array_to_tsvector`, a separate IMMUTABLE code path), and a term in NEITHER
 *    row. A single positive query cannot tell a working index from one that
 *    matches everything, and the first draft of this check did exactly that.
 *  - The geography column is checked by ORDERING against independently
 *    checkable real-world distances. A test asserting only "a row came back"
 *    passes against a latitude/longitude swap, which is the single most likely
 *    mistake in a coordinate pair and the reason the point is GENERATED.
 *  - The enforcement idempotency key is checked BOTH ways: a replay is rejected
 *    AND a later revision's `restore` is permitted. A key without `revision`
 *    would pass the first assertion and fail the second, and the second is the
 *    half that decides whether an accepted appeal can ever relist an item.
 *
 * ## Isolation
 *
 * `vitest.pg.globalSetup.ts` creates ONE throwaway database for the whole suite,
 * so every realdb file shares it. Nothing here counts rows table-wide: each
 * assertion is scoped to the store this file creates, whose id is generated per
 * run. A test that read `select count(*) from listings` would pass alone and
 * fail the moment a second realdb file was added.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { findSchemaInvariantViolations, findUnsupportedExpiryColumns } from '@oxyhq/db/assert';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { EXPIRY_TARGETS } from '../expiryTargets.js';
import {
  listings,
  moderationEnforcements,
  productVariants,
  stores,
} from '../schema/index.js';
import { deleteTestStores } from './store-teardown.js';

/**
 * Traversal floors for `findSchemaInvariantViolations`. Fewer than this is a
 * broken catalogue query reporting a clean schema, not a clean schema — the
 * table count is the same 57 `schema-conventions.test.ts` pins, and the column
 * floor is a deliberately loose lower bound on a schema whose money columns
 * alone number in the dozens.
 */
const MINIMUM_TABLES = 57;
const MINIMUM_COLUMNS = 400;

/** A 24-char ObjectId hex — the id shape every pre-cutover row carries. */
const OBJECT_ID = 'a1b2c3d4e5f60718293a4b5c';

/** 25 ⊜ in minor units. Past `integer`'s 2_147_483_647 ceiling, which is the point. */
const BIG_AMOUNT = 2_500_000_000;

/** Barcelona, as `(longitude, latitude)` — the order the generated point states. */
const BARCELONA: readonly [number, number] = [2.1734, 41.3851];

let db: Database;
/** This run's store — every assertion below is scoped to it. */
let storeId: string;
/** The uuid-v7 half of the two-id-shapes assertion. */
let uuidListingId: string;

beforeAll(async () => {
  db = await connectPostgres();

  storeId = uuidv7();
  uuidListingId = uuidv7();

  await db.insert(stores).values({
    id: storeId,
    handle: `realdb-${storeId.slice(0, 8)}`,
    name: 'Schema realdb store',
    description: '',
    brandColor: '#000000',
  });
}, 120_000);

afterAll(async () => {
  // `listings.store_id` is ON DELETE RESTRICT — a listing outlives its store on
  // purpose — so the listings go first and take their variants with them
  // (`product_variants.listing_id` DOES cascade).
  await db.delete(listings).where(eq(listings.storeId, storeId));
  await deleteTestStores(db, [storeId]);
  await db.delete(moderationEnforcements).where(eq(moderationEnforcements.subjectId, OBJECT_ID));
  await closePostgres();
});

/**
 * Assert a write is refused by the named CLASS of constraint.
 *
 * Distinguishing check from unique matters: both refuse the write, and a test
 * that only asserted "it threw" would pass if the wrong constraint fired — which
 * is exactly what a mis-typed partial index predicate looks like.
 */
async function expectRefused(
  write: () => Promise<unknown>,
  kind: 'check' | 'unique',
): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  const matched = kind === 'check' ? isCheckViolation(caught) : isUniqueViolation(caught);
  expect(matched, `expected a ${kind} violation, got: ${String(caught)}`).toBe(true);
}

describe('the migrated schema', () => {
  it('breaks no schema-wide invariant the catalogue can see', async () => {
    const violations = await findSchemaInvariantViolations(db, {
      minimumTables: MINIMUM_TABLES,
      minimumColumns: MINIMUM_COLUMNS,
    });
    expect(violations).toEqual([]);
  });

  it('gives every expiry-swept column a supporting leading btree index', async () => {
    const violations = await findUnsupportedExpiryColumns(db, EXPIRY_TARGETS);
    expect(violations).toEqual([]);
  });

  it('registers every expiry target the schema needs', () => {
    // The anti-vacuity floor for the gate above: it reports nothing for an
    // EMPTY target list, so a registry that lost an entry would pass it.
    // Fourteen targets today — three ported TTL indexes, the payment outbox and
    // the provider-event store (born in Postgres), guest_sessions TWICE (one
    // entry per purge trigger: absolute expiry and revocation, ADR 0003 D11),
    // the referral touch evidence store (#142), whose raw rows are retainable
    // separately from the durable attributions derived from them, and the SIX
    // analytics tables (#77), each with its own deadline because retention is
    // per event CLASS and never one blanket TTL, and #62's ingestion rejection
    // residual — the only table in that domain bounded by TRAFFIC rather than
    // by the catalogue, which is why it is the only one swept. #108 adds THREE:
    // portal grants (on a `purge_at` column stamped per PURPOSE, because the
    // ADR gives exchange rows 24 h and portal rows 90 days and this registry
    // has no filter to express two retentions over one table), the
    // transactional-message queue, and the recovery throttle's counters — which
    // are a throttle rather than a history, so keeping them past their window
    // would be keeping a record that somebody asked about an inbox. #124 adds
    // TWO of exactly that traffic-bounded shape (the procurement outbox and the
    // supplier provider-event store) and deliberately leaves its five EVIDENCE
    // tables unswept: they are bounded by the number of purchase orders and are
    // what a chargeback months later is reconciled against.
    // #63 adds THREE more, and their ORDER is the retention argument: a staged
    // upload (7 days; the bytes live on one task's disk and do not survive a
    // deployment), an import report (90 days; an ACTIVE mapping version cites
    // one by foreign key) and its per-record entries (30 days, deliberately
    // SHORTER than the report that counts them, and the only #63 table bounded
    // by traffic).
    // #109 adds ONE — a completed claim's follow-up JOB, the same
    // traffic-bounded shape — and deliberately leaves its two other tables
    // unswept: a claim records who owns a purchase and a revocation records an
    // operator correcting that, so a retention shorter than the orders would
    // answer the only question either exists for with silence.
    // #78 adds ONE — a price OBSERVATION, at the deadline its source's own
    // rights policy set — and leaves its three other tables unswept: points are
    // removed by CASCADE with the observation they cite, a series is one row per
    // question anybody asked, and the write metrics are the counters that make a
    // broken deduplication visible, which is exactly what must not age out.
    // #81 adds ONE — a RECORDED evaluation of a private watchlist, the only
    // table in that domain whose size is a function of how often somebody opens
    // a list — and leaves its three others unswept: a list and its items are a
    // person's own data, removed when they remove them, and a snapshot's LINES
    // CASCADE with the snapshot, so a line can never outlive the evaluation it
    // describes.
    // #95 adds TWO — a clarification session and a recorded interpretation —
    // and leaves its two benchmark tables unswept: a recorded run is what an
    // enablement rests on, and an enablement is a decision somebody made, so a
    // retention on either would leave the parser enabled with its
    // justification gone.
    // #86 adds ONE — a merchant demand SNAPSHOT — and leaves its six others
    // unswept: two CASCADE from the snapshot, and the four acquisition tables
    // are the record of what people decided, which a retention clock destroys.
    // #111 adds THREE, and the SIX it leaves out are the point: the abuse
    // counters, the interventions they produced and the security signal counts
    // are the only tables in that domain bounded by TRAFFIC, while the
    // retention POLICY, the retention RUNS, the legal HOLDS and the two erasure
    // audit tables must all outlive the data they are about — a retention that
    // deleted the record of what the retention WAS, or of why a deletion did
    // NOT happen, would answer the only question an auditor asks with silence.
    // #303 adds ONE, the first from `connectors.ts`: the per-record reasons a
    // sync refused, which is the only table there bounded by TRAFFIC rather
    // than by a merchant's channels. Its two neighbours are deliberately never
    // swept — `connections` and `sync_runs` are the activity log the dashboard
    // reads, and the tally and summary on the run are what survive a swept page.
    // #67 adds ONE — an outbound CLICK, at the deadline its writer stamps from
    // `AFFILIATE_CLICK_RETENTION_DAYS` — and leaves its five others unswept:
    // the destination allow-list is a standing operator decision, and the four
    // commission tables are ACCOUNTING, reconciled against a publisher
    // statement months later. The click is the only table in that domain whose
    // size is a function of TRAFFIC, and it is deliberately retained LONGER
    // than a typical telemetry table (400 days) because a commission reversed
    // eleven months after the fact must still resolve to the offer it was for.
    // #148 adds ONE — a referral RISK SIGNAL, at 400 days — and leaves its four
    // others unswept, which is #148 acceptance 5 as a registry entry: an
    // enforcement ACTION, its appeal, the conduct policy and the disclosure copy
    // are all decisions, and a retention on a decision would leave the effect in
    // force with the reason for it gone. The signal is the only table in that
    // domain whose size is a function of behaviour rather than of decisions, and
    // it deliberately outlives `referral_touches` (30 days past its own
    // attribution window) and dies long before the financial record it may have
    // informed — the separation acceptance 5 names, expressed as two entries in
    // this list with two different clocks.
    // #367 step 5 adds ONE — an abandoned authoring DRAFT — and leaves its
    // other three tables unswept: the two child tables CASCADE from the draft,
    // and the cache register is one row per subject rather than per event. The
    // draft's deadline is NULL exactly when it was published
    // (`catalog_authoring_drafts_expiry_check`), so the sweep's unconditional
    // predicate selects the abandoned set and never the audit record of a
    // listing that exists.
    expect(EXPIRY_TARGETS).toHaveLength(36);
  });
});

describe('primary keys', () => {
  it('accepts BOTH id shapes — a 24-hex ObjectId and a uuid v7', async () => {
    // Deliberately different searchable text, so the tsvector assertions below
    // can tell a working index from one that matches everything.
    await db.insert(listings).values({
      id: OBJECT_ID,
      ownerType: 'store',
      storeId,
      title: 'Vintage bicycle',
      description: 'a red bicycle for sale',
      tags: ['bike', 'red'],
      condition: 'new',
      conditionAssertion: 'seller_declared',
    });
    await db.insert(listings).values({
      id: uuidListingId,
      ownerType: 'store',
      storeId,
      title: 'Ceramic teapot',
      description: 'a small teapot',
      tags: ['kitchen'],
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
    });

    const stored = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.storeId, storeId));
    expect(stored.map((row) => row.id).sort()).toEqual([OBJECT_ID, uuidListingId].sort());
  });
});

describe('money columns', () => {
  it('rejects a currency code outside ALL_CURRENCY_CODES', async () => {
    await expectRefused(
      () =>
        db.insert(productVariants).values({
          listingId: OBJECT_ID,
          priceAmount: 100,
          // The CHECK is the only thing enforcing this: `text({ enum })` emits
          // no DDL, so the narrowing below is erased at runtime.
          priceCurrency: 'XYZ' as 'FAIR',
        }),
      'check',
    );
  });

  it('round-trips a bigint amount past the integer ceiling as a JavaScript number', async () => {
    const variantId = uuidv7();
    await db.insert(productVariants).values({
      id: variantId,
      listingId: OBJECT_ID,
      priceAmount: BIG_AMOUNT,
      priceCurrency: 'FAIR',
    });

    const [row] = await db
      .select({ amount: productVariants.priceAmount })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));

    // The claim the whole money-column decision rests on, and the one thing
    // about it that could not be settled by reading drizzle's source: postgres.js
    // hands `int8` back as a STRING, and `mode: 'number'` is what maps it.
    expect(row?.amount).toBe(BIG_AMOUNT);
    expect(typeof row?.amount).toBe('number');
  });
});

describe('the generated tsvector', () => {
  it('indexes title, description AND tags — and matches nothing it should not', async () => {
    const [vector] = await db
      .select({ text: sql<string>`${listings.searchVector}::text` })
      .from(listings)
      .where(eq(listings.id, OBJECT_ID));
    expect(vector?.text).toBeTruthy();

    const matching = async (term: string): Promise<string[]> => {
      const rows = await db
        .select({ id: listings.id })
        .from(listings)
        .where(
          and(
            eq(listings.storeId, storeId),
            sql`${listings.searchVector} @@ to_tsquery('english', ${term})`,
          ),
        );
      return rows.map((row) => row.id);
    };

    // Only in the description.
    expect(await matching('bicycle')).toEqual([OBJECT_ID]);
    // Only in the TAGS — which reach the vector through `array_to_tsvector`, a
    // separate IMMUTABLE code path from the two `to_tsvector` calls.
    expect(await matching('kitchen')).toEqual([uuidListingId]);
    // In NEITHER row. Without this the two above cannot distinguish a working
    // index from one that matches everything.
    expect(await matching('helicopter')).toEqual([]);
  });
});

describe('the generated geography point', () => {
  it('populates from longitude/latitude and orders by TRUE distance', async () => {
    // Madrid is ~505 km from Barcelona; Paris is ~830 km. The figures are
    // independently checkable ON PURPOSE: a test asserting only "a row came
    // back" passes against a latitude/longitude swap, which yields a plausible
    // point in the wrong place.
    await db
      .update(listings)
      .set({ longitude: -3.7038, latitude: 40.4168 })
      .where(eq(listings.id, OBJECT_ID));
    await db
      .update(listings)
      .set({ longitude: 2.3522, latitude: 48.8566 })
      .where(eq(listings.id, uuidListingId));

    const origin = sql`st_makepoint(${BARCELONA[0]}, ${BARCELONA[1]})::geography`;
    const nearest = await db
      .select({
        id: listings.id,
        km: sql<number>`round((st_distance(${listings.geo}, ${origin}) / 1000)::numeric)`,
      })
      .from(listings)
      .where(and(eq(listings.storeId, storeId), isNotNull(listings.geo)))
      .orderBy(sql`${listings.geo} <-> ${origin}`);

    expect(nearest.map((row) => row.id)).toEqual([OBJECT_ID, uuidListingId]);
    expect(Number(nearest[0]?.km)).toBeGreaterThan(480);
    expect(Number(nearest[0]?.km)).toBeLessThan(530);
    expect(Number(nearest[1]?.km)).toBeGreaterThan(800);
    expect(Number(nearest[1]?.km)).toBeLessThan(860);
  });

  it('stores a Point at SRID 4326, which the typmod cannot declare', async () => {
    // drizzle-kit cannot emit the `(Point,4326)` typmod, so the column is
    // declared bare and this is the only place the claim is checked.
    const [row] = await db
      .select({
        type: sql<string>`st_geometrytype(${listings.geo}::geometry)`,
        srid: sql<number>`st_srid(${listings.geo}::geometry)`,
      })
      .from(listings)
      .where(eq(listings.id, OBJECT_ID));

    expect(row?.type).toBe('ST_Point');
    expect(Number(row?.srid)).toBe(4326);
  });
});

describe('partial unique indexes', () => {
  it('permits many NULL handles and rejects a duplicate value', async () => {
    // This was `product_variants_sku_key` until #296 dropped it — a SKU is
    // unique at no grain Mercaria can enforce without refusing real data, and
    // the barcode unique went with it. The property being measured is the
    // PARTIAL UNIQUE's, not the SKU's, so it moved to the nearest index that
    // both survives and is load-bearing: `listings_store_id_handle_key` is what
    // makes a stranded listing block its own re-import (#221) and what the
    // push-in path surfaces as a genuine merchant conflict.
    //
    // The retired half was the DUPLICATE REJECTION, and what replaced it is not
    // another index: it is a reader that refuses to guess. `matchIncomingVariant`
    // (connector pull) and `resolveInventoryVariant` (push) each return every
    // candidate and name them rather than taking one, which is the check the
    // index was standing in for and could never perform.
    //
    // The other half — a nullable column holding many NULLs at once — did NOT
    // move here, because it does not belong to an index at all once the index is
    // gone. It is now `catalog.realdb.test.ts`'s `nullIfEmpty` case, which is
    // where it becomes a real assertion: the version that stood here wrote rows
    // with the `sku` key ABSENT, so it never passed a value through
    // `nullIfEmpty` and after the drop would have asserted nothing whatever.
    const nullHandles = await db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.storeId, storeId), isNull(listings.handle)));
    // Both listings this file created, neither of which states a handle.
    expect(nullHandles).toHaveLength(2);

    const handle = `handle-${storeId.slice(0, 8)}`;
    const withHandle = {
      ownerType: 'store' as const,
      storeId,
      title: 'Handled listing',
      description: 'carries a handle',
      condition: 'new' as const,
      conditionAssertion: 'seller_declared' as const,
      handle,
    };
    await db.insert(listings).values({ id: uuidv7(), ...withHandle });
    // An empty string would NOT behave this way — it is a VALUE and collides for
    // real, which is why a sparse-unique column must be written NULL.
    await expectRefused(
      () => db.insert(listings).values({ id: uuidv7(), ...withHandle }),
      'unique',
    );
  });
});

describe('the moderation enforcement idempotency key', () => {
  const base = {
    decisionId: `dec-${OBJECT_ID}`,
    revision: 1,
    action: 'restrict' as const,
    subjectType: 'listing' as const,
    subjectId: OBJECT_ID,
    applied: true,
    reason: 'schema realdb',
  };

  it('rejects a replay, and permits a later revision’s restore', async () => {
    await db.insert(moderationEnforcements).values(base);
    await expectRefused(() => db.insert(moderationEnforcements).values(base), 'unique');

    // The half that matters. A key without `revision` passes the assertion above
    // and fails this one — and failing this one means an accepted appeal can
    // never relist the item it restores.
    await db
      .insert(moderationEnforcements)
      .values({ ...base, revision: 2, action: 'restore' });

    const ledger = await db
      .select({ action: moderationEnforcements.action })
      .from(moderationEnforcements)
      .where(eq(moderationEnforcements.subjectId, OBJECT_ID));
    expect(ledger.map((row) => row.action).sort()).toEqual(['restore', 'restrict']);
  });
});

describe('the owner-exclusivity CHECK', () => {
  it('rejects a store listing carrying an oxyUserId', async () => {
    // The `pre('validate')` hook this replaces ran on `save()` and NOT on
    // `updateOne`, `insertMany` or a backfill. The constraint has no such gap.
    await expectRefused(
      () =>
        db.insert(listings).values({
          id: uuidv7(),
          ownerType: 'store',
          storeId,
          oxyUserId: 'u1',
          title: 'X',
          // Supplied so the row is otherwise VALID: without it the insert fails
          // its NOT NULL first and `expectRefused` reports a 23502, never
          // reaching the CHECK this test exists to exercise.
          description: '',
          condition: 'new',
          conditionAssertion: 'seller_declared',
        }),
      'check',
    );
  });
});

describe('the counter sequences', () => {
  it('allocate distinct ascending numbers', async () => {
    // Not asserted to start at 1: this database is shared with every other
    // realdb file in the suite, and a sequence another test drew from is still
    // a correct sequence. Distinct AND ascending is the whole property the
    // `Counter` collection's `findByIdAndUpdate($inc)` provided.
    const next = async (sequence: string): Promise<number> => {
      const rows = await db.execute(sql`select nextval(${sequence}) as n`);
      return Number(rows[0]?.n);
    };

    const firstOrder = await next('order_number_seq');
    const secondOrder = await next('order_number_seq');
    const firstRma = await next('rma_number_seq');

    expect(secondOrder).toBeGreaterThan(firstOrder);
    expect(Number.isInteger(firstRma)).toBe(true);
  });
});
