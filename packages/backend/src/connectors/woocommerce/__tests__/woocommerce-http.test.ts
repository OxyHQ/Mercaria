/**
 * Unit tests for the WooCommerce transport's 429 retry
 * ({@link createWooCommerceTransport}) — #219.
 *
 * The clock and sleep are injected, so the retry logic is exercised WITHOUT any
 * real waiting: the fake `sleep` advances the fake clock, mirroring real time.
 * That is also what makes the two BOUNDS testable at all — a per-wait cap and a
 * total budget are both statements about elapsed time, and a frozen clock would
 * make the budget unreachable and the case vacuous.
 *
 * What is deliberately NOT here, because it is deliberately not in the wrapper:
 * a proactive self-throttle. Shopify's transport has one because Shopify
 * publishes a leaky-bucket header; WordPress publishes nothing of the kind, so
 * there is no header to read and a fixed interval would be Mercaria guessing
 * somebody's hosting plan.
 */

import { describe, it, expect } from 'vitest';
import { createWooCommerceTransport } from '../http.js';
import type { WooCommerceHttpResponse, WooCommerceTransport } from '../http.js';

const URL = 'https://shop.example.test/wp-json/wc/v3/products?per_page=100&page=1';
const HEADERS = { Authorization: 'Basic Y2s6Y3M=', Accept: 'application/json' };

/** A fake raw transport that returns queued responses and records call counts. */
function queuedRaw(responses: WooCommerceHttpResponse[]): {
  raw: WooCommerceTransport;
  calls: () => number;
  methods: string[];
} {
  let index = 0;
  let count = 0;
  const methods: string[] = [];
  const next = (method: string): Promise<WooCommerceHttpResponse> => {
    count += 1;
    methods.push(method);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response);
  };
  const raw: WooCommerceTransport = {
    get: () => next('GET'),
    post: () => next('POST'),
    del: () => next('DELETE'),
  };
  return { raw, calls: () => count, methods };
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

const ok = (): WooCommerceHttpResponse => ({ status: 200, headers: {}, body: '[]' });
const rateLimited = (headers: Record<string, string> = {}): WooCommerceHttpResponse => ({
  status: 429,
  headers,
  body: '{"message":"Too many requests"}',
});

describe('createWooCommerceTransport — 429 retry', () => {
  it('honours Retry-After and succeeds on the retry', async () => {
    const { raw, calls } = queuedRaw([rateLimited({ 'retry-after': '2' }), ok()]);
    const clock = fakeClock();
    const transport = createWooCommerceTransport(raw, { sleep: clock.sleep, now: clock.now });

    const response = await transport.get(URL, HEADERS);

    expect(response.status).toBe(200);
    expect(calls()).toBe(2); // the initial 429 + one retry
    expect(clock.sleeps).toEqual([2000]); // Retry-After: 2s → exactly 2000ms
  });

  it('gives up after maxRetries and SURFACES the final 429', async () => {
    // The behaviour AFTER the retries is unchanged: `assertOk` still turns this
    // into a failed run, which is what keeps "a failed run archives nothing"
    // true rather than newly true.
    const { raw, calls } = queuedRaw([rateLimited({ 'retry-after': '1' })]);
    const clock = fakeClock();
    const transport = createWooCommerceTransport(raw, {
      sleep: clock.sleep,
      now: clock.now,
      maxRetries: 3,
    });

    const response = await transport.get(URL, HEADERS);

    expect(response.status).toBe(429);
    expect(calls()).toBe(4); // 1 initial + 3 retries
    expect(clock.sleeps).toHaveLength(3); // one wait per retry
  });

  it('backs off (bounded, jittered) when a 429 carries no Retry-After', async () => {
    const { raw } = queuedRaw([rateLimited(), rateLimited(), ok()]);
    const clock = fakeClock();
    const transport = createWooCommerceTransport(raw, { sleep: clock.sleep, now: clock.now });

    await transport.get(URL, HEADERS);

    expect(clock.sleeps).toHaveLength(2);
    // Equal jitter: attempt N waits within [ceiling/2, ceiling) for a ceiling of
    // 500 * 2^N. The floor is what makes it a real wait rather than a spin.
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(clock.sleeps[0]).toBeLessThan(500);
    expect(clock.sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(clock.sleeps[1]).toBeLessThan(1000);
  });

  it('CAPS a single wait, however long the host asks for', async () => {
    // An over-eager WAF answering `Retry-After: 3600` would otherwise park a
    // backfill worker asleep for an hour holding its job lease.
    const { raw } = queuedRaw([rateLimited({ 'retry-after': '3600' }), ok()]);
    const clock = fakeClock();
    const transport = createWooCommerceTransport(raw, { sleep: clock.sleep, now: clock.now });

    await transport.get(URL, HEADERS);

    expect(clock.sleeps).toEqual([30_000]);
  });

  it('STOPS retrying once the total wait budget is spent, before maxRetries', async () => {
    // `maxRetries` bounds the COUNT and not the TIME: three capped waits is a
    // minute and a half inside a job with a whole catalogue left to page. The
    // budget is what makes the clock injectable rather than decorative — with a
    // frozen clock this case cannot fail.
    const { raw, calls } = queuedRaw([rateLimited({ 'retry-after': '30' })]);
    const clock = fakeClock();
    const transport = createWooCommerceTransport(raw, {
      sleep: clock.sleep,
      now: clock.now,
      maxRetries: 10,
    });

    const response = await transport.get(URL, HEADERS);

    expect(response.status).toBe(429);
    // Two 30s waits reach the 60s budget exactly; a third would exceed it, so it
    // is refused BEFORE sleeping rather than after.
    expect(clock.sleeps).toEqual([30_000, 30_000]);
    expect(calls()).toBe(3);
  });

  it('does NOT retry a non-429 — a failed POST is never silently re-sent', async () => {
    const { raw, calls } = queuedRaw([{ status: 500, headers: {}, body: '{}' }, ok()]);
    const clock = fakeClock();
    const transport = createWooCommerceTransport(raw, { sleep: clock.sleep, now: clock.now });

    const response = await transport.post(URL, HEADERS, '{}');

    expect(response.status).toBe(500);
    expect(calls()).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries every METHOD, including the registration POST', async () => {
    // A 429 means the request was not processed, so re-sending it creates
    // nothing twice — and #218's registration reports a `rate_limited` topic
    // rather than a duplicate subscription precisely because this holds.
    for (const method of ['get', 'post', 'del'] as const) {
      const { raw, calls, methods } = queuedRaw([rateLimited({ 'retry-after': '0' }), ok()]);
      const clock = fakeClock();
      const transport = createWooCommerceTransport(raw, { sleep: clock.sleep, now: clock.now });

      const response =
        method === 'post'
          ? await transport.post(URL, HEADERS, '{}')
          : await transport[method](URL, HEADERS);

      expect(response.status, `${method} did not retry`).toBe(200);
      expect(calls()).toBe(2);
      expect(new Set(methods).size, 'the retry must re-issue the SAME verb').toBe(1);
    }
  });
});
