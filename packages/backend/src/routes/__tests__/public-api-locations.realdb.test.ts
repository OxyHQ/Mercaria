/**
 * The PUBLIC location reads (#1017, ADR 0013) over real HTTP against a real
 * database and a FAKE GoWay behind the SDK's own `fetch` seam — the routes a
 * GoWay place page renders "products at this store" from.
 *
 * It drives the real `createApp()` chain, exactly as `public-api.realdb.test.ts`
 * does for the catalogue, and proves what only these routes decide:
 *
 * - the STATUS rules: 404 for a location never published, 410 for one
 *   withdrawn, returned to draft, restricted, deactivated, in a store that is
 *   not live, or whose GoWay place no longer vouches for it; and 503 — never
 *   410 — when GoWay cannot be asked and nothing recent is cached;
 * - the TRUST LINK's effects, live: a place that stops naming the location
 *   takes it out of the detail read and every list at the next read, and a
 *   place that names it again brings it back;
 * - AVAILABILITY bounding: three words at the location's own threshold, a stale
 *   count treated as nothing, `exactQuantity` only where the merchant discloses
 *   it and the count is fresh;
 * - CURSOR fingerprinting: a cursor is bound to the location and its filters;
 * - and that no place fact (GoWay's) and no operational or moderation fact
 *   (Mercaria's own) reaches a body.
 *
 * The auth stand-in is `public-api.realdb.test.ts`'s, for the same reasons.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { eq } from 'drizzle-orm';
import { MERCARIA_PUBLIC_API_BASE_PATH, type MercariaPublicErrorCode } from '@mercaria/contracts';
import type { Database } from '../../db/postgres.js';
import { locationPublications } from '../../db/schema/pickup.js';
import { createFakeGoWay, type FakeGoWay } from '../../services/goway/__tests__/fake-goway.js';
import { exactKeys } from './public-api-fixtures.js';
import {
  checkLocation,
  checkLocationProduct,
  createLocationWorld,
} from './public-api-location-fixtures.js';

const world = createLocationWorld();
const { ids, SENTINEL, TERM, storeHandle, placeOf, place, FRESH, STALE } = world;

const levers = vi.hoisted(() => ({ placeCacheTtlSeconds: 60 }));

vi.mock('../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      goway: {
        ...actual.config.goway,
        get placeCacheTtlSeconds() {
          return levers.placeCacheTtlSeconds;
        },
        placeStaleTtlSeconds: 24 * 60 * 60,
      },
    },
  };
});

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    middleware: {
      auth:
        () =>
        (_req: express.Request, _res: express.Response, next: express.NextFunction): void => {
          next();
        },
    },
    assets: { publicUrl: (fileId: string) => `https://media.test.invalid/${fileId}` },
    users: {
      get: (id: string) =>
        Promise.resolve({ id, username: 'nobody', name: { displayName: 'Nobody' } }),
    },
  },
  authenticateToken: (_req: express.Request, res: express.Response): void => {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  },
  optionalAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ): void => {
    next();
  },
}));

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

/** Every body this file received, for the census at the end. */
const BODIES: string[] = [];

let db: Database;
let closePostgres: () => Promise<void>;
let server: Server;
let base: string;
let webOrigin: string;
let goway: FakeGoWay;
let clearPlaceCache: () => void;

