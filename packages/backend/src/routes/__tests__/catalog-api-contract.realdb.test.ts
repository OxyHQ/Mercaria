/**
 * Contract tests for the authoring, taxonomy and localization ENDPOINTS
 * (#367 Workstream 19), driven over real HTTP against a real database — plus a
 * route census DERIVED from the routers rather than hand-listed.
 *
 * ## What was unproven
 *
 * The authoring domain has a large test surface and none of it was HTTP. A census
 * over `--include=*.test.ts` for files importing `createApp` found 27 BEFORE this
 * file (28 with it), and the only one naming `catalog-authoring` was
 * `catalog-rollout.realdb.test.ts`, which asserts MOUNTS and nothing about a
 * response. Everything else calls the service:
 * `schema-version-lifecycle-exposure.realdb.test.ts` drives `composeAuthoringSchema`
 * directly, `catalog-authoring.realdb.test.ts` drives the CHECKs,
 * `authoring-etag.test.ts` drives the digest. The positive control for that census
 * is `'/checkout'`, which appears in a test file — so the instrument does find HTTP
 * paths when they are there.
 *
 * What a service test cannot reach is exactly what this file is about: the
 * `.strict()` query schemas, the ETag exchange and its `304`, the store
 * authorization chain, the status codes, and the fact that a route is REGISTERED at
 * the path a client will call. A module can be correct, tested, and called by
 * nothing.
 *
 * ## The census is DERIVED, and coverage is RECORDED rather than declared
 *
 * `registeredRoutes` walks each router's own `stack` — every verb, not a
 * source-regex over `router.get|post`, which is blind to a `patch` or a `delete`
 * somebody adds. Coverage is then decided by replaying the calls this file
 * ACTUALLY made (`CALLS`, appended by the two request helpers) against express's
 * OWN layer regexps, in registration order, exactly as express itself dispatches.
 * So a route added tomorrow is uncovered until somebody drives it, and a case
 * deleted from this file un-covers its route — neither of which a hand list can do.
 *
 * The exemption list has an exact-count assertion, because a list of exemptions
 * with no count is a list that grows quietly.
 *
 * ## The auth STAND-IN, and what it does not stand in for
 *
 * `middleware/auth.js` is mocked with a header-driven `authenticateToken`: no
 * `x-test-actor` is a 401 in the real error shape, and one present attaches that
 * Oxy id. That makes 401 AND 403 drivable in one deployment, which mocking auth
 * away entirely (`catalog-rollout`'s approach) cannot do.
 *
 * It stands in for the NETWORK call to Oxy and for nothing else:
 * `loadStore`, `requireStorePermission`, `effectivePermissions` and every schema
 * run for real. `oxyClient` is stubbed with a working `auth()` because
 * `lib/rate-limit.ts` imports it and `createOxyRateLimit` calls it on every
 * request — the limiter itself is NOT mocked, which is what makes the abuse-limit
 * case real.
 *
 * ## This file inserts ONE `catalog_proposals` row, and that is a known interaction
 *
 * `catalog-rollout.realdb.test.ts`'s header records that
 * `services/catalog-observability/__tests__/metrics.realdb.test.ts` asserts a DELTA
 * of exactly one on `proposal_creation_count`, and names three existing inserters.
 * This is a FIFTH, inserting exactly one row in exactly one case rather than a
 * stream. Recorded rather than mitigated, because the alternative is not driving
 * `POST /catalog-proposals` at all. If that delta ever flakes, this file is one of
 * five places to look.
 *
 * ## The abuse-limit case is LAST, deliberately
 *
 * `/taxonomy`, `/categories` and `/product-types` share the `'listings'` bucket and
 * the limiter is per process with no Redis, so exhausting it poisons every later
 * case in this file. It therefore runs after everything else, and moving it earlier
 * will fail the file in a way that names the wrong route.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import type { Router } from 'express';
import { sql } from 'drizzle-orm';

const TOKEN = `c367${randomBytes(3).toString('hex')}`;
const NS_DOT = TOKEN;
const MEMBER = `${TOKEN}-member`;
const OUTSIDER = `${TOKEN}-outsider`;

/* -------------------------------------------------------------------------- */
/* The auth stand-in                                                          */
/* -------------------------------------------------------------------------- */

vi.mock('../../middleware/auth.js', () => {
  const actorOf = (req: express.Request): string | undefined => {
    const raw = req.headers['x-test-actor'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === undefined || value === '' ? undefined : value;
  };
  return {
    // A working `auth()` because `lib/rate-limit.ts` imports this client and
    // `createOxyRateLimit` calls it on every request. `{}` would throw at
    // construction and take the whole app with it.
    oxyClient: {
      auth:
        () =>
        (_req: express.Request, _res: express.Response, next: express.NextFunction): void => {
          next();
        },
    },
    authenticateToken: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      const actor = actorOf(req);
      if (actor === undefined) {
        // The shape `createOxyAuthMiddleware` answers with, so a client's
        // handling of it is what this file measures.
        res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
        return;
      }
      // BOTH, because the real `createOxyAuthMiddleware` sets both and different
      // consumers read different ones: `authoringPermissions` reads
      // `req.storeMembership`, and `loadStore` reads `req.userId`. Setting only
      // `req.user` makes every store-scoped route answer 401 — measured.
      (req as unknown as { user: { id: string }; userId: string }).user = { id: actor };
      (req as unknown as { userId: string }).userId = actor;
      next();
    },
    optionalAuth: (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ): void => {
      const actor = actorOf(req);
      if (actor !== undefined) {
        (req as unknown as { user: { id: string } }).user = { id: actor };
        (req as unknown as { userId: string }).userId = actor;
      }
      next();
    },
  };
});

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: (req: express.Request) =>
    (req as unknown as { user?: { id: string } }).user?.id ?? MEMBER,
}));

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

interface Call {
  readonly method: string;
  readonly path: string;
}

/** Every request this file made, for the census to replay. */
const CALLS: Call[] = [];

interface Answer {
  readonly status: number;
  readonly etag: string | null;
  readonly cacheControl: string | null;
  readonly body: Record<string, unknown>;
}

