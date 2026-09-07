/**
 * Who may reach `/internal/discovery/*` — the operator trigger for the
 * discovery sweep.
 *
 * `internal-analytics.test.ts`'s three mount/gate properties, applied to a
 * surface that joins that SAME allow-list rather than creating its own:
 *
 *  - a deployment with an EMPTY allow-list has no such surface at all — 404,
 *    from the MOUNT, never a 401 that would advertise it exists;
 *  - an authenticated Oxy user who is NOT allow-listed gets 403, not a sweep;
 *  - an allow-listed operator gets a sweep run;
 *  - the PAYMENTS allow-list does not open it either — a different power,
 *    and the case a refactor toward "any operator" would silently break.
 *
 * A REAL database, unlike `internal-analytics.test.ts`: that file stubs
 * `db/postgres.js` because every case it asserts is decided before a query
 * runs, but `runDiscoverySweepOnce` genuinely writes `discovery_signals`, and
 * a stubbed pool would only prove the 200 never reached the handler. The
 * `catalog-rollout.realdb.test.ts` device — two module graphs behind
 * `vi.resetModules()`, one with a connection and one without, because the
 * deployment whose every request 404s at the mount never needs one.
 *
 * The identity layer is mocked, `catalog-rollout.realdb.test.ts`'s own
 * device: there is no way to hand this process a real Oxy session token, and
 * every case here turns on WHICH verified caller reached the gate, never on
 * how that verification happened.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const ANALYTICS_OPERATOR = 'oxy-user-discovery-sweep-operator';
const PAYMENTS_OPERATOR = 'oxy-user-discovery-sweep-payments-operator';
const ORDINARY_USER = 'oxy-user-discovery-sweep-ordinary';

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

interface Deployment {
  readonly url: string;
  readonly server: Server;
  readonly close: () => Promise<void>;
}

let enabled: Deployment;
let disabled: Deployment;

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      });
    });
  });
}

/** Build one deployment with its own frozen config and its own module graph. */
async function build(options: {
  readonly operators: string;
  readonly withDatabase: boolean;
}): Promise<Deployment> {
  vi.resetModules();
  process.env.ANALYTICS_OPERATOR_OXY_USER_IDS = options.operators;
  process.env.PAYMENT_OPERATOR_OXY_USER_IDS = PAYMENTS_OPERATOR;
  process.env.STRIPE_ENABLED = 'false';

  const graph = options.withDatabase ? await import('../../db/postgres.js') : null;
  if (graph) await graph.connectPostgres();
  const { createApp } = await import('../../app.js');
  const { server, url } = await listen(createApp());

  return {
    url,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (graph) await graph.closePostgres();
    },
  };
}

beforeAll(async () => {
  // The surface actually writes to Postgres, so this graph keeps its pool.
  enabled = await build({ operators: ANALYTICS_OPERATOR, withDatabase: true });
  // Every request here 404s at the mount before any query — no pool needed,
  // the `catalog-rollout.realdb.test.ts` / `search-rollout.realdb.test.ts`
  // reasoning for a database this suite shares with every other file.
  disabled = await build({ operators: '', withDatabase: false });
}, 60_000);

afterAll(async () => {
  delete process.env.ANALYTICS_OPERATOR_OXY_USER_IDS;
  delete process.env.PAYMENT_OPERATOR_OXY_USER_IDS;
  delete process.env.STRIPE_ENABLED;
  await Promise.all([enabled, disabled].map((deployment) => deployment.close()));
});

describe('the /internal/discovery operator gate', () => {
  it('is NOT MOUNTED when the allow-list is empty — 404, never 401', async () => {
    // A 401 would tell an unauthenticated caller that an operator surface
    // exists on this deployment; the whole allow-list design turns on this
    // distinction.
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${disabled.url}/internal/discovery/sweep`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('refuses an authenticated caller who is not on the list', async () => {
    currentUser = ORDINARY_USER;
    const response = await fetch(`${enabled.url}/internal/discovery/sweep`, { method: 'POST' });
    expect(response.status).toBe(403);
  });

  it('refuses the PAYMENTS operator — separate lists, separate powers', async () => {
    // The cross-list case a refactor toward "any operator may sweep" would
    // silently break: this surface joined the ANALYTICS list specifically,
    // not an operator role in general.
    currentUser = PAYMENTS_OPERATOR;
    const response = await fetch(`${enabled.url}/internal/discovery/sweep`, { method: 'POST' });
    expect(response.status).toBe(403);
  });

  it('runs a sweep for a caller on the list', async () => {
    currentUser = ANALYTICS_OPERATOR;
    const response = await fetch(`${enabled.url}/internal/discovery/sweep`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { ran: boolean; rowsWritten?: number } };
    // Another task holding the lease is a NORMAL outcome on this shared test
    // database, not a failure of this gate — so both readings of `ran` are
    // accepted, and only the shape of whichever one came back is checked.
    if (body.data.ran) {
      expect(typeof body.data.rowsWritten).toBe('number');
    } else {
      expect(body.data).toEqual({ ran: false });
    }
  });
});
