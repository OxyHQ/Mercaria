/**
 * The proposal surface's rate limit (#630).
 *
 * `/catalog-proposals` mounts `makeRateLimiter('admin')`
 * (`routes/catalog-proposals.ts:61`) and, before this file, nothing asserted it.
 * The repository's only 429 assertion was
 * `catalog-api-contract.realdb.test.ts`'s, whose own title says it covers the
 * catalogue bucket — **a test that covers the same mechanism somewhere else
 * reads exactly like a test that covers it here**, so a reader checking whether
 * the proposal surface is limited found a passing 429 and stopped.
 *
 * ## Why this is TWO tests and not one 429
 *
 * The obvious test — hammer `/catalog-proposals` until it 429s — cannot
 * attribute its own result, and that is measured rather than feared (#784).
 * `app.ts:240` mounts `makeRateLimiter('general')` above every route, and the
 * `admin` scope passes no budget override, so both take
 * `createOxyRateLimit`'s anonymous default of 600. The global limiter is reached
 * first on every request and counts traffic from every router, so it is spent
 * first — the 429 such a test observes is `general`'s.
 *
 * MEASURED while writing this file: after exhausting `/catalog-proposals`, a
 * request to `/taxonomy/categories/not-an-id` — a different router on a
 * different scope — also answered 429, and the pre-existing catalogue case then
 * hit 429 on its FIRST attempt and failed its own `attempts > 100` floor.
 *
 * So the property is split into the two halves that ARE provable, because
 * either alone would be dishonest:
 *
 * 1. **The wiring** — the limiter is mounted on this router, with the `admin`
 *    scope, ABOVE `authenticateToken`. A source census, because the router
 *    builds its limiter at import time and there is no seam to substitute a
 *    budget through; what a runtime probe could show is that SOMETHING refused,
 *    never which scope.
 * 2. **The mechanism** — a limiter built from the same factory refuses at its
 *    boundary, and a different scope's counter is untouched. In isolation, where
 *    the global mount cannot mask it.
 *
 * Together they say: this factory limits, and this router is wired to it. What
 * neither says is that the `admin` bucket is ever the one that refuses in the
 * assembled app — it is not, and that is #784 rather than something to assert.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRateLimiter } from '../../lib/rate-limit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_SOURCE = join(HERE, '..', 'catalog-proposals.ts');

describe('the proposal router is WIRED to a rate limiter', () => {
  const source = readFileSync(ROUTER_SOURCE, 'utf8');

  /**
   * The `router.use(...)` line that mounts the surface-wide middleware.
   *
   * Matched as a whole rather than by two independent `toContain` checks: the
   * ORDER is the property. A limiter mounted after `authenticateToken` would
   * still be present in the file and would no longer bound an unauthenticated
   * flood, which is the traffic an abuse limit on a submission surface is for.
   */
  const MOUNT = /router\.use\(\s*makeRateLimiter\('admin'\)\s*,\s*authenticateToken\s*\)/u;

  it('mounts makeRateLimiter with the admin scope ABOVE authenticateToken', () => {
    expect(MOUNT.test(source)).toBe(true);
  });

  it('VACUITY CONTROL — the file was read and the pattern can miss', () => {
    // Without the first line, a pattern that silently matched nothing (a moved
    // file, an empty read) would make the case above pass by measuring no text.
    expect(source.length).toBeGreaterThan(500);
    // A handler this router really mounts. Chosen over the router's own binding
    // because it is `export default router` — which this control asserted by
    // guess on its first run, and the guess is what the control caught.
    expect(source).toContain('submitCatalogProposalHandler');
    // The mutation self-test: the SAME pattern against the reversed order must
    // NOT match, or it is asserting presence rather than order.
    expect(MOUNT.test(`router.use(authenticateToken, makeRateLimiter('admin'))`)).toBe(false);
    // ...and against a different scope, or it is asserting a limiter rather
    // than THIS bucket.
    expect(MOUNT.test(`router.use(makeRateLimiter('listings'), authenticateToken)`)).toBe(false);
  });
});

describe('the limiter this router is wired to actually limits', () => {
  /**
   * Two limiters from the same factory, on a bare app, with a budget small
   * enough to reach. No `authenticateToken` and no database: the subject is the
   * bucket, and anything else in the chain could refuse for its own reasons.
   */
  const BUDGET = 3;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(
      '/admin-scope',
      makeRateLimiter('admin', { anonymousMax: BUDGET, windowMs: 60_000 }),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    // A DIFFERENT scope, its own counter, deliberately generous. If exhausting
    // the first also refused this, the two would be sharing a bucket.
    app.use(
      '/other-scope',
      makeRateLimiter('listings', { anonymousMax: 100, windowMs: 60_000 }),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('admits up to the budget and refuses the request after it', async () => {
    // The control comes FIRST and is the half that matters: a limiter refusing
    // everything from request one would satisfy the 429 assertion below while
    // being catastrophically wrong, and this is what tells them apart.
    for (let index = 1; index <= BUDGET; index += 1) {
      const answer = await fetch(`${base}/admin-scope`);
      expect(answer.status, `request ${String(index)} of the budget was refused`).toBe(200);
    }

    const overBudget = await fetch(`${base}/admin-scope`);
    expect(overBudget.status, 'the request past the budget was admitted').toBe(429);
  });

  it('leaves a DIFFERENT scope’s counter untouched', async () => {
    // Runs after the case above has spent the admin budget. Without this, a
    // single process-wide counter would pass every assertion there.
    const other = await fetch(`${base}/other-scope`);
    expect(other.status, 'exhausting one scope refused another').toBe(200);
  });
});
