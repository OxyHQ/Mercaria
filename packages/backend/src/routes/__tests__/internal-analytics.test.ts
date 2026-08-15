/**
 * Who may reach `/internal/analytics/*` (#77 dashboards), and what a client may
 * put into `/analytics/events` (#77 acceptance 3).
 *
 * The `internal-canonical-catalog.test.ts` shape, applied to the FOURTH
 * operator allow-list, with the same four properties:
 *
 *  - an allow-listed Oxy operator gets past the gate;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a read;
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, because a 401 would advertise that the surface exists;
 *  - the PAYMENTS allow-list does not open it: separate powers, and the
 *    cross-list case is the one a refactor toward "one operator list" would
 *    silently break.
 *
 * Plus the two this issue adds, both about the INGEST endpoint:
 *
 *  - it refuses every event type outside `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES`,
 *    which is acceptance 3 at the request boundary — a browser cannot assert a
 *    payment, a session issuance, a cart merge or a completed claim;
 *  - it answers 202 rather than 201, because the events were accepted into a
 *    bounded queue that may drop them.
 *
 * Two real apps against two frozen configs, because the empty-list case is a
 * property of the MOUNT, not of any handler.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const ANALYTICS_OPERATOR = 'oxy-user-analytics-operator-1';
const PAYMENTS_OPERATOR = 'oxy-user-payments-operator-1';
const ORDINARY_USER = 'oxy-user-merchant-1';

/** Whichever caller the current request is acting as. */
let currentUser = ANALYTICS_OPERATOR;

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
async function buildApp(analyticsOperatorIds: string): Promise<express.Express> {
  vi.resetModules();
  process.env.ANALYTICS_OPERATOR_OXY_USER_IDS = analyticsOperatorIds;
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = PAYMENTS_OPERATOR;
  // Collection ON for the ingest cases; the enabled/disabled distinction under
  // test here is the OPERATOR list, not the collection flag.
  process.env.ANALYTICS_COLLECTION_MODE = 'full';
  process.env.ANALYTICS_ENABLED = 'true';
  process.env.STRIPE_ENABLED = 'false';
  const { createApp } = await import('../../app.js');
  return createApp();
}

beforeAll(async () => {
  ({ server: enabledServer, url: enabledUrl } = await listen(await buildApp(ANALYTICS_OPERATOR)));
  ({ server: disabledServer, url: disabledUrl } = await listen(await buildApp('')));
}, 60_000);

