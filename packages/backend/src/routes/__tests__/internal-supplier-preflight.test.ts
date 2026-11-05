/**
 * Who may reach `/internal/supplier-preflight/*` (#122 operations 4–5), and
 * what a client may put into it.
 *
 * The `internal-retail-eligibility.test.ts` shape, applied to the SIXTH
 * operator key, `procurement.operate`, with the same three gate properties:
 *
 *  - a holder of `procurement.operate` gets past the gate;
 *  - an authenticated Oxy user holding no key gets 404, not a read — a 401 or
 *    403 would advertise that the surface exists;
 *  - holding `payments.operate`, `catalog.operate` or `retail.operate` does not
 *    open it. This is the surface that reads Mercaria's wholesale cost base and
 *    flips a market kill switch, and the cross-desk case is the one a refactor
 *    toward "one operator key" would silently break.
 *
 * Plus the two this issue adds, both about what a caller can WRITE:
 *
 *  - a sourcing policy body cannot NAME a forbidden signal, and the refusal
 *    says what the signal is rather than "unrecognized key";
 *  - a kill-switch body has no `origin` field, so an operator cannot file a
 *    stop that reads as the system's and lapses on its own.
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
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [PROCUREMENT_OPERATOR]: ['procurement.operate'],
  [PAYMENTS_OPERATOR]: ['payments.operate'],
  [CATALOG_OPERATOR]: ['catalog.operate'],
  [RETAIL_OPERATOR]: ['retail.operate'],
};

vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  getRequiredOxyUserId: () => currentUser,
}));
vi.mock('../../middleware/auth.js', async () => {
  const { fakeAppPermissions } = await import('../../__tests__/oxy-app-permissions-fake.js');
  const fake = fakeAppPermissions(
    () => GRANTS[currentUser] ?? [],
    () => currentUser,
  );
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  };
  return {
    authenticateToken: pass,
    oxyClient: {
      middleware: {
        auth: () => (_req: unknown, res: express.Response) => res.sendStatus(401),
        requireAppPermission: fake.requireAppPermission,
      },
    },
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

let server: Server;
let url: string;

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const started = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });
  const { port } = started.address() as AddressInfo;
  return { server: started, url: `http://127.0.0.1:${String(port)}` };
}

beforeAll(async () => {
  const { createApp } = await import('../../app.js');
  ({ server, url } = await listen(createApp()));
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

async function post(baseUrl: string, path: string, payload: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

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
  it('lets a holder of procurement.operate past the gate', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await fetch(`${url}/internal/supplier-preflight/metrics`);
    // Past the gate is what is under test; the stubbed database is what it hits
    // next, so anything other than 404 means the gate admitted it.
    expect([200, 500]).toContain(response.status);
  });

  it('hides the surface from an authenticated user holding no key', async () => {
    currentUser = ORDINARY_USER;
    const response = await fetch(`${url}/internal/supplier-preflight/metrics`);
    // 404 and never 401 or 403: those would tell the caller the surface is there.
    expect(response.status).toBe(404);
  });

  it('is NOT opened by the payments, catalog or retail keys', async () => {
    // The case a refactor toward "one operator key" would silently break.
    for (const operator of [PAYMENTS_OPERATOR, CATALOG_OPERATOR, RETAIL_OPERATOR]) {
      currentUser = operator;
      const response = await fetch(`${url}/internal/supplier-preflight/metrics`);
      expect(response.status).toBe(404);
    }
  });
});

describe('what a caller may write to the supplier-preflight surface', () => {
  it('refuses a forbidden sourcing signal BY NAME, not as an unknown key', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await post(
      url,
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
      url,
      '/internal/supplier-preflight/policies',
      policyBody({ rankingCriteria: ['delivery_promise'] }),
    );
    expect(response.status).toBe(400);
  });

  it('has no `origin` field on a kill switch, so a person cannot file a system stop', async () => {
    currentUser = PROCUREMENT_OPERATOR;
    const response = await post(url, '/internal/supplier-preflight/suppressions', {
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
    const response = await post(url, '/internal/supplier-preflight/suppressions/some-id/lift', {});
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
      const response = await post(url, path, {});
      expect(response.status).toBe(404);
    }
  });
});
