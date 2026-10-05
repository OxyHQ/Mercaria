/**
 * Place facts live in GoWay (ADR 0013) — the services, against a REAL
 * database and a FAKE GoWay behind the SDK's own `fetch` seam.
 *
 * The real `@goway.to/sdk` builds every request and parses every response with
 * GoWay's contract (`goway/__tests__/fake-goway.ts`), so what is under test is
 * Mercaria's half end to end: the trust rule as the merchant's verify act and
 * the publish refusal apply it, a merge followed and audited, the nearby read
 * composed from GoWay's answer and Mercaria's stock, the collection snapshot
 * read from the place at checkout, a GoWay outage failing PICKUP closed, and the
 * shopper's coordinate reaching GoWay and nowhere else.
 *
 * The per-condition table of the rule itself is `goway/__tests__/place-facts.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';

const levers = vi.hoisted(() => ({ placeCacheTtlSeconds: 60 }));

vi.mock('../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      pickup: {
        ...actual.config.pickup,
        nearbyEnabled: true,
        storePickupEnabled: true,
        collectionCodeKey: 'a'.repeat(64),
      },
      goway: {
        ...actual.config.goway,
        apiUrl: 'https://goway.test',
        get placeCacheTtlSeconds() {
          return levers.placeCacheTtlSeconds;
        },
        placeStaleTtlSeconds: 24 * 60 * 60,
      },
    },
  };
});

import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings, productVariants, inventoryLevels } from '../../db/schema/catalog.js';
import { locations, stores } from '../../db/schema/stores.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { nativeListingLinks } from '../../db/schema/offers.js';
import { locationPublicationEvents, locationPublications } from '../../db/schema/pickup.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';
import { log } from '../../lib/logger.js';
import { MercariaError } from '../../lib/errors/error-codes.js';
import { useGoWayTransportForTests } from '../goway/client.js';
import { clearPlaceCacheForTests, inProcessPlaceCacheForTests } from '../goway/cache.js';
import { createFakeGoWay, type FakeGoWay, type FakePlace } from '../goway/__tests__/fake-goway.js';
import { verifyLocationPlaceLink } from '../pickup/place-link.service.js';
import { changePublicationState, upsertPublication } from '../pickup/publication.service.js';
import { findNearbyAvailability, suggestNearbyPlaces } from '../pickup/nearby.service.js';
import { resolvePickupForCheckout } from '../pickup/checkout-gate.js';

let db: Database;
let goway: FakeGoWay;

const RUN = uuidv7().slice(-12);

/** Barcelona, Plaça de Catalunya — the shopper. Its digits are what the privacy case hunts for. */
const SHOPPER = { latitude: 41.387412, longitude: 2.168637 };

const createdStoreIds: string[] = [];
const createdLocationIds: string[] = [];
const createdListingIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
  goway = createFakeGoWay();
  useGoWayTransportForTests({ apiBaseUrl: goway.apiBaseUrl, fetch: goway.fetch });
}, 120_000);

beforeEach(() => {
  clearPlaceCacheForTests();
  goway.down = false;
  goway.requests.length = 0;
  levers.placeCacheTtlSeconds = 60;
});

