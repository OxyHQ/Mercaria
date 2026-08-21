/**
 * Secondary category classification, driven over HTTP against a real database
 * (#367 Workstream 1).
 *
 * ## Why the ROUTES and not the repository
 *
 * A repository test passes on a write path no client can reach. #853 shipped a
 * variant-image write proved at the repository and #855 had to be filed because
 * nothing reached it over HTTP — so every acceptance case below goes through
 * `createApp()`, the real router, the real `.strict()`-equivalent schema and the
 * real operator gate.
 *
 * The DIRECT-SQL cases at the bottom are the opposite move, deliberately: they
 * bypass the service entirely to prove the DATABASE refuses, because a rule
 * that only the service enforces is a rule a second writer walks around. Both
 * halves are needed and neither substitutes for the other.
 *
 * ## The vacuity control
 *
 * A 404 under an authenticated router prefix means "no such route" AND "not an
 * operator" AND "no such subject" — `referral-partner-mount.integration.test.ts`
 * records reading one wrong. So every positive case asserts a FIELD it seeded
 * by name, never merely a 2xx, and the mount is proven by a request that
 * succeeds rather than by one that fails.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { uuidv7 } from '@oxyhq/db';

import type { Database } from '../../db/postgres.js';

/** Unique to this run: the throwaway database is shared across parallel FILES. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
const OPERATOR = `oxy-user-cls-${RUN}`;

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => OPERATOR,
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

let db: Database;
let closePostgres: () => Promise<void>;
let server: Server;
let base: string;

/** The fixture tree, all ids namespaced by RUN so nothing collides with a sibling file. */
const CAT = {
  root: `cat-root-${RUN}`,
  electronics: `cat-elec-${RUN}`,
  phones: `cat-phon-${RUN}`,
  foldables: `cat-fold-${RUN}`,
  cameras: `cat-cams-${RUN}`,
  audio: `cat-audio-${RUN}`,
  deprecated: `cat-dead-${RUN}`,
  suppressed: `cat-supp-${RUN}`,
  /** Published but NOT selectable, and in a branch unrelated to `phones`. */
  structural: `cat-struct-${RUN}`,
  /**
   * A SELECTABLE grouping and a child of it, for the parent-guard ancestor case.
   *
   * `root` is the obvious ancestor to re-point a primary at and it is useless
   * here: it is `selectable: false`, so the pre-existing
   * `mercaria_category_assignment_selectable` refuses that update whether or not
   * the parent guard exists — and the test passes while proving nothing. That is
   * not hypothetical; mutation-testing this file with both parent guards
   * disabled left exactly that case green, and this pair is the fix.
   */
  imaging: `cat-imaging-${RUN}`,
  lenses: `cat-lenses-${RUN}`,
} as const;

const LISTING_ID = `lst-${RUN}`;
let canonicalProductId = '';
const SELLER_ID = `oxy-seller-${RUN}`;

interface Json {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function request(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body['data'] ?? {}) as Record<string, unknown>;
}

/** The message a refusal carried, wherever this app's envelope puts it. */
function refusalText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

/** One valid body, so each case varies exactly the field it is about. */
function validBody(categoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    categoryId,
    reason: 'multi_function_product',
    justification: 'It is genuinely also the camera people buy it for.',
    ...overrides,
  };
}

