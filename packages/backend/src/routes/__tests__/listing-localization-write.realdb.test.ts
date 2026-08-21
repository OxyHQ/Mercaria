/**
 * A seller AUTHORING their own listing's translations, driven over HTTP against
 * a real database (#814).
 *
 * ## Why this drives ROUTES and not the repository
 *
 * The gap #814 closes was never "the mechanism is wrong". #809 landed
 * `listing_localizations` with its CHECKs, its machine-write guard, its stale
 * triggers, its `exact_locale_then_base` resolution and a nineteen-case realdb
 * suite — and epic #367's box stayed unearned because nothing in production
 * could WRITE a row. That is the "green and inert" shape: a repository test
 * would have gone green the moment the repository existed, while the capability
 * the box names — a seller owning their translations — still had no door.
 *
 * So every case here goes through a URL. Two of them, because there are two
 * doors onto one listing and they authorize completely differently, and a test
 * against the shared factory would measure neither:
 *
 *  - `/seller/listings/:id/localizations` — the caller IS the owner.
 *  - `/admin/stores/:storeId/products/:id/localizations` — `loadStore` plus
 *    `requireStorePermission('products:write')` plus a store-ownership compare.
 *
 * ## The vacuity controls
 *
 * A 200 that wrote nothing and a 400 that wrote something both read as a pass
 * from the response alone, so every write case reads the ROW back and every
 * refusal case asserts the row is ABSENT afterwards. The 403 cases are aimed at
 * a listing this file created and does NOT own, rather than at a fabricated id,
 * because a fabricated id answers 404 through a different branch and would pass
 * whether or not the ownership compare exists.
 *
 * `listing-localization.realdb.test.ts` (#809) still owns the CONSTRAINTS. This
 * file deliberately re-proves exactly one of them — that the applied database
 * admits `seller` — because that is migration `0132`'s own claim and a text
 * assertion over migration SQL cannot see a later `CREATE OR REPLACE`
 * superseding what it matched.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  LOCALIZATION_PROVENANCES,
  SELLER_LOCALIZATION_PROVENANCE,
  SELLER_LOCALIZATION_STATUS,
} from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { listingLocalizations } from '../../db/schema/catalogLocalization.js';
import { storeMembers, stores } from '../../db/schema/stores.js';

/** Unique to this run: the throwaway database is SHARED across parallel files. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
const SELLER = `oxy-user-l10n-write-${RUN}`;
const STRANGER = `oxy-user-l10n-other-${RUN}`;

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => SELLER,
}));
vi.mock('../../middleware/auth.js', () => ({
  // `loadStore` reads `req.userId` to find the membership, so a pass-through
  // that only calls `next()` would 401 the store half in a file whose point is
  // that the store half works.
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = SELLER;
    next();
  },
  oxyClient: {},
  optionalAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = SELLER;
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

/** Owned by SELLER. */
let ownListingId = '';
/** Owned by STRANGER — the 403 target on the seller mount. */
let foreignListingId = '';
/** Owned by the store SELLER is a member of. */
let storeListingId = '';
/** Owned by a store SELLER is NOT a member of — the 403 target on the store mount. */
let otherStoreListingId = '';
let storeId = '';
let otherStoreId = '';

const listingIds: string[] = [];
const storeIds: string[] = [];

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(method: string, path: string, payload?: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function data(reply: Reply): Record<string, unknown> {
  return (reply.body['data'] ?? {}) as Record<string, unknown>;
}

/** The stored rows for one listing — what a response claim is checked against. */
async function rowsFor(listingId: string): Promise<
  {
    locale: string;
    status: string;
    provenance: string;
    title: string | null;
    description: string | null;
    reviewedByOxyUserId: string | null;
  }[]
> {
  return db
    .select({
      locale: listingLocalizations.locale,
      status: listingLocalizations.status,
      provenance: listingLocalizations.provenance,
      title: listingLocalizations.title,
      description: listingLocalizations.description,
      reviewedByOxyUserId: listingLocalizations.reviewedByOxyUserId,
    })
    .from(listingLocalizations)
    .where(eq(listingLocalizations.listingId, listingId));
}

async function createListing(input: {
  ownerType: 'user' | 'store';
  oxyUserId?: string;
  storeId?: string;
  title: string;
}): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: input.ownerType,
      oxyUserId: input.oxyUserId ?? null,
      storeId: input.storeId ?? null,
      title: input.title,
      description: 'the seller’s own base description',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  if (!row) throw new Error('createListing returned no row');
  listingIds.push(row.id);
  return row.id;
}

