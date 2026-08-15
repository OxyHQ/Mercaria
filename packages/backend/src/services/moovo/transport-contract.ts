/**
 * The Moovo TRANSPORT PORT (#156) — what a Moovo call needs from whoever holds
 * the socket, and the one fact about a failure only that layer can know.
 *
 * ## Why this contract stops at Mercaria's own types
 *
 * #156 asks for "typed operations generated/shared from the Moovo service
 * contract". There is no such contract to share: `@moovo/shared-types` is
 * `private: true` and 404s on npm, Moovo publishes no OpenAPI document, and the
 * versioned logistics service API is `OxyHQ/Moovo#28`, still OPEN. So the
 * request and response shapes on the WIRE are unknown, and inventing them here
 * would produce a client that type-checks against a guess and fails against the
 * real thing — the expensive kind of wrong, because it looks finished.
 *
 * What Mercaria DOES own is the five operations it needs and the payload it is
 * willing to disclose (#126's `MoovoTransportRequest`, an allow-list expressed
 * as a type). This port is stated in exactly those terms. The implementer —
 * #159, once `OxyHQ/oxy#878` supplies an audience-aware service client — owns
 * the mapping onto whatever Moovo publishes, which is the half that belongs to
 * Moovo rather than to this repository.
 *
 * ## `afterWrite` is the whole reason this is a port
 *
 * `services/printful/transport-contract.ts` makes the same argument for the
 * same reason, and #124 turned it into a rule: only the code holding the socket
 * knows which side of a write a failure fell on. A connection that was never
 * established wrote nothing; a request fully sent and then timed out may have
 * created a transport Mercaria will never hear about. Anything that cannot be
 * told apart answers `unknown`, which {@link moovoFailureIsAmbiguous} treats
 * exactly as `yes` — reading an unknown as "nothing was written" is how one
 * paid order becomes two parcels.
 *
 * A classification made later from an error message cannot recover this fact,
 * which is why it is a required field of the failure rather than something the
 * client infers.
 */

import type {
  MoovoLogisticsOperation,
  MoovoTransportProjection,
  MoovoTransportRequest,
} from '@mercaria/shared-types';

/**
 * What Moovo answers when a transport is created or registered.
 *
 * Duplicated from `services/retail-fulfilment/moovo.port.ts` deliberately? No —
 * it is IMPORTED there. This module is the owner because the transport produces
 * the value and the port merely passes it on, and #126's domain may not import
 * this directory (it would put outbound HTTP one import away from a wall whose
 * whole purpose is that there is none).
 */
export interface MoovoTransportHandle {
  readonly transportRequestId: string;
  /** ISO-8601, from Moovo. When the transport came into existence. */
  readonly registeredAt: string;
}

/**
 * Which of the five operations WRITE.
 *
 * A `Record` over the closed operation tuple, so an operation added without a
 * decision fails `tsc` here rather than defaulting to the safe-looking answer.
 * The distinction is not cosmetic: ambiguity only matters for a write, and the
 * retry disposition of a read and a write diverge completely — a read may be
 * repeated freely, and a write whose outcome is unknown may not be repeated at
 * all until somebody has looked.
 */
export const MOOVO_OPERATION_IS_WRITE: Record<MoovoLogisticsOperation, boolean> = {
  register_tracking_only_transport: true,
  book_transport: true,
  read_transport_projection: false,
  cancel_transport: true,
  request_return_transport: true,
};

/**
 * Every way a Moovo call can fail, as a CLOSED set.
 *
 * These are #156's eight error-policy rows collapsed onto the distinctions that
 * change what a caller may do next; two rows that license the same next action
 * are one member, and two that license opposite actions are never merged.
 * `classifyMoovoFailure` is the single place a raw failure becomes one of
 * these, which is #156 item 6's "normalizes safe Moovo errors ONCE".
 */
export const MOOVO_FAILURE_CLASSES = [
  /** Moovo understood the request and rejected it. Policy row 1: no blind retry. */
  'validation',
  /** Moovo cannot serve this movement at all. Policy row 1, and not a retry. */
  'no_service',
  /** The quote no longer stands. Policy row 2: re-quote, then re-accept. */
  'quote_expired',
  /** The credential was refused. Policy row 3: one refresh, then stop. */
  'authentication',
  /** The credential is valid and lacks the grant. Policy row 8: do NOT retry. */
  'authorization',
  /** Policy row 4: bounded retry with jitter. */
  'rate_limited',
  /** Moovo is unwell or unreachable. Policy rows 4 and 7. */
  'provider_unavailable',
  /** The caller's own deadline elapsed. Ambiguity decides what happens next. */
  'timeout',
  /** Anything unrecognised. Treated as the least optimistic thing it could be. */
  'unexpected',
] as const;
export type MoovoFailureClass = (typeof MOOVO_FAILURE_CLASSES)[number];