async function call(path: string): Promise<Answer> {
  const response = await fetch(`${base}${MERCARIA_PUBLIC_API_BASE_PATH}${path}`);
  const text = await response.text();
  BODIES.push(text);
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function expectFailure(answer: Answer, status: number, code: MercariaPublicErrorCode): void {
  expect(answer.status, answer.text).toBe(status);
  const error = exactKeys(answer.body, ['error'], 'error body')['error'] as Record<string, unknown>;
  expect(error['code']).toBe(code);
}

function items(answer: Answer): Record<string, unknown>[] {
  expect(answer.status, answer.text).toBe(200);
  const page = exactKeys(answer.body, ['items', 'nextCursor'], 'page');
  return page['items'] as Record<string, unknown>[];
}

function locationIds(answer: Answer): string[] {
  return items(answer).map((item, index) => {
    const location = checkLocation(item, `items[${index}]`);
    return (location['ref'] as { id: string }).id;
  });
}

/** The location products of one page, keyed by product id. */
function stockByProduct(answer: Answer): Map<string, Record<string, unknown>> {
  return new Map(
    items(answer).map((item, index) => {
      const product = checkLocationProduct(item, `items[${index}]`);
      return [(product['product'] as { ref: { id: string } }).ref.id, product];
    }),
  );
}

/** Walk every page of a list, asserting no duplicate. */
async function walk(path: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const answer = await call(
      `${path}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    for (const item of items(answer)) {
      const ref = (item['ref'] ?? (item['product'] as { ref: unknown }).ref) as { id: string };
      seen.push(ref.id);
    }
    cursor = answer.body['nextCursor'] as string | null;
    pages += 1;
    expect(pages).toBeLessThan(20);
  } while (cursor !== null);
  expect(new Set(seen).size, 'a page repeated an item').toBe(seen.length);
  return { ids: seen, pages };
}

beforeAll(async () => {
  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;
  const { config } = await import('../../config/index.js');
  webOrigin = config.web.origin.replace(/\/+$/u, '');

  goway = createFakeGoWay();
  const { useGoWayTransportForTests } = await import('../../services/goway/client.js');
  useGoWayTransportForTests({ apiBaseUrl: goway.apiBaseUrl, fetch: goway.fetch });
  clearPlaceCache = (await import('../../services/goway/cache.js')).clearPlaceCacheForTests;

  await world.seed(db, goway);

  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 300_000);

beforeEach(() => {
  clearPlaceCache();
  world.resetPlaces(goway);
  goway.down = false;
  goway.requests.length = 0;
  levers.placeCacheTtlSeconds = 60;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const { useGoWayTransportForTests } = await import('../../services/goway/client.js');
  useGoWayTransportForTests(null);
  await world.cleanup(db);
  await closePostgres();
}, 300_000);

/* -------------------------------------------------------------------------- */
/* GET /locations/:id                                                         */
/* -------------------------------------------------------------------------- */

describe('GET /public/v1/locations/:id', () => {
  it('serves a vouched-for location: Mercaria’s half, and the place id to read the rest from', async () => {
    const answer = await call(`/locations/${ids.linked}`);
    expect(answer.status, answer.text).toBe(200);
    const location = checkLocation(answer.body, 'location');
    expect(location).toEqual({
      ref: { kind: 'location', id: ids.linked },
      goWayPlaceId: placeOf('linked'),
      store: {
        ref: { kind: 'store', id: ids.store },
        handle: storeHandle,
        name: expect.any(String),
        logoUrl: expect.stringMatching(/^https:\/\/media\.test\.invalid\//u),
      },
      pickup: {
        identityRequirement: 'collection_code',
        paymentRequirement: 'prepaid',
        instructions: 'Ring at the side door',
      },
      discoverable: true,
      url: `${webOrigin}/stores/${storeHandle}?location=${ids.linked}`,
    });
  });

  it('says a paused or collection-less location is not discoverable, without saying why', async () => {
    const paused = checkLocation((await call(`/locations/${ids.paused}`)).body, 'paused');
    expect(paused['discoverable']).toBe(false);
    expect(paused['pickup']).not.toBeNull();
    const noPickup = checkLocation((await call(`/locations/${ids.noPickup}`)).body, 'noPickup');
    expect(noPickup['discoverable']).toBe(false);
    expect(noPickup['pickup']).toBeNull();
  });

  it('answers 404 for a location never published, unknown or malformed', async () => {
    for (const id of [ids.draftNever, '019a0000-0000-7000-8000-000000000000', 'not-an-id']) {
      expectFailure(await call(`/locations/${id}`), 404, 'not_found');
    }
  });

  it('answers 410 for one withdrawn, back to draft, restricted, deactivated, or whose store is not live', async () => {
    for (const id of [
      ids.withdrawn,
      ids.draftAfter,
      ids.restricted,
      ids.inactive,
      ids.inSuspendedStore,
    ]) {
      expectFailure(await call(`/locations/${id}`), 410, 'gone');
    }
  });

  it('answers 410 for one whose place does not vouch for it, or that names no place', async () => {
    expectFailure(await call(`/locations/${ids.unvouched}`), 410, 'gone');
    expectFailure(await call(`/locations/${ids.noPlace}`), 410, 'gone');
  });

  it('follows the trust link live: a place that stops naming the location takes it down, and back', async () => {
    goway.places.set(
      placeOf('linked'),
      place('linked', ids.linked, {
        storeLinks: [{ locationId: ids.paused, verification: 'business_asserted' }],
      }),
    );
    expectFailure(await call(`/locations/${ids.linked}`), 410, 'gone');
    expect(locationIds(await call(`/locations?goWayPlaceId=${placeOf('linked')}`))).toEqual([]);
    expect(locationIds(await call(`/stores/${ids.store}/locations?limit=50`))).not.toContain(
      ids.linked,
    );

    clearPlaceCache();
    world.resetPlaces(goway);
    expect((await call(`/locations/${ids.linked}`)).status).toBe(200);

    clearPlaceCache();
    goway.places.delete(placeOf('linked'));
    goway.gone.set(placeOf('linked'), null);
    expectFailure(await call(`/locations/${ids.linked}`), 410, 'gone');
  });

  it('answers 503 — never 410 — when GoWay cannot be asked and nothing is cached', async () => {
    goway.down = true;
    expectFailure(await call(`/locations/${ids.linked}`), 503, 'service_unavailable');
    expectFailure(await call(`/locations/${ids.linked}/products`), 503, 'service_unavailable');
    expectFailure(await call(`/stores/${ids.store}/locations`), 503, 'service_unavailable');
    expectFailure(
      await call(`/locations?goWayPlaceId=${placeOf('linked')}`),
      503,
      'service_unavailable',
    );
  });

  it('serves the last good place through an outage once the fresh window has passed', async () => {
    expect((await call(`/locations/${ids.linked}`)).status).toBe(200);
    levers.placeCacheTtlSeconds = 0;
    goway.down = true;
    const answer = await call(`/locations/${ids.linked}`);
    expect(answer.status, answer.text).toBe(200);
    expect(goway.requests.length).toBeGreaterThan(1);
  });

  it('takes no query parameter', async () => {
    expectFailure(await call(`/locations/${ids.linked}?locale=es`), 400, 'bad_request');
  });
});

/* -------------------------------------------------------------------------- */
/* The lists                                                                  */
/* -------------------------------------------------------------------------- */

describe('GET /public/v1/locations?goWayPlaceId=', () => {
  it('lists the location a place vouches for', async () => {
    expect(locationIds(await call(`/locations?goWayPlaceId=${placeOf('linked')}`))).toEqual([
      ids.linked,
    ]);
    expect(locationIds(await call(`/locations?goWayPlaceId=${placeOf('noPickup')}`))).toEqual([
      ids.noPickup,
    ]);
  });

  it('answers an empty page for a place nobody live trades from — and asks GoWay nothing when Mercaria has no row', async () => {
    for (const label of ['unvouched', 'withdrawn', 'restricted', 'inactive', 'inSuspendedStore']) {
      expect(locationIds(await call(`/locations?goWayPlaceId=${placeOf(label)}`)), label).toEqual(
        [],
      );
    }
    goway.requests.length = 0;
    expect(locationIds(await call(`/locations?goWayPlaceId=plc-nobody-${world.RUN}`))).toEqual([]);
    expect(goway.requests).toEqual([]);
  });

  it('requires the place, and bounds it', async () => {
    expectFailure(await call('/locations'), 400, 'bad_request');
    expectFailure(
      await call(`/locations?goWayPlaceId=${'x'.repeat(129)}`),
      422,
      'validation_failed',
    );
    expectFailure(
      await call(`/locations?goWayPlaceId=${placeOf('linked')}&storeId=${ids.store}`),
      400,
      'bad_request',
    );
  });
});

describe('GET /public/v1/stores/:id/locations', () => {
  it('lists exactly the store’s served locations, page by page, with no duplicate and no gap', async () => {
    const { ids: found, pages } = await walk(`/stores/${ids.store}/locations`, 2);
    expect(new Set(found)).toEqual(new Set([ids.linked, ids.paused, ids.noPickup]));
    expect(pages).toBeGreaterThan(1);
  });

  it('gates the store first: 410 for one not live, 404 for none', async () => {
    expectFailure(await call(`/stores/${ids.suspendedStore}/locations`), 410, 'gone');
    expectFailure(
      await call('/stores/019a0000-0000-7000-8000-000000000000/locations'),
      404,
      'not_found',
    );
  });

  it('refuses a cursor minted for another list', async () => {
    const first = await call(`/stores/${ids.store}/locations?limit=1`);
    const cursor = first.body['nextCursor'] as string;
    expect(cursor).toBeTypeOf('string');
    expectFailure(
      await call(`/stores/${ids.store}/collections?cursor=${cursor}`),
      400,
      'bad_request',
    );
    expectFailure(
      await call(`/locations?goWayPlaceId=${placeOf('linked')}&cursor=${cursor}`),
      400,
      'bad_request',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* GET /locations/:id/products                                                */
/* -------------------------------------------------------------------------- */

describe('GET /public/v1/locations/:id/products', () => {
  it('lists the store’s live products stocked here — not one stocked elsewhere, archived or unstocked', async () => {
    const stock = stockByProduct(await call(`/locations/${ids.linked}/products?limit=50`));
    expect(new Set(stock.keys())).toEqual(
      new Set([ids.inStock, ids.low, ids.empty, ids.stale, ids.halfStale]),
    );
  });

  it('bounds availability at the location’s own threshold, and treats a stale count as nothing', async () => {
    const stock = stockByProduct(await call(`/locations/${ids.linked}/products?limit=50`));
    const availability = Object.fromEntries(
      [...stock].map(([id, item]) => [id, item['availability']]),
    );
    expect(availability).toEqual({
      [ids.inStock]: 'in_stock',
      [ids.low]: 'low_stock',
      [ids.empty]: 'out_of_stock',
      [ids.stale]: 'out_of_stock',
      [ids.halfStale]: 'low_stock',
    });
    // Private exact stock: no number anywhere at this location.
    for (const item of stock.values()) expect('exactQuantity' in item).toBe(false);
    // The oldest fresh confirmation a figure rests on, or the latest stale one.
    expect(stock.get(ids.halfStale)?.['stockConfirmedAt']).toBe(FRESH.toISOString());
    expect(stock.get(ids.stale)?.['stockConfirmedAt']).toBe(STALE.toISOString());
  });

  it('discloses an exact count only where the merchant opted in, and only while it is fresh', async () => {
    const stock = stockByProduct(await call(`/locations/${ids.noPickup}/products?limit=50`));
    expect(new Set(stock.keys())).toEqual(new Set([ids.inStock, ids.stale]));
    expect(stock.get(ids.inStock)).toMatchObject({ availability: 'in_stock', exactQuantity: 5 });
    expect(stock.get(ids.stale)?.['availability']).toBe('out_of_stock');
    expect('exactQuantity' in (stock.get(ids.stale) ?? {})).toBe(false);
  });

  it('filters to what is on the shelf here with inStock=true, and searches and sorts like a store', async () => {
    const inStock = stockByProduct(
      await call(`/locations/${ids.linked}/products?inStock=true&limit=50`),
    );
    expect(new Set(inStock.keys())).toEqual(new Set([ids.inStock, ids.low, ids.halfStale]));
    const searched = stockByProduct(await call(`/locations/${ids.linked}/products?q=${TERM}`));
    expect([...searched.keys()]).toEqual([ids.inStock]);
    const sorted = items(
      await call(`/locations/${ids.linked}/products?sort=price_asc&limit=50`),
    ).map((item) => (item['product'] as { price: { amount: number } }).price.amount);
    expect(sorted).toEqual([700, 900, 1_100, 1_200, 1_500]);
  });

  it('pages with a cursor bound to the location and its filters', async () => {
    const { ids: walked, pages } = await walk(
      `/locations/${ids.linked}/products?sort=price_asc`,
      2,
    );
    expect(pages).toBe(3);
    expect(walked).toEqual([ids.empty, ids.low, ids.halfStale, ids.stale, ids.inStock]);

    const cursor = (await call(`/locations/${ids.linked}/products?limit=2`)).body[
      'nextCursor'
    ] as string;
    expect(cursor).toBeTypeOf('string');
    for (const path of [
      `/locations/${ids.linked}/products?inStock=true&cursor=${cursor}`,
      `/locations/${ids.linked}/products?sort=price_desc&cursor=${cursor}`,
      `/locations/${ids.noPickup}/products?cursor=${cursor}`,
      `/stores/${ids.store}/products?cursor=${cursor}`,
    ]) {
      expectFailure(await call(path), 400, 'bad_request');
    }
  });

  it('gates the location first', async () => {
    expectFailure(await call(`/locations/${ids.withdrawn}/products`), 410, 'gone');
    expectFailure(await call(`/locations/${ids.unvouched}/products`), 410, 'gone');
    expectFailure(await call(`/locations/${ids.draftNever}/products`), 404, 'not_found');
  });

  it('refuses the same values a store’s product list refuses', async () => {
    expectFailure(
      await call(`/locations/${ids.linked}/products?sort=relevance`),
      422,
      'validation_failed',
    );
    expectFailure(
      await call(`/locations/${ids.linked}/products?inStock=yes`),
      422,
      'validation_failed',
    );
    expectFailure(await call(`/locations/${ids.linked}/products?near=1`), 400, 'bad_request');
  });
});

/* -------------------------------------------------------------------------- */
/* Publication history, and the census                                        */
/* -------------------------------------------------------------------------- */

describe('the publication history behind 404 versus 410', () => {
  it('stamps the first publication and keeps it, so a withdrawn location stays a 410', async () => {
    const { changePublicationState } = await import('../../services/pickup/publication.service.js');
    const [before] = await db
      .select({ publishedAt: locationPublications.publishedAt })
      .from(locationPublications)
      .where(eq(locationPublications.locationId, ids.draftNever));
    expect(before?.publishedAt).toBeNull();

    await changePublicationState({
      storeId: ids.store,
      locationId: ids.draftNever,
      actorOxyUserId: `oxy-user-publoc-${world.RUN}`,
      at: new Date(),
      body: { state: 'published' },
    }).catch(() => undefined);
    // Publishing runs the trust rule against the place, and `draftNever` names
    // a place the fake does not hold — so it stays a draft, never published.
    expectFailure(await call(`/locations/${ids.draftNever}`), 404, 'not_found');

    goway.places.set(placeOf('draftNever'), place('draftNever', ids.draftNever));
    await changePublicationState({
      storeId: ids.store,
      locationId: ids.draftNever,
      actorOxyUserId: `oxy-user-publoc-${world.RUN}`,
      at: new Date(),
      body: { state: 'published' },
    });
    expect((await call(`/locations/${ids.draftNever}`)).status).toBe(200);

    await changePublicationState({
      storeId: ids.store,
      locationId: ids.draftNever,
      actorOxyUserId: `oxy-user-publoc-${world.RUN}`,
      at: new Date(),
      body: { state: 'withdrawn' },
    });
    expectFailure(await call(`/locations/${ids.draftNever}`), 410, 'gone');
    const [after] = await db
      .select({ publishedAt: locationPublications.publishedAt })
      .from(locationPublications)
      .where(eq(locationPublications.locationId, ids.draftNever));
    expect(after?.publishedAt).toBeInstanceOf(Date);
  });
});

describe('the privacy census', () => {
  it('no place fact and no operational or moderation fact reaches any body', () => {
    expect(BODIES.length).toBeGreaterThanOrEqual(40);
    const everything = BODIES.join('\n');
    // The positive control: the census reads bodies carrying this file's public facts.
    expect(everything).toContain(ids.linked);
    expect(everything).toContain(placeOf('linked'));
    for (const value of Object.values(SENTINEL)) {
      expect(
        BODIES.filter((body) => body.includes(value)),
        `${value} reached a public body`,
      ).toEqual([]);
    }
  });
});
