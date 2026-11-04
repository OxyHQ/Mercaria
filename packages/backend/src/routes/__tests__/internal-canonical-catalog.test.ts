/**
 * Who may reach `/internal/canonical-catalog/*` — issue #56, the operator-only
 * product surface. The `internal-commerce-graph.test.ts` shape, applied to the
 * second router that reads the SAME `catalog.operate` key, and the same three
 * properties plus one this issue adds:
 *
 *  - a holder of the desk's key gets past the gate;
 *  - an authenticated Oxy user holding no key gets 404 — never revealed;
 *  - holding `payments.operate` does not open it: separate powers, and the
 *    cross-desk case is the one a refactor toward "one operator key" would
 *    silently break;
 *  - **the source-fact endpoints REFUSE a canonical field.** `.strict()` means
 *    a body carrying `name`, `slug`, `status` or `pinnedFields` is rejected at
 *    the schema, so #56 API rule 4 ("accept source facts rather than arbitrary
 *    canonical overwrite") is a property of the request boundary rather than a
 *    habit in a handler. That check runs as the key HOLDER, so a 400
 *    can only be the schema — a 404 would prove nothing.
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

/**
 * Every path the surface exposes, with a method and a minimal valid body.
 *
 * The three MERGE paths were removed with the handlers behind them (#36
 * completion criterion 4): `/product-families/:winnerId/merge`,
 * `/products/:winnerId/merge` and `/variants/:winnerId/merge` performed a
 * single-transaction merge outside #59's conflict gate and census-complete
 * rehoming plan. `internal-commerce-graph.test.ts` covers the merge-job routes
 * that replaced them, on the SAME `catalog.operate` key.
 */
const PATHS: readonly { method: 'POST'; path: string; body: unknown }[] = [
  // `/attribute-definitions` was HERE until #94, which made a definition a
  // versioned record with a lifecycle and moved the whole registry to
  // `/internal/catalog-attributes/definitions` — its own router on the SAME
  // operator key, gated by `internal-catalog-attributes.test.ts`.
  {
    method: 'POST',
    path: '/internal/canonical-catalog/product-families',
    body: { name: 'iPhone' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/products',
    body: { name: 'iPhone 16 Pro' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/products/p1/variants',
    body: { options: [{ key: 'color', value: 'Black' }] },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/products/p1/observations',
    body: {
      sourceId: 's1',
      externalId: 'ext-1',
      observedAt: '2026-08-01T00:00:00.000Z',
      method: 'connector_declared',
      matchRule: 'test.rule',
    },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/identifiers',
    body: { variantId: 'v1', scheme: 'ean', rawValue: '4006381333931' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/identifiers/i1/correct',
    body: {
      scheme: 'ean',
      rawValue: '4006381333931',
      note: 'A note long enough to satisfy the schema.',
    },
  },
];

async function call(
  baseUrl: string,
  route: { method: 'POST'; path: string; body: unknown },
  actingAs: string,
): Promise<Response> {
  currentUser = actingAs;
  return await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(route.body),
  });
}

describe('the catalog.operate application role on the product surface', () => {
  it('lets a holder of catalog.operate through the gate on every path', async () => {
    // Past the GATE is the assertion, not a 200: the database is stubbed to
    // throw, so handlers answer 500 — what matters is that none answers 403,
    // 404 or 400, which is what a gate or a schema refusing a valid request
    // would yield.
    for (const route of PATHS) {
      const res = await call(url, route, CATALOG_OPERATOR);
      expect([400, 403, 404], `${route.path} was refused before reaching a handler`).not.toContain(
        res.status,
      );
    }
  });

  it('answers a caller holding no key with 404 on every path', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, MERCHANT_USER);
      expect(res.status).toBe(404);
    }
  });

  it('does not open for a holder of payments.operate — the keys are separate powers', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, PAYMENTS_OPERATOR);
      expect(res.status).toBe(404);
    }
  });
});

describe('the source-fact boundary (#56 API rule 4)', () => {
  /** As the key HOLDER, so a 400 can only be the schema. */
  const observationPath = '/internal/canonical-catalog/products/p1/observations';
  const validObservation = {
    sourceId: 's1',
    externalId: 'ext-1',
    observedAt: '2026-08-01T00:00:00.000Z',
    method: 'connector_declared',
    matchRule: 'test.rule',
  };

  it('refuses a canonical field on the source-fact endpoint', async () => {
    for (const forbidden of [
      { name: 'A curated name' },
      { slug: 'a-curated-slug' },
      { status: 'active' },
      { pinnedFields: ['name'] },
      { variantDefiningAttributeKeys: ['color'] },
      { rating: 5 },
    ]) {
      const res = await call(
        url,
        { method: 'POST', path: observationPath, body: { ...validObservation, ...forbidden } },
        CATALOG_OPERATOR,
      );
      expect(res.status, `${JSON.stringify(forbidden)} was accepted`).toBe(400);
    }
  });

  it('accepts the same request WITHOUT the canonical field, so the refusal is a narrowing', async () => {
    // Without this, every assertion above would also pass against a schema that
    // rejected the endpoint's whole body.
    const res = await call(
      url,
      {
        method: 'POST',
        path: observationPath,
        body: { ...validObservation, sourceTitle: 'What the source called it' },
      },
      CATALOG_OPERATOR,
    );
    expect(res.status).not.toBe(400);
  });

  it('has no field through which a merchant SKU could arrive as an identifier', async () => {
    // #56 acceptance 2, at the request boundary: there is no `sku` scheme and no
    // `sku` field, so a seller's private code has no path into identity.
    const res = await call(
      url,
      {
        method: 'POST',
        path: '/internal/canonical-catalog/identifiers',
        body: { variantId: 'v1', scheme: 'sku', rawValue: 'SELLER-SKU-1' },
      },
      CATALOG_OPERATOR,
    );
    expect(res.status).toBe(400);

    const withSkuField = await call(
      url,
      {
        method: 'POST',
        path: '/internal/canonical-catalog/identifiers',
        body: { variantId: 'v1', scheme: 'ean', rawValue: '4006381333931', sku: 'SELLER-SKU-1' },
      },
      CATALOG_OPERATOR,
    );
    expect(withSkuField.status).toBe(400);
  });

  it('refuses an identifier request that names both grains, or neither', async () => {
    for (const body of [
      { productId: 'p1', variantId: 'v1', scheme: 'ean', rawValue: '4006381333931' },
      { scheme: 'ean', rawValue: '4006381333931' },
    ]) {
      const res = await call(
        url,
        { method: 'POST', path: '/internal/canonical-catalog/identifiers', body },
        CATALOG_OPERATOR,
      );
      expect(res.status).toBe(400);
    }
  });
});
