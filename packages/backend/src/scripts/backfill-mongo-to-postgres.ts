/**
 * Fase 4 — copy the production MongoDB contents into PostgreSQL, once.
 *
 * Usage (both database names are REQUIRED and both are verified against the
 * live connections before anything is read or written):
 *
 *   node packages/backend/dist/scripts/backfill-mongo-to-postgres.js \
 *     --source-database=mercaria-production --target-database=mercaria
 *
 *   --audit-only    census + map completeness + enum audit. Writes NOTHING.
 *   --verify-only   compare what is already in Postgres against Mongo. Writes
 *                   NOTHING. Safe to run against a live cutover at any time.
 *
 * ## Why the database names are arguments rather than read off the URLs
 *
 * The URLs come from the environment, which is exactly what is easiest to get
 * wrong under pressure: a task definition pointed at staging, a shell with a
 * stale `MONGODB_URI` exported. Naming both databases makes the run state its
 * intent, and the check below turns a mismatch into a refusal instead of a
 * backfill into the wrong database. It is the same guard `db/migrate.ts` already
 * applies with `--target-database`, for the same reason.
 *
 * ## The collection map is TOTAL, and re-censused at run time
 *
 * Every collection that exists in the live source must appear in
 * `COLLECTION_MAP` under one of three dispositions. A collection in NONE of them
 * is a hard failure, never a silent skip — which is the whole point, because the
 * failure this prevents is data nobody knew about being left behind.
 *
 *  - `copy`        — has a transform, and its rows are written.
 *  - `expect-empty` — no transform, and the run REFUSES if it holds documents.
 *  - `exclude`     — deliberately never copied, with the reason stated.
 *
 * `expect-empty` is the important one and is not a synonym for `exclude`. The
 * 2026-08-08 census found exactly three documents in the whole database (one
 * store, one location, one user preference) and 28 empty collections. Writing 28
 * transforms against no data would be 28 untested transforms; excluding them
 * outright would silently drop anything written between that census and the
 * cutover. Asserting they are still empty is the honest third option: it costs a
 * `countDocuments` each and converts "the census went stale" from data loss into
 * a failed run that says which collection changed.
 *
 * ## Verification, and what it does NOT prove
 *
 * `--verify-only` re-reads every source document, applies the SAME transform,
 * and compares field by field against the row in Postgres. That proves the row
 * LANDED as the transform intended — a partial insert, a truncation, a driver
 * coercion, a row lost to `ON CONFLICT`. It cannot prove the transform itself is
 * right, because a wrong transform is applied identically on both sides. That is
 * what `__tests__/backfill.realdb.test.ts` is for, and the division is stated
 * here so nobody reads a green verify as more than it is.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { ALL_CURRENCY_CODES } from '@mercaria/shared-types';
import { connectPostgres, closePostgres, type Database } from '../db/postgres.js';
// The audit tuples come from the SCHEMA, which is where the CHECKs are rendered
// from — so an audit can never allow a value the constraint would reject.
import {
  LOCATION_TYPES,
  STORE_PERMISSIONS,
  STORE_ROLES,
  STORE_STATUSES,
  TEXT_TONES,
  locations,
  storeMembers,
  stores,
} from '../db/schema/stores.js';
import { userPreferences } from '../db/schema/buyers.js';
import { log } from '../lib/logger.js';

/** A Mongo document, before any transform. Deliberately untyped at the edge. */
type SourceDoc = Record<string, unknown>;

/**
 * The insert types drizzle infers for each destination table.
 *
 * Used as the transforms' RETURN types rather than a shared
 * `Record<string, unknown>`: a mistyped or misspelled column then fails `tsc`
 * here, at the transform, instead of at the insert as an overload error that
 * names the whole table.
 */
type StoreRow = typeof stores.$inferInsert;
type StoreMemberRow = typeof storeMembers.$inferInsert;
type LocationRow = typeof locations.$inferInsert;
type UserPreferenceRow = typeof userPreferences.$inferInsert;

