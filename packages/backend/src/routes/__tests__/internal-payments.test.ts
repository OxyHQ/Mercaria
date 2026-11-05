/**
 * Who may reach `/internal/payments/*`, and who may not — issue #50, acceptance 4.
 *
 * The desk is gated on the `payments.operate` APPLICATION ROLE
 * (`middleware/operator-authz.ts`): Oxy says who holds it, the real gate asks
 * through `oxyClient.middleware.requireAppPermission`, and this file stands in
 * for Oxy with the SDK-boundary fake.
 *
 * ## The properties, each of which would be a security bug
 *
 *  - a holder of `payments.operate` gets through;
 *  - an authenticated Oxy user holding no key gets 404, not a trace — the
 *    surface is never revealed, and a 401 would tell a caller it exists;
 *  - holding EVERY other desk's key opens nothing here;
 *  - a request with no person in a session (a service token) gets the same 404;
 *  - a store owner holding every store permission Mercaria grants is refused,
 *    since none of them says anything about the platform's own money.
 *
 * The last is the one worth stating twice. Mercaria's store permissions are
 * scoped to a STORE by construction — so the failure mode this test exists for
 * is somebody "fixing" the gate by reaching for
 * `requireStorePermission('store:manage')`, which would hand every store owner
 * in the marketplace a read across everybody else's finances.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const OPERATOR = 'oxy-user-operator-1';
const MERCHANT = 'oxy-user-merchant-1';
const OTHER_DESKS_OPERATOR = 'oxy-user-other-desks-operator-1';

/** Whichever caller the current request is acting as. */
let currentUser = OPERATOR;
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [OPERATOR]: ['payments.operate'],
  // Every OTHER desk's key, and not this one: holding them all opens nothing here.
  [OTHER_DESKS_OPERATOR]: [
    'catalog.operate',
    'guest.operate',
    'analytics.operate',
    'retail.operate',
    'procurement.operate',
    'referrals.operate',
  ],
};
/** Set to model Oxy giving no answer about the person instead of their keys. */
let oxyAnswer: 'held' | 'no_session' | 'not_configured' = 'held';

// The Oxy SDK's own user resolution, stubbed to whatever the test is acting as.
// Everything downstream — the operator gate, the zod bodies — is the
// production chain; who holds which key comes from the app-permission fake.
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  getRequiredOxyUserId: () => currentUser,
}));
vi.mock('../../middleware/auth.js', async () => {
  const { fakeAppPermissions } = await import('../../__tests__/oxy-app-permissions-fake.js');
  const fake = fakeAppPermissions(
    () => (oxyAnswer === 'held' ? (GRANTS[currentUser] ?? []) : oxyAnswer),
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

describe('the payments.operate application role', () => {
  it('lets a holder of payments.operate through the gate on every path', async () => {
    // Past the gate is the assertion, not a 200: `PEABLE_ENABLED` is off and
    // the database is stubbed, so the handlers themselves answer 409 or 500.
    // What matters here is that NONE of them answers 403 or 404 — which is
    // exactly what a gate that refused the right caller would produce.
    for (const route of PATHS) {
      const res = await call(url, route, OPERATOR);
      expect([403, 404], `${route.method} ${route.path}`).not.toContain(res.status);
    }
  });

  it('hides the surface from an authenticated Oxy account holding no key', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, MERCHANT);
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('NOT_FOUND');
    }
  });

  it('refuses a caller holding every STORE permission Mercaria grants', async () => {
    // The failure mode this test exists for: somebody gating this surface on
    // `requireStorePermission('store:manage')`, which every store OWNER holds
    // for their own store — and which says nothing whatsoever about the
    // platform's money. A store credential must not reach here however
    // privileged it is inside its own store.
    const { STORE_PERMISSIONS } = await import('@mercaria/shared-types');
    expect(STORE_PERMISSIONS.length).toBeGreaterThan(0);

    currentUser = MERCHANT;
    const res = await fetch(`${url}/internal/payments/exceptions`, {
      headers: {
        // The headers a merchant dashboard would carry. None of them is read by
        // the gate, which is the property — it consults Oxy about the
        // authenticated caller and nothing a client can send.
        'x-store-role': 'owner',
        'x-store-permissions': STORE_PERMISSIONS.join(','),
      },
    });

    expect(res.status).toBe(404);
  });

  it('does not open for a holder of every OTHER desk key', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, OTHER_DESKS_OPERATOR);
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  it('answers a request with no person in a session — a service token — with 404', async () => {
    oxyAnswer = 'no_session';
    try {
      for (const route of PATHS) {
        const res = await call(url, route, OPERATOR);
        expect(res.status, `${route.method} ${route.path}`).toBe(404);
      }
    } finally {
      oxyAnswer = 'held';
    }
  });

  it('answers 500, not a refusal, when Oxy does not know Mercaria’s application', async () => {
    oxyAnswer = 'not_configured';
    try {
      const res = await call(url, PATHS[0] ?? { method: 'GET', path: '/' }, OPERATOR);
      expect(res.status).toBe(500);
    } finally {
      oxyAnswer = 'held';
    }
  });

  it('refuses a repair with no reason, before any authorization is spent on it', async () => {
    // Issue #50's repair invariant 9: every action requires a named reason. The
    // schema is `.strict()` and the minimum length is real — an operator typing
    // `x` to satisfy a validator produces an audit trail recording that they
    // typed `x`.
    currentUser = OPERATOR;
    const res = await fetch(`${url}/internal/payments/repairs`, {
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
    const res = await fetch(`${url}/internal/payments/repairs`, {
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
    const byEmail = await fetch(`${url}/internal/payments/trace?email=buyer%40example.com`);
    expect(byEmail.status).toBe(400);

    // …and exactly one handle, never two.
    const byTwo = await fetch(`${url}/internal/payments/trace?paymentId=p1&orderId=o1`);
    expect(byTwo.status).toBe(400);

    // …and never none.
    const byNone = await fetch(`${url}/internal/payments/trace`);
    expect(byNone.status).toBe(400);
  });
});
