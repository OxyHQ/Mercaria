/**
 * `CATALOG_ROLLOUT_COHORTS` as behaviour and as coverage — #367 Workstream 0
 * line 117 ("define feature flags by market, locale, store, category and product
 * type"), ADR 0007 D12.
 *
 * `services/catalog-rollout/__tests__/cohort.test.ts` measures the pure half. A
 * pure test cannot establish the thing the epic line actually asks for, which is
 * that each of the five dimensions is REACHABLE — that some real HTTP surface
 * states it and some real gate reads it. A vocabulary with no production caller
 * is a dead export cited as a mechanism, and this file is what stops this one
 * becoming that.
 *
 * ## Part 1: each dimension, end to end, through the real Express chain
 *
 * Per dimension, one deployment whose `CATALOG_ROLLOUT_COHORTS` names ONE value
 * of it, and two probes against a surface that states that dimension:
 *
 *   - the ADMITTED probe states the cohort's value and must NOT be refused;
 *   - the REFUSED probe states a DIFFERENT value of the SAME dimension and must
 *     be answered 404.
 *
 * The admitted probe deliberately carries a `bogus` field, so it passes the gate
 * and is then refused 400 by the route's own `.strict()` validator. That is what
 * makes the two answers DISTINGUISHABLE without a database: 404 is the gate, 400
 * is everything past it. A probe that expected 200 would need a fixture, and — as
 * `catalog-rollout.realdb.test.ts` records about `/product-types` — a handler
 * that legitimately 404s for a missing row is indistinguishable from a gate that
 * refused.
 *
 * ## The control is what makes the 404s mean anything
 *
 * A sixth deployment sets NO cohorts, and both probes must answer 400 there. Ask
 * what this file would report if the gate did not exist: without the control, a
 * route that had been deleted, unmounted or renamed would answer 404 to every
 * probe and every case here would pass. With it, "404 with a cohort, 400
 * without" is a difference only the cohort can produce.
 *
 * ## Part 2: the coverage census
 *
 * A gate on five surfaces is one route away from being a gate on four. The
 * census DERIVES the catalog mounts from `app.ts` — every `app.use` inside a
 * guard whose config namespace begins with `catalog` — and requires each to be
 * covered by the middleware, walking the routers' real Express stacks. A new
 * public catalog mount fails the build until it is gated or exempted by the
 * `/internal/` rule.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import type { CatalogRolloutDimension } from '@mercaria/shared-types';
import { CATALOG_ROLLOUT_DIMENSIONS } from '@mercaria/shared-types';
import { SRC_ROOT } from '../../__tests__/domain-population.js';
import { stripComments } from '../../__tests__/package-barrel-symbols.js';

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => 'oxy-user-catalog-cohort-probe',
}));
vi.mock('../../middleware/auth.js', () => ({
  /**
   * Authenticates AS the account the probe names, so `internal_user` has a
   * caller to be.
   *
   * The header is this mock's stand-in for a signed request: the real
   * `authenticateToken` sets `req.user` from a verified token, and the
   * `internal_user` dimension reads `req.user?.id`. Without it every probe is
   * anonymous and that dimension could only ever be refused — which would look
   * exactly like a working gate.
   *
   * It is a mock-local mechanism and reaches no production path: the real
   * middleware never reads this header, and `catalogRolloutSubjectFromRequest`
   * takes the id from `req.user` rather than from the request, which is the
   * property `internal_user is never taken from the request` pins.
   */
  authenticateToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const asUser = req.header('x-probe-oxy-user-id');
    if (asUser !== undefined && asUser !== '') {
      (req as express.Request & { user?: { id: string } }).user = { id: asUser };
    }
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

/** The four levers ADR 0007 D12 shipped, which every probe needs switched on. */
const LEVERS = [
  'CATALOG_AUTHORING_ENABLED',
  'CATALOG_PROPOSALS_ENABLED',
  'FACETS_ENABLED',
  'CATALOG_TAXONOMY_V2_ENABLED',
] as const;

/** One request. `value` is substituted into whichever place the surface states it. */
interface Probe {
  readonly method: 'GET' | 'POST';
  readonly path: (value: string) => string;
  readonly body?: (value: string) => unknown;
  /** Extra request headers, for a dimension the request body cannot state. */
  readonly headers?: (value: string) => Record<string, string>;
}

