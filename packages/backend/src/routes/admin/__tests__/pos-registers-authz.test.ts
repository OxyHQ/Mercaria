/**
 * Authorization of the named POS registers router (`expanded_pos_registers`).
 *
 * The real middleware chain, behind a stub standing in for `authenticateToken`
 * + `loadStore` that injects a role's default permissions; the service is
 * mocked, so a 200/201 means the guard let the call through. Who may do what:
 * a cashier or a location manager may LIST (to pick a register); only
 * `locations:write` may create, rename or remove one; the summary is a sales
 * report (`stats:read`). The plan gate is the service's, not the router's.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { STORE_ROLE_PERMISSIONS, type StoreAccountRole } from '@mercaria/shared-types';

vi.mock('../../../services/pos-registers.service.js', () => ({
  listPosRegisters: vi.fn().mockResolvedValue({ registers: [], attributionActive: false }),
  createPosRegister: vi.fn().mockResolvedValue({ id: 'r' }),
  renamePosRegister: vi.fn().mockResolvedValue({ id: 'r' }),
  removePosRegister: vi.fn().mockResolvedValue({ id: 'r', outcome: 'deleted' }),
  getPosRegisterSalesSummary: vi.fn().mockResolvedValue({ from: '', to: '', rows: [] }),
}));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import posRegistersRouter from '../pos-registers.js';

const STORE_ID = '0'.repeat(24);
const REGISTER_ID = '1'.repeat(24);
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
  app.use('/', posRegistersRouter);
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

async function call(path: string, method: string, role: StoreAccountRole, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-role': role, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

const create = { locationId: 'loc-1', name: 'Till 2' };

describe('who may list registers', () => {
  it('an editor (runs the POS and the locations) may', async () => {
    expect(await call('/', 'GET', 'editor')).toBe(200);
  });
  it('a viewer, a developer and billing may not', async () => {
    for (const role of ['viewer', 'developer', 'billing'] as const) {
      expect(await call('/', 'GET', role), role).toBe(403);
    }
  });
});

describe('who may manage registers (locations:write)', () => {
  it('an editor and an admin may create, rename and remove', async () => {
    for (const role of ['editor', 'admin'] as const) {
      expect(await call('/', 'POST', role, create), role).toBe(201);
      expect(await call(`/${REGISTER_ID}`, 'PATCH', role, { name: 'Front' }), role).toBe(200);
      expect(await call(`/${REGISTER_ID}`, 'DELETE', role), role).toBe(200);
    }
  });
  it('a viewer, a developer and billing may not', async () => {
    for (const role of ['viewer', 'developer', 'billing'] as const) {
      expect(await call('/', 'POST', role, create), role).toBe(403);
      expect(await call(`/${REGISTER_ID}`, 'PATCH', role, { name: 'Front' }), role).toBe(403);
      expect(await call(`/${REGISTER_ID}`, 'DELETE', role), role).toBe(403);
    }
  });
  it('refuses an unknown body field and an over-long name', async () => {
    expect(await call('/', 'POST', 'admin', { ...create, extra: true })).toBe(400);
    expect(await call('/', 'POST', 'admin', { ...create, name: 'x'.repeat(61) })).toBe(400);
    expect(await call('/', 'POST', 'admin', { ...create, name: '   ' })).toBe(400);
  });
});

describe('who may read the summary (stats:read)', () => {
  it('a viewer and billing may; a developer may not', async () => {
    expect(await call('/summary', 'GET', 'viewer')).toBe(200);
    expect(await call('/summary', 'GET', 'billing')).toBe(200);
    expect(await call('/summary', 'GET', 'developer')).toBe(403);
  });
});
