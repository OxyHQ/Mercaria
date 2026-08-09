/**
 * The eBay network boundary — issue #65, and the only place this domain opens a
 * socket.
 *
 * Isolated for the reason the WooCommerce transport is: it makes the provider
 * logic (URL building, JSON mapping, the phase machine) pure and testable by
 * injecting a fake, which is exactly what the #62 contract suite needs in order
 * to run all thirteen cases against the REAL adapter.
 *
 * ## The host is a code constant, so this is not the SSRF surface WooCommerce is
 *
 * A WooCommerce host is fully merchant-supplied and its transport therefore
 * rests entirely on `safeFetch`'s runtime validation. eBay's is one of two
 * compile-time constants, so the first control here is an ALLOW-LIST — the
 * strongest form, because it cannot be widened by data — and `safeFetch` is the
 * second, still applied because a compiled-in hostname still resolves through
 * DNS somebody else controls and a redirect can still be answered by anything.
 *
 * ## The POST is IP-pinned by hand for the same reason WooCommerce's is
 *
 * `safeFetch` cannot carry a request body, and the OAuth token exchange is a
 * form POST. The pinned request re-validates the URL, then connects to the exact
 * validated IP with the original `servername`, so DNS is never re-resolved
 * between the check and the connection.
 *
 * ## Nothing here logs a request, a header or a body
 *
 * The token request carries a Basic credential and the token response carries a
 * bearer token. There is no debug switch that would print either, and the errors
 * this module raises name the OPERATION and the status — never a URL with a
 * query string, which on the Browse API carries the search terms and on the
 * token endpoint would carry nothing worth the risk of getting it wrong.
 */

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { safeFetch, assertSafePublicUrl, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import { EBAY_ALLOWED_HOSTS, EBAY_MAX_RESPONSE_BYTES, EBAY_REQUEST_TIMEOUT_MS } from './constants.js';

/** A normalized provider response: status, lower-cased headers, buffered body. */
export interface EbayHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/**
 * The injectable network boundary.
 *
 * Two methods, because this integration makes two kinds of request: a bearer GET
 * against Browse, and one form POST against the token endpoint. There is
 * deliberately no general `request` — a transport that could do anything is a
 * transport a fake has to model everything of.
 */
export interface EbayTransport {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<EbayHttpResponse>;
  postForm(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): Promise<EbayHttpResponse>;
}

/**
 * Refuse anything that is not https on a host eBay actually serves.
 *
 * Before DNS, before a socket, before a credential is composed. The allow-list
 * is the control a data-driven base URL would have removed.
 */
function assertEbayUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfRejection('Malformed eBay URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfRejection(`Only https is allowed for eBay, got ${parsed.protocol}`);
  }
  if (!EBAY_ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new SsrfRejection(`${parsed.hostname} is not an eBay API host`);
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

/** Read a response stream to a string, aborting past {@link EBAY_MAX_RESPONSE_BYTES}. */
async function readBounded(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > EBAY_MAX_RESPONSE_BYTES) {
      stream.destroy();
      throw new UpstreamError('eBay response exceeded the maximum allowed size');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The form POST the token exchange needs, with the same hardening as the GET. */
async function ipPinnedPostForm(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): Promise<EbayHttpResponse> {
  const parsed = assertEbayUrl(url);
  const guard = await assertSafePublicUrl(url);
  if (!guard.ok) {
    throw new SsrfRejection('reason' in guard ? guard.reason : 'blocked SSRF target');
  }

  const bodyBuffer = Buffer.from(body, 'utf8');
  return new Promise<EbayHttpResponse>((resolve, reject) => {
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
    req.setTimeout(EBAY_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new UpstreamError('eBay request timed out'));
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

/** The real transport. Both paths are https-only, host-allow-listed and SSRF-guarded. */
export const ebayTransport: EbayTransport = {
  async get(url, headers) {
    assertEbayUrl(url);
    const result = await safeFetch(url, { method: 'GET', headers: { ...headers } });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },

  async postForm(url, headers, body) {
    return ipPinnedPostForm(url, headers, body);
  },
};