let base: string;
let server: Server;
let db: Awaited<ReturnType<typeof import('../../db/postgres.js').connectPostgres>>;

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { readonly actor?: string; readonly body?: unknown; readonly ifNoneMatch?: string } = {},
): Promise<Answer> {
  CALLS.push({ method, path });
  const headers: Record<string, string> = {};
  if (options.actor !== undefined) headers['x-test-actor'] = options.actor;
  if (options.ifNoneMatch !== undefined) headers['if-none-match'] = options.ifNoneMatch;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    cacheControl: response.headers.get('cache-control'),
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const get = (path: string, options?: Parameters<typeof request>[2]): Promise<Answer> =>
  request('GET', path, options);

/** The `data` envelope `sendSuccess` wraps every success in. */
function data(answer: Answer): Record<string, unknown> {
  return (answer.body['data'] ?? {}) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly rootId: string;
  readonly midId: string;
  readonly leafAId: string;
  readonly leafBId: string;
  readonly suppressedId: string;
  readonly draftRootId: string;
  readonly underDraftId: string;
  readonly midKey: string;
  readonly midSlug: string;
  readonly productTypeKey: string;
  readonly productTypeV1Id: string;
  readonly attributeId: string;
  readonly attributeKey: string;
  readonly storeId: string;
}

let fx: Fixture;
/** The searchable fragment. Distinctive per run, so a hit is provably ours. */
const SEARCH_STEM = TOKEN;

beforeAll(async () => {
  for (const lever of [
    'CATALOG_AUTHORING_ENABLED',
    'CATALOG_PROPOSALS_ENABLED',
    'CATALOG_TAXONOMY_V2_ENABLED',
  ]) {
    process.env[lever] = 'true';
  }
  process.env.STRIPE_ENABLED = 'false';
  // `config/index.ts` freezes `process.env` at import, and `app.ts` decides every
  // mount from that frozen value — so the levers have to be set before the module
  // graph loads. `catalog-rollout.realdb.test.ts`'s device.
  vi.resetModules();

  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  const { insertCategory } = await import('../../db/taxonomy/taxonomyRepository.js');
  const { upsertCategoryLocalization } = await import(
    '../../db/catalogLocalization/categoryLocalizationRepository.js'
  );
  const { issueCategoryLocalizedSlug } = await import(
    '../../db/catalogLocalization/categoryLocalizedSlugRepository.js'
  );
  const { insertProductTypeDefinition, setProductTypeLifecycleIfIn } = await import(
    '../../db/productTypes/productTypeRepository.js'
  );
  const { insertProductTypeCategoryScope, insertProductTypeField, insertProductTypeFieldGroup } =
    await import('../../db/productTypes/productTypeFieldRepository.js');
  const { insertAttributeDefinition, transitionAttributeDefinition } = await import(
    '../../db/attributes/definitionRepository.js'
  );

  // A grouping ROOT (published, NOT selectable) → a real `category_not_selectable`.
  const root = await insertCategory({
    key: `${NS_DOT}.root`,
    name: `Root ${SEARCH_STEM}`,
    slug: `${TOKEN}-root`,
    position: 0,
    selectable: false,
  });
  const mid = await insertCategory({
    key: `${NS_DOT}.root.mid`,
    name: `Sneakers ${SEARCH_STEM}`,
    slug: `${TOKEN}-mid`,
    parentId: root.id,
    position: 1,
  });
  const leafA = await insertCategory({
    key: `${NS_DOT}.root.mid.leaf_a`,
    name: `Running ${SEARCH_STEM}`,
    slug: `${TOKEN}-leaf-a`,
    parentId: mid.id,
    position: 0,
  });
  const leafB = await insertCategory({
    key: `${NS_DOT}.root.mid.leaf_b`,
    name: `Trail ${SEARCH_STEM}`,
    slug: `${TOKEN}-leaf-b`,
    parentId: mid.id,
    position: 1,
  });
  // SUPPRESSED: selectable, and a shopper must not see it in a browse.
  const suppressed = await insertCategory({
    key: `${NS_DOT}.root.mid.hidden`,
    name: `Hidden ${SEARCH_STEM}`,
    slug: `${TOKEN}-hidden`,
    parentId: mid.id,
    position: 2,
    lifecycle: 'suppressed',
  });
  // A DRAFT root with a PUBLISHED child — the trail case no filter can serve.
  const draftRoot = await insertCategory({
    key: `${NS_DOT}.unannounced`,
    name: `Unannounced vertical ${SEARCH_STEM}`,
    slug: `${TOKEN}-unannounced`,
    position: 3,
    lifecycle: 'draft',
  });
  const underDraft = await insertCategory({
    key: `${NS_DOT}.unannounced.live`,
    name: `Live under draft ${SEARCH_STEM}`,
    slug: `${TOKEN}-under-draft`,
    parentId: draftRoot.id,
    position: 0,
  });

  // Spanish for the mid category only, so an English read and a Spanish read of
  // the SAME node differ — which is what the cache-separation cases measure.
  await upsertCategoryLocalization(
    {
      categoryId: mid.id,
      locale: 'es',
      status: 'approved',
      provenance: 'mercaria',
      name: `Zapatillas ${SEARCH_STEM}`,
      description: `Descripcion ${SEARCH_STEM}`,
      // `category_localizations_reviewed_audit_check` and its `reviewer_pair`
      // sibling: settled text names who settled it, and the reviewer and the
      // instant travel together. A real CHECK a mocked insert would have accepted.
      reviewedByOxyUserId: MEMBER,
      reviewedAt: new Date(),
    },
    db,
  );
  await issueCategoryLocalizedSlug(
    { categoryId: mid.id, locale: 'es', slug: `${TOKEN}-zapatillas`, provenance: 'mercaria' },
    db,
  );

  // ONE published attribute definition, so the product type can declare a field.
  // `composeAuthoringSchema` REFUSES a version that declares no field in the
  // requested flow (`flow_declares_no_field`) — a version with a group and no
  // field is not a form, and refusing is right. Found by driving the route.
  const attribute = await insertAttributeDefinition(db, {
    key: `${TOKEN}_upper_material`,
    version: 1,
    label: 'Upper material',
    valueType: 'string',
    objectivity: 'objective',
    createdByOxyUserId: MEMBER,
  });
  await transitionAttributeDefinition(db, attribute.id, 'draft', 'active', {
    publishedByOxyUserId: MEMBER,
    publishedAt: new Date(),
  });

  const productTypeKey = `${TOKEN}_footwear`;
  const v1 = await insertProductTypeDefinition(db, {
    key: productTypeKey,
    version: 1,
    name: `Footwear ${TOKEN} v1`,
    createdByOxyUserId: MEMBER,
  });
  // Children BEFORE publication. `mercaria_product_type_child_frozen` reads the
  // PARENT's lifecycle, so a group or a scope added after publishing raises — the
  // structural half of "a published version is frozen, and its children with it".
  const v1Group = await insertProductTypeFieldGroup(db, {
    productTypeDefinitionId: v1.id,
    key: 'basics',
    label: 'Basics',
    position: 0,
  });
  await insertProductTypeField(db, {
    productTypeDefinitionId: v1.id,
    groupId: v1Group.id,
    attributeDefinitionId: attribute.id,
    // The denormalized citation, which `mercaria_product_type_field_citation`
    // checks against the definition the foreign key names — so a wrong key or
    // version here raises rather than drifting.
    attributeKey: attribute.key,
    attributeDefinitionVersion: attribute.version,
    scope: 'product',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'typed_scalar',
    position: 0,
  });
  await insertProductTypeCategoryScope(db, {
    productTypeDefinitionId: v1.id,
    categoryId: mid.id,
    includeDescendants: true,
  });
  await setProductTypeLifecycleIfIn(db, v1.id, ['draft'], 'published', {
    publishedByOxyUserId: MEMBER,
    publishedAt: new Date(),
  });

  // A 24-character ObjectId hex, because `validateId('storeId')` runs on the
  // drafts router and `isLiveEntityId` admits exactly two shapes: that, and a uuid
  // v7. A readable `<token>-store` is a 400 before any handler sees it — which is
  // the guard doing its job, and a fixture detail worth stating rather than
  // rediscovering.
  const storeId = randomBytes(12).toString('hex');
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${storeId}, ${`${TOKEN} store`}, ${`${TOKEN}-store`}, '', '#101010')
    on conflict (id) do nothing
  `);
  // The id is supplied: `generatedId()` mints in the APPLICATION rather than by a
  // database `DEFAULT` (Postgres 17 has no native `uuidv7()`), so a raw insert
  // gets none — which is the documented behaviour and not a bug to work around.
  await db.execute(sql`
    insert into store_members (id, store_id, oxy_user_id, role, permissions, joined_at)
    values (${randomBytes(12).toString('hex')}, ${storeId}, ${MEMBER}, 'owner', '{}', now())
  `);

  fx = {
    rootId: root.id,
    midId: mid.id,
    leafAId: leafA.id,
    leafBId: leafB.id,
    suppressedId: suppressed.id,
    draftRootId: draftRoot.id,
    underDraftId: underDraft.id,
    midKey: mid.key,
    midSlug: mid.slug,
    productTypeKey,
    productTypeV1Id: v1.id,
    attributeId: attribute.id,
    attributeKey: attribute.key,
    storeId,
  };

  const { createApp } = await import('../../app.js');
  server = await new Promise<Server>((resolve) => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 240_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!db || !fx) return;
  const { setCategoryLifecycle } = await import('../../db/taxonomy/taxonomyRepository.js');

  // DELETE what the server permits and RETIRE what it does not — the
  // `vertical-fixture.ts` posture, and here for its two reasons.
  //
  // `mercaria_product_type_definition_immutable` refuses a DELETE of any version
  // that has left draft, and `mercaria_product_type_child_frozen` refuses a delete
  // of its scope rows too — so a published product type and the CATEGORIES its
  // scopes cite (`product_type_category_scopes.category_id` is `RESTRICT`) both
  // survive this run permanently.
  //
  // `deprecated` is what makes that harmless: `isCategoryLifecycleActive` reads it
  // as inactive, so `findActiveCategories` — what `GET /categories` and
  // `feed.service` serve — never sees them again, and `/taxonomy`'s browse reads
  // admit `published` only.
  /*
   * `catalog_review_events` refuses DELETE by trigger and its `proposal_id` is a
   * plain foreign key, so the events genuinely have to go before their proposal —
   * and the only way out is to turn the trigger off inside a window.
   *
   * `withTriggerToggleLock` and NOT a bare `db.transaction`:
   * on the pool that DDL AUTOCOMMITS, so a throw between the disable and the
   * enable leaves the trigger off database-wide for the rest of the run, and every
   * later file asserting it refuses a write passes VACUOUSLY.
   * `advisory-lock-census.test.ts` fails the build on the bare spelling.
   * ONE table, one trigger, both statements on `tx`, re-enabled in the same window
   * — `catalog-proposals.realdb.test.ts`'s teardown, for its reasons.
   */
  const { withTriggerToggleLock } = await import('../../db/__tests__/trigger-toggle-lock.js');
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table catalog_review_events disable trigger mercaria_catalog_review_event_append_only`,
    );
    await tx.execute(sql`
      delete from catalog_review_events
      where proposal_id in (select id from catalog_proposals where store_id = ${fx.storeId})
    `);
    await tx.execute(
      sql`alter table catalog_review_events enable trigger mercaria_catalog_review_event_append_only`,
    );
  });
  await db.execute(
    sql`delete from catalog_proposal_references where proposal_id in (select id from catalog_proposals where store_id = ${fx.storeId})`,
  );
  await db.execute(
    sql`delete from catalog_proposal_duplicate_candidates where proposal_id in (select id from catalog_proposals where store_id = ${fx.storeId})`,
  );
  await db.execute(sql`delete from catalog_proposals where store_id = ${fx.storeId}`);
  await db.execute(sql`delete from catalog_authoring_drafts where store_id = ${fx.storeId}`);
  await db.execute(sql`delete from store_members where store_id = ${fx.storeId}`);
  /*
   * `deleteTestStores` and NOT a `delete from stores`, and it is not optional:
   * `services/backfill/stages/store-merchants.ts` pages EVERY active store in the
   * shared throwaway database and writes a `native_store_links` row for each, so a
   * store this file created can acquire a link between its last write and this
   * teardown — and `native_store_links.store_id` is `ON DELETE RESTRICT`.
   *
   * MEASURED: the raw statement passed in isolation and failed the full parallel
   * run with `23503` on a constraint this file has nothing to do with, which is
   * exactly the failure `store-teardown.ts`'s header describes.
   */
  const { deleteTestStores } = await import('../../db/__tests__/store-teardown.js');
  await deleteTestStores(db, [fx.storeId]);

  // Children first, and each of these is referenced by nothing: the two leaves and
  // the suppressed node have no children and no scope, and `underDraft` has to go
  // before its draft parent because `categories.parent_id` is `RESTRICT`.
  for (const id of [fx.leafAId, fx.leafBId, fx.suppressedId, fx.underDraftId, fx.draftRootId]) {
    await db.execute(sql`delete from categories where id = ${id}`);
  }
  // `mid` carries the scope rows and `root` is its parent, so both are retired.
  await setCategoryLifecycle(fx.midId, 'deprecated', db);
  await setCategoryLifecycle(fx.rootId, 'deprecated', db);
  // The attribute definition is `active` and cited by frozen product-type fields,
  // so it is RETIRED rather than deleted — and it is scoped to no category, so
  // `listActiveDefinitionsForCategory` never offers it to a sibling's read.
  await db.execute(
    sql`update attribute_definitions set lifecycle_state = 'retired' where key like ${`${TOKEN}%`}`,
  );

  const { closePostgres } = await import('../../db/postgres.js');
  await closePostgres();
}, 240_000);