beforeAll(async () => {
  // `config/index.ts` reads `process.env` once at import and freezes it, and
  // `app.ts` decides every `/internal/*` mount from that frozen value — so the
  // allow-list has to be set BEFORE the graph loads. The
  // `catalog-rollout.realdb.test.ts` device.
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = OPERATOR;
  vi.resetModules();

  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;

  const { categories, listings } = await import('../../db/schema/catalog.js');
  const { canonicalProducts } = await import('../../db/schema/canonicalCatalog.js');

  await db.insert(categories).values([
    {
      id: CAT.root,
      key: `r${RUN}`,
      name: 'Root',
      slug: `root-${RUN}`,
      ancestorIds: [],
      ancestorSlugs: [],
      selectable: false,
    },
    {
      id: CAT.electronics,
      key: `r${RUN}.electronics`,
      name: 'Electronics',
      slug: `electronics-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
    },
    {
      id: CAT.phones,
      key: `r${RUN}.electronics.phones`,
      name: 'Phones',
      slug: `phones-${RUN}`,
      parentId: CAT.electronics,
      ancestorIds: [CAT.root, CAT.electronics],
      ancestorSlugs: [`root-${RUN}`, `electronics-${RUN}`],
    },
    {
      id: CAT.foldables,
      key: `r${RUN}.electronics.phones.foldables`,
      name: 'Foldables',
      slug: `foldables-${RUN}`,
      parentId: CAT.phones,
      ancestorIds: [CAT.root, CAT.electronics, CAT.phones],
      ancestorSlugs: [`root-${RUN}`, `electronics-${RUN}`, `phones-${RUN}`],
    },
    {
      id: CAT.cameras,
      key: `r${RUN}.cameras`,
      name: 'Cameras',
      slug: `cameras-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
    },
    {
      id: CAT.audio,
      key: `r${RUN}.audio`,
      name: 'Audio',
      slug: `audio-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
    },
    {
      id: CAT.deprecated,
      key: `r${RUN}.deprecated`,
      name: 'Deprecated',
      slug: `deprecated-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
      lifecycle: 'deprecated',
    },
    {
      id: CAT.suppressed,
      key: `r${RUN}.holdingpen`,
      name: 'Holding pen',
      slug: `holdingpen-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
      lifecycle: 'suppressed',
    },
    {
      id: CAT.structural,
      key: `r${RUN}.grouping`,
      name: 'Grouping',
      slug: `grouping-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
      selectable: false,
    },
    {
      id: CAT.imaging,
      key: `r${RUN}.imaging`,
      name: 'Imaging',
      slug: `imaging-${RUN}`,
      parentId: CAT.root,
      ancestorIds: [CAT.root],
      ancestorSlugs: [`root-${RUN}`],
    },
    {
      id: CAT.lenses,
      key: `r${RUN}.imaging.lenses`,
      name: 'Lenses',
      slug: `lenses-${RUN}`,
      parentId: CAT.imaging,
      ancestorIds: [CAT.root, CAT.imaging],
      ancestorSlugs: [`root-${RUN}`, `imaging-${RUN}`],
    },
  ]);

  /**
   * A P2P listing, not a store one, and that is deliberate rather than the
   * cheaper fixture.
   *
   * `owner_type = 'user'` is the half of the marketplace that
   * `provisional-products.ts` leaves PERMANENTLY unattached to any canonical
   * product (`p2p_left_unattached`), which is the reason classification lives on
   * listings at all and not only on the canonical graph. Proving the listing
   * path against a store listing would exercise the one case that has a
   * canonical alternative.
   *
   * It also removes the `stores` row the first draft needed, so the fixture
   * touches one fewer table.
   */
  await db.insert(listings).values({
    id: LISTING_ID,
    ownerType: 'user',
    oxyUserId: SELLER_ID,
    title: `Listing ${RUN}`,
    description: 'A fixture listing.',
    // #90's pair, and the two columns answer different questions: `condition`
    // is the nine-key taxonomy, `condition_assertion` is WHO asserted it.
    condition: 'used_good',
    conditionAssertion: 'seller_declared',
    handle: `listing-${RUN}`,
    categoryId: CAT.phones,
    categorySlugs: [`root-${RUN}`, `electronics-${RUN}`, `phones-${RUN}`],
  });

  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Product ${RUN}`,
      normalizedName: `product ${RUN}`,
      slug: `product-${RUN}`,
      categoryId: CAT.phones,
    })
    .returning();
  if (!product) throw new Error('canonical product insert returned no row');
  canonicalProductId = product.id;

  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  // Guarded: a `beforeAll` that threw before the listener was created leaves
  // `server` undefined, and an unguarded `.close()` replaces the real failure
  // with a TypeError from teardown — which is the error that gets reported.
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const { canonicalProductSecondaryCategories, listingSecondaryCategories } = await import(
    '../../db/schema/taxonomyClassification.js'
  );
  const { categories, listings } = await import('../../db/schema/catalog.js');
  const { eq, inArray } = await import('drizzle-orm');

  // Children first: both subject foreign keys are `cascade`, but the CATEGORY
  // side is `restrict`, so the categories cannot go until every classification
  // naming them has.
  await db
    .delete(listingSecondaryCategories)
    .where(eq(listingSecondaryCategories.listingId, LISTING_ID));
  await db
    .delete(canonicalProductSecondaryCategories)
    .where(eq(canonicalProductSecondaryCategories.canonicalProductId, canonicalProductId));
  await db.delete(listings).where(eq(listings.id, LISTING_ID));
  // Routed through the shared helper rather than a direct delete, and
  // `canonical-fixture-census.test.ts` fails the build on the direct form. The
  // reason is a measured one: the matcher's retrieval is a trigram scan over
  // EVERY `canonical_products` row, so a sibling file's `runMatch` can record a
  // `match_decisions` row citing this file's fixture, and both citing columns
  // are `ON DELETE restrict` — a direct delete then fails teardown with 23503
  // in a file that did nothing wrong. The helper DECLINES exactly the pinned
  // ids instead of deleting a sibling's row.
  const { deleteTestCanonicalRows } = await import('../../db/__tests__/canonical-teardown.js');
  await deleteTestCanonicalRows(db, { productIds: [canonicalProductId] });
  // Deepest category first — `parent_id` is `restrict` too.
  await db
    .delete(categories)
    .where(
      inArray(categories.id, [
        CAT.foldables,
        CAT.phones,
        CAT.electronics,
        CAT.cameras,
        CAT.audio,
        CAT.deprecated,
        CAT.suppressed,
        CAT.structural,
        CAT.lenses,
        CAT.imaging,
        CAT.root,
      ]),
    );

  await closePostgres();
}, 180_000);

describe('the surface is mounted and gated', () => {
  it('serves a subject that exists, which is what proves the mount', async () => {
    const response = await request('GET', `/internal/taxonomy/classifications/listing/${LISTING_ID}`);
    expect(response.status).toBe(200);
    const body = data(response.body);
    // A seeded FIELD by name, not merely a 2xx: a 200 with an empty envelope is
    // what a missing handler and a real answer both look like.
    expect(body['state']).toBe('classified');
    expect((body['primary'] as Record<string, unknown>)['categoryId']).toBe(CAT.phones);
  });

  it('404s a subject that does not exist, distinguishably from the mount being absent', async () => {
    const response = await request(
      'GET',
      `/internal/taxonomy/classifications/listing/no-such-${RUN}`,
    );
    expect(response.status).toBe(404);
  });

  it('refuses a subject KIND the domain has no table for', async () => {
    const response = await request(
      'GET',
      `/internal/taxonomy/classifications/canonical_variant/${LISTING_ID}`,
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('canonical_variant');
  });
});

describe('filing a secondary classification over HTTP', () => {
  it('accepts an unrelated, selectable, published category and returns the row', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.cameras),
    );
    expect(response.status).toBe(201);
    const body = data(response.body);
    expect(body['categoryId']).toBe(CAT.cameras);
    expect(body['reason']).toBe('multi_function_product');
    // The AUTHOR comes from the credential, never the body.
    expect(body['justifiedBy']).toBe(OPERATOR);
    expect(body['schemeRef']).toBeUndefined();
  });

  it('shows the filing on the composed read, beside the primary', async () => {
    const response = await request('GET', `/internal/taxonomy/classifications/listing/${LISTING_ID}`);
    const body = data(response.body);
    const secondary = body['secondary'] as Array<Record<string, unknown>>;
    expect(secondary.map((row) => row['categoryId'])).toContain(CAT.cameras);
    expect((body['primary'] as Record<string, unknown>)['categoryId']).toBe(CAT.phones);
  });

  it('refuses a SECOND filing under the same category, rather than silently keeping either', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.cameras, { justification: 'A different reason from a different person.' }),
    );
    expect(response.status).toBe(409);
  });

  it('refuses the PRIMARY category as a secondary', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.phones),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('already implies');
  });

  it('refuses an ANCESTOR of the primary', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.electronics),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('already implies');
  });

  it('refuses a DESCENDANT of the primary', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.foldables),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('already implies');
  });

  it('refuses a DEPRECATED category for a new filing', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.deprecated),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('no longer take new classifications');
  });

  it('ACCEPTS a suppressed category — the connector holding pen is assignable', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.suppressed, { justification: 'Holding pen is suppressed but assignable.' }),
    );
    expect(response.status).toBe(201);
    expect(data(response.body)['categoryId']).toBe(CAT.suppressed);
  });

  /**
   * The DISCRIMINATING selectability case.
   *
   * `CAT.structural` sits in a branch UNRELATED to the primary, so the kinship
   * guard passes it and only `mercaria_category_assignment_selectable` can
   * refuse it. A structural node that were also an ancestor would be refused by
   * the kinship guard first, and this case would pass while proving nothing
   * about selectability — the overlap that makes a new guard's test unable to
   * fail.
   */
  it('refuses a NON-SELECTABLE structural node even when it is unrelated to the primary', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.structural),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('structural node');
  });
});

describe('“justified” is enforced, not decorative', () => {
  it('refuses a blank justification', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.audio, { justification: '   ' }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a missing justification', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      { categoryId: CAT.audio, reason: 'multi_function_product' },
    );
    expect(response.status).toBe(400);
  });

  it('refuses a scheme-citing reason with no schemeRef', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.audio, { reason: 'regulatory_scheme' }),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('schemeRef');
  });

  it('refuses a judgement reason that pretends to cite a scheme', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.audio, { schemeRef: 'EU-2023/1542' }),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('schemeRef');
  });

  it('accepts a scheme-citing reason WITH its citation', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/listing/${LISTING_ID}`,
      validBody(CAT.audio, {
        reason: 'regulatory_scheme',
        schemeRef: 'EU-2023/1542',
        justification: 'The battery regulation files it here regardless of the retail branch.',
      }),
    );
    expect(response.status).toBe(201);
    expect(data(response.body)['schemeRef']).toBe('EU-2023/1542');
  });
});

