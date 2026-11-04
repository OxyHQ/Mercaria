/**
 * Who may reach `/internal/commerce-graph/*` — issue #54, the operator-only
 * linkage surface. The `internal-payments.test.ts` shape, applied to the
 * `catalog.operate` application role, and the same three properties:
 *
 *  - a holder of `catalog.operate` gets past the gate;
 *  - an authenticated Oxy user holding no key gets 404 — the surface is never
 *    revealed, and a 401 would advertise that it exists;
 *  - holding `payments.operate` does not open this surface: the two keys are
 *    separate powers, and the cross-desk case is the one a refactor toward
 *    "one operator key" would silently break.
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
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [CATALOG_OPERATOR]: ['catalog.operate'],
  [PAYMENTS_OPERATOR]: ['payments.operate'],
};
const appPermissions = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | import('../../__tests__/oxy-app-permissions-fake.js').FakeAppPermissions,
}));

// The Oxy SDK's own user resolution, stubbed to whatever the test is acting
// as. Everything downstream — the operator gate, the zod bodies — is the
// production chain; who holds which key comes from the app-permission fake.
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
  appPermissions.current = fake;
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
  // `routes/cart.ts` reaches this module through `createApp()` too (#104).
  makeActorRateLimiter:
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
  process.env.STRIPE_ENABLED = 'false';
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

describe('the catalog.operate application role', () => {
  it('lets a holder of catalog.operate through the gate on every path', async () => {
    // Past the GATE is the assertion, not a 200: the database is stubbed to
    // throw, so handlers answer 500 — what matters is that none answers 403
    // or 404, which is exactly what a gate refusing the right caller yields.
    for (const route of PATHS) {
      const res = await call(url, route, CATALOG_OPERATOR);
      expect([403, 404]).not.toContain(res.status);
    }
  });

  it('answers a caller holding no key with 404 on every path', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, MERCHANT_USER);
      expect(res.status).toBe(404);
    }
  });

  it('does not open for a holder of payments.operate — the two keys are separate powers', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, PAYMENTS_OPERATOR);
      expect(res.status).toBe(404);
    }
  });
});
