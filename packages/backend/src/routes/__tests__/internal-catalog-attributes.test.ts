/**
 * Who may reach `/internal/catalog-attributes/*` — issue #94, the attribute
 * registry's operator surface. The `internal-canonical-catalog.test.ts` shape,
 * applied to the THIRD router reading the SAME catalog allow-list, plus the two
 * properties this issue adds:
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403;
 *  - an EMPTY allow-list means no such surface at all — 404 from the MOUNT,
 *    because a 401 would advertise that it exists;
 *  - the PAYMENTS allow-list does not open it: separate powers, and the
 *    cross-list case is the one a refactor toward "one operator list" would
 *    silently break;
 *  - **the public surface stays public and stays reticent.** `/catalog-attributes`
 *    is mounted with no allow-list at all, and its value projection carries no
 *    provenance — the two halves of #94 API rule 7.
 *  - **an observation cannot carry a canonical value.** `.strict()` means a body
 *    with `normalizedNumber`, `selectionState` or `normalizedText` is refused at
 *    the schema, so "internal upsert APIs accept source facts" is a property of
 *    the request boundary rather than a habit in a handler.
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

interface Route {
  method: 'POST' | 'GET';
  path: string;
  body?: unknown;
}

/** Every path the operator surface exposes, with a minimal valid body. */
const PATHS: readonly Route[] = [
  {
    method: 'POST',
    path: '/internal/catalog-attributes/definitions',
    body: { key: 'screen_size', label: 'Screen size', valueType: 'measurement', unitFamily: 'length' },
  },
  { method: 'POST', path: '/internal/catalog-attributes/definitions/screen_size/versions/1/publish' },
  { method: 'POST', path: '/internal/catalog-attributes/definitions/screen_size/versions/1/deprecate' },
  { method: 'POST', path: '/internal/catalog-attributes/definitions/screen_size/versions/1/retire' },
  { method: 'GET', path: '/internal/catalog-attributes/definitions/screen_size/versions' },
  { method: 'GET', path: '/internal/catalog-attributes/definitions/screen_size' },
  {
    method: 'POST',
    path: '/internal/catalog-attributes/source-mappings',
    body: { catalogSourceId: 's1', sourceField: 'memory_size', attributeKey: 'ram_capacity' },
  },
  {
    method: 'POST',
    path: '/internal/catalog-attributes/observations',
    body: {
      entityKind: 'product',
      entityId: 'p1',
      attributeKey: 'ram_capacity',
      displayValue: '16 GB',
      sourceRecordId: 'r1',
    },
  },
  { method: 'GET', path: '/internal/catalog-attributes/values/product/p1' },
  { method: 'GET', path: '/internal/catalog-attributes/reviews' },
  {
    method: 'POST',
    path: '/internal/catalog-attributes/reviews/rv1/resolve',
    body: { state: 'dismissed' },
  },
  { method: 'GET', path: '/internal/catalog-attributes/coverage' },
  { method: 'GET', path: '/internal/catalog-attributes/reindex-requests' },
];

async function call(baseUrl: string, route: Route, actingAs: string): Promise<Response> {
  currentUser = actingAs;
  return await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    ...(route.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) }),
  });
}

describe('the catalog operator allow-list on the attribute surface', () => {
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

describe('the observation endpoint takes source facts and nothing else', () => {
  const forbidden = [
    { normalizedNumber: 16_000_000_000 },
    { normalizedText: 'sixteen' },
    { selectionState: 'selected' },
    { verificationState: 'operator_verified' },
    { normalizationState: 'normalized' },
  ];

  it.each(forbidden)('refuses a body carrying %j', async (extra) => {
    // As the ALLOW-LISTED operator, so a 400 can only be the schema — a 403
    // would prove nothing about the request boundary.
    const res = await call(
      enabledUrl,
      {
        method: 'POST',
        path: '/internal/catalog-attributes/observations',
        body: {
          entityKind: 'product',
          entityId: 'p1',
          attributeKey: 'ram_capacity',
          displayValue: '16 GB',
          sourceRecordId: 'r1',
          ...extra,
        },
      },
      CATALOG_OPERATOR,
    );
    expect(res.status).toBe(400);
  });
});

describe('the PUBLIC attribute surface', () => {
  it('is mounted with no allow-list, on a deployment that has no operators', async () => {
    // The public reads must not disappear when nobody is allow-listed: they are
    // catalogue identity, not operator tooling.
    const res = await fetch(`${disabledUrl}/catalog-attributes/definitions`);
    expect(res.status).not.toBe(404);
  });

  it('refuses a constraint set that names no constraints', async () => {
    const res = await fetch(`${enabledUrl}/catalog-attributes/constraints/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constraints: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a text preference that tries to declare itself hard', async () => {
    // The wire has no representation of a hard text requirement — the schema
    // has no `strength` field on a text preference, and it is `.strict()`.
    const res = await fetch(`${enabledUrl}/catalog-attributes/constraints/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        constraints: [
          {
            kind: 'text',
            id: 't1',
            scope: 'product',
            explanation: 'mentions gaming',
            query: 'gaming',
            fields: ['name'],
            strength: 'hard',
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });
});