async function createStore(handle: string, member: string | null): Promise<string> {
  const [store] = await db
    .insert(stores)
    .values({ handle, name: `L10n store ${RUN}`, description: '', brandColor: '#000000' })
    .returning({ id: stores.id });
  if (!store) throw new Error('createStore returned no row');
  storeIds.push(store.id);
  if (member !== null) {
    await db.insert(storeMembers).values({
      storeId: store.id,
      oxyUserId: member,
      // `admin`, deliberately, and NOT `owner`. An `admin` holds every
      // permission EXCEPT `store:manage`, so this membership is the one that
      // fails if the mount is ever re-gated on `store:manage` — which is the
      // exact mistake #814 rejected, and a fixture with an `owner` could not
      // notice it.
      role: 'admin',
      permissions: ['products:read', 'products:write'],
      joinedAt: new Date(),
    });
  }
  return store.id;
}

beforeAll(async () => {
  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;

  ownListingId = await createListing({
    ownerType: 'user',
    oxyUserId: SELLER,
    title: `Own ${RUN}`,
  });
  foreignListingId = await createListing({
    ownerType: 'user',
    oxyUserId: STRANGER,
    title: `Foreign ${RUN}`,
  });
  storeId = await createStore(`l10nstore${RUN}`, SELLER);
  otherStoreId = await createStore(`l10nother${RUN}`, null);
  storeListingId = await createListing({
    ownerType: 'store',
    storeId,
    title: `Store ${RUN}`,
  });
  otherStoreListingId = await createListing({
    ownerType: 'store',
    storeId: otherStoreId,
    title: `Other store ${RUN}`,
  });

  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 300_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Children first: `listing_localizations.listing_id` cascades, but the
  // listings themselves are what `stores` RESTRICTs on.
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  if (storeIds.length > 0) {
    const { deleteTestStores } = await import('../../db/__tests__/store-teardown.js');
    await deleteTestStores(db, storeIds);
  }
  await closePostgres();
}, 300_000);

describe('the migration this write path depends on actually applied', () => {
  it('admits `seller` on `listing_localizations`, read back from pg_constraint', async () => {
    const rows = await db.execute<{ conname: string; def: string }>(sql`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conname = 'listing_localizations_provenance_check'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].def).toContain(`'${SELLER_LOCALIZATION_PROVENANCE}'`);
    // The positive control: every member the tuple names is admitted, so a
    // constraint that had been replaced by something narrower — which is what a
    // stale `shared-types/dist` regeneration emits — fails here rather than at a
    // seller's first write.
    for (const provenance of LOCALIZATION_PROVENANCES) {
      expect(rows[0].def).toContain(`'${provenance}'`);
    }
  });

  it('does NOT admit a provenance nobody declared — the negative control', async () => {
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def
        from pg_constraint
       where conname = 'listing_localizations_provenance_check'
    `);
    // Without this, the assertion above passes against a CHECK somebody had
    // widened to admit anything at all.
    expect(rows[0].def).not.toContain("'store'");
    expect(rows[0].def).not.toContain("'seller_authored'");
  });
});

