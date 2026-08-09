/**
 * Who may reach `/internal/retail-eligibility/*` (#121 operations 3), and what a
 * client may put into it (#121 acceptance 8's "client-bypass attempts").
 *
 * The `internal-analytics.test.ts` shape, applied to the FIFTH operator
 * allow-list, with the same four properties:
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a read;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that the surface exists;
 *  - the PAYMENTS and CATALOG allow-lists do not open it: separate powers, and
 *    the cross-list case is the one a refactor toward "one operator list" would
 *    silently break. This is the list whose misuse puts an unsafe product back
 *    on sale, so it is the one that most needs the case.
 *
 * Plus the four this issue adds, all about what a caller can WRITE:
 *
 *  - no body accepts a `force` / `bypass` / `assumeEligible` field — `.strict()`
 *    refuses it, so an override cannot be smuggled past the gate;
 *  - an exception body cannot even NAME an unwaivable reason: the enum on the
 *    wire is the waivable set;
 *  - a recall cannot be filed as `advisory`, which would record it and change
 *    nothing;
 *  - a policy version cannot REQUIRE evidence that could never authorize a
 *    resale, and the refusal names the prohibition rather than saying
 *    "invalid enum value".
 *
 * Two real apps against two frozen configs, because the empty-list case is a
 * property of the MOUNT, not of any handler.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const RETAIL_OPERATOR = 'oxy-user-retail-operator-1';
const PAYMENTS_OPERATOR = 'oxy-user-payments-operator-1';
const CATALOG_OPERATOR = 'oxy-user-catalog-operator-1';
const ORDINARY_USER = 'oxy-user-merchant-1';

/** Whichever caller the current request is acting as. */
let currentUser = RETAIL_OPERATOR;

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
  makeActorRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
}));
vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    guest: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
async function buildApp(retailOperatorIds: string): Promise<express.Express> {
  vi.resetModules();
  process.env.RETAIL_OPERATOR_OXY_USER_IDS = retailOperatorIds;
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = PAYMENTS_OPERATOR;
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = CATALOG_OPERATOR;
  process.env.STRIPE_ENABLED = 'false';
  const { createApp } = await import('../../app.js');
  return createApp();
}

/** POST a JSON body as the current caller. */
async function post(url: string, path: string, payload: unknown): Promise<Response> {
  return await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  ({ server: enabledServer, url: enabledUrl } = await listen(await buildApp(RETAIL_OPERATOR)));
  ({ server: disabledServer, url: disabledUrl } = await listen(await buildApp('')));
}, 60_000);

