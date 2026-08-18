/**
 * ADR 0007 D12's rollback, as a measurement rather than a document.
 *
 * D12 claims two things and until now neither had a test. `docs/catalog-migration-operations.md`
 * recorded both as conventions:
 *
 *  1. **Turning a lever off restores the previous behaviour** — the previous
 *     behaviour being that these six surfaces did not exist.
 *  2. **No lever gates a durable record** — a draft or a proposal stored with the
 *     lever on is still there, and still reachable, with it off.
 *
 * The audit could establish (1) and (2) only by CENSUS: the four levers are read
 * in six places and four of those are the `app.use` that mounts a router. A census
 * is real evidence and it is not a gate — it goes stale the moment somebody adds a
 * fifth read, and nothing fails. This file is the gate.
 *
 * ## Three deployments, three module graphs
 *
 * `config/index.ts` reads `process.env` once at import and freezes the result, and
 * `app.ts` decides every mount from that frozen value — so a test that mutated the
 * environment after loading the app would assert against a config nobody serves.
 * `vi.resetModules()` per deployment, the `internal-offers.test.ts` device.
 *
 * ## Why the assertions compare ON against OFF rather than naming expected codes
 *
 * "Existing products remain readable and sellable" is a claim about SAMENESS, and
 * a test that asserted `/categories` answers 200 would keep passing if the lever
 * had quietly changed its body, its shape or its status to another success. So the
 * unconditional paths are called on BOTH deployments and their statuses compared.
 * The gated paths need the opposite treatment: 404-with-the-lever-off is worthless
 * without 404's absence with it on, or a route deleted outright would satisfy
 * every case here. Both directions are asserted for all six.
 *
 * ## The third deployment is the one that shows the failure mode
 *
 * `config.catalog.graphOperatorSurfaceEnabled` is DERIVED —
 * `resolveCatalogOperatorIds().length > 0` — so an EMPTY
 * `CATALOG_OPERATOR_OXY_USER_IDS` unmounts all nine `/internal/*` catalog
 * surfaces. Combined with every rollout lever off, that is a rollback in which the
 * catalogue evidence is reachable through no HTTP surface at all, which is exactly
 * the state an operator discovers during the incident that caused it. The
 * deployment exists so that failure is a red test rather than a paragraph.
 *
 * ## A real database, because half the claim is about a stored row
 *
 * The mount assertions never reach Postgres — a 403 or a 404 is decided before any
 * query. The durable-record assertions must: the point is that the ROW outlived a
 * config change, and a stubbed repository would make the case indistinguishable
 * from one where the lever had dropped it. The third deployment opens no pool at
 * all, because every path this file sends it 404s at the mount.
 *
 * ## This file is a FOURTH inserter into `catalog_proposals`, which is shared
 *
 * The suite's throwaway database is shared across parallel FILES, and
 * `services/catalog-observability/__tests__/metrics.realdb.test.ts` asserts a
 * DELTA of exactly one on `proposal_creation_count` and `proposal_backlog_count`
 * — never an absolute — precisely because "these aggregates have no tenant
 * predicate and siblings hold proposals of their own". An insert landing inside
 * that file's before/after window would make its delta two and fail it, naming
 * nothing about this file.
 *
 * The fixture below inserts ONE row, once, in a `beforeAll`, so the exposure is a
 * single moment rather than a stream — and three siblings
 * (`catalog-proposals.realdb.test.ts`, `verticals-smartphone.realdb.test.ts`,
 * `vertical-matrix-and-new-product.e2e.realdb.test.ts`) already insert proposals,
 * so this is a fourth instance of an existing interaction rather than a new class
 * of it. Recorded rather than mitigated because the alternative is not inserting,
 * and the stored row IS what the durable-record claim is about. If that delta ever
 * flakes, this file is one of four places to look.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

const CATALOG_OPERATOR = 'oxy-user-catalog-rollout-operator';
const ORDINARY_USER = 'oxy-user-catalog-rollout-ordinary';

/** Whichever caller the current request is acting as. */
let currentUser = CATALOG_OPERATOR;

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

