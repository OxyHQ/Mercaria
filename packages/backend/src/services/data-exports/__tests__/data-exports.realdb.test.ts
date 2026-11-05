/**
 * Store data exports against a real server: the schedule rows and their shape
 * CHECKs, the materializer (one run per occurrence, one unit of the allowance
 * per run, refusals recorded and never retried), the run lease, the whole
 * read → store → complete path, file retention, and the free on-demand export.
 *
 * Every claim is scoped to the stores this file mints (`onlyStoreIds`), because
 * the test database is shared with parallel files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { STORE_ROLE_PERMISSIONS } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { stores } from '../../../db/schema/stores.js';
import { dataExportRuns, dataExportSchedules } from '../../../db/schema/dataExports.js';
import { oxyFileReferenceOutboxes } from '../../../db/schema/oxyFiles.js';
import { entitlementUsageCounters } from '../../../db/schema/merchantPlans.js';
import { findEntitlementUsage } from '../../../db/merchantPlans/usageRepository.js';
import {
  insertDataExportSchedule,
  listDataExportSchedules,
} from '../../../db/dataExports/scheduleRepository.js';
import {
  claimDataExportRuns,
  completeDataExportRun,
  insertScheduledDataExportRun,
  releaseExpiredDataExportFiles,
} from '../../../db/dataExports/runRepository.js';
import { createCustomer } from '../../customer.service.js';
import { createStoreProduct } from '../../catalog-write.service.js';
import { insertCategory } from '../../../db/taxonomy/taxonomyRepository.js';
import { insertLocation } from '../../../db/stores/locationRepository.js';
import { PlanCapabilityRefusal } from '../../entitlements/enforce.js';
import { entitleStoreForTest } from '../../entitlements/__tests__/entitle-store.js';
import { invalidateMerchantEntitlements } from '../../entitlements/resolve.js';
import {
  createDataExportSchedule,
  dataExportDownload,
  deleteDataExportScheduleForCaller,
  listDataExportRunsForCaller,
  materializeDueDataExportSchedules,
  processDataExportRuns,
  requestOnDemandDataExport,
  updateDataExportScheduleForCaller,
} from '../data-export.service.js';
import type { DataExportStorage } from '../storage.js';

let db: Database;
const RUN = uuidv7().slice(-12);
const OWNER = STORE_ROLE_PERMISSIONS.owner;
const VIEWER = STORE_ROLE_PERMISSIONS.viewer;
const ACTOR = { oxyUserId: 'oxy-user-exports', permissions: OWNER };

/** A storage double: remembers what it stored, serves a URL for it. */
function fakeStorage(): DataExportStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async store(body) {
      const fileId = `exp_${uuidv7().replace(/-/g, '').slice(0, 24)}`;
      files.set(fileId, body);
      return { fileId };
    },
    async downloadUrl(fileId) {
      return files.has(fileId) ? `https://files.example/${fileId}?sig=test` : null;
    },
  };
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

// No store teardown: the plan grants and usage counters reference the store
// `restrict` (the enforce suite's posture). Every row is scoped to these ids.
afterAll(async () => {
  await closePostgres();
});

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `exports-${RUN}-${label}`,
      name: `Exports ${label}`,
      description: '',
      brandColor: '#101010',
    })
    .returning();
  if (!row) throw new Error('store insert returned no row');
  return row.id;
}

async function refusalOf(promise: Promise<unknown>): Promise<PlanCapabilityRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlanCapabilityRefusal) return error;
    throw error;
  }
  throw new Error('expected a plan refusal, and the call succeeded');
}

/** Make a schedule due now, the way the clock would. */
async function makeDue(scheduleId: string, at: Date): Promise<void> {
  await db
    .update(dataExportSchedules)
    .set({ nextRunAt: at })
    .where(eq(dataExportSchedules.id, scheduleId));
}

