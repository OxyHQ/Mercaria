/**
 * Shopify HTTP transport — the SSRF-safe network boundary for the Shopify
 * provider. Isolating the network here keeps the provider logic (URL building,
 * JSON mapping) pure and unit-testable by injecting a fake transport.
 *
 * SECURITY. The shop host is caller-influenced (a merchant supplies their shop
 * domain), so every request is SSRF-guarded on TWO levels:
 *   1. HOST ALLOWLIST — the host MUST be `*.myshopify.com`. Shopify controls
 *      that entire namespace and points it only at Shopify infrastructure, so a
 *      value in this set can never address an internal/metadata IP. This is the
 *      primary control and it applies to every request (GET and POST).
 *   2. `@oxyhq/core/server` SSRF primitives — GET goes through `safeFetch`
 *      (validates every hop against the private/metadata denylist AND pins the
 *      connection to the validated IP, closing the DNS-rebind window). POST
 *      (which `safeFetch` cannot carry a body for) validates via
 *      `assertSafePublicUrl` and then PINS the single-hop request to the exact
 *      validated IP (`hostname: ip`, `servername`/`Host` = the shop) so DNS is
 *      never re-resolved between the check and the connection.
 */

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  safeFetch,
  assertSafePublicUrl,
  SsrfRejection,
  UpstreamError,
} from '@oxyhq/core/server';

/** A normalized HTTP response (status + headers + fully-buffered text body). */
export interface ShopifyHttpResponse {
  status: number;
  /** Lower-cased header names → first value (Shopify responses are single-valued). */
  headers: Record<string, string | undefined>;
  body: string;
}

/** The injectable network boundary the Shopify provider talks through. */
export interface ShopifyTransport {
  get(url: string, headers: Record<string, string>): Promise<ShopifyHttpResponse>;
  post(url: string, headers: Record<string, string>, body: string): Promise<ShopifyHttpResponse>;
  del(url: string, headers: Record<string, string>): Promise<ShopifyHttpResponse>;
}

/** Only the Shopify shop namespace may ever be contacted. */
const SHOPIFY_HOST_SUFFIX = '.myshopify.com';
/** Time-to-first-byte deadline for the token-exchange POST. */
const POST_HEADERS_TIMEOUT_MS = 8000;
/** Hard cap on a buffered response body (Shopify product pages are well under this). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Reject any URL whose host is not a Shopify shop host. */
function assertShopifyHost(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfRejection(`Malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfRejection(`Only https is allowed, got ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'myshopify.com' && !host.endsWith(SHOPIFY_HOST_SUFFIX)) {
    throw new SsrfRejection(`Host is not a Shopify shop domain: ${host}`);
  }
  return parsed;
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
      throw new UpstreamError('Shopify response exceeded the maximum allowed size');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The real transport: `safeFetch` for the body-less GET/DELETE (it re-validates
 * every hop + pins the connection to the validated IP), and an IP-pinned https
 * request for POST (which `safeFetch` cannot carry a request body for).
 */
export const shopifyTransport: ShopifyTransport = {
  async get(url, headers) {
    assertShopifyHost(url);
    const result = await safeFetch(url, { method: 'GET', headers });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },

  async del(url, headers) {
    assertShopifyHost(url);
    const result = await safeFetch(url, { method: 'DELETE', headers });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },

  async post(url, headers, body) {
    const parsed = assertShopifyHost(url);

    // Validate + resolve the target with the SDK's SSRF guard, then pin the
    // connection to the exact validated IP (no DNS re-resolution → no rebind).
    const guard = await assertSafePublicUrl(url);
    if (!guard.ok) {
      throw new SsrfRejection('reason' in guard ? guard.reason : 'blocked SSRF target');
    }

    const bodyBuffer = Buffer.from(body, 'utf8');
    return new Promise<ShopifyHttpResponse>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: guard.ip,
          servername: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: {
            ...headers,
            Host: parsed.hostname,
            'Content-Length': String(bodyBuffer.length),
          },
        },
        (res) => {
          readBounded(res).then(
            (responseBody) =>
              resolve({
                status: res.statusCode ?? 0,
                headers: flattenHeaders(res.headers),
                body: responseBody,
              }),
            reject,
          );
        },
      );
      req.setTimeout(POST_HEADERS_TIMEOUT_MS, () => {
        req.destroy(new UpstreamError('Shopify token exchange timed out'));
      });
      req.on('error', reject);
      req.write(bodyBuffer);
      req.end();
    });
  },
};
