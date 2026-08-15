/**
 * Who may reach `/internal/supplier-preflight/*` (#122 operations 4–5), and
 * what a client may put into it.
 *
 * The `internal-retail-eligibility.test.ts` shape, applied to the SIXTH
 * operator allow-list, with the same four gate properties:
 *
 *  - an allow-listed operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a read;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that the surface exists;
 *  - the PAYMENTS, CATALOG and RETAIL allow-lists do not open it. This is the
 *    surface that reads Mercaria's wholesale cost base and flips a market kill
 *    switch, and the cross-list case is the one a refactor toward "one operator
 *    list" would silently break.
 *
 * Plus the two this issue adds, both about what a caller can WRITE:
 *
 *  - a sourcing policy body cannot NAME a forbidden signal, and the refusal
 *    says what the signal is rather than "unrecognized key";
 *  - a kill-switch body has no `origin` field, so an operator cannot file a
 *    stop that reads as the system's and lapses on its own.
 *
 * Two real apps against two frozen configs, because the empty-list case is a
 * property of the MOUNT, not of any handler.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const PROCUREMENT_OPERATOR = 'oxy-user-procurement-operator-1';
const PAYMENTS_OPERATOR = 'oxy-user-payments-operator-1';
const CATALOG_OPERATOR = 'oxy-user-catalog-operator-1';
const RETAIL_OPERATOR = 'oxy-user-retail-operator-1';
const ORDINARY_USER = 'oxy-user-merchant-1';

/** Whichever caller the current request is acting as. */
let currentUser = PROCUREMENT_OPERATOR;

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => currentUser,
}));
vi.mock('../../middleware/auth.js', () => {
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  };
  return {
    authenticateToken: pass,
    oxyClient: {},
    optionalAuth: pass,
  };
});
vi.mock('../../lib/rate-limit.js', () => {
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  };
  return { makeRateLimiter: () => pass, makeActorRateLimiter: () => pass };
});
vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    guest: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
// A 403/404/400 is decided before any query; the stub is what keeps this a
// ROUTE test rather than a second copy of the realdb suite.
vi.mock('../../db/postgres.js', () => ({
  getDb: () => {
    throw new Error('An authorization test must not reach the database.');
  },
  checkPostgresHealth: () => Promise.resolve(true),
  assertMigrationsCurrent: () => Promise.resolve(),
  closePostgres: () => Promise.resolve(),
}));

let enabledServer: Server;
let disabledServer: Server;
let enabledUrl: string;
let disabledUrl: string;

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => {
      resolve(started);
    });
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

/**
 * Build a real app against a FROZEN config for one allow-list state.
 * `config/index.ts` reads process.env once at module load; `vi.resetModules()`
 * gives each app its own frozen view.
 */
async function buildApp(procurementOperatorIds: string): Promise<express.Express> {
  vi.resetModules();
  process.env.PROCUREMENT_OPERATOR_OXY_USER_IDS = procurementOperatorIds;
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = PAYMENTS_OPERATOR;
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = CATALOG_OPERATOR;
  process.env.RETAIL_OPERATOR_OXY_USER_IDS = RETAIL_OPERATOR;
  process.env.STRIPE_ENABLED = 'false';
  const { createApp } = await import('../../app.js');
  return createApp();
}

async function post(url: string, path: string, payload: unknown): Promise<Response> {
  return await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  ({ server: enabledServer, url: enabledUrl } = await listen(await buildApp(PROCUREMENT_OPERATOR)));
  ({ server: disabledServer, url: disabledUrl } = await listen(await buildApp('')));
}, 60_000);

afterAll(async () => {
  delete process.env.PROCUREMENT_OPERATOR_OXY_USER_IDS;
  delete process.env.PAYMENT_OPERATOR_OXY_USER_IDS;
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
  delete process.env.RETAIL_OPERATOR_OXY_USER_IDS;
  delete process.env.STRIPE_ENABLED;
  await Promise.all(
    [enabledServer, disabledServer].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    ),
  );
});

