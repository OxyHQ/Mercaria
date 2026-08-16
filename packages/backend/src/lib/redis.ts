/**
 * Shared Redis client singleton.
 * Used by rate limiting, Socket.IO adapter, and task queue.
 * Requires REDIS_URL env var. Returns null if not configured.
 */

import Redis from 'ioredis';
import { log } from './logger.js';

let client: Redis | null = null;
let adapterClients: { pubClient: Redis; subClient: Redis } | null = null;

const MAX_RETRIES = 10;
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogTime = 0;

function throttledErrorLog(label: string, err: Error) {
  const now = Date.now();
  if (now - lastErrorLogTime > ERROR_LOG_INTERVAL_MS) {
    log.general.error({ err }, `${label} (suppressing repeats for 60s)`);
    lastErrorLogTime = now;
  }
}

/**
 * Read the database index out of a Redis URL's path (`redis://host:6379/9`).
 *
 * Returns `undefined` for a URL that names none, and `null` for one that names
 * something unusable. The two are different answers because the failure this
 * exists to prevent is silent and PERMISSIVE: an index is how an operator
 * isolates one service's keyspace on a shared Redis, so parsing it cleanly and
 * discarding it hands them isolation they believe in and do not have, with
 * nothing in a log or a health check to say otherwise.
 *
 * A malformed index is therefore refused rather than defaulted. Landing on db 0
 * is the exact harm; falling back to no Redis at all costs an in-memory rate
 * limiter and inline jobs, both correct, and it is loud.
 *
 * The upper bound is deliberately NOT checked here — `databases` is a
 * server-side setting, so any ceiling this file picked would be a guess about
 * somebody else's config, and Redis rejects an out-of-range `SELECT` itself.
 */
function parseRedisDbIndex(pathname: string): number | undefined | null {
  const raw = pathname.replace(/^\//, '');
  if (raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const db = Number(raw);
  return Number.isSafeInteger(db) ? db : null;
}

function parseRedisUrl(): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: object;
} | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const parsed = new URL(url);
    let tls: object | undefined;
    if (parsed.protocol === 'rediss:') {
      const caCert = process.env.REDIS_CA_CERT || process.env.CA_CERT;
      tls = caCert ? { ca: caCert } : {};
    }
    const db = parseRedisDbIndex(parsed.pathname);
    if (db === null) {
      log.general.warn(
        'REDIS_URL carries a database index that is not a non-negative integer — refusing the URL rather than silently using db 0',
      );
      return null;
    }
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      db,
      tls,
    };
  } catch {
    log.general.warn('REDIS_URL is set but could not be parsed');
    return null;
  }
}

/**
 * Get the shared Redis client (singleton). Returns null if REDIS_URL not set.
 */
export function getRedisClient(): Redis | null {
  if (client) return client;

  const config = parseRedisUrl();
  if (!config) return null;

  client = new Redis({
    ...config,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    commandTimeout: 2000,
    retryStrategy: (times) => {
      if (times > MAX_RETRIES) {
        log.general.warn(`Redis client giving up after ${MAX_RETRIES} retries`);
        return null; // Stop reconnecting
      }
      return Math.min(times * 500, 5000);
    },
  });

  client.on('error', (err) => {
    throttledErrorLog('Redis client error', err);
  });

  client.on('connect', () => {
    log.general.info('Redis connected');
  });

  return client;
}

/**
 * Get the Socket.IO adapter's PUB/SUB client pair.
 *
 * `@socket.io/redis-adapter` needs two connections because it puts the second
 * into subscriber mode, where Redis accepts nothing but (un)subscribe/ping/quit.
 *
 * **Never call `.connect()` on these.** ioredis connects EAGERLY in the
 * constructor (`lazyConnect` defaults false), and `_connect()` rejects with
 * `Redis is already connecting/connected` for a client whose status is already
 * `connecting`/`connect`/`ready`. That rejection is what left the adapter
 * unattached in production (#364). The adapter needs no connected client: it
 * issues `psubscribe`/`subscribe` in its own constructor and ioredis queues
 * them on the offline queue until the socket is up. The `Promise.all([...connect()])`
 * shape belongs to `redis` (node-redis v4), which DOES require an explicit
 * connect; it was applied to ioredis clients, where it can only ever reject.
 *
 * These are a DEDICATED pair rather than `getRedisClient()` reused as the
 * publisher, and the three differences from that client are the whole reason:
 *
 * - **`retryStrategy` never gives up.** The shared client stops reconnecting
 *   after `MAX_RETRIES` (correct for a cache: fail open, read from the source).
 *   An adapter that stops reconnecting goes on serving traffic with a dead
 *   fan-out — half of every cross-task emit silently dropped, with no error
 *   after the initial burst. That is #364's failure mode arriving a second way,
 *   so the one thing the fix must not do is reintroduce it.
 * - **No `commandTimeout`.** The subscriber's `subscribe` is long-lived setup,
 *   re-issued by ioredis on every reconnect; a timed-out re-subscribe leaves the
 *   adapter deaf and says nothing.
 * - **`maxRetriesPerRequest` is kept at 3**, which is what bounds the offline
 *   queue while Redis is unreachable. A pending `publish` then rejects rather
 *   than accumulating; `index.ts`'s `unhandledRejection` handler logs it and the
 *   process carries on.
 *
 * BullMQ is unaffected either way — it takes plain connection options from
 * `getRedisConnection()` (with its required `maxRetriesPerRequest: null`) and
 * never one of these instances.
 */
