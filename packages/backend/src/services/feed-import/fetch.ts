/**
 * Fetching a merchant-supplied URL (#63 security 1, 2 and 5).
 *
 * ## `safeFetch` is the WHOLE SSRF defence, and nothing here is hand-rolled
 *
 * `@oxyhq/core/server`'s `safeFetch` resolves the host, refuses every
 * private/link-local/metadata range, PINS the TCP connection to the validated
 * address (so there is no DNS-rebind window between the check and the connect)
 * and re-validates every redirect hop, destroying redirect bodies rather than
 * draining them. `services/merchant-claims/site-verification.ts` uses it for the
 * same class of caller-influenced host and states the same rule: an app-local
 * URL check here would be a second, weaker answer to a question the SDK already
 * answers correctly, and the two would drift.
 *
 * Three things are added ON TOP, all of them properties of a FEED rather than
 * of a URL:
 *
 *  - **HTTPS only.** Enforced by CHECK on the column and re-asserted here,
 *    because a feed fetched over cleartext can be rewritten by anyone on the
 *    path — and a rewritten feed is a catalogue of somebody else's choosing,
 *    including its prices and its outbound links.
 *  - **A streamed, bounded read.** `safeFetch` hands the caller the stream and
 *    says the caller owns it. A feed is gigabytes, so it is never buffered; the
 *    caps live in `bytes.ts` and this module simply hands the stream over.
 *  - **Conditional requests.** `If-None-Match` / `If-Modified-Since` from the
 *    configuration's stored validators, which is issue §"Supported inputs" 5 —
 *    and the reason {@link FeedFetchOutcome} has a `not_modified` branch that
 *    carries no stream at all.
 *
 * ## A 304 is a SEPARATE outcome, not an empty feed
 *
 * This is the trap conditional requests introduce and the reason the branch is
 * a discriminated union rather than a flag. A 304 answered on a SNAPSHOT feed
 * means "your copy is current" — but a pass that read zero records and reported
 * a complete enumeration retires the entire catalogue. There is no
 * `records: []` for a caller to mistake for an enumeration, because the branch
 * has no records member.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import { FeedImportRefusal } from './errors.js';
import { authorizeFeedRequest, type FeedAuthorization } from './auth.js';

/** The validators a conditional request presents. */
export interface FeedValidators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface FeedFetchRequest {
  readonly url: string;
  readonly authorization: FeedAuthorization;
  readonly validators: FeedValidators;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * What a fetch produced. Three branches, and only one of them has bytes.
 *
 * `not_modified` carries the validators back unchanged so the caller can leave
 * them in place; inventing new ones from a 304's headers is how a validator
 * gets lost and every subsequent request becomes unconditional.
 */
export type FeedFetchOutcome =
  | {
      readonly kind: 'ok';
      readonly bytes: AsyncIterable<Uint8Array>;
      readonly validators: FeedValidators;
      /** Closes the socket. The caller MUST call it, in every branch. */
      readonly close: () => void;
    }
  | { readonly kind: 'not_modified' };

/**
 * Open a feed stream.
 *
 * Every failure becomes a {@link FeedImportRefusal} with a reason from the
 * closed set, so the adapter never has to classify an exception — a refusal
 * already knows whether it is an auth failure, an outage or a blocked address,
 * and `feedRefusalFetchKind` turns it into #62's vocabulary by table lookup.
 */
export async function openFeedStream(request: FeedFetchRequest): Promise<FeedFetchOutcome> {
  if (!request.url.toLowerCase().startsWith('https://')) {
    throw new FeedImportRefusal(
      'insecure_url',
      'A feed must be fetched over HTTPS. A feed served in cleartext can be rewritten in ' +
        'transit, and a rewritten feed is a catalogue of somebody else’s choosing.',
    );
  }

  const authorized = authorizeFeedRequest(request.url, request.authorization);
  const headers: Record<string, string> = { ...authorized.headers };
  if (request.validators.etag !== null) headers['if-none-match'] = request.validators.etag;
  if (request.validators.lastModified !== null) {
    headers['if-modified-since'] = request.validators.lastModified;
  }

  let result;
  try {
    result = await safeFetch(authorized.url, {
      method: 'GET',
      headers,
      headersTimeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error: unknown) {
    if (error instanceof SsrfRejection) {
      // A feed "host" resolving into a private range is not a transport failure
      // to retry — it is the check working, and it is a configuration fault.
      throw new FeedImportRefusal(
        'blocked_address',
        'The feed host resolves to an address the SSRF guard refuses (private, link-local, ' +
          'loopback or metadata range).',
        { cause: error },
      );
    }
    if (error instanceof UpstreamError) {
      throw new FeedImportRefusal('upstream_unavailable', 'The feed host did not answer in time.', {
        cause: error,
      });
    }
    throw new FeedImportRefusal('upstream_unavailable', 'The feed host could not be reached.', {
      cause: error,
    });
  }

  const { response, status, headers: responseHeaders } = result;

  if (status === 304) {
    response.destroy();
    return { kind: 'not_modified' };
  }
  if (status === 401 || status === 403) {
    response.destroy();
    throw new FeedImportRefusal(
      'unauthorized',
      `The feed host answered ${status}. The stored credential is missing, wrong or expired.`,
    );
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new FeedImportRefusal('upstream_status', `The feed host answered ${status}.`);
  }

  return {
    kind: 'ok',
    bytes: response,
    validators: readValidators(responseHeaders),
    close: () => {
      response.destroy();
    },
  };
}

/** The validators to present NEXT time, bounded to what the column accepts. */
function readValidators(headers: IncomingHttpHeaders): FeedValidators {
  const etag = firstHeader(headers.etag);
  const lastModified = firstHeader(headers['last-modified']);
  return {
    etag: etag === null ? null : etag.slice(0, 256),
    lastModified: lastModified === null ? null : lastModified.slice(0, 128),
  };
}

function firstHeader(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && single.trim() !== '' ? single.trim() : null;
}
