/**
 * Unit tests for the Shopify transport's RATE-LIMIT wrapper
 * ({@link createShopifyTransport}): HTTP 429 retry honoring `Retry-After` (else a
 * bounded exponential backoff), and proactive per-shop throttling from the
 * `X-Shopify-Shop-Api-Call-Limit` leaky-bucket header. The clock and sleep are
 * injected, so the retry/throttle logic is exercised WITHOUT any real waiting: the
 * fake `sleep` advances the fake clock, mirroring real time.
 */

import { describe, it, expect } from 'vitest';
import { createShopifyTransport } from '../http.js';
import type { ShopifyHttpResponse, ShopifyTransport } from '../http.js';

const URL = 'https://acme.myshopify.com/admin/api/2024-10/products.json';
const HEADERS = { 'X-Shopify-Access-Token': 'shpat_test', Accept: 'application/json' };

/** A fake raw transport that returns queued responses per method and records call counts. */
function queuedRaw(responses: ShopifyHttpResponse[]): { raw: ShopifyTransport; calls: () => number } {
  let index = 0;
  let count = 0;
  const next = (): Promise<ShopifyHttpResponse> => {
    count += 1;
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response);
  };
  const raw: ShopifyTransport = {
    get: () => next(),
    post: () => next(),
    put: () => next(),
    del: () => next(),
  };
  return { raw, calls: () => count };
}

/** A clock driven by the injected sleep (sleeping advances time), plus the recorded waits. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    now: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

const ok = (headers: Record<string, string> = {}): ShopifyHttpResponse => ({ status: 200, headers, body: '{}' });
const rateLimited = (headers: Record<string, string> = {}): ShopifyHttpResponse => ({
  status: 429,
  headers,
  body: '{"errors":"throttled"}',
});

describe('createShopifyTransport — 429 retry', () => {
  it('honors Retry-After and succeeds on the retry', async () => {
    const { raw, calls } = queuedRaw([rateLimited({ 'retry-after': '2' }), ok()]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now });

    const response = await transport.get(URL, HEADERS);

    expect(response.status).toBe(200);
    expect(calls()).toBe(2); // initial 429 + one retry
    expect(clock.sleeps).toEqual([2000]); // Retry-After: 2s → exactly 2000ms
  });

  it('gives up after maxRetries and surfaces the final 429', async () => {
    const { raw, calls } = queuedRaw([rateLimited({ 'retry-after': '1' })]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now, maxRetries: 3 });

    const response = await transport.get(URL, HEADERS);

    expect(response.status).toBe(429);
    expect(calls()).toBe(4); // 1 initial + 3 retries
    expect(clock.sleeps).toHaveLength(3); // one wait per retry
  });

  it('backs off (bounded) when a 429 carries no Retry-After', async () => {
    const { raw, calls } = queuedRaw([rateLimited(), ok()]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now });

    const response = await transport.get(URL, HEADERS);

    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
    expect(clock.sleeps).toHaveLength(1);
    // Equal-jitter backoff for attempt 0: within (BACKOFF_BASE/2, BACKOFF_BASE].
    expect(clock.sleeps[0]).toBeGreaterThan(0);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(500);
  });

  it('does NOT retry a non-429 error — a failed POST is never silently re-sent', async () => {
    const { raw, calls } = queuedRaw([{ status: 500, headers: {}, body: 'err' }]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now });

    const response = await transport.post(URL, HEADERS, '{}');

    expect(response.status).toBe(500);
    expect(calls()).toBe(1); // no retry
    expect(clock.sleeps).toHaveLength(0);
  });
});

describe('createShopifyTransport — proactive bucket throttle', () => {
  it('waits before the next call when the shop bucket is near its limit', async () => {
    // First response reports 39/40 (over the 80% threshold) → the SECOND call is delayed.
    const { raw } = queuedRaw([ok({ 'x-shopify-shop-api-call-limit': '39/40' }), ok()]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now });

    await transport.get(URL, HEADERS); // arms the throttle from the call-limit header
    expect(clock.sleeps).toHaveLength(0); // first call is not delayed

    await transport.get(URL, HEADERS); // must wait out the throttle first
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThan(0);
  });

  it('does NOT throttle while the bucket stays under the threshold', async () => {
    const { raw } = queuedRaw([ok({ 'x-shopify-shop-api-call-limit': '5/40' }), ok()]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now });

    await transport.get(URL, HEADERS);
    await transport.get(URL, HEADERS);

    expect(clock.sleeps).toHaveLength(0);
  });

  it('throttles per shop host — a busy shop does not slow a different shop', async () => {
    const { raw } = queuedRaw([ok({ 'x-shopify-shop-api-call-limit': '39/40' }), ok()]);
    const clock = fakeClock();
    const transport = createShopifyTransport(raw, { sleep: clock.sleep, now: clock.now });

    await transport.get('https://busy.myshopify.com/admin/api/2024-10/products.json', HEADERS);
    await transport.get('https://calm.myshopify.com/admin/api/2024-10/products.json', HEADERS);

    // The second call is a DIFFERENT host, so it carries no throttle debt.
    expect(clock.sleeps).toHaveLength(0);
  });
});
