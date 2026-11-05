/**
 * The replenishment router's authorization and wire behaviour, on the REAL
 * middleware chain with the service mocked.
 *
 * A stub stands in for `authenticateToken` + `loadStore` and injects a role's
 * real permissions. Reading needs `products:read` AND `stats:read` (a plan row
 * is stock beside sales); writing adds `inventory:write`. A capability refusal
 * thrown by the service reaches the wire as the plan error vocabulary.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { STORE_ROLE_PERMISSIONS, type StoreAccountRole } from '@mercaria/shared-types';

// No `vi.hoisted`: this file also runs under `bun test` (scripts/test-bun.ts),
// whose `mock.module` is neither hoisted nor offers it. The fns live in the
// factory and are read back through the mocked module below.
vi.mock('../../../services/replenishment/plan.service.js', () => ({
  computeReplenishmentPlan: vi.fn(),
  readReplenishmentSettings: vi.fn(),
  updateReplenishmentSettings: vi.fn(),
  setReplenishmentOverride: vi.fn(),
  removeReplenishmentOverride: vi.fn(),
  toReplenishmentCsv: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import replenishmentRouter from '../replenishment.js';
import * as planService from '../../../services/replenishment/plan.service.js';
import { PlanCapabilityRefusal } from '../../../services/entitlements/enforce.js';

type MockFn = ReturnType<typeof vi.fn>;
const SERVICE_FUNCTIONS = [
  'computeReplenishmentPlan',
  'readReplenishmentSettings',
  'updateReplenishmentSettings',
  'setReplenishmentOverride',
  'removeReplenishmentOverride',
  'toReplenishmentCsv',
] as const;
const service = planService as unknown as Record<(typeof SERVICE_FUNCTIONS)[number], MockFn>;

const STORE_ID = '0'.repeat(24);
const VARIANT_ID = '1'.repeat(24);
const PLAN = {
  storeId: STORE_ID,
  generatedAt: '2024-03-01T00:00:00.000Z',
  locationId: null,
  rows: [],
};
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    const role = (req.headers['x-role'] as StoreAccountRole) ?? 'viewer';
    req.store = { id: STORE_ID } as unknown as typeof req.store;
    req.storeAccess = { role, permissions: [...STORE_ROLE_PERMISSIONS[role]] };
    next();
  });
  app.use('/', replenishmentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const name of SERVICE_FUNCTIONS) service[name].mockReset();
  service.computeReplenishmentPlan.mockResolvedValue(PLAN);
  service.readReplenishmentSettings.mockResolvedValue({ settings: {}, overrides: [] });
  service.updateReplenishmentSettings.mockResolvedValue({ settings: {}, overrides: [] });
  service.setReplenishmentOverride.mockResolvedValue({ settings: {}, overrides: [] });
  service.removeReplenishmentOverride.mockResolvedValue({ settings: {}, overrides: [] });
  service.toReplenishmentCsv.mockReturnValue('"product"\n');
});

async function call(path: string, method: string, role: StoreAccountRole, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-role': role, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const SETTINGS = { leadTimeDays: 14, targetCoverDays: 28, safetyStockDays: 7 };

describe('reading the plan and the settings', () => {
  it.each(['owner', 'admin', 'editor', 'viewer'] as const)('%s may read', async (role) => {
    expect((await call('/plan', 'GET', role)).status).toBe(200);
    expect((await call('/settings', 'GET', role)).status).toBe(200);
  });

  it.each(['developer', 'billing'] as const)(
    '%s may not: it lacks stock or sales',
    async (role) => {
      expect((await call('/plan', 'GET', role)).status).toBe(403);
      expect((await call('/settings', 'GET', role)).status).toBe(403);
      expect(service.computeReplenishmentPlan).not.toHaveBeenCalled();
    },
  );

  it('passes the location and status filters through, and refuses an unknown status', async () => {
    expect(
      (await call('/plan?locationId=loc-1&status=reorder_now&limit=20', 'GET', 'viewer')).status,
    ).toBe(200);
    expect(service.computeReplenishmentPlan).toHaveBeenCalledWith({
      storeId: STORE_ID,
      locationId: 'loc-1',
      status: 'reorder_now',
      limit: 20,
    });
    expect((await call('/plan?status=everything', 'GET', 'viewer')).status).toBe(400);
  });

  it('answers the CSV with every row', async () => {
    const res = await call('/plan?format=csv', 'GET', 'viewer');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('replenishment-2024-03-01.csv');
    expect(await res.text()).toBe('"product"\n');
    expect(service.computeReplenishmentPlan).toHaveBeenCalledWith({
      storeId: STORE_ID,
      limit: Number.POSITIVE_INFINITY,
    });
  });

  it('answers a capability refusal as 403 PLAN_CAPABILITY_REQUIRED', async () => {
    service.computeReplenishmentPlan.mockRejectedValue(
      new PlanCapabilityRefusal('replenishment_planning', 'not_entitled'),
    );
    const res = await call('/plan', 'GET', 'owner');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('PLAN_CAPABILITY_REQUIRED');
  });
});

describe('changing the settings', () => {
  it.each(['owner', 'admin', 'editor'] as const)('%s may write', async (role) => {
    expect((await call('/settings', 'PUT', role, SETTINGS)).status).toBe(200);
    expect((await call(`/overrides/${VARIANT_ID}`, 'PUT', role, { leadTimeDays: 3 })).status).toBe(
      200,
    );
    expect((await call(`/overrides/${VARIANT_ID}`, 'DELETE', role)).status).toBe(200);
  });

  it.each(['viewer', 'developer', 'billing'] as const)('%s may not', async (role) => {
    expect((await call('/settings', 'PUT', role, SETTINGS)).status).toBe(403);
    expect((await call(`/overrides/${VARIANT_ID}`, 'PUT', role, { leadTimeDays: 3 })).status).toBe(
      403,
    );
    expect((await call(`/overrides/${VARIANT_ID}`, 'DELETE', role)).status).toBe(403);
    expect(service.updateReplenishmentSettings).not.toHaveBeenCalled();
  });

  it('refuses an unknown field, a fraction and an out-of-range value', async () => {
    expect((await call('/settings', 'PUT', 'owner', { ...SETTINGS, supplier: 'x' })).status).toBe(
      400,
    );
    expect(
      (await call('/settings', 'PUT', 'owner', { ...SETTINGS, leadTimeDays: 1.5 })).status,
    ).toBe(400);
    expect(
      (await call('/settings', 'PUT', 'owner', { ...SETTINGS, safetyStockDays: 181 })).status,
    ).toBe(400);
    expect((await call('/settings', 'PUT', 'owner', { leadTimeDays: 1 })).status).toBe(400);
    expect(service.updateReplenishmentSettings).not.toHaveBeenCalled();
  });

  it('validates the variant id', async () => {
    expect((await call('/overrides/not-an-id', 'PUT', 'owner', { leadTimeDays: 3 })).status).toBe(
      400,
    );
  });
});
