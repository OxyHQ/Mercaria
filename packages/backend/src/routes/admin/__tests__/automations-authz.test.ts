/**
 * The automation-rule routes are MOUNTED, behind the permissions they claim,
 * with the shipped body validation (#89, `automation_rules`).
 *
 * `automation-rules.realdb.test.ts` proves what the service does; none of its
 * cases would notice a route that was never registered or sat behind the wrong
 * permission. Two modules are mocked, and which two is the point:
 * `store-authz`, so the permission each route ASKS for is observable, and the
 * controller, so no database is needed. `validate.js` is REAL.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { StorePermission } from '@mercaria/shared-types';

vi.mock('../../../middleware/store-authz.js', () => ({
  requireStorePermission:
    (permission: StorePermission) => (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('x-required-permission', permission);
      next();
    },
}));

vi.mock('../../../controllers/admin/automation-rules-admin.controller.js', () => {
  const echo =
    (name: string) =>
    (req: Request, res: Response): void => {
      res.status(200).json({ success: true, data: { handler: name, body: req.body } });
    };
  return {
    listAutomationRules: echo('list'),
    listAutomationRuleRuns: echo('runs'),
    getAutomationRule: echo('get'),
    createAutomationRule: echo('create'),
    patchAutomationRule: echo('patch'),
    deleteAutomationRule: echo('delete'),
  };
});

import automationsRouter from '../automations.js';

const RULE_ID = 'a'.repeat(24);
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', automationsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function call(method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const VALID = {
  name: 'Pause sold-out listings',
  trigger: 'listing_stock_at_or_below',
  action: 'pause_listing',
  stockThreshold: 0,
};

describe('/admin/stores/:storeId/automations', () => {
  it('reads behind products:read, and /runs is not mistaken for an id', async () => {
    for (const path of ['/', '/runs', `/${RULE_ID}`]) {
      const res = await call('GET', path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-required-permission'), path).toBe('products:read');
    }
    const runs = await call('GET', '/runs?limit=5');
    expect(((await runs.json()) as { data: { handler: string } }).data.handler).toBe('runs');
  });

  it('writes behind products:write', async () => {
    const created = await call('POST', '/', VALID);
    expect(created.status).toBe(200);
    expect(created.headers.get('x-required-permission')).toBe('products:write');
    const patched = await call('PATCH', `/${RULE_ID}`, { enabled: false });
    expect(patched.headers.get('x-required-permission')).toBe('products:write');
    const deleted = await call('DELETE', `/${RULE_ID}`);
    expect(deleted.headers.get('x-required-permission')).toBe('products:write');
  });

  it('refuses an unknown trigger or action, an extra field, and an edit of the trigger', async () => {
    expect((await call('POST', '/', { ...VALID, trigger: 'price_changed' })).status).toBe(400);
    expect((await call('POST', '/', { ...VALID, action: 'set_status' })).status).toBe(400);
    expect((await call('POST', '/', { ...VALID, storeId: 'someone-else' })).status).toBe(400);
    expect((await call('PATCH', `/${RULE_ID}`, { trigger: 'order_paid' })).status).toBe(400);
    expect((await call('PATCH', `/${RULE_ID}`, {})).status).toBe(400);
    expect((await call('POST', '/', { ...VALID, name: '' })).status).toBe(400);
  });

  it('refuses a malformed rule id', async () => {
    expect((await call('DELETE', '/not-an-id')).status).toBe(400);
  });
});
