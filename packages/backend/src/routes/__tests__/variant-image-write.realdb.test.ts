/**
 * A seller CHOOSING which gallery photographs each variant shows, driven over
 * HTTP against a real database (#855).
 *
 * ## Why this drives ROUTES and not the repository
 *
 * The gap #855 closes was never "the mechanism is wrong". #853 landed
 * `product_variant_images` with both composite foreign keys, a de-duplicating
 * writer, `findVariantImages`, hydration with the listing-gallery fallback and a
 * realdb suite covering all of it — and epic #367's box stayed unearned because
 * nothing in production could WRITE a row. `replaceVariantImages` had its own
 * definition and five test references and no production caller at all.
 *
 * That is the "green and inert" shape, and it is exactly what a repository test
 * cannot see: every case in `catalog.realdb.test.ts` passed before this PR and
 * passes after it, unchanged. So every case here goes through a URL. Two mounts,
 * because there are two doors onto one listing and they authorize completely
 * differently — a test against the shared factory would measure neither:
 *
 *  - `/seller/listings/:id/variants/:variantId/images` — the caller IS the owner.
 *  - `/admin/stores/:storeId/products/:id/variants/:variantId/images` —
 *    `loadStore` plus `requireStorePermission('products:write')` plus a
 *    store-ownership compare.
 *
 * ## The vacuity controls
 *
 * A 200 that wrote nothing and a 400 that wrote something both read as a pass
 * from the response alone, so every write case reads the ROWS back out of
 * `product_variant_images` and every refusal case asserts the stored set is
 * UNCHANGED afterwards — not merely that some rows exist, which a refusal that
 * had already deleted would still satisfy.
 *
 * The 403 cases are aimed at a listing this file created and does NOT own,
 * rather than at a fabricated id, because a fabricated id answers 404 through a
 * different branch and would pass whether or not the ownership compare exists.
 *
 * `catalog.realdb.test.ts` (#853) still owns the writer's own semantics and the
 * foreign-key refusal at repository level. This file deliberately re-proves the
 * composite key ONE way it cannot: that the applied database really carries it,
 * read back from `pg_constraint`, because a service-layer 400 in front of a
 * constraint is indistinguishable from a service-layer 400 in front of nothing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { Database } from '../../db/postgres.js';
import { listingImages, listings, productVariantImages } from '../../db/schema/catalog.js';
import { storeMembers, stores } from '../../db/schema/stores.js';

/** Unique to this run: the throwaway database is SHARED across parallel files. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
const SELLER = `oxy-user-vimg-write-${RUN}`;
const STRANGER = `oxy-user-vimg-other-${RUN}`;

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => SELLER,
}));
/**
 * What a resolved file id looks like in this file's responses.
 *
 * Deliberately NOT the identity function. `resolveMedia` is THE media
 * chokepoint, and a projection that forgot to make that hop would return a bare
 * file id — which under an identity stub is indistinguishable from a correct
 * one. Prefixing makes every response assertion below also a check that the hop
 * happened.
 */
const mediaUrl = (fileId: string): string => `https://media.test.invalid/${fileId}`;

