/**
 * A fake GoWay, behind the SDK's own `fetch` seam.
 *
 * The real `@goway.to/sdk` still builds every URL, validates every request and
 * parses every response with GoWay's contract — only the network is replaced.
 * So a body this fake gets wrong is refused exactly as a real malformed GoWay
 * response would be, and a test cannot pass on a shape GoWay would never send.
 *
 * It answers the four reads Mercaria makes: a place by id (with its hours
 * exceptions, as a single-place read carries them), places near a point that
 * carry a capability (without exceptions, as a list does), and the geocoder.
 * Every request URL is recorded, so a test can assert what was — and was not —
 * sent.
 */

import type { GoWayFetch } from '@goway.to/sdk';

/** One fake place. Everything optional that GoWay's contract makes optional. */
export interface FakePlace {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly status?: 'active' | 'closed' | 'proposed';
  readonly address?: Record<string, string>;
  readonly timezone?: string;
  readonly openingHours?: { intervals: { day: number; opens: string; closes: string }[] };
  readonly hoursExceptions?: readonly {
    startsOn: string;
    endsOn: string;
    closed: boolean;
    intervals?: { opens: string; closes: string }[];
    note?: string;
    verification?: string;
  }[];
  readonly contact?: { phone?: string; website?: string };
  /** `commerce.mercaria.store` assertions, strongest-first is GoWay's job, not the fixture's. */
  readonly storeLinks?: readonly { locationId: string; verification: string }[];
  /** Any other capability, `[key, value, verification]`. */
  readonly capabilities?: readonly (readonly [string, unknown, string])[];
}

/** A town the geocoder knows. */
export interface FakeTown {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly countryCode?: string;
  readonly kind?: 'locality' | 'region' | 'address';
}

export interface FakeGoWay {
  readonly apiBaseUrl: string;
  readonly fetch: GoWayFetch;
  readonly places: Map<string, FakePlace>;
  /** A withdrawn place id, and where a merge sent it (`null` for a removal). */
  readonly gone: Map<string, string | null>;
  readonly towns: FakeTown[];
  /** Every URL requested, in order. */
  readonly requests: string[];
  /** While true, every request answers `503 service_unavailable`. */
  down: boolean;
}

const OBSERVED = '2026-09-01T00:00:00.000Z';

export function createFakeGoWay(): FakeGoWay {
  const fake: FakeGoWay = {
    apiBaseUrl: 'https://goway.test',
    places: new Map(),
    gone: new Map(),
    towns: [],
    requests: [],
    down: false,
    fetch: async (url) => {
      fake.requests.push(url);
      if (fake.down) return respond(503, error('service_unavailable', 'GoWay is down'));

      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/api\/v1/, '');
      const query = parsed.searchParams;

      if (path === '/places/nearby') return respond(200, nearby(fake, query));
      if (path === '/geocode') return respond(200, geocode(fake, query));
      const single = /^\/places\/([^/]+)$/.exec(path);
      if (single) {
        const id = decodeURIComponent(single[1]);
        if (fake.gone.has(id)) {
          const mergedInto = fake.gone.get(id);
          return respond(
            410,
            error('gone', 'This place was withdrawn', mergedInto ? { mergedInto } : undefined),
          );
        }
        const place = fake.places.get(id);
        if (!place) return respond(404, error('not_found', 'No such place'));
        return respond(200, placeJson(place, true));
      }
      return respond(404, error('unknown_route', 'No such route'));
    },
  };
  return fake;
}

function nearby(fake: FakeGoWay, query: URLSearchParams) {
  const latitude = Number(query.get('latitude'));
  const longitude = Number(query.get('longitude'));
  const radius = Number(query.get('radiusMeters'));
  const limit = Number(query.get('limit') ?? '50');
  const offset = query.get('cursor') ? Number(Buffer.from(query.get('cursor') ?? '', 'base64url').toString()) : 0;
  const wanted = (query.get('capabilities') ?? '').split(',').filter((key) => key !== '');

  const matches = [...fake.places.values()]
    .filter((place) => wanted.every((key) => key !== 'commerce.mercaria.store' || (place.storeLinks ?? []).length > 0))
    .map((place) => ({ place, distance: metresBetween(latitude, longitude, place.latitude, place.longitude) }))
    .filter((entry) => entry.distance <= radius)
    .sort((left, right) => left.distance - right.distance || left.place.id.localeCompare(right.place.id));

  const page = matches.slice(offset, offset + limit);
  const next = offset + limit < matches.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
  return {
    items: page.map((entry) => ({ ...placeJson(entry.place, false), distanceMeters: entry.distance })),
    nextCursor: next,
  };
}

function geocode(fake: FakeGoWay, query: URLSearchParams) {
  const term = (query.get('q') ?? '').toLowerCase();
  return {
    items: fake.towns
      .filter((town) => town.name.toLowerCase().startsWith(term))
      .map((town, index) => ({
        id: `town-${index}`,
        displayName: town.name,
        kind: town.kind ?? 'locality',
        coordinate: { latitude: town.latitude, longitude: town.longitude },
        context: { city: town.name, ...(town.countryCode ? { countryCode: town.countryCode } : {}) },
        source: 'photon',
      })),
    nextCursor: null,
    providers: ['photon'],
  };
}

function placeJson(place: FakePlace, single: boolean) {
  const capabilities = [
    ...(place.storeLinks ?? []).map((link) => capability('commerce.mercaria.store', link.locationId, link.verification)),
    ...(place.capabilities ?? []).map(([key, value, verification]) => capability(key, value, verification)),
  ];
  return {
    id: place.id,
    name: place.name,
    location: { latitude: place.latitude, longitude: place.longitude },
    categories: ['shop.books'],
    ...(place.address ? { address: place.address } : {}),
    ...(place.contact ? { contact: place.contact } : {}),
    ...(place.openingHours ? { openingHours: place.openingHours } : {}),
    ...(place.timezone ? { timezone: place.timezone } : {}),
    ...(single
      ? {
          names: [],
          hoursExceptions: (place.hoursExceptions ?? []).map((exception, index) => ({
            id: `${place.id}-exception-${index}`,
            placeId: place.id,
            startsOn: exception.startsOn,
            endsOn: exception.endsOn,
            closed: exception.closed,
            intervals: exception.intervals ?? [],
            ...(exception.note ? { note: exception.note } : {}),
            source: 'goway',
            verification: exception.verification ?? 'business_asserted',
            observedAt: OBSERVED,
          })),
        }
      : {}),
    status: place.status ?? 'active',
    verification: { state: 'unverified' },
    sources: [],
    capabilities,
    createdAt: OBSERVED,
    updatedAt: OBSERVED,
  };
}

function capability(key: string, value: unknown, verification: string) {
  const separator = key.lastIndexOf('.');
  return {
    namespace: key.slice(0, separator),
    capability: key.slice(separator + 1),
    key,
    value,
    verification,
    observedAt: OBSERVED,
  };
}

function error(code: string, message: string, details?: Record<string, string>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function respond(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return Promise.resolve({
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: () => Promise.resolve(text),
  });
}

/** Great-circle metres, rounded — the distance GoWay reports. */
function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a))));
}
