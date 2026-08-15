/**
 * Who may reach `/internal/backfill/*`, and what the canonical READ levers do to
 * the public surfaces — issue #60 feature flags 2, 3 and 5, plus acceptance 5
 * ("turning off canonical reads restores the existing listing-first
 * experience") and acceptance 7 (rollback is tested, not just documented).
 *
 * The `internal-offers.test.ts` shape, extended with the thing this issue adds:
 * FOUR apps against four frozen configs, because a lever's effect is a property
 * of the MOUNT and of a middleware that reads a frozen config — neither is
 * observable from a handler test.
 *
 *  - an allow-listed catalog operator gets past the gate on every path;
 *  - an authenticated non-operator gets 403, not a run;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that it exists;
 *  - the PAYMENTS allow-list does not open it: separate powers, and the
 *    cross-list case is what a refactor toward "one operator list" would
 *    silently break.
 *
 * And the rollout half, which is where acceptance 5 actually lives:
 *
 *  - with every lever at its DEFAULT, `/canonical-products`, `/product-families`
 *    and `/offers` answer exactly as they did before this issue — because a
 *    lever that withdrew a shipped surface on the deploy that added it would be
 *    an outage rather than a rollout;
 *  - `CANONICAL_READS=off` 404s the canonical product surfaces and leaves the
 *    offer comparison alone, and vice versa: the two levers bound different
 *    blast radii or they are one lever wearing two names;
 *  - `CANONICAL_PUBLIC_ROUTES_ENABLED=false` removes all three at once — the
 *    blunt rollback, which must not depend on every handler having remembered
 *    its own gate;
 *  - the OPERATOR surface stays reachable through all of it, because the
 *    evidence has to be readable during exactly the incident that turned the
 *    levers off.
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
// A 403/404/400 is decided before any query; the stub is what keeps this a ROUTE
// test rather than a second copy of the realdb suite.
vi.mock('../../db/postgres.js', () => ({
  getDb: () => {
    throw new Error('An authorization test must not reach the database.');
  },
  checkPostgresHealth: () => Promise.resolve(true),
  assertMigrationsCurrent: () => Promise.resolve(),
  closePostgres: () => Promise.resolve(),
}));

interface Deployment {
  readonly server: Server;
  readonly url: string;
}

const deployments: Deployment[] = [];
let enabled: Deployment;
let noOperators: Deployment;
let readsOff: Deployment;
let routesOff: Deployment;

async function listen(app: express.Express): Promise<Deployment> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => {
      resolve(started);
    });
  });
  const { port } = server.address() as AddressInfo;
  const deployment = { server, url: `http://127.0.0.1:${String(port)}` };
  deployments.push(deployment);
  return deployment;
}

/**
 * Build a real app against a FROZEN config. `config/index.ts` reads process.env
 * once at module load; `vi.resetModules()` gives each app its own frozen view,
 * which is the only way to observe a lever that gates a MOUNT.
 */
async function buildApp(env: Record<string, string>): Promise<express.Express> {
  vi.resetModules();
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = PAYMENTS_OPERATOR;
  process.env.STRIPE_ENABLED = 'false';
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = CATALOG_OPERATOR;
  delete process.env.CANONICAL_READS;
  delete process.env.CANONICAL_OFFER_COMPARISON;
  delete process.env.CANONICAL_PUBLIC_ROUTES_ENABLED;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const { createApp } = await import('../../app.js');
  return createApp();
}

beforeAll(async () => {
  enabled = await listen(await buildApp({}));
  noOperators = await listen(await buildApp({ CATALOG_OPERATOR_OXY_USER_IDS: '' }));
  readsOff = await listen(await buildApp({ CANONICAL_READS: 'off' }));
  routesOff = await listen(await buildApp({ CANONICAL_PUBLIC_ROUTES_ENABLED: 'false' }));
}, 60_000);

afterAll(async () => {
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
  delete process.env.PAYMENT_OPERATOR_OXY_USER_IDS;
  delete process.env.CANONICAL_READS;
  delete process.env.CANONICAL_OFFER_COMPARISON;
  delete process.env.CANONICAL_PUBLIC_ROUTES_ENABLED;
  await Promise.all(
    deployments.map(
      (deployment) =>
        new Promise<void>((resolve, reject) => {
          deployment.server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    ),
  );
});

/** Every path the operator surface exposes, with a minimal valid body. */
const OPERATOR_PATHS: readonly { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/internal/backfill/flags' },
  { method: 'GET', path: '/internal/backfill/metrics' },
  { method: 'GET', path: '/internal/backfill/runs' },
  {
    method: 'POST',
    path: '/internal/backfill/runs',
    body: { stage: 'store_merchants', mode: 'dry_run' },
  },
  { method: 'POST', path: '/internal/backfill/runs/run-1/page', body: {} },
  {
    method: 'POST',
    path: '/internal/backfill/runs/run-1/cancel',
    body: { reason: 'operator changed their mind' },
  },
  { method: 'GET', path: '/internal/backfill/runs/run-1/records' },
  { method: 'GET', path: '/internal/backfill/subjects/listing:listing-1' },
  { method: 'GET', path: '/internal/backfill/findings' },
];

async function call(
  baseUrl: string,
  route: { method: 'GET' | 'POST'; path: string; body?: unknown },
  actingAs: string = CATALOG_OPERATOR,
): Promise<Response> {
  currentUser = actingAs;
  return await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    ...(route.method === 'POST' ? { body: JSON.stringify(route.body ?? {}) } : {}),
  });
}

