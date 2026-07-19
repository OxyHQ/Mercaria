/**
 * WooCommerce HTTP transport — the SSRF-safe network boundary for the WooCommerce
 * provider. Isolating the network here keeps the provider logic (URL building,
 * JSON mapping) pure and unit-testable by injecting a fake transport.
 *
 * SECURITY. Unlike Shopify (whose shop host is confined to the `*.myshopify.com`
 * namespace), a WooCommerce site host is FULLY merchant-supplied — any hostname on
 * the public internet. There is therefore no host allowlist to lean on, so SSRF
 * defence rests entirely on two controls applied to EVERY request:
 *   1. HTTPS-ONLY — WooCommerce's over-HTTPS Basic auth requires TLS, and rejecting
 *      `http:` also removes the cleartext downgrade that would expose the consumer
 *      secret. A malformed or non-https URL is rejected before any DNS lookup.
 *   2. `@oxyhq/core/server` `safeFetch` — validates every hop (including redirects)
 *      against the private/link-local/metadata denylist AND pins the connection to
 *      the validated IP, closing the DNS-rebind window. The pull path is read-only
 *      (GET), which is exactly what `safeFetch` carries.
 */

import type { IncomingMessage } from 'node:http';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxyhq/core/server';

/** A normalized HTTP response (status + headers + fully-buffered text body). */
export interface WooCommerceHttpResponse {
  status: number;
  /** Lower-cased header names → first value (WooCommerce responses are single-valued). */
  headers: Record<string, string | undefined>;
  body: string;
}

/** The injectable network boundary the WooCommerce provider talks through (read-only). */
export interface WooCommerceTransport {
  get(url: string, headers: Record<string, string>): Promise<WooCommerceHttpResponse>;
}

/** Hard cap on a buffered response body (a 100-product WooCommerce page is well under this). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Reject any non-https or malformed URL before it is dispatched. */
function assertHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfRejection(`Malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfRejection(`Only https is allowed for WooCommerce, got ${parsed.protocol}`);
  }
}

/** Flatten Node's multi-valued header map to first-value strings. */
function flattenHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** Read a response stream to a string, aborting if it exceeds {@link MAX_BODY_BYTES}. */
async function readBounded(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      stream.destroy();
      throw new UpstreamError('WooCommerce response exceeded the maximum allowed size');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The real transport: `safeFetch` for the body-less GET (it re-validates every hop
 * and pins the connection to the validated IP). The pull-only WooCommerce provider
 * never issues a body-carrying request, so only GET is exposed.
 */
export const wooCommerceTransport: WooCommerceTransport = {
  async get(url, headers) {
    assertHttpsUrl(url);
    const result = await safeFetch(url, { method: 'GET', headers });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },
};
