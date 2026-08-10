/**
 * The Printful TRANSPORT PORT (#125) — one HTTP call, and the one fact about a
 * failure that only the code holding the socket can know.
 *
 * ## Why this is a port and not a `fetch` call inside the adapter
 *
 * Both Printful adapters live in directories that are WALLS:
 * `services/supplier-orders/adapters/` may import no config, service,
 * repository or database handle (`supplier-order-isolation.test.ts`), and
 * `services/ingestion/adapters/` the same (`ingestion-isolation.test.ts`). A
 * real HTTP client needs a base URL, which comes from configuration — so the
 * adapters declare what they need and are HANDED an implementation, exactly as
 * #124 hands an adapter its credential rather than letting it read one.
 *
 * The second reason is the one that makes the conformance suites worth running.
 * #124's suite asks "did a second supplier order get placed", and only the
 * TRANSPORT can answer that; a mocked adapter would be measuring the mock. A
 * fake transport is a real adapter over a fake wire, so every gate, every
 * attempt row and every convergence lookup is the production one.
 *
 * ## `afterWrite` is the whole point of {@link PrintfulTransportError}
 *
 * #124's ambiguity model turns on whether a failed call may have reached the
 * provider, and it is deliberately the ADAPTER's answer rather than a
 * classification made later from an error message. The transport is the only
 * layer that knows: a connection that was never established wrote nothing; a
 * request that was fully sent and then timed out waiting for a response may
 * have created an order Mercaria will never hear about.
 *
 * Anything it cannot tell apart answers `true`, because reading an unknown as
 * "definitely nothing was written" is the assumption that costs real money.
 */

/**
 * Printful's documented API root.
 *
 * It lives in this file — which imports nothing at all — because both the
 * transport and the configuration read it, and two literals of one fact can
 * disagree. Configuration may override it, and the override is not a widening:
 * {@link PRINTFUL_ALLOWED_HOSTS} in `transport.ts` is checked independently, so
 * a base URL pointed anywhere else is refused before DNS.
 */
export const PRINTFUL_BASE_URL = 'https://api.printful.com';

/** One request to Printful, in provider terms and nothing more. */
export interface PrintfulRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Version-qualified and absolute against the API root — `/v2/orders`, `/orders/123`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  /**
   * The bearer token, or `null` for "resolve it yourself".
   *
   * The nullability records a real asymmetry between the two contracts this one
   * transport serves, rather than papering over it. #124's
   * `SupplierOrderCallContext` carries a `credential` the chokepoint resolved
   * per call, so an order-side adapter never holds a secret and cannot cache one
   * across a rotation — and it is passed straight through. #122's
   * `SupplierAdapterQuoteInput` carries NO credential at all, so on the
   * preflight path there is nothing to pass and the transport resolves one for
   * the supplier account itself.
   *
   * The consequence is where the live gate has to live. On the order path the
   * ADAPTER can refuse an unprovisioned `live` account, because it can see the
   * value; on the quote path only the transport can, so the transport refuses
   * too. Both fail closed, and neither can fail open — nothing on either side
   * can manufacture a token.
   */
  readonly credential: string | null;
  /**
   * `X-PF-Store-Id`, for an account-level token that serves several stores.
   *
   * Printful documents the header for account-level tokens; a store-level token
   * carries the store implicitly. `null` sends no header, which is the correct
   * behaviour for the store-scoped private token the pilot uses.
   */
  readonly storeId: string | null;
  readonly timeoutMs: number;
}

/** One answer from Printful, with the body left unparsed when it is not JSON. */
export interface PrintfulResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The parsed JSON body, or `null` when the response carried none.
   *
   * `parsed` is what tells "the body was `null`" from "the body was not JSON",
   * and the two lead opposite ways: an empty 204 is a success, an unparseable
   * 200 is an AMBIGUITY, because a response nobody can read says nothing about
   * whether the request took effect.
   */
  readonly body: unknown;
  readonly parsed: boolean;
}

/**
 * A call that produced no answer at all.
 *
 * Distinct from a non-2xx response, which IS an answer and is classified from
 * its status. This is the socket-level failure, and `afterWrite` is the field
 * every downstream decision hangs on.
 */
export class PrintfulTransportError extends Error {
  /**
   * Whether the request may have reached Printful.
   *
   * `false` only when the transport can prove nothing was written — a DNS
   * failure, a refused connection, a request aborted before it was sent.
   * Everything else, including a read timeout and an aborted response, is
   * `true`: the order may exist.
   */
  readonly afterWrite: boolean;
  /** Whether waiting longer could plausibly help, from the transport's view. */
  readonly retryable: boolean;

  constructor(message: string, options: { afterWrite: boolean; retryable: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PrintfulTransportError';
    this.afterWrite = options.afterWrite;
    this.retryable = options.retryable;
  }
}

/**
 * What a Printful adapter is handed instead of a network.
 *
 * One method, because one method is all either adapter needs and a wider port
 * would be a place for provider logic to leak out of the adapter that owns it.
 */
export interface PrintfulTransport {
  /** The API root this transport speaks to, for the log line and nothing else. */
  readonly baseUrl: string;
  call(request: PrintfulRequest): Promise<PrintfulResponse>;
}