describe('the reasons another domain owns are refused BY NAME', () => {
  it('names the prohibition for a merchandising placement rather than saying “invalid”', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}`,
      validBody(CAT.cameras, { reason: 'merchandising_placement' }),
    );
    expect(response.status).toBe(400);
    const text = refusalText(response.body);
    // The WORDING is the whole value of the mechanism, so this asserts the
    // answer and not merely the status — a gate on 400 alone would pass against
    // the generic membership refusal.
    expect(text).toContain('merchandising_placement');
    expect(text).toContain('another domain owns it');
  });

  it('names the prohibition for a ranking boost', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}`,
      validBody(CAT.cameras, { reason: 'search_ranking_boost' }),
    );
    expect(response.status).toBe(400);
    expect(refusalText(response.body)).toContain('another domain owns it');
  });

  it('answers isPrimary by pointing at the door that sets a primary', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}`,
      validBody(CAT.cameras, { isPrimary: true }),
    );
    expect(response.status).toBe(400);
    const text = refusalText(response.body);
    expect(text).toContain('never primary');
  });

  it('still refuses an unrecognised key it has no named answer for', async () => {
    const response = await request(
      'POST',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}`,
      validBody(CAT.cameras, { boost: 3 }),
    );
    expect(response.status).toBe(400);
  });
});