/**
 * How each dimension is stated by a real request, and on which surface.
 *
 * A `Record` over the dimension union, so a sixth dimension added to
 * `CATALOG_ROLLOUT_DIMENSIONS` fails `tsc` here until somebody says which
 * surface can state it — which is the "add a dimension with no wiring and the
 * gate goes red" direction, held by the compiler rather than by a runtime count.
 */
interface DimensionProbe {
  /** The surface, for the failure message. */
  readonly surface: string;
  /** The value the cohort names and the admitted probe states. */
  readonly inside: string;
  /** A different value of the same dimension. */
  readonly outside: string;
  readonly probe: Probe;
}

const PROBES: Record<CatalogRolloutDimension, DimensionProbe> = {
  market: {
    surface: 'GET /navigation',
    inside: 'PT',
    outside: 'ES',
    probe: {
      method: 'GET',
      path: (market) => `/navigation?market=${market}&locale=es&bogus=1`,
    },
  },
  locale: {
    surface: 'GET /navigation',
    inside: 'pt-pt',
    outside: 'es',
    probe: {
      method: 'GET',
      // The market is held constant at a value NO cohort in this case names, so
      // the only thing that can admit the request is the locale.
      path: (locale) => `/navigation?market=ES&locale=${locale}&bogus=1`,
    },
  },
  store: {
    surface: 'POST /catalog-proposals',
    inside: 'store-cohort-alpha',
    outside: 'store-cohort-beta',
    probe: {
      method: 'POST',
      path: () => '/catalog-proposals',
      body: (storeId) => ({ storeId, bogus: 1 }),
    },
  },
  category: {
    surface: 'POST /facets',
    inside: 'cat-cohort-alpha',
    outside: 'cat-cohort-beta',
    probe: {
      method: 'POST',
      path: () => '/facets',
      body: (categoryId) => ({ scope: { kind: 'category', categoryId }, bogus: 1 }),
    },
  },
  product_type: {
    surface: 'GET /catalog-authoring/schemas/:productTypeKey',
    inside: 'cohort.alpha',
    outside: 'cohort.beta',
    probe: {
      method: 'GET',
      path: (productTypeKey) => `/catalog-authoring/schemas/${productTypeKey}?bogus=1`,
    },
  },
  internal_user: {
    // An AUTHENTICATED surface, necessarily. The three anonymous gated routers
    // (`facets`, `navigation`, `taxonomy`) carry no auth middleware, so they can
    // never state this dimension and refuse every request while it is enabled —
    // which `an anonymous surface refuses` below drives directly.
    surface: 'GET /catalog-authoring/schemas/:productTypeKey',
    inside: 'oxy-user-cohort-alpha',
    outside: 'oxy-user-cohort-beta',
    probe: {
      method: 'GET',
      // The product type is held constant at a value no cohort in this case
      // names, so the only thing that can admit the request is the caller.
      path: () => '/catalog-authoring/schemas/cohort.constant?bogus=1',
      headers: (oxyUserId) => ({ 'x-probe-oxy-user-id': oxyUserId }),
    },
  },
};

interface Deployment {
  readonly url: string;
  readonly close: () => Promise<void>;
}

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

/**
 * One deployment with its own frozen config and its own module graph.
 *
 * `config/index.ts` reads `process.env` once at import and freezes it, and both
 * `app.ts`'s mounts and `middleware/catalog-rollout.ts`'s parsed cohort list are
 * derived from that frozen value — so a test that changed the environment after
 * loading would assert against a configuration nobody serves.
 * `vi.resetModules()` per deployment, the `catalog-rollout.realdb.test.ts`
 * device.
 *
 * No database is opened. Every probe below either stops at the gate (404) or at
 * a `.strict()` validator (400), and neither reaches a handler.
 */
async function build(cohorts: string): Promise<Deployment> {
  vi.resetModules();
  for (const lever of LEVERS) process.env[lever] = 'true';
  process.env.CATALOG_ROLLOUT_COHORTS = cohorts;
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = '';
  process.env.STRIPE_ENABLED = 'false';

  const { createApp } = await import('../../app.js');
  const { server, url } = await listen(createApp());
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function call(deployment: Deployment, probe: Probe, value: string): Promise<number> {
  const extraHeaders = probe.headers === undefined ? {} : probe.headers(value);
  const response = await fetch(`${deployment.url}${probe.path(value)}`, {
    method: probe.method,
    ...(probe.method === 'POST'
      ? {
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body: JSON.stringify(probe.body === undefined ? {} : probe.body(value)),
        }
      : { headers: extraHeaders }),
  });
  return response.status;
}

/** Every deployment this file opened, closed together. */
const opened: Deployment[] = [];

/** Keyed by dimension; the control is under the empty string. */
const deployments = new Map<string, Deployment>();

const CONTROL = '';

beforeAll(async () => {
  for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
    const spec = PROBES[dimension];
    const deployment = await build(`${dimension}:${spec.inside}`);
    deployments.set(dimension, deployment);
    opened.push(deployment);
  }
  const control = await build('');
  deployments.set(CONTROL, control);
  opened.push(control);
}, 180_000);

