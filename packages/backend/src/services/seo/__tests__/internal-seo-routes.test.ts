/**
 * The SEO operator surface is READ-ONLY and its route set is CLOSED (#75).
 *
 * The gate `ranking-operator` established: enumerate the routes the router
 * ACTUALLY registered and compare against the expected set EXACTLY. A
 * `toContain` per expected route would pass while a fourth route nobody
 * reviewed sat beside them, and the fourth route is the one that matters —
 * "index this anyway", "set this page's robots directive", "add this URL to the
 * sitemap" are all one handler away, and each would be a second authority over
 * what `decideIndexability` already decides.
 *
 * It also asserts the two middlewares are mounted in the right ORDER: an
 * allow-list consulted before authentication compares against whatever a client
 * claimed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import internalSeoRouter from '../../../routes/internal-seo.js';
import seoRouter from '../../../routes/seo.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every `<METHOD> <path>` the router registered, as express holds them. */
function registeredRoutes(router: { stack: unknown[] }): string[] {
  const found: string[] = [];
  for (const layer of router.stack) {
    const entry = layer as { route?: { path?: string; methods?: Record<string, boolean> } };
    const route = entry.route;
    if (!route || typeof route.path !== 'string') continue;
    for (const [method, enabled] of Object.entries(route.methods ?? {})) {
      if (enabled) found.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return found.sort();
}

describe('the operator surface is a CLOSED set of reads', () => {
  it('registers exactly three routes, all GET', () => {
    expect(registeredRoutes(internalSeoRouter as unknown as { stack: unknown[] })).toEqual([
      'GET /diagnose',
      'GET /routes',
      'GET /sitemaps/:collection/:page',
    ]);
  });

  it('registers no route that could change what is indexed', () => {
    // Named individually rather than left to the exact-set assertion above,
    // because these are the four somebody will actually reach for.
    const routes = registeredRoutes(internalSeoRouter as unknown as { stack: unknown[] });
    for (const forbidden of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(routes.some((route) => route.startsWith(forbidden)), forbidden).toBe(false);
    }
  });

  it('authenticates BEFORE it checks the allow-list', () => {
    const source = readFileSync(join(SRC_ROOT, 'routes/internal-seo.ts'), 'utf8');
    const authenticate = source.indexOf('router.use(authenticateToken)');
    const operator = source.indexOf('router.use(requireCatalogOperator)');
    expect(authenticate, 'authenticateToken is not mounted').toBeGreaterThan(-1);
    expect(operator, 'requireCatalogOperator is not mounted').toBeGreaterThan(-1);
    expect(authenticate).toBeLessThan(operator);
  });

  it('is on the catalogue allow-list, not a seventh one', () => {
    const source = readFileSync(join(SRC_ROOT, 'routes/internal-seo.ts'), 'utf8');
    expect(source).toContain('requireCatalogOperator');
    // A `SEO_OPERATOR_OXY_USER_IDS` would be a seventh list for a power the
    // catalogue list already holds.
    expect(source).not.toContain('SEO_OPERATOR');
  });
});

describe('the PUBLIC surface is a closed set too', () => {
  it('registers exactly four reads and no write', () => {
    expect(registeredRoutes(seoRouter as unknown as { stack: unknown[] })).toEqual([
      'GET /resolve',
      'GET /robots.txt',
      'GET /sitemap.xml',
      'GET /sitemaps/:collection/:file',
    ]);
  });
});

describe('the comments name routes that EXIST', () => {
  /**
   * The failure this file was added for.
   *
   * `indexability.ts` and `seo.controller.ts` both said the reason was served
   * from `/internal/seo` while no such router existed and nothing read the
   * value. Nothing recomputes a comment, so the claim would have survived
   * indefinitely — this asserts the router the prose promises is the router the
   * app mounts.
   */
  it('every module claiming `/internal/seo` is backed by a mounted router', () => {
    const claimants = ['services/seo/indexability.ts', 'controllers/seo.controller.ts'];
    let claimed = 0;
    for (const relative of claimants) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      if (!source.includes('/internal/seo')) continue;
      claimed += 1;
    }
    // Vacuity floor: if nobody claims it, this test measures nothing and the
    // claimant list has rotted.
    expect(claimed, 'no module claims /internal/seo — has the list gone stale?').toBeGreaterThan(0);

    const app = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
    expect(app).toContain("app.use('/internal/seo', internalSeoRouter)");
    expect(
      registeredRoutes(internalSeoRouter as unknown as { stack: unknown[] }).length,
    ).toBeGreaterThan(0);
  });
});