/** Which source values a CHECK-constrained column is allowed to hold. */
interface EnumAudit {
  /** Dotted path in the Mongo document, e.g. `members.role`. */
  field: string;
  /** The tuple the Postgres CHECK is rendered from. */
  allowed: readonly string[];
}

interface CopyEntry {
  disposition: 'copy';
  /** Stated so the run log names the destination, not just the source. */
  target: string;
  audits: EnumAudit[];
}
interface ExpectEmptyEntry {
  disposition: 'expect-empty';
  reason: string;
}
interface ExcludeEntry {
  disposition: 'exclude';
  reason: string;
}
type MapEntry = CopyEntry | ExpectEmptyEntry | ExcludeEntry;

/**
 * The reason shared by every collection the 2026-08-08 census found empty.
 *
 * Stated once rather than 27 times: repeating it would make the list look like
 * 27 considered decisions when it is one decision applied 27 times, and the next
 * person needs to see that clearly to know what changes if a collection fills.
 */
const EMPTY_AT_CENSUS =
  'Empty in the 2026-08-08 production census. No transform is written for it, ' +
  'and the run refuses if it holds documents — so this becomes a loud failure ' +
  'rather than silent data loss if anything writes here before the cutover.';

/**
 * EVERY collection in the source, and what happens to it.
 *
 * Checked for completeness against a LIVE `listCollections` at run time, in both
 * directions: a live collection missing here fails, and an entry here naming a
 * collection that no longer exists is reported as stale.
 */
export const COLLECTION_MAP: Record<string, MapEntry> = {
  stores: {
    disposition: 'copy',
    target: 'stores + store_members',
    audits: [
      { field: 'textTone', allowed: TEXT_TONES },
      { field: 'status', allowed: STORE_STATUSES },
      { field: 'defaultCurrency', allowed: ALL_CURRENCY_CODES },
      { field: 'members.role', allowed: STORE_ROLES },
      { field: 'members.permissions', allowed: STORE_PERMISSIONS },
    ],
  },
  locations: {
    disposition: 'copy',
    target: 'locations',
    audits: [{ field: 'type', allowed: LOCATION_TYPES }],
  },
  userpreferences: {
    disposition: 'copy',
    target: 'user_preferences',
    audits: [
      { field: 'preferredCurrency', allowed: ALL_CURRENCY_CODES },
      { field: 'secondaryCurrency', allowed: ALL_CURRENCY_CODES },
    ],
  },

  counters: {
    disposition: 'exclude',
    reason:
      'Consumed by the sequence step below rather than copied. Postgres holds ' +
      'these as SEQUENCES, not rows, so there is no table to copy them into — ' +
      'their values become `setval` calls.',
  },

  abusereports: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  addresses: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  carts: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  categories: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  channelapikeys: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  collections: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  connections: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  customers: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  discounts: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  draftorders: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  favorites: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  feedbacks: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  inventorylevels: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  listings: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  moderationenforcements: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  moderationevents: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  moderationoutboxes: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  notifications: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  orders: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  productvariants: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  pushtokens: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  refunds: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  reviews: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  sellerprofiles: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  syncruns: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  taxrates: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
  webpushsubscriptions: { disposition: 'expect-empty', reason: EMPTY_AT_CENSUS },
};

/**
 * Mongo counter document id → Postgres sequence.
 *
 * `draftOrder` is deliberately absent: `nextDraftOrderNumber` had zero call
 * sites, so `0001_counter_sequences.sql` created two sequences rather than
 * three. A counter with no sequence is reported, not silently dropped.
 */
export const SEQUENCE_FOR_COUNTER: Record<string, string> = {
  order: 'order_number_seq',
  rma: 'rma_number_seq',
};

/** Read `--flag=value`, or `undefined`. */
function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length).trim() || undefined;
}


/** A Mongo `_id` as the verbatim string Postgres stores. */
function idOf(doc: SourceDoc): string {
  return String(doc._id);
}

/** NULL for an absent optional — never `''`, which is a VALUE, not absence. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A Mongoose timestamp, or now for a document written before they existed. */
function timestamp(value: unknown): Date {
  return value instanceof Date ? value : new Date();
}