afterAll(async () => {
  for (const lever of LEVERS) delete process.env[lever];
  delete process.env.CATALOG_ROLLOUT_COHORTS;
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
  delete process.env.STRIPE_ENABLED;
  for (const deployment of opened) await deployment.close();
});

/** The deployment for a dimension, or a throw rather than a silent skip. */
function deploymentFor(key: string): Deployment {
  const deployment = deployments.get(key);
  if (deployment === undefined) throw new Error(`no deployment built for '${key}'`);
  return deployment;
}

describe('the probe table covers the tuple and cannot pass by accident', () => {
  it('has a probe for every dimension, and the tuple is not empty', () => {
    expect(CATALOG_ROLLOUT_DIMENSIONS.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(PROBES).sort()).toEqual([...CATALOG_ROLLOUT_DIMENSIONS].sort());
  });

  it('probes different values on each side, across at least four surfaces', () => {
    // Two floors, because they fail independently. A probe whose two values were
    // equal could not discriminate; a table whose probes all pointed at ONE
    // surface would report five dimensions wired while measuring one route.
    const surfaces = new Set<string>();
    for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
      const spec = PROBES[dimension];
      expect(spec.inside, dimension).not.toEqual(spec.outside);
      surfaces.add(spec.surface);
    }
    expect(surfaces.size).toBeGreaterThanOrEqual(4);
  });
});

describe('every dimension actually scopes a real surface', () => {
  for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
    const spec = PROBES[dimension];

    it(`${dimension}: ${spec.surface} refuses a request outside the cohort`, async () => {
      const status = await call(deploymentFor(dimension), spec.probe, spec.outside);
      expect(status, `${spec.surface} did not refuse a ${dimension} outside the cohort`).toBe(404);
    });

    it(`${dimension}: ${spec.surface} admits a request inside the cohort`, async () => {
      const status = await call(deploymentFor(dimension), spec.probe, spec.inside);
      expect(
        status,
        `${spec.surface} refused a ${dimension} the cohort names — the gate is reading the ` +
          'wrong field, or this dimension has no production caller',
      ).not.toBe(404);
      // Not merely "not 404": pinning 400 is what proves the request travelled
      // past the gate into the route's own validator rather than being answered
      // by something else on the way.
      expect(status).toBe(400);
    });
  }
});

describe('`internal_user` is a claim about the CALLER, not about the request', () => {
  /**
   * The two properties the dimension exists for, neither of which the generic
   * admit/refuse pair above can see.
   */
  it('a client cannot admit itself by NAMING an internal user in the request', async () => {
    // The whole security content of this dimension. `internal_user` is the only
    // one whose value is a claim about the caller, and
    // `catalogRolloutSubjectFromRequest` reads the other five from
    // params/query/body — so a resolver that picked this one up the same way
    // would let any client send a known staff id and walk into an unreleased
    // surface. That resolver's own docblock says it is not a security boundary,
    // which is true and harmless for market and locale.
    //
    // Sent as an ANONYMOUS request naming the admitted account in every place
    // `pick()` looks.
    const deployment = deploymentFor('internal_user');
    const named = PROBES.internal_user.inside;
    const status = await call(
      deployment,
      {
        method: 'GET',
        path: () =>
          `/catalog-authoring/schemas/cohort.constant?internalUserOxyUserId=${named}` +
          `&oxyUserId=${named}&userId=${named}&bogus=1`,
      },
      named,
    );
    expect(
      status,
      'a request NAMING an internal user was admitted — the subject is being read from the ' +
        'request rather than from the authenticated caller',
    ).toBe(404);
  });

  it('an ANONYMOUS surface refuses every request while the dimension is enabled', async () => {
    // The consequence, driven rather than described. `facets`, `navigation` and
    // `taxonomy` carry no auth middleware, so they can never state this
    // dimension and refuse everyone — internal callers included.
    //
    // That is the accurate rendering of "not rolled out" for a public,
    // ETag-validated, per-(market, locale) surface, and it is asserted here so a
    // reviewer meeting it in production finds it pinned as a decision rather
    // than discovering it as a bug.
    const deployment = deploymentFor('internal_user');
    const status = await call(
      deployment,
      { method: 'GET', path: () => '/navigation?market=ES&locale=es&bogus=1' },
      PROBES.internal_user.inside,
    );
    expect(
      status,
      'an anonymous surface answered while `internal_user` was the only enabled cohort',
    ).toBe(404);
  });
});

