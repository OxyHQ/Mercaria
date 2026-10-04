import type { z } from 'zod';
import { MERCARIA_PUBLIC_API_BASE_PATH, MercariaErrorBodySchema } from './contract';
import type { MercariaPublicErrorCode } from './contract';
import {
  MercariaAbortError,
  MercariaApiError,
  MercariaBadRequestError,
  MercariaConflictError,
  MercariaError,
  MercariaForbiddenError,
  MercariaGoneError,
  MercariaNetworkError,
  MercariaNotFoundError,
  MercariaRateLimitError,
  MercariaResponseError,
  MercariaTimeoutError,
  MercariaUnauthorizedError,
  MercariaUnavailableError,
  MercariaUnknownRouteError,
  MercariaValidationError,
  type MercariaErrorOptions,
  type MercariaRateLimitErrorOptions,
} from './errors';
import {
  createAbortController,
  globalFetch,
  startTimer,
  stopTimer,
  type MercariaAbortSignal,
  type MercariaFetch,
  type MercariaFetchResponse,
  type MercariaHeadersLike,
} from './runtime';

/** Supplies the caller's Oxy access token; see `MercariaClientOptions.getAccessToken`. */
export type MercariaAccessTokenGetter = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;

/** Everything a request needs from the client. Resolved and validated once. */
export interface TransportConfig {
  apiBaseUrl: string;
  fetch: MercariaFetch | undefined;
  getAccessToken: MercariaAccessTokenGetter | undefined;
  timeoutMs: number;
  headers: Readonly<Record<string, string>>;
}

export type QueryValue = string | number | boolean | undefined;

/**
 * Serialise query parameters DETERMINISTICALLY: `undefined` omitted, keys in
 * sorted order, both halves `encodeURIComponent`-encoded, booleans as
 * `true`/`false`. Two calls with the same input produce byte-identical URLs,
 * which is what lets a consumer (or a CDN) cache by URL.
 *
 * Hand-rolled rather than `URLSearchParams`, which encodes a space as `+` and
 * is incomplete in React Native.
 */