afterAll(async () => {
  delete process.env.ANALYTICS_OPERATOR_OXY_USER_IDS;
  delete process.env.PAYMENT_OPERATOR_OXY_USER_IDS;
  delete process.env.ANALYTICS_COLLECTION_MODE;
  delete process.env.ANALYTICS_ENABLED;
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

describe('the /internal/analytics operator gate', () => {
  it('lets an allow-listed operator read the metric catalogue', async () => {
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/analytics/metrics`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { metrics: { key: string; denominator: string }[] };
    };
    // Acceptance 6: the catalogue a dashboard builds itself from, so a client
    // never has to hold a copy of what a metric means.
    expect(body.data.metrics.length).toBeGreaterThanOrEqual(18);
    for (const metric of body.data.metrics) {
      expect(metric.denominator.length).toBeGreaterThan(10);
    }
  });

  it('refuses an authenticated user who is not on the list', async () => {
    currentUser = ORDINARY_USER;
    const response = await fetch(`${enabledUrl}/internal/analytics/metrics`);
    expect(response.status).toBe(403);
  });

  it('refuses the PAYMENTS operator — separate lists, separate powers', async () => {
    // The cross-list case a refactor toward "one operator list" would silently
    // break, and the reason this domain has a fourth list at all.
    currentUser = PAYMENTS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/analytics/metrics`);
    expect(response.status).toBe(403);
  });

  it('does not MOUNT the surface at all on an empty allow-list', async () => {
    // 404, never 401: a 401 would tell an unauthenticated caller that an
    // operator surface exists on this deployment.
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${disabledUrl}/internal/analytics/metrics`);
    expect(response.status).toBe(404);
  });

  it('refuses a metric key no definition explains', async () => {
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(
      `${enabledUrl}/internal/analytics/metrics/invented_metric?from=2026-01-01&to=2026-01-02`,
    );
    // A dashboard must not be able to render a number nothing explains, and the
    // read is refused before the database is touched — which the mocked `getDb`
    // proves, since reaching it would throw and produce a 500.
    expect(response.status).toBe(404);
  });

  it('refuses a trace with no handle', async () => {
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/analytics/trace`);
    expect(response.status).toBe(400);
  });

  it('refuses an experiment whose treatment kind is outside the vocabulary', async () => {
    // Experimentation rules 3, 5 and 9 at the request boundary. Run as the
    // ALLOW-LISTED operator, so a 400 can only be the validation — a 403 would
    // prove nothing.
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/analytics/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        experimentKey: 'hide-guest-option',
        treatmentKind: 'hide_guest_option',
        hypothesis: 'forcing an account lifts sign-ups',
        primaryMetricKey: 'native_checkout_conversion',
        guardrailMetricKeys: ['zero_result_rate'],
        stopConditions: ['error_rate_regression'],
        assignmentUnit: 'pseudonymous_session',
        variants: ['control', 'treatment'],
        trafficAllocationBps: 5_000,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toMatch(/treatmentKind/);
  });

  it('refuses an experiment with no guardrail', async () => {
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${enabledUrl}/internal/analytics/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        experimentKey: 'result-density',
        treatmentKind: 'result_presentation',
        hypothesis: 'a denser grid lifts click-through',
        primaryMetricKey: 'search_to_product_click_rate',
        guardrailMetricKeys: [],
        stopConditions: ['error_rate_regression'],
        assignmentUnit: 'pseudonymous_session',
        variants: ['control', 'treatment'],
        trafficAllocationBps: 5_000,
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('the /analytics client ingest endpoint', () => {
  it('accepts a client-emittable event and answers 202', async () => {
    // 202, never 201: the events were accepted into a bounded queue that may
    // drop them, and telling a client they were stored would be the
    // overstatement `POST /reports` refuses one domain over.
    const response = await fetch(`${enabledUrl}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ eventType: 'search_result_impression', measures: { position: 3 } }],
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { data: { accepted: number; rejected: number } };
    expect(body.data).toEqual({ accepted: 1, rejected: 0 });
  });

  it('REJECTS every event type a server owns — acceptance 3', async () => {
    // The whole of "native paid orders and network-reported affiliate
    // conversions cannot be forged by client analytics", at the boundary.
    const response = await fetch(`${enabledUrl}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { eventType: 'guest_payment_verified' },
          { eventType: 'checkout_started' },
          { eventType: 'guest_session_issued' },
          { eventType: 'guest_cart_merged' },
          { eventType: 'guest_claim_completed' },
          { eventType: 'native_add_to_cart' },
        ],
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { data: { accepted: number; rejected: number } };
    // Counted, not fatal: one bad entry must not discard the good ones beside
    // it, and a client sending a server-only type sees a non-zero `rejected`.
    expect(body.data).toEqual({ accepted: 0, rejected: 6 });
  });

  it('accepts the good entries in a mixed batch', async () => {
    const response = await fetch(`${enabledUrl}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { eventType: 'product_page_view' },
          { eventType: 'guest_payment_verified' },
          { eventType: 'offer_impression' },
        ],
      }),
    });
    const body = (await response.json()) as { data: { accepted: number; rejected: number } };
    expect(body.data).toEqual({ accepted: 2, rejected: 1 });
  });

  it('refuses an over-large batch', async () => {
    const response = await fetch(`${enabledUrl}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: Array.from({ length: 51 }, () => ({ eventType: 'product_page_view' })),
      }),
    });
    expect(response.status).toBe(400);
  });

  it('is mounted even on a deployment with no operators', async () => {
    // The ingest endpoint is NOT gated on the operator list — collecting and
    // reading are different powers, and a storefront must not stop working
    // because nobody was allow-listed to read a dashboard.
    const response = await fetch(`${disabledUrl}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ eventType: 'product_page_view' }] }),
    });
    expect(response.status).toBe(202);
  });
});
