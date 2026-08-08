/**
 * Who may reach `/internal/payments/*`, and who may not — issue #50, acceptance 4.
 *
 * ## The four properties, each of which would be a security bug
 *
 *  - an allow-listed Oxy operator gets through;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a trace;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404 on
 *    every path, because a 401 would tell an unauthenticated caller that an
 *    operator surface exists here;
 *  - a store owner holding every store permission Mercaria grants is refused,
 *    since none of them says anything about the platform's own money.
 *
 * The last is the one worth stating twice. Mercaria's only authorization
 * vocabulary is store permissions, and it is scoped to a STORE by construction —
 * so the failure mode this test exists for is somebody "fixing" the gate by
 * reaching for `requireStorePermission('store:manage')`, which would hand every
 * store owner in the marketplace a read across everybody else's finances.
 *
 * ## Two apps, because the mount is the gate
 *
 * The empty-allow-list case cannot be tested on the same app as the others: the
 * router is not mounted at all in that configuration, so what answers is
 * Express's own 404. Building the real `createApp()` twice, against two frozen
 * configs, is the only way to assert a MOUNT rather than a handler — and
 * `app.ts` exists to be built without listening precisely so an invariant like
 * this can be checked against the real middleware chain.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const OPERATOR = 'oxy-user-operator-1';
const MERCHANT = 'oxy-user-merchant-1';

/** Whichever caller the current request is acting as. */
let currentUser = OPERATOR;

// The Oxy SDK's own user resolution, stubbed to whatever the test is acting as.
// Everything downstream — the allow-list comparison, the mount check, the zod
// bodies — is the production chain.
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
// The surface reads Postgres on its way to a 200. These tests never get that
// far on the paths that matter — a 403 or a 404 is decided by middleware — so
// the database is stubbed rather than started, which is also what keeps this a
// ROUTE test rather than a second copy of the realdb suites.
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
 * Build a real app against a FROZEN config for one allow-list.
 *
 * `config/index.ts` reads process.env once at module load and freezes the
 * result, so the two configurations cannot coexist in one module registry —
 * `vi.resetModules()` between them is what gives each app its own frozen view.
 */
async function buildApp(operatorIds: string): Promise<express.Express> {
  vi.resetModules();
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = operatorIds;
  process.env.STRIPE_ENABLED = 'false';
  const { createApp } = await import('../../app.js');
  return createApp();
}

beforeAll(async () => {
  ({ server: enabledServer, url: enabledUrl } = await listen(await buildApp(OPERATOR)));
  ({ server: disabledServer, url: disabledUrl } = await listen(await buildApp('')));
}, 60_000);

afterAll(async () => {
  // vitest reuses a worker PROCESS across files while giving each its own module
  // registry, so this variable would otherwise survive into a sibling's frozen
  // `config` and mount an operator surface in a file that never asked for one.
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
const PATHS: readonly { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/internal/payments/trace?paymentId=p1' },
  { method: 'GET', path: '/internal/payments/exceptions' },
  { method: 'GET', path: '/internal/payments/metrics' },
  { method: 'POST', path: '/internal/payments/events/evt_1/replay' },
  { method: 'POST', path: '/internal/payments/refetch', body: { paymentId: 'p1' } },
  {
    method: 'POST',
    path: '/internal/payments/repairs',
    body: {
      action: 'retry_provider_refund',
      reason: 'A reason long enough to satisfy the schema.',
      refundId: 'r1',
    },
  },
  {
    method: 'POST',
    path: '/internal/payments/discrepancies/d1/resolve',
    body: { reason: 'Investigated and closed.' },
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
    ...(route.body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(route.body),
        }),
  });
}

describe('the operator allow-list', () => {
  it('lets an allow-listed Oxy account through the gate on every path', async () => {
    // Past the gate is the assertion, not a 200: `STRIPE_ENABLED` is off and
    // the database is stubbed, so the handlers themselves answer 409 or 500.
    // What matters here is that NONE of them answers 403 or 404 — which is
    // exactly what a gate that refused the right caller would produce.
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, OPERATOR);
      expect([403, 404], `${route.method} ${route.path}`).not.toContain(res.status);
    }
  });

  it('refuses an authenticated Oxy account that is not on the list', async () => {
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, MERCHANT);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('FORBIDDEN');
    }
  });

  it('refuses a caller holding every STORE permission Mercaria grants', async () => {
    // The failure mode this test exists for: somebody gating this surface on
    // `requireStorePermission('store:manage')`, which every store OWNER holds
    // for their own store — and which says nothing whatsoever about the
    // platform's money. A store credential must not reach here however
    // privileged it is inside its own store.
    const { STORE_PERMISSIONS } = await import('../../db/schema/stores.js');
    expect(STORE_PERMISSIONS.length).toBeGreaterThan(0);

    const res = await fetch(`${enabledUrl}/internal/payments/exceptions`, {
      headers: {
        // The headers a merchant dashboard would carry. None of them is read by
        // the gate, which is the property — it consults the allow-list and the
        // authenticated caller and nothing a client can send.
        'x-store-role': 'owner',
        'x-store-permissions': STORE_PERMISSIONS.join(','),
      },
    });

    currentUser = MERCHANT;
    expect(res.status).toBe(403);
  });

  it('does not mount the surface at all when the allow-list is empty', async () => {
    // 404 and not 401: a deployment with no operators has no operator surface,
    // and answering 401 would confirm to an unauthenticated caller that one
    // exists here. The router is not registered, so this is Express's own 404.
    for (const route of PATHS) {
      const res = await call(disabledUrl, route, OPERATOR);
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  it('refuses a repair with no reason, before any authorization is spent on it', async () => {
    // Issue #50's repair invariant 9: every action requires a named reason. The
    // schema is `.strict()` and the minimum length is real — an operator typing
    // `x` to satisfy a validator produces an audit trail recording that they
    // typed `x`.
    currentUser = OPERATOR;
    const res = await fetch(`${enabledUrl}/internal/payments/repairs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'retry_provider_refund',
        reason: 'x',
        refundId: 'r1',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a repair body carrying a field the surface does not declare', async () => {
    // `.strict()`, and it matters more here than on a merchant route: an
    // operator body reaches code that moves money, so a field the schema does
    // not know must be REFUSED rather than stripped — silently ignoring
    // `amountMinor` on a retry would let somebody believe they had set one.
    currentUser = OPERATOR;
    const res = await fetch(`${enabledUrl}/internal/payments/repairs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'retry_provider_refund',
        reason: 'A reason long enough to satisfy the schema.',
        refundId: 'r1',
        amountMinor: '999999',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a trace asking by anything other than the five permitted handles', async () => {
    // #45's buyer boundaries, held at the HTTP edge: there is no way to trace by
    // an email, a phone number or a card fingerprint, and `.strict()` is what
    // makes an attempt to a 400 rather than a silently-ignored parameter that
    // returns somebody else's payment.
    currentUser = OPERATOR;
    const byEmail = await fetch(
      `${enabledUrl}/internal/payments/trace?email=buyer%40example.com`,
    );
    expect(byEmail.status).toBe(400);

    // …and exactly one handle, never two.
    const byTwo = await fetch(
      `${enabledUrl}/internal/payments/trace?paymentId=p1&orderId=o1`,
    );
    expect(byTwo.status).toBe(400);

    // …and never none.
    const byNone = await fetch(`${enabledUrl}/internal/payments/trace`);
    expect(byNone.status).toBe(400);
  });
});
