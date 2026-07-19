/**
 * Integration test for the channels router's authorization.
 *
 * Spins up a real Express app with the channels sub-router mounted behind a stub
 * that injects a store membership of a chosen role (standing in for
 * `authenticateToken` + `loadStore`). The `connector-sync.service` is mocked, so
 * the test exercises the REAL middleware chain (`requireStorePermission('channels:write')`)
 * without a DB. Asserts staff are blocked (403) on every route while admins pass
 * the guard and reach the (mocked) service.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StoreRole } from '@mercaria/shared-types';

vi.mock('../../../services/connector-sync.service.js', () => ({
  listConnections: vi.fn().mockResolvedValue([]),
  buildConnectAuthorizeUrl: vi.fn().mockReturnValue('https://acme.myshopify.com/admin/oauth/authorize?x=1'),
  updateSyncSettings: vi.fn(),
  runBackfill: vi.fn(),
  disconnect: vi.fn(),
  toConnectionDTO: vi.fn(),
  toSyncRunDTO: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import channelsRouter from '../channels.js';

const STORE_ID = '0'.repeat(24);
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stub the upstream auth + loadStore: role comes from an `x-role` test header.
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    const role = (req.headers['x-role'] as StoreRole) ?? 'staff';
    req.store = { _id: STORE_ID } as unknown as typeof req.store;
    req.storeMembership = { oxyUserId: 'user-1', role, permissions: [], joinedAt: new Date() };
    next();
  });
  app.use('/', channelsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function call(path: string, method: string, role: StoreRole, body?: unknown): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-role': role, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

const CONNECTION_ID = '1'.repeat(24);

describe('channels router authz — staff lack channels:write', () => {
  it('403s staff on list', async () => {
    expect(await call('/', 'GET', 'staff')).toBe(403);
  });
  it('403s staff on connect', async () => {
    expect(await call('/shopify/connect', 'POST', 'staff', { shopDomain: 'acme.myshopify.com' })).toBe(403);
  });
  it('403s staff on settings patch', async () => {
    expect(await call(`/${CONNECTION_ID}/settings`, 'PATCH', 'staff', { autoPublish: true })).toBe(403);
  });
  it('403s staff on sync', async () => {
    expect(await call(`/${CONNECTION_ID}/sync`, 'POST', 'staff')).toBe(403);
  });
  it('403s staff on disconnect', async () => {
    expect(await call(`/${CONNECTION_ID}`, 'DELETE', 'staff')).toBe(403);
  });
});

describe('channels router authz — admins pass the guard', () => {
  it('lets an admin list connections (reaches the mocked service → 200)', async () => {
    expect(await call('/', 'GET', 'admin')).toBe(200);
  });
  it('lets an admin start a connect (200 with an authorize URL)', async () => {
    expect(await call('/shopify/connect', 'POST', 'admin', { shopDomain: 'acme.myshopify.com' })).toBe(200);
  });
  it('validates the connect body (400 on a non-myshopify domain even for admin)', async () => {
    expect(await call('/shopify/connect', 'POST', 'admin', { shopDomain: 'evil.example.com' })).toBe(400);
  });
});