/** The four levers ADR 0007 D12 actually shipped, as env. */
const LEVERS = [
  'CATALOG_AUTHORING_ENABLED',
  'CATALOG_PROPOSALS_ENABLED',
  'FACETS_ENABLED',
  'CATALOG_TAXONOMY_V2_ENABLED',
] as const;

interface Deployment {
  readonly url: string;
  readonly server: Server;
  readonly close: () => Promise<void>;
}

let leversOn: Deployment;
let leversOff: Deployment;
let leversOffNoOperators: Deployment;

/** The `leversOn` graph's database handle, for writing the fixture rows. */
let writeDb: Awaited<ReturnType<typeof import('../../db/postgres.js').connectPostgres>>;
let insertProposal: typeof import('../../db/catalogProposals/proposalRepository.js').insertProposal;

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
 * Build one deployment with its own frozen config and its own module graph.
 *
 * `withDatabase` is false for the deployment whose every request 404s at the
 * mount: three module graphs each holding a connection pool against a database
 * every parallel test file shares is a real cost, and this one is avoidable —
 * the `search-rollout.realdb.test.ts` reasoning.
 */
async function build(options: {
  readonly levers: boolean;
  readonly operators: string;
  readonly withDatabase: boolean;
}): Promise<Deployment & { readonly graph: typeof import('../../db/postgres.js') | null }> {
  vi.resetModules();
  for (const lever of LEVERS) process.env[lever] = options.levers ? 'true' : 'false';
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = options.operators;
  process.env.STRIPE_ENABLED = 'false';

  const graph = options.withDatabase ? await import('../../db/postgres.js') : null;
  if (graph) await graph.connectPostgres();
  const { createApp } = await import('../../app.js');
  const { server, url } = await listen(createApp());

  return {
    url,
    server,
    graph,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (graph) await graph.closePostgres();
    },
  };
}

beforeAll(async () => {
  const on = await build({ levers: true, operators: CATALOG_OPERATOR, withDatabase: true });
  leversOn = on;
  // The fixture rows are written through the ON graph, which is the deployment
  // that would really have created them.
  if (on.graph) writeDb = on.graph.getDb();
  ({ insertProposal } = await import('../../db/catalogProposals/proposalRepository.js'));

  leversOff = await build({ levers: false, operators: CATALOG_OPERATOR, withDatabase: true });
  leversOffNoOperators = await build({ levers: false, operators: '', withDatabase: false });
}, 180_000);

afterAll(async () => {
  for (const lever of LEVERS) delete process.env[lever];
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
  // `build()` sets this too. Vitest isolates files, so leaving it set changes
  // nothing today — but an afterAll that unsets some of what its setup set is a
  // half-cleanup somebody later trusts.
  delete process.env.STRIPE_ENABLED;
  for (const deployment of [leversOn, leversOff, leversOffNoOperators]) {
    if (deployment) await deployment.close();
  }
});

interface Call {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /**
   * `false` when a STATUS cannot tell "mounted" from "not mounted" for this path,
   * so the not-404 floor below must skip it.
   *
   * Exactly one path is like this and the exemption is counted, because a list of
   * exemptions with no exact-count assertion is a list that grows quietly:
   * `/product-types` registers exactly one route (`GET /:key/specification-layout`)
   * and a key with no published version answers 404 — which is the documented
   * behaviour that made `PRODUCT_TYPES_ENABLED` unnecessary in the first place. So
   * a 404 there is indistinguishable from an unmounted router, and asserting
   * not-404 would assert nothing. Its SAMENESS across lever states is still
   * measured, which is the box-1 property; its unconditional mount is established
   * by the `app.ts` census in `docs/catalog-migration-operations.md` and could be
   * asserted here only by router-stack introspection, which is a different
   * instrument from behaviour.
   */
  readonly probesMount?: false;
}

async function call(deployment: Deployment, target: Call): Promise<number> {
  const response = await fetch(`${deployment.url}${target.path}`, {
    method: target.method,
    ...(target.method === 'POST'
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target.body ?? {}),
        }
      : {}),
  });
  return response.status;
}