export function serializeQuery(query: Readonly<Record<string, QueryValue>>): string {
  return Object.keys(query)
    .filter((key) => query[key] !== undefined)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`)
    .join('&');
}

/**
 * One path segment. `.` and `..` are refused rather than encoded: the WHATWG
 * URL parser treats `..` AND `%2e%2e` as a parent-directory segment, so an id of
 * `..` would silently address a different route.
 */
export function pathSegment(id: string, what: string): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new MercariaValidationError(`${what} must be a non-empty string`);
  }
  if (id === '.' || id === '..') throw new MercariaValidationError(`${what} is not a valid id`);
  return encodeURIComponent(id);
}

export function buildUrl(apiBaseUrl: string, path: string, query: Readonly<Record<string, QueryValue>>): string {
  const serialized = serializeQuery(query);
  return `${apiBaseUrl}${MERCARIA_PUBLIC_API_BASE_PATH}${path}${serialized === '' ? '' : `?${serialized}`}`;
}

/** The largest amount of server-supplied message text an error will carry. */
const MAX_SERVER_MESSAGE_LENGTH = 200;

/** A server message made safe to put in an error: a string, one line, bounded. */
function safeServerMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (flattened === '') return null;
  return flattened.length > MAX_SERVER_MESSAGE_LENGTH
    ? `${flattened.slice(0, MAX_SERVER_MESSAGE_LENGTH)}…`
    : flattened;
}

function readHeader(headers: MercariaHeadersLike | undefined, name: string): string | null {
  try {
    const value = headers?.get(name);
    return typeof value === 'string' ? value.trim() : null;
  } catch {
    return null;
  }
}

const DELTA_SECONDS = /^\d+$/;

/**
 * Seconds until a rate-limited caller may retry: `Retry-After` (delta-seconds
 * or HTTP-date), then `RateLimit-Reset`, then the `reset=` member of a combined
 * `RateLimit` header. `null` when none is present and parseable.
 */
export function parseRetryAfterSeconds(headers: MercariaHeadersLike | undefined, now = Date.now()): number | null {
  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter) {
    if (DELTA_SECONDS.test(retryAfter)) return Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  }
  const reset = readHeader(headers, 'ratelimit-reset');
  if (reset && DELTA_SECONDS.test(reset)) return Number(reset);
  const combined = readHeader(headers, 'ratelimit');
  const member = combined ? /(?:^|[;,\s])reset=(\d+)/i.exec(combined) : null;
  return member?.[1] !== undefined ? Number(member[1]) : null;
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type ErrorClass = new (message: string, options: MercariaErrorOptions) => MercariaError;

/**
 * The class for each code the server can answer with. Typed as an exhaustive
 * `Record`, so a code added to the contract without a class here is a compile
 * error rather than an error a consumer cannot branch on.
 */
const ERROR_CLASS_BY_CODE: Record<MercariaPublicErrorCode, ErrorClass> = {
  bad_request: MercariaBadRequestError,
  unauthorized: MercariaUnauthorizedError,
  forbidden: MercariaForbiddenError,
  not_found: MercariaNotFoundError,
  unknown_route: MercariaUnknownRouteError,
  gone: MercariaGoneError,
  conflict: MercariaConflictError,
  validation_failed: MercariaValidationError,
  rate_limited: MercariaRateLimitError,
  internal_error: MercariaUnavailableError,
  service_unavailable: MercariaUnavailableError,
};

/**
 * The typed error for a non-2xx response.
 *
 * A body that IS the contract's error (`{ error: { code, message, details? } }`
 * with a code from the closed list) decides the class. Otherwise the status
 * does — with ONE deliberate exception: a 404 or 410 WITHOUT a Mercaria error
 * body is a {@link MercariaApiError}, never `NotFound`/`Gone`. A misrouted
 * proxy or gateway answers 404 for everything, and a consumer told "this
 * product no longer exists" may delete a reference on the strength of it; only
 * Mercaria itself can say that.
 */
export function errorForResponse(status: number, headers: MercariaHeadersLike | undefined, body: unknown): MercariaError {
  const parsed = MercariaErrorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, details } = parsed.data.error;
    const serverMessage = safeServerMessage(parsed.data.error.message);
    const message = serverMessage
      ? `Mercaria API error (HTTP ${status}): ${serverMessage}`
      : `Mercaria API responded with HTTP ${status}`;
    const options: MercariaRateLimitErrorOptions = { status, code, details: details ?? null };
    if (code === 'rate_limited') {
      const fromBody = details?.retryAfterSeconds;
      options.retryAfterSeconds =
        typeof fromBody === 'number' && Number.isSafeInteger(fromBody) && fromBody >= 0
          ? fromBody
          : parseRetryAfterSeconds(headers);
    }
    return new ERROR_CLASS_BY_CODE[code](message, options);
  }

  const message = `Mercaria API responded with HTTP ${status}`;
  if (status === 400) return new MercariaBadRequestError(message, { status });
  if (status === 401) return new MercariaUnauthorizedError(message, { status });
  if (status === 403) return new MercariaForbiddenError(message, { status });
  if (status === 409) return new MercariaConflictError(message, { status });
  if (status === 422) return new MercariaValidationError(message, { status });
  if (status === 429) {
    return new MercariaRateLimitError(message, { status, retryAfterSeconds: parseRetryAfterSeconds(headers) });
  }
  if (status === 404 || status === 410) {
    return new MercariaApiError(`Mercaria API responded with HTTP ${status} without a Mercaria error body`, {
      status,
    });
  }
  if (status === 408) return new MercariaApiError(message, { status, retryable: true });
  if (status >= 500 && status !== 501 && status !== 505) return new MercariaUnavailableError(message, { status });
  return new MercariaApiError(message, { status });
}

/** The most issues a malformed-response message names. */
const MAX_REPORTED_ISSUES = 3;

/** `['items', 3, 'price']` → `items[3].price`. */
function issuePath(path: readonly PropertyKey[]): string {
  const spelled = path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`))
    .join('')
    .replace(/^\./, '');
  return spelled === '' ? '(body)' : spelled;
}

/**
 * A response body that is not the contract, as a message naming the PATH of
 * each offending field and what was expected — never the value received, which
 * may be arbitrary server data.
 */
function malformedMessage(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const named = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
  const more = issues.length > MAX_REPORTED_ISSUES ? ` (and ${issues.length - MAX_REPORTED_ISSUES} more)` : '';
  return `Mercaria returned a malformed response: ${named.join('; ')}${more}`;
}

