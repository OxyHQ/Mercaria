/**
 * Who may reach `/internal/commerce-graph/*` — issue #54, the operator-only
 * linkage surface. The `internal-payments.test.ts` shape, applied to the
 * catalog operator allow-list, and the same four properties:
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a write;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that the surface exists;
 *  - the PAYMENTS allow-list does not open this surface: the two lists are
 *    separate powers, and the cross-list case is the one a refactor toward
 *    "one operator list" would silently break.
 *
 * Two real apps against two frozen configs, because the empty-list case is a
 * property of the MOUNT, not of any handler.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const CATALOG_OPERATOR = 'oxy-user-catalog-operator-1';
const PAYMENTS_OPERATOR = 'oxy-user-payments-operator-1';
const MERCHANT_USER = 'oxy-user-merchant-1';

/** Whichever caller the current request is acting as. */
let currentUser = CATALOG_OPERATOR;

// The Oxy SDK's own user resolution, stubbed to whatever the test is acting
// as. Everything downstream — the allow-list comparison, the mount check, the
// zod bodies — is the production chain.
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => currentUser,
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
  oxyClient: {},
  authenticateTokenOrApiKey: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
  optionalAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
  oxyServiceAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
  requireScope: () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
}));
vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
// A 403/404 is decided by middleware before any query; the stub is what keeps
// this a ROUTE test rather than a second copy of the realdb suite.
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

/** Start one app and return its base URL. */
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
async function buildApp(catalogOperatorIds: string): Promise<express.Express> {
  vi.resetModules();
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = catalogOperatorIds;
  // The payments operator surface stays configured in BOTH apps, so the
  // cross-list case below proves separation rather than absence.
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = PAYMENTS_OPERATOR;
  process.env.STRIPE_ENABLED = 'false';
  const { createApp } = await import('../../app.js');
  return createApp();
}

beforeAll(async () => {
  ({ server: enabledServer, url: enabledUrl } = await listen(await buildApp(CATALOG_OPERATOR)));
  ({ server: disabledServer, url: disabledUrl } = await listen(await buildApp('')));
}, 60_000);

afterAll(async () => {
  // vitest reuses a worker PROCESS across files while giving each its own
  // module registry; these would otherwise leak into a sibling's frozen config.
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
  delete process.env.PAYMENT_OPERATOR_OXY_USER_IDS;
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

/** Every path the surface exposes, with a method and a minimal valid body. */
const PATHS: readonly { method: 'POST'; path: string; body: unknown }[] = [
  {
    method: 'POST',
    path: '/internal/commerce-graph/native-store-links',
    body: {
      merchantId: 'm1',
      storeId: 's1',
      method: 'operator',
      reason: 'A reason long enough to satisfy the schema.',
    },
  },
  {
    method: 'POST',
    path: '/internal/commerce-graph/native-store-links/link1/revoke',
    body: { reason: 'A reason long enough to satisfy the schema.' },
  },
];

/** Issue one request against one app as one caller. */
async function call(
  baseUrl: string,
  route: (typeof PATHS)[number],
  actingAs: string,
): Promise<Response> {
  currentUser = actingAs;
  return await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(route.body),
  });
}

describe('the catalog operator allow-list', () => {
  it('lets an allow-listed catalog operator through the gate on every path', async () => {
    // Past the GATE is the assertion, not a 200: the database is stubbed to
    // throw, so handlers answer 500 — what matters is that none answers 403
    // or 404, which is exactly what a gate refusing the right caller yields.
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, CATALOG_OPERATOR);
      expect([403, 404]).not.toContain(res.status);
    }
  });

  it('refuses an authenticated non-operator with 403 on every path', async () => {
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, MERCHANT_USER);
      expect(res.status).toBe(403);
    }
  });

  it('does not open for a PAYMENTS operator — the two lists are separate powers', async () => {
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, PAYMENTS_OPERATOR);
      expect(res.status).toBe(403);
    }
  });

  it('answers 404 on every path when the allow-list is empty — the surface is not mounted', async () => {
    for (const route of PATHS) {
      const res = await call(disabledUrl, route, CATALOG_OPERATOR);
      expect(res.status).toBe(404);
    }
  });
});