/**
 * The six mounts the four levers gate, one call each.
 *
 * `/stores/:storeId/product-drafts` is the one to read carefully: `storesRouter`
 * is mounted at `/stores` UNCONDITIONALLY, so with the authoring lever off this
 * path is not merely unmounted — it falls through to the public store router,
 * whose own 404 is what a client receives. The status is the same either way,
 * which is what the test asserts; the mechanism differing is recorded here
 * because a future catch-all under `/stores` would turn that 404 into something
 * else and this comment is the only warning of it.
 */
const GATED: readonly Call[] = [
  { method: 'GET', path: '/catalog-authoring/categories' },
  { method: 'POST', path: '/stores/store-rollout-1/product-drafts', body: {} },
  { method: 'POST', path: '/catalog-proposals', body: {} },
  { method: 'POST', path: '/facets', body: {} },
  { method: 'GET', path: '/navigation?market=ES&locale=es' },
  /*
   * #367 Workstream 1's public taxonomy reads, behind the SAME
   * `CATALOG_TAXONOMY_V2_ENABLED` lever `/navigation` is behind — the lever
   * `config/index.ts` calls "the extended taxonomy READS", and which until this
   * surface landed gated only the menu.
   *
   * `/categories/roots` rather than a `:categoryId` path: a probe naming an id
   * would 404 for the id as well as for the mount, which is the `probesMount:
   * false` situation below, and this list is better with one fewer of those.
   */
  { method: 'GET', path: '/taxonomy/categories/roots' },
];

/**
 * Surfaces that predate this epic and must not move when a lever does.
 *
 * `/cart` and `/checkout` are the sellability half and are the reason this list
 * is not just catalogue reads: box 1 is "readable AND sellable".
 */
const UNCONDITIONAL: readonly Call[] = [
  { method: 'GET', path: '/categories' },
  { method: 'GET', path: '/listings' },
  { method: 'GET', path: '/cart' },
  { method: 'POST', path: '/checkout', body: {} },
  { method: 'GET', path: '/catalog-attributes/definitions' },
  // See `probesMount` on `Call`: its only route 404s for an unpublished key.
  {
    method: 'GET',
    path: '/product-types/rollout-gate-unpublished-key/specification-layout',
    probesMount: false,
  },
];

/** The nine `/internal/*` catalog surfaces gated on the allow-list and no lever. */
const INTERNAL: readonly string[] = [
  '/internal/catalog-proposals',
  '/internal/canonical-catalog',
  '/internal/offers',
  '/internal/catalog-attributes',
  '/internal/catalog-condition',
  '/internal/matching',
  '/internal/navigation',
  '/internal/catalog-governance',
  '/internal/catalog-metrics',
];

describe('the four levers gate a MOUNT — and turning them off restores the previous behaviour', () => {
  it.each(GATED)('$method $path answers 404 with the levers OFF', async (target) => {
    expect(await call(leversOff, target)).toBe(404);
  });

  it.each(GATED)(
    'POSITIVE CONTROL — $method $path is NOT 404 with the levers ON',
    async (target) => {
      // Without this the case above would pass against a route deleted outright,
      // which is the one failure a 404-only assertion cannot distinguish from the
      // rollback working.
      expect(await call(leversOn, target)).not.toBe(404);
    },
  );

  it('withdraws EXACTLY those six mounts and nothing else', async () => {
    // The vacuity floor on the two lists: an empty GATED array would make both
    // cases above pass trivially, and an empty UNCONDITIONAL array would make the
    // sameness case below pass trivially.
    expect(GATED.length).toBe(6);
    expect(UNCONDITIONAL.length).toBeGreaterThanOrEqual(6);
  });
});

