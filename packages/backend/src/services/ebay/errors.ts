/**
 * eBay's error taxonomy, translated into #62's — issue #65 §"Provider error
 * taxonomy and retry rules".
 *
 * ## The rule that costs a catalogue
 *
 * `retryable` decides whether the run is RELEASED (cursor intact, retried) or
 * CLOSED (outcome recorded, health moved). Neither branch can retire anything —
 * a failed fetch never sets `AdapterFetchPage.complete`, and
 * `catalog_source_runs_retirement_check` refuses a retirement count on any
 * outcome outside `CATALOG_SOURCE_RETIRING_OUTCOMES` — so issue #65 reliability
 * 6 ("do not expire prior offers from a transient account outage") holds
 * whatever this file gets wrong. What this file decides is whether Mercaria
 * hammers eBay or backs off.
 *
 * ## Why the classification reads the STATUS first and the errorId second
 *
 * eBay returns a JSON error envelope with numeric `errorId`s, and the set is
 * large, versioned and partly undocumented. A classifier that switched on it
 * would be a table nobody could keep current, and an unrecognised id would fall
 * through to a default that is wrong in exactly the expensive direction. The
 * HTTP status is small, stable and standardised; the `errorId` is used for the
 * two distinctions the status genuinely cannot make:
 *
 *  - **`1001`/`1002` inside a 400 is an expired or invalid TOKEN**, not a bad
 *    request. Reading it as `schema_drift` would quarantine a healthy feed for a
 *    credential that needed re-minting.
 *  - **`11001` (application quota exceeded) inside a 403** is a rate limit and
 *    not an authorisation failure. Reading it as `auth_failure` would mark the
 *    source `failed` and page somebody about a credential that is fine.
 *
 * ## Why an unknown status is a RETRYABLE outage
 *
 * `classifyFetchError` in #62 makes exactly the same choice for an unrecognised
 * throw and states the reason: something in a system Mercaria does not control
 * went wrong and nobody said what. Guessing `schema_drift` would quarantine a
 * whole marketplace over a socket reset.
 */

import { CatalogSourceFetchError } from '../ingestion/adapter.js';

/**
 * eBay `errorId`s that mean the ACCESS TOKEN is the problem.
 *
 * They arrive with a 400 rather than a 401, which is the trap: the status says
 * "your request was malformed" and the body says "your token expired".
 */
const EBAY_TOKEN_ERROR_IDS: readonly number[] = [1001, 1002];

/**
 * eBay `errorId`s that mean the APPLICATION QUOTA is exhausted.
 *
 * They arrive with a 403. `10001` is the per-call rate limit and `11001` is the
 * daily application quota; both mean "come back later", and neither means the
 * credential is wrong.
 */
const EBAY_RATE_LIMIT_ERROR_IDS: readonly number[] = [10001, 11001];

/** One error as eBay's envelope carries it. Nothing else in the body is read. */
export interface EbayErrorEnvelopeEntry {
  readonly errorId?: number;
  readonly message?: string;
  readonly longMessage?: string;
}

/**
 * Pull the error ids out of a provider body, defensively.
 *
 * A body that is not the envelope, is not JSON at all, or is an HTML error page
 * from a load balancer returns an empty list — every one of those is a real
 * thing eBay's edge returns, and none of them should throw inside a classifier
 * whose job is to describe a failure.
 */