describe('schedules: the rows and their shape', () => {
  it('a cadence carries exactly its own field, and a paused schedule has no due instant', async () => {
    const storeId = await mintStore('shape');
    const base = {
      storeId,
      dataset: 'orders' as const,
      hour: 6,
      timeZone: 'UTC',
      actorOxyUserId: 'u',
    };
    await expect(
      insertDataExportSchedule(db, {
        ...base,
        cadence: 'weekly',
        weekday: null,
        dayOfMonth: null,
        enabled: false,
        nextRunAt: null,
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/data_export_schedules_weekday_shape_check/u) },
    });
    await expect(
      insertDataExportSchedule(db, {
        ...base,
        cadence: 'daily',
        weekday: null,
        dayOfMonth: null,
        enabled: true,
        nextRunAt: null,
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/data_export_schedules_enabled_shape_check/u) },
    });
    const row = await insertDataExportSchedule(db, {
      ...base,
      cadence: 'monthly',
      weekday: null,
      dayOfMonth: 28,
      enabled: false,
      nextRunAt: null,
    });
    expect((await listDataExportSchedules(storeId)).map((s) => s.id)).toEqual([row.id]);
  });
});

describe('creating and editing a schedule asks the plan; pausing and deleting never do', () => {
  it('refuses a store without the tool, and lets an entitled one create', async () => {
    const storeId = await mintStore('gate');
    const refusal = await refusalOf(
      createDataExportSchedule(storeId, ACTOR, {
        dataset: 'orders',
        cadence: 'daily',
        hour: 6,
        timeZone: 'Europe/Madrid',
      }),
    );
    expect(refusal.code).toBe('PLAN_CAPABILITY_REQUIRED');

    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: 5 });
    const created = await createDataExportSchedule(storeId, ACTOR, {
      dataset: 'orders',
      cadence: 'weekly',
      weekday: 1,
      dayOfMonth: 9, // dropped: a weekly schedule carries no day of the month
      hour: 6,
      timeZone: 'Europe/Madrid',
    });
    expect(created).toMatchObject({ cadence: 'weekly', weekday: 1, dayOfMonth: null });
    expect(created.nextRunAt).not.toBeNull();

    // Revoke by plan end: the grant is gone, so the tool is not held.
    await db.execute(
      sql`update entitlement_grants set revoked_at = now(), revoked_by_oxy_user_id = 'test', revocation_reason = 'test' where store_id = ${storeId}`,
    );
    invalidateMerchantEntitlements(storeId);
    // Pausing still works…
    const paused = await updateDataExportScheduleForCaller(storeId, created.id, ACTOR, {
      enabled: false,
    });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
    // …re-enabling does not…
    expect(
      (
        await refusalOf(
          updateDataExportScheduleForCaller(storeId, created.id, ACTOR, { enabled: true }),
        )
      ).code,
    ).toBe('PLAN_CAPABILITY_REQUIRED');
    // …and deleting does.
    await deleteDataExportScheduleForCaller(storeId, created.id, OWNER);
    expect(await listDataExportSchedules(storeId)).toEqual([]);
  });

  it('a caller who cannot read the dataset cannot schedule it', async () => {
    const storeId = await mintStore('perm');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: null });
    await expect(
      createDataExportSchedule(
        storeId,
        { oxyUserId: 'viewer', permissions: VIEWER },
        { dataset: 'customers', cadence: 'daily', hour: 1, timeZone: 'UTC' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createDataExportSchedule(storeId, ACTOR, {
        dataset: 'orders',
        cadence: 'daily',
        hour: 1,
        timeZone: 'Mars/Olympus_Mons',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('materializing: one run per occurrence, one unit per run', () => {
  it('takes the allowance per run, and records a refused run then moves on', async () => {
    const storeId = await mintStore('consume');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: 1 });
    const schedule = await createDataExportSchedule(storeId, ACTOR, {
      dataset: 'customers',
      cadence: 'daily',
      hour: 3,
      timeZone: 'UTC',
    });
    const now = new Date();
    const due = new Date(now.getTime() - 60_000);
    await makeDue(schedule.id, due);

    const first = await materializeDueDataExportSchedules({ now, onlyStoreIds: [storeId] });
    expect(first).toEqual([
      { scheduleId: schedule.id, runId: expect.any(String), outcome: 'pending' },
    ]);

    const [advanced] = await db
      .select()
      .from(dataExportSchedules)
      .where(eq(dataExportSchedules.id, schedule.id));
    expect(advanced?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime());

    // The second occurrence: the allowance (1) is spent.
    const secondDue = new Date(now.getTime() - 30_000);
    await makeDue(schedule.id, secondDue);
    const second = await materializeDueDataExportSchedules({ now, onlyStoreIds: [storeId] });
    expect(second.map((r) => r.outcome)).toEqual(['skipped_limit']);

    // A second pass finds nothing due: a refusal is never retried.
    expect(await materializeDueDataExportSchedules({ now, onlyStoreIds: [storeId] })).toEqual([]);

    const runs = await db
      .select()
      .from(dataExportRuns)
      .where(eq(dataExportRuns.storeId, storeId))
      .orderBy(dataExportRuns.occurrenceAt);
    expect(runs.map((r) => r.status)).toEqual(['pending', 'skipped_limit']);
    expect(runs[1]?.completedAt).not.toBeNull();

    const counter = await db
      .select({ used: entitlementUsageCounters.used })
      .from(entitlementUsageCounters)
      .where(
        and(
          eq(entitlementUsageCounters.storeId, storeId),
          eq(entitlementUsageCounters.capabilityKey, 'scheduled_exports'),
        ),
      );
    expect(counter.map((c) => c.used)).toEqual([1]);
  });

  it('an unentitled store’s occurrence is recorded as skipped_not_entitled and consumes nothing', async () => {
    const storeId = await mintStore('unentitled');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: 3 });
    const schedule = await createDataExportSchedule(storeId, ACTOR, {
      dataset: 'orders',
      cadence: 'daily',
      hour: 3,
      timeZone: 'UTC',
    });
    await db.execute(
      sql`update entitlement_grants set revoked_at = now(), revoked_by_oxy_user_id = 'test', revocation_reason = 'test' where store_id = ${storeId}`,
    );
    invalidateMerchantEntitlements(storeId);
    const now = new Date();
    await makeDue(schedule.id, new Date(now.getTime() - 1_000));
    const result = await materializeDueDataExportSchedules({ now, onlyStoreIds: [storeId] });
    expect(result.map((r) => r.outcome)).toEqual(['skipped_not_entitled']);
    const [schedRow] = await db
      .select()
      .from(dataExportSchedules)
      .where(eq(dataExportSchedules.id, schedule.id));
    // The schedule is kept, still enabled, and moved on.
    expect(schedRow?.enabled).toBe(true);
    expect(schedRow?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  it('an unlimited allowance runs every occurrence', async () => {
    const storeId = await mintStore('unlimited');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: null });
    const schedule = await createDataExportSchedule(storeId, ACTOR, {
      dataset: 'orders',
      cadence: 'daily',
      hour: 3,
      timeZone: 'UTC',
    });
    const now = new Date();
    for (const ago of [3_000, 2_000, 1_000]) {
      await makeDue(schedule.id, new Date(now.getTime() - ago));
      await materializeDueDataExportSchedules({ now, onlyStoreIds: [storeId] });
    }
    const runs = await db.select().from(dataExportRuns).where(eq(dataExportRuns.storeId, storeId));
    expect(runs.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('an occurrence materializes once, whatever retries it', async () => {
    const storeId = await mintStore('idempotent');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: 5 });
    const schedule = await createDataExportSchedule(storeId, ACTOR, {
      dataset: 'orders',
      cadence: 'daily',
      hour: 3,
      timeZone: 'UTC',
    });
    const occurrenceAt = new Date(Date.now() - 5_000);
    const input = {
      storeId,
      scheduleId: schedule.id,
      dataset: 'orders' as const,
      occurrenceAt,
      now: new Date(),
    };
    const first = await insertScheduledDataExportRun(db, input);
    const second = await insertScheduledDataExportRun(db, input);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();

    // The materializer meeting an existing occurrence consumes nothing and advances.
    await makeDue(schedule.id, occurrenceAt);
    const result = await materializeDueDataExportSchedules({ onlyStoreIds: [storeId] });
    expect(result.map((r) => r.outcome)).toEqual(['existing']);
    const counter = await findEntitlementUsage(db, {
      storeId,
      capabilityKey: 'scheduled_exports',
      periodKey:
        (
          await db.execute<{ period_key: string }>(
            sql`select period_key from entitlement_usage_counters where store_id = ${storeId}`,
          )
        )[0]?.period_key ?? 'none',
    });
    expect(counter).toBeUndefined();
  });
});

describe('the run lease and the whole path', () => {
  it('one claim per run, an owner check on every write, and a file a merchant can download', async () => {
    const storeId = await mintStore('path');
    await createCustomer(storeId, { displayName: '=cmd|calc', email: 'a@example.com' });
    await createCustomer(storeId, { displayName: 'Bea "B" Ortiz', tags: ['vip'] });
    const storage = fakeStorage();

    const run = await requestOnDemandDataExport(storeId, ACTOR, 'customers', {
      drainInline: false,
    });
    // Asking again while it is open answers the same run.
    const again = await requestOnDemandDataExport(storeId, ACTOR, 'customers', {
      drainInline: false,
    });
    expect(again.id).toBe(run.id);

    const claimA = await claimDataExportRuns({
      leaseOwner: 'worker-a',
      batchSize: 5,
      leaseMs: 60_000,
      onlyStoreIds: [storeId],
    });
    const claimB = await claimDataExportRuns({
      leaseOwner: 'worker-b',
      batchSize: 5,
      leaseMs: 60_000,
      onlyStoreIds: [storeId],
    });
    expect(claimA.map((r) => r.id)).toEqual([run.id]);
    expect(claimB).toEqual([]);
    // A worker that does not hold the lease cannot complete it.
    expect(
      await completeDataExportRun({
        runId: run.id,
        leaseOwner: 'worker-b',
        rowCount: 0,
        byteSize: 0,
        truncated: false,
        fileId: 'nope_nope_nope',
        fileExpiresAt: new Date(Date.now() + 1_000),
      }),
    ).toBe(false);

    // The lease expires; the worker reclaims and produces the file.
    const later = new Date(Date.now() + 120_000);
    const tally = await processDataExportRuns({
      storage,
      onlyStoreIds: [storeId],
      leaseOwner: 'worker-c',
      now: later,
    });
    expect(tally.succeeded).toBe(1);

    const [view] = await listDataExportRunsForCaller(storeId, OWNER);
    expect(view).toMatchObject({
      id: run.id,
      status: 'succeeded',
      rowCount: 2,
      downloadable: true,
    });
    const [file] = [...storage.files.values()];
    expect(file?.split('\r\n')[0]).toContain('"customer_id","display_name"');
    // The formula is neutralised and quotes are doubled.
    expect(file).toContain(`"'=cmd|calc"`);
    expect(file).toContain('"Bea ""B"" Ortiz"');

    const download = await dataExportDownload(storeId, run.id, OWNER, storage);
    expect(download.url).toMatch(/^https:\/\/files\.example\//u);
    expect(download.filename).toMatch(/^mercaria-customers-\d{4}-\d{2}-\d{2}\.csv$/u);

    // The file is an Oxy reference: the trigger enqueued it.
    const outbox = await db
      .select()
      .from(oxyFileReferenceOutboxes)
      .where(
        and(
          eq(oxyFileReferenceOutboxes.entityType, 'data_export_file'),
          eq(oxyFileReferenceOutboxes.entityId, run.id),
        ),
      );
    expect(outbox).toHaveLength(1);

    // A viewer (no customers:read) sees neither the run nor the file.
    expect(await listDataExportRunsForCaller(storeId, VIEWER)).toEqual([]);
    await expect(dataExportDownload(storeId, run.id, VIEWER, storage)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // Past retention the file is released; the history stays.
    const released = await releaseExpiredDataExportFiles({
      now: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000),
      limit: 10,
      onlyStoreIds: [storeId],
    });
    expect(released).toBe(1);
    const [afterRelease] = await listDataExportRunsForCaller(storeId, OWNER);
    expect(afterRelease).toMatchObject({ status: 'succeeded', rowCount: 2, downloadable: false });
    await expect(dataExportDownload(storeId, run.id, OWNER, storage)).rejects.toMatchObject({
      code: 'GONE',
    });
  });

  it('the on-demand export never reads the plan', async () => {
    const storeId = await mintStore('free');
    const run = await requestOnDemandDataExport(storeId, ACTOR, 'orders', { drainInline: false });
    expect(run).toMatchObject({ trigger: 'on_demand', status: 'pending' });
    const tally = await processDataExportRuns({
      storage: fakeStorage(),
      onlyRunIds: [run.id],
    });
    expect(tally.succeeded).toBe(1);
    const [view] = await listDataExportRunsForCaller(storeId, OWNER);
    expect(view).toMatchObject({ status: 'succeeded', rowCount: 0, downloadable: true });
  });

  it('a products export is one row per variant, amounts in the currency’s precision', async () => {
    const storeId = await mintStore('products');
    const location = await insertLocation(storeId, {
      name: 'Default location',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const category = await insertCategory({
      key: `exports-goods-${RUN}`,
      name: 'Export goods',
      slug: `exports-goods-${RUN}`,
    });
    await createStoreProduct(
      storeId,
      {
        title: '+Tee',
        description: '',
        category: category.slug,
        handle: `exports-tee-${RUN}`,
        imageFileIds: [],
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [
          {
            optionValues: [{ name: 'Size', value: 'S' }],
            price: { amount: 1500, currency: 'GBP' },
            sku: 'TEE-S',
            inventory: { tracked: true, available: 3 },
          },
          {
            optionValues: [{ name: 'Size', value: 'M' }],
            price: { amount: 1650, currency: 'GBP' },
            sku: 'TEE-M',
            inventory: { tracked: true, available: 0 },
          },
        ],
      },
      { locationId: location.id },
    );
    const storage = fakeStorage();
    const run = await requestOnDemandDataExport(storeId, ACTOR, 'products', { drainInline: false });
    expect((await processDataExportRuns({ storage, onlyRunIds: [run.id] })).succeeded).toBe(1);
    const [file] = [...storage.files.values()];
    const lines = (file ?? '').trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^"product_id","title","handle"/u);
    expect(file).toContain(`"'+Tee"`);
    expect(file).toContain('"TEE-S",,15.00,,"GBP",3,');
    expect(file).toContain('"TEE-M",,16.50,,"GBP",0,');
  });

  it('a storage outage retries with backoff, then fails visibly', async () => {
    const storeId = await mintStore('outage');
    const broken: DataExportStorage = {
      async store() {
        throw new Error('storage down');
      },
      async downloadUrl() {
        return null;
      },
    };
    const run = await requestOnDemandDataExport(storeId, ACTOR, 'products', { drainInline: false });
    let at = Date.now();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      at += 60 * 60_000; // past every backoff
      await processDataExportRuns({ storage: broken, onlyRunIds: [run.id], now: new Date(at) });
    }
    const [row] = await db.select().from(dataExportRuns).where(eq(dataExportRuns.id, run.id));
    expect(row).toMatchObject({ status: 'failed', failure: 'storage_unavailable', fileId: null });
    expect(row?.attempts).toBeGreaterThanOrEqual(4);
  });
});
