/**
 * Mercaria's ONE Moovo client (#156).
 *
 * Everything #156 asks a client to own that does not depend on a wire format
 * lives here: idempotency and correlation, the caller's deadline, one
 * normalization of every failure, the ambiguity rule, redacted logging and
 * safe per-operation metrics. What it does NOT own is the socket — that is
 * `MoovoTransport`, whose default is unregistered, because the request and
 * response shapes belong to `OxyHQ/Moovo#28` and do not exist yet.
 *
 * The split is what makes acceptance 1 structural rather than aspirational: a
 * feature that wanted to reach Moovo would have to register a second transport
 * or import one, and `__tests__/moovo-client-isolation.test.ts` fails the build
 * on either.
 *
 * ## What this client deliberately does NOT do
 *
 * **It does not mint, cache or refresh a token.** #156 item 3 asks that tokens
 * be cached "through the shared SDK by credential, audience and scope", and the
 * SDK cannot express an audience: `getServiceToken()` POSTs `{apiKey,
 * apiSecret}` and every token it returns carries the hardcoded `oxy-api`. A
 * token cache written here would be exactly the "custom token cache" acceptance
 * 4 forbids, built to work around an SDK gap that `OxyHQ/oxy#878` is open to
 * close. So `retry_after_refresh` is CLASSIFIED and reported and acted on by
 * nothing in this file — the refresh belongs to the SDK client that will sit
 * inside the transport, one refresh then one retry, per #156 error policy 3.
 *
 * **It does not retry a write whose outcome is unknown.** That is
 * `moovoRetryDisposition`'s job and this file's most important line: ambiguity
 * outranks the failure class, so a 500 on a booking reconciles rather than
 * retries.
 */