describe('the control: with no cohorts configured, nothing is refused', () => {
  for (const dimension of CATALOG_ROLLOUT_DIMENSIONS) {
    const spec = PROBES[dimension];

    it(`${dimension}: both probes answer 400 with CATALOG_ROLLOUT_COHORTS unset`, async () => {
      // The case that makes every 404 above attributable. Without it a deleted
      // route would satisfy the whole file. It is also the property an operator
      // relies on: an empty variable is today's behaviour exactly.
      const control = deploymentFor(CONTROL);
      expect(await call(control, spec.probe, spec.inside), spec.surface).toBe(400);
      expect(await call(control, spec.probe, spec.outside), spec.surface).toBe(400);
    });
  }
});

/* ------------------------------------------------------------------------- */
/* Part 2 — the coverage census                                               */
/* ------------------------------------------------------------------------- */

/** The middleware's function name, which is how a layer is recognised. */
const GATE_NAME = 'catalogRolloutMiddleware';

interface ExpressLayer {
  readonly name?: string;
  readonly handle?: { readonly name?: string };
  readonly route?: { readonly path?: unknown; readonly stack?: readonly ExpressLayer[] };
}

interface ExpressRouterInternals {
  readonly stack?: readonly ExpressLayer[];
}

/** One `app.use` found inside a catalog-namespaced guard in `app.ts`. */
interface CatalogMount {
  readonly path: string;
  readonly router: string;
  readonly guard: string;
}

/**
 * Every `app.use('<path>', <ident>)` inside a guard whose config namespace starts
 * with `catalog`.
 *
 * DERIVED rather than transcribed: the guard set comes from the source, so a new
 * catalog lever, a new mount under an existing one, or a mount moved out of a
 * guard all change what this returns. A hand list would have gone green on all
 * three.
 */
function catalogMounts(source: string): CatalogMount[] {
  const code = stripComments(source);
  const mounts: CatalogMount[] = [];
  const guard = /if\s*\(\s*config\.(catalog[A-Za-z0-9]*)\.([A-Za-z0-9]+)\s*\)\s*\{/g;
  let match = guard.exec(code);
  while (match !== null) {
    const open = code.indexOf('{', match.index);
    const block = balancedBlock(code, open);
    const use = /app\.use\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)\s*\)/g;
    let inner = use.exec(block);
    while (inner !== null) {
      mounts.push({
        path: inner[1] ?? '',
        router: inner[2] ?? '',
        guard: `config.${match[1] ?? ''}.${match[2] ?? ''}`,
      });
      inner = use.exec(block);
    }
    match = guard.exec(code);
  }
  return mounts;
}

/** The text between a `{` and its matching `}`, ignoring braces inside strings. */
function balancedBlock(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i += 1) {
    const char = code[i];
    if (quote !== null) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** `import <ident> from '<specifier>';` — the map from a mount to its module. */
function defaultImports(source: string): Map<string, string> {
  const code = stripComments(source);
  const imports = new Map<string, string>();
  const pattern = /import\s+([A-Za-z0-9_]+)\s+from\s+'([^']+)'/g;
  let match = pattern.exec(code);
  while (match !== null) {
    if (match[1] !== undefined && match[2] !== undefined) imports.set(match[1], match[2]);
    match = pattern.exec(code);
  }
  return imports;
}

/**
 * Which of a router's routes the gate does NOT cover.
 *
 * A route is covered when the router carries a path-less `router.use` gate
 * before it, or when the gate sits in the route's own stack. Both spellings are
 * in use and for a stated reason (`routes/catalog-authoring.ts`), so a census
 * that recognised only one would report four surfaces ungated.
 */
