/**
 * The data-export router on the real middleware chain against a real server:
 * which role reaches which dataset, and which writes the plan gates.
 *
 * A stub stands in for `authenticateToken` + `loadStore` (the role comes from an
 * `x-role` header), so the REAL validation, controller and service run, with
 * the REAL entitlement resolver and refusal.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { uuidv7 } from '@oxy.so/db';
import { STORE_ROLE_PERMISSIONS, type StoreAccountRole } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { stores } from '../../../db/schema/stores.js';
import { entitleStoreForTest } from '../../../services/entitlements/__tests__/entitle-store.js';
import dataExportsRouter from '../data-exports.js';

let db: Database;
let server: Server;
let baseUrl: string;
const RUN = uuidv7().slice(-12);

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `exports-authz-${RUN}-${label}`,
      name: `Exports authz ${label}`,
      description: '',
      brandColor: '#101010',
    })
    .returning();
  if (!row) throw new Error('store insert returned no row');
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/stores/:storeId/exports', (req, _res, next) => {
    const role = (req.headers['x-role'] as StoreAccountRole) ?? 'viewer';
    req.userId = `user-${role}`;
    req.store = { id: req.params.storeId } as unknown as typeof req.store;
    req.storeAccess = { role, permissions: [...STORE_ROLE_PERMISSIONS[role]] };
    next();
  });
  app.use('/stores/:storeId/exports', dataExportsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closePostgres();
});

async function call(
  storeId: string,
  path: string,
  method: string,
  role: StoreAccountRole,
  body?: unknown,
): Promise<{ status: number; body: { data?: unknown; error?: string } }> {
  const res = await fetch(`${baseUrl}/stores/${storeId}/exports${path}`, {
    method,
    headers: { 'x-role': role, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as { data?: unknown; error?: string } };
}

const DAILY = { dataset: 'orders', cadence: 'daily', hour: 6, timeZone: 'UTC' };

describe('creating a schedule is the plan’s; everything else is free', () => {
  it('refuses a store without the tool with PLAN_CAPABILITY_REQUIRED, and still exports on demand', async () => {
    const storeId = await mintStore('free');
    const create = await call(storeId, '/schedules', 'POST', 'owner', DAILY);
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('PLAN_CAPABILITY_REQUIRED');

    const list = await call(storeId, '/schedules', 'GET', 'owner');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    const onDemand = await call(storeId, '/runs', 'POST', 'owner', { dataset: 'orders' });
    expect(onDemand.status).toBe(202);
    expect(onDemand.body.data).toMatchObject({ trigger: 'on_demand', dataset: 'orders' });
  });

  it('lets an entitled store create, pause and delete, and validates the body', async () => {
    const storeId = await mintStore('paid');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: 60 });

    expect(
      (await call(storeId, '/schedules', 'POST', 'owner', { ...DAILY, cadence: 'hourly' })).status,
    ).toBe(400);
    expect(
      (await call(storeId, '/schedules', 'POST', 'owner', { ...DAILY, extra: 1 })).status,
    ).toBe(400);

    const created = await call(storeId, '/schedules', 'POST', 'owner', DAILY);
    expect(created.status).toBe(201);
    const id = (created.body.data as { id: string }).id;

    const paused = await call(storeId, `/schedules/${id}`, 'PATCH', 'owner', { enabled: false });
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ enabled: false, nextRunAt: null });

    expect((await call(storeId, `/schedules/${id}`, 'DELETE', 'owner')).status).toBe(200);
    expect((await call(storeId, `/schedules/${id}`, 'DELETE', 'owner')).status).toBe(404);
  });
});

describe('each dataset needs the permission reading it already needs', () => {
  it('a viewer (no customers:read) cannot export or schedule customers, and a developer cannot see orders', async () => {
    const storeId = await mintStore('perms');
    await entitleStoreForTest(db, { storeId, capability: 'scheduled_exports', limit: null });

    expect((await call(storeId, '/runs', 'POST', 'viewer', { dataset: 'customers' })).status).toBe(
      404,
    );
    expect(
      (await call(storeId, '/schedules', 'POST', 'viewer', { ...DAILY, dataset: 'customers' }))
        .status,
    ).toBe(404);

    // An editor schedules customers; a viewer's list does not show it.
    const created = await call(storeId, '/schedules', 'POST', 'editor', {
      ...DAILY,
      dataset: 'customers',
    });
    expect(created.status).toBe(201);
    const id = (created.body.data as { id: string }).id;
    expect((await call(storeId, '/schedules', 'GET', 'viewer')).body.data).toEqual([]);
    expect((await call(storeId, `/schedules/${id}`, 'DELETE', 'viewer')).status).toBe(404);

    await call(storeId, '/runs', 'POST', 'owner', { dataset: 'orders' });
    const developerRuns = await call(storeId, '/runs', 'GET', 'developer');
    expect(developerRuns.status).toBe(200);
    expect(developerRuns.body.data).toEqual([]);
  });

  it('a download of a run in another store answers nothing', async () => {
    const storeA = await mintStore('a');
    const storeB = await mintStore('b');
    const run = await call(storeA, '/runs', 'POST', 'owner', { dataset: 'products' });
    const runId = (run.body.data as { id: string }).id;
    expect((await call(storeB, `/runs/${runId}/download`, 'GET', 'owner')).status).toBe(404);
  });
});