describe('a P2P seller writing their own listing’s translations', () => {
  it('creates a row, stamped `seller` and settled by the caller', async () => {
    expect(await rowsFor(ownListingId)).toHaveLength(0);

    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/es`, {
      title: 'Bicicleta de carretera',
      description: 'Cuadro de aluminio, poco uso',
    });
    expect(reply.status).toBe(200);
    expect(data(reply)['provenance']).toBe(SELLER_LOCALIZATION_PROVENANCE);

    const rows = await rowsFor(ownListingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].locale).toBe('es');
    expect(rows[0].title).toBe('Bicicleta de carretera');
    expect(rows[0].description).toBe('Cuadro de aluminio, poco uso');
    // The three server-decided facts. None of them was in the request.
    //
    // Spelled as LITERALS and not only as the constants the write reads.
    // Asserting `toBe(SELLER_LOCALIZATION_PROVENANCE)` alone is circular — both
    // sides move together, so re-pointing the constant at `mercaria` leaves it
    // green while every seller's translation starts claiming Mercaria wrote it.
    // Measured: under that mutation only the isolation case below went red.
    expect(rows[0].provenance).toBe('seller');
    expect(rows[0].status).toBe('approved');
    expect(rows[0].provenance).toBe(SELLER_LOCALIZATION_PROVENANCE);
    expect(rows[0].status).toBe(SELLER_LOCALIZATION_STATUS);
    expect(rows[0].reviewedByOxyUserId).toBe(SELLER);
  });

  it('folds the locale, so `ES-mx` and `es-mx` are ONE row and not two', async () => {
    const first = await call('PUT', `/seller/listings/${ownListingId}/localizations/ES-MX`, {
      title: 'Bicicleta de ruta',
    });
    expect(first.status).toBe(200);
    expect(data(first)['locale']).toBe('es-mx');

    const second = await call('PUT', `/seller/listings/${ownListingId}/localizations/es-mx`, {
      title: 'Bicicleta de ruta corregida',
    });
    expect(second.status).toBe(200);

    const mexican = (await rowsFor(ownListingId)).filter((row) => row.locale === 'es-mx');
    expect(mexican).toHaveLength(1);
    // The second write is the CORRECTION, which is why the upsert is DO UPDATE.
    expect(mexican[0].title).toBe('Bicicleta de ruta corregida');
  });

  it('clears a description the second write omits, rather than inheriting it', async () => {
    await call('PUT', `/seller/listings/${ownListingId}/localizations/fr`, {
      title: 'Vélo de route',
      description: 'Cadre en aluminium',
    });
    await call('PUT', `/seller/listings/${ownListingId}/localizations/fr`, {
      title: 'Vélo de route',
    });
    const french = (await rowsFor(ownListingId)).filter((row) => row.locale === 'fr');
    expect(french).toHaveLength(1);
    // A revision that inherited half of the row it replaced is the failure the
    // repository names every column to prevent.
    expect(french[0].description).toBeNull();
  });

  it('lists every locale it has, and reads one back', async () => {
    const coverage = await call('GET', `/seller/listings/${ownListingId}/localizations`);
    expect(coverage.status).toBe(200);
    const locales = (coverage.body['data'] as { locale: string }[]).map((row) => row.locale);
    expect(locales).toEqual(expect.arrayContaining(['es', 'es-mx', 'fr']));

    const one = await call('GET', `/seller/listings/${ownListingId}/localizations/es`);
    expect(one.status).toBe(200);
    expect(data(one)['title']).toBe('Bicicleta de carretera');
  });

  it('withdraws a translation, and a repeat converges on 404', async () => {
    const removed = await call('DELETE', `/seller/listings/${ownListingId}/localizations/fr`);
    expect(removed.status).toBe(200);
    expect((await rowsFor(ownListingId)).filter((row) => row.locale === 'fr')).toHaveLength(0);

    const again = await call('DELETE', `/seller/listings/${ownListingId}/localizations/fr`);
    expect(again.status).toBe(404);
  });
});

describe('what a seller structurally cannot say', () => {
  it('refuses a body claiming a review outcome, and writes NOTHING', async () => {
    const before = await rowsFor(ownListingId);
    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/de`, {
      title: 'Rennrad',
      // `reviewed` and `approved` are `REVIEWABLE_LOCALIZATION_STATUSES` —
      // an OPERATOR review outcome, written by `catalog-governance`'s
      // `reviewLocalization` under `provenance: 'mercaria'`. The seller schema
      // declares no `status` key at all, so `.strict()` refuses the request
      // rather than a branch weighing the value. There is no shape in which a
      // seller's request expresses a review.
      status: 'reviewed',
    });
    expect(reply.status).toBe(400);
    // The control that matters: a 400 that had already written is a pass from
    // the status code alone.
    expect(await rowsFor(ownListingId)).toHaveLength(before.length);
  });

  it('refuses a body claiming a `mercaria` provenance, and writes NOTHING', async () => {
    const before = await rowsFor(ownListingId);
    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/de`, {
      title: 'Rennrad',
      provenance: 'mercaria',
    });
    expect(reply.status).toBe(400);
    expect(await rowsFor(ownListingId)).toHaveLength(before.length);
  });

  it('refuses a body naming somebody else as the settling account', async () => {
    const before = await rowsFor(ownListingId);
    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/de`, {
      title: 'Rennrad',
      reviewedByOxyUserId: STRANGER,
    });
    expect(reply.status).toBe(400);
    expect(await rowsFor(ownListingId)).toHaveLength(before.length);
  });

  it('refuses the BASE locale — those words live on the listing itself', async () => {
    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/en`, {
      title: 'A second English title',
    });
    expect(reply.status).toBe(400);
    expect((await rowsFor(ownListingId)).filter((row) => row.locale === 'en')).toHaveLength(0);
  });

  it('refuses a locale Mercaria does not author in', async () => {
    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/sw-ke`, {
      title: 'Baiskeli',
    });
    expect(reply.status).toBe(400);
  });

  it('refuses a blank title', async () => {
    const reply = await call('PUT', `/seller/listings/${ownListingId}/localizations/it`, {
      title: '   ',
    });
    expect(reply.status).toBe(400);
    expect((await rowsFor(ownListingId)).filter((row) => row.locale === 'it')).toHaveLength(0);
  });

  it('never mints a row a machine could then overwrite', async () => {
    // `HUMAN_SETTLED_LOCALIZATION_STATUSES` is what the machine-write guard
    // protects, and a seller's own words being inside it is the point of
    // choosing `approved`: a later machine retranslation is refused by the
    // trigger rather than silently replacing them.
    const rows = await rowsFor(ownListingId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['reviewed', 'approved']).toContain(row.status);
    }
  });
});

