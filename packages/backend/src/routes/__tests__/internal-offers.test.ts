/**
 * Who may reach `/internal/offers/*` — issue #57, the operator-only offer
 * surface. The `internal-canonical-catalog.test.ts` shape, applied to the third
 * router gated on the SAME `catalog.operate` application role, plus one
 * property this issue adds:
 *
 *  - a holder of `catalog.operate` gets past the gate;
 *  - an authenticated Oxy user holding no key gets 404 — the surface is never
 *    revealed, and a 401 would advertise that it exists;
 *  - holding `payments.operate` does not open it: separate powers, and the
 *    cross-desk case is the one a refactor toward "one operator key" would
 *    silently break;
 *  - an Oxy that cannot answer is 503, and that outage is never remembered as
 *    a "no"; a write asks Oxy fresh while a read may reuse an answer;
 *  - **the retire endpoint refuses an unattributed removal.** `.strict()` plus a
 *    mandatory bounded `note` means an operator cannot withdraw a seller's offer
 *    from every comparison without saying why, and the `payment_repairs`
 *    discipline is a property of the request boundary rather than a habit in a
 *    handler. That check runs as the key HOLDER, so a 400 can only be the schema
 *    — a 404 would prove nothing.
 *
 * The PUBLIC read is asserted here too, and specifically that it is NOT gated:
 * an offer is public commercial information, and a surface that 404'd for a
 * caller with no operator key would take the product page down with it.
 *
 * One real app; who holds what comes from the SDK-boundary fake of
 * `oxyClient.middleware.requireAppPermission`.
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
/** What Oxy says each caller holds on Mercaria's application. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [CATALOG_OPERATOR]: ['catalog.operate'],
  [PAYMENTS_OPERATOR]: ['payments.operate'],
};
/** Flip to model an Oxy that cannot answer the roles read. */
let oxyAvailable = true;
const appPermissions = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | import('../../__tests__/oxy-app-permissions-fake.js').FakeAppPermissions,
}));

vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  getRequiredOxyUserId: () => currentUser,
}));
vi.mock('../../middleware/auth.js', async () => {
  const { fakeAppPermissions } = await import('../../__tests__/oxy-app-permissions-fake.js');
  const fake = fakeAppPermissions(
    () => (oxyAvailable ? (GRANTS[currentUser] ?? []) : 'unavailable'),
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
        auth: () => (_req: unknown, res: express.Response) => res.sendStatus(401),
        requireAppPermission: fake.requireAppPermission,
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

describe('the catalog.operate application role on the offer surface', () => {
  it('lets a holder of catalog.operate through the gate on every path', async () => {
    // Past the GATE is the assertion, not a 200: the database is stubbed to
    // throw, so handlers answer 500 — what matters is that none answers 404 or
    // 400, which is what a gate or a schema refusing a valid request would yield.
    for (const route of PATHS) {
      const res = await call(url, route, CATALOG_OPERATOR);
      expect([400, 403, 404], `${route.path} was refused before reaching a handler`).not.toContain(
        res.status,
      );
    }
  });

  it('answers a caller holding no key with 404 on every path — the surface is not revealed', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, MERCHANT_USER);
      expect(res.status, route.path).toBe(404);
    }
  });

  it('does not open for a holder of payments.operate — the two keys are separate powers', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, PAYMENTS_OPERATOR);
      expect(res.status, route.path).toBe(404);
    }
  });

  it('answers 503 while Oxy cannot say, and never remembers the outage as a "no"', async () => {
    oxyAvailable = false;
    try {
      for (const route of PATHS) {
        const res = await call(url, route, CATALOG_OPERATOR);
        expect(res.status, route.path).toBe(503);
      }
    } finally {
      oxyAvailable = true;
    }
    // The very next request asks again and gets through.
    const res = await call(url, PATHS[0] ?? { method: 'GET', path: '/' }, CATALOG_OPERATOR);
    expect([403, 404, 503]).not.toContain(res.status);
  });

  it('asks Oxy fresh for a write and lets a read reuse an answer', async () => {
    const fake = appPermissions.current;
    if (!fake) throw new Error('the app-permission fake was not installed');
    fake.calls.length = 0;
    await call(url, { method: 'GET', path: '/internal/offers/convergence' }, CATALOG_OPERATOR);
    await call(
      url,
      { method: 'POST', path: '/internal/offers/listings/listing-1/converge', body: {} },
      CATALOG_OPERATOR,
    );
    expect(fake.calls).toEqual([
      { permission: 'catalog.operate', fresh: false, method: 'GET' },
      { permission: 'catalog.operate', fresh: true, method: 'POST' },
    ]);
  });
});

describe('the PUBLIC offer read is deliberately not gated', () => {
  it('answers a caller with no operator key — an offer is public information', async () => {
    // A surface that 404'd here would take the product page down with the
    // operator tooling.
    currentUser = MERCHANT_USER;
    const res = await fetch(`${url}/offers?canonicalVariantId=v1`);
    // The database is stubbed to throw, so this is a 500 — but it is a 500
    // from a HANDLER, which is what proves the route exists and is reachable.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('refuses a request naming both scopes, and one naming neither', async () => {
    // The schema's `refine`, before any query — an ambiguous comparison must
    // never reach a database that would happily answer one of the two.
    for (const query of ['', '?canonicalVariantId=v1&canonicalProductId=p1']) {
      const res = await fetch(`${url}/offers${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it('refuses a value outside a closed set rather than ignoring it', async () => {
    const res = await fetch(`${url}/offers?canonicalVariantId=v1&kinds=not_a_kind`);
    expect(res.status).toBe(400);
    // …and the same request with a REAL kind is not refused by the schema, so
    // the assertion above is a narrowing rather than a blanket rejection.
    const valid = await fetch(`${url}/offers?canonicalVariantId=v1&kinds=native,external`);
    expect(valid.status).not.toBe(400);
  });
});

describe('an operator cannot withdraw an offer unattributably', () => {
  /** As the key HOLDER, so a 400 can only be the schema. */
  const retirePath = '/internal/offers/offer-1/retire';

  it('refuses a retirement with no note, a short note, or an unknown reason', async () => {
    for (const body of [
      { reason: 'operator' },
      { reason: 'operator', note: 'too short' },
      { reason: 'because-i-said-so', note: 'A note long enough to satisfy the schema.' },
      { note: 'A note long enough to satisfy the schema.' },
    ]) {
      const res = await call(url, { method: 'POST', path: retirePath, body }, CATALOG_OPERATOR);
      expect(res.status, `${JSON.stringify(body)} was accepted`).toBe(400);
    }
  });

  it('accepts the well-formed one, so the refusals are a narrowing', async () => {
    // Without this, every assertion above would also pass against a schema that
    // rejected the endpoint's whole body.
    const res = await call(
      url,
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
      url,
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
