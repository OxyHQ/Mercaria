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
  | 'search'
  | 'rates'
  | 'channels'
  | 'reports'
  | 'payments'
  // ADR 0003 D3/T10: guest-session ISSUANCE has its own bucket
  // (`rl:guest-issue:`) — per IP, since the caller is anonymous by definition
  // — so a farmer exhausts this budget, not the general one.
  | 'guest-issue'
  // The rest of the guest-session surface (inspect/rotate/revoke).
  | 'guest'
  // Merchant claiming (#83, security control 1) — the NETWORK axis of the four
  // the issue names. Its own bucket (`rl:merchant-claims:`) so a claim-farming
  // burst exhausts this budget and not the general one; the per-user,
  // per-merchant and per-domain axes are durable counts in Postgres, because
  // "how often may this DOMAIN be challenged, across every claimant and every
  // ECS task" is not a question a per-IP bucket can answer.
  | 'merchant-claims';

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
