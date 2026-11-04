/**
 * Who may reach `/internal/catalog-attributes/*` — issue #94, the attribute
 * registry's operator surface. The `internal-canonical-catalog.test.ts` shape,
 * applied to the THIRD router gated on the SAME `catalog.operate` key, plus the two
 * properties this issue adds:
 *
 *  - a holder of the desk's key gets past the gate;
 *  - an authenticated Oxy user holding no key gets 404 — never revealed;
 *  - holding `payments.operate` does not open it: separate powers, and the
 *    cross-desk case is the one a refactor toward "one operator key" would
 *    silently break;
 *  - **the public surface stays public and stays reticent.** `/catalog-attributes`
 *    is mounted with no operator gate at all, and its value projection carries no
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
    body: {
      key: 'screen_size',
      label: 'Screen size',
      valueType: 'measurement',
      unitFamily: 'length',
    },
  },
  {
    method: 'POST',
    path: '/internal/catalog-attributes/definitions/screen_size/versions/1/publish',
  },
  {
    method: 'POST',
    path: '/internal/catalog-attributes/definitions/screen_size/versions/1/deprecate',
  },
  {
    method: 'POST',
    path: '/internal/catalog-attributes/definitions/screen_size/versions/1/retire',
  },
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

describe('the catalog.operate application role on the attribute surface', () => {
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
      expect(res.status, route.path).toBe(404);
    }
  });

  it('does not open for a holder of payments.operate — the keys are separate powers', async () => {
    for (const route of PATHS) {
      const res = await call(url, route, PAYMENTS_OPERATOR);
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
    // As the key HOLDER, so a 400 can only be the schema — a 404
    // would prove nothing about the request boundary.
    const res = await call(
      url,
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
  it('is reachable by a caller holding no operator key', async () => {
    // The public reads must not disappear for somebody who is no operator: they
    // are catalogue identity, not operator tooling.
    currentUser = MERCHANT_USER;
    const res = await fetch(`${url}/catalog-attributes/definitions`);
    expect(res.status).not.toBe(404);
  });

  it('refuses a constraint set that names no constraints', async () => {
    const res = await fetch(`${url}/catalog-attributes/constraints/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constraints: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a text preference that tries to declare itself hard', async () => {
    // The wire has no representation of a hard text requirement — the schema
    // has no `strength` field on a text preference, and it is `.strict()`.
    const res = await fetch(`${url}/catalog-attributes/constraints/validate`, {
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
