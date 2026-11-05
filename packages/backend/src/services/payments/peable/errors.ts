/**
 * How a failed Peable call is classified — the ONE answer to "may this same
 * request, unchanged, ever succeed?" for every Peable call Mercaria makes.
 *
 * Its own module rather than part of `client.ts`, which is the one module that
 * REACHES the gateway and the one suites replace with the fake gateway; this
 * reaches nothing, so it stays real under that fake.
 */

import { PeableError } from '@peable.to/sdk';
import { PaymentProviderError, type PaymentProviderStage } from '../provider.js';

/**
 * A failed gateway call, in the payment domain's vocabulary.
 *
 * The ONE classification of a Peable failure, shared by the payment adapter and
 * every event handler that re-reads the gateway, so "may this same request ever
 * succeed" has one answer. A truncated error body keeps its known refusal
 * status; a lost 2xx body or a transport failure without headers stays
 * indeterminate and therefore retryable.
 */
export function toPeableProviderError(
  stage: PaymentProviderStage,
  error: unknown,
): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error;
  const status = error instanceof PeableError ? error.statusCode : undefined;
  return new PaymentProviderError({
    provider: 'peable',
    stage,
    message: 'The Peable operation failed; retry only with the original intent.',
    retryable:
      status === undefined || status < 400 || status >= 500 || status === 408 || status === 429,
  });
}

/** Run one gateway call, classifying its failure (see {@link toPeableProviderError}). */
export async function callPeable<T>(
  stage: PaymentProviderStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toPeableProviderError(stage, error);
  }
}