describe('the category usage read, and withdrawal', () => {
  it('counts what is filed under a category, across both subject kinds', async () => {
    await request(
      'POST',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}`,
      validBody(CAT.cameras, { justification: 'The catalogue files it under cameras too.' }),
    );

    const response = await request('GET', `/internal/taxonomy/categories/${CAT.cameras}/usage`);
    expect(response.status).toBe(200);
    const body = data(response.body);
    expect(body['listings']).toBe(1);
    expect(body['canonicalProducts']).toBe(1);
  });

  it('withdraws one, and the count follows', async () => {
    const removed = await request(
      'DELETE',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}/${CAT.cameras}`,
    );
    expect(removed.status).toBe(200);

    const usage = await request('GET', `/internal/taxonomy/categories/${CAT.cameras}/usage`);
    expect(data(usage.body)['canonicalProducts']).toBe(0);
    // The listing side is untouched — a withdrawal is scoped to its subject.
    expect(data(usage.body)['listings']).toBe(1);
  });

  it('404s withdrawing one that is not there', async () => {
    const response = await request(
      'DELETE',
      `/internal/taxonomy/classifications/canonical_product/${canonicalProductId}/${CAT.cameras}`,
    );
    expect(response.status).toBe(404);
  });
});

/**
 * Everything below bypasses the service and writes SQL directly.
 *
 * The point is that the invariants survive a writer that never calls this
 * domain's code — a migration, a backfill, `psql`, or the next service somebody
 * adds. A rule enforced only in `classification.service.ts` is a rule the second
 * writer walks around, and there is always a second writer eventually.
 */
