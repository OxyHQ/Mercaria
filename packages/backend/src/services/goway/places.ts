/**
 * Every GoWay read Mercaria makes, in one module (ADR 0013).
 *
 * Feature code never imports `@goway.to/sdk`: it asks this module for a place,
 * for the Mercaria places near a point, or for a town by name, and gets
 * Mercaria shapes and Mercaria failures back. The base URL is configuration,
 * each request has a budget (`GOWAY_TIMEOUT_MS`), and every failure is one of
 * three answers — the place does not exist, GoWay withdrew it, or GoWay could
 * not be asked — so a caller decides what an outage means for ITS question
 * rather than inheriting a transport error.
 *
 * ## Two kinds of read, cached differently
 *
 * - **A place by id** is public, keyed on nothing about the caller, and cached
 *   (`cache.ts`): fresh for at most a minute, kept as last-good for longer so
 *   a collection can still be described while GoWay is down.
 * - **Places near a point** and **towns by name** carry what a SHOPPER sent —
 *   their coordinate, what they typed — and are never cached, never logged and
 *   never written anywhere. The coordinate is forwarded to GoWay for the length
 *   of one request, exactly as the shopper's own browser would send it, and
 *   GoWay's own rule is that it is transient there too. A failure is logged by
 *   its CODE: a transport error's message or cause can carry the request URL,
 *   and this URL has the coordinate in it.
 */

import {
  GoWayGoneError,
  GoWayNotFoundError,
  GoWayValidationError,
  isGoWayError,
  type GoWayClient,
  type SearchResultKind,
} from '@goway.to/sdk';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { MercariaError, validationError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';
import { placeCacheKey, readCachedPlace, writeCachedPlace, type CachedPlaceOutcome } from './cache.js';
import { goWayClient } from './client.js';
import {
  MERCARIA_STORE_CAPABILITY,
  placeFactsOf,
  type PlaceFacts,
  type PlaceLookup,
} from './place-facts.js';

/**
 * GoWay could not answer a question that has no last-good answer to fall back
 * on — a nearby search, a town lookup. `503`, retryable, and deliberately
 * WITHOUT the underlying error as a `cause`: see the module docblock.
 */
export class GoWayUnavailableError extends MercariaError {
  constructor(
    message = 'Locations cannot be looked up right now, because GoWay (which knows where they are) ' +
      'did not answer. Try again in a minute.',
  ) {
    super({ code: ErrorCodes.SERVICE_UNAVAILABLE, message });
    this.name = 'GoWayUnavailableError';
  }
}

/** How many place reads one caller may have in flight at once. */
const PLACE_READ_CONCURRENCY = 8;

/** Options a single-place read accepts. */
export interface PlaceReadOptions {
  /** BCP 47 tag the place's `displayName` resolves against. Never changes `name`. */
  readonly locale?: string;
  /**
   * Ask GoWay even when a fresh entry is cached. For a merchant who has just
   * edited the place in GoWay and asks whether it took: a minute-old "no" is
   * the wrong answer to them. A failure still falls back to last-good.
   */
  readonly fresh?: boolean;
}

/**
 * One place, by its GoWay id.
 *
 * A fresh cache entry answers without asking GoWay. Otherwise GoWay is asked,
 * and its answer — found, not found, or gone (with where a merge sent it) — is
 * cached. If GoWay cannot answer, a last-good `found` stands in, marked stale;
 * with none, the answer is `unavailable`. Never throws.
 */
export async function readPlace(placeId: string, options: PlaceReadOptions = {}): Promise<PlaceLookup> {
  const key = placeCacheKey(placeId, options.locale);
  const cached = await readCachedPlace(key);
  const now = Date.now();
  if (!options.fresh && cached && now - cached.fetchedAt < config.goway.placeCacheTtlSeconds * 1_000) {
    return fromCache(cached.outcome, false);
  }

  const client = goWayClient();
  const outcome = client === null ? null : await askForPlace(client, placeId, options.locale);
  if (outcome !== null) {
    await writeCachedPlace(key, { outcome, fetchedAt: now }, config.goway.placeStaleTtlSeconds);
    return fromCache(outcome, false);
  }

  if (cached && cached.outcome.kind === 'found' && now - cached.fetchedAt < config.goway.placeStaleTtlSeconds * 1_000) {
    return fromCache(cached.outcome, true);
  }
  return { kind: 'unavailable' };
}

/** Several places at once, each through {@link readPlace}, at a bounded concurrency. */
export async function readPlaces(
  placeIds: readonly string[],
  options: PlaceReadOptions = {},
): Promise<ReadonlyMap<string, PlaceLookup>> {
  const unique = [...new Set(placeIds)];
  const results = new Map<string, PlaceLookup>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const placeId = unique[next];
      next += 1;
      results.set(placeId, await readPlace(placeId, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLACE_READ_CONCURRENCY, unique.length) }, worker));
  return results;
}

/**
 * One place, following a merge one hop — the read the VERIFY act makes.
 *
 * GoWay keeps a merge pointer one hop deep, so one hop is all there is. The
 * caller rewrites the id it stores when `mergedFrom` comes back; the public
 * reads never follow, so a merged place is unlinked until that happens.
 */
export async function readPlaceFollowingMerge(
  placeId: string,
  options: PlaceReadOptions = {},
): Promise<{ lookup: PlaceLookup; placeId: string; mergedFrom?: string }> {
  const first = await readPlace(placeId, options);
  if (first.kind !== 'gone' || first.mergedInto === null) return { lookup: first, placeId };
  const survivor = await readPlace(first.mergedInto, options);
  return { lookup: survivor, placeId: first.mergedInto, mergedFrom: placeId };
}

