/**
 * The Awin Publisher API network boundary (#67), and the only place this
 * domain opens a socket.
 *
 * Isolated for #65's reason: it makes the reader — URL building, JSON mapping,
 * status classification, money parsing — PURE with respect to the wire, which
 * is what lets the whole of it be measured against a fake transport rather than
 * against a mock of itself.
 *
 * ## Two controls, and the second is not redundant
 *
 * The base URL is CONFIGURABLE (`AWIN_PUBLISHER_API_BASE_URL`, for a staging
 * host or a future migration), so an allow-list of literal hosts is not
 * available the way it is for eBay. What IS available is stronger than nothing
 * and is applied first: the composed URL must be `https:` and must share an
 * ORIGIN with the configured base, so no path Mercaria builds and no redirect
 * it follows can move the request to another host. `safeFetch` is the second
 * control and does the work a compiled-in hostname never removes the need for —
 * a configured hostname still resolves through DNS somebody else controls.
 *
 * ## The token is a header, never a query parameter
 *
 * Awin accepts `?accessToken=`, and it must not be used: a URL with a
 * credential in it reaches an access log, an error message and every `catch`
 * that stringifies a request. Nothing here logs a URL, a header or a body.
 */

import { safeFetch, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import type { IncomingMessage } from 'node:http';

/** How large an Awin transactions response may be before it is a fault. */
export const AWIN_PUBLISHER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A normalized provider response: status, lower-cased headers, buffered body. */
export interface AwinPublisherResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/**
 * The injectable boundary.
 *
 * ONE method, because this integration makes one kind of request: a bearer GET.
 * A transport that could do anything is a transport a fake has to model
 * everything of, and every extra verb is a way for a later change to leave the
 * tested path.
 */
export interface AwinPublisherTransport {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<AwinPublisherResponse>;
}

/** Refuse anything that is not https on the configured Publisher API origin. */
export function assertAwinPublisherUrl(url: string, baseUrl: string): URL {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfRejection('Malformed Awin Publisher API URL');
  }
  try {
    base = new URL(baseUrl);
  } catch {
    throw new SsrfRejection('AWIN_PUBLISHER_API_BASE_URL is not a URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfRejection(`Only https is allowed for Awin, got ${parsed.protocol}`);
  }
  if (parsed.origin !== base.origin) {
    // Compared as an ORIGIN and never with `startsWith`, under which
    // `https://api.awin.com.evil.test` is a prefix match of the configured base
    // — the exact host shape every allow-list in this repository exists for.
    throw new SsrfRejection(`${parsed.host} is not the configured Awin Publisher API host`);
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

/** Read a response stream to a string, aborting past the cap. */
async function readBounded(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > AWIN_PUBLISHER_MAX_RESPONSE_BYTES) {
      stream.destroy();
      throw new UpstreamError('Awin Publisher API response exceeded the maximum allowed size');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The real transport: https-only, origin-checked, SSRF-guarded, bounded. */
export const awinPublisherTransport: AwinPublisherTransport = {
  async get(url, headers) {
    const result = await safeFetch(url, { method: 'GET', headers: { ...headers } });
    const body = await readBounded(result.response);
    return { status: result.status, headers: flattenHeaders(result.headers), body };
  },
};
