/**
 * `readPlaces` — the batch read (`GET /places?ids=`) against a FAKE GoWay
 * behind the SDK's own `fetch` seam, so the real SDK builds every request and
 * parses every answer with GoWay's contract.
 *
 * What it must hold: one request per {@link MAX_PLACE_BATCH_SIZE} misses, the
 * three answers mapped exactly as the single read maps them, every answer
 * cached under the single read's key, an id GoWay's contract refuses answered
 * without asking, and a batch GoWay could not answer falling back per id to a
 * last-good copy or `unavailable`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PLACE_BATCH_SIZE } from '@goway.to/sdk';

const levers = vi.hoisted(() => ({ placeCacheTtlSeconds: 60 }));

vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
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

import { useGoWayTransportForTests } from '../client.js';
import { clearPlaceCacheForTests, inProcessPlaceCacheForTests, placeCacheKey } from '../cache.js';
import { readPlace, readPlaces } from '../places.js';
import { createFakeGoWay, type FakeGoWay } from './fake-goway.js';

let goway: FakeGoWay;

function addPlace(id: string, locationId?: string): void {
  goway.places.set(id, {
    id,
    name: `Shop ${id}`,
    latitude: 41.39,
    longitude: 2.17,
    timezone: 'Europe/Madrid',
    address: { countryCode: 'ES', city: 'Barcelona' },
    hoursExceptions: [{ startsOn: '2025-12-25', endsOn: '2025-12-25', closed: true, note: 'Christmas' }],
    ...(locationId === undefined ? {} : { storeLinks: [{ locationId, verification: 'business_asserted' }] }),
  });
}

/** The batch requests made so far, as their `ids` lists. */
function batchRequests(): string[][] {
  return goway.requests
    .map((url) => new URL(url))
    .filter((url) => url.pathname.endsWith('/places'))
    .map((url) => (url.searchParams.get('ids') ?? '').split(','));
}

beforeAll(() => {
  goway = createFakeGoWay();
  useGoWayTransportForTests({ apiBaseUrl: goway.apiBaseUrl, fetch: goway.fetch });
});

beforeEach(() => {
  clearPlaceCacheForTests();
  goway.places.clear();
  goway.gone.clear();
  goway.down = false;
  goway.requests.length = 0;
  levers.placeCacheTtlSeconds = 60;
});

afterAll(() => {
  useGoWayTransportForTests(null);
});

describe('readPlaces', () => {
  it('answers found, gone (with the merge survivor) and not_found from ONE request', async () => {
    addPlace('gw_found', 'loc_1');
    goway.gone.set('gw_merged', 'gw_found');
    goway.gone.set('gw_removed', null);

    const results = await readPlaces(['gw_found', 'gw_merged', 'gw_removed', 'gw_never', 'gw_found'], {
      locale: 'ca',
    });

    expect(batchRequests()).toHaveLength(1);
    expect(goway.requests[0]).toContain('locale=ca');
    const found = results.get('gw_found');
    expect(found).toMatchObject({ kind: 'found', stale: false, place: { id: 'gw_found', storeLink: { locationId: 'loc_1' } } });
    // The batch carries hours exceptions, as the single read does.
    expect(found?.kind === 'found' ? found.place.opening.hoursExceptions : undefined).toHaveLength(1);
    expect(results.get('gw_merged')).toEqual({ kind: 'gone', mergedInto: 'gw_found' });
    expect(results.get('gw_removed')).toEqual({ kind: 'gone', mergedInto: null });
    expect(results.get('gw_never')).toEqual({ kind: 'not_found' });
    expect(results.size).toBe(4);
  });

  it('splits the misses into requests of at most MAX_PLACE_BATCH_SIZE', async () => {
    const ids = Array.from({ length: MAX_PLACE_BATCH_SIZE * 2 + 3 }, (_, index) => `gw_${index}`);
    for (const id of ids) addPlace(id);

    const results = await readPlaces(ids);

    const requests = batchRequests();
    expect(requests.map((request) => request.length).sort((a, b) => b - a)).toEqual([
      MAX_PLACE_BATCH_SIZE,
      MAX_PLACE_BATCH_SIZE,
      3,
    ]);
    expect(new Set(requests.flat())).toEqual(new Set(ids));
    expect([...results.values()].every((lookup) => lookup.kind === 'found')).toBe(true);
  });

  it('caches each answer under the single read\'s key, and asks only for what is not fresh', async () => {
    addPlace('gw_a');
    addPlace('gw_b');
    await readPlaces(['gw_a']);
    expect(inProcessPlaceCacheForTests().has(placeCacheKey('gw_a', undefined))).toBe(true);

    goway.requests.length = 0;
    await readPlaces(['gw_a', 'gw_b']);
    expect(batchRequests()).toEqual([['gw_b']]);

    // The single read is answered by the batch read's entry.
    goway.requests.length = 0;
    expect(await readPlace('gw_b')).toMatchObject({ kind: 'found', stale: false });
    expect(goway.requests).toHaveLength(0);
  });

  it('answers an id GoWay\'s contract refuses as not_found, without letting it sink the batch', async () => {
    addPlace('gw_ok');
    const results = await readPlaces(['', '   ', 'x'.repeat(129), 'gw_ok']);
    expect(results.get('')).toEqual({ kind: 'not_found' });
    expect(results.get('   ')).toEqual({ kind: 'not_found' });
    expect(results.get('x'.repeat(129))).toEqual({ kind: 'not_found' });
    expect(results.get('gw_ok')).toMatchObject({ kind: 'found' });
    expect(batchRequests()).toEqual([['gw_ok']]);
  });

  it('falls back per id when GoWay cannot answer: last-good, marked stale, else unavailable', async () => {
    addPlace('gw_known');
    addPlace('gw_unknown');
    await readPlaces(['gw_known']);

    levers.placeCacheTtlSeconds = 0;
    goway.down = true;
    const results = await readPlaces(['gw_known', 'gw_unknown']);

    expect(results.get('gw_known')).toMatchObject({ kind: 'found', stale: true, place: { id: 'gw_known' } });
    expect(results.get('gw_unknown')).toEqual({ kind: 'unavailable' });
  });

  it('asks GoWay again for a `fresh` read, even with a fresh entry cached', async () => {
    addPlace('gw_a');
    await readPlaces(['gw_a']);
    goway.requests.length = 0;
    await readPlaces(['gw_a'], { fresh: true });
    expect(batchRequests()).toEqual([['gw_a']]);
  });
});