vi.mock('../../middleware/auth.js', () => ({
  // `loadStore` reads `req.userId` to find the membership, so a pass-through
  // that only calls `next()` would 401 the store half in a file whose point is
  // that the store half works.
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = SELLER;
    next();
  },
  oxyClient: {
    // `resolveMedia` calls this for every non-absolute file id. The real SDK is
    // not reachable here and this surface renders images, so an empty object
    // makes every 200 a 500.
    getFileDownloadUrl: (fileId: string) => `https://media.test.invalid/${fileId}`,
  },
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

interface Fixture {
  readonly listingId: string;
  /** `listing_images.file_id`, in gallery order — what a client can name. */
  readonly fileIds: string[];
  /** `listing_images.id`, in gallery order — what the table actually stores. */
  readonly imageIds: string[];
  readonly variantIds: string[];
}

/** Owned by SELLER. */
let own: Fixture;
/** Owned by STRANGER — the 403 target on the seller mount. */
let foreign: Fixture;
/** Owned by the store SELLER is an `admin` of. */
let storeOwned: Fixture;
/** Owned by a store SELLER is NOT a member of — the 403 target on the store mount. */
let otherStoreOwned: Fixture;
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

function data(reply: Reply): unknown[] {
  return (reply.body['data'] ?? []) as unknown[];
}

/**
 * The STORED selections for one variant, in stored order.
 *
 * `listing_image_id`, not the file id: this is what the row actually holds, and
 * reading it back through the same projection the response uses would make a
 * projection bug invisible to every assertion in the file.
 */
async function storedFor(variantId: string): Promise<{ listingImageId: string; position: number }[]> {
  return db
    .select({
      listingImageId: productVariantImages.listingImageId,
      position: productVariantImages.position,
    })
    .from(productVariantImages)
    .where(eq(productVariantImages.variantId, variantId))
    .orderBy(asc(productVariantImages.position), asc(productVariantImages.id));
}

/** A listing with a three-photograph gallery and two variants. */
async function makeFixture(input: {
  ownerType: 'user' | 'store';
  oxyUserId?: string;
  storeId?: string;
  label: string;
}): Promise<Fixture> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: input.ownerType,
      oxyUserId: input.oxyUserId ?? null,
      storeId: input.storeId ?? null,
      title: `${input.label} ${RUN}`,
      description: 'the seller’s own base description',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('makeFixture: no listing row');
  listingIds.push(listing.id);

  // File ids are namespaced per fixture: the resolution this surface performs is
  // scoped to ONE listing's gallery, and a shared file id across two fixtures
  // would let a cross-listing case pass by accident.
  const fileIds = [0, 1, 2].map((n) => `file-${input.label}-${n}-${RUN}`);
  await db
    .insert(listingImages)
    .values(fileIds.map((fileId, position) => ({ listingId: listing.id, fileId, position })));
  const gallery = await db
    .select({ id: listingImages.id, fileId: listingImages.fileId })
    .from(listingImages)
    .where(eq(listingImages.listingId, listing.id))
    .orderBy(asc(listingImages.position), asc(listingImages.id));
  expect(gallery).toHaveLength(3);

  const { insertVariants } = await import('../../db/catalog/variantRepository.js');
  const variants = await insertVariants(
    listing.id,
    ['Blue', 'Red'].map((title, position) => ({
      title,
      position,
      optionValues: [],
      priceAmount: 1_000,
      priceCurrency: 'FAIR' as const,
      inventoryTracked: true,
      inventoryAvailable: 5,
    })),
  );
  expect(variants).toHaveLength(2);

  return {
    listingId: listing.id,
    fileIds: gallery.map((g) => g.fileId),
    imageIds: gallery.map((g) => g.id),
    variantIds: variants.map((v) => v.id),
  };
}

async function createStore(handle: string, member: string | null): Promise<string> {
  const [store] = await db
    .insert(stores)
    .values({ handle, name: `Variant image store ${RUN}`, description: '', brandColor: '#000000' })
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
      // exact mistake #855 rejected, and a fixture with an `owner` could not
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

  own = await makeFixture({ ownerType: 'user', oxyUserId: SELLER, label: 'own' });
  foreign = await makeFixture({ ownerType: 'user', oxyUserId: STRANGER, label: 'foreign' });
  storeId = await createStore(`vimgstore${RUN}`, SELLER);
  otherStoreId = await createStore(`vimgother${RUN}`, null);
  storeOwned = await makeFixture({ ownerType: 'store', storeId, label: 'store' });
  otherStoreOwned = await makeFixture({
    ownerType: 'store',
    storeId: otherStoreId,
    label: 'otherstore',
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
  // Children first: `product_variant_images` and `listing_images` both cascade
  // from the listing, but the listings themselves are what `stores` RESTRICTs on.
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  if (storeIds.length > 0) {
    const { deleteTestStores } = await import('../../db/__tests__/store-teardown.js');
    await deleteTestStores(db, storeIds);
  }
  await closePostgres();
}, 300_000);

describe('the constraint this write path leans on actually exists', () => {
  it('carries the composite listing-image foreign key, read from pg_constraint', async () => {
    const rows = await db.execute<{ conname: string; def: string }>(sql`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conname = 'product_variant_images_listing_image_fk'
    `);
    expect(rows.length).toBe(1);
    // BOTH columns. A single-column key onto `listing_images(id)` would look
    // identical in a functional test and would admit another listing's
    // photograph, which is the whole thing this table's shape prevents.
    expect(rows[0].def).toMatch(/FOREIGN KEY \(listing_image_id, listing_id\)/u);
    expect(rows[0].def).toMatch(/REFERENCES listing_images\(id, listing_id\)/u);
  });

  it('carries the composite VARIANT foreign key too', async () => {
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def
        from pg_constraint
       where conname = 'product_variant_images_variant_fk'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].def).toMatch(/FOREIGN KEY \(variant_id, listing_id\)/u);
  });

  it('still refuses a foreign photograph BENEATH the route — the FK is the authority', async () => {
    // The route answers 400 at the gallery resolution, which is a service-layer
    // answer. This asserts the constraint underneath it would refuse anyway, so
    // the 400 is an honest message in front of a real wall rather than the only
    // thing standing there. Aimed at the writer directly, bypassing the
    // resolution the route performs.
    const { replaceVariantImages } = await import('../../db/catalog/variantRepository.js');
    await expect(
      replaceVariantImages(own.listingId, own.variantIds[0], [foreign.imageIds[0]]),
    ).rejects.toMatchObject({ cause: { code: '23503' } });

    // Positive control: the same call with this listing's own photograph works,
    // so the refusal is about the LISTING and not about the call shape.
    await replaceVariantImages(own.listingId, own.variantIds[0], [own.imageIds[0]]);
    expect(await storedFor(own.variantIds[0])).toHaveLength(1);
    await replaceVariantImages(own.listingId, own.variantIds[0], []);
  });
});

