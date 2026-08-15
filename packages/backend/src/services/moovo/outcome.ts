/**
 * Turning a Moovo failure into a classification, a next action and a log line
 * that discloses nothing (#156 items 6, 7, 8 and 9).
 *
 * Every function here is PURE and is the ONLY place its decision is made.
 * #156 item 6 asks that safe Moovo errors be normalized "once" — the failure
 * mode it is aimed at is two call sites classifying the same 409 differently,
 * one of them retrying a booking that already exists.
 */

import type { MoovoLogisticsOperation, MoovoUnavailableReason } from '@mercaria/shared-types';
import {
  MOOVO_OPERATION_IS_WRITE,
  moovoFailureIsAmbiguous,
  type MoovoFailureClass,
  type MoovoTransportFailure,
} from './transport-contract.js';

/**
 * What a caller — or the client's own retry loop — may do next.
 *
 * A CLOSED set, and the members are the distinctions that change behaviour
 * rather than the reasons that produced them. Two failures that license the
 * same action share a disposition; two that license opposite actions never do.
 */
export const MOOVO_RETRY_DISPOSITIONS = [
  /** Never retried automatically. The request itself is what Moovo objected to. */
  'no_retry',
  /** One token refresh, then a single retry. #156 error policy 3. */
  'retry_after_refresh',
  /** Bounded retry with jitter. #156 error policy 4. */
  'retry_bounded',
  /**
   * A WRITE whose outcome is unknown. #156 error policy 6 and item 8: READ or
   * reconcile before another write, never another blind attempt.
   */
  'reconcile_before_retry',
  /** A grant or scope problem. #156 error policy 8: alert, do not retry storm. */
  'reconfigure',
] as const;
export type MoovoRetryDisposition = (typeof MOOVO_RETRY_DISPOSITIONS)[number];

/**
 * Classify a raw transport failure.
 *
 * The status is read FIRST and the provider code second, which is #65's
 * ordering and is here for its two reasons: a quota refusal wearing a 403 is a
 * rate limit (reading it as auth pages somebody about a working credential),
 * and a provider that publishes a specific code for an expired quote is more
 * precise than any status could be. An unrecognised shape lands on `unexpected`
 * rather than on a guess.
 */
export function classifyMoovoFailure(failure: MoovoTransportFailure): MoovoFailureClass {
  const code = failure.providerCode?.toLowerCase() ?? '';
  if (code.includes('quote') && (code.includes('expired') || code.includes('stale'))) {
    return 'quote_expired';
  }
  if (code.includes('not_serviceable') || code.includes('no_service')) {
    return 'no_service';
  }

  const status = failure.status;
  if (status === undefined) {
    // No response at all. A deadline the caller set is a timeout; anything else
    // is the provider being unreachable. Both are ambiguity candidates, which
    // `moovoRetryDisposition` decides separately — the class says WHAT
    // happened, never what to do about it.
    return failure.afterWrite === 'unknown' ? 'timeout' : 'provider_unavailable';
  }
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'authentication';
  if (status === 403) {
    // A 403 is the one status that legitimately means two things. Moovo's own
    // code decides; with none published this is a grant problem, which refuses
    // loudly rather than retrying — the safe direction, since a retry storm
    // against a revoked grant is what #156 error policy 8 exists to prevent.
    return code.includes('rate') || code.includes('quota') ? 'rate_limited' : 'authorization';
  }
  if (status === 408 || status === 504) return 'timeout';
  if (status === 409 || status === 422 || (status >= 400 && status < 500)) return 'validation';
  if (status >= 500) return 'provider_unavailable';
  return 'unexpected';
}

/**
 * What may be done next, given the class, the operation and the ambiguity.
 *
 * **Ambiguity outranks everything.** A write whose outcome is unknown is
 * `reconcile_before_retry` whatever its class, because the class describes the
 * error and the ambiguity describes what may already exist at Moovo. Checking
 * the class first is the natural spelling and is wrong: a 500 on a booking is
 * `provider_unavailable`, which reads as "retry", and retrying a booking that
 * succeeded is the duplicate-parcel failure this whole module is shaped around.
 * #124 reached the same rule for supplier orders.
 */