afterAll(async () => {
  useGoWayTransportForTests(null);
  await db
    .delete(nativeListingLinks)
    .where(inArray(nativeListingLinks.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));
  // `location_publications` CASCADEs into its append-only trail, so the
  // trigger has to stand down for exactly that one table — one window, one
  // table, as `docs/postgres-testing-and-migrations.md` requires.
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table location_publication_events disable trigger location_publication_events_append_only`,
    );
    await tx
      .delete(locationPublications)
      .where(inArray(locationPublications.locationId, safeIds(createdLocationIds)));
    await tx.execute(
      sql`alter table location_publication_events enable trigger location_publication_events_append_only`,
    );
  });
  await db.delete(locations).where(inArray(locations.id, safeIds(createdLocationIds)));
  await deleteTestStores(db, createdStoreIds);
  await deleteTestCanonicalRows(db, { productIds: createdProductIds, variantIds: createdVariantIds });
  await closePostgres();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `goway-${label}-${RUN}`,
      name: `GoWay store ${label} ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  createdStoreIds.push(row.id);
  return row.id;
}

/** A location, published, naming `placeId` (or no place). */
async function mintPublishedLocation(storeId: string, label: string, placeId: string | null): Promise<string> {
  const [row] = await db
    .insert(locations)
    .values({ storeId, name: `${label} ${RUN}`, type: 'retail', goWayPlaceId: placeId })
    .returning({ id: locations.id });
  createdLocationIds.push(row.id);
  await db.insert(locationPublications).values({
    locationId: row.id,
    storeId,
    publicationState: 'published',
    pickupOffered: true,
    inventorySource: 'pos',
    stockConfirmationIntervalSeconds: 3_600,
  });
  return row.id;
}

async function mintCanonicalVariant(label: string): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `GoWay product ${label} ${RUN}`,
      normalizedName: `goway product ${label} ${RUN}`,
      slug: `goway-product-${label}-${RUN}`,
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  createdProductIds.push(product.id);
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      name: 'Default',
      signature: createHash('sha256').update(`goway-${label}-${RUN}`).digest('hex'),
    })
    .returning({ id: canonicalVariants.id });
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

/** One store listing stocked at each of `locationIds`, attached to a canonical variant. */
async function mintStock(storeId: string, locationIds: readonly string[], canonicalVariantId: string): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: `GoWay listing ${RUN}`,
      description: 'under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);
  const [variant] = await db
    .insert(productVariants)
    .values({
      listingId: listing.id,
      title: 'Default Title',
      priceAmount: 2_500,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5 * locationIds.length,
    })
    .returning({ id: productVariants.id });
  for (const locationId of locationIds) {
    await db.insert(inventoryLevels).values({ variantId: variant.id, listingId: listing.id, locationId, available: 5 });
  }
  await db.insert(nativeListingLinks).values({
    productVariantId: variant.id,
    listingId: listing.id,
    canonicalVariantId,
    method: 'barcode_gtin',
    matchRule: 'test',
    status: 'active',
  });
  return variant.id;
}

/** A GoWay place a fixture location trades from, vouched for by its business unless told otherwise. */
function placeFor(locationId: string | null, overrides: Partial<FakePlace> & { id: string }): FakePlace {
  return {
    name: 'Llibreria Central',
    latitude: 41.4036,
    longitude: 2.1744,
    address: {
      street: 'Carrer de Mallorca',
      houseNumber: '401',
      city: 'Barcelona',
      postalCode: '08013',
      countryCode: 'ES',
    },
    timezone: 'Europe/Madrid',
    openingHours: { intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '00:00', closes: '00:00' })) },
    storeLinks: locationId === null ? [] : [{ locationId, verification: 'business_asserted' }],
    ...overrides,
  };
}

/** A calendar date in Europe/Madrid, `offsetDays` from today. */
function madridDate(offsetDays: number): string {
  const day = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(day);
}

async function placeIdOf(locationId: string): Promise<string | null> {
  const [row] = await db
    .select({ goWayPlaceId: locations.goWayPlaceId })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row?.goWayPlaceId ?? null;
}

async function expectMercariaError(run: () => Promise<unknown>, httpStatus: number, message?: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected a refusal, but it succeeded').toBeInstanceOf(MercariaError);
  expect((thrown as MercariaError).httpStatus).toBe(httpStatus);
  if (message) expect((thrown as MercariaError).message).toMatch(message);
}

// ── The trust rule, as the merchant reads it ────────────────────────────────

