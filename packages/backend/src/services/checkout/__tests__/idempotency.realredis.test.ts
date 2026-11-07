import { afterAll, beforeAll, expect, it } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  checkoutClaimToken,
  completeCheckoutClaim,
  isPendingCheckoutClaim,
  releaseCheckoutClaim,
} from '../idempotency.js';

let redis: Redis;
const key = `checkout-lease-test:${randomUUID()}`;
beforeAll(async () => {
  if (!process.env.TEST_REDIS_URL)
    throw new Error('TEST_REDIS_URL is required for real Redis lease tests');
  redis = new Redis(process.env.TEST_REDIS_URL);
  await redis.ping();
});
afterAll(async () => {
  if (redis) {
    await redis.del(key);
    await redis.quit();
  }
});
it('recognizes rolling-deployment markers without treating completed groups as pending', () => {
  expect(isPendingCheckoutClaim('__pending__')).toBe(true);
  expect(isPendingCheckoutClaim(checkoutClaimToken(randomUUID()))).toBe(true);
  expect(isPendingCheckoutClaim(randomUUID())).toBe(false);
});
it('serializes concurrent claims and fences expired owners from releasing or publishing over successors', async () => {
  const first = checkoutClaimToken(randomUUID());
  const second = checkoutClaimToken(randomUUID());
  expect(await redis.set(key, first, 'PX', 10_000, 'NX')).toBe('OK');
  expect(await redis.set(key, second, 'PX', 10_000, 'NX')).toBeNull();
  expect(await releaseCheckoutClaim(redis, key, second)).toBe(false);
  expect(await redis.get(key)).toBe(first);
  await redis.pexpire(key, 1);
  const expiryDeadline = Date.now() + 1_000;
  while ((await redis.exists(key)) && Date.now() < expiryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await redis.get(key)).toBeNull();
  expect(await redis.set(key, second, 'PX', 10_000, 'NX')).toBe('OK');
  expect(await releaseCheckoutClaim(redis, key, first)).toBe(false);
  expect(await completeCheckoutClaim(redis, key, first, 'stale-group', 10_000)).toBe(false);
  expect(await redis.get(key)).toBe(second);
  expect(await completeCheckoutClaim(redis, key, second, 'completed-group', 10_000)).toBe(true);
  expect(await releaseCheckoutClaim(redis, key, first)).toBe(false);
  expect(await completeCheckoutClaim(redis, key, first, 'stale-group', 10_000)).toBe(false);
  expect(await redis.get(key)).toBe('completed-group');
  expect(await redis.pttl(key)).toBeGreaterThan(0);
});
