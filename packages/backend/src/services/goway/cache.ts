/**
 * The place cache: GoWay place reads, by place id, for a short time.
 *
 * Redis when `REDIS_URL` is configured, so every task serves the same answer;
 * an in-process map otherwise, and always as the fallback when Redis is slow or
 * down — the `fx.service` last-good arrangement. A cache failure is never an
 * error: the worst it costs is a GoWay round trip.
 *
 * ## Two clocks
 *
 * An entry is FRESH for `GOWAY_PLACE_CACHE_TTL_SECONDS` and KEPT for
 * `GOWAY_PLACE_STALE_TTL_SECONDS`. A fresh entry is served without asking
 * GoWay; a kept one only when GoWay cannot answer, labelled stale, so a
 * collection can still be described during an outage and fails closed once
 * nothing recent is known.
 *
 * ## What it can never hold
 *
 * A place id and a locale in the key, a GoWay place's public facts in the
 * value. Nothing keyed on a POSITION is cached anywhere — a nearby search
 * carries the shopper's coordinate, and a cache of it would be a store of who
 * was where (`goway-adapter.test.ts` asserts the keys and values it writes).
 */

import { getRedisClient, withRedisTimeout } from '../../lib/redis.js';
import { log } from '../../lib/logger.js';
import type { PlaceFacts } from './place-facts.js';

/** What one place read concluded, as the cache keeps it. Never `unavailable`. */
export type CachedPlaceOutcome =
  | { readonly kind: 'found'; readonly place: PlaceFacts }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'gone'; readonly mergedInto: string | null };

/** One cached outcome and when GoWay said it. */
export interface CachedPlace {
  readonly outcome: CachedPlaceOutcome;
  /** Epoch milliseconds. */
  readonly fetchedAt: number;
}

/** Bumped whenever {@link PlaceFacts} changes shape, so an old entry is a miss, never a misread. */
const KEY_PREFIX = 'goway:place:v1:';

/** The in-process fallback's ceiling, so a crawler sweeping place ids cannot grow it without bound. */
const MAX_IN_PROCESS_ENTRIES = 5_000;

const inProcess = new Map<string, CachedPlace>();

/** The cache key for one place in one locale. */
export function placeCacheKey(placeId: string, locale: string | undefined): string {
  return `${KEY_PREFIX}${locale ?? '-'}:${placeId}`;
}

/** Read one entry: Redis first, then this process. */
export async function readCachedPlace(key: string): Promise<CachedPlace | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await withRedisTimeout(redis.get(key));
      if (raw) {
        const parsed = JSON.parse(raw) as CachedPlace;
        if (typeof parsed?.fetchedAt === 'number' && typeof parsed?.outcome?.kind === 'string') return parsed;
      }
    } catch (err) {
      log.general.warn({ err }, '[GoWay] could not read the place cache from Redis');
    }
  }
  return inProcess.get(key) ?? null;
}

/** Keep one entry for the stale window, in both stores. */
export async function writeCachedPlace(key: string, entry: CachedPlace, keepSeconds: number): Promise<void> {
  if (inProcess.size >= MAX_IN_PROCESS_ENTRIES && !inProcess.has(key)) {
    // Oldest-inserted first: a Map iterates in insertion order.
    const oldest = inProcess.keys().next().value;
    if (oldest !== undefined) inProcess.delete(oldest);
  }
  inProcess.set(key, entry);

  const redis = getRedisClient();
  if (!redis) return;
  try {
    await withRedisTimeout(redis.setex(key, Math.max(1, keepSeconds), JSON.stringify(entry)));
  } catch (err) {
    log.general.warn({ err }, '[GoWay] could not write the place cache to Redis');
  }
}

/** Tests only: forget every in-process entry. */
export function clearPlaceCacheForTests(): void {
  inProcess.clear();
}

/** Tests only: every in-process entry, to assert what the cache can hold. */
export function inProcessPlaceCacheForTests(): ReadonlyMap<string, CachedPlace> {
  return inProcess;
}
