/**
 * Who may reach `/internal/canonical-catalog/*` — issue #56, the operator-only
 * product surface. The `internal-commerce-graph.test.ts` shape, applied to the
 * second router that reads the SAME catalog allow-list, and the same four
 * properties plus one this issue adds:
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a write;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that the surface exists;
 *  - the PAYMENTS allow-list does not open it: separate powers, and the
 *    cross-list case is the one a refactor toward "one operator list" would
 *    silently break;
 *  - **the source-fact endpoints REFUSE a canonical field.** `.strict()` means
 *    a body carrying `name`, `slug`, `status` or `pinnedFields` is rejected at
 *    the schema, so #56 API rule 4 ("accept source facts rather than arbitrary
 *    canonical overwrite") is a property of the request boundary rather than a
 *    habit in a handler. That check runs as the ALLOW-LISTED operator, so a 400
 *    can only be the schema — a 403 would prove nothing.
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
const PATHS: readonly { method: 'POST'; path: string; body: unknown }[] = [
  {
    method: 'POST',
    path: '/internal/canonical-catalog/attribute-definitions',
    body: { key: 'storage', label: 'Storage', valueType: 'text' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/product-families',
    body: { name: 'iPhone' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/product-families/f1/merge',
    body: { loserId: 'f2', reason: 'A reason long enough to satisfy the schema.' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/products',
    body: { name: 'iPhone 16 Pro' },
  },
  {
    method: 'POST',
    path: '/internal/canonical-catalog/products/p1/merge',
    body: { loserId: 'p2', reason: 'A reason long enough to satisfy the schema.' },
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
    path: '/internal/canonical-catalog/variants/v1/merge',
    body: { loserId: 'v2', reason: 'A reason long enough to satisfy the schema.' },
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

describe('the catalog operator allow-list on the product surface', () => {
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

describe('the source-fact boundary (#56 API rule 4)', () => {
  /** As the ALLOW-LISTED operator, so a 400 can only be the schema. */
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
        enabledUrl,
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
      enabledUrl,
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
      enabledUrl,
      {
        method: 'POST',
        path: '/internal/canonical-catalog/identifiers',
        body: { variantId: 'v1', scheme: 'sku', rawValue: 'SELLER-SKU-1' },
      },
      CATALOG_OPERATOR,
    );
    expect(res.status).toBe(400);

    const withSkuField = await call(
      enabledUrl,
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
        enabledUrl,
        { method: 'POST', path: '/internal/canonical-catalog/identifiers', body },
        CATALOG_OPERATOR,
      );
      expect(res.status).toBe(400);
    }
  });
});