afterAll(async () => {
  delete process.env.RETAIL_OPERATOR_OXY_USER_IDS;
  delete process.env.PAYMENT_OPERATOR_OXY_USER_IDS;
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
  delete process.env.STRIPE_ENABLED;
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

describe('the /internal/retail-eligibility operator gate', () => {
  it('lets an allow-listed operator past the gate', async () => {
    currentUser = RETAIL_OPERATOR;
    // The database stub throws, so a 500 here means the gate PASSED and the
    // handler ran — which is the property under test. A 403 or 404 would mean
    // it did not.
    const response = await fetch(`${enabledUrl}/internal/retail-eligibility/policies`);
    expect(response.status).toBe(500);
  });

  it('refuses an authenticated user who is not on the list', async () => {
    currentUser = ORDINARY_USER;
    const response = await fetch(`${enabledUrl}/internal/retail-eligibility/policies`);
    expect(response.status).toBe(403);
  });

  it('refuses the PAYMENTS operator — separate lists, separate powers', async () => {
    currentUser = PAYMENTS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/retail-eligibility/policies`);
    expect(response.status).toBe(403);
  });

  it('refuses the CATALOG operator too', async () => {
    // Lifting a recall is not a catalogue-curation power. The cross-list case a
    // refactor toward "one operator list" would silently break.
    currentUser = CATALOG_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/retail-eligibility/policies`);
    expect(response.status).toBe(403);
  });

  it('does not MOUNT the surface at all on an empty allow-list', async () => {
    // 404, never 401: a 401 would tell an unauthenticated caller that a
    // compliance surface exists on this deployment.
    currentUser = RETAIL_OPERATOR;
    for (const path of [
      '/internal/retail-eligibility/policies',
      '/internal/retail-eligibility/suppressions',
      '/internal/retail-eligibility/metrics',
    ]) {
      const response = await fetch(`${disabledUrl}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});

describe('acceptance 8: client-bypass attempts', () => {
  it('refuses an override-shaped field on the trace body', async () => {
    currentUser = RETAIL_OPERATOR;
    for (const smuggled of [
      { force: true },
      { bypass: true },
      { assumeEligible: true },
      { skipChecks: ['product_recalled'] },
      { verdict: 'eligible' },
    ]) {
      const response = await post(enabledUrl, '/internal/retail-eligibility/trace', {
        procurementOfferId: 'offer-1',
        channel: 'mercaria_branded_checkout',
        destinationCountry: 'ES',
        currency: 'EUR',
        quantity: 1,
        fulfilmentMethod: 'standard_delivery',
        customerType: 'consumer',
        ...smuggled,
      });
      // 400 from `.strict()`, before any handler — never a 500 from the
      // database stub, which is what a body that got THROUGH would produce.
      expect(response.status, JSON.stringify(smuggled)).toBe(400);
    }
  });

  it('accepts the same body without the smuggled field, so the refusal is not vacuous', async () => {
    currentUser = RETAIL_OPERATOR;
    const response = await post(enabledUrl, '/internal/retail-eligibility/trace', {
      procurementOfferId: 'offer-1',
      channel: 'mercaria_branded_checkout',
      destinationCountry: 'ES',
      currency: 'EUR',
      quantity: 1,
      fulfilmentMethod: 'standard_delivery',
      customerType: 'consumer',
    });
    // Past the schema and into the handler, where the database stub throws.
    expect(response.status).toBe(500);
  });

  it('refuses an exception that names an UNWAIVABLE reason', async () => {
    currentUser = RETAIL_OPERATOR;
    for (const reason of [
      'product_recalled',
      'category_prohibited',
      'compliance_evidence_expired',
      'resale_evidence_missing',
      'tax_treatment_unknown',
    ]) {
      const response = await post(enabledUrl, '/internal/retail-eligibility/exceptions', {
        policyId: 'policy-1',
        supplierId: 'supplier-1',
        waivedReasons: [reason],
        justification: 'we would really like to sell this',
        expiresAt: '2027-01-01T00:00:00.000Z',
        reason: 'commercial pressure',
      });
      // The enum on the wire IS the waivable set: an unwaivable reason has no
      // representation, so it never reaches the database CHECK that would also
      // refuse it.
      expect(response.status, reason).toBe(400);
    }
  });

  it('accepts a WAIVABLE reason on the same body', async () => {
    currentUser = RETAIL_OPERATOR;
    const response = await post(enabledUrl, '/internal/retail-eligibility/exceptions', {
      policyId: 'policy-1',
      supplierId: 'supplier-1',
      waivedReasons: ['category_requires_approval'],
      justification: 'the category assessment is in flight and the SKU is low risk',
      expiresAt: '2027-01-01T00:00:00.000Z',
      reason: 'pilot scope',
    });
    expect(response.status).toBe(500);
  });

  it('refuses a recall filed as ADVISORY — the one combination that changes nothing', async () => {
    currentUser = RETAIL_OPERATOR;
    const response = await post(enabledUrl, '/internal/retail-eligibility/suppressions', {
      scope: 'canonical_variant',
      scopeRef: 'variant-1',
      kind: 'recall',
      severity: 'advisory',
      source: 'authority',
      reason: 'authority notice',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a policy version requiring evidence that can never authorize a resale', async () => {
    currentUser = RETAIL_OPERATOR;
    const response = await post(enabledUrl, '/internal/retail-eligibility/policies', {
      policyKey: 'mercaria-retail-eligibility',
      version: 2,
      name: 'Affiliate-backed',
      summary: 'Trying to launch on an affiliate feed.',
      effectiveStart: '2026-08-09T00:00:00.000Z',
      requiredResaleEvidenceKinds: ['affiliate_product_feed'],
      reason: 'faster launch',
    });
    expect(response.status).toBe(400);
    // The canonical Mercaria envelope: `error` is the machine code, `message`
    // the human explanation.
    const payload = (await response.json()) as { error?: string; message?: string };
    expect(payload.error).toBe('VALIDATION_ERROR');
    // …and the refusal NAMES the prohibition rather than saying "invalid enum
    // value", which is the whole reason the detector runs BEFORE the schema.
    expect(payload.message ?? '').toMatch(/affiliate/i);
    expect(payload.message ?? '').toMatch(/WRITTEN grant/);
  });

  it('refuses every mutating body with no reason — an audit row with none answers nothing', async () => {
    currentUser = RETAIL_OPERATOR;
    for (const [path, payload] of [
      ['/internal/retail-eligibility/policies/policy-1/activate', {}],
      ['/internal/retail-eligibility/suppressions/suppression-1/lift', {}],
      ['/internal/retail-eligibility/resale-evidence/evidence-1/verify', {}],
      ['/internal/retail-eligibility/exceptions/exception-1/approve', {}],
    ] as const) {
      const response = await post(enabledUrl, path, payload);
      expect(response.status, path).toBe(400);
    }
  });
});
