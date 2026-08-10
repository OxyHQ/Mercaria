/**
 * The Printful network boundary (#125) — the only place this integration opens a
 * socket, and the second half of the live gate.
 *
 * Isolated for the reason eBay's `http.ts` is: it makes the adapters PURE, which
 * is what lets #124's conformance suite and #62's contract suite drive the REAL
 * adapters over a fake wire. A mocked adapter would be measuring the mock; a
 * fake transport measures the adapter, the orchestration, the attempt log and
 * the convergence path.
 *
 * ## The host is a code constant, so the allow-list is the primary control
 *
 * `api.printful.com` is compiled in, and {@link PRINTFUL_ALLOWED_HOSTS} is
 * checked before DNS, before a socket and before a credential is composed —
 * the strongest form of the control, because it cannot be widened by data.
 * `safeFetch` is still applied on top, because a compiled-in hostname still
 * resolves through DNS somebody else controls and a redirect can still be
 * answered by anything (eBay's transport says the same and for the same reason).
 *
 * ## `afterWrite` is observed, never guessed
 *
 * #124's whole ambiguity model rests on it, and this is the only layer that can
 * see it. The request is flushed explicitly and a flag is set when `end()` has
 * completed; a failure before that point wrote nothing and is `afterWrite:
 * false`, and everything after it — a read timeout, an aborted response, a
 * socket reset mid-body — is `true`. An error that arrives with no flag either
 * way answers `true`, because reading an unknown as "definitely nothing was
 * written" is the assumption that places a second supplier order.
 *
 * ## Nothing here logs a request, a header, a body or a token
 *
 * The bearer token is a Printful credential and the bodies carry a buyer's
 * street address. The errors this module raises name the METHOD and the PATH
 * and nothing else — never a query string, never a header map.
 */

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { assertSafePublicUrl, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import type {
  PrintfulRequest,
  PrintfulResponse,
  PrintfulTransport,
} from './transport-contract.js';
import { PRINTFUL_BASE_URL, PrintfulTransportError } from './transport-contract.js';

/** The only hosts this integration will ever speak to. */
export const PRINTFUL_ALLOWED_HOSTS: readonly string[] = ['api.printful.com'];

/**
 * A bound on what Mercaria will read back.
 *
 * A catalogue page is a few hundred kilobytes; anything an order of magnitude
 * past that is a response nobody expected, and reading it to completion is how a
 * task's memory becomes a provider's problem.
 */
const PRINTFUL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * How a live call gets its bearer token.
 *
 * A PORT, resolved per call, so the transport holds no secret between calls and
 * cannot cache one across a rotation — #124's arrangement, applied to the
 * preflight path where #122's contract carries no credential. `null` means the
 * approved secret system has no value for this account, which is a refusal and
 * never a fallback.
 */
export type PrintfulCredentialResolver = (providerAccountId: string) => Promise<string | null>;

/** Build a transport over one credential resolver. */
export function createPrintfulTransport(options: {
  readonly baseUrl?: string;
  readonly resolveCredential: PrintfulCredentialResolver;
}): PrintfulTransport {
  const baseUrl = options.baseUrl ?? PRINTFUL_BASE_URL;
  return {
    baseUrl,
    async call(request: PrintfulRequest): Promise<PrintfulResponse> {
      const credential = request.credential ?? (await options.resolveCredential(request.storeId ?? ''));
      if (credential === null || credential.trim() === '') {
        // The live gate's second half. #122's quote path hands no credential, so
        // the adapter cannot check one — this is where an unprovisioned account
        // is refused instead. `afterWrite: false` because nothing was sent.
        throw new PrintfulTransportError(
          'no Printful credential is provisioned for this supplier account',
          { afterWrite: false, retryable: false },
        );
      }
      return await send(baseUrl, request, credential);
    },
  };
}

/** Refuse anything that is not https on a host Printful actually serves. */
function assertPrintfulUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfRejection('Malformed Printful URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfRejection(`Only https is allowed for Printful, got ${parsed.protocol}`);
  }
  if (!PRINTFUL_ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new SsrfRejection(`${parsed.hostname} is not a Printful API host`);
  }
  return parsed;
}

/** Flatten Node's multi-valued header map to first-value lower-cased strings. */
function flattenHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) out[key.toLowerCase()] = first;
  }
  return out;
}

/** Read a response stream to a string, aborting past the size bound. */
async function readBounded(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > PRINTFUL_MAX_RESPONSE_BYTES) {
      stream.destroy();
      throw new UpstreamError('Printful response exceeded the maximum allowed size');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One IP-pinned HTTPS request.
 *
 * Pinned rather than `safeFetch` for every verb, because `safeFetch` cannot
 * carry a request body and most of this integration's calls are POSTs. The URL
 * is re-validated, then the connection is made to the exact validated IP with
 * the original `servername`, so DNS is never re-resolved between the check and
 * the connection.
 */
async function send(
  baseUrl: string,
  request: PrintfulRequest,
  credential: string,
): Promise<PrintfulResponse> {
  const url = new URL(request.path, baseUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const parsed = assertPrintfulUrl(url.toString());
  const guard = await assertSafePublicUrl(url.toString());
  if (!guard.ok) {
    throw new SsrfRejection('reason' in guard ? guard.reason : 'blocked SSRF target');
  }

  const bodyBuffer =
    request.body === undefined ? null : Buffer.from(JSON.stringify(request.body), 'utf8');

  return await new Promise<PrintfulResponse>((resolve, reject) => {
    // THE flag the whole ambiguity model rests on. It flips only once the
    // request has been fully flushed to the socket, so a failure before that
    // point provably wrote nothing.
    let flushed = false;
    const req = httpsRequest(
      {
        hostname: guard.ip,
        servername: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: request.method,
        headers: {
          Host: parsed.hostname,
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
          ...(request.storeId === null ? {} : { 'X-PF-Store-Id': request.storeId }),
          ...(bodyBuffer === null
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': String(bodyBuffer.length) }),
        },
      },
      (res) => {
        readBounded(res).then(
          (text) => {
            let body: unknown = null;
            let parsedBody = false;
            if (text.trim() !== '') {
              try {
                body = JSON.parse(text);
                parsedBody = true;
              } catch {
                // Left unparsed on purpose. The adapter tells "the body was
                // null" from "the body was not JSON", and an unreadable 2xx is
                // an AMBIGUITY rather than a success.
                body = null;
              }
            } else {
              parsedBody = true;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: flattenHeaders(res.headers),
              body,
              parsed: parsedBody,
            });
          },
          (error: unknown) => {
            // A failure while READING the response: the request was certainly
            // written and Printful certainly acted on it.
            reject(
              new PrintfulTransportError('printful response could not be read', {
                afterWrite: true,
                retryable: true,
                cause: error,
              }),
            );
          },
        );
      },
    );
    req.setTimeout(request.timeoutMs, () => {
      req.destroy(new UpstreamError('printful request timed out'));
    });
    req.on('error', (error: unknown) => {
      reject(
        new PrintfulTransportError('printful request failed', {
          afterWrite: flushed,
          retryable: true,
          cause: error,
        }),
      );
    });
    if (bodyBuffer !== null) req.write(bodyBuffer);
    req.end(() => {
      flushed = true;
    });
  });
}
