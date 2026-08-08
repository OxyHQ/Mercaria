/**
 * The Fase 4 backfill, against a real MongoDB AND a real PostgreSQL.
 *
 * ## Why both have to be real
 *
 * The script's whole job is to move data between two servers, and every property
 * worth testing is a property one of them enforces:
 *
 *  - the enum audit exists to catch a value the Postgres CHECK would reject. A
 *    mocked insert accepts anything, so a mocked test cannot tell a working
 *    audit from an absent one — it would pass either way.
 *  - `ON CONFLICT DO NOTHING` on the verbatim source id is what makes a re-run
 *    resume instead of duplicate. That is a unique-constraint behaviour.
 *  - `distinct()` descending an array (`members.role`, `members.permissions`) is
 *    a MongoDB behaviour the script relies on and does not implement.
 *
 * ## The fixture is the real census, plus one deliberate poison
 *
 * The 2026-08-08 production census found exactly three documents: one store, one
 * location, one user preference. That shape is seeded verbatim, so the copy path
 * under test is the one the cutover will actually run rather than a scaled-down
 * imitation of a bigger migration.
 *
 * The audit tests then add a value no CHECK accepts and assert the run REFUSES.
 * That is the assertion that would silently pass against a broken audit if the
 * fixture were clean, so it is the one the file is really built around.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, type Database } from '../../db/postgres.js';
import { locations, storeMembers, stores } from '../../db/schema/stores.js';
import { userPreferences } from '../../db/schema/buyers.js';
import {
  COLLECTION_MAP,
  applySequences,
  assertExpectedEmpties,
  assertMapIsTotal,
  auditEnums,
  censusCollections,
  runBackfill,
  verify,
} from '../backfill-mongo-to-postgres.js';

/** The census's real ids, so the verbatim-id assertion is about real values. */
const STORE_ID = '6a39a7d5b5809e55ba556ad0';
const LOCATION_ID = '6a39a7d5b5809e55ba556ae1';
const PREFERENCE_ID = '6a39a7d5b5809e55ba556af2';
const OWNER = 'oxy-user-owner';

let mongod: MongoMemoryServer;
let db: Database;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'mercaria-backfill-test' });
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  await closePostgres();
});

beforeEach(async () => {
  // The MONGO side is this file's own in-memory server, so it can be cleared
  // wholesale. The POSTGRES side deliberately is not: realdb files share one
  // throwaway database and run in parallel, so a TRUNCATE here would take
  // another file's rows with it. Every Postgres assertion below is scoped to
  // the three ids this file seeds.
  const database = mongoose.connection.db;
  if (!database) throw new Error('no mongo handle');
  // DROP, not `deleteMany`. The map's completeness check reads
  // `listCollections`, so an emptied-but-existing collection is still live to it
  // — the `loyaltypoints` fixture from one test would fail every later one.
  for (const { name } of await database.listCollections().toArray()) {
    await database.collection(name).drop();
  }
  await db.delete(storeMembers).where(sql`${storeMembers.storeId} = ${STORE_ID}`);
  await db.delete(locations).where(sql`${locations.id} = ${LOCATION_ID}`);
  await db.delete(stores).where(sql`${stores.id} = ${STORE_ID}`);
  await db.delete(userPreferences).where(sql`${userPreferences.id} = ${PREFERENCE_ID}`);
});

/**
 * Seed the census shape.
 *
 * EVERY collection in the map is created, empty ones included, because the map's
 * completeness check reads a live `listCollections` — a fixture that created
 * only the three populated collections would exercise a much weaker check than
 * production will.
 */
