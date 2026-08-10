/**
 * `CANONICAL_SEARCH` — #70's rollback lever, and acceptance 8 ("rollback to the
 * previous read path remains possible during launch") as a measurement.
 *
 * Three module graphs, one per lever value, because `config/index.ts` reads
 * `process.env` once at import: a test that mutated the value after loading the
 * app would assert against a config nobody serves. The
 * `internal-offers.test.ts` device — `vi.resetModules()` per app.
 *
 * ## A REAL database, because `shadow` is the case worth testing
 *
 * `off` could be asserted against a stub. `shadow` cannot: its whole behaviour
 * is to COMPUTE the canonical answer and the listing-first one, record the
 * comparison, and serve neither — so a stubbed database would make the case
 * indistinguishable from `off`, which is exactly the confusion the mode exists
 * to avoid. The one property that matters here is that a shopper sees the same
 * 404 either way while the counters move only in `shadow`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { CanonicalReadMode } from '@mercaria/shared-types';

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
  readonly readShadow: () => { queries: number };
  readonly close: () => Promise<void>;
}

const deployments = new Map<CanonicalReadMode, Deployment>();

/**
 * Build one deployment at one lever value, with its own module graph and its
 * own Postgres connection.
 */
async function build(mode: CanonicalReadMode): Promise<Deployment> {
  vi.resetModules();
  process.env.CANONICAL_SEARCH = mode;

  const pg = await import('../../db/postgres.js');
  // The `off` deployment never reaches the database — its handler answers 404
  // before the service is called — so it opens no pool. Three module graphs
  // each holding a connection pool on a database every parallel test file
  // shares is a real cost, and this one is avoidable.
  if (mode !== 'off') await pg.connectPostgres();
  const { default: searchRouter } = await import('../search.js');
  const shadow = await import('../../services/search/shadow.js');

  const app = express();
  app.use('/search', searchRouter);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => {
      resolve(started);
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    server,
    readShadow: () => shadow.readShadowComparisons(),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (mode !== 'off') await pg.closePostgres();
    },
  };
}

beforeAll(async () => {
  for (const mode of ['off', 'shadow', 'on'] as const) {
    deployments.set(mode, await build(mode));
  }
}, 180_000);

afterAll(async () => {
  delete process.env.CANONICAL_SEARCH;
  for (const deployment of deployments.values()) await deployment.close();
});

function deployment(mode: CanonicalReadMode): Deployment {
  const found = deployments.get(mode);
  if (!found) throw new Error(`no deployment for ${mode}`);
  return found;
}

describe('the CANONICAL_SEARCH lever', () => {
  it('answers 404 with the lever OFF — the rollback, in one variable', async () => {
    // A 404 rather than a 403: a shopper reaching a surface this deployment has
    // not rolled out is looking at a page that does not exist here, and a 403
    // would advertise one they cannot reach.
    const response = await fetch(`${deployment('off').url}/search?q=anything`);
    expect(response.status).toBe(404);
  });

  it('answers 404 in SHADOW too, and records the comparison behind it', async () => {
    const target = deployment('shadow');
    const before = target.readShadow().queries;
    const response = await fetch(`${target.url}/search?q=shadowprobe`);
    expect(response.status).toBe(404);
    // The difference `off` cannot produce: both answers were computed and
    // compared while the shopper saw nothing. ADR 0002 D24 phase 3.
    expect(target.readShadow().queries).toBe(before + 1);
  });

  it('does NOT record a comparison with the lever off', async () => {
    // The positive control for the assertion above: without it, a counter that
    // had stopped incrementing entirely would satisfy neither test's intent
    // while failing only one of them.
    const target = deployment('off');
    const before = target.readShadow().queries;
    await fetch(`${target.url}/search?q=offprobe`);
    expect(target.readShadow().queries).toBe(before);
  });

  it('serves the canonical answer with the lever ON', async () => {
    const response = await fetch(`${deployment('on').url}/search?q=nothingmatchesthisterm`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { results: unknown[]; truncated: boolean; policyVersion: string };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.results)).toBe(true);
    expect(body.data.policyVersion).toBe('sr-1');
    expect(body.data.truncated).toBe(false);
  });

  it('refuses a query the schema does not admit, whatever the lever says', async () => {
    // `.strict()` doing its job: a request able to name a ranking weight is the
    // shape a caller-controlled ordering would arrive in.
    const response = await fetch(`${deployment('on').url}/search?q=phone&boost=merchant-1`);
    expect(response.status).toBe(400);
  });

  it('requires a term — a canonical search with no query is a browse', async () => {
    const response = await fetch(`${deployment('on').url}/search`);
    expect(response.status).toBe(400);
  });
});