describe('a P2P seller choosing photographs for their own variant', () => {
  const url = (f: Fixture, v: number): string =>
    `/seller/listings/${f.listingId}/variants/${f.variantIds[v]}/images`;

  it('writes a selection in the CALLER’s order, and stores gallery row ids', async () => {
    expect(await storedFor(own.variantIds[0])).toHaveLength(0);

    // Caller order c, a — deliberately not gallery order, so a handler that
    // ignored the body and stored the gallery would fail here.
    const reply = await call('PUT', url(own, 0), {
      fileIds: [own.fileIds[2], own.fileIds[0]],
    });
    expect(reply.status).toBe(200);

    const stored = await storedFor(own.variantIds[0]);
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.listingImageId)).toEqual([own.imageIds[2], own.imageIds[0]]);
    // Positions are assigned from the caller's array, never taken from the body.
    expect(stored.map((r) => r.position)).toEqual([0, 1]);

    // And the response says the same thing, in the same order — through the
    // media chokepoint, which the prefix is what proves.
    expect(data(reply)).toHaveLength(2);
    expect((data(reply)[0] as { fileId: string }).fileId).toBe(mediaUrl(own.fileIds[2]));
  });

  it('GET reads back exactly what was selected, and no fallback', async () => {
    const reply = await call('GET', url(own, 0));
    expect(reply.status).toBe(200);
    expect((data(reply) as { fileId: string }[]).map((i) => i.fileId)).toEqual([
      mediaUrl(own.fileIds[2]),
      mediaUrl(own.fileIds[0]),
    ]);

    // The OTHER variant has selected nothing and must read as EMPTY here, not as
    // the listing's three-photograph gallery. This is an authoring view: a
    // seller has to be able to tell "I selected none" from "I selected all".
    const untouched = await call('GET', url(own, 1));
    expect(untouched.status).toBe(200);
    expect(data(untouched)).toHaveLength(0);
    expect(await storedFor(own.variantIds[1])).toHaveLength(0);
  });

  it('REPLACES rather than merging, and an empty list clears the selection', async () => {
    const replaced = await call('PUT', url(own, 0), { fileIds: [own.fileIds[1]] });
    expect(replaced.status).toBe(200);
    let stored = await storedFor(own.variantIds[0]);
    expect(stored).toHaveLength(1);
    expect(stored[0].listingImageId).toBe(own.imageIds[1]);

    // Clearing is the only way back to the listing-gallery fallback, so a
    // surface that refused an empty array would be one-way.
    const cleared = await call('PUT', url(own, 0), { fileIds: [] });
    expect(cleared.status).toBe(200);
    expect(data(cleared)).toHaveLength(0);
    stored = await storedFor(own.variantIds[0]);
    expect(stored).toHaveLength(0);
  });

  it('is idempotent, and one file named twice lands ONCE at its first position', async () => {
    const body = { fileIds: [own.fileIds[0], own.fileIds[1], own.fileIds[0]] };

    const first = await call('PUT', url(own, 0), body);
    expect(first.status).toBe(200);
    const afterFirst = await storedFor(own.variantIds[0]);
    expect(afterFirst.map((r) => r.listingImageId)).toEqual([own.imageIds[0], own.imageIds[1]]);
    expect(afterFirst.map((r) => r.position)).toEqual([0, 1]);

    // A retrying client converges instead of colliding with
    // `product_variant_images_variant_id_listing_image_id_key`.
    const second = await call('PUT', url(own, 0), body);
    expect(second.status).toBe(200);
    expect(await storedFor(own.variantIds[0])).toEqual(afterFirst);

    await call('PUT', url(own, 0), { fileIds: [] });
  });

  it('REFUSES a file that is not in this listing’s gallery, and names it', async () => {
    const before = await storedFor(own.variantIds[0]);

    // A photograph that exists — on somebody else's listing. This is the case a
    // surface taking a bare file id would turn into a second upload channel.
    const reply = await call('PUT', url(own, 0), { fileIds: [foreign.fileIds[0]] });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain(foreign.fileIds[0]);

    // Nothing moved. A 400 raised AFTER the delete would leave this empty, which
    // is why the assertion is equality against the prior set and not "> 0".
    expect(await storedFor(own.variantIds[0])).toEqual(before);
  });

  it('REFUSES a file nobody uploaded, without creating a gallery row', async () => {
    const invented = `file-never-uploaded-${RUN}`;
    const galleryBefore = await db
      .select({ id: listingImages.id })
      .from(listingImages)
      .where(eq(listingImages.listingId, own.listingId));

    const reply = await call('PUT', url(own, 0), { fileIds: [invented] });
    expect(reply.status).toBe(400);

    // The point of the whole `fileIds` spelling: this is a SELECTION surface, so
    // an unknown file must not become a `listing_images` row.
    const galleryAfter = await db
      .select({ id: listingImages.id })
      .from(listingImages)
      .where(eq(listingImages.listingId, own.listingId));
    expect(galleryAfter).toHaveLength(galleryBefore.length);
  });

  it('REFUSES an undeclared key — `position` and `alt` are not the caller’s', async () => {
    for (const body of [
      { fileIds: [own.fileIds[0]], position: 3 },
      { fileIds: [own.fileIds[0]], alt: 'the blue one' },
      { fileIds: [own.fileIds[0]], listingId: foreign.listingId },
    ]) {
      const reply = await call('PUT', url(own, 0), body);
      expect(reply.status).toBe(400);
    }
    expect(await storedFor(own.variantIds[0])).toHaveLength(0);
  });

  it('403s a listing the caller does not own, and writes NOTHING to it', async () => {
    const before = await storedFor(foreign.variantIds[0]);
    expect(before).toHaveLength(0);

    const reply = await call(
      'PUT',
      `/seller/listings/${foreign.listingId}/variants/${foreign.variantIds[0]}/images`,
      { fileIds: [foreign.fileIds[0]] },
    );
    expect(reply.status).toBe(403);
    expect(await storedFor(foreign.variantIds[0])).toHaveLength(0);

    // The READ is gated identically. A write-only gate would let a stranger
    // enumerate which photographs a seller had assigned to which configuration.
    const read = await call(
      'GET',
      `/seller/listings/${foreign.listingId}/variants/${foreign.variantIds[0]}/images`,
    );
    expect(read.status).toBe(403);
  });

  it('404s a variant of ANOTHER listing — and does not clear its selections', async () => {
    // The hazard `requireVariantId` exists for. `replaceVariantImages` opens
    // with `delete … where variant_id = $1`, which is NOT scoped by listing, so
    // a handler that trusted `:variantId` would clear a foreign variant's
    // selections and only then fail on the insert — and with an empty `fileIds`
    // there is no insert left to fail, so it would succeed at doing damage.
    // Neither foreign key can see this: they constrain rows being WRITTEN.
    const { replaceVariantImages } = await import('../../db/catalog/variantRepository.js');
    await replaceVariantImages(foreign.listingId, foreign.variantIds[0], [foreign.imageIds[1]]);
    expect(await storedFor(foreign.variantIds[0])).toHaveLength(1);

    // Own listing (403 does not fire), somebody else's variant.
    const emptied = await call(
      'PUT',
      `/seller/listings/${own.listingId}/variants/${foreign.variantIds[0]}/images`,
      { fileIds: [] },
    );
    expect(emptied.status).toBe(404);
    expect(await storedFor(foreign.variantIds[0])).toHaveLength(1);

    const withFiles = await call(
      'PUT',
      `/seller/listings/${own.listingId}/variants/${foreign.variantIds[0]}/images`,
      { fileIds: [own.fileIds[0]] },
    );
    expect(withFiles.status).toBe(404);
    expect(await storedFor(foreign.variantIds[0])).toHaveLength(1);

    await replaceVariantImages(foreign.listingId, foreign.variantIds[0], []);
  });
});