describe('somebody else’s listing', () => {
  it('answers 403 on the seller mount, and writes nothing', async () => {
    const reply = await call('PUT', `/seller/listings/${foreignListingId}/localizations/es`, {
      title: 'No es mío',
    });
    // 403 and not 404, matching both halves this surface mounts under
    // (`seller-listings.controller.ts` and `products-admin.controller.ts`).
    // #92's indistinguishable-404 posture is deliberately NOT copied: there the
    // key is an ACCOUNT id and enumeration is the risk, here it is a listing id
    // the caller already had.
    expect(reply.status).toBe(403);
    expect(await rowsFor(foreignListingId)).toHaveLength(0);
  });

  it('refuses a READ of it too, not only the write', async () => {
    const reply = await call('GET', `/seller/listings/${foreignListingId}/localizations`);
    expect(reply.status).toBe(403);
  });
});

describe('a store member writing a store product’s translations', () => {
  it('creates a row through the admin mount, stamped exactly as the seller mount does', async () => {
    expect(await rowsFor(storeListingId)).toHaveLength(0);

    const reply = await call(
      'PUT',
      `/admin/stores/${storeId}/products/${storeListingId}/localizations/es`,
      { title: 'Camiseta de algodón' },
    );
    expect(reply.status).toBe(200);

    const rows = await rowsFor(storeListingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Camiseta de algodón');
    // ONE vocabulary for both doors. A store's translation is not a different
    // KIND of fact from an individual's, which is why `LOCALIZATION_PROVENANCES`
    // gained `seller` and not `store` — `ConditionActor`, the actor vocabulary
    // this repository already uses for "a person editing a listing they own",
    // has `seller | operator | source | migration` and no `store` member, and
    // the store-side listing edit passes `{kind: 'seller'}` too.
    expect(rows[0].provenance).toBe('seller');
    expect(rows[0].status).toBe('approved');
    expect(rows[0].provenance).toBe(SELLER_LOCALIZATION_PROVENANCE);
    expect(rows[0].status).toBe(SELLER_LOCALIZATION_STATUS);
    expect(rows[0].reviewedByOxyUserId).toBe(SELLER);
  });

  it('reads the coverage back', async () => {
    const reply = await call(
      'GET',
      `/admin/stores/${storeId}/products/${storeListingId}/localizations`,
    );
    expect(reply.status).toBe(200);
    expect((reply.body['data'] as unknown[]).length).toBe(1);
  });

  it('refuses a product belonging to another store', async () => {
    const reply = await call(
      'PUT',
      `/admin/stores/${storeId}/products/${otherStoreListingId}/localizations/es`,
      { title: 'No es de esta tienda' },
    );
    expect(reply.status).toBe(403);
    expect(await rowsFor(otherStoreListingId)).toHaveLength(0);
  });

  it('refuses a caller with no membership of the store in the path', async () => {
    // SELLER is a member of `storeId` and of no other store, so this is
    // `requireStorePermission` answering rather than the ownership compare.
    const reply = await call(
      'PUT',
      `/admin/stores/${otherStoreId}/products/${otherStoreListingId}/localizations/es`,
      { title: 'Tampoco' },
    );
    expect([401, 403, 404]).toContain(reply.status);
    expect(await rowsFor(otherStoreListingId)).toHaveLength(0);
  });
});

describe('the operator review path is a different path, on different entities', () => {
  it('cannot name a listing at all', async () => {
    const { REVIEWABLE_LOCALIZATION_STATUSES } = await import(
      '../../services/catalog-governance/review.service.js'
    );
    // The review path owns `reviewed | approved | stale` — on `category` and
    // `product_type`. Its input union has no member that could name a listing,
    // so `listing_localizations` is unreachable from it: the separation is
    // structural rather than a permission check, and this is what pins it.
    expect([...REVIEWABLE_LOCALIZATION_STATUSES]).toEqual(['reviewed', 'approved', 'stale']);

    // …and every row this file's seller wrote is distinguishable from one that
    // path would write, in ONE column, which is the whole reason a new
    // provenance member was needed rather than a reused one.
    const written = await db
      .select({ provenance: listingLocalizations.provenance })
      .from(listingLocalizations)
      .where(
        and(
          inArray(listingLocalizations.listingId, [ownListingId, storeListingId]),
          eq(listingLocalizations.provenance, 'mercaria'),
        ),
      );
    expect(written).toHaveLength(0);
  });
});