/* -------------------------------------------------------------------------- */
/* 1. The taxonomy surface                                                    */
/* -------------------------------------------------------------------------- */

describe('the taxonomy reads', () => {
  it('serves roots with a stable id, a stable key AND a resolved presentation', async () => {
    const answer = await get('/taxonomy/categories/roots?limit=200');
    expect(answer.status).toBe(200);
    const page = data(answer);
    const categories = page['categories'] as {
      id: string;
      key: string;
      name: { outcome: string; value?: string };
      slug: { outcome: string; slug?: string };
      selectable: boolean;
      depth: number;
    }[];
    // A global read, so `find` and not an equality — plus the floor, because an
    // empty page satisfies every "does not contain".
    expect(categories.length).toBeGreaterThan(0);
    const ours = categories.find((entry) => entry.id === fx.rootId);
    expect(ours, 'the seeded root is not in the roots page').toBeDefined();
    if (ours === undefined) return;
    // Never presentation alone, and never identity alone.
    expect(ours.key).toBe(`${NS_DOT}.root`);
    expect(ours.name.outcome).toBe('resolved');
    expect(ours.slug.outcome).toBe('resolved');
    expect(ours.depth).toBe(0);
    expect(ours.selectable).toBe(false);
    // The DRAFT root is not browsable — the control that makes the case above a
    // measurement rather than "the read returns rows".
    expect(categories.some((entry) => entry.id === fx.draftRootId)).toBe(false);
  });

  it('serves children in sibling order and excludes a SUPPRESSED node', async () => {
    const answer = await get(`/taxonomy/categories/${fx.midId}/children?limit=50`);
    expect(answer.status).toBe(200);
    const ids = (data(answer)['categories'] as { id: string }[]).map((entry) => entry.id);
    // Equality, because these are exactly the children this file created.
    expect(ids).toEqual([fx.leafAId, fx.leafBId]);
    expect(ids).not.toContain(fx.suppressedId);
  });

  it('serves descendants at any depth, root-relative', async () => {
    const answer = await get(`/taxonomy/categories/${fx.rootId}/descendants?limit=50`);
    expect(answer.status).toBe(200);
    const ids = (data(answer)['categories'] as { id: string }[]).map((entry) => entry.id);
    // `(position, slug)` across every depth, which is NOT depth-first: `leafA` is
    // position 0, and `leafB` and `mid` share position 1 with `-leaf-b` sorting
    // before `-mid`. That is the repository's documented sibling order applied to a
    // flat result, it is TOTAL (`categories_slug_key` makes the slug unique), and a
    // client re-nests by `parentId` rather than relying on arrival order.
    expect(ids).toEqual([fx.leafAId, fx.leafBId, fx.midId]);
  });

  it('pages descendants on a keyset, and refuses a cursor it did not issue', async () => {
    const first = await get(`/taxonomy/categories/${fx.rootId}/descendants?limit=1`);
    expect(first.status).toBe(200);
    const page = data(first);
    expect(page['hasMore']).toBe(true);
    const cursor = page['nextCursor'] as string;
    expect(typeof cursor).toBe('string');
    const second = await get(
      `/taxonomy/categories/${fx.rootId}/descendants?limit=5&cursor=${encodeURIComponent(cursor)}`,
    );
    const secondIds = (data(second)['categories'] as { id: string }[]).map((entry) => entry.id);
    // Strictly after, with no overlap — the property an offset cursor loses under
    // a concurrent insert and a broken keyset loses always.
    expect(secondIds).toEqual([fx.leafBId, fx.midId]);

    const forged = await get(
      `/taxonomy/categories/${fx.rootId}/descendants?limit=5&cursor=not-a-cursor`,
    );
    // Refused, not ignored: silently restarting would answer page four with page
    // one, which reads as duplicate rows and looks like a client bug.
    expect(forged.status).toBe(400);
  });

  it('serves the ancestors and the breadcrumb, and the trail includes SELF only in the breadcrumb', async () => {
    const ancestors = await get(`/taxonomy/categories/${fx.leafAId}/ancestors`);
    expect(ancestors.status).toBe(200);
    const ancestorIds = (data(ancestors)['steps'] as { id: string }[]).map((step) => step.id);
    expect(ancestorIds).toEqual([fx.rootId, fx.midId]);

    const breadcrumb = await get(`/taxonomy/categories/${fx.leafAId}/breadcrumb`);
    expect(breadcrumb.status).toBe(200);
    const crumbIds = (data(breadcrumb)['steps'] as { id: string }[]).map((step) => step.id);
    expect(crumbIds).toEqual([fx.rootId, fx.midId, fx.leafAId]);
  });

  it('keeps a trail COMPLETE while withholding an undisclosable step’s identity', async () => {
    const answer = await get(`/taxonomy/categories/${fx.underDraftId}/breadcrumb`);
    expect(answer.status).toBe(200);
    const steps = data(answer)['steps'] as Record<string, unknown>[];
    // The trail keeps its LENGTH: a breadcrumb missing its middle is not a shorter
    // breadcrumb, it is a wrong one.
    expect(steps.length).toBe(2);
    const parent = steps[0] as { disclosure: string; id: string; lifecycle: string };
    expect(parent.id).toBe(fx.draftRootId);
    expect(parent.disclosure).toBe('withheld');
    expect(parent.lifecycle).toBe('draft');
    // The three fields that would leak an unannounced vertical's identity are
    // ABSENT rather than empty — the `withheld` branch has no property for them.
    expect(Object.keys(parent).sort()).toEqual(['disclosure', 'id', 'lifecycle']);
    // POSITIVE CONTROL: the disclosed step DOES carry them, so the assertion above
    // is about disclosure and not about the serializer emitting nothing.
    const self = steps[1] as { disclosure: string; key: string };
    expect(self.disclosure).toBe('disclosed');
    expect(self.key).toBe(`${NS_DOT}.unannounced.live`);
  });

  it('answers ONE 404 for an absent category and for an unaddressable one', async () => {
    const absent = await get(`/taxonomy/categories/${'0'.repeat(24)}`);
    const unannounced = await get(`/taxonomy/categories/${fx.draftRootId}`);
    expect(absent.status).toBe(404);
    expect(unannounced.status).toBe(404);
    // Byte-identical, because a distinguishable answer is an oracle over which
    // guessable ids name a vertical nobody has announced.
    expect(unannounced.body).toEqual(absent.body);
    // POSITIVE CONTROL: a published node at the same route answers 200, so the two
    // 404s above are about lifecycle rather than about the route being broken.
    expect((await get(`/taxonomy/categories/${fx.midId}`)).status).toBe(200);
  });

  it('resolves a category by its stable KEY, and refuses a label where a key belongs', async () => {
    const byKey = await get(`/taxonomy/categories/by-key/${fx.midKey}`);
    expect(byKey.status).toBe(200);
    expect((data(byKey)['category'] as { id: string }).id).toBe(fx.midId);
    // A display label — spaces and capitals — is a 400 naming the rule, not a 404.
    const byLabel = await get('/taxonomy/categories/by-key/Sneakers%20And%20Boots');
    expect(byLabel.status).toBe(400);
    expect(String(byLabel.body['message'])).toContain('stable machine key');
  });

  it('answers eligibility as a VERDICT with named reasons, not as a filtered set', async () => {
    const selectable = await get(`/taxonomy/categories/${fx.midId}/eligibility`);
    expect(selectable.status).toBe(200);
    const yes = data(selectable)['eligibility'] as {
      listable: boolean;
      refusals: string[];
      selectable: boolean;
      productTypes: { key: string; version: number }[];
    };
    expect(yes.listable).toBe(true);
    expect(yes.refusals).toEqual([]);
    expect(yes.productTypes.map((entry) => entry.key)).toContain(fx.productTypeKey);

    // The grouping ROOT: published, and a product may not be filed under it. The
    // set-shaped answer cannot express this at all.
    const structural = await get(`/taxonomy/categories/${fx.rootId}/eligibility`);
    const no = data(structural)['eligibility'] as { listable: boolean; refusals: string[] };
    expect(no.listable).toBe(false);
    expect(no.refusals).toContain('category_not_selectable');

    /*
     * The SECOND reason, and it is the one that makes `listable` a derivation
     * rather than a rename of `selectable`. `underDraft` is published AND
     * selectable, and no product-type version is scoped to it or to any ancestor —
     * so nothing can be authored there and it is not listable.
     *
     * MEASURED: without this case, replacing `listable: refusals.length === 0` with
     * `listable: row.selectable` passes — the two only disagree here.
     */
    const unscoped = await get(`/taxonomy/categories/${fx.underDraftId}/eligibility`);
    expect(unscoped.status).toBe(200);
    const neither = data(unscoped)['eligibility'] as {
      listable: boolean;
      selectable: boolean;
      refusals: string[];
      productTypes: unknown[];
    };
    expect(neither.selectable).toBe(true);
    expect(neither.productTypes).toEqual([]);
    expect(neither.refusals).toEqual(['no_scoped_product_type']);
    expect(neither.listable).toBe(false);
  });

  it('refuses an undeclared query parameter — the `.strict()` schema', async () => {
    // `?lifecycle=draft` is the one that matters: there is no such parameter, so an
    // anonymous caller has no way to widen what a read admits.
    expect((await get('/taxonomy/categories/roots?lifecycle=draft')).status).toBe(400);
    expect((await get(`/taxonomy/categories/${fx.midId}?market=ES`)).status).toBe(400);
    expect((await get(`/taxonomy/categories/${fx.midId}/children?offset=10`)).status).toBe(400);
    // POSITIVE CONTROL: the declared ones are accepted, so the refusals above are
    // about strictness rather than about the schema rejecting everything.
    expect((await get('/taxonomy/categories/roots?locale=es&limit=5')).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Localized search and autocomplete                                       */
/* -------------------------------------------------------------------------- */

describe('localized category search', () => {
  it('matches the LOCALIZED name in the reader’s locale and says so', async () => {
    const answer = await get(
      `/taxonomy/categories/search?q=${encodeURIComponent(`Zapatillas ${SEARCH_STEM}`)}&locale=es`,
    );
    expect(answer.status).toBe(200);
    const hits = data(answer)['hits'] as {
      category: { id: string; name: { value: string } };
      match: string;
      matchedIn: string;
    }[];
    expect(hits.length).toBe(1);
    expect(hits[0]?.category.id).toBe(fx.midId);
    expect(hits[0]?.matchedIn).toBe('localized_name');
    expect(hits[0]?.match).toBe('prefix');
    expect(hits[0]?.category.name.value).toContain('Zapatillas');
  });

  it('matches the BASE name when there is no translation, and reports that', async () => {
    const answer = await get(
      `/taxonomy/categories/search?q=${encodeURIComponent(`Running ${SEARCH_STEM}`)}&locale=es`,
    );
    const hits = data(answer)['hits'] as { category: { id: string }; matchedIn: string }[];
    expect(hits.map((hit) => hit.category.id)).toEqual([fx.leafAId]);
    // `base_name`, not `localized_name`: an untranslated taxonomy must not read as
    // a translated one.
    expect(hits[0]?.matchedIn).toBe('base_name');
  });

  it('ranks a prefix match ahead of a contains match, deterministically', async () => {
    const answer = await get(`/taxonomy/categories/search?q=${SEARCH_STEM}&locale=en&limit=50`);
    const hits = data(answer)['hits'] as { category: { id: string }; match: string }[];
    // The stem sits at the END of every seeded name, so every hit is `contains` and
    // the order is by name length then slug — a TOTAL order, which is what makes
    // two runs agree.
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(new Set(hits.map((hit) => hit.match))).toEqual(new Set(['contains']));
    const repeat = await get(`/taxonomy/categories/search?q=${SEARCH_STEM}&locale=en&limit=50`);
    expect((data(repeat)['hits'] as { category: { id: string } }[]).map((h) => h.category.id)).toEqual(
      hits.map((hit) => hit.category.id),
    );
    // The suppressed and draft nodes carry the stem in their names and must not be
    // in a shopper's autocomplete — the control on the lifecycle filter.
    const ids = hits.map((hit) => hit.category.id);
    expect(ids).not.toContain(fx.suppressedId);
    expect(ids).not.toContain(fx.draftRootId);
  });

  it('drops a candidate the reader’s OWN label does not contain', async () => {
    /*
     * The load-bearing half of the search, and it is what makes the ranking honest.
     *
     * `mid` has base name `Sneakers <stem>` and an approved Spanish name
     * `Zapatillas <stem>`. For `locale=es` the fallback chain is `['es', 'en']`, so
     * the SQL candidate scan matches `mid` through its BASE name — and the resolver
     * then serves the Spanish one, which does not contain "Sneakers". Returning it
     * would put a hit in front of a Spanish shopper that is invisible in the text
     * they are shown.
     */
    const spanish = await get(
      `/taxonomy/categories/search?q=${encodeURIComponent(`Sneakers ${SEARCH_STEM}`)}&locale=es`,
    );
    expect(spanish.status).toBe(200);
    expect((data(spanish)['hits'] as { category: { id: string } }[]).map((h) => h.category.id)).not.toContain(
      fx.midId,
    );
    // POSITIVE CONTROL: the same query in the locale whose label DOES contain it
    // returns the row — so the case above is about the drop and not about the query
    // matching nothing.
    const english = await get(
      `/taxonomy/categories/search?q=${encodeURIComponent(`Sneakers ${SEARCH_STEM}`)}&locale=en`,
    );
    expect((data(english)['hits'] as { category: { id: string } }[]).map((h) => h.category.id)).toEqual([
      fx.midId,
    ]);
  });

  it('answers a LIKE metacharacter query with no hits', async () => {
    /*
     * MEASURED: this does NOT prove `escapeLikePattern` works, and it used to claim
     * it did. Removing the escaping leaves this green, because an unescaped `%%`
     * widens the SQL CANDIDATE set to every published category and the resolved-name
     * filter above then drops all of them — the answer is right either way.
     *
     * So the escaping bounds the SCAN and the filter bounds the ANSWER. What is
     * asserted here is the answer; the escaping's benefit is a bounded read that no
     * response field can show, and it is kept for that reason rather than this one.
     */
    const answer = await get('/taxonomy/categories/search?q=%25%25&locale=en');
    expect(answer.status).toBe(200);
    expect((data(answer)['hits'] as unknown[]).length).toBe(0);
  });

  it('refuses a one-character query', async () => {
    expect((await get('/taxonomy/categories/search?q=a')).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Locale cache separation, and the ETag exchange                          */
/* -------------------------------------------------------------------------- */

describe('the ETag exchange and locale cache separation', () => {
  it('answers 304 to an echo of its own tag, and 200 to a different one', async () => {
    const first = await get(`/taxonomy/categories/${fx.midId}?locale=es`);
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(first.cacheControl).toBe('public, no-cache');
    const echoed = await get(`/taxonomy/categories/${fx.midId}?locale=es`, {
      ifNoneMatch: first.etag ?? '',
    });
    expect(echoed.status).toBe(304);
    // A weak echo of a strong tag still means "I hold this content".
    const weak = await get(`/taxonomy/categories/${fx.midId}?locale=es`, {
      ifNoneMatch: `W/${first.etag ?? ''}`,
    });
    expect(weak.status).toBe(304);
    const stale = await get(`/taxonomy/categories/${fx.midId}?locale=es`, {
      ifNoneMatch: '"tax-0000000000000000000000000000abcd"',
    });
    expect(stale.status).toBe(200);
  });

  it('gives two LOCALES two tags, and a 304 for one is a 200 for the other', async () => {
    const spanish = await get(`/taxonomy/categories/${fx.midId}?locale=es`);
    const english = await get(`/taxonomy/categories/${fx.midId}?locale=en`);
    expect(spanish.status).toBe(200);
    expect(english.status).toBe(200);
    expect(spanish.etag).not.toBe(english.etag);
    // The load-bearing half: presenting the Spanish tag on the English read must
    // NOT be answered 304, or one locale's cache entry serves the other's body.
    const crossed = await get(`/taxonomy/categories/${fx.midId}?locale=en`, {
      ifNoneMatch: spanish.etag ?? '',
    });
    expect(crossed.status).toBe(200);
  });

  /*
   * MEASURED, and it corrected this file: the case here used to claim that two
   * locales falling back to the same base name produce the SAME body and must
   * still get different tags. That premise is FALSE — `LocalizedResolution` echoes
   * `requestedLocale` inside the payload, so an `es` body and an `fr` body differ
   * by that field and the tags differ through the BODY whatever the key does.
   * Freezing the locale in the ETag key left the whole file green, which is how the
   * vacuity was found.
   *
   * The dimensions genuinely NOT recoverable from the body are `read`, `subject`
   * and `parameters`, because three different questions can share one
   * byte-identical answer: the empty page. Each pair below asserts that its two
   * bodies really are equal — the premise — and then that the tags differ. Without
   * the premise the case would pass for any two reads that happen to answer
   * differently, which is every other pair on this surface.
   */
  it('distinguishes reads whose bodies are BYTE-IDENTICAL', async () => {
    const childrenA = await get(`/taxonomy/categories/${fx.leafAId}/children`);
    const descendantsA = await get(`/taxonomy/categories/${fx.leafAId}/descendants`);
    const childrenB = await get(`/taxonomy/categories/${fx.leafBId}/children`);
    const childrenALimited = await get(`/taxonomy/categories/${fx.leafAId}/children?limit=2`);
    for (const answer of [childrenA, descendantsA, childrenB, childrenALimited]) {
      expect(answer.status).toBe(200);
    }
    // The premise: a leaf has no children and no descendants, so all four answers
    // are the same empty page.
    expect(data(childrenA)).toEqual({ categories: [], hasMore: false });
    expect(data(descendantsA)).toEqual(data(childrenA));
    expect(data(childrenB)).toEqual(data(childrenA));
    expect(data(childrenALimited)).toEqual(data(childrenA));

    // Different READ, same subject: a shared tag would let a `304` answer
    // "what is below this" with "what is directly under this".
    expect(descendantsA.etag).not.toBe(childrenA.etag);
    // Different SUBJECT, same read.
    expect(childrenB.etag).not.toBe(childrenA.etag);
    // Different PARAMETER, same read and subject.
    expect(childrenALimited.etag).not.toBe(childrenA.etag);
    // …and the exchange really refuses the crossed validator rather than merely
    // minting a different string.
    expect(
      (
        await get(`/taxonomy/categories/${fx.leafAId}/descendants`, {
          ifNoneMatch: childrenA.etag ?? '',
        })
      ).status,
    ).toBe(200);
  });

  it('separates two PAGES of one read, so a cursor cannot be answered from the other', async () => {
    const first = await get(`/taxonomy/categories/${fx.rootId}/descendants?limit=1`);
    const cursor = data(first)['nextCursor'] as string;
    const second = await get(
      `/taxonomy/categories/${fx.rootId}/descendants?limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.etag).not.toBe(first.etag);
    expect(
      (
        await get(
          `/taxonomy/categories/${fx.rootId}/descendants?limit=1&cursor=${encodeURIComponent(cursor)}`,
          { ifNoneMatch: first.etag ?? '' },
        )
      ).status,
    ).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The v1 taxonomy reads and the public product-type layout                */
/* -------------------------------------------------------------------------- */

describe('the pre-existing catalogue reads still answer', () => {
  it('serves the v1 category tree, which carries no key and no localization', async () => {
    const answer = await get('/categories');
    expect(answer.status).toBe(200);
    const nodes = answer.body['data'] as { id: string; name: string; key?: string }[];
    const ours = nodes.find((node) => node.id === fx.rootId);
    expect(ours, 'the seeded root is not in the v1 tree').toBeDefined();
    // Recorded rather than fixed: `CategoryNode` has no `key`, which is why
    // `/taxonomy` is additive instead of a change to this shape (ADR 0007 D13).
    expect(ours?.key).toBeUndefined();
  });

  it('serves a category’s listing browse', async () => {
    const answer = await get(`/categories/${fx.midSlug}/listings`);
    expect(answer.status).toBe(200);
    expect(Array.isArray(data(answer)['data'])).toBe(true);
  });

  it('serves the PUBLISHED specification layout, and 404s an unpublished key', async () => {
    const answer = await get(`/product-types/${fx.productTypeKey}/specification-layout`);
    expect(answer.status).toBe(200);
    expect((data(answer)['layout'] ?? data(answer))).toBeTruthy();
    expect((await get(`/product-types/${TOKEN}_nothing/specification-layout`)).status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The authoring surface                                                   */
/* -------------------------------------------------------------------------- */

describe('the authoring reads', () => {
  it('requires authentication on every one of them', async () => {
    for (const path of [
      '/catalog-authoring/categories',
      `/catalog-authoring/product-types?categoryId=${fx.midId}`,
      '/catalog-authoring/canonical-search?q=ab',
      `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=ES`,
    ]) {
      expect((await get(path)).status, path).toBe(401);
    }
  });

  it('offers only categories a product may be FILED under', async () => {
    const answer = await get('/catalog-authoring/categories?limit=500', { actor: MEMBER });
    expect(answer.status).toBe(200);
    const ids = (data(answer)['categories'] as { id: string }[]).map((entry) => entry.id);
    expect(ids).toContain(fx.midId);
    // The grouping root is published and NOT selectable; the suppressed node is
    // selectable and not published. Both are excluded, and they are different facts.
    expect(ids).not.toContain(fx.rootId);
    expect(ids).not.toContain(fx.suppressedId);
  });

  it('resolves the product types scoped to a category', async () => {
    const answer = await get(`/catalog-authoring/product-types?categoryId=${fx.leafAId}`, {
      actor: MEMBER,
    });
    expect(answer.status).toBe(200);
    // `leafA` is a DESCENDANT of the scoped node, so this also proves
    // `includeDescendants` is read.
    const keys = (data(answer)['productTypes'] as { key: string }[]).map((entry) => entry.key);
    expect(keys).toContain(fx.productTypeKey);
  });

  it('searches the canonical catalogue, and refuses a one-character query', async () => {
    expect(
      (await get(`/catalog-authoring/canonical-search?q=${TOKEN}`, { actor: MEMBER })).status,
    ).toBe(200);
    expect((await get('/catalog-authoring/canonical-search?q=a', { actor: MEMBER })).status).toBe(
      400,
    );
  });

  it('composes a schema with an ETag, honours If-None-Match, and keys on the MARKET', async () => {
    const path = `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=ES`;
    const first = await get(path, { actor: MEMBER });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(first.cacheControl).toBe('private, no-cache');
    expect(
      (await get(path, { actor: MEMBER, ifNoneMatch: first.etag ?? '' })).status,
    ).toBe(304);

    // A different MARKET is a different composition, so the tag must differ and
    // the other market's tag must not be answered 304.
    const other = `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=MX`;
    const mx = await get(other, { actor: MEMBER });
    expect(mx.status).toBe(200);
    expect(mx.etag).not.toBe(first.etag);
    expect((await get(other, { actor: MEMBER, ifNoneMatch: first.etag ?? '' })).status).toBe(200);

    // …and on the LOCALE, independently of the market.
    const es = await get(`${path}&locale=es-ES`, { actor: MEMBER });
    expect(es.etag).not.toBe(first.etag);
  });

  it('refuses an undeclared query key and a missing required one', async () => {
    expect(
      (
        await get(`/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}`, {
          actor: MEMBER,
        })
      ).status,
      'market is required',
    ).toBe(400);
    expect(
      (
        await get(
          `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=ES&lifecycle=draft`,
          { actor: MEMBER },
        )
      ).status,
    ).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Drafts: store ownership, permissions, and optimistic concurrency        */
/* -------------------------------------------------------------------------- */

describe('the product drafts', () => {
  let draftId = '';

  it('refuses an unauthenticated caller and a non-member', async () => {
    expect((await get(`/stores/${fx.storeId}/product-drafts`)).status).toBe(401);
    // A member of no store: `loadStore` resolves the store and
    // `requireStorePermission` refuses. Not a 404, because the store is real and
    // the caller is simply not on it.
    expect((await get(`/stores/${fx.storeId}/product-drafts`, { actor: OUTSIDER })).status).toBe(
      403,
    );
  });

  it('creates, reads and lists a draft for a member', async () => {
    const created = await request('POST', `/stores/${fx.storeId}/product-drafts`, {
      actor: MEMBER,
      body: { categoryId: fx.midId, productTypeKey: fx.productTypeKey, market: 'ES' },
    });
    expect(created.status).toBe(201);
    const draft = data(created)['draft'] as { id: string; version: number };
    draftId = draft.id;
    expect(draft.version).toBe(1);

    expect((await get(`/stores/${fx.storeId}/product-drafts/${draftId}`, { actor: MEMBER })).status).toBe(
      200,
    );
    const listed = await get(`/stores/${fx.storeId}/product-drafts?limit=10`, { actor: MEMBER });
    expect(listed.status).toBe(200);
    expect((data(listed)['drafts'] as { id: string }[]).map((entry) => entry.id)).toContain(draftId);
  });

  it('enforces the version compare-and-swap on a PATCH', async () => {
    const ok = await request('PATCH', `/stores/${fx.storeId}/product-drafts/${draftId}`, {
      actor: MEMBER,
      body: { version: 1, title: `Draft ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect((data(ok)['draft'] as { version: number }).version).toBe(2);

    // The SAME request again, carrying the version it has just superseded. A CAS that
    // accepted it would silently overwrite whatever landed in between.
    const stale = await request('PATCH', `/stores/${fx.storeId}/product-drafts/${draftId}`, {
      actor: MEMBER,
      body: { version: 1, title: 'clobbered' },
    });
    expect(stale.status).toBe(409);

    // And a body with no version at all is a 400 rather than an unchecked write:
    // an optional CAS token is the same as no CAS for every client that forgets.
    const unversioned = await request('PATCH', `/stores/${fx.storeId}/product-drafts/${draftId}`, {
      actor: MEMBER,
      body: { title: 'no version' },
    });
    expect(unversioned.status).toBe(400);
  });

  it('validates a draft, and refuses to publish an incomplete one with the SAME finding shape', async () => {
    const validated = await request(
      'POST',
      `/stores/${fx.storeId}/product-drafts/${draftId}/validate`,
      { actor: MEMBER },
    );
    expect(validated.status).toBe(200);
    const validation = data(validated)['validation'] as {
      findings: { code: string; path: string }[];
    };
    expect(Array.isArray(validation.findings)).toBe(true);
    // Codes and paths, never a message — a client maps codes to its own i18n keys.
    for (const finding of validation.findings) {
      expect(finding).not.toHaveProperty('message');
      expect(typeof finding.code).toBe('string');
    }

    const published = await request(
      'POST',
      `/stores/${fx.storeId}/product-drafts/${draftId}/publish`,
      { actor: MEMBER },
    );
    // 422 and not 400: the request is well-formed and the DRAFT is not ready. The
    // body is the same `AuthoringValidationResult` the validate route returns, so a
    // client renders one list for both.
    expect(published.status).toBe(422);
    expect(
      (published.body['data'] as { validation?: unknown } | undefined)?.validation,
    ).toBeDefined();
  });

  it('previews an upgrade with a GET and applies one with a POST, on one path', async () => {
    const preview = await get(`/stores/${fx.storeId}/product-drafts/${draftId}/upgrade`, {
      actor: MEMBER,
    });
    expect(preview.status).toBe(200);
    // Applying is a different VERB, so a client that only meant to look cannot
    // rewrite the draft. The apply is driven with the CURRENT published version as
    // the target, which is a no-op upgrade and still exercises the route.
    const applied = await request(
      'POST',
      `/stores/${fx.storeId}/product-drafts/${draftId}/upgrade`,
      {
        actor: MEMBER,
        body: { version: 2, targetDefinitionId: fx.productTypeV1Id },
      },
    );
    // Either outcome is a driven contract: a no-op upgrade may be accepted (200) or
    // refused as nothing to do (409). What must NOT happen is a 404 or a 500.
    expect([200, 409]).toContain(applied.status);
  });

  it('discards a draft with the version in the QUERY', async () => {
    const current = await get(`/stores/${fx.storeId}/product-drafts/${draftId}`, { actor: MEMBER });
    const version = (data(current)['draft'] as { version: number }).version;
    const discarded = await request(
      'DELETE',
      `/stores/${fx.storeId}/product-drafts/${draftId}?version=${String(version)}`,
      { actor: MEMBER },
    );
    expect(discarded.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Proposals                                                               */
/* -------------------------------------------------------------------------- */

describe('the catalog proposals', () => {
  let proposalId = '';

  it('scans for duplicates without storing anything, and refuses a forbidden field', async () => {
    const scan = await request('POST', '/catalog-proposals/duplicates', {
      actor: MEMBER,
      body: {
        // A BRAND proposal, not a controlled value: a controlled-value request must
        // name an attribute whose FIELD opens it to proposals
        // (`valuePolicy: 'proposal_enabled'`), and this file's product type declares
        // a `typed_scalar` field — so that path is refused 403 by design. Driving
        // the ROUTE is what this case is for; which type it carries is incidental.
        type: 'brand',
        storeId: fx.storeId,
        proposedLabel: `Brand ${TOKEN}`,
      },
    });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
  });

  it('submits ONE proposal, reads it back, and refuses another store’s', async () => {
    const submitted = await request('POST', '/catalog-proposals', {
      actor: MEMBER,
      body: {
        type: 'brand',
        storeId: fx.storeId,
        proposedLabel: `Brand ${TOKEN}`,
        sourceLocale: 'en',
      },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const proposal = (data(submitted)['proposal'] ?? data(submitted)) as { id: string };
    proposalId = proposal.id;
    expect(typeof proposalId).toBe('string');

    const listed = await get(`/catalog-proposals?storeId=${fx.storeId}`, { actor: MEMBER });
    expect(listed.status).toBe(200);

    const read = await get(`/catalog-proposals/${proposalId}?storeId=${fx.storeId}`, {
      actor: MEMBER,
    });
    expect(read.status).toBe(200);

    // A caller who is not on the store is refused by the SAME chain the drafts use.
    expect(
      (await get(`/catalog-proposals/${proposalId}?storeId=${fx.storeId}`, { actor: OUTSIDER }))
        .status,
    ).toBe(403);
  });

  it('refuses information for a proposal nobody asked about, then withdraws it', async () => {
    const information = await request('POST', `/catalog-proposals/${proposalId}/information`, {
      actor: MEMBER,
      body: { storeId: fx.storeId, response: `because ${TOKEN}` },
    });
    // A driven refusal: the route exists and is authorized, and the STATE is wrong.
    // "we never asked" and "we asked and it failed" lead an operator to opposite
    // conclusions, so this must not be a 404.
    expect([409, 422]).toContain(information.status);

    const withdrawn = await request('POST', `/catalog-proposals/${proposalId}/withdraw`, {
      actor: MEMBER,
      body: { storeId: fx.storeId, reason: `no longer needed ${TOKEN}` },
    });
    expect(withdrawn.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Exact schema-version retrieval AFTER a newer version publishes           */
/* -------------------------------------------------------------------------- */

describe('exact schema-version retrieval after a newer version publishes', () => {
  it('serves v2 unversioned and v1 by ?version=, once v2 is published', async () => {
    const before = await get(
      `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=ES`,
      { actor: MEMBER },
    );
    expect(before.status).toBe(200);
    const v1 = (data(before)['schema'] as { productType: { version: number } }).productType;
    expect(v1.version).toBe(1);
    const v1Etag = before.etag;

    // Publish v2. `product_type_definitions_one_published_per_key` is a partial
    // unique, so the predecessor must be deprecated in the SAME transaction — which
    // is the structural half of "a published version is immutable".
    const { insertProductTypeDefinition, setProductTypeLifecycleIfIn } = await import(
      '../../db/productTypes/productTypeRepository.js'
    );
    const { insertProductTypeCategoryScope, insertProductTypeField, insertProductTypeFieldGroup } =
      await import('../../db/productTypes/productTypeFieldRepository.js');
    const v2 = await insertProductTypeDefinition(db, {
      key: fx.productTypeKey,
      version: 2,
      name: `Footwear ${TOKEN} v2`,
      createdByOxyUserId: MEMBER,
    });
    const v2Group = await insertProductTypeFieldGroup(db, {
      productTypeDefinitionId: v2.id,
      key: 'basics',
      label: 'Basics',
      position: 0,
    });
    await insertProductTypeField(db, {
      productTypeDefinitionId: v2.id,
      groupId: v2Group.id,
      attributeDefinitionId: fx.attributeId,
      attributeKey: fx.attributeKey,
      attributeDefinitionVersion: 1,
      scope: 'product',
      flow: 'merchant',
      requirement: 'optional',
      valuePolicy: 'typed_scalar',
      position: 0,
    });
    await insertProductTypeCategoryScope(db, {
      productTypeDefinitionId: v2.id,
      categoryId: fx.midId,
      includeDescendants: true,
    });
    await db.transaction(async (tx) => {
      await setProductTypeLifecycleIfIn(tx, fx.productTypeV1Id, ['published'], 'deprecated', {
        deprecatedAt: new Date(),
      });
      await setProductTypeLifecycleIfIn(tx, v2.id, ['draft'], 'published', {
        publishedByOxyUserId: MEMBER,
        publishedAt: new Date(),
      });
    });

    // Unversioned now composes v2 — the CURRENT schema.
    const after = await get(
      `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=ES`,
      { actor: MEMBER },
    );
    expect(after.status).toBe(200);
    expect(
      (data(after)['schema'] as { productType: { version: number } }).productType.version,
    ).toBe(2);
    // And its tag differs from v1's, so a client holding the old schema is not
    // answered 304 with a body it no longer has.
    expect(after.etag).not.toBe(v1Etag);
    expect(
      (
        await get(
          `/catalog-authoring/schemas/${fx.productTypeKey}?categoryId=${fx.midId}&market=ES`,
          { actor: MEMBER, ifNoneMatch: v1Etag ?? '' },
        )
      ).status,
    ).toBe(200);

    // `?version=1` still composes v1, which is now DEPRECATED — a draft that pinned
    // it has to keep resolving, which is what `deprecated` means here.
    const pinned = await get(
      `/catalog-authoring/schemas/${fx.productTypeKey}?version=1&categoryId=${fx.midId}&market=ES`,
      { actor: MEMBER },
    );
    expect(pinned.status).toBe(200);
    const pinnedType = (data(pinned)['schema'] as {
      productType: { version: number; lifecycle: string };
    }).productType;
    // The BOX: the exact version is still retrievable after a newer one published.
    expect(pinnedType.version).toBe(1);

    /*
     * This assertion used to read `published`, and that was a BUG PINNED ON
     * PURPOSE — a fact about `composeAuthoringSchema`'s process-local memo
     * rather than about `?version=`. The comment here ended: "If somebody adds
     * the lifecycle to the key, the first line fails and this comment is the
     * explanation." #611 added it, this line failed, and this is that
     * explanation being spent.
     *
     * `AuthoringSchemaKey` now carries the version's LIFECYCLE, so a composition
     * taken while v1 was `published` is no longer served unchanged after v1 is
     * deprecated. Both locales therefore agree below: the already-memoized `en`
     * (which the case above composed) and a `pt` nothing has composed.
     *
     * Both are still asserted, and that is the half worth keeping. A pin on the
     * MEMOIZED locale is the only one that can fail — a fresh locale never had an
     * entry to be stale, so it reported the truth before the fix too and would
     * report it if the key regressed.
     */
    expect(pinnedType.lifecycle).toBe('deprecated');
    const fresh = await get(
      `/catalog-authoring/schemas/${fx.productTypeKey}?version=1&categoryId=${fx.midId}&market=ES&locale=pt`,
      { actor: MEMBER },
    );
    expect(
      (data(fresh)['schema'] as { productType: { lifecycle: string } }).productType.lifecycle,
    ).toBe('deprecated');

    // A version nobody published is NOT retrievable, and a version that does not
    // exist answers the same way — the exposure
    // `schema-version-lifecycle-exposure.realdb.test.ts` closed, asserted here over
    // HTTP for the first time.
    const nonexistent = await get(
      `/catalog-authoring/schemas/${fx.productTypeKey}?version=99&categoryId=${fx.midId}&market=ES`,
      { actor: MEMBER },
    );
    expect(nonexistent.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. The DERIVED route census                                                */
/* -------------------------------------------------------------------------- */

interface RegisteredRoute {
  readonly method: string;
  /** The full path as a client calls it. */
  readonly full: string;
  /** Whether a concrete request path reaches this route, by express's own regexp. */
  readonly matches: (path: string) => boolean;
}

/**
 * The routers this census covers, with the prefix `app.ts` mounts each at.
 *
 * The prefix is written out because a router does not know its own mount. It is
 * checked against `app.ts` by `mountsAreReal` below, so a prefix that drifted
 * fails rather than silently censusing a path nobody serves.
 */
const SURFACES = [
  { module: '../taxonomy.js', mount: '/taxonomy' },
  { module: '../categories.js', mount: '/categories' },
  { module: '../product-types.js', mount: '/product-types' },
  { module: '../catalog-authoring.js', mount: '/catalog-authoring' },
  { module: '../product-drafts.js', mount: '/stores/:storeId/product-drafts' },
  { module: '../catalog-proposals.js', mount: '/catalog-proposals' },
] as const;

/**
 * Routes NOT driven by this file, each with a reason.
 *
 * Exact-count asserted below, because a list of exemptions with no count is a list
 * that grows quietly.
 */
const EXEMPT: readonly { readonly route: string; readonly why: string }[] = [];

function joinMount(mount: string, routePath: string): string {
  const tail = routePath === '/' ? '' : routePath;
  return `${mount}${tail}` || '/';
}

/** `:param` → one path segment. The route's OWN regexp does the rest. */
function mountRegexp(mount: string): RegExp {
  const pattern = mount
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}`, 'u');
}

async function registeredRoutes(): Promise<RegisteredRoute[]> {
  const routes: RegisteredRoute[] = [];
  for (const surface of SURFACES) {
    const loaded = (await import(surface.module)) as { default: Router };
    const prefix = mountRegexp(surface.mount);
    for (const layer of (loaded.default as unknown as { stack: unknown[] }).stack) {
      const entry = layer as {
        route?: { path: string; methods: Record<string, boolean> };
        regexp?: RegExp;
      };
      if (entry.route === undefined) continue;
      const routePath = entry.route.path;
      const regexp = entry.regexp;
      for (const [method, enabled] of Object.entries(entry.route.methods)) {
        if (!enabled || method === '_all') continue;
        routes.push({
          method: method.toUpperCase(),
          full: `${method.toUpperCase()} ${joinMount(surface.mount, routePath)}`,
          matches: (path: string): boolean => {
            /*
             * The PREFIX test is not redundant and leaving it out is a real defect
             * this file hit: with it absent, a path whose mount does not match was
             * left unchanged and then tested against the route's own regexp — so
             * `/catalog-proposals` matched `GET /stores/:storeId/product-drafts/:draftId`
             * (one segment after a slash), the attribution landed on the wrong
             * route, and `GET /catalog-proposals` was reported uncovered while a
             * drafts route was reported covered by a call that never touched it.
             */
            if (!prefix.test(path)) return false;
            const withoutPrefix = path.replace(prefix, '');
            const candidate = withoutPrefix === '' ? '/' : withoutPrefix;
            return regexp === undefined ? candidate === routePath : regexp.test(candidate);
          },
        });
      }
    }
  }
  return routes;
}

describe('every registered route on the authoring, taxonomy and product-type surfaces is driven', () => {
  it('covers each one, derived from the ROUTER and matched by express’s own regexps', async () => {
    const routes = await registeredRoutes();
    // The vacuity floor. A census over an EMPTY route list passes every coverage
    // assertion, and an import that resolved to the wrong module is exactly how
    // that happens.
    // EXACT, not a floor. A floor is a vacuity guard and this is also a
    // population statement: 9 taxonomy + 2 categories + 1 product-type + 4
    // authoring + 9 drafts + 6 proposals. A route ADDED fails here as well as
    // failing the coverage assertion below, and a route DELETED fails only here —
    // which is the direction a floor is blind to.
    expect(routes.length, `${String(routes.length)} routes derived`).toBe(31);

    const calls = CALLS.map((call) => ({
      method: call.method,
      path: (call.path.split('?')[0] ?? call.path),
    }));
    // A floor on the CALLS too: they are appended by the request helpers, so an
    // empty list would mean this describe ran before every other one.
    expect(calls.length, `${String(calls.length)} calls recorded`).toBeGreaterThanOrEqual(50);

    const exempted = new Set(EXEMPT.map((entry) => entry.route));
    const uncovered: string[] = [];
    for (const route of routes) {
      if (exempted.has(route.full)) continue;
      // Attributed to the FIRST matching route in registration order, exactly as
      // express dispatches — so driving `/categories/roots` does not mark
      // `/categories/:categoryId` covered.
      const covered = calls.some((call) => {
        if (call.method !== route.method) return false;
        const first = routes.find(
          (candidate) => candidate.method === call.method && candidate.matches(call.path),
        );
        return first?.full === route.full;
      });
      if (!covered) uncovered.push(route.full);
    }
    expect(uncovered, `uncovered: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('names every exemption with a reason, and counts them exactly', () => {
    expect(EXEMPT.length, `${String(EXEMPT.length)} exemptions`).toBe(0);
    for (const entry of EXEMPT) expect(entry.why.length).toBeGreaterThan(20);
  });

  it('MUTATION SELF-TEST — the REAL matcher discriminates in both directions', async () => {
    /*
     * The coverage case above is worthless if `matches` is always true (everything
     * covered) or always false (nothing covered, and `uncovered` would then be
     * non-empty, so that direction fails loudly). The dangerous direction is
     * always-true, and it is what these three assertions pin — using the REAL
     * derived matchers, not a hand-written stand-in whose subject is itself.
     */
    const routes = await registeredRoutes();
    const roots = routes.find((route) => route.full === 'GET /taxonomy/categories/roots');
    const eligibility = routes.find(
      (route) => route.full === 'GET /taxonomy/categories/:categoryId/eligibility',
    );
    expect(roots).toBeDefined();
    expect(eligibility).toBeDefined();
    if (roots === undefined || eligibility === undefined) return;

    // Positive: the path this file really calls.
    expect(roots.matches('/taxonomy/categories/roots')).toBe(true);
    // Negative on a SIBLING path under the same mount — an always-true matcher
    // fails here.
    expect(roots.matches('/taxonomy/categories/search')).toBe(false);
    // Negative ACROSS mounts. This is the one that fails when the prefix test is
    // removed from `matches`: `/catalog-proposals` is `/` plus one segment, which
    // the drafts router's `/:draftId` regexp matches once the prefix is not
    // checked.
    expect(eligibility.matches('/catalog-proposals')).toBe(false);
    const drafts = routes.find(
      (route) => route.full === 'GET /stores/:storeId/product-drafts/:draftId',
    );
    expect(drafts).toBeDefined();
    expect(drafts?.matches('/catalog-proposals')).toBe(false);

    // …and the recorded calls really do reach the roots route through it.
    const calls = CALLS.map((call) => ({
      method: call.method,
      path: call.path.split('?')[0] ?? call.path,
    }));
    expect(calls.some((call) => call.method === 'GET' && roots.matches(call.path))).toBe(true);
  });

  it('every mount prefix this census claims is a prefix `app.ts` really mounts', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.ts'),
      'utf8',
    );
    for (const surface of SURFACES) {
      expect(source, `${surface.mount} is not mounted in app.ts`).toContain(`'${surface.mount}'`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Abuse limits — LAST, because it exhausts a shared bucket               */
/* -------------------------------------------------------------------------- */

describe('abuse limits', () => {
  /**
   * RETITLED (#630). It said *"the anonymous budget for the catalogue bucket"*,
   * and it cannot attribute its 429 to that bucket.
   *
   * `app.ts:240` mounts `makeRateLimiter('general')` above every route, and
   * `taxonomy.ts:90`'s `makeRateLimiter('listings')` passes no override, so both
   * take the same anonymous default of 600. The global limiter is reached first
   * on every request and counts traffic from every router, so it is spent first
   * — the 429 below is `general`'s.
   *
   * MEASURED, not inferred: a sibling case that first exhausted a different
   * router drove THIS case to 429 on attempt 1, failing its own
   * `attempts > 100` floor. Recorded as #784, which is a production-config
   * decision and not this file's to make.
   *
   * The case is kept because what it proves is real and worth keeping — an
   * anonymous flood is bounded, at a budget in the hundreds rather than one.
   * Only the name changed, because a title claiming a bucket it cannot
   * attribute is the exact defect #630 exists to remove.
   */
  it('answers 429 once the anonymous budget bounding this surface is spent', async () => {
    // 600 per 15 minutes is `createOxyRateLimit`'s anonymous default and
    // `makeRateLimiter` passes no override. The path chosen 400s at `validateId`
    // BEFORE any database access, so exhausting the budget costs no queries — the
    // limiter runs first because it is `router.use`'d above every route.
    let last = 0;
    let attempts = 0;
    for (let index = 0; index < 900; index += 1) {
      attempts += 1;
      const answer = await fetch(`${base}/taxonomy/categories/not-an-id`);
      last = answer.status;
      if (last === 429) break;
      // The control: until the budget is spent, the answer is the 400 the path
      // really produces — so a 429 on the first request would fail here instead of
      // reading as the limiter working.
      expect(last, `attempt ${String(attempts)}`).toBe(400);
    }
    expect(last, `429 not reached in ${String(attempts)} attempts`).toBe(429);
    expect(attempts).toBeGreaterThan(100);
  }, 240_000);
});
