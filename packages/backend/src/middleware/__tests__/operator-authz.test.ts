/**
 * The operator gates (`middleware/operator-authz.ts`) are Oxy application
 * roles. These cases drive the REAL gate over a fake of the SDK middleware it
 * is built on (`oxyClient.middleware.requireAppPermission`, with the SDK's own
 * `OxyAppPermissionError` codes), through a real Express app, and pin what
 * each outcome is answered:
 *
 * - a holder of the desk's key passes, and `operatorId` is the HUMAN Oxy named;
 * - a non-holder, and a request with no person, is 404 — the surface is never
 *   revealed, and no env allow-list or "empty = unmounted" state exists;
 * - an Oxy outage is 503 — never a "no" — and is not remembered: the next
 *   request asks again and passes;
 * - a write asks Oxy fresh, a read does not.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeAppPermissions } from '../../__tests__/oxy-app-permissions-fake.js';

const state = vi.hoisted(() => ({
  holdings: (): readonly string[] | 'unavailable' | 'no_session' | 'not_configured' => [],
  fake: undefined as FakeAppPermissions | undefined,
}));

vi.mock('../auth.js', async () => {
  const { fakeAppPermissions } = await import('../../__tests__/oxy-app-permissions-fake.js');
  state.fake = fakeAppPermissions(
    () => state.holdings(),
    () => 'the-person',
  );
  return { oxyClient: { middleware: { requireAppPermission: state.fake.requireAppPermission } } };
});
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { OPERATOR_PERMISSIONS, operatorId, requireCatalogOperator, requirePaymentOperator } =
  await import('../operator-authz.js');

let base = '';
let close: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const app = express();
  for (const [path, gate] of [
    ['/payments', requirePaymentOperator],
    ['/catalog', requireCatalogOperator],
  ] as const) {
    app.all(path, gate, (req, res) => {
      res.json({ operator: operatorId(req) });
    });
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(() => close());

beforeEach(() => {
  state.holdings = () => [];
  state.fake?.calls.splice(0);
});

describe('operator desks are application roles', () => {
  it('declares one dot-spelled key per desk, seven in all', () => {
    expect(Object.values(OPERATOR_PERMISSIONS).sort()).toEqual([
      'analytics.operate',
      'catalog.operate',
      'guest.operate',
      'payments.operate',
      'procurement.operate',
      'referrals.operate',
      'retail.operate',
    ]);
  });

  it('lets a holder through and records the person Oxy resolved as the actor', async () => {
    state.holdings = () => ['payments.operate'];
    const res = await fetch(`${base}/payments`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ operator: 'the-person' });
  });

  it('answers a non-holder 404, and one key never opens another desk', async () => {
    state.holdings = () => ['payments.operate'];
    const res = await fetch(`${base}/catalog`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: 'NOT_FOUND' });
  });

  it('answers a request with no person in a session 404, never 401', async () => {
    state.holdings = () => 'no_session';
    expect((await fetch(`${base}/payments`)).status).toBe(404);
  });

  it('answers an Oxy outage 503 and does not remember it', async () => {
    state.holdings = () => 'unavailable';
    const refused = await fetch(`${base}/payments`);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
    state.holdings = () => ['payments.operate'];
    expect((await fetch(`${base}/payments`)).status).toBe(200);
  });

  it('answers a deployment Oxy does not know 500 — a deploy fault, not a refusal', async () => {
    state.holdings = () => 'not_configured';
    expect((await fetch(`${base}/payments`)).status).toBe(500);
  });

  it('asks Oxy fresh on a write and not on a read', async () => {
    state.holdings = () => ['catalog.operate'];
    await fetch(`${base}/catalog`);
    await fetch(`${base}/catalog`, { method: 'POST' });
    expect(state.fake?.calls).toEqual([
      { permission: 'catalog.operate', fresh: false, method: 'GET' },
      { permission: 'catalog.operate', fresh: true, method: 'POST' },
    ]);
  });

  it('refuses to name an actor outside a gate', () => {
    expect(() => operatorId({} as express.Request)).toThrow(/outside an operator gate/);
  });
});