async function seedCensus(overrides: { storeMemberRole?: string } = {}): Promise<void> {
  const database = mongoose.connection.db;
  if (!database) throw new Error('no mongo handle');
  for (const name of Object.keys(COLLECTION_MAP)) {
    await database.createCollection(name).catch(() => undefined);
  }
  const now = new Date('2026-08-01T10:00:00.000Z');

  await database.collection('stores').insertOne({
    _id: STORE_ID as unknown as never,
    handle: 'acme-supply-co',
    name: 'Acme Supply Co',
    description: 'Everything and anvils',
    brandColor: '#1d4ed8',
    textTone: 'light',
    status: 'active',
    members: [
      {
        oxyUserId: OWNER,
        role: overrides.storeMemberRole ?? 'owner',
        permissions: ['store:manage'],
        joinedAt: now,
      },
    ],
    policies: { returnWindowDays: 30 },
    defaultCurrency: 'FAIR',
    taxSettings: { pricesIncludeTax: false, chargeTaxOnProducts: true },
    notificationSettings: { lowStockAlerts: true, orderEmails: true },
    rating: 4.5,
    reviewCount: 2,
    productCount: 0,
    salesCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  await database.collection('locations').insertOne({
    _id: LOCATION_ID as unknown as never,
    storeId: STORE_ID,
    name: 'Default',
    type: 'warehouse',
    address: { recipientName: 'Acme', line1: '1 Anvil Way', city: 'Valencia', postalCode: '46001', country: 'ES' },
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
    createdAt: now,
    updatedAt: now,
  });

  await database.collection('userpreferences').insertOne({
    _id: PREFERENCE_ID as unknown as never,
    oxyUserId: OWNER,
    preferredCurrency: 'EUR',
    dualDisplayEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

describe('the collection map is total', () => {
  it('accepts a source whose every collection is accounted for', async () => {
    await seedCensus();
    const live = await censusCollections();
    expect(live.length).toBe(Object.keys(COLLECTION_MAP).length);
    expect(() => assertMapIsTotal(live)).not.toThrow();
  });

  it('REFUSES a collection in neither the copy, expect-empty nor exclude list', async () => {
    await seedCensus();
    // The failure the map exists for: something started writing a collection
    // nobody told the backfill about. Silently skipping it is data loss.
    await mongoose.connection.db?.createCollection('loyaltypoints');
    const live = await censusCollections();
    expect(() => assertMapIsTotal(live)).toThrow(/loyaltypoints/);
  });

  it('REFUSES when a collection the map calls empty is not', async () => {
    await seedCensus();
    await mongoose.connection.db?.collection('orders').insertOne({ orderNumber: 'MRC-000001' });
    const live = await censusCollections();
    await expect(assertExpectedEmpties(live)).rejects.toThrow(/orders \(1\)/);
  });
});

describe('the enum audit', () => {
  it('passes on the census as it stands', async () => {
    await seedCensus();
    const live = await censusCollections();
    await expect(auditEnums(live)).resolves.toBeUndefined();
  });

  it('REFUSES a widened value before writing anything', async () => {
    // `superadmin` is not in STORE_ROLES, so `store_members_role_check` would
    // reject it — mid-insert, after the store row had already landed. The audit
    // turns that half-copied database into a refused run.
    await seedCensus({ storeMemberRole: 'superadmin' });
    const live = await censusCollections();
    await expect(auditEnums(live)).rejects.toThrow(/superadmin/);

    // And nothing was written: the audit runs BEFORE the copy, which is the
    // whole point of auditing rather than catching the constraint error.
    const rows = await db.select().from(stores).where(sql`${stores.id} = ${STORE_ID}`);
    expect(rows).toHaveLength(0);
  });

  it('descends into an ARRAY field, which is where a bad permission would hide', async () => {
    await seedCensus();
    await mongoose.connection.db
      ?.collection('stores')
      .updateOne({ _id: STORE_ID as unknown as never }, { $set: { 'members.0.permissions': ['store:manage', 'store:invent'] } });
    const live = await censusCollections();
    await expect(auditEnums(live)).rejects.toThrow(/store:invent/);
  });
});

describe('the copy', () => {
  it('carries ids VERBATIM and every field through the transform', async () => {
    await seedCensus();
    await runBackfill(db, 'copy');

    const [store] = await db.select().from(stores).where(sql`${stores.id} = ${STORE_ID}`);
    expect(store.id).toBe(STORE_ID);
    expect(store.handle).toBe('acme-supply-co');
    expect(store.description).toBe('Everything and anvils');
    expect(store.rating).toBe(4.5);
    expect(store.defaultCurrency).toBe('FAIR');
    // An absent optional becomes NULL, never the empty string — `''` is a value
    // and would make "no logo" indistinguishable from a cleared one.
    expect(store.logoFileId).toBeNull();
    expect(store.policiesReturnWindowDays).toBe(30);
    expect(store.createdAt.toISOString()).toBe('2026-08-01T10:00:00.000Z');

    const members = await db
      .select()
      .from(storeMembers)
      .where(sql`${storeMembers.storeId} = ${STORE_ID}`);
    expect(members).toHaveLength(1);
    expect(members[0].oxyUserId).toBe(OWNER);
    expect(members[0].role).toBe('owner');
    expect(members[0].permissions).toEqual(['store:manage']);

    const [location] = await db.select().from(locations).where(sql`${locations.id} = ${LOCATION_ID}`);
    expect(location.id).toBe(LOCATION_ID);
    expect(location.storeId).toBe(STORE_ID);
    expect(location.addressCity).toBe('Valencia');
    // The label was absent in the source and must not have been invented.
    expect(location.addressLabel).toBeNull();
    expect(location.isDefault).toBe(true);

    const [preference] = await db
      .select()
      .from(userPreferences)
      .where(sql`${userPreferences.id} = ${PREFERENCE_ID}`);
    expect(preference.preferredCurrency).toBe('EUR');
    // Absent in the source, and nullable in Postgres — not defaulted to FAIR.
    expect(preference.secondaryCurrency).toBeNull();
  });

  it('is IDEMPOTENT: a second run adds nothing and changes nothing', async () => {
    await seedCensus();
    await runBackfill(db, 'copy');
    const first = await db.select().from(stores).where(sql`${stores.id} = ${STORE_ID}`);

    await runBackfill(db, 'copy');

    const second = await db.select().from(stores).where(sql`${stores.id} = ${STORE_ID}`);
    expect(second).toHaveLength(1);
    expect(second[0].updatedAt.toISOString()).toBe(first[0].updatedAt.toISOString());
    // Members carry a MINTED id, so only the (store, user) unique index stops a
    // second row here — this is the assertion that would catch its removal.
    const members = await db
      .select()
      .from(storeMembers)
      .where(sql`${storeMembers.storeId} = ${STORE_ID}`);
    expect(members).toHaveLength(1);
  });

  it('verification catches a row that was changed underneath it', async () => {
    await seedCensus();
    await runBackfill(db, 'copy');
    const live = await censusCollections();
    await expect(verify(db, live)).resolves.toBeUndefined();

    // A verify that could not fail would be worthless, so prove it fails.
    await db.update(stores).set({ name: 'Tampered' }).where(sql`${stores.id} = ${STORE_ID}`);
    await expect(verify(db, live)).rejects.toThrow(/name: expected "Acme Supply Co"/);
  });
});

describe('the sequences', () => {
  it('sets each one from its COUNTER, not from the highest number used', async () => {
    await seedCensus();
    // A counter ahead of any number actually issued — the gap-carrying case that
    // makes `max(order_number)` the wrong source. Seeding 41 here means the next
    // order must be 42, even though no order row exists at all.
    await mongoose.connection.db?.collection('counters').insertMany([
      { _id: 'order' as unknown as never, seq: 41 },
      { _id: 'rma' as unknown as never, seq: 7 },
    ]);

    await applySequences(db);

    const [order] = await db.execute<{ n: string }>(sql`select nextval('order_number_seq') as n`);
    expect(Number(order.n)).toBe(42);
    const [rma] = await db.execute<{ n: string }>(sql`select nextval('rma_number_seq') as n`);
    expect(Number(rma.n)).toBe(8);
  });

  it('leaves a sequence alone when its counter is ABSENT, which is today’s case', async () => {
    await seedCensus();
    // The census found `counters` empty. Nothing has been numbered, so the
    // sequence must keep whatever it is on rather than being reset — a `setval`
    // to 0 here would hand out a number another realdb file had already taken.
    const [before] = await db.execute<{ n: string }>(sql`select last_value as n from order_number_seq`);
    await applySequences(db);
    const [after] = await db.execute<{ n: string }>(sql`select last_value as n from order_number_seq`);
    expect(after.n).toBe(before.n);
  });
});
