/**
 * WooCommerce HTTP transport — the SSRF-safe network boundary for the WooCommerce
 * provider. Isolating the network here keeps the provider logic (URL building,
 * JSON mapping) pure and unit-testable by injecting a fake transport.
 *
 * The exported {@link wooCommerceTransport} is TWO layers, like Shopify's:
 *   1. {@link rawWooCommerceTransport} — the SSRF-hardened single-shot calls.
 *   2. a RATE-LIMIT wrapper ({@link createWooCommerceTransport}) that retries
 *      HTTP 429. Its clock and `sleep` are injectable so tests exercise the
 *      retry without waiting on a real timer.
 *
 * **The wrapper is 429 retry and NOTHING else, and that is deliberate** (#219).
 * Shopify's counterpart also self-throttles from
 * `X-Shopify-Shop-Api-Call-Limit`, because Shopify publishes a leaky-bucket
 * header describing one documented, uniform limit. WordPress publishes no such
 * header and has no uniform limit to describe: a WooCommerce 429 comes from
 * Cloudflare, Wordfence, a plan-level cap or a security plugin, each with its
 * own rules. Reading an `X-WP-*`-shaped header would be inventing a contract,
 * and a fixed per-host minimum interval would be Mercaria guessing somebody's
 * hosting plan — slowing every healthy site to protect the ones it cannot
 * measure. What IS honest is reacting to the refusal the host actually sends.
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
 * The RAW transport: `safeFetch` for the body-less GET/DELETE (it re-validates every
 * hop and pins the connection to the validated IP), and an IP-pinned https request for
 * the webhook-registration POST (which `safeFetch` cannot carry a body for). Every
 * path is https-only + SSRF-guarded — a WooCommerce host is fully merchant-supplied.
 * This layer performs NO retry — {@link createWooCommerceTransport} wraps it.
 */
export const rawWooCommerceTransport: WooCommerceTransport = {
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

// --- Rate-limit wrapper (429 retry only — see the file header) --------------

/** Header a host sets on a 429: seconds until a retry may succeed (may be fractional). */
const RETRY_AFTER_HEADER = 'retry-after';
/** Base for the exponential 429 backoff (used only when `Retry-After` is absent). */
const BACKOFF_BASE_MS = 500;
/**
 * Cap on ONE wait, `Retry-After` included.
 *
 * Shopify's equivalent bounds only the computed backoff, because Shopify's own
 * `Retry-After` is a couple of seconds by construction. A WordPress site is
 * somebody's hosting: an over-eager WAF answering `Retry-After: 3600` would
 * otherwise park a backfill worker asleep for an hour holding its job lease. The
 * cap turns that into a bounded retry that eventually surfaces the 429.
 */
const BACKOFF_MAX_MS = 30_000;
/**
 * Total time ONE logical request may spend waiting across all its retries.
 *
 * The second half of the same bound, and the reason the clock is injected at
 * all: `maxRetries` alone bounds the COUNT, and five capped waits is still two
 * and a half minutes inside a job that has a whole catalogue to page through.
 */
const RETRY_BUDGET_MS = 60_000;
/** Default bound on 429 retries before giving up and surfacing the 429. */
const DEFAULT_MAX_RETRIES = 5;

/** Injectable clock/sleep + retry bound, so tests never wait on a real timer. */
export interface WooCommerceTransportOptions {
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
 * Wrap a {@link WooCommerceTransport} with a 429 retry (#219).
 *
 * On HTTP 429, retry up to `maxRetries` times, waiting `Retry-After` when the
 * host sends one (capped at {@link BACKOFF_MAX_MS}) else an equal-jitter
 * exponential backoff, and stopping once {@link RETRY_BUDGET_MS} of waiting has
 * accumulated. A 429 means the request was NOT processed, so retrying it is safe
 * for EVERY method here — including the webhook-registration POST, which is why
 * a refused registration topic can be a `rate_limited` failure worth retrying
 * rather than a duplicate subscription. **No other status or error is ever
 * retried**: a failed POST is surfaced to the caller, never silently re-sent.
 *
 * When the retries are exhausted the final 429 is RETURNED, so `assertOk` turns
 * it into the same failed run it always did — the behaviour after the retries is
 * unchanged, which is what keeps "a failed run archives nothing" true.
 */
export function createWooCommerceTransport(
  raw: WooCommerceTransport = rawWooCommerceTransport,
  options: WooCommerceTransportOptions = {},
): WooCommerceTransport {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  /** Run one logical request through the 429-retry loop. */
  async function execute(
    call: () => Promise<WooCommerceHttpResponse>,
  ): Promise<WooCommerceHttpResponse> {
    const startedAt = now();
    let attempt = 0;
    for (;;) {
      const response = await call();
      if (response.status !== 429 || attempt >= maxRetries) {
        return response;
      }
      const wait = Math.min(retryAfterMs(response.headers) ?? backoffMs(attempt), BACKOFF_MAX_MS);
      // The budget is checked BEFORE the wait, not after: a check afterwards
      // would always permit one more sleep of any size the cap allows, which is
      // the bound not applying to the wait that actually costs the time.
      if (now() - startedAt + wait > RETRY_BUDGET_MS) {
        return response;
      }
      await sleep(wait);
      attempt += 1;
    }
  }

  return {
    get: (url, headers) => execute(() => raw.get(url, headers)),
    post: (url, headers, body) => execute(() => raw.post(url, headers, body)),
    del: (url, headers) => execute(() => raw.del(url, headers)),
  };
}

/** The default WooCommerce transport: SSRF-safe raw layer + 429 retry. */
export const wooCommerceTransport: WooCommerceTransport = createWooCommerceTransport();