describe('existing products remain readable and sellable with every lever off', () => {
  it.each(UNCONDITIONAL)(
    '$method $path answers IDENTICALLY with the levers on and off',
    async (target) => {
      const [on, off] = await Promise.all([call(leversOn, target), call(leversOff, target)]);
      expect(off, `${target.path} changed between lever states`).toBe(on);
    },
  );

  it.each(UNCONDITIONAL.filter((target) => target.probesMount !== false))(
    '$method $path is mounted at all — not 404',
    async (target) => {
      // The floor under the sameness assertion above: two 404s are identical, so
      // without this a route that had been removed from BOTH deployments would
      // satisfy every case in this describe.
      expect(await call(leversOff, target)).not.toBe(404);
    },
  );

  it('exempts EXACTLY one path from that floor', () => {
    // The exemption's own exact count. Without it, marking a path
    // `probesMount: false` is a way to silence a real regression, and the silence
    // would look like the floor still covering everything.
    const exempt = UNCONDITIONAL.filter((target) => target.probesMount === false);
    expect(exempt.map((target) => target.path)).toEqual([
      '/product-types/rollout-gate-unpublished-key/specification-layout',
    ]);
  });
});

describe('no lever gates a durable record', () => {
  /** A proposal stored by the deployment that had the lever ON. */
  let proposalId: string;

  beforeAll(async () => {
    const now = new Date();
    const label = `Rollout Gate Brand ${String(now.getTime())}`;
    const row = await insertProposal(writeDb, {
      type: 'brand',
      origin: 'operator',
      storeId: null,
      submittedByOxyUserId: CATALOG_OPERATOR,
      proposedLabel: label,
      sourceLocale: 'en',
      normalizedLabel: label.toLowerCase(),
      searchLabel: label.toLowerCase(),
      proposedDescription: null,
      submitterNote: null,
      categoryId: null,
      productTypeDefinitionId: null,
      attributeDefinitionId: null,
      attributeDefinitionVersion: null,
      duplicateScanPopulation: 1,
      duplicateScanCandidates: 0,
      duplicateScanAt: now,
    });
    expect(row, 'the fixture proposal was not stored').toBeDefined();
    proposalId = row?.id ?? '';
  }, 60_000);

  it('the merchant surface that created it is GONE with the lever off', async () => {
    expect(await call(leversOff, { method: 'POST', path: '/catalog-proposals', body: {} })).toBe(
      404,
    );
  });

  it('and the row is still READABLE over HTTP, through the operator surface', async () => {
    // The whole claim in one request: the surface a merchant used is unmounted,
    // the row it created is not gone, and an operator can still reach it — which
    // is what makes the rollback one somebody would actually pull.
    currentUser = CATALOG_OPERATOR;
    const response = await fetch(`${leversOff.url}/internal/catalog-proposals/${proposalId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data?: unknown };
    expect(body.success).toBe(true);
    expect(JSON.stringify(body.data)).toContain(proposalId);
  });
});

describe('the nine internal catalog surfaces are gated on the allow-list and on NO lever', () => {
  it.each(INTERNAL)('%s is MOUNTED with every lever off', async (path) => {
    // A 403 rather than a 404: the surface exists and this caller is not on the
    // list. That is the discrimination the whole allow-list convention rests on,
    // and it is only meaningful next to the empty-list case below.
    currentUser = ORDINARY_USER;
    const status = await call(leversOff, { method: 'GET', path });
    currentUser = CATALOG_OPERATOR;
    expect(status).toBe(403);
  });

  it.each(INTERNAL)(
    'THE FAILURE MODE — %s answers 404 when the operator allow-list is EMPTY',
    async (path) => {
      // `graphOperatorSurfaceEnabled` is derived from the list's LENGTH, so an
      // empty list plus every lever off is a rollback in which the catalogue
      // evidence is reachable through no HTTP surface at all. An operator's own
      // token gets the same 404, which is why this is a trap rather than a
      // permission error somebody would recognise.
      currentUser = CATALOG_OPERATOR;
      expect(await call(leversOffNoOperators, { method: 'GET', path })).toBe(404);
    },
  );

  it('names all nine surfaces — the vacuity floor on both cases above', () => {
    expect(INTERNAL.length).toBe(9);
    expect(new Set(INTERNAL).size).toBe(9);
  });
});