describe('the place link and the trust rule', () => {
  let storeId: string;
  beforeAll(async () => {
    storeId = await mintStore('trust');
  });

  it('is linked when the place exists, is active and names the location back as its business', async () => {
    const locationId = await mintPublishedLocation(storeId, 'linked', `place-linked-${RUN}`);
    goway.places.set(`place-linked-${RUN}`, placeFor(locationId, { id: `place-linked-${RUN}` }));

    const link = await verifyLocationPlaceLink({ storeId, locationId, actorOxyUserId: 'merchant-1', at: new Date() });
    expect(link).toMatchObject({ verdict: 'linked', missing: [], goWayPlaceId: `place-linked-${RUN}` });
    expect(link.place?.url).toBe(`https://goway.to/place/place-linked-${RUN}`);
    expect(link.storeLink).toEqual({ locationId, verification: 'business_asserted' });
  });

  const failing: readonly [string, (locationId: string, placeId: string) => void, string][] = [
    ['names no place', () => undefined, 'place_not_set'],
    ['names a place GoWay never heard of', () => undefined, 'place_not_found'],
    ['names a place GoWay removed', (_location, placeId) => goway.gone.set(placeId, null), 'place_gone'],
    [
      'names a closed place',
      (locationId, placeId) => goway.places.set(placeId, placeFor(locationId, { id: placeId, status: 'closed' })),
      'place_not_active',
    ],
    [
      'names a place that names nobody',
      (_location, placeId) => goway.places.set(placeId, placeFor(null, { id: placeId })),
      'store_link_missing',
    ],
    [
      'names a place that names ANOTHER location',
      (_location, placeId) => goway.places.set(placeId, placeFor('location-elsewhere', { id: placeId })),
      'store_link_names_other_location',
    ],
    [
      'names a place only the community says it trades from',
      (locationId, placeId) =>
        goway.places.set(
          placeId,
          placeFor(null, { id: placeId, storeLinks: [{ locationId, verification: 'community_reported' }] }),
        ),
      'store_link_unverified',
    ],
  ];
  for (const [label, arrange, gap] of failing) {
    it(`is unlinked when the location ${label}`, async () => {
      const slug = label.replace(/\W+/g, '-');
      const placeId = gap === 'place_not_set' ? null : `place-${slug}-${RUN}`;
      const locationId = await mintPublishedLocation(storeId, slug, placeId);
      if (placeId !== null) arrange(locationId, placeId);
      const link = await verifyLocationPlaceLink({ storeId, locationId, actorOxyUserId: null, at: new Date() });
      expect(link.verdict).toBe('unlinked');
      expect(link.missing).toEqual([gap]);
    });
  }

  it('fails closed when GoWay cannot be asked, rather than vouching from silence', async () => {
    const locationId = await mintPublishedLocation(storeId, 'down', `place-down-${RUN}`);
    goway.places.set(`place-down-${RUN}`, placeFor(locationId, { id: `place-down-${RUN}` }));
    goway.down = true;
    const link = await verifyLocationPlaceLink({ storeId, locationId, actorOxyUserId: null, at: new Date() });
    expect(link.missing).toEqual(['goway_unavailable']);
  });

  it('FOLLOWS a merge: re-points the location at the survivor and audits the move', async () => {
    const absorbed = `place-absorbed-${RUN}`;
    const survivor = `place-survivor-${RUN}`;
    const locationId = await mintPublishedLocation(storeId, 'merged', absorbed);
    goway.gone.set(absorbed, survivor);
    goway.places.set(survivor, placeFor(locationId, { id: survivor }));

    const link = await verifyLocationPlaceLink({ storeId, locationId, actorOxyUserId: 'merchant-1', at: new Date() });
    expect(link).toMatchObject({ verdict: 'linked', goWayPlaceId: survivor, followedMergeFrom: absorbed });
    expect(await placeIdOf(locationId)).toBe(survivor);

    const trail = await db
      .select({
        kind: locationPublicationEvents.kind,
        previous: locationPublicationEvents.previousGoWayPlaceId,
        next: locationPublicationEvents.nextGoWayPlaceId,
      })
      .from(locationPublicationEvents)
      .innerJoin(locationPublications, eq(locationPublications.id, locationPublicationEvents.publicationId))
      .where(eq(locationPublications.locationId, locationId));
    expect(trail).toEqual([{ kind: 'place_merge_followed', previous: absorbed, next: survivor }]);
  });

  it('refuses to PUBLISH a location the rule refuses, naming what is missing, and publishes it once linked', async () => {
    const placeId = `place-publish-${RUN}`;
    const locationId = await mintPublishedLocation(storeId, 'publish', placeId);
    await db.update(locationPublications).set({ publicationState: 'draft' }).where(eq(locationPublications.locationId, locationId));
    goway.places.set(placeId, placeFor(null, { id: placeId }));

    await expectMercariaError(
      () => changePublicationState({ storeId, locationId, actorOxyUserId: 'm', at: new Date(), body: { state: 'published' } }),
      400,
      /store_link_missing/,
    );

    // The merchant asserts the back-reference in GoWay; the publish re-reads
    // FRESH, so a minute-old "no" from the cache cannot refuse it.
    goway.places.set(placeId, placeFor(locationId, { id: placeId }));
    const published = await changePublicationState({
      storeId,
      locationId,
      actorOxyUserId: 'm',
      at: new Date(),
      body: { state: 'published' },
    });
    expect(published.publicationState).toBe('published');
  });

  it('saves a chosen place only once GoWay confirms it exists, storing a merge survivor', async () => {
    const locationId = await mintPublishedLocation(storeId, 'choose', null);
    const body = {
      pickupOffered: true,
      inventorySource: 'pos' as const,
      stockConfirmationIntervalSeconds: 3_600,
    };
    const save = (goWayPlaceId: string) =>
      upsertPublication({ storeId, locationId, actorOxyUserId: 'm', at: new Date(), body: { ...body, goWayPlaceId } });

    await expectMercariaError(() => save(`place-nowhere-${RUN}`), 400, /no such place/i);

    goway.gone.set(`place-old-${RUN}`, `place-new-${RUN}`);
    goway.places.set(`place-new-${RUN}`, placeFor(locationId, { id: `place-new-${RUN}` }));
    const saved = await save(`place-old-${RUN}`);
    expect(saved.goWayPlaceId).toBe(`place-new-${RUN}`);
    expect(await placeIdOf(locationId)).toBe(`place-new-${RUN}`);

    goway.down = true;
    await expectMercariaError(() => save(`place-other-${RUN}`), 503);
  });

  it('refuses a second location of the same store on the same place', async () => {
    const placeId = `place-taken-${RUN}`;
    const first = await mintPublishedLocation(storeId, 'taken-a', placeId);
    const second = await mintPublishedLocation(storeId, 'taken-b', null);
    goway.places.set(placeId, placeFor(first, { id: placeId }));
    await expectMercariaError(
      () =>
        upsertPublication({
          storeId,
          locationId: second,
          actorOxyUserId: 'm',
          at: new Date(),
          body: { goWayPlaceId: placeId, pickupOffered: true, inventorySource: 'pos', stockConfirmationIntervalSeconds: 3_600 },
        }),
      409,
    );
  });
});