describe('a store member choosing photographs through the admin mount', () => {
  const url = (f: Fixture, store: string, v: number): string =>
    `/admin/stores/${store}/products/${f.listingId}/variants/${f.variantIds[v]}/images`;

  it('writes for a store the caller is an `admin` of — so `products:write` is the gate', async () => {
    expect(await storedFor(storeOwned.variantIds[0])).toHaveLength(0);

    const reply = await call('PUT', url(storeOwned, storeId, 0), {
      fileIds: [storeOwned.fileIds[1]],
    });
    // The membership is `admin`, which holds every permission EXCEPT
    // `store:manage`. A 200 here is what proves the mount is not gated on it.
    expect(reply.status).toBe(200);

    const stored = await storedFor(storeOwned.variantIds[0]);
    expect(stored).toHaveLength(1);
    expect(stored[0].listingImageId).toBe(storeOwned.imageIds[1]);

    const read = await call('GET', url(storeOwned, storeId, 0));
    expect(read.status).toBe(200);
    expect(data(read)).toHaveLength(1);
  });

  it('refuses a product belonging to another store, and writes nothing', async () => {
    const before = await storedFor(otherStoreOwned.variantIds[0]);
    expect(before).toHaveLength(0);

    // Reached through the store the caller IS a member of, naming a product that
    // belongs to a different one — so `requireStorePermission` passes and
    // `loadStoreProduct`'s ownership compare is the only thing that can refuse.
    const viaOwnStore = await call('PUT', url(otherStoreOwned, storeId, 0), {
      fileIds: [otherStoreOwned.fileIds[0]],
    });
    expect(viaOwnStore.status).toBe(403);
    expect(await storedFor(otherStoreOwned.variantIds[0])).toHaveLength(0);

    // And through the store that owns it, where the caller has no membership at
    // all — a different refusal, from `requireStorePermission`.
    const viaOtherStore = await call('PUT', url(otherStoreOwned, otherStoreId, 0), {
      fileIds: [otherStoreOwned.fileIds[0]],
    });
    expect(viaOtherStore.status).toBeGreaterThanOrEqual(400);
    expect(await storedFor(otherStoreOwned.variantIds[0])).toHaveLength(0);
  });

  it('does NOT swallow the sibling routes under `/:id/variants/:variantId`', async () => {
    /**
     * Why this mount names the WHOLE path.
     *
     * `router.use(prefix, mw)` runs its middleware for EVERY request matching
     * the prefix, whether or not a route inside the sub-router matches. Mounted
     * at `/:id/variants` this factory therefore sits in front of four
     * established siblings — the variant `PATCH` and `DELETE`, the inventory
     * absolute-set and the per-location levels — adding `products:write` and a
     * `validateId('id')` pass to all of them.
     *
     * ## What that is, measured, and what it is NOT
     *
     * It is NOT a live permission bug, and this test does not claim to catch
     * one. `effectivePermissions` is `ROLE_PERMISSIONS[role] ∪ explicit grants`,
     * and every role that holds `inventory:write` also holds `products:write`
     * (owner, admin and staff all hold both, and there is no mechanism that
     * REMOVES a role's permission), so no membership can be constructed that the
     * extra gate would refuse. The short prefix is a latent hazard the day a
     * permission is unbundled or a sibling with a different gate is added, not
     * a reachable defect today — which is exactly why the path spelling is
     * written down rather than left to be noticed.
     *
     * What IS observable is ROUTING, and that is what this asserts: each sibling
     * still reaches its own handler. A future mount that swallowed them — a
     * catch-all `router.use('/:id/variants', …)` whose sub-router answered 404
     * for an unmatched path instead of calling `next()` — turns these green
     * cases red.
     */
    const listingUrl = `/admin/stores/${storeId}/products/${storeOwned.listingId}`;
    const variantId = storeOwned.variantIds[1];

    // The levels READ (`products:read`) reaches its handler and answers.
    const levels = await call('GET', `${listingUrl}/variants/${variantId}/levels`);
    expect(levels.status).toBe(200);

    // The variant PATCH (`products:write`) reaches its handler and takes effect
    // — a routing assertion with a stored consequence, so a 200 from a handler
    // that never ran could not satisfy it.
    const renamed = await call('PATCH', `${listingUrl}/variants/${variantId}`, {
      title: `Renamed ${RUN}`,
    });
    expect(renamed.status).toBe(200);
    const { findVariantInListing } = await import('../../db/catalog/variantRepository.js');
    const row = await findVariantInListing(storeOwned.listingId, variantId);
    expect(row?.title).toBe(`Renamed ${RUN}`);

    // And the images route on the SAME prefix still answers — the positive
    // control, without which the two above would pass on a mount that was never
    // registered at all.
    const images = await call('GET', `${listingUrl}/variants/${variantId}/images`);
    expect(images.status).toBe(200);
  });

  it('refuses a P2P listing through the store door', async () => {
    // `own` is `ownerType: 'user'`, so `loadStoreProduct`'s
    // `ownerType !== 'store'` branch is what refuses. Without it a store admin
    // could edit an individual's listing by guessing its id.
    const reply = await call('PUT', url(own, storeId, 0), { fileIds: [own.fileIds[0]] });
    expect(reply.status).toBe(403);
    expect(await storedFor(own.variantIds[0])).toHaveLength(0);
  });
});