export function getSocketAdapterClients(): { pubClient: Redis; subClient: Redis } | null {
  if (adapterClients) return adapterClients;

  const config = parseRedisUrl();
  if (!config) return null;

  const pubClient = new Redis({
    ...config,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  // Same options by construction, so the two can never drift apart.
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => {
    throttledErrorLog('Socket.IO Redis publisher error', err);
  });
  subClient.on('error', (err) => {
    throttledErrorLog('Socket.IO Redis subscriber error', err);
  });

  adapterClients = { pubClient, subClient };
  return adapterClients;
}

/**
 * Get BullMQ-compatible connection config (not an ioredis instance).
 * BullMQ requires maxRetriesPerRequest: null.
 */
export function getRedisConnection(): (ReturnType<typeof parseRedisUrl> & { maxRetriesPerRequest: null }) | null {
  const config = parseRedisUrl();
  if (!config) return null;
  return { ...config, maxRetriesPerRequest: null };
}

/**
 * Race a promise against a timeout. Used by rate limiters to fail-open
 * if Redis is slow. Exported so callers don't duplicate this helper.
 */
export const REDIS_TIMEOUT_MS = 1_000;

export function withRedisTimeout<T>(promise: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Redis timeout')), ms),
    ),
  ]);
}

/**
 * What the health snapshot may say about Redis.
 *
 * THREE values, where the field it feeds had two, because "nobody configured
 * Redis" and "Redis is down" are different operational facts that call for
 * opposite responses — and the old two-value field could express only the
 * first. `getRedisClient()` returns non-null the moment `REDIS_URL` parses and
 * STAYS non-null after `retryStrategy` gives up for good, so an existence test
 * reported `connected` for a permanently dead client and `unavailable` could
 * only ever mean "unset or unparseable".
 */
export type RedisHealth = 'connected' | 'unreachable' | 'not_configured';

/**
 * Whether Redis answers a command right now.
 *
 * A real round trip, not a `client !== null` flag — the `checkPostgresHealth`
 * contract, applied to the other store this task opens: it NEVER THROWS,
 * because an unreachable dependency is a health RESULT rather than an error.
 *
 * Bounded TWICE, and the outer bound is a tightening rather than the guarantee:
 * this client already carries `commandTimeout: 2000`, which fires even for a
 * command sitting on the offline queue, so a Redis that accepts a socket and
 * then says nothing rejects at 2s on its own. `withRedisTimeout` brings that to
 * 1s, which matters because the ALB allows 5s per check and `/health` has other
 * work to do inside it — but removing it leaves the probe bounded, which is
 * measured: mutating the call away leaves every case here green at ~2s.
 * `Promise.race` subscribes to the ping either way, so a late rejection is
 * absorbed rather than surfacing as an unhandled rejection.
 *
 * `not_configured` is a legitimate, deliberate deployment — rate limiting falls
 * back to an in-memory bucket and queued jobs run inline — which is exactly why
 * it must not read the same as an outage.
 */
export async function checkRedisHealth(): Promise<RedisHealth> {
  const instance = getRedisClient();
  if (!instance) return 'not_configured';
  try {
    await withRedisTimeout(instance.ping());
    return 'connected';
  } catch (error) {
    log.general.warn({ err: error }, 'Redis health check failed');
    return 'unreachable';
  }
}

/**
 * Close all Redis connections. Call during graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
  if (adapterClients) {
    await Promise.all([adapterClients.pubClient.quit(), adapterClients.subClient.quit()]);
    adapterClients = null;
  }
}