// ── Nearby ──────────────────────────────────────────────────────────────────

describe('nearby availability, GoWay places × Mercaria stock', () => {
  let storeId: string;
  let canonical: { productId: string; variantId: string };
  let nearId: string;
  let fartherId: string;
  let communityId: string;
  let mergedAwayId: string;

  beforeAll(async () => {
    storeId = await mintStore('nearby');
    canonical = await mintCanonicalVariant('nearby');
    nearId = await mintPublishedLocation(storeId, 'near', `place-near-${RUN}`);
    fartherId = await mintPublishedLocation(storeId, 'farther', `place-farther-${RUN}`);
    communityId = await mintPublishedLocation(storeId, 'community', `place-community-${RUN}`);
    mergedAwayId = await mintPublishedLocation(storeId, 'merged-away', `place-absorbed-near-${RUN}`);
    await mintStock(storeId, [nearId, fartherId, communityId, mergedAwayId], canonical.variantId);
  });

  beforeEach(() => {
    // ~2 km and ~5 km from the shopper; a third the community vouches for; a
    // fourth whose location still names a place GoWay merged away.
    goway.places.set(`place-near-${RUN}`, placeFor(nearId, { id: `place-near-${RUN}` }));
    goway.places.set(
      `place-farther-${RUN}`,
      placeFor(fartherId, { id: `place-farther-${RUN}`, name: 'Llibreria Gràcia', latitude: 41.43, longitude: 2.16 }),
    );
    goway.places.set(
      `place-community-${RUN}`,
      placeFor(null, {
        id: `place-community-${RUN}`,
        latitude: 41.39,
        longitude: 2.17,
        storeLinks: [{ locationId: communityId, verification: 'community_reported' }],
      }),
    );
    goway.gone.set(`place-absorbed-near-${RUN}`, `place-survivor-near-${RUN}`);
    goway.places.set(
      `place-survivor-near-${RUN}`,
      placeFor(mergedAwayId, { id: `place-survivor-near-${RUN}`, latitude: 41.395, longitude: 2.17 }),
    );
  });

  const ask = (overrides: Partial<Parameters<typeof findNearbyAvailability>[0]> = {}) =>
    findNearbyAvailability(
      {
        canonicalVariantId: canonical.variantId,
        origin: SHOPPER,
        originSource: 'device',
        radiusMetres: 25_000,
        limit: 20,
        withCheckoutEligibility: false,
        ...overrides,
      },
      { kind: 'anonymous' },
      new Date(),
    );

  it('answers with the vouched-for locations, nearest first, from the PLACE\'s facts', async () => {
    const page = await ask();
    expect(page.results.map((result) => result.location.locationId)).toEqual([nearId, fartherId]);

    const [near] = page.results;
    expect(near.location).toMatchObject({
      goWayPlaceId: `place-near-${RUN}`,
      displayName: 'Llibreria Central',
      address: { line1: 'Carrer de Mallorca 401', city: 'Barcelona', postalCode: '08013', country: 'ES' },
      timezone: 'Europe/Madrid',
      openState: { known: true, open: true },
    });
    // GoWay measured ~2 km; what leaves is rounded OUTWARD to 100 m.
    expect(near.approximateMetres % 100).toBe(0);
    expect(near.approximateMetres).toBeGreaterThan(1_500);
    expect(near.approximateMetres).toBeLessThan(2_600);
    expect(near.distanceBand).toBe('under_5km');
  });

  it('reads each place ONCE: the nearby list carries hours exceptions, so no per-place read follows', async () => {
    goway.places.set(
      `place-near-${RUN}`,
      placeFor(nearId, {
        id: `place-near-${RUN}`,
        // Yesterday to tomorrow in the place's calendar: closed NOW, open again
        // within the discoverability horizon.
        hoursExceptions: [{ startsOn: madridDate(-1), endsOn: madridDate(1), closed: true, note: 'Refit' }],
      }),
    );
    const page = await ask({ locale: 'ca' });
    expect(goway.requests).toHaveLength(1);
    expect(goway.requests[0]).toContain('/places/nearby');
    expect(goway.requests[0]).toContain('locale=ca');
    const near = page.results.find((result) => result.location.locationId === nearId);
    // Closed by the exception the LIST carried — what a second read used to be for.
    expect(near?.location.openState).toMatchObject({ known: true, open: false, exceptionNote: 'Refit' });
  });

  it('omits a place only the community vouches for, and one GoWay merged until verify follows it', async () => {
    const page = await ask();
    const served = page.results.map((result) => result.location.locationId);
    expect(served).not.toContain(communityId);
    expect(served).not.toContain(mergedAwayId);
  });

  it('pages with GoWay\'s own cursor, and never repeats a location', async () => {
    const first = await ask({ limit: 1 });
    expect(first.nextCursor).toBeDefined();
    const seen = first.results.map((result) => result.location.locationId);
    let cursor = first.nextCursor;
    // The fake holds every place this file minted, most of them in Barcelona,
    // so the walk is long — which is the point: one place per page.
    for (let guard = 0; cursor !== undefined && guard < 100; guard += 1) {
      const next = await ask({ limit: 1, cursor });
      seen.push(...next.results.map((result) => result.location.locationId));
      cursor = next.nextCursor;
    }
    // Shorter pages are allowed (a place may hold nothing); repeats are not.
    expect(cursor, 'the walk did not reach the last page').toBeUndefined();
    expect(seen).toEqual([nearId, fartherId]);
  });

  it('drops a location whose place stopped naming it, at the next read', async () => {
    goway.places.set(`place-near-${RUN}`, placeFor(null, { id: `place-near-${RUN}` }));
    const page = await ask();
    expect(page.results.map((result) => result.location.locationId)).toEqual([fartherId]);
  });

  it('answers 503 when GoWay cannot say what is near, rather than an empty page', async () => {
    goway.down = true;
    await expectMercariaError(() => ask(), 503);
  });

  it('suggests a TYPED town only when something is collectable around it', async () => {
    goway.towns.length = 0;
    goway.towns.push(
      { name: 'Barcelona', latitude: 41.3874, longitude: 2.1686, countryCode: 'ES' },
      { name: 'Barbastro', latitude: 42.0356, longitude: 0.1265, countryCode: 'ES' },
    );
    const towns = await suggestNearbyPlaces({ canonicalVariantId: canonical.variantId, term: 'Bar', limit: 5 });
    expect(towns.map((town) => town.label)).toEqual(['Barcelona']);
    expect(towns[0].locationCount).toBe(2);
    // No term, nothing to resolve: no gazetteer enumeration.
    expect(await suggestNearbyPlaces({ canonicalVariantId: canonical.variantId, limit: 5 })).toEqual([]);
  });

  it('PRIVACY: the shopper\'s coordinate reaches GoWay and is never logged or cached', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(log.general, level));
    try {
      await ask({ withCheckoutEligibility: true });
      goway.down = true;
      await ask().catch(() => undefined);
    } finally {
      goway.down = false;
    }
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const spy of spies) spy.mockRestore();

    const digits = [String(SHOPPER.latitude), String(SHOPPER.longitude)];
    // Positive control: it WAS forwarded, for the length of the request.
    expect(goway.requests.some((url) => digits.every((digit) => url.includes(digit)))).toBe(true);
    for (const digit of digits) {
      expect(logged, 'a log line carries the shopper\'s coordinate').not.toContain(digit);
      for (const [key, entry] of inProcessPlaceCacheForTests()) {
        expect(key).not.toContain(digit);
        expect(JSON.stringify(entry)).not.toContain(digit);
      }
    }
    // The cache holds place reads by id, and only those.
    expect([...inProcessPlaceCacheForTests().keys()].every((key) => key.startsWith('goway:place:'))).toBe(true);
  });
});

