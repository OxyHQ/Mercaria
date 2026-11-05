/**
 * Who may reach `/internal/catalog-metrics/*` — #367 W16/W17, the catalog
 * observability operator surface.
 *
 * The `internal-catalog-attributes.test.ts` shape, applied to another router
 * gated on the SAME `catalog.operate` application role, plus the two
 * properties this surface adds.
 *
 *  - a holder of `catalog.operate` gets past the gate;
 *  - an authenticated Oxy user holding no key gets **404** — a 401 or 403
 *    would advertise that the surface exists;
 *  - holding `payments.operate` does not open it. This is the case a refactor
 *    toward "one operator key" would silently break, and the reason it matters
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
 * the gate or the router before any query, and the stub is what keeps that a
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
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [CATALOG_OPERATOR]: ['catalog.operate'],
  [PAYMENTS_OPERATOR]: ['payments.operate'],
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
  return {
    authenticateToken: (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      next();
    },
    oxyClient: {
      middleware: {
        requireAppPermission: fake.requireAppPermission,
        auth: () => (_req: unknown, res: express.Response) => res.sendStatus(401),
      },
    },
    optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
  };
});
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

/** Every path this surface exposes. Five GETs and nothing else. */
const PATHS: readonly string[] = [
  '/internal/catalog-metrics',
  '/internal/catalog-metrics/integrity',
  '/internal/catalog-metrics/latency',
  '/internal/catalog-metrics/proposal-queue',
  '/internal/catalog-metrics/trace/draft/obs-route-draft-1',
];

/** The methods that must NOT be served anywhere under this prefix. */
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('/internal/catalog-metrics authorization', () => {
  it('a holder of catalog.operate gets past the gate', async () => {
    currentUser = CATALOG_OPERATOR;
    let checked = 0;
    for (const path of PATHS) {
      const response = await fetch(`${url}${path}`);
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

  it('an authenticated user holding no key gets 404 — never 401 or 403', async () => {
    currentUser = MERCHANT_USER;
    let checked = 0;
    for (const path of PATHS) {
      const response = await fetch(`${url}${path}`);
      // A 401 or 403 would confirm the surface exists.
      expect(response.status, `${path} did not hide itself from a non-operator`).toBe(404);
      checked += 1;
    }
    expect(checked).toBe(PATHS.length);
    currentUser = CATALOG_OPERATOR;
  });

  it('holding payments.operate does not open the catalog surface', async () => {
    // The cross-desk case. Separate powers: an operator vetted to repair a
    // payment has not been vetted to read a merchant's authoring funnel.
    currentUser = PAYMENTS_OPERATOR;
    const response = await fetch(`${url}/internal/catalog-metrics`);
    expect(response.status).toBe(404);
    currentUser = CATALOG_OPERATOR;
  });

  it('serves no write method anywhere under the prefix', async () => {
    // Asserted from OUTSIDE the router, over HTTP. `contract-gates.test.ts`
    // asserts the registered set off the router's own stack; this catches a write
    // handler mounted under the same prefix by anything else.
    currentUser = CATALOG_OPERATOR;
    let checked = 0;
    for (const method of WRITE_METHODS) {
      for (const path of PATHS) {
        const response = await fetch(`${url}${path}`, {
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
      `[routes] /internal/catalog-metrics: ${String(PATHS.length)} GET paths, ` +
        `${String(checked)} write attempts all 404\n`,
    );
  });

  it('a trace opens from a closed two-member handle set and nothing else', async () => {
    currentUser = CATALOG_OPERATOR;
    // Neither `merchant` nor `store` nor `email` is a handle kind. Refused at the
    // controller before any read, so an invented kind leaks nothing.
    for (const kind of ['merchant', 'store', 'email', 'oxy_user']) {
      const response = await fetch(`${url}/internal/catalog-metrics/trace/${kind}/whatever`);
      expect(response.status, `trace/${kind} was accepted`).toBe(400);
    }
  });
});
