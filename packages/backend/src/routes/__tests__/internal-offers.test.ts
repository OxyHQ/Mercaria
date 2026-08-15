/**
 * Who may reach `/internal/offers/*` — issue #57, the operator-only offer
 * surface. The `internal-canonical-catalog.test.ts` shape, applied to the third
 * router reading the SAME catalog allow-list, plus one property this issue adds:
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a write;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that the surface exists;
 *  - the PAYMENTS allow-list does not open it: separate powers, and the
 *    cross-list case is the one a refactor toward "one operator list" would
 *    silently break;
 *  - **the retire endpoint refuses an unattributed removal.** `.strict()` plus a
 *    mandatory bounded `note` means an operator cannot withdraw a seller's offer
 *    from every comparison without saying why, and the `payment_repairs`
 *    discipline is a property of the request boundary rather than a habit in a
 *    handler. That check runs as the ALLOW-LISTED operator, so a 400 can only be
 *    the schema — a 403 would prove nothing.
 *
 * The PUBLIC read is asserted here too, and specifically that it is NOT gated:
 * an offer is public commercial information, and a surface that 404'd on a
 * deployment with no operators would take the product page down with it.
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
    moderation: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

/** Every path the surface exposes, with a method and a minimal valid body. */
const PATHS: readonly { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/internal/offers/convergence' },
  { method: 'GET', path: '/internal/offers/offer-1' },
  { method: 'POST', path: '/internal/offers/listings/listing-1/converge', body: {} },
  {
    method: 'POST',
    path: '/internal/offers/offer-1/retire',
    body: { reason: 'operator', note: 'A note long enough to satisfy the schema.' },
  },
];

async function call(
  baseUrl: string,
  route: { method: 'GET' | 'POST'; path: string; body?: unknown },
  actingAs: string,
): Promise<Response> {
  currentUser = actingAs;
  return await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    ...(route.method === 'POST' ? { body: JSON.stringify(route.body ?? {}) } : {}),
  });
}

describe('the catalog operator allow-list on the offer surface', () => {
  it('lets an allow-listed catalog operator through the gate on every path', async () => {
    // Past the GATE is the assertion, not a 200: the database is stubbed to
    // throw, so handlers answer 500 — what matters is that none answers 403,
    // 404 or 400, which is what a gate or a schema refusing a valid request
    // would yield.
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, CATALOG_OPERATOR);
      expect([400, 403, 404], `${route.path} was refused before reaching a handler`).not.toContain(
        res.status,
      );
    }
  });

  it('refuses an authenticated non-operator with 403 on every path', async () => {
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, MERCHANT_USER);
      expect(res.status, route.path).toBe(403);
    }
  });

  it('does not open for a PAYMENTS operator — the two lists are separate powers', async () => {
    for (const route of PATHS) {
      const res = await call(enabledUrl, route, PAYMENTS_OPERATOR);
      expect(res.status, route.path).toBe(403);
    }
  });

  it('answers 404 on every path when the allow-list is empty — the surface is not mounted', async () => {
    for (const route of PATHS) {
      const res = await call(disabledUrl, route, CATALOG_OPERATOR);
      expect(res.status, route.path).toBe(404);
    }
  });
});

describe('the PUBLIC offer read is deliberately not gated', () => {
  it('answers the same on both deployments — an offer is public information', async () => {
    // Both apps, including the one with no operators at all. A surface that
    // 404'd here would take the product page down with the operator tooling.
    for (const baseUrl of [enabledUrl, disabledUrl]) {
      const res = await fetch(`${baseUrl}/offers?canonicalVariantId=v1`);
      // The database is stubbed to throw, so this is a 500 — but it is a 500
      // from a HANDLER, which is what proves the route exists and is reachable.
      expect(res.status, baseUrl).not.toBe(404);
      expect(res.status, baseUrl).not.toBe(403);
    }
  });

  it('refuses a request naming both scopes, and one naming neither', async () => {
    // The schema's `refine`, before any query — an ambiguous comparison must
    // never reach a database that would happily answer one of the two.
    for (const query of ['', '?canonicalVariantId=v1&canonicalProductId=p1']) {
      const res = await fetch(`${enabledUrl}/offers${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it('refuses a value outside a closed set rather than ignoring it', async () => {
    const res = await fetch(`${enabledUrl}/offers?canonicalVariantId=v1&kinds=not_a_kind`);
    expect(res.status).toBe(400);
    // …and the same request with a REAL kind is not refused by the schema, so
    // the assertion above is a narrowing rather than a blanket rejection.
    const valid = await fetch(`${enabledUrl}/offers?canonicalVariantId=v1&kinds=native,external`);
    expect(valid.status).not.toBe(400);
  });
});

describe('an operator cannot withdraw an offer unattributably', () => {
  /** As the ALLOW-LISTED operator, so a 400 can only be the schema. */
  const retirePath = '/internal/offers/offer-1/retire';

  it('refuses a retirement with no note, a short note, or an unknown reason', async () => {
    for (const body of [
      { reason: 'operator' },
      { reason: 'operator', note: 'too short' },
      { reason: 'because-i-said-so', note: 'A note long enough to satisfy the schema.' },
      { note: 'A note long enough to satisfy the schema.' },
    ]) {
      const res = await call(
        enabledUrl,
        { method: 'POST', path: retirePath, body },
        CATALOG_OPERATOR,
      );
      expect(res.status, `${JSON.stringify(body)} was accepted`).toBe(400);
    }
  });

  it('accepts the well-formed one, so the refusals are a narrowing', async () => {
    // Without this, every assertion above would also pass against a schema that
    // rejected the endpoint's whole body.
    const res = await call(
      enabledUrl,
      {
        method: 'POST',
        path: retirePath,
        body: { reason: 'operator', note: 'A note long enough to satisfy the schema.' },
      },
      CATALOG_OPERATOR,
    );
    expect(res.status).not.toBe(400);
  });

  it('refuses an unknown field — there is no way to smuggle a price in', async () => {
    const res = await call(
      enabledUrl,
      {
        method: 'POST',
        path: retirePath,
        body: {
          reason: 'operator',
          note: 'A note long enough to satisfy the schema.',
          priceAmount: 1,
        },
      },
      CATALOG_OPERATOR,
    );
    expect(res.status).toBe(400);
  });
});
