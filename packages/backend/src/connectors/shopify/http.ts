/**
 * Shopify HTTP transport — the SSRF-safe network boundary for the Shopify
 * provider. Isolating the network here keeps the provider logic (URL building,
 * JSON mapping) pure and unit-testable by injecting a fake transport.
 *
 * The exported {@link shopifyTransport} is TWO layers:
 *   1. {@link rawShopifyTransport} — the SSRF-hardened single-shot network calls.
 *   2. a RATE-LIMIT wrapper ({@link createShopifyTransport}) that retries HTTP 429
 *      with backoff (honoring `Retry-After`) and proactively throttles when the
 *      shop's REST leaky-bucket (`X-Shopify-Shop-Api-Call-Limit`) is near full, so
 *      every provider method (`verifyConnection`/`fetchProducts`/`fetchInventory`/
 *      `fetchOrders`/`pushProduct`/`pushFulfillment`/collection lookups) is
 *      rate-safe. The wrapper's clock (`now`) and `sleep` are injectable so tests
 *      exercise the retry/throttle logic without ever waiting on a real timer.
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
  put(url: string, headers: Record<string, string>, body: string): Promise<ShopifyHttpResponse>;
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
 * The RAW transport: `safeFetch` for the body-less GET/DELETE (it re-validates
 * every hop + pins the connection to the validated IP), and an IP-pinned https
 * request for POST/PUT (which `safeFetch` cannot carry a request body for). This
 * layer performs NO retry/throttle — {@link createShopifyTransport} wraps it.
 */
export const rawShopifyTransport: ShopifyTransport = {
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
    return ipPinnedWrite('POST', url, headers, body);
  },

  async put(url, headers, body) {
    return ipPinnedWrite('PUT', url, headers, body);
  },
};

/**
 * Perform a body-carrying request (POST/PUT) to a Shopify shop host with the same
 * SSRF hardening as {@link rawShopifyTransport.get}: the host allowlist, the SDK's
 * public-URL guard, then a connection PINNED to the exact validated IP (so DNS is
 * never re-resolved between the check and the connection → no DNS-rebind window).
 */
