/**
 * Shared Redis client singleton.
 * Used by rate limiting, Socket.IO adapter, and task queue.
 * Requires REDIS_URL env var. Returns null if not configured.
 */

import Redis from 'ioredis';
import { log } from './logger.js';

let client: Redis | null = null;
let subClient: Redis | null = null;

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
 * Get a dedicated subscriber client for Socket.IO adapter.
 * Socket.IO needs a separate connection in subscriber mode.
 */
export function getRedisSubClient(): Redis | null {
  if (subClient) return subClient;

  const config = parseRedisUrl();
  if (!config) return null;

  subClient = new Redis({
    ...config,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    commandTimeout: 2000,
    retryStrategy: (times) => {
      if (times > MAX_RETRIES) {
        log.general.warn(`Redis subscriber giving up after ${MAX_RETRIES} retries`);
        return null;
      }
      return Math.min(times * 500, 5000);
    },
  });

  subClient.on('error', (err) => {
    throttledErrorLog('Redis subscriber client error', err);
  });

  return subClient;
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
 * Close all Redis connections. Call during graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
  if (subClient) {
    await subClient.quit();
    subClient = null;
  }
}