// ── Checkout ────────────────────────────────────────────────────────────────

describe('a collection checkout reads its snapshot from the GoWay place', () => {
  let storeId: string;
  let locationId: string;
  let variantId: string;
  const placeId = `place-checkout-${RUN}`;

  beforeAll(async () => {
    storeId = await mintStore('checkout');
    const canonical = await mintCanonicalVariant('checkout');
    locationId = await mintPublishedLocation(storeId, 'checkout', placeId);
    variantId = await mintStock(storeId, [locationId], canonical.variantId);
  });

  beforeEach(() => {
    goway.places.set(placeId, placeFor(locationId, { id: placeId, name: 'Llibreria del Pi' }));
  });

  const resolve = () =>
    resolvePickupForCheckout({
      locationId,
      actor: { kind: 'oxy', oxyUserId: `buyer-${RUN}` } as Parameters<typeof resolvePickupForCheckout>[0]['actor'],
      lines: [{ sellerKey: `store:${storeId}`, sellerType: 'store', variantId, quantity: 1 }],
      at: new Date(),
    });

  it('freezes the place\'s name, address, timezone and id', async () => {
    const pickup = await resolve();
    expect(pickup).toMatchObject({
      locationId,
      goWayPlaceId: placeId,
      displayName: 'Llibreria del Pi',
      publicLine1: 'Carrer de Mallorca 401',
      publicCity: 'Barcelona',
      publicPostalCode: '08013',
      publicCountry: 'ES',
      timezone: 'Europe/Madrid',
    });
  });

  it('refuses a collection whose place no longer names the location', async () => {
    goway.places.set(placeId, placeFor(null, { id: placeId }));
    // The ordinary checkout refusal — naming the seller, never the reason.
    await expectMercariaError(() => resolve(), 409, /not available/);
  });

  it('GoWay DOWN with nothing cached: pickup fails CLOSED with a clear, retryable 503', async () => {
    goway.down = true;
    await expectMercariaError(() => resolve(), 503, /Collection in person cannot be confirmed right now/);
  });

  it('GoWay DOWN with a last-good place cached: the collection still resolves from it', async () => {
    levers.placeCacheTtlSeconds = 0;
    await resolve();
    goway.down = true;
    const pickup = await resolve();
    expect(pickup.goWayPlaceId).toBe(placeId);
  });
});