export function transformStore(doc: SourceDoc): { store: StoreRow; members: StoreMemberRow[] } {
  const id = idOf(doc);
  const policies = (doc.policies ?? {}) as Record<string, unknown>;
  const tax = (doc.taxSettings ?? {}) as Record<string, unknown>;
  const notify = (doc.notificationSettings ?? {}) as Record<string, unknown>;
  const members = Array.isArray(doc.members) ? (doc.members as Record<string, unknown>[]) : [];

  return {
    store: {
      id,
      handle: String(doc.handle),
      name: String(doc.name),
      // NOT NULL with no default in Postgres, `default: ''` in Mongoose — an
      // absent description becomes the empty string the column expects rather
      // than failing the insert.
      description: typeof doc.description === 'string' ? doc.description : '',
      logoFileId: optionalText(doc.logoFileId),
      coverFileId: optionalText(doc.coverFileId),
      brandColor: String(doc.brandColor),
      textTone: String(doc.textTone ?? 'light') as StoreRow['textTone'],
      status: String(doc.status ?? 'active') as StoreRow['status'],
      policiesReturnWindowDays: Number(policies.returnWindowDays ?? 30),
      policiesShippingNote: optionalText(policies.shippingNote),
      policiesRefundPolicy: optionalText(policies.refundPolicy),
      policiesPrivacyPolicy: optionalText(policies.privacyPolicy),
      policiesTermsOfService: optionalText(policies.termsOfService),
      defaultCurrency: String(doc.defaultCurrency ?? 'FAIR'),
      taxSettingsPricesIncludeTax: Boolean(tax.pricesIncludeTax ?? false),
      taxSettingsTaxRegistrationId: optionalText(tax.taxRegistrationId),
      taxSettingsChargeTaxOnProducts: Boolean(tax.chargeTaxOnProducts ?? true),
      notificationSettingsLowStockAlerts: Boolean(notify.lowStockAlerts ?? true),
      notificationSettingsOrderEmails: Boolean(notify.orderEmails ?? true),
      notificationSettingsLowStockThreshold:
        notify.lowStockThreshold === undefined || notify.lowStockThreshold === null
          ? null
          : Number(notify.lowStockThreshold),
      rating: Number(doc.rating ?? 0),
      reviewCount: Number(doc.reviewCount ?? 0),
      productCount: Number(doc.productCount ?? 0),
      salesCount: Number(doc.salesCount ?? 0),
      createdAt: timestamp(doc.createdAt),
      updatedAt: timestamp(doc.updatedAt),
    },
    // Members were an EMBEDDED array declared `{ _id: false }`, so unlike every
    // other row here there is no source id to carry — these are minted. Safe to
    // repeat because `store_members_store_id_oxy_user_id_key` makes the insert
    // idempotent on (store, user) rather than on the id.
    members: members.map((member) => ({
      id: uuidv7(),
      storeId: id,
      oxyUserId: String(member.oxyUserId),
      role: String(member.role) as StoreMemberRow['role'],
      permissions: (Array.isArray(member.permissions)
        ? member.permissions.map(String)
        : []) as StoreMemberRow['permissions'],
      invitedBy: optionalText(member.invitedBy),
      joinedAt: timestamp(member.joinedAt),
    })),
  };
}

export function transformLocation(doc: SourceDoc): LocationRow {
  const address = (doc.address ?? {}) as Record<string, unknown>;
  return {
    id: idOf(doc),
    storeId: String(doc.storeId),
    name: String(doc.name),
    type: String(doc.type ?? 'warehouse') as LocationRow['type'],
    addressLabel: optionalText(address.label),
    addressRecipientName: optionalText(address.recipientName),
    addressLine1: optionalText(address.line1),
    addressLine2: optionalText(address.line2),
    addressCity: optionalText(address.city),
    addressRegion: optionalText(address.region),
    addressPostalCode: optionalText(address.postalCode),
    addressCountry: optionalText(address.country),
    addressPhone: optionalText(address.phone),
    isDefault: Boolean(doc.isDefault ?? false),
    isActive: Boolean(doc.isActive ?? true),
    fulfillsOnlineOrders: Boolean(doc.fulfillsOnlineOrders ?? true),
    createdAt: timestamp(doc.createdAt),
    updatedAt: timestamp(doc.updatedAt),
  };
}

