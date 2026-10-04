import type { MercariaErrorDetails, MercariaPublicErrorCode } from './contract';

/**
 * Every code a {@link MercariaError} can carry.
 *
 * The server's stable codes (`MERCARIA_PUBLIC_ERROR_CODES`, snake_case) pass
 * through unchanged when a response names one. The rest describe failures the
 * server never got to report: the request never completed, the caller
 * cancelled it, the body was not the contract, or the status carried no
 * Mercaria error body.
 */
export type MercariaErrorCode =
  | MercariaPublicErrorCode
  | 'network_error'
  | 'timeout'
  | 'aborted'
  | 'malformed_response'
  | 'http_error';

/** Options every error constructor accepts. All optional; each class has defaults. */
export interface MercariaErrorOptions {
  /** HTTP status, or `null` when no response was received. */
  status?: number | null;
  code?: MercariaErrorCode;
  retryable?: boolean;
  /** The server's `error.details` (scalars only), or the SDK's own for a refused input. */
  details?: MercariaErrorDetails | null;
  cause?: unknown;
}

/** `options` with every property it leaves `undefined` taken from `defaults`. */
function withDefaults<T extends MercariaErrorOptions>(options: T, defaults: MercariaErrorOptions): T {
  const merged: MercariaErrorOptions = { ...defaults };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged as T;
}

/**
 * A brand every SDK error carries: the names of its class and each ancestor.
 *
 * `instanceof` compares class IDENTITY, and a process can hold two copies of
 * this package — the ESM and the CommonJS build side by side (a CommonJS
 * dependency of an ESM app), or two versions. An error thrown by one copy is
 * then not `instanceof` the other copy's class, and a consumer's
 * `if (err instanceof MercariaGoneError)` silently takes the wrong branch. Each
 * class therefore answers `instanceof` from this brand as well as from its
 * prototype chain. `Symbol.for` is what makes the key shared across copies.
 */
const LINEAGE: unique symbol = Symbol.for('@mercaria.co/sdk:error-lineage') as never;

type Branded = { [LINEAGE]?: readonly string[] };

function lineageOf(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const lineage = (value as Branded)[LINEAGE];
  return Array.isArray(lineage) ? lineage : undefined;
}

/** The base of every error the SDK throws. */
export class MercariaError extends Error {
  /** The stable class name used for cross-copy `instanceof`. Never minified. */
  static readonly errorName: string = 'MercariaError';

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return lineageOf(value)?.includes(this.errorName) ?? false;
  }

  /** A stable, machine-readable code. Branch on this or on the class, never on `message`. */
  readonly code: MercariaErrorCode;
  /** The HTTP status, or `null` when no response was received (or the error is client-side). */
  readonly status: number | null;
  /**
   * Whether repeating the SAME request later may succeed. The SDK itself never
   * retries; this tells a caller whether a retry with backoff is sensible.
   */
  readonly retryable: boolean;
  /**
   * Scalars the server attached to its error — `field` on a refused request,
   * `retryAfterSeconds` on a rate limit — or `null`. Never user content.
   */
  readonly details: Readonly<MercariaErrorDetails> | null;
  declare readonly cause?: unknown;

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message);
    const target = new.target as typeof MercariaError;
    Object.setPrototypeOf(this, target.prototype);

    const lineage: string[] = [];
    let current: typeof MercariaError | null = target;
    while (current !== null) {
      if (Object.prototype.hasOwnProperty.call(current, 'errorName')) lineage.push(current.errorName);
      if (current === MercariaError) break;
      current = Object.getPrototypeOf(current) as typeof MercariaError | null;
    }
    Object.defineProperty(this, LINEAGE, { value: Object.freeze(lineage), enumerable: false });
    Object.defineProperty(this, 'name', {
      value: target.errorName,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    // Non-enumerable, so serialising an error never walks into whatever a
    // `fetch` implementation attached to its own failure.
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false, configurable: true });
    }

    this.code = options.code ?? 'http_error';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details ? Object.freeze({ ...options.details }) : null;
  }

  /** A safe, loggable shape: no cause, no stack, no request data. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      details: this.details,
      message: this.message,
    };
  }
}

/** The request did not complete: DNS, TLS, connection reset, offline. Retryable. */
export class MercariaNetworkError extends MercariaError {
  static override readonly errorName: string = 'MercariaNetworkError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'network_error', retryable: true }));
  }
}

/** The request exceeded the client's `timeoutMs`. A network error; retryable. */
export class MercariaTimeoutError extends MercariaNetworkError {
  static override readonly errorName: string = 'MercariaTimeoutError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'timeout' }));
  }
}

/** The caller aborted the request through its own `AbortSignal`. Not retryable. */
export class MercariaAbortError extends MercariaError {
  static override readonly errorName: string = 'MercariaAbortError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'aborted', retryable: false }));
  }
}

