/**
 * Who may reach `/internal/catalog-metrics/*` — #367 W16/W17, the catalog
 * observability operator surface.
 *
 * The `internal-catalog-attributes.test.ts` shape, applied to another router
 * reading the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, plus the two
 * properties this surface adds.
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403;
 *  - an EMPTY allow-list means no such surface at all — **404 from the MOUNT**,
 *    because a 401 would advertise that it exists;
 *  - the PAYMENTS allow-list does not open it. This is the case a refactor
 *    toward "one operator list" would silently break, and the reason it matters
 *    here is specific: a payment operator tracing money has no business reading
 *    which of a merchant's drafts were abandoned.
 *  - **the surface is READ-ONLY, and that is asserted by METHOD rather than by
 *    reading the router.** `contract-gates.test.ts` asserts the registered route
 *    set exactly off the router's own stack; this asserts the same closure from
 *    the OUTSIDE, over HTTP, on the mounted app — so a write handler added
 *    anywhere under this prefix fails here even if it were registered by a
 *    different router.
 *
 * The database is stubbed to throw. Every assertion in this file is decided by
 * the gate or the mount before any query, and the stub is what keeps that a
 * property of the routing rather than something a passing realdb fixture could
 * mask.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const CATALOG_OPERATOR = 'oxy-user-catalog-operator-1';
const PAYMENTS_OPERATOR = 'oxy-user-payments-operator-1';
const MERCHANT_USER = 'oxy-user-merchant-1';

let currentUser = CATALOG_OPERATOR;

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
  optionalAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
  makeActorRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
}));
vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    guest: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    health: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    moderation: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  sanitizeForLog: (value: string) => value,
}));
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

async function buildApp(catalogOperatorIds: string): Promise<express.Express> {
  vi.resetModules();
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = catalogOperatorIds;
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

/** Every path this surface exposes. Four GETs and nothing else. */
const PATHS: readonly string[] = [
  '/internal/catalog-metrics',
  '/internal/catalog-metrics/integrity',
  '/internal/catalog-metrics/latency',
  '/internal/catalog-metrics/trace/draft/obs-route-draft-1',
];

/** The methods that must NOT be served anywhere under this prefix. */
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('/internal/catalog-metrics authorization', () => {
  it('an allow-listed catalog operator gets past the gate', async () => {
    currentUser = CATALOG_OPERATOR;
    let checked = 0;
    for (const path of PATHS) {
      const response = await fetch(`${enabledUrl}${path}`);
      // Past the gate. The handler then hits the throwing database stub and
      // answers 500 — or 404 for the trace, whose controller validates its
      // handle first. What must NOT appear is 403 or 401.
      expect([200, 404, 500], `${path} answered ${String(response.status)}`).toContain(
        response.status,
      );
      checked += 1;
    }
    // A loop that ran zero times would report zero failures.
    expect(checked).toBe(PATHS.length);
  });

  it('an authenticated user who is not allow-listed gets 403', async () => {
    currentUser = MERCHANT_USER;
    let checked = 0;
    for (const path of PATHS) {
      const response = await fetch(`${enabledUrl}${path}`);
      expect(response.status, `${path} did not refuse a non-operator`).toBe(403);
      checked += 1;
    }
    expect(checked).toBe(PATHS.length);
    currentUser = CATALOG_OPERATOR;
  });

  it('the PAYMENTS allow-list does not open the catalog surface', async () => {
    // The cross-list case. Separate powers: an operator vetted to repair a
    // payment has not been vetted to read a merchant's authoring funnel.
    currentUser = PAYMENTS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/catalog-metrics`);
    expect(response.status).toBe(403);
    currentUser = CATALOG_OPERATOR;
  });

  it('an EMPTY allow-list means the surface is not mounted at all — 404, never 401', async () => {
    currentUser = CATALOG_OPERATOR;
    let checked = 0;
    for (const path of PATHS) {
      const response = await fetch(`${disabledUrl}${path}`);
      // 404 from the MOUNT. A 401 or 403 would confirm the surface exists, which
      // is exactly what an unmounted operator surface must not do.
      expect(response.status, `${path} advertised itself on a deployment with no operators`).toBe(
        404,
      );
      checked += 1;
    }
    expect(checked).toBe(PATHS.length);
  });

  it('serves no write method anywhere under the prefix', async () => {
    // Asserted from OUTSIDE the router, over HTTP. `contract-gates.test.ts`
    // asserts the registered set off the router's own stack; this catches a write
    // handler mounted under the same prefix by anything else.
    currentUser = CATALOG_OPERATOR;
    let checked = 0;
    for (const method of WRITE_METHODS) {
      for (const path of PATHS) {
        const response = await fetch(`${enabledUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'DELETE' ? undefined : '{}',
        });
        expect(
          response.status,
          `${method} ${path} is served — this surface is read-only by design`,
        ).toBe(404);
        checked += 1;
      }
    }
    expect(checked).toBe(WRITE_METHODS.length * PATHS.length);
    process.stdout.write(
      `[routes] /internal/catalog-metrics: ${String(PATHS.length)} GET paths, `
        + `${String(checked)} write attempts all 404\n`,
    );
  });

  it('a trace opens from a closed two-member handle set and nothing else', async () => {
    currentUser = CATALOG_OPERATOR;
    // Neither `merchant` nor `store` nor `email` is a handle kind. Refused at the
    // controller before any read, so an invented kind leaks nothing.
    for (const kind of ['merchant', 'store', 'email', 'oxy_user']) {
      const response = await fetch(
        `${enabledUrl}/internal/catalog-metrics/trace/${kind}/whatever`,
      );
      expect(response.status, `trace/${kind} was accepted`).toBe(400);
    }
  });
});
