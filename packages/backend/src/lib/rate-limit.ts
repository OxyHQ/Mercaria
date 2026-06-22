/**
 * Rate limiting.
 *
 * Wraps the SDK's `createOxyRateLimit` (per-user for authenticated callers,
 * per-IP for anonymous) with a Redis-backed store when `REDIS_URL` is set, so
 * limits are shared across all ECS tasks behind the ALB. Without Redis it falls
 * back to the SDK's in-memory store (per-instance).
 *
 * Each scope MUST use a unique `rl:<scope>:` Redis prefix — sharing one Redis
 * client across limiters without distinct prefixes makes them increment the
 * same key and halves the effective budget (ERR_ERL_DOUBLE_COUNT).
 */

import type { RequestHandler } from 'express';
import { RedisStore } from 'rate-limit-redis';
import { createOxyRateLimit, type OxyRateLimitOptions } from '@oxyhq/core/server';
import { oxyClient } from '../middleware/auth.js';
import { getRedisClient } from './redis.js';
import { log } from './logger.js';

export type RateLimitScope =
  | 'general'
  | 'feedback'
  | 'listings'
  | 'feed'
  | 'stores'
  | 'cart'
  | 'checkout'
  | 'orders'
  | 'reviews'
  | 'admin'
  | 'search';

/**
 * Build a rate-limit middleware for a scope. The scope drives a unique
 * `rl:<scope>:` Redis key prefix so limiters never share counters.
 */
export function makeRateLimiter(
  scope: RateLimitScope,
  options: Omit<OxyRateLimitOptions, 'store'> = {},
): RequestHandler {
  const redis = getRedisClient();
  const store = redis
    ? new RedisStore({
        prefix: `rl:${scope}:`,
        sendCommand: (command: string, ...args: string[]) =>
          redis.call(command, ...args) as Promise<number | string>,
      })
    : undefined;

  if (!store) {
    log.general.info({ scope }, 'Rate limiter using in-memory store (REDIS_URL not set)');
  }

  return createOxyRateLimit(oxyClient, { ...options, ...(store ? { store } : {}) });
}