/** A non-2xx response the SDK has no more specific class for. */
export class MercariaApiError extends MercariaError {
  static override readonly errorName: string = 'MercariaApiError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'http_error' }));
  }
}

/**
 * 404 `unknown_route`: the server does not serve the route this SDK called —
 * the SDK and the API disagree about the route table, so one of them is older
 * than the other. NEVER a {@link MercariaNotFoundError}: that would tell a
 * consumer a valid persisted reference is dead.
 */
export class MercariaUnknownRouteError extends MercariaApiError {
  static override readonly errorName: string = 'MercariaUnknownRouteError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'unknown_route' }));
  }
}

/**
 * 400 `bad_request`: the request was not well-formed — a wrong type, a
 * missing or unknown parameter, a cursor from another list. Raised by the
 * server, or by the SDK before anything was sent (`status: null`).
 */
export class MercariaBadRequestError extends MercariaError {
  static override readonly errorName: string = 'MercariaBadRequestError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'bad_request' }));
  }
}

/**
 * 422 `validation_failed`: well-formed, but a value was refused — a `limit`
 * out of range, `relevance` without a query, an empty id. Raised by the
 * server, or by the SDK before anything was sent (`status: null`).
 * `details.field` names the parameter when the server or the contract knows it.
 */
export class MercariaValidationError extends MercariaError {
  static override readonly errorName: string = 'MercariaValidationError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'validation_failed' }));
  }
}

/** 401: the access token was missing where required, expired or invalid. */
export class MercariaUnauthorizedError extends MercariaError {
  static override readonly errorName: string = 'MercariaUnauthorizedError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'unauthorized' }));
  }
}

/** 403: the caller is authenticated but not allowed. */
export class MercariaForbiddenError extends MercariaError {
  static override readonly errorName: string = 'MercariaForbiddenError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'forbidden' }));
  }
}

/**
 * 404 `not_found`: Mercaria has no such entity — it never existed, or the id is
 * wrong. Only raised when the response is a genuine Mercaria error body (or,
 * for `products.resolveVariant`, when the product has no such variant): a bare
 * 404 from a proxy proves nothing about the entity and is a
 * {@link MercariaApiError} instead.
 */
export class MercariaNotFoundError extends MercariaError {
  static override readonly errorName: string = 'MercariaNotFoundError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'not_found' }));
  }
}

/**
 * 410 `gone`: the entity EXISTED and is no longer publicly available — archived,
 * withdrawn, or its store closed or suspended. Deliberately says nothing about
 * why. Render "no longer available", not "broken link". (A sold one-off product
 * is NOT gone: it reads successfully with `availability: 'sold'`.)
 */
export class MercariaGoneError extends MercariaError {
  static override readonly errorName: string = 'MercariaGoneError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'gone' }));
  }
}

/** 409 `conflict`: the request conflicts with current state. */
export class MercariaConflictError extends MercariaError {
  static override readonly errorName: string = 'MercariaConflictError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'conflict' }));
  }
}

/** Options {@link MercariaRateLimitError} additionally accepts. */
export interface MercariaRateLimitErrorOptions extends MercariaErrorOptions {
  retryAfterSeconds?: number | null;
}

/** 429 `rate_limited`: too many requests. Retryable, after `retryAfterSeconds` when the server said. */
export class MercariaRateLimitError extends MercariaError {
  static override readonly errorName: string = 'MercariaRateLimitError';

  /** Seconds to wait before retrying — `details.retryAfterSeconds`, else `Retry-After` / `RateLimit-Reset` — or `null`. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, options: MercariaRateLimitErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'rate_limited', retryable: true }));
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterSeconds: this.retryAfterSeconds };
  }
}

/**
 * Mercaria is temporarily unable to answer: `internal_error` (500),
 * `service_unavailable` (503), and the other server-side statuses except 501
 * and 505. Retryable. Render "temporarily unavailable" — this is never
 * evidence about the entity itself. `code` says which the server reported.
 */
export class MercariaUnavailableError extends MercariaError {
  static override readonly errorName: string = 'MercariaUnavailableError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'service_unavailable', retryable: true }));
  }
}

/**
 * The response was not the contract: invalid JSON, a missing or mistyped
 * field, an unknown enum value, or a success status carrying a failure body.
 * `status` is the HTTP status that came with it.
 */
export class MercariaResponseError extends MercariaError {
  static override readonly errorName: string = 'MercariaResponseError';

  constructor(message: string, options: MercariaErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'malformed_response', retryable: false }));
  }
}

/** Whether `value` is an error thrown by (any copy of) this SDK. */
export function isMercariaError(value: unknown): value is MercariaError {
  return value instanceof MercariaError;
}
