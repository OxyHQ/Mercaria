/**
 * The referral PARTNER surface is actually MOUNTED and serves exactly the
 * routes it claims (#146 increment 2).
 *
 * ## Why this file exists at all
 *
 * Increment 2's headline claim is that ADR 0005 D15 gate 2 finally reaches a
 * caller. Every other test in this increment exercises the SERVICE — the realdb
 * suite drives `declareTaxProfile` directly, and the isolation gate reads the
 * route files as text. Neither can tell a mounted router from an unmounted one,
 * and "a mechanism can be GREEN AND INERT at once" is exactly the failure this
 * increment exists to undo: increment 1's `declareTaxProfile` was complete,
 * correct, fully tested and reachable by nobody.
 *
 * ## Two halves, because ONE of them cannot prove what it looks like it proves
 *
 * The first version of this file sent unauthenticated requests to each path and
 * read a 401 as "this route exists". **It does not**, and the vacuity control
 * caught it: `authenticateToken` is mounted at the ROUTER level, so it answers
 * 401 for every path under `/referral-partner` including
 * `/referral-partner/there-is-no-such-route`. Getting past it to discriminate
 * per route would need a real Oxy credential.
 *
 * So the claim is split into the two things that ARE checkable:
 *
 *  1. **Reachability** — an unauthenticated request to each PREFIX is refused by
 *     auth rather than 404ing, which is positive evidence the router is mounted
 *     in the real `createApp()` chain. The vacuity control sits OUTSIDE every
 *     prefix, so a 404 there proves the 401s are not what this app answers to
 *     everything.
 *  2. **The route set** — built from the router's OWN Express stack rather than
 *     from source text, asserted as an EXACT set of method/path pairs. That is
 *     what makes the docblock's "nine routes and no tenth" checkable, and it is
 *     what catches a typo'd path that the reachability half cannot see.
 *
 * Composed: the router is mounted at both prefixes, and the router declares
 * these nine routes, so those eighteen paths are served.
 */

import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import type express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { config } from '../../config/index.js';
import { makeReferralPartnerRouter } from '../../controllers/referral-partner.controller.js';

const servers: Server[] = [];
let base: string;

/**
 * A real ephemeral listener plus `fetch`, matching
 * `stripe-webhook.integration.test.ts`.
 *
 * Deliberately not `supertest`, which this repository does not depend on: a
 * mount assertion is the case where the request should travel the real socket
 * and the real chain rather than an in-process shim's idea of one.
 */
function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

beforeAll(async () => {
  base = await listen(createApp());
}, 60_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function get(path: string): Promise<number> {
  return (await fetch(`${base}${path}`)).status;
}

const STORE = '/admin/stores/01a00000-0000-7000-8000-000000000000/referral-partner';

describe('the partner surface is reachable in the real app', () => {
  it('is enabled by default, which is the premise of everything below', () => {
    // Stated rather than assumed: with the lever off these routers are
    // correctly absent and every assertion here would be measuring that.
    expect(config.referrals.partnerEnrollmentEnabled).toBe(true);
  });

  it('mounts the individual half at /referral-partner', async () => {
    const status = await get('/referral-partner');
    expect(status, '/referral-partner 404d — the router is not mounted').not.toBe(404);
    // And the refusal is AUTH's, not a handler that ran anonymously: a 200 here
    // would be a worse failure than not being mounted.
    expect([401, 403]).toContain(status);
  });

  it('mounts the store half under /admin/stores/:storeId/referral-partner', async () => {
    const status = await get(STORE);
    expect(status, `${STORE} 404d — the router is not mounted`).not.toBe(404);
    expect([401, 403]).toContain(status);
  });

  /**
   * The VACUITY CONTROL, and it must sit OUTSIDE every prefix.
   *
   * Inside one, router-level `authenticateToken` answers 401 before Express can
   * fall through to the app's 404 — which is precisely what this control caught
   * the first time it ran. A path under no router at all is what shows the app
   * really does 404 things it does not serve.
   */
  it('a path under no router still 404s', async () => {
    expect(await get('/referral-partner-not-a-real-prefix')).toBe(404);
  });

  /**
   * The operator review surface is NOT mounted with an empty allow-list —
   * itself the documented behaviour (empty ⇒ 404, never 401), and worth pinning
   * so an unpopulated list cannot accidentally expose the review path.
   */
  it('does not mount the operator review surface with an empty allow-list', async () => {
    expect(config.referrals.operatorSurfaceEnabled).toBe(false);
    expect(await get('/internal/referrals/partners')).toBe(404);
  });
});

/**
 * The route SET, read off the router's own Express stack.
 *
 * Not from source text — a regex over the file would keep passing if the router
 * were assembled differently, and would need its own vacuity floor. This is the
 * object the app actually mounts.
 */
describe('the partner router serves exactly nine routes', () => {
  function declaredRoutes(): readonly string[] {
    const router = makeReferralPartnerRouter(() => ({ ownerType: 'user', ownerId: 'x' }));
    const stack = (router as unknown as { stack: readonly Record<string, unknown>[] }).stack;
    const routes: string[] = [];
    for (const layer of stack) {
      const route = layer.route as { path?: string; methods?: Record<string, boolean> } | undefined;
      if (!route?.path) continue;
      for (const [method, on] of Object.entries(route.methods ?? {})) {
        if (on) routes.push(`${method.toUpperCase()} ${route.path}`);
      }
    }
    return routes.sort();
  }

  it('declares the nine, and no tenth', () => {
    expect(declaredRoutes()).toEqual(
      [
        'GET /',
        'POST /application',
        'POST /application/submit',
        'POST /application/withdraw',
        'POST /terms',
        'POST /marketing-consent',
        'GET /tax-profile',
        // ADR 0005 D15 gate 2. The route the whole increment turns on: until it
        // existed, tax readiness was `pending` for every partner and
        // `deriveRewardPayability` blocked every batch.
        'POST /tax-profile',
        'POST /appeal',
      ].sort(),
    );
  });

  /**
   * The floor, and it is not redundant beside an exact set.
   *
   * A stack walk that found NOTHING would make `toEqual([])` the assertion —
   * and if somebody later relaxed the expected list to match, an empty router
   * would pass. Asserting the count separately means the walk has to have seen
   * something for either assertion to mean anything.
   */
  it('the stack walk actually found routes', () => {
    expect(declaredRoutes().length).toBe(9);
  });
});
