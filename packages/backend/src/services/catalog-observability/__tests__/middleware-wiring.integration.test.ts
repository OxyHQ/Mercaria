/**
 * The catalog observability middleware is actually WIRED (#367 W16/W17).
 *
 * ## Why this file exists, and why the rest of the suite does not cover it
 *
 * Everything else here tests a mechanism: the store classifies statuses
 * correctly, the reservoir evicts, the budgets name real routes, the collector
 * turns observations into readings. Every one of those passes with
 * `app.use(catalogObservability)` deleted from `app.ts`, because none of them
 * goes through the app. That is the "a mechanism can be GREEN AND INERT" trap in
 * its exact form, and the remedy is the one this repository already names: assert
 * the ENTRYPOINT calls it.
 *
 * It is not a hypothetical. Mounting this middleware is order-sensitive in two
 * independent ways — after the routers it observes only the traffic that matched
 * no route, and after a handler has replied `res.setHeader` throws — so the
 * mount is exactly the kind of line that gets moved by somebody tidying imports,
 * with every other test in this directory still green.
 *
 * ## It drives the REAL app
 *
 * `createApp()` builds the production middleware chain, the server listens on an
 * ephemeral port, and the requests are real HTTP. Nothing is stubbed: if the
 * mount is removed, or moved below the routers, or the template set stops
 * matching the mounted routes, this file goes red and the message says which.
 *
 * ## What it deliberately does NOT assert
 *
 * Not the latency VALUE — a p95 over one local request is a number about this
 * machine. What matters is that an observation exists at all, that it is filed
 * under the right template, and that the status landed in the right dimension.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type express from 'express';
import { CATALOG_LATENCY_BUDGETS } from '@mercaria/shared-types';
import {
  CATALOG_OBSERVED_ROUTES,
  readRouteObservation,
  resetCatalogRouteObservations,
} from '../route-observations.js';

/** The header the middleware stamps, so a client can quote it in a bug report. */
const CORRELATION_HEADER = 'x-mercaria-correlation-id';

/**
 * A budgeted GET that needs no authentication, no database row and no fixture.
 *
 * The category tree: it is in `CATALOG_LATENCY_BUDGETS`, it is mounted publicly,
 * and whether it answers 200 or 500 is irrelevant here — an observation is filed
 * either way, which is the point. Picking a budgeted route rather than inventing
 * a probe route is what ties this file to the real closed set.
 */
const OBSERVED_PATH = '/categories';
const OBSERVED_TEMPLATE = '/categories';

const servers: Server[] = [];
let createApp: typeof import('../../../app.js').createApp;
let closePostgres: typeof import('../../../db/postgres.js').closePostgres;

beforeAll(async () => {
  // Imported inside `beforeAll` for the reason `stripe-webhook.integration.test.ts`
  // states: `config/index.ts` freezes `process.env` at module load and `app.ts`
  // decides its mounts from that frozen value.
  ({ createApp } = await import('../../../app.js'));
  const postgres = await import('../../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  await postgres.connectPostgres();
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await closePostgres();
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

describe('#367 W16/W17 — the observability middleware is mounted in the real app', () => {
  it('the route this file drives is one the budgets actually name', () => {
    // The floor. Without it, a renamed budget would leave every assertion below
    // measuring the refusal path while reading like the happy path.
    const key = `GET ${OBSERVED_TEMPLATE}`;
    expect(
      CATALOG_OBSERVED_ROUTES,
      `${key} is not in the closed observed set, so this file measures nothing`,
    ).toContain(key);
    expect(
      CATALOG_LATENCY_BUDGETS.some(
        (budget) => budget.method === 'GET' && budget.route === OBSERVED_TEMPLATE,
      ),
    ).toBe(true);
  });

  it('files an observation for a real request through the real chain', async () => {
    resetCatalogRouteObservations();

    // Nothing was observed before the request — so a stale bucket cannot be what
    // the assertion below reads.
    expect(readRouteObservation('GET', OBSERVED_TEMPLATE)).toBeUndefined();

    const base = await listen(createApp());
    const response = await fetch(`${base}${OBSERVED_PATH}`);

    // The correlation id reaches the client. This is the half that fails loudly
    // if the middleware is mounted below the routers: `res.setHeader` would have
    // thrown after the handler replied.
    const correlationId = response.headers.get(CORRELATION_HEADER);
    expect(correlationId, 'no correlation header — is the middleware mounted above the routers?')
      .toBeTruthy();

    const observed = readRouteObservation('GET', OBSERVED_TEMPLATE);
    expect(
      observed,
      'the real app served a budgeted route and filed no observation — '
        + 'is `app.use(catalogObservability)` still mounted, and above the routers?',
    ).toBeDefined();
    expect(observed?.requests).toBe(1);

    // The status landed in exactly one dimension, whichever it was. A request
    // counted in two, or in none when it failed, is how the error rate and the
    // cache-hit rate drift apart.
    const flagged =
      (observed?.serverErrors ?? 0) + (observed?.clientErrors ?? 0) + (observed?.notModified ?? 0);
    expect(flagged).toBe(response.status >= 400 || response.status === 304 ? 1 : 0);

    // A latency sample exists. The VALUE is deliberately not asserted.
    expect(observed?.latency?.observations).toBe(1);

    process.stdout.write(
      `[wiring] GET ${OBSERVED_PATH} -> ${String(response.status)}, `
        + `observed under '${OBSERVED_TEMPLATE}' with `
        + `${String(observed?.latency?.observations ?? 0)} latency sample(s), `
        + `correlation id ${correlationId === null ? 'absent' : 'present'}\n`,
    );
  }, 60_000);

  it('mints a DIFFERENT correlation id per request', async () => {
    // One id reused across requests would make every log line in a busy task
    // correlate to the same "request", which is worse than having no id: it reads
    // as a trace and is not one.
    const base = await listen(createApp());
    const [first, second] = await Promise.all([
      fetch(`${base}${OBSERVED_PATH}`),
      fetch(`${base}${OBSERVED_PATH}`),
    ]);
    const a = first.headers.get(CORRELATION_HEADER);
    const b = second.headers.get(CORRELATION_HEADER);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  }, 60_000);

  it('files NOTHING for a path no budget names', async () => {
    resetCatalogRouteObservations();
    const base = await listen(createApp());
    // A path that certainly matches no observed template. It still gets a
    // correlation id — that is per request, not per budgeted route.
    const response = await fetch(`${base}/__definitely-not-a-catalog-route`);
    expect(response.headers.get(CORRELATION_HEADER)).toBeTruthy();

    for (const key of CATALOG_OBSERVED_ROUTES) {
      const separator = key.indexOf(' ');
      const observed = readRouteObservation(key.slice(0, separator), key.slice(separator + 1));
      expect(observed, `${key} recorded traffic it never served`).toBeUndefined();
    }
  }, 60_000);
});