/**
 * Turn a completed response into data, or into the typed error it represents.
 *
 * A success body IS the value (no envelope), parsed with the contract's schema:
 * a fresh object holding the contract's keys only, so a field the server leaks
 * cannot reach a DTO, and a missing field, a wrong type or a value outside a
 * closed set is a {@link MercariaResponseError}. One malformed row fails the
 * whole page rather than being dropped: dropping would make `items.length` lie
 * and let a consumer paginate past a product it never learns exists.
 */
export function interpretResponse<T>(
  response: { status: number; headers: MercariaHeadersLike | undefined; text: string },
  schema: z.ZodType<T>,
): T {
  const { status, headers, text } = response;
  const body = parseJson(text);

  if (status < 200 || status >= 300) throw errorForResponse(status, headers, body);

  if (body === undefined) {
    throw new MercariaResponseError(`Mercaria returned HTTP ${status} with a body that is not JSON`, { status });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new MercariaResponseError(malformedMessage(parsed.error.issues), { status, cause: parsed.error });
  }
  return parsed.data;
}

type Cancellation = 'aborted' | 'timeout';

/**
 * Perform one GET and parse it.
 *
 * Cancellation is enforced HERE, not delegated to `fetch`: every await — the
 * token getter, the request, the body — is raced against the caller's signal
 * and the timeout, so an injected `fetch` that ignores `signal` still cannot
 * outlive either. The signal is also passed to `fetch` so a real one releases
 * the connection.
 */
export async function request<T>(
  config: TransportConfig,
  path: string,
  query: Readonly<Record<string, QueryValue>>,
  schema: z.ZodType<T>,
  signal: MercariaAbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw new MercariaAbortError('The request was aborted before it was sent');

  const fetchImpl = config.fetch ?? globalFetch();
  if (!fetchImpl) {
    throw new TypeError('No fetch implementation is available; pass `fetch` to createMercariaClient');
  }
  const url = buildUrl(config.apiBaseUrl, path, query);

  const controller = createAbortController();
  let cancellation: Cancellation | undefined;
  let rejectCancelled: (reason: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  // The race below observes this promise; this handler only stops an
  // unobserved rejection from being reported when nothing is awaiting.
  cancelled.catch(() => undefined);

  const cancel = (reason: Cancellation) => {
    if (cancellation !== undefined) return;
    cancellation = reason;
    controller?.abort();
    rejectCancelled(cancellationError(reason, config.timeoutMs));
  };
  const onAbort = () => cancel('aborted');
  signal?.addEventListener('abort', onAbort);
  const timer = startTimer(() => cancel('timeout'), config.timeoutMs);

  const race = <V>(step: Promise<V>): Promise<V> => Promise.race([step, cancelled]);

  try {
    const headers: Record<string, string> = { ...config.headers, Accept: 'application/json' };
    if (config.getAccessToken) {
      const getter = config.getAccessToken;
      const token = await race(Promise.resolve().then(() => getter()));
      if (token !== null && token !== undefined && typeof token !== 'string') {
        throw new TypeError('getAccessToken must return a string, null or undefined');
      }
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    let response: MercariaFetchResponse;
    try {
      response = await race(
        fetchImpl(url, {
          method: 'GET',
          headers,
          credentials: 'omit',
          redirect: 'follow',
          ...(controller ? { signal: controller.signal } : {}),
        }),
      );
    } catch (error) {
      if (cancellation !== undefined) throw cancellationError(cancellation, config.timeoutMs);
      throw new MercariaNetworkError('The request to Mercaria could not be completed', { cause: error });
    }

    let text: string;
    try {
      text = await race(response.text());
    } catch (error) {
      if (cancellation !== undefined) throw cancellationError(cancellation, config.timeoutMs);
      throw new MercariaNetworkError('The response from Mercaria could not be read', {
        status: response.status,
        cause: error,
      });
    }

    return interpretResponse({ status: response.status, headers: response.headers, text }, schema);
  } catch (error) {
    // A cancellation that lands while the token getter is pending surfaces as
    // the race's own rejection; normalise so the caller always sees one class.
    if (cancellation !== undefined && !(error instanceof MercariaError)) {
      throw cancellationError(cancellation, config.timeoutMs);
    }
    throw error;
  } finally {
    stopTimer(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function cancellationError(reason: Cancellation, timeoutMs: number): MercariaError {
  return reason === 'timeout'
    ? new MercariaTimeoutError(`The request to Mercaria timed out after ${timeoutMs} ms`)
    : new MercariaAbortError('The request was aborted');
}