export function transformUserPreference(doc: SourceDoc): UserPreferenceRow {
  return {
    id: idOf(doc),
    oxyUserId: String(doc.oxyUserId),
    preferredCurrency: optionalText(doc.preferredCurrency) as UserPreferenceRow['preferredCurrency'],
    secondaryCurrency: optionalText(doc.secondaryCurrency) as UserPreferenceRow['secondaryCurrency'],
    dualDisplayEnabled: Boolean(doc.dualDisplayEnabled ?? true),
    createdAt: timestamp(doc.createdAt),
    updatedAt: timestamp(doc.updatedAt),
  };
}

/**
 * One `copy` collection: how to write it, and what its rows should look like.
 *
 * `copy` and `expected` come from the SAME transform, which is what lets
 * `--verify-only` check a database this run did not write. Each step keeps its
 * own drizzle types inside its closure, so the heterogeneous list below needs no
 * cast and a mistyped column still fails at the transform.
 */
interface CopyStep {
  collection: string;
  table: string;
  copy: (db: Database, docs: SourceDoc[]) => Promise<number>;
  /** The row each source document should have produced, keyed by its id. */
  expected: (docs: SourceDoc[]) => Map<string, Record<string, unknown>>;
}

export const COPY_STEPS: CopyStep[] = [
  {
    collection: 'stores',
    table: 'stores',
    copy: async (db, docs) => {
      const plans = docs.map(transformStore);
      // `onConflictDoNothing` on the PRIMARY KEY, which is the verbatim source
      // id — so a re-run after a partial failure resumes rather than
      // duplicating, and never overwrites a row the live system has changed.
      await db.insert(stores).values(plans.map((plan) => plan.store)).onConflictDoNothing();
      const members = plans.flatMap((plan) => plan.members);
      if (members.length > 0) {
        await db
          .insert(storeMembers)
          .values(members)
          .onConflictDoNothing({ target: [storeMembers.storeId, storeMembers.oxyUserId] });
      }
      return plans.length;
    },
    expected: (docs) => new Map(docs.map((doc) => [idOf(doc), { ...transformStore(doc).store }])),
  },
  {
    collection: 'locations',
    table: 'locations',
    copy: async (db, docs) => {
      await db.insert(locations).values(docs.map(transformLocation)).onConflictDoNothing();
      return docs.length;
    },
    expected: (docs) => new Map(docs.map((doc) => [idOf(doc), { ...transformLocation(doc) }])),
  },
  {
    collection: 'userpreferences',
    table: 'user_preferences',
    copy: async (db, docs) => {
      await db.insert(userPreferences).values(docs.map(transformUserPreference)).onConflictDoNothing();
      return docs.length;
    },
    expected: (docs) => new Map(docs.map((doc) => [idOf(doc), { ...transformUserPreference(doc) }])),
  },
];

/** Which collections actually exist in the source, right now. */
export async function censusCollections(): Promise<string[]> {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB connection has no database handle.');
  const found = await database.listCollections().toArray();
  return found.map((entry) => entry.name).sort();
}

/**
 * Refuse unless the map accounts for every live collection.
 *
 * Both directions are reported. A live collection with no entry is FATAL — it is
 * the "data nobody knew about" case this map exists for. An entry naming a
 * collection that no longer exists is only a warning: dropping a collection is a
 * legitimate thing to have done, and failing on it would make this script the
 * reason a cutover cannot proceed.
 */
export function assertMapIsTotal(live: readonly string[]): void {
  const unmapped = live.filter((name) => !(name in COLLECTION_MAP));
  if (unmapped.length > 0) {
    throw new Error(
      `${unmapped.length} live collection(s) are in neither the copy, expect-empty nor ` +
        `exclude list: ${unmapped.join(', ')}. Refusing to run — an unmapped collection ` +
        `is data this backfill would leave behind without saying so. Add each to ` +
        `COLLECTION_MAP with a transform or a stated reason.`,
    );
  }
  const stale = Object.keys(COLLECTION_MAP).filter((name) => !live.includes(name));
  if (stale.length > 0) {
    log.general.warn(
      { stale },
      '[backfill] COLLECTION_MAP names collections that no longer exist in the source',
    );
  }
}