/**
 * Whether the request had left Mercaria when the call failed.
 *
 * STRING members rather than a boolean, and not only for the third state: this
 * backend compiles with `strict: false`, so TypeScript does not narrow a union
 * on the truthiness of a boolean-literal discriminant, and a caller writing
 * `if (!failure.afterWrite)` would hold the whole union (the #68 finding, hit
 * again in #110). A string discriminant narrows.
 */
export const MOOVO_AFTER_WRITE_STATES = ['no', 'yes', 'unknown'] as const;
export type MoovoAfterWrite = (typeof MOOVO_AFTER_WRITE_STATES)[number];

/**
 * What the transport reports when a call did not succeed.
 *
 * **There is no free-text field, and the absence is the privacy mechanism**
 * (#156 item 9). A `detail` string carrying Moovo's own prose was written here
 * first and removed: a character-level redactor cannot defend it, because a
 * street name, a recipient and a company are ordinary letters and survive every
 * allow-list that still leaves the message readable. The first version of this
 * module proved it — `"Rejected for Buyer Name at Calle Mayor 4"` passed
 * through a redactor that stripped punctuation and long digit runs, and only a
 * case-INSENSITIVE assertion caught it (the case-sensitive one beside it passed
 * vacuously, because the redactor had lower-cased its own output).
 *
 * So Mercaria keeps the two facts a provider error is actually diagnosed from —
 * the status and a machine-readable code — and the `correlationId`, which is
 * what an operator takes to Moovo to read their side. #124 reached the same
 * place: "privacy is absence first", then an allow-list, then a scrub.
 */
export interface MoovoTransportFailure {
  /** HTTP status, when there was a response at all. */
  readonly status?: number;
  /**
   * Moovo's own machine-readable error code, when it publishes one.
   *
   * A TOKEN, not a sentence — `redactMoovoProviderCode` drops anything
   * containing whitespace, because a provider that starts sending prose in this
   * field must not thereby start sending it to a log.
   */
  readonly providerCode?: string;
  /** Only the socket-holder knows this. See the module docblock. */
  readonly afterWrite: MoovoAfterWrite;
  /** `Retry-After`, in milliseconds, when the provider published one. */
  readonly retryAfterMs?: number;
}

/** One transport call's result, before the client classifies it. */
export type MoovoTransportOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed'; readonly failure: MoovoTransportFailure };

/**
 * The context every call carries, composed by the client and never by a caller.
 *
 * `idempotencyKey` is derived from the fulfilment intent's own
 * `sourceReference` (#126's GENERATED column), so two racing bookings compose
 * the same key and Moovo deduplicates them. `correlationId` is per ATTEMPT and
 * exists to join Mercaria's logs to Moovo's; it must never be the idempotency
 * key, or a retry would look like a new request to one system and a repeat to
 * the other.
 */
export interface MoovoCallContext {
  readonly operation: MoovoLogisticsOperation;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** The caller's bound, in milliseconds. A transport MUST honour it. */
  readonly timeoutMs: number;
}

/**
 * Whoever can actually reach Moovo.
 *
 * Every method takes the context the client composed, so a transport neither
 * mints an idempotency key nor chooses a deadline — both are policy, and policy
 * that lived in the transport would be re-decided by every future transport.
 *
 * There is no `quote` method, and that absence is a finding rather than an
 * omission: Moovo has no standalone quote endpoint. Pricing a movement there
 * requires first creating a `shipments` row owned by the CALLING Oxy USER, so
 * the operation Mercaria would need does not exist and the one that does cannot
 * be reached by an application principal. `docs/moovo/` records the survey.
 */
export interface MoovoTransport {
  registerTrackingOnlyTransport(
    request: MoovoTransportRequest,
    context: MoovoCallContext,
  ): Promise<MoovoTransportOutcome<MoovoTransportHandle>>;

  bookTransport(
    request: MoovoTransportRequest,
    context: MoovoCallContext,
  ): Promise<MoovoTransportOutcome<MoovoTransportHandle>>;

  readTransportProjection(
    transportRequestId: string,
    context: MoovoCallContext,
  ): Promise<MoovoTransportOutcome<MoovoTransportProjection>>;

  cancelTransport(
    transportRequestId: string,
    context: MoovoCallContext,
  ): Promise<MoovoTransportOutcome<void>>;

  requestReturnTransport(
    request: MoovoTransportRequest,
    context: MoovoCallContext,
  ): Promise<MoovoTransportOutcome<MoovoTransportHandle>>;
}

/**
 * Whether a failure leaves Mercaria unable to say if Moovo wrote anything.
 *
 * `unknown` is folded in with `yes` HERE, once, rather than at each call site —
 * the collapse is the safety rule and a call site that got it wrong would be
 * indistinguishable from one that got it right until a supplier shipped twice.
 */
export function moovoFailureIsAmbiguous(failure: MoovoTransportFailure): boolean {
  return failure.afterWrite === 'yes' || failure.afterWrite === 'unknown';
}