describe('the DATABASE refuses, not merely the service', () => {
  it('refuses two primaries structurally: there is no column shape for one', async () => {
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const { listings } = await import('../../db/schema/catalog.js');
    const { canonicalProducts } = await import('../../db/schema/canonicalCatalog.js');
    const { listingSecondaryCategories, canonicalProductSecondaryCategories } = await import(
      '../../db/schema/taxonomyClassification.js'
    );

    // "Exactly one primary" is held by the primary being a SCALAR column, so the
    // proof is that there is exactly one of it and that nothing in the secondary
    // tables could claim to be one. A partial unique on `is_primary` would be
    // the alternative, and this asserts the alternative was not built.
    for (const table of [listings, canonicalProducts]) {
      const columns = getTableConfig(table).columns.filter((c) => c.name === 'categoryId');
      expect(columns).toHaveLength(1);
    }

    for (const table of [listingSecondaryCategories, canonicalProductSecondaryCategories]) {
      const names = getTableConfig(table).columns.map((c) => c.name.toLowerCase());
      expect(names).not.toContain('isprimary');
      expect(names).not.toContain('primary');
      expect(names).not.toContain('position');
      expect(names).not.toContain('sortorder');
    }
  });

  it('refuses a secondary equal to the primary, written directly', async () => {
    const { listingSecondaryCategories } = await import(
      '../../db/schema/taxonomyClassification.js'
    );
    await expect(
      db.insert(listingSecondaryCategories).values({
        listingId: LISTING_ID,
        categoryId: CAT.phones,
        reason: 'multi_function_product',
        justification: 'direct write',
        justifiedBy: OPERATOR,
        justifiedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('refuses a blank justification, written directly', async () => {
    const { listingSecondaryCategories } = await import(
      '../../db/schema/taxonomyClassification.js'
    );
    await expect(
      db.insert(listingSecondaryCategories).values({
        listingId: LISTING_ID,
        categoryId: CAT.audio,
        reason: 'multi_function_product',
        justification: '   ',
        justifiedBy: OPERATOR,
        justifiedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('refuses a scheme_ref/reason mismatch, written directly', async () => {
    const { listingSecondaryCategories } = await import(
      '../../db/schema/taxonomyClassification.js'
    );
    await expect(
      db.insert(listingSecondaryCategories).values({
        listingId: LISTING_ID,
        categoryId: CAT.audio,
        reason: 'tax_scheme',
        justification: 'no citation',
        justifiedBy: OPERATOR,
        justifiedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  /**
   * The PARENT side — the half that gets forgotten.
   *
   * The listing currently carries a secondary under `CAT.cameras`. Re-pointing
   * its PRIMARY there would make that secondary the primary, silently, with both
   * rows individually valid.
   */
  it('refuses re-pointing the primary onto an existing secondary', async () => {
    const { listings } = await import('../../db/schema/catalog.js');
    const { eq } = await import('drizzle-orm');
    await expect(
      db.update(listings).set({ categoryId: CAT.cameras }).where(eq(listings.id, LISTING_ID)),
    ).rejects.toThrow();
  });

  /**
   * The ancestor branch of the parent guard, against a SELECTABLE ancestor.
   *
   * `CAT.imaging` is published and selectable, so the only thing that can refuse
   * this update is `mercaria_listing_primary_category_guard` finding that the
   * listing's secondary under `CAT.lenses` is its descendant. Re-pointing at
   * `CAT.root` instead would be refused by the pre-existing selectability
   * trigger and would prove nothing about this one.
   */
  it('refuses re-pointing the primary to a SELECTABLE ancestor of an existing secondary', async () => {
    const { listings } = await import('../../db/schema/catalog.js');
    const { listingSecondaryCategories } = await import(
      '../../db/schema/taxonomyClassification.js'
    );
    const { and, eq } = await import('drizzle-orm');

    await db.insert(listingSecondaryCategories).values({
      listingId: LISTING_ID,
      categoryId: CAT.lenses,
      reason: 'multi_function_product',
      justification: 'It takes the same lens mount.',
      justifiedBy: OPERATOR,
      justifiedAt: new Date(),
    });

    await expect(
      db.update(listings).set({ categoryId: CAT.imaging }).where(eq(listings.id, LISTING_ID)),
    ).rejects.toThrow();

    // The CONTROL for this case specifically: with that secondary withdrawn,
    // the very same update succeeds. Without it, a guard that refused every
    // re-point would pass the assertion above.
    await db
      .delete(listingSecondaryCategories)
      .where(
        and(
          eq(listingSecondaryCategories.listingId, LISTING_ID),
          eq(listingSecondaryCategories.categoryId, CAT.lenses),
        ),
      );
    await db.update(listings).set({ categoryId: CAT.imaging }).where(eq(listings.id, LISTING_ID));
    await db.update(listings).set({ categoryId: CAT.phones }).where(eq(listings.id, LISTING_ID));
  });

  it('refuses CLEARING the primary while secondaries exist', async () => {
    const { listings } = await import('../../db/schema/catalog.js');
    const { eq } = await import('drizzle-orm');
    await expect(
      db.update(listings).set({ categoryId: null }).where(eq(listings.id, LISTING_ID)),
    ).rejects.toThrow();
  });

  /**
   * The NEGATIVE CONTROL for all three above.
   *
   * Without it, every one of them would pass against a trigger that refused
   * EVERY update to `listings` — which is a defect, not a guarantee, and one a
   * suite of refusals cannot see.
   */
  it('PERMITS an unrelated column update on the parent', async () => {
    const { listings } = await import('../../db/schema/catalog.js');
    const { eq } = await import('drizzle-orm');
    await db
      .update(listings)
      .set({ title: `Listing ${RUN} renamed` })
      .where(eq(listings.id, LISTING_ID));

    const [row] = await db
      .select({ title: listings.title })
      .from(listings)
      .where(eq(listings.id, LISTING_ID))
      .limit(1);
    expect(row?.title).toBe(`Listing ${RUN} renamed`);
  });

  /** And the primary CAN still move somewhere genuinely unrelated. */
  it('PERMITS re-pointing the primary to a category unrelated to every secondary', async () => {
    const { listings } = await import('../../db/schema/catalog.js');
    const { eq } = await import('drizzle-orm');
    await db
      .update(listings)
      .set({ categoryId: CAT.foldables })
      .where(eq(listings.id, LISTING_ID));

    const [row] = await db
      .select({ categoryId: listings.categoryId })
      .from(listings)
      .where(eq(listings.id, LISTING_ID))
      .limit(1);
    expect(row?.categoryId).toBe(CAT.foldables);

    // Put it back, so the teardown and any later case see the seeded state.
    await db.update(listings).set({ categoryId: CAT.phones }).where(eq(listings.id, LISTING_ID));
  });
});

/**
 * The lifecycle rule is spelled literally in hand-written SQL and as a tuple in
 * shared-types. This is what binds them: it drives ALL FIVE lifecycles through
 * the trigger and asserts accept/reject against the tuple, so a reworded trigger
 * or a widened tuple fails here rather than drifting apart silently.
 */
describe('the assignable-lifecycle tuple and the trigger agree', () => {
  it('accepts exactly the lifecycles the shared tuple names', async () => {
    const { CATEGORY_LIFECYCLES, SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES } = await import(
      '@mercaria/shared-types'
    );
    const { categories } = await import('../../db/schema/catalog.js');
    const { canonicalProductSecondaryCategories } = await import(
      '../../db/schema/taxonomyClassification.js'
    );
    const { eq, inArray } = await import('drizzle-orm');

    // A vacuity floor: five lifecycles exist, and a loop over an empty or
    // one-member list would report a clean pass having proven nothing.
    expect(CATEGORY_LIFECYCLES.length).toBe(5);
    expect(SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES.length).toBeGreaterThan(0);

    const probeIds: string[] = [];
    const accepted: string[] = [];

    for (const lifecycle of CATEGORY_LIFECYCLES) {
      const probeId = `cat-lc-${lifecycle}-${RUN}`;
      probeIds.push(probeId);
      await db.insert(categories).values({
        id: probeId,
        key: `r${RUN}.lc${lifecycle}`,
        name: `LC ${lifecycle}`,
        slug: `lc-${lifecycle}-${RUN}`,
        parentId: CAT.root,
        ancestorIds: [CAT.root],
        ancestorSlugs: [`root-${RUN}`],
        lifecycle,
        // `merged` needs a successor, a biconditional CHECK on `categories`.
        ...(lifecycle === 'merged' ? { mergedIntoCategoryId: CAT.audio } : {}),
      });

      try {
        await db.insert(canonicalProductSecondaryCategories).values({
          canonicalProductId,
          categoryId: probeId,
          reason: 'multi_function_product',
          justification: `probe for ${lifecycle}`,
          justifiedBy: OPERATOR,
          justifiedAt: new Date(),
        });
        accepted.push(lifecycle);
      } catch {
        // Refused — recorded by its absence from `accepted`.
      }
    }

    expect([...accepted].sort()).toEqual([...SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES].sort());

    await db
      .delete(canonicalProductSecondaryCategories)
      .where(inArray(canonicalProductSecondaryCategories.categoryId, probeIds));
    await db.delete(categories).where(inArray(categories.id, probeIds));
    // `merged` pointed at CAT.audio; nothing else references it.
    void eq;
  });
});