describe('the catalog operator allow-list on the backfill surface', () => {
  it('lets an allow-listed catalog operator through the gate on every path', async () => {
    // Past the GATE is the assertion, not a 200: the database is stubbed to
    // throw, so handlers answer 500 — what matters is that none answers 403,
    // 404 or 400, which is what a gate or a schema refusing a valid request
    // would yield. `/flags` is the exception and legitimately answers 200: it
    // reads configuration and nothing else.
    for (const route of OPERATOR_PATHS) {
      const res = await call(enabled.url, route);
      expect([400, 403, 404], `${route.path} was refused before reaching a handler`).not.toContain(
        res.status,
      );
    }
  });

  it('refuses an authenticated non-operator with 403 on every path', async () => {
    for (const route of OPERATOR_PATHS) {
      const res = await call(enabled.url, route, MERCHANT_USER);
      expect(res.status, route.path).toBe(403);
    }
  });

  it('does not mount the surface at all when the allow-list is empty', async () => {
    for (const route of OPERATOR_PATHS) {
      const res = await call(noOperators.url, route);
      expect(res.status, route.path).toBe(404);
    }
  });

  it('does not open the surface to the PAYMENTS operator', async () => {
    for (const route of OPERATOR_PATHS) {
      const res = await call(enabled.url, route, PAYMENTS_OPERATOR);
      expect(res.status, route.path).toBe(403);
    }
  });

  it('reports every rollout lever, and reads them from configuration alone', async () => {
    const res = await call(enabled.url, { method: 'GET', path: '/internal/backfill/flags' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { flags: Record<string, unknown> };
    };
    // The two WRITE levers default OFF, as ADR 0002 D24 binds; the READ levers
    // default to today's behaviour. Both halves asserted, because a change to
    // either default is a rollout decision and not a refactor.
    expect(body.data.flags.graphEnabled).toBe(false);
    expect(body.data.flags.writePublicationEnabled).toBe(false);
    expect(body.data.flags.reads).toBe('on');
    expect(body.data.flags.offerComparison).toBe('on');
    expect(body.data.flags.publicRoutesEnabled).toBe(true);
    expect(body.data.flags.searchIndexingEnabled).toBe(false);
    expect(body.data.flags.readCohorts).toEqual([]);
  });
});

describe('the canonical READ levers (acceptance 5 and 7)', () => {
  /**
   * A path is REACHABLE when it does not 404 from a mount or a lever.
   *
   * The stubbed database makes every real read answer 500, so 500 is the
   * "reached a handler" signal here and 404 is the "a lever refused it" one.
   * That distinction is the whole test: a handler that happened to answer 404 on
   * its own would be indistinguishable from a lever, which is why every probe
   * below uses a path whose handler cannot answer 404 without touching Postgres.
   */
  const CANONICAL_PATHS = [
    '/canonical-products/does-not-exist',
    // The id form, not the bare collection: `/product-families` has no index
    // route, so it 404s on its own and would make this probe unable to tell a
    // lever from a missing route — the vacuous version of the whole test.
    '/product-families/does-not-exist',
  ];
  const OFFER_PATH = '/offers?canonicalVariantId=variant-1';

  it('leaves every shipped public surface exactly as it was, at the defaults', async () => {
    for (const path of [...CANONICAL_PATHS, OFFER_PATH]) {
      const res = await fetch(`${enabled.url}${path}`);
      expect(res.status, `${path} was withdrawn by a lever at its default`).not.toBe(404);
    }
  });

  it('CANONICAL_READS=off 404s the canonical product surfaces and NOTHING else', async () => {
    for (const path of CANONICAL_PATHS) {
      const res = await fetch(`${readsOff.url}${path}`);
      expect(res.status, path).toBe(404);
    }
    // The offer comparison is a SEPARATE lever and is untouched — withdrawing
    // price comparison and withdrawing product identity are different decisions.
    const offers = await fetch(`${readsOff.url}${OFFER_PATH}`);
    expect(offers.status).not.toBe(404);
  });

  it('CANONICAL_PUBLIC_ROUTES_ENABLED=false removes all three at once', async () => {
    for (const path of [...CANONICAL_PATHS, OFFER_PATH]) {
      const res = await fetch(`${routesOff.url}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('keeps the OPERATOR surface reachable while every read lever is off', async () => {
    // The evidence has to be readable during exactly the incident that turned
    // the levers off, which is why `/internal/backfill` is gated on the operator
    // allow-list and on nothing else.
    for (const deployment of [readsOff, routesOff]) {
      const res = await call(deployment.url, {
        method: 'GET',
        path: '/internal/backfill/flags',
      });
      expect(res.status).toBe(200);
    }
  });
});
