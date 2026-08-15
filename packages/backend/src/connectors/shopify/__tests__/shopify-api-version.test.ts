/**
 * The API-version read-back, and proof that it fires.
 *
 * Shopify does not fail a request for a retired version — it "falls forward and
 * responds using the oldest accessible stable version", and says so only in the
 * `X-Shopify-API-Version` response header. So the pin in `index.ts` is a comment
 * unless something reads that header back: every call succeeds, every response
 * parses, and the shapes being normalized belong to a version nobody chose.
 * Shopify's own guidance is exactly this check — "if it differs from what you
 * requested, your app is targeting an inaccessible version".
 *
 * A detector that has never been shown to fire is a detector nobody has tested,
 * so each case here has its opposite beside it: the mismatch warns AND the match
 * is silent, the header being absent records NOTHING rather than a false
 * reassurance, and an unobserved host answers `null` rather than "fine".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShopifyTransport, lastServedShopifyApiVersion } from '../http.js';
import type { ShopifyHttpResponse, ShopifyTransport } from '../http.js';
import { log } from '../../../lib/logger.js';

/** A distinct host per case: the observation map is module-level and per host. */
let hostCounter = 0;
function freshShopUrl(version: string): { url: string; host: string } {
  hostCounter += 1;
  const host = `version-probe-${hostCounter}.myshopify.com`;
  return { url: `https://${host}/admin/api/${version}/shop.json`, host };
}

/** A raw transport that answers every method with one canned response. */
function transportAnswering(headers: Record<string, string>): ShopifyTransport {
  const response: ShopifyHttpResponse = { status: 200, headers, body: '{}' };
  return {
    get: async () => response,
    post: async () => response,
    put: async () => response,
    del: async () => response,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(log.general, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('the served API version is read back', () => {
  it('WARNS when Shopify served a different version than was requested', async () => {
    const { url, host } = freshShopUrl('2024-10');
    const transport = createShopifyTransport(
      transportAnswering({ 'x-shopify-api-version': '2025-10' }),
    );

    await transport.get(url, {});

    expect(lastServedShopifyApiVersion(host)).toBe('2025-10');
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.requestedApiVersion).toBe('2024-10');
    expect(fields.servedApiVersion).toBe('2025-10');
  });

  it('is SILENT when the served version matches — the control', async () => {
    // Without this, a warner that fired on every response would pass the case
    // above and be indistinguishable from a working detector.
    const { url, host } = freshShopUrl('2025-10');
    const transport = createShopifyTransport(
      transportAnswering({ 'x-shopify-api-version': '2025-10' }),
    );

    await transport.get(url, {});

    expect(lastServedShopifyApiVersion(host)).toBe('2025-10');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE per host and version pair, however many calls are made', async () => {
    // A catalogue backfill is thousands of calls. One configuration fact must
    // not become thousands of log lines, or the signal is buried by itself.
    const { url } = freshShopUrl('2024-10');
    const transport = createShopifyTransport(
      transportAnswering({ 'x-shopify-api-version': '2025-10' }),
    );

    await transport.get(url, {});
    await transport.get(url, {});
    await transport.get(url, {});

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('records NOTHING when the response carries no version header', async () => {
    // Absence is not agreement. Recording the requested version here would make
    // a transport that never heard from Shopify report a healthy pin.
    const { url, host } = freshShopUrl('2024-10');
    const transport = createShopifyTransport(transportAnswering({}));

    await transport.get(url, {});

    expect(lastServedShopifyApiVersion(host)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers null for a host nothing has called', () => {
    expect(lastServedShopifyApiVersion('never-called.myshopify.com')).toBeNull();
  });

  it('reads the version out of the REQUEST URL, not a second copy of the pin', async () => {
    // The comparison is between what was genuinely asked and what genuinely
    // answered, so there is no constant here to drift from `index.ts`.
    const { url, host } = freshShopUrl('2019-04');
    const transport = createShopifyTransport(
      transportAnswering({ 'x-shopify-api-version': '2026-07' }),
    );

    await transport.get(url, {});

    expect(lastServedShopifyApiVersion(host)).toBe('2026-07');
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.requestedApiVersion).toBe('2019-04');
  });
});
