/**
 * Who may reach `/internal/discovery/*` — the operator trigger for the
 * discovery sweep.
 *
 * `internal-analytics.test.ts`'s gate properties, applied to a surface that
 * joins that SAME `analytics.operate` key rather than creating its own:
 *
 *  - an authenticated Oxy user holding no key gets 404, not a sweep — never a
 *    401 or 403 that would advertise the surface exists;
 *  - a holder of `analytics.operate` gets a sweep run;
 *  - holding `payments.operate` does not open it either — a different power,
 *    and the case a refactor toward "any operator" would silently break.
 *
 * A REAL database, unlike `internal-analytics.test.ts`: that file stubs
 * `db/postgres.js` because every case it asserts is decided before a query
 * runs, but `runDiscoverySweepOnce` genuinely writes `discovery_signals`, and
 * a stubbed pool would only prove the 200 never reached the handler.
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
import type { Database } from '../../db/postgres.js';
import {
  acquireDiscoverySignalsSlot,
  type DiscoverySignalsSlot,
} from '../../db/__tests__/discovery-signals-slot.js';

const ANALYTICS_OPERATOR = 'oxy-user-discovery-sweep-operator';
const PAYMENTS_OPERATOR = 'oxy-user-discovery-sweep-payments-operator';
const ORDINARY_USER = 'oxy-user-discovery-sweep-ordinary';

/** Whichever caller the current request is acting as. */
let currentUser = ANALYTICS_OPERATOR;
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [ANALYTICS_OPERATOR]: ['analytics.operate'],
  [PAYMENTS_OPERATOR]: ['payments.operate'],
};

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

interface Deployment {
  readonly url: string;
  readonly server: Server;
  /** The pool this deployment opened — the slot needs a handle. */
  readonly db: Database;
  readonly closeServer: () => Promise<void>;
  /**
   * Ends this deployment's pool.
   *
   * Separate from `closeServer` because the slot is held on a connection
   * reserved out of THIS pool: the release has to run after the servers stop
   * and before the pool ends, which one combined `close()` cannot express.
   */
  readonly closePostgres: () => Promise<void>;
}

let enabled: Deployment;
let slot: DiscoverySignalsSlot | undefined;

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

/** Build the deployment with its own frozen config and its own module graph. */
async function build(): Promise<Deployment> {
  vi.resetModules();
  process.env.STRIPE_ENABLED = 'false';

  const graph = await import('../../db/postgres.js');
  const db = await graph.connectPostgres();
  const { createApp } = await import('../../app.js');
  const { server, url } = await listen(createApp());

  return {
    url,
    server,
    db,
    closeServer: () => new Promise<void>((resolve) => server.close(() => resolve())),
    closePostgres: () => graph.closePostgres(),
  };
}

beforeAll(async () => {
  // The surface actually writes to Postgres, so this graph keeps its pool.
  enabled = await build();
  // The sweep this file forces REPLACES the whole `discovery_signals` window,
  // so for as long as it may run one, that table is exclusively ours — see
  // `db/__tests__/discovery-signals-slot.ts` for what collides.
  slot = await acquireDiscoverySignalsSlot(enabled.db);
}, 120_000);

afterAll(async () => {
  // The WHOLE teardown sits inside the region that ends the pool: the slot is
  // held on a connection reserved out of `enabled`'s, and returning that
  // connection does NOT end the hold (#272) — so anything that throws above
  // the release, the release included, must still reach `closePostgres`.
  // `db/__tests__/slot-teardown-census.test.ts` fails the build otherwise.
  try {
    delete process.env.STRIPE_ENABLED;
    await enabled.closeServer();
    if (slot) await slot.release();
  } finally {
    await enabled.closePostgres();
  }
});

describe('the /internal/discovery operator gate', () => {
  it('hides the surface from an authenticated caller holding no key — 404, never 401', async () => {
    // A 401 or 403 would tell the caller that an operator surface exists here.
    currentUser = ORDINARY_USER;
    const response = await fetch(`${enabled.url}/internal/discovery/sweep`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('refuses a holder of payments.operate — separate keys, separate powers', async () => {
    // The cross-desk case a refactor toward "any operator may sweep" would
    // silently break: this surface joined the ANALYTICS key specifically,
    // not an operator role in general.
    currentUser = PAYMENTS_OPERATOR;
    const response = await fetch(`${enabled.url}/internal/discovery/sweep`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('runs a sweep for a holder of analytics.operate', async () => {
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