/**
 * Every CHECK-constrained column's DISTINCT source values, against its tuple.
 *
 * Runs before any insert, and reports EVERY offending field rather than stopping
 * at the first: an operator mid-cutover needs the whole list, not one value per
 * failed run.
 *
 * A WIDENING is what this catches — a value written by an older image or a hand
 * edit that the Postgres CHECK will reject. Finding it here costs a refused run;
 * finding it during the insert costs a half-copied database.
 */
export async function auditEnums(live: readonly string[]): Promise<void> {
  const problems: string[] = [];

  for (const [collection, entry] of Object.entries(COLLECTION_MAP)) {
    if (entry.disposition !== 'copy' || !live.includes(collection)) continue;
    const handle = mongoose.connection.db?.collection(collection);
    if (!handle) continue;

    for (const audit of entry.audits) {
      // `distinct` descends arrays itself, which is what makes one call correct
      // for `members.role` and for the `members.permissions` string array alike.
      const values = await handle.distinct(audit.field);
      const offending = values
        .filter((value) => value !== null && value !== undefined)
        .map(String)
        .filter((value) => !audit.allowed.includes(value));
      if (offending.length > 0) {
        problems.push(
          `${collection}.${audit.field}: ${offending.map((v) => JSON.stringify(v)).join(', ')} ` +
            `(allowed: ${audit.allowed.join(', ')})`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `The source holds ${problems.length} value(s) no Postgres CHECK accepts:\n  ` +
        problems.join('\n  ') +
        `\nRefusing to copy. Every one would be rejected mid-insert, leaving the ` +
        `target half-populated. Correct them at the source, or widen the tuple AND ` +
        `its migration, then re-run.`,
    );
  }
}

/** Refuse if a collection the map calls empty is not. */
export async function assertExpectedEmpties(live: readonly string[]): Promise<void> {
  const populated: string[] = [];
  for (const [collection, entry] of Object.entries(COLLECTION_MAP)) {
    if (entry.disposition !== 'expect-empty' || !live.includes(collection)) continue;
    const count = (await mongoose.connection.db?.collection(collection).countDocuments()) ?? 0;
    if (count > 0) populated.push(`${collection} (${count})`);
  }
  if (populated.length > 0) {
    throw new Error(
      `${populated.length} collection(s) the map expects to be EMPTY hold documents: ` +
        `${populated.join(', ')}. The census is stale. Refusing to run — copying would ` +
        `silently leave these behind. Write a transform for each and move it to \`copy\`.`,
    );
  }
}

/** Every document of a collection, oldest first so a log reads in order. */
async function readSource(collection: string): Promise<SourceDoc[]> {
  const handle = mongoose.connection.db?.collection(collection);
  if (!handle) return [];
  return (await handle.find({}).sort({ _id: 1 }).toArray()) as SourceDoc[];
}

/**
 * Point each sequence at its counter, so no already-printed number is re-minted.
 *
 * Read from the `counters` documents and NOT from `max(order_number)`: the
 * counter is incremented before a number is used and a rolled-back transaction
 * keeps its gap, so the counter sits AHEAD of the highest number on any receipt.
 * Seeding from the maximum would re-mint the numbers in those gaps, and
 * `orders.order_number` is UNIQUE — the second collision is a failed checkout.
 *
 * `is_called = true`, so the next `nextval` returns `seq + 1` — the first number
 * the Mongo counter had not yet handed out.
 */
export async function applySequences(db: Database): Promise<void> {
  const docs = ((await mongoose.connection.db?.collection('counters').find({}).toArray()) ??
    []) as SourceDoc[];
  const seqById = new Map(docs.map((doc) => [String(doc._id), Number(doc.seq ?? 0)]));

  for (const [counterId, sequence] of Object.entries(SEQUENCE_FOR_COUNTER)) {
    const seq = seqById.get(counterId);
    if (seq === undefined) {
      // The expected path today: the census found `counters` empty, so nothing
      // has ever been numbered and a sequence left at its start hands out 1
      // first — which is correct. Logged explicitly because "no setval ran" and
      // "setval ran" are indistinguishable afterwards, and an operator checking
      // the cutover needs to know which happened.
      log.general.info(
        { counterId, sequence },
        '[backfill] no counter document; leaving the sequence at its start value',
      );
      continue;
    }
    await db.execute(sql`select setval(${sequence}, ${seq}, true)`);
    log.general.info({ counterId, sequence, seq }, '[backfill] sequence set from its counter');
  }

  const orphans = [...seqById.keys()].filter((id) => !(id in SEQUENCE_FOR_COUNTER));
  if (orphans.length > 0) {
    // `draftOrder` is the known one — `nextDraftOrderNumber` had no call sites,
    // so the port created two sequences rather than three. Reported rather than
    // ignored: a counter nobody consumes is either dead or a missing sequence,
    // and only a person can tell which.
    log.general.warn(
      { orphans },
      '[backfill] counter documents with no Postgres sequence — copied nowhere',
    );
  }
}

/** Compare a transformed value against what Postgres returned for it. */
function sameValue(expected: unknown, stored: unknown): boolean {
  if (expected instanceof Date) {
    // The comparison reads a raw `select *`, so postgres.js hands back whatever
    // it decodes a `timestamptz` to — which is the driver's text form
    // (`2026-08-01 10:00:00+00`), not a `Date`. Comparing the printed strings
    // would then fail on every timestamp in the table while the data was
    // perfectly correct. Compare the INSTANTS.
    const storedAt = stored instanceof Date ? stored : new Date(String(stored));
    return !Number.isNaN(storedAt.getTime()) && storedAt.getTime() === expected.getTime();
  }
  if (Array.isArray(expected) && Array.isArray(stored)) {
    return expected.length === stored.length && expected.every((v, i) => sameValue(v, stored[i]));
  }
  if (expected === null || expected === undefined) return stored === null || stored === undefined;
  // postgres.js returns `bigint`/`numeric` as strings and `double precision` as
  // a number; comparing on Number for a numeric expectation is what makes the
  // round trip checkable without asserting the driver's representation.
  if (typeof expected === 'number') return Number(stored) === expected;
  return String(expected) === String(stored);
}

/** camelCase drizzle property → the snake_case column `select *` returns. */
function columnOf(property: string): string {
  return property.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Compare every source document against its row, field by field. */
export async function verify(db: Database, live: readonly string[]): Promise<void> {
  const mismatches: string[] = [];

  for (const step of COPY_STEPS) {
    if (!live.includes(step.collection)) continue;
    const docs = await readSource(step.collection);
    const expected = step.expected(docs);

    const found = await db.execute<Record<string, unknown>>(
      sql`select * from ${sql.identifier(step.table)}`,
    );
    const byId = new Map(found.map((row) => [String(row.id), row]));

    // Deliberately NOT `found.length === docs.length`. This script is resumable
    // by design — `ON CONFLICT DO NOTHING` means it tolerates rows that were
    // already there — so it has never claimed to own the whole table, and a row
    // it did not write is not evidence of a failed backfill. What it DOES claim
    // is that every source document arrived, which is the loop below. The counts
    // are reported either way, because "3 of 3 matched" is what an operator
    // reads to decide the cutover is done.
    log.general.info(
      { collection: step.collection, table: step.table, sourceDocuments: docs.length, rowsInTable: found.length },
      '[backfill] verifying collection',
    );

    for (const [id, row] of expected) {
      const actual = byId.get(id);
      if (!actual) {
        mismatches.push(`${step.collection}: no row in ${step.table} for _id ${id}`);
        continue;
      }
      for (const [property, value] of Object.entries(row)) {
        const column = columnOf(property);
        if (!sameValue(value, actual[column])) {
          mismatches.push(
            `${step.collection}.${id}.${column}: expected ${JSON.stringify(value)}, ` +
              `stored ${JSON.stringify(actual[column])}`,
          );
        }
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Verification found ${mismatches.length} discrepanc(ies):\n  ` + mismatches.join('\n  '),
    );
  }
  log.general.info('[backfill] verification passed: every source document matches its row');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sourceDatabase = readFlag(argv, 'source-database');
  const targetDatabase = readFlag(argv, 'target-database');
  const auditOnly = argv.includes('--audit-only');
  const verifyOnly = argv.includes('--verify-only');

  if (!sourceDatabase || !targetDatabase) {
    throw new Error(
      'Both --source-database=<name> and --target-database=<name> are required. ' +
        'Which databases a run touches is decided by the environment, so a run that ' +
        'does not state its intent cannot be checked against it — and a backfill ' +
        'aimed at the wrong database does not fail, it succeeds over the wrong data.',
    );
  }
  if (auditOnly && verifyOnly) {
    throw new Error('--audit-only and --verify-only are mutually exclusive.');
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is not set.');

  await mongoose.connect(mongoUri, { dbName: sourceDatabase });
  const actualSource = mongoose.connection.db?.databaseName;
  if (actualSource !== sourceDatabase) {
    throw new Error(
      `--source-database=${sourceDatabase} but MONGODB_URI resolved to ${String(actualSource)}.`,
    );
  }

  const db = await connectPostgres();
  const [row] = await db.execute<{ name: string }>(sql`select current_database() as name`);
  if (row?.name !== targetDatabase) {
    throw new Error(
      `--target-database=${targetDatabase} but DATABASE_URL resolved to ${String(row?.name)}.`,
    );
  }

  const mode = auditOnly ? 'audit' : verifyOnly ? 'verify' : 'copy';
  log.general.info(
    { sourceDatabase, targetDatabase, mode },
    '[backfill] connected to both databases, names verified',
  );

  await runBackfill(db, mode);
}

/**
 * The whole flow, given connections the caller already opened and verified.
 *
 * Separated from `main` so the realdb test can drive the REAL steps against a
 * throwaway Mongo and a throwaway Postgres. Everything argv- and
 * environment-shaped stays in `main`; everything that touches data is here, so
 * the test exercises the code the cutover runs rather than a paraphrase of it.
 */
export async function runBackfill(db: Database, mode: 'audit' | 'verify' | 'copy'): Promise<void> {
  const live = await censusCollections();
  assertMapIsTotal(live);

  if (mode === 'verify') {
    await verify(db, live);
    return;
  }

  await assertExpectedEmpties(live);
  await auditEnums(live);
  log.general.info(
    { collections: live.length },
    '[backfill] audit passed: the map is total, every expected-empty is empty, every enum value is accepted',
  );
  if (mode === 'audit') return;

  let copied = 0;
  for (const step of COPY_STEPS) {
    if (!live.includes(step.collection)) continue;
    const docs = await readSource(step.collection);
    if (docs.length === 0) continue;
    copied += await step.copy(db, docs);
    log.general.info(
      { collection: step.collection, table: step.table, rows: docs.length },
      '[backfill] collection copied',
    );
  }
  await applySequences(db);
  log.general.info({ copied }, '[backfill] copy complete');

  await verify(db, live);
}

/**
 * Run the CLI only when this module IS the process entry point.
 *
 * `db/migrate.ts` runs `main()` unconditionally, which is fine there because
 * nothing imports it. This module is imported by `__tests__/backfill.realdb.test.ts`
 * to drive the real steps, and an unconditional `main()` would fire on that
 * import — with no argv and no MONGODB_URI — failing the suite from a module the
 * test had only meant to read functions out of.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isEntryPoint) {
  main()
    .then(async () => {
      await mongoose.disconnect();
      await closePostgres();
    })
    .catch((error: unknown) => {
      log.general.error({ err: error }, 'Backfill failed');
      void mongoose.disconnect();
      void closePostgres();
      process.exitCode = 1;
    });
}