export function readEbayErrorIds(body: string): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  const ids: number[] = [];
  for (const entry of errors) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = (entry as EbayErrorEnvelopeEntry).errorId;
    if (typeof id === 'number' && Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

/**
 * Read a `Retry-After` header into milliseconds.
 *
 * Both forms the RFC permits: delta-seconds, and an HTTP date. A provider that
 * told you when to come back is a provider you do not guess a backoff for —
 * #62 honours it when it is LONGER than the computed one and never when it is
 * shorter, so a provider cannot talk Mercaria into hammering it either.
 */
export function readRetryAfterMs(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  const delta = date.getTime() - now.getTime();
  return delta > 0 ? delta : 0;
}

/**
 * Turn one non-2xx provider response into a classified framework failure.
 *
 * @param status The HTTP status eBay answered with.
 * @param body The response body, for its `errorId`s. Never stored, never logged.
 * @param retryAfter The `Retry-After` header, when the provider sent one.
 */
export function classifyEbayResponse(input: {
  status: number;
  body: string;
  retryAfter?: string;
  now: Date;
  context: string;
}): CatalogSourceFetchError {
  const { status, body, context } = input;
  const ids = readEbayErrorIds(body);
  const retryAfterMs = readRetryAfterMs(input.retryAfter, input.now);
  const withRetryAfter = retryAfterMs === undefined ? {} : { retryAfterMs };

  // A quota refusal wearing a 403. Checked BEFORE the status, because the status
  // alone would send somebody to rotate a credential that is working.
  if (ids.some((id) => EBAY_RATE_LIMIT_ERROR_IDS.includes(id))) {
    return new CatalogSourceFetchError('rate_limit', `${context}: eBay quota exceeded`, {
      retryable: true,
      ...withRetryAfter,
    });
  }

  // An expired token wearing a 400. Retryable, because the very next attempt
  // mints a fresh one — and NOT `auth_failure`, which would mark the source
  // failed for a token that had merely aged out mid-page.
  if (ids.some((id) => EBAY_TOKEN_ERROR_IDS.includes(id))) {
    return new CatalogSourceFetchError('auth_failure', `${context}: eBay rejected the access token`, {
      retryable: true,
      ...withRetryAfter,
    });
  }

  if (status === 429) {
    return new CatalogSourceFetchError('rate_limit', `${context}: eBay rate limited the request`, {
      retryable: true,
      ...withRetryAfter,
    });
  }

  if (status === 401 || status === 403) {
    /**
     * CREDENTIAL OR APPROVAL LOSS — issue #65 reliability 5, "stop safely".
     *
     * NOT retryable, deliberately. A revoked keyset, a lapsed Buy API approval
     * and a rotated secret all answer identically on every attempt, and retrying
     * them spends the whole daily budget re-asking the same question. #62 closes
     * the run with `auth_failure`, moves the source to `failed`, and retires
     * NOTHING — which is exactly "stop safely": the catalogue Mercaria already
     * holds keeps serving under its existing rights while somebody looks at the
     * credential.
     */
    return new CatalogSourceFetchError('auth_failure', `${context}: eBay refused the credential`, {
      retryable: false,
      ...withRetryAfter,
    });
  }

  if (status === 404) {
    // A single item that is gone is NOT an error at this layer — `getItems`
    // reports it per id in a partial success. A 404 on a whole request means the
    // path is wrong, which is a schema problem and not a transient one.
    return new CatalogSourceFetchError('schema_drift', `${context}: eBay answered 404`, {
      retryable: false,
    });
  }

  if (status >= 500) {
    return new CatalogSourceFetchError('source_outage', `${context}: eBay answered ${status}`, {
      retryable: true,
      ...withRetryAfter,
    });
  }

  if (status === 400 || status === 422) {
    return new CatalogSourceFetchError(
      'schema_drift',
      `${context}: eBay rejected the request (${status})`,
      { retryable: false },
    );
  }

  // Anything else. #62's own reading of an unrecognised failure, verbatim.
  return new CatalogSourceFetchError('source_outage', `${context}: eBay answered ${status}`, {
    retryable: true,
    ...withRetryAfter,
  });
}

/**
 * A body that parsed as JSON but is not the shape the parser expects.
 *
 * `parse_failure` rather than `schema_drift`: the two are different repairs.
 * Drift is "the provider renamed a field", which needs a code change; a parse
 * failure is "this response was not what a response looks like", which is
 * usually one bad page. Neither is retryable — replaying the same bytes produces
 * the same result — and #62 records both without retiring anything.
 */
export function ebayParseFailure(context: string, detail: string): CatalogSourceFetchError {
  return new CatalogSourceFetchError('parse_failure', `${context}: ${detail}`, {
    retryable: false,
  });
}