/** A Mercaria location's GoWay place near a point, as GoWay vouches for it. */
export interface StorePlaceNear {
  readonly placeId: string;
  /** The location the place names back — at a claimant's tier, or it is not here. */
  readonly locationId: string;
  /** Exact, as GoWay measured it. Coarsen before it leaves the server. */
  readonly distanceMetres: number;
}

/**
 * One page of GoWay places near a point that carry `commerce.mercaria.store`,
 * nearest first, reduced to the ones whose back-reference proves something.
 *
 * A place is kept when it is `active` and its STRONGEST back-reference is at
 * `business_asserted` or `oxy_verified` — the trust rule's place half, read off
 * the list GoWay already returned, so the public reads apply it with no extra
 * round trip. Whether the LOCATION names the place back is the caller's join.
 *
 * Paging is GoWay's own: `cursor` is the opaque one it issued, bound by GoWay
 * to the point and the radius, and `nextCursor` is passed through. A page may
 * therefore come back shorter than `limit`, or empty, with a next cursor.
 *
 * @throws {GoWayUnavailableError} When GoWay cannot answer.
 * @throws A `validationError` for a cursor GoWay refuses — one minted for a
 *   different point or radius.
 */
export async function findStorePlacesNear(input: {
  latitude: number;
  longitude: number;
  radiusMetres: number;
  limit: number;
  cursor?: string;
}): Promise<{ items: StorePlaceNear[]; nextCursor: string | null }> {
  const client = goWayClient();
  if (client === null) throw new GoWayUnavailableError();

  let page;
  try {
    page = await client.places.nearby({
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMetres,
      capabilities: [MERCARIA_STORE_CAPABILITY],
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  } catch (error) {
    throw listFailure(error, 'nearby');
  }

  const items: StorePlaceNear[] = [];
  for (const place of page.items) {
    if (place.status !== 'active') continue;
    // The projection is the one place the strongest-assertion rule is read, so
    // the list and the single-place read cannot disagree about it.
    const link = placeFactsOf(place, '').storeLink;
    if (link === undefined) continue;
    if (link.verification !== 'business_asserted' && link.verification !== 'oxy_verified') continue;
    items.push({ placeId: place.id, locationId: link.locationId, distanceMetres: place.distanceMeters });
  }
  return { items, nextCursor: page.nextCursor };
}

/** A town GoWay resolved from what a shopper typed. */
export interface TownMatch {
  readonly label: string;
  readonly city?: string;
  readonly region?: string;
  /** ISO-3166 alpha-2, when GoWay knows it. */
  readonly country?: string;
  /** The town's own centre — never a shopper's position. */
  readonly latitude: number;
  readonly longitude: number;
}

/** The result kinds that name a town or wider, which is what a manual origin is. */
const TOWN_KINDS: readonly SearchResultKind[] = ['locality', 'region'];

/**
 * Towns matching what a shopper typed, as GoWay's geocoder resolves them.
 *
 * @throws {GoWayUnavailableError} When GoWay cannot answer.
 */
export async function findTowns(input: {
  term: string;
  limit: number;
  locale?: string;
}): Promise<TownMatch[]> {
  const client = goWayClient();
  if (client === null) throw new GoWayUnavailableError();

  let results;
  try {
    results = await client.geocode.forward({
      query: input.term,
      limit: input.limit,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    });
  } catch (error) {
    throw listFailure(error, 'towns');
  }

  return results.items
    .filter((item) => TOWN_KINDS.includes(item.kind))
    .map((item) => {
      const city = item.address?.city ?? item.context?.city;
      const region = item.address?.region ?? item.context?.region;
      const country = (item.address?.countryCode ?? item.context?.countryCode)?.toUpperCase();
      return {
        label: item.displayName,
        ...(city === undefined ? {} : { city }),
        ...(region === undefined ? {} : { region }),
        ...(country === undefined ? {} : { country }),
        latitude: item.coordinate.latitude,
        longitude: item.coordinate.longitude,
      };
    });
}

/** Ask GoWay for one place. `null` means it could not answer. */
async function askForPlace(
  client: GoWayClient,
  placeId: string,
  locale: string | undefined,
): Promise<CachedPlaceOutcome | null> {
  try {
    const place = await client.places.get(placeId, locale === undefined ? {} : { locale });
    return { kind: 'found', place: placeFactsOf(place, client.links.place(place)) };
  } catch (error) {
    if (error instanceof GoWayNotFoundError) return { kind: 'not_found' };
    if (error instanceof GoWayGoneError) return { kind: 'gone', mergedInto: error.mergedInto };
    // A place id GoWay's contract refuses (too long, empty) names no place.
    if (error instanceof GoWayValidationError) return { kind: 'not_found' };
    log.general.warn(
      { code: isGoWayError(error) ? error.code : 'unexpected' },
      '[GoWay] a place read failed; serving last-good if there is one',
    );
    return null;
  }
}

/** Map a list read's failure to the Mercaria error a route answers with. */
function listFailure(error: unknown, read: 'nearby' | 'towns'): Error {
  if (error instanceof GoWayValidationError) {
    return validationError('That page cursor or search is not one this surface can resume.');
  }
  // The CODE only — see the module docblock for why never the error itself.
  log.general.warn({ read, code: isGoWayError(error) ? error.code : 'unexpected' }, '[GoWay] a list read failed');
  return new GoWayUnavailableError();
}

function fromCache(outcome: CachedPlaceOutcome, stale: boolean): PlaceLookup {
  return outcome.kind === 'found' ? { kind: 'found', place: outcome.place, stale } : outcome;
}

/** A place's facts when the read found one, `null` otherwise. */
export function foundPlace(lookup: PlaceLookup | undefined): PlaceFacts | null {
  return lookup?.kind === 'found' ? lookup.place : null;
}
