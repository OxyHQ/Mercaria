/**
 * BullMQ connection wiring for the marketplace queues.
 *
 * Reuses the single Redis config source (`lib/redis.ts#getRedisConnection`)
 * rather than building a second one. Per the Mercaria BullMQ gotcha (isolated
 * bun linker can nest a distinct `ioredis` under `bullmq`, which makes passing
 * an ioredis INSTANCE throw TS2322), we pass a plain connection-OPTIONS object
 * to BullMQ — BullMQ then creates and owns its own ioredis per Queue/Worker, so
 * closing the Queue/Worker closes the underlying socket.
 *
 * `getRedisConnection()` already returns `maxRetriesPerRequest: null` (required
 * by BullMQ for its blocking commands).
 */

import type { ConnectionOptions } from 'bullmq';
import { getRedisConnection } from '../lib/redis.js';

/**
 * Whether a usable Redis target is configured (REDIS_URL present + parseable).
 * Callers MUST guard with this before `getQueueConnection()`.
 */
export function isQueueEnabled(): boolean {
  return getRedisConnection() !== null;
}

/**
 * Build the BullMQ `ConnectionOptions` from the shared Redis config. Throws when
 * Redis is not configured — callers must guard with {@link isQueueEnabled}.
 */
export function getQueueConnection(): ConnectionOptions {
  const config = getRedisConnection();
  if (!config) {
    throw new Error('getQueueConnection called without Redis configured (guard with isQueueEnabled)');
  }

  const options: ConnectionOptions = {
    host: config.host,
    port: config.port,
    maxRetriesPerRequest: null,
  };
  if (config.password) {
    options.password = config.password;
  }
  if (config.username) {
    options.username = config.username;
  }
  if (config.tls) {
    options.tls = config.tls;
  }
  return options;
}

/**
 * Close BullMQ's shared connection. With a plain-options `connection`, BullMQ
 * creates+owns one ioredis per Queue/Worker, so there is no shared instance to
 * close here — closing the Queues/Workers (see `closeQueues` / `shutdownQueues`)
 * disconnects the underlying sockets. Kept as a documented no-op so the shutdown
 * call sites read symmetrically and a future shared-instance refactor has a seam.
 */
export async function closeQueueConnection(): Promise<void> {
  return Promise.resolve();
}