/** A minimally valid sourcing policy body. */
function policyBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'Launch sourcing',
    summary: 'Cheapest complete landed cost, then the fastest promise.',
    effectiveStart: new Date().toISOString(),
    rankingCriteria: ['total_landed_cost', 'delivery_promise'],
    requiredCapabilities: ['live_stock_lookup'],
    maxSourcingAttempts: 3,
    maxSupplierShareBps: 10_000,
    quoteTtlSeconds: 900,
    providerTimeoutMs: 8_000,
    maxProviderConcurrency: 4,
    maxProviderCallsPerMinute: 120,
    healthWindowMinutes: 15,
    healthMinimumSamples: 20,
    healthMaxFailureBps: 5_000,
    healthSuppressionMinutes: 15,
    ...extra,
  };
}

describe('the /internal/supplier-preflight operator gate', () => {
  it('lets an allow-listed operator past the gate', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/supplier-preflight/metrics`);
    // Past the gate is what is under test; the stubbed database is what it hits
    // next, so anything other than 403/404 means the gate admitted it.
    expect([200, 500]).toContain(response.status);
  });

  it('refuses an authenticated user who is not allow-listed', async () => {
    currentUser = ORDINARY_USER;
    const response = await fetch(`${enabledUrl}/internal/supplier-preflight/metrics`);
    expect(response.status).toBe(403);
  });

  it('does not MOUNT the surface when the allow-list is empty', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await fetch(`${disabledUrl}/internal/supplier-preflight/metrics`);
    // 404 and never 401: a 401 tells an unauthenticated caller the surface is
    // there, which is the thing an empty list is meant to withhold.
    expect(response.status).toBe(404);
  });

  it('is NOT opened by the payments, catalog or retail allow-lists', async () => {
    // The case a refactor toward "one operator list" would silently break.
    for (const operator of [PAYMENTS_OPERATOR, CATALOG_OPERATOR, RETAIL_OPERATOR]) {
      currentUser = operator;
      const response = await fetch(`${enabledUrl}/internal/supplier-preflight/metrics`);
      expect(response.status).toBe(403);
    }
  });
});

describe('what a caller may write to the supplier-preflight surface', () => {
  it('refuses a forbidden sourcing signal BY NAME, not as an unknown key', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await post(
      enabledUrl,
      '/internal/supplier-preflight/policies',
      policyBody({ affiliateCommissionWeight: 10 }),
    );
    expect(response.status).toBe(400);
    // `sendError` puts the machine code on `error` and the human text on
    // `message` — reading `error.message` would be `undefined` and the regex
    // below would then be asserted against an empty string, which passes for
    // nothing and fails for everything.
    const body = (await response.json()) as { error?: string; message?: string };
    expect(body.error).toBe('VALIDATION_ERROR');
    // The refusal names the prohibition. The assertion is on the MESSAGE
    // because a remount of this middleware after the `.strict()` schema would
    // still 400 — with "unrecognized key", which reads as a typo rather than as
    // an attempt at something #122 selection 3 forbids.
    expect(body.message ?? '').toMatch(/affiliate commission/i);
    expect(body.message ?? '').toMatch(/never reads a commission/i);
  });

  it('refuses a ranking policy that does not rank on landed cost', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await post(
      enabledUrl,
      '/internal/supplier-preflight/policies',
      policyBody({ rankingCriteria: ['delivery_promise'] }),
    );
    expect(response.status).toBe(400);
  });

  it('has no `origin` field on a kill switch, so a person cannot file a system stop', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await post(enabledUrl, '/internal/supplier-preflight/suppressions', {
      scope: 'market',
      marketCountry: 'ES',
      kind: 'kill_switch',
      reason: 'Incident 42',
      origin: 'automatic_health',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a lift with no stated reason', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await post(
      enabledUrl,
      '/internal/supplier-preflight/suppressions/some-id/lift',
      {},
    );
    expect(response.status).toBe(400);
  });

  it('has no route that could edit a quote', async () => {
    // The surface is READ plus two write kinds and no third: a quote records
    // what a supplier said, and an operator who could edit one could authorize
    // a sale the supplier never agreed to.
    currentUser = PROCUREMENT_OPERATOR;
    for (const path of [
      '/internal/supplier-preflight/quotes/some-id/complete',
      '/internal/supplier-preflight/quotes/some-id/override',
      '/internal/supplier-preflight/reservations/some-id/extend',
    ]) {
      const response = await post(enabledUrl, path, {});
      expect(response.status).toBe(404);
    }
  });
});