describe('a variant selection survives the listing gallery being rewritten', () => {
  it('keeps the selection when a connector-shaped image rewrite replays the SAME files', async () => {
    /**
     * #853's convergence, proved end to end through both real surfaces rather
     * than at the repository.
     *
     * `replaceListingImages` matches an incoming photograph to an existing row
     * by `file_id` and keeps its id, because `product_variant_images` names that
     * id and both its foreign keys CASCADE. `channel-ingest.service` sets
     * `imageFileIds` on EVERY sync that carries images, so before #853 a
     * connected Shopify or WooCommerce shop would have wiped its own variant
     * galleries on a schedule — nothing failing, nothing logged.
     *
     * `PATCH /seller/listings/:id` with `imageFileIds` is the same funnel that
     * sync reaches, so this drives the real path.
     */
    const selected = await call(
      'PUT',
      `/seller/listings/${own.listingId}/variants/${own.variantIds[0]}/images`,
      { fileIds: [own.fileIds[0], own.fileIds[2]] },
    );
    expect(selected.status).toBe(200);
    const before = await storedFor(own.variantIds[0]);
    expect(before).toHaveLength(2);

    const resync = await call('PATCH', `/seller/listings/${own.listingId}`, {
      imageFileIds: own.fileIds,
    });
    expect(resync.status).toBe(200);

    // The gallery row ids are the SAME rows, so the selections still point at
    // live photographs. Were `replaceListingImages` to delete and re-insert,
    // both cascades would have fired and this would be empty.
    expect(await storedFor(own.variantIds[0])).toEqual(before);

    const read = await call(
      'GET',
      `/seller/listings/${own.listingId}/variants/${own.variantIds[0]}/images`,
    );
    expect((data(read) as { fileId: string }[]).map((i) => i.fileId)).toEqual([
      mediaUrl(own.fileIds[0]),
      mediaUrl(own.fileIds[2]),
    ]);
  });

  it('drops the selection for a photograph the seller actually REMOVED', async () => {
    // The other half of "this is still a REPLACE": removing a photograph removes
    // it, and its variant selections go with it, exactly as the cascade intends.
    // Without this case the test above would pass against a gallery writer that
    // had simply stopped deleting anything.
    const kept = own.fileIds[0];
    const resync = await call('PATCH', `/seller/listings/${own.listingId}`, {
      imageFileIds: [kept],
    });
    expect(resync.status).toBe(200);

    const stored = await storedFor(own.variantIds[0]);
    expect(stored).toHaveLength(1);
    expect(stored[0].listingImageId).toBe(own.imageIds[0]);

    // Restore the gallery for any case that runs after this one.
    await call('PATCH', `/seller/listings/${own.listingId}`, { imageFileIds: own.fileIds });
  });
});