async function ipPinnedWrite(
  method: 'POST' | 'PUT',
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<ShopifyHttpResponse> {
  const parsed = assertShopifyHost(url);

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
        method,
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
      req.destroy(new UpstreamError('Shopify request timed out'));
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

// --- Rate-limit wrapper (429 retry + proactive leaky-bucket throttle) --------

/** Header carrying the shop's REST leaky-bucket usage, e.g. `"39/40"`. */
const CALL_LIMIT_HEADER = 'x-shopify-shop-api-call-limit';
/** Header Shopify sets on a 429, seconds until a retry may succeed (may be fractional). */
const RETRY_AFTER_HEADER = 'retry-after';
/**
 * Shopify's REST leaky bucket drains at ~2 requests/second (standard plan). Used to
 * size the proactive wait: how long until enough tokens drain below the threshold.
 */
const BUCKET_LEAK_PER_SEC = 2;
/** Start proactively throttling once the bucket is at/over this fraction of its limit. */
const BUCKET_THROTTLE_RATIO = 0.8;
/** Never proactively wait longer than this before a call (a hard cap on self-throttle). */
const THROTTLE_MAX_MS = 2000;
/** Base for the exponential 429 backoff (used only when `Retry-After` is absent). */
const BACKOFF_BASE_MS = 500;
/** Cap on a single 429 backoff wait. */
const BACKOFF_MAX_MS = 60000;
/** Default bound on 429 retries before giving up and surfacing the 429. */
const DEFAULT_MAX_RETRIES = 5;

/** Injectable clock/sleep + retry bound, so tests never wait on a real timer. */
export interface ShopifyTransportOptions {
  /** Sleep for `ms` (default: real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Current epoch ms (default: `Date.now`). */
  now?: () => number;
  /** Max 429 retries before returning the 429 to the caller (default {@link DEFAULT_MAX_RETRIES}). */
  maxRetries?: number;
}

/** Real sleep — a self-clearing one-shot timer (no event-loop retention concern). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Extract the host for per-shop throttle keying; '' when the URL is malformed (raw layer rejects it). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Parse `Retry-After` (fractional seconds) to ms; undefined when absent/non-numeric (→ backoff). */
function retryAfterMs(headers: Record<string, string | undefined>): number | undefined {
  const raw = headers[RETRY_AFTER_HEADER];
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  return undefined;
}

/** Equal-jitter exponential backoff for attempt N (guarantees a non-trivial minimum wait). */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const half = ceiling / 2;
  return Math.floor(half + Math.random() * half);
}

/**
 * Wrap a {@link ShopifyTransport} (the raw SSRF-safe network layer) with Shopify's
 * REST rate-limit discipline:
 *   - On HTTP 429, retry up to `maxRetries` times, waiting `Retry-After` seconds
 *     when present else an exponential backoff with jitter. A 429 means the request
 *     was NOT processed, so retrying it is safe for EVERY method — including the
 *     non-idempotent POST. No other status/error is ever retried (a failed POST is
 *     surfaced to the caller, never silently re-sent).
 *   - Proactively self-throttle per shop host: after each response, read
 *     `X-Shopify-Shop-Api-Call-Limit`; when the bucket is at/over
 *     {@link BUCKET_THROTTLE_RATIO}, delay the shop's NEXT call long enough for the
 *     leaky bucket to drain back under the threshold (capped at {@link THROTTLE_MAX_MS}).
 */
export function createShopifyTransport(
  raw: ShopifyTransport = rawShopifyTransport,
  options: ShopifyTransportOptions = {},
): ShopifyTransport {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  /** Per-shop-host earliest-next-call timestamps (proactive throttle state). */
  const earliestNextCallAt = new Map<string, number>();

  /** Wait out any proactive throttle owed for `host` before issuing its next call. */
  async function respectThrottle(host: string): Promise<void> {
    const until = earliestNextCallAt.get(host);
    if (until === undefined) {
      return;
    }
    const wait = until - now();
    if (wait > 0) {
      await sleep(wait);
    }
  }

  /** Learn from a response's call-limit header; arm/clear the shop's proactive throttle. */
  function updateThrottle(host: string, headers: Record<string, string | undefined>): void {
    const raw = headers[CALL_LIMIT_HEADER];
    if (!raw) {
      return;
    }
    const [usedStr, limitStr] = raw.split('/');
    const used = Number(usedStr);
    const limit = Number(limitStr);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
      return;
    }
    const threshold = limit * BUCKET_THROTTLE_RATIO;
    if (used < threshold) {
      earliestNextCallAt.delete(host);
      return;
    }
    const over = used - threshold;
    const delayMs = Math.min(THROTTLE_MAX_MS, Math.ceil((over / BUCKET_LEAK_PER_SEC) * 1000));
    earliestNextCallAt.set(host, now() + delayMs);
  }

  /** Run one logical request through the throttle + 429-retry loop. */
  async function execute(
    host: string,
    call: () => Promise<ShopifyHttpResponse>,
  ): Promise<ShopifyHttpResponse> {
    let attempt = 0;
    for (;;) {
      await respectThrottle(host);
      const response = await call();
      updateThrottle(host, response.headers);
      if (response.status !== 429 || attempt >= maxRetries) {
        return response;
      }
      await sleep(retryAfterMs(response.headers) ?? backoffMs(attempt));
      attempt += 1;
    }
  }

  return {
    get(url, headers) {
      return execute(hostOf(url), () => raw.get(url, headers));
    },
    post(url, headers, body) {
      return execute(hostOf(url), () => raw.post(url, headers, body));
    },
    put(url, headers, body) {
      return execute(hostOf(url), () => raw.put(url, headers, body));
    },
    del(url, headers) {
      return execute(hostOf(url), () => raw.del(url, headers));
    },
  };
}

/** The default Shopify transport: SSRF-safe raw layer + 429 retry / bucket throttle. */
export const shopifyTransport: ShopifyTransport = createShopifyTransport();
