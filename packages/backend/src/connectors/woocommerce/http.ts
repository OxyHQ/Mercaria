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

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  safeFetch,
  assertSafePublicUrl,
  SsrfRejection,
  UpstreamError,
} from '@oxyhq/core/server';

/** A normalized HTTP response (status + headers + fully-buffered text body). */
export interface WooCommerceHttpResponse {
  status: number;
  /** Lower-cased header names → first value (WooCommerce responses are single-valued). */
  headers: Record<string, string | undefined>;
  body: string;
}

/**
 * The injectable network boundary the WooCommerce provider talks through. `get` +
 * `del` cover the read/reconcile paths; `post` is used ONLY to register webhooks
 * (create a webhook subscription). Every method is SSRF-guarded (see below); tests
 * inject a fake to exercise the mapping/paging logic without a network.
 */
export interface WooCommerceTransport {
  get(url: string, headers: Record<string, string>): Promise<WooCommerceHttpResponse>;
  post(url: string, headers: Record<string, string>, body: string): Promise<WooCommerceHttpResponse>;
  del(url: string, headers: Record<string, string>): Promise<WooCommerceHttpResponse>;
}

/** Hard cap on a buffered response body (a 100-product WooCommerce page is well under this). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Time-to-first-byte deadline for a body-carrying POST (webhook registration). */
const POST_HEADERS_TIMEOUT_MS = 8000;

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
 * Perform a body-carrying POST to a merchant-supplied WooCommerce host with the same
 * SSRF hardening as the GET path: https-only, the SDK's public-URL guard, then a
 * connection PINNED to the exact validated IP (so DNS is never re-resolved between the
 * check and the connection → no DNS-rebind window). `safeFetch` cannot carry a request
 * body, so — like the Shopify transport — the write goes through a raw pinned request.
 */
async function ipPinnedPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<WooCommerceHttpResponse> {
  assertHttpsUrl(url);
  const parsed = new URL(url);

  const guard = await assertSafePublicUrl(url);
  if (!guard.ok) {
    throw new SsrfRejection('reason' in guard ? guard.reason : 'blocked SSRF target');
  }

  const bodyBuffer = Buffer.from(body, 'utf8');
  return new Promise<WooCommerceHttpResponse>((resolve, reject) => {
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
      req.destroy(new UpstreamError('WooCommerce request timed out'));
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

/**
 * The real transport: `safeFetch` for the body-less GET/DELETE (it re-validates every
 * hop and pins the connection to the validated IP), and an IP-pinned https request for
 * the webhook-registration POST (which `safeFetch` cannot carry a body for). Every
 * path is https-only + SSRF-guarded — a WooCommerce host is fully merchant-supplied.
 */
export const wooCommerceTransport: WooCommerceTransport = {
  async get(url, headers) {
    assertHttpsUrl(url);
    const result = await safeFetch(url, { method: 'GET', headers });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },

  async del(url, headers) {
    assertHttpsUrl(url);
    const result = await safeFetch(url, { method: 'DELETE', headers });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },

  async post(url, headers, body) {
    return ipPinnedPost(url, headers, body);
  },
};
