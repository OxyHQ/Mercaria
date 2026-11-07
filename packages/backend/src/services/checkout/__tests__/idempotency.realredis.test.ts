import { afterAll, beforeAll, expect, it } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { completeLegacyCheckoutClaim, isPendingCheckoutClaim } from '../idempotency.js';
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
it('recognizes both pending formats and keeps completed groups replayable', () => {
  expect(isPendingCheckoutClaim('__pending__')).toBe(true);
  expect(isPendingCheckoutClaim(`__pending__:${randomUUID()}`)).toBe(true);
  expect(isPendingCheckoutClaim(randomUUID())).toBe(false);
});
it('completes a legacy claim atomically and preserves its replay TTL', async () => {
  await redis.set(key, '__pending__', 'PX', 10_000);
  expect(await completeLegacyCheckoutClaim(redis, key, 'completed-group', 10_000)).toBe(true);
  expect(await redis.get(key)).toBe('completed-group');
  expect(await redis.pttl(key)).toBeGreaterThan(0);
});
it('cannot complete an expired claim or overwrite a newer owned claim or completed group', async () => {
  await redis.set(key, '__pending__', 'PX', 1);
  const deadline = Date.now() + 1_000;
  while ((await redis.exists(key)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await redis.get(key)).toBeNull();
  expect(await completeLegacyCheckoutClaim(redis, key, 'stale-group', 10_000)).toBe(false);
  const owned = `__pending__:${randomUUID()}`;
  expect(await redis.set(key, owned, 'PX', 10_000, 'NX')).toBe('OK');
  expect(await completeLegacyCheckoutClaim(redis, key, 'stale-group', 10_000)).toBe(false);
  expect(await redis.get(key)).toBe(owned);
  await redis.set(key, 'new-completed-group', 'PX', 10_000);
  expect(await completeLegacyCheckoutClaim(redis, key, 'stale-group', 10_000)).toBe(false);
  expect(await redis.get(key)).toBe('new-completed-group');
});