export function moovoRetryDisposition(
  operation: MoovoLogisticsOperation,
  failureClass: MoovoFailureClass,
  failure: MoovoTransportFailure,
): MoovoRetryDisposition {
  if (MOOVO_OPERATION_IS_WRITE[operation] && moovoFailureIsAmbiguous(failure)) {
    return 'reconcile_before_retry';
  }
  switch (failureClass) {
    case 'authentication':
      return 'retry_after_refresh';
    case 'authorization':
      return 'reconfigure';
    case 'rate_limited':
    case 'provider_unavailable':
    case 'timeout':
      return 'retry_bounded';
    case 'validation':
    case 'no_service':
    case 'quote_expired':
    case 'unexpected':
      return 'no_retry';
  }
}

/**
 * The `MoovoOperationResult` reason a caller outside this domain sees.
 *
 * Deliberately COARSER than the class: #126's tuple is the vocabulary the
 * retail-fulfilment domain reads, and it distinguishes exactly what that domain
 * can act on. The one distinction it must not lose is ambiguity, which is why
 * `provider_outcome_ambiguous` was added to it rather than collapsed into
 * `provider_unreachable`.
 */
export function moovoUnavailableReasonFor(
  operation: MoovoLogisticsOperation,
  failureClass: MoovoFailureClass,
  failure: MoovoTransportFailure,
): MoovoUnavailableReason {
  if (MOOVO_OPERATION_IS_WRITE[operation] && moovoFailureIsAmbiguous(failure)) {
    return 'provider_outcome_ambiguous';
  }
  switch (failureClass) {
    case 'provider_unavailable':
    case 'timeout':
      return 'provider_unreachable';
    case 'validation':
    case 'no_service':
    case 'quote_expired':
    case 'authentication':
    case 'authorization':
    case 'rate_limited':
    case 'unexpected':
      return 'provider_refused';
  }
}

/**
 * The shape a provider ERROR CODE must have to be logged at all.
 *
 * A machine token: letters, digits, underscore, hyphen and dot, bounded in
 * length. Anything else — most importantly anything containing WHITESPACE — is
 * dropped entirely rather than scrubbed, because a value with a space in it is
 * a sentence, and a sentence from a logistics provider is where a recipient's
 * name and a delivery address turn up.
 *
 * This is deliberately NOT a character-scrubber over free text. One was written
 * here first and it did not work: `"Rejected for Buyer Name at Calle Mayor 4"`
 * survived stripping punctuation and long digit runs, because a street and a
 * person are ordinary letters. `services/payments/redact.ts` reaches the same
 * conclusion from the other direction — an allow-list of FIELDS rather than a
 * filter over values.
 */
const PROVIDER_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Keep a provider error code only if it is a code.
 *
 * Case is lower-folded so two spellings of one code count as one, and a value
 * that fails the shape test returns `undefined` rather than a truncated
 * version of itself: half a sentence is still a sentence.
 */
export function redactMoovoProviderCode(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const trimmed = code.trim();
  if (!PROVIDER_CODE_SHAPE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

/**
 * What a Moovo failure may contribute to a log line.
 *
 * Every member is either Mercaria's own (the operation, the correlation id, the
 * two derived verdicts) or a bounded machine value. There is no field that
 * could hold prose, an address, a token or a label, which is the #77 posture:
 * the ABSENT fields are the enforcement.
 */
export interface SafeMoovoFailureLog {
  readonly operation: MoovoLogisticsOperation;
  readonly correlationId: string;
  readonly failureClass: MoovoFailureClass;
  readonly disposition: MoovoRetryDisposition;
  readonly afterWrite: string;
  readonly status?: number;
  readonly providerCode?: string;
}

/**
 * Compose the ONLY shape this domain logs about a failure.
 *
 * The idempotency key is deliberately absent: it is derived from the fulfilment
 * intent's source reference, so logging it would put a stable per-order
 * correlation handle into the log stream for every retry. The per-ATTEMPT
 * `correlationId` is what joins Mercaria's logs to Moovo's and identifies
 * nothing on its own.
 */
export function safeMoovoFailureLog(
  operation: MoovoLogisticsOperation,
  correlationId: string,
  failure: MoovoTransportFailure,
): SafeMoovoFailureLog {
  const failureClass = classifyMoovoFailure(failure);
  const providerCode = redactMoovoProviderCode(failure.providerCode);
  return {
    operation,
    correlationId,
    failureClass,
    disposition: moovoRetryDisposition(operation, failureClass, failure),
    afterWrite: failure.afterWrite,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(providerCode === undefined ? {} : { providerCode }),
  };
}
