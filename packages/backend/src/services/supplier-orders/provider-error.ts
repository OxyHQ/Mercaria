/**
 * The normalized provider failure, its retry guidance, and the one field that
 * decides ambiguity (#124 provider-neutral type 12, idempotency 4).
 *
 * ## `afterWrite` is the whole of it
 *
 * A connection refused sent nothing, so retrying costs nothing. A request whose
 * bytes went out and whose response never came back MAY have created a supplier
 * order, and retrying it creates a second one — real money, invisible until a
 * statement is reconciled weeks later. Only the code holding the socket knows
 * which side of the write a failure fell on, so the ADAPTER states it and this
 * module carries it.
 *
 * The default is the safe one: an error that is not a {@link SupplierProviderError}
 * at all — a `TypeError` from a bad response shape, an abort, anything the
 * adapter did not classify — is read as `afterWrite: 'unknown'`, which the
 * orchestration treats exactly as it treats `yes`. Reading an unclassified
 * failure as "definitely nothing was written" is the assumption that costs
 * money, so it is the one this module cannot make.
 *
 * ## Retryability is a TABLE
 *
 * `SUPPLIER_PROVIDER_ERROR_RETRYABLE` in shared-types, not a switch here, so
 * the answer is the same wherever it is asked. `auth` is deliberately NOT
 * retryable — a rejected credential retried on a backoff burns the account's
 * rate budget and on some providers locks it, and rotating it is an operator
 * act with an exception row attached. `unknown` IS retryable, for the opposite
 * reason: an unclassified failure is far more often a transport fault than a
 * refusal, and a purchase order a customer has paid for must not be abandoned
 * because an adapter did not recognise a status code.
 */

import type {
  SupplierProviderErrorClass,
  SupplierProviderFailure,
} from '@mercaria/shared-types';
import { SUPPLIER_PROVIDER_ERROR_RETRYABLE } from '@mercaria/shared-types';

/**
 * What an adapter throws when a provider call fails.
 *
 * A class rather than a returned union, because a failure has to interrupt the
 * call: an adapter that returned a failure alongside an optional answer would
 * let a caller read the answer without checking, and the answer in that case is
 * whatever the adapter had before the failure.
 */
export class SupplierProviderError extends Error {
  readonly errorClass: SupplierProviderErrorClass;
  /** Whether the request may already have been applied at the provider. */
  readonly afterWrite: boolean;
  readonly providerCode: string | null;
  readonly retryAfterMs: number | null;

  constructor(input: {
    message: string;
    errorClass: SupplierProviderErrorClass;
    afterWrite: boolean;
    providerCode?: string | null;
    retryAfterMs?: number | null;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'SupplierProviderError';
    this.errorClass = input.errorClass;
    this.afterWrite = input.afterWrite;
    this.providerCode = input.providerCode ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

/** Whether an unknown thrown value is one of ours. */
export function isSupplierProviderError(error: unknown): error is SupplierProviderError {
  return error instanceof SupplierProviderError;
}

/**
 * Normalize anything thrown by an adapter into the stored failure shape.
 *
 * An error that is not a {@link SupplierProviderError} is `unknown` /
 * `afterWrite: 'unknown'` — see the module docblock for why that is not the
 * same as `no`.
 */
export function normalizeProviderFailure(error: unknown): SupplierProviderFailure & {
  afterWriteFlag: 'yes' | 'no' | 'unknown';
} {
  if (isSupplierProviderError(error)) {
    return {
      errorClass: error.errorClass,
      afterWrite: error.afterWrite,
      afterWriteFlag: error.afterWrite ? 'yes' : 'no',
      providerCode: error.providerCode,
      retryAfterMs: error.retryAfterMs,
      message: error.message,
    };
  }
  return {
    errorClass: 'unknown',
    afterWrite: true,
    afterWriteFlag: 'unknown',
    providerCode: null,
    retryAfterMs: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Whether this failure may be retried at all. */
export function isRetryableSupplierFailure(failure: {
  errorClass: SupplierProviderErrorClass;
}): boolean {
  return SUPPLIER_PROVIDER_ERROR_RETRYABLE[failure.errorClass];
}

/**
 * Whether this failure leaves the outcome AMBIGUOUS.
 *
 * `afterWrite` OR an unclassified error. Note what is deliberately NOT part of
 * the answer: the error CLASS. A `validation` failure that happened after the
 * write is still ambiguous — some providers validate asynchronously and answer
 * 400 on an order they have already created — so classifying it as terminal and
 * retrying under a corrected request would place the second order.
 */
export function isAmbiguousSupplierFailure(failure: {
  afterWriteFlag: 'yes' | 'no' | 'unknown';
}): boolean {
  return failure.afterWriteFlag !== 'no';
}