export function uncoveredRoutes(router: unknown): { routes: number; uncovered: string[] } {
  const stack = (router as ExpressRouterInternals).stack ?? [];
  const uncovered: string[] = [];
  let routerLevelGate = false;
  let routes = 0;

  for (const layer of stack) {
    if (layer.route === undefined) {
      if (layerName(layer) === GATE_NAME) routerLevelGate = true;
      continue;
    }
    routes += 1;
    if (routerLevelGate) continue;
    const covered = (layer.route.stack ?? []).some((inner) => layerName(inner) === GATE_NAME);
    if (!covered) uncovered.push(String(layer.route.path ?? '<unknown>'));
  }
  return { routes, uncovered };
}

function layerName(layer: ExpressLayer): string {
  return layer.name ?? layer.handle?.name ?? '';
}

describe('the catalog mount census is derived from app.ts and is not empty', () => {
  const source = readFileSync(join(SRC_ROOT, 'app.ts'), 'utf8');
  const mounts = catalogMounts(source);
  const publicMounts = mounts.filter((mount) => !mount.path.startsWith('/internal/'));
  const operatorMounts = mounts.filter((mount) => mount.path.startsWith('/internal/'));

  it('finds the catalog mounts, both kinds, above a floor', () => {
    // Floors PER SHAPE rather than one total: the two populations break
    // independently, and a single number would let the public set collapse to
    // zero while the operator set carried it.
    expect(publicMounts.length, 'the derived public catalog mount set collapsed').toBeGreaterThanOrEqual(6);
    expect(operatorMounts.length, 'the derived operator catalog mount set collapsed').toBeGreaterThanOrEqual(20);
    expect(new Set(mounts.map((mount) => mount.guard)).size).toBeGreaterThanOrEqual(4);
  });

  it('a negative control: the block matcher does not swallow the file', () => {
    // `/categories` is mounted unconditionally, immediately above a guarded
    // block. If brace matching ran away it would appear here, and every
    // "uncovered" assertion below would then be about the whole app.
    const paths = mounts.map((mount) => mount.path);
    expect(paths).not.toContain('/categories');
    expect(paths).not.toContain('/listings');
    // …and the positive half, so the control cannot pass by matching nothing.
    expect(paths).toContain('/navigation');
    expect(paths).toContain('/facets');
  });

  it('every public catalog mount is covered by the rollout gate', async () => {
    const imports = defaultImports(source);
    let totalRoutes = 0;
    const failures: string[] = [];

    for (const mount of publicMounts) {
      const specifier = imports.get(mount.router);
      expect(specifier, `no default import found for ${mount.router}`).toBeDefined();
      const module: { default?: unknown } = await import(
        `../../${String(specifier).replace(/^\.\//, '').replace(/\.js$/, '.js')}`
      );
      const { routes, uncovered } = uncoveredRoutes(module.default);
      expect(routes, `${mount.path} registered no routes to measure`).toBeGreaterThanOrEqual(1);
      totalRoutes += routes;
      for (const route of uncovered) {
        failures.push(`${mount.path} (${mount.guard}) route '${route}' is not cohort-gated`);
      }
    }

    // The walk's own floor: a router-stack shape change that made every stack
    // read empty would otherwise report perfect coverage.
    expect(totalRoutes, 'the Express stack walk found almost no routes').toBeGreaterThanOrEqual(20);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('the coverage detector detects — both spellings, and a gap', () => {
    // A mutation self-test on the instrument itself. Without it, a walk that
    // recognised no layer at all would report every router fully covered.
    const gate = { name: GATE_NAME };
    const handler = { name: 'someHandler' };

    const routerLevel = {
      stack: [{ ...gate }, { route: { path: '/a', stack: [handler] } }],
    };
    expect(uncoveredRoutes(routerLevel).uncovered).toEqual([]);
    expect(uncoveredRoutes(routerLevel).routes).toBe(1);

    const perRoute = { stack: [{ route: { path: '/a', stack: [gate, handler] } }] };
    expect(uncoveredRoutes(perRoute).uncovered).toEqual([]);

    const ungated = { stack: [{ route: { path: '/a', stack: [handler] } }] };
    expect(uncoveredRoutes(ungated).uncovered).toEqual(['/a']);

    // A gate registered AFTER the route does not cover it, which is the mistake
    // an ordering change would make silently.
    const late = { stack: [{ route: { path: '/a', stack: [handler] } }, { ...gate }] };
    expect(uncoveredRoutes(late).uncovered).toEqual(['/a']);
  });
});