import { randomUUID } from 'node:crypto';
import type {
  MoovoLogisticsOperation,
  MoovoOperationResult,
  MoovoTransportProjection,
  MoovoTransportRequest,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import {
  moovoRetryDisposition,
  moovoUnavailableReasonFor,
  classifyMoovoFailure,
  safeMoovoFailureLog,
} from './outcome.js';
import {
  type MoovoCallContext,
  type MoovoTransport,
  type MoovoTransportFailure,
  type MoovoTransportHandle,
  type MoovoTransportOutcome,
} from './transport-contract.js';

/** What the client needs to know that is not the transport's business. */
export interface MoovoClientOptions {
  /** The caller's bound for one attempt, in milliseconds. */
  readonly timeoutMs: number;
  /** How many attempts a `retry_bounded` failure may make, INCLUDING the first. */
  readonly maxAttempts: number;
  /** The first backoff step. Later steps double, with equal jitter. */
  readonly retryBaseDelayMs: number;
  /** Ceiling on any single wait, so a published `Retry-After` cannot park a request. */
  readonly retryMaxDelayMs: number;
}

/** Injected so the retry schedule is deterministic under test, per the #125 transport's arrangement. */
export interface MoovoClientDeps {
  readonly sleep: (ms: number) => Promise<void>;
  /** Returns [0, 1). Equal jitter halves the step and randomises the other half. */
  readonly random: () => number;
  readonly newCorrelationId: () => string;
}

const DEFAULT_DEPS: MoovoClientDeps = {
  sleep: (ms) =>
    new Promise((resolve) => {
      // `unref` so a pending backoff can never hold the process open — the
      // house rule for any timer a module owns.
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  random: Math.random,
  newCorrelationId: () => randomUUID(),
};

/**
 * Per-operation, per-outcome counters (#156 item 10).
 *
 * Process-local and deliberately unlabelled by anything a person could be
 * identified from: an operation name and an outcome, and nothing else. No
 * source reference, no transport id, no order. Scraping and alerting belong to
 * `oxy-infra`, which is where every other metric in this repository is read.
 */
export type MoovoMetricOutcome = 'ok' | 'unavailable' | 'refused_no_transport';
const metrics = new Map<string, number>();

function countMetric(operation: MoovoLogisticsOperation, outcome: MoovoMetricOutcome): void {
  const key = `${operation}:${outcome}`;
  metrics.set(key, (metrics.get(key) ?? 0) + 1);
}

/** Read the counters. A snapshot, so a caller cannot mutate them. */
export function moovoClientMetrics(): Readonly<Record<string, number>> {
  return Object.fromEntries(metrics);
}

/** Reset the counters. For tests; production has no reason to. */
export function resetMoovoClientMetrics(): void {
  metrics.clear();
}

/**
 * The idempotency key for one operation on one subject.
 *
 * DERIVED and never minted, which is the property it exists for: a booking
 * retried after a lost response must present the same key or Moovo would treat
 * it as a new movement. `sourceReference` is #126's GENERATED column, so two
 * racers compose byte-identical keys — a value derived at call time would
 * differ between them and defeat the whole mechanism.
 */
export function moovoIdempotencyKey(
  operation: MoovoLogisticsOperation,
  subject: string,
): string {
  return `mercaria:${operation}:${subject}`;
}

/** Equal jitter: half the step, plus a random half. Bounded by the configured ceiling. */
function backoffMs(
  attempt: number,
  failure: MoovoTransportFailure,
  options: MoovoClientOptions,
  random: () => number,
): number {
  const published = failure.retryAfterMs;
  if (published !== undefined && published > 0) {
    return Math.min(published, options.retryMaxDelayMs);
  }
  const step = Math.min(options.retryBaseDelayMs * 2 ** (attempt - 1), options.retryMaxDelayMs);
  return Math.floor(step / 2 + random() * (step / 2));
}

/**
 * Run one operation, with the whole policy around it.
 *
 * The retry loop turns ONLY on `retry_bounded`. Every other disposition
 * returns immediately, which is what makes "never retries an ambiguous
 * booking blindly" a property of the control flow rather than of a comment:
 * `reconcile_before_retry` is not a case this loop handles.
 */
async function runMoovoOperation<T>(
  transport: MoovoTransport,
  operation: MoovoLogisticsOperation,
  subject: string,
  options: MoovoClientOptions,
  deps: MoovoClientDeps,
  call: (context: MoovoCallContext) => Promise<MoovoTransportOutcome<T>>,
): Promise<MoovoOperationResult<T>> {
  const idempotencyKey = moovoIdempotencyKey(operation, subject);
  let lastFailure: MoovoTransportFailure | null = null;

  for (let attempt = 1; attempt <= Math.max(1, options.maxAttempts); attempt += 1) {
    const context: MoovoCallContext = {
      operation,
      idempotencyKey,
      correlationId: deps.newCorrelationId(),
      timeoutMs: options.timeoutMs,
    };

    // A transport that THROWS is treated as the most dangerous thing it could
    // be: a write that may have landed. Only the transport can say otherwise,
    // and one that threw did not say anything.
    let outcome: MoovoTransportOutcome<T>;
    try {
      outcome = await call(context);
    } catch {
      outcome = { kind: 'failed', failure: { afterWrite: 'unknown' } };
    }

    if (outcome.kind === 'ok') {
      countMetric(operation, 'ok');
      return { outcome: 'ok', value: outcome.value };
    }

    lastFailure = outcome.failure;
    const failureClass = classifyMoovoFailure(outcome.failure);
    const disposition = moovoRetryDisposition(operation, failureClass, outcome.failure);
    log.general.warn(
      { ...safeMoovoFailureLog(operation, context.correlationId, outcome.failure), attempt },
      '[Moovo] operation failed',
    );

    if (disposition !== 'retry_bounded' || attempt >= options.maxAttempts) break;
    await deps.sleep(backoffMs(attempt, outcome.failure, options, deps.random));
  }

  countMetric(operation, 'unavailable');
  // `lastFailure` is non-null on every path that reaches here: the loop runs at
  // least once and only exits through a failure or a return.
  const failure: MoovoTransportFailure = lastFailure ?? { afterWrite: 'unknown' };
  return {
    outcome: 'unavailable',
    reason: moovoUnavailableReasonFor(operation, classifyMoovoFailure(failure), failure),
    owedBy: 'OxyHQ/Moovo',
  };
}

/**
 * Build the typed client over a transport.
 *
 * Returns the five operations #126's `MoovoLogisticsPort` declares, so
 * `register.ts` can hand the result straight to `registerMoovoLogisticsPort`
 * with no adapter in between — one contract, satisfied by construction rather
 * than by a mapping somebody maintains.
 */
export function createMoovoLogisticsClient(
  transport: MoovoTransport,
  options: MoovoClientOptions,
  deps: MoovoClientDeps = DEFAULT_DEPS,
) {
  return {
    registerTrackingOnlyTransport(
      request: MoovoTransportRequest,
    ): Promise<MoovoOperationResult<MoovoTransportHandle>> {
      return runMoovoOperation(
        transport,
        'register_tracking_only_transport',
        request.sourceReference,
        options,
        deps,
        (context) => transport.registerTrackingOnlyTransport(request, context),
      );
    },

    bookTransport(
      request: MoovoTransportRequest,
    ): Promise<MoovoOperationResult<MoovoTransportHandle>> {
      return runMoovoOperation(
        transport,
        'book_transport',
        request.sourceReference,
        options,
        deps,
        (context) => transport.bookTransport(request, context),
      );
    },

    readTransportProjection(
      transportRequestId: string,
    ): Promise<MoovoOperationResult<MoovoTransportProjection>> {
      return runMoovoOperation(
        transport,
        'read_transport_projection',
        transportRequestId,
        options,
        deps,
        (context) => transport.readTransportProjection(transportRequestId, context),
      );
    },

    cancelTransport(transportRequestId: string): Promise<MoovoOperationResult<void>> {
      return runMoovoOperation(
        transport,
        'cancel_transport',
        transportRequestId,
        options,
        deps,
        (context) => transport.cancelTransport(transportRequestId, context),
      );
    },

    requestReturnTransport(
      request: MoovoTransportRequest,
    ): Promise<MoovoOperationResult<MoovoTransportHandle>> {
      return runMoovoOperation(
        transport,
        'request_return_transport',
        request.sourceReference,
        options,
        deps,
        (context) => transport.requestReturnTransport(request, context),
      );
    },
  };
}
