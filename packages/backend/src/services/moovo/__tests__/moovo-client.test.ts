/**
 * The Moovo client's policy, driven through a FAKE TRANSPORT (#156 tests).
 *
 * The transport is the only thing faked, which is #125's argument for its
 * conformance suites: a fake WIRE measures the real client, the real
 * classification and the real retry loop, where a mocked client would measure
 * the mock. Everything under test here — idempotency derivation, the ambiguity
 * rule, the retry schedule, redaction, metrics — is the code that would run in
 * production the moment a transport is registered.
 *
 * The cases map onto #156's own test list: 7 (idempotency preserved), 8
 * (booking timeout reconciliation), 9 (safe error details), 10 (no secret or
 * token in logs), 11 (readiness gating). Cases 1-6 and 12 need either an
 * audience-aware SDK or a Moovo service surface and are covered by
 * `moovo-client-isolation.test.ts` and the survey document instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoovoTransportProjection, MoovoTransportRequest } from '@mercaria/shared-types';
import {
  createMoovoLogisticsClient,
  moovoClientMetrics,
  moovoIdempotencyKey,
  resetMoovoClientMetrics,
  type MoovoClientDeps,
  type MoovoClientOptions,
} from '../client.js';
import {
  classifyMoovoFailure,
  moovoRetryDisposition,
  moovoUnavailableReasonFor,
  redactMoovoProviderCode,
  safeMoovoFailureLog,
} from '../outcome.js';
import type {
  MoovoCallContext,
  MoovoTransport,
  MoovoTransportFailure,
  MoovoTransportHandle,
  MoovoTransportOutcome,
} from '../transport-contract.js';

const OPTIONS: MoovoClientOptions = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 1_000,
};

/** Deterministic: no real waiting, no real randomness, countable correlation ids. */
function deterministicDeps(): MoovoClientDeps & { readonly waits: number[] } {
  const waits: number[] = [];
  let correlation = 0;
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    random: () => 0.5,
    newCorrelationId: () => `corr-${(correlation += 1)}`,
  };
}

const REQUEST: MoovoTransportRequest = {
  sourceReference: 'rfi_01HQ',
  mode: 'moovo_controlled',
  origin: {
    contactName: 'Warehouse',
    contactPhone: null,
    line1: 'Calle Mayor 4',
    line2: null,
    city: 'Madrid',
    region: null,
    postalCode: '28013',
    country: 'ES',
  },
  destination: {
    contactName: 'Buyer',
    contactPhone: null,
    line1: 'Rua Augusta 10',
    line2: null,
    city: 'Lisboa',
    region: null,
    postalCode: '1100-053',
    country: 'PT',
  },
  lines: [{ orderItemId: 'oi_1', quantity: 1, description: 'Mug' }],
};

/**
 * `registeredAt` is pinned safely in the PAST, and the first version of this
 * file was not — `fixture-date-census.test.ts` caught it about an hour before
 * the clock would have. It is inert data (a value the fake transport echoes
 * back and nothing compares against `now`), which is exactly why it would have
 * been tempting to allow-list instead; re-pinning costs nothing and leaves no
 * exemption for a later reader to reason about.
 */
const HANDLE: MoovoTransportHandle = {
  transportRequestId: 'tr_1',
  registeredAt: '2026-01-15T00:00:00.000Z',
};

/**
 * A transport that plays a scripted sequence and records what it was handed.
 *
 * Recording the CONTEXT is what makes the idempotency case real: asserting the
 * client "derives a key" without checking that the same key reached the wire on
 * every attempt would pass against a client that derived one and then sent a
 * fresh one each time.
 */
type ScriptEntry =
  | { readonly kind: 'failed'; readonly failure: MoovoTransportFailure }
  | { readonly kind: 'ok'; readonly value: MoovoTransportHandle };

const PROJECTION: MoovoTransportProjection = {
  transportRequestId: 'tr_1',
  state: 'in_transit',
  observedAt: '2026-01-15T00:00:00.000Z',
  sourceVersion: 1,
  shipmentCount: 1,
};

function scriptedTransport(script: readonly ScriptEntry[]) {
  const contexts: MoovoCallContext[] = [];
  let index = 0;
  // No `any` and no cast anywhere: each method maps a shared script entry onto
  // its OWN return type, which is what a union-typed script would have needed a
  // cast to fake.
  const next = (context: MoovoCallContext): ScriptEntry => {
    contexts.push(context);
    const outcome = script[Math.min(index, script.length - 1)];
    index += 1;
    return outcome;
  };
  const handle = (context: MoovoCallContext): Promise<MoovoTransportOutcome<MoovoTransportHandle>> =>
    Promise.resolve(next(context));
  const transport: MoovoTransport = {
    registerTrackingOnlyTransport: (_r, c) => handle(c),
    bookTransport: (_r, c) => handle(c),
    requestReturnTransport: (_r, c) => handle(c),
    readTransportProjection: (_i, c) => {
      const outcome = next(c);
      return Promise.resolve(
        outcome.kind === 'ok' ? { kind: 'ok', value: PROJECTION } : outcome,
      );
    },
    cancelTransport: (_i, c) => {
      const outcome = next(c);
      return Promise.resolve(outcome.kind === 'ok' ? { kind: 'ok', value: undefined } : outcome);
    },
  };
  return { transport, contexts, calls: () => index };
}

function failure(overrides: Partial<MoovoTransportFailure>): MoovoTransportFailure {
  return { afterWrite: 'no', ...overrides };
}

beforeEach(() => {
  resetMoovoClientMetrics();
});

describe('#156 item 8 — an ambiguous write is never retried blindly', () => {
  it('does not call the transport again when a booking times out after the write', async () => {
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ afterWrite: 'unknown' }) },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deterministicDeps());

    const result = await client.bookTransport(REQUEST);

    expect(scripted.calls()).toBe(1);
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'provider_outcome_ambiguous',
      owedBy: 'OxyHQ/Moovo',
    });
  });

  it('a transport that THROWS is ambiguous, never "nothing was written"', async () => {
    const transport: MoovoTransport = {
      registerTrackingOnlyTransport: () => Promise.reject(new Error('socket hang up')),
      bookTransport: () => Promise.reject(new Error('socket hang up')),
      readTransportProjection: () => Promise.reject(new Error('socket hang up')),
      cancelTransport: () => Promise.reject(new Error('socket hang up')),
      requestReturnTransport: () => Promise.reject(new Error('socket hang up')),
    };
    const client = createMoovoLogisticsClient(transport, OPTIONS, deterministicDeps());

    const result = await client.bookTransport(REQUEST);

    expect(result).toMatchObject({ outcome: 'unavailable', reason: 'provider_outcome_ambiguous' });
  });

  it('ambiguity OUTRANKS the failure class — a 500 on a write reconciles, it does not retry', () => {
    const ambiguous = failure({ status: 500, afterWrite: 'unknown' });
    expect(classifyMoovoFailure(ambiguous)).toBe('provider_unavailable');
    // The class alone would say "retry_bounded". The write's ambiguity wins.
    expect(moovoRetryDisposition('book_transport', 'provider_unavailable', ambiguous)).toBe(
      'reconcile_before_retry',
    );
    // The same failure on a READ is freely retryable — nothing was written.
    expect(moovoRetryDisposition('read_transport_projection', 'provider_unavailable', ambiguous)).toBe(
      'retry_bounded',
    );
  });

  it('a write whose request never left IS retried — the bound is ambiguity, not writes', async () => {
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ status: 503, afterWrite: 'no' }) },
      { kind: 'ok', value: HANDLE },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deterministicDeps());

    const result = await client.bookTransport(REQUEST);

    expect(scripted.calls()).toBe(2);
    expect(result).toEqual({ outcome: 'ok', value: HANDLE });
  });
});

describe('#156 item 7 — idempotency and correlation', () => {
  it('sends the SAME idempotency key on every attempt and a FRESH correlation id', async () => {
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ status: 429, afterWrite: 'no' }) },
      { kind: 'failed', failure: failure({ status: 429, afterWrite: 'no' }) },
      { kind: 'ok', value: HANDLE },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deterministicDeps());

    await client.bookTransport(REQUEST);

    const keys = new Set(scripted.contexts.map((context) => context.idempotencyKey));
    expect(scripted.contexts).toHaveLength(3);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('mercaria:book_transport:rfi_01HQ');
    expect(new Set(scripted.contexts.map((c) => c.correlationId)).size).toBe(3);
  });

  it('is derived from the source reference, so two racers compose the same key', () => {
    expect(moovoIdempotencyKey('book_transport', REQUEST.sourceReference)).toBe(
      moovoIdempotencyKey('book_transport', REQUEST.sourceReference),
    );
    // A return is a SEPARATE movement and must not collide with the outbound one.
    expect(moovoIdempotencyKey('request_return_transport', REQUEST.sourceReference)).not.toBe(
      moovoIdempotencyKey('book_transport', REQUEST.sourceReference),
    );
  });
});

describe('#156 error policy — retry schedule', () => {
  it('stops at maxAttempts and waits with equal jitter, doubling', async () => {
    const deps = deterministicDeps();
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ status: 503, afterWrite: 'no' }) },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deps);

    await client.readTransportProjection('tr_1');

    expect(scripted.calls()).toBe(3);
    // random() === 0.5 ⇒ step/2 + 0.5*(step/2) = 0.75 * step. Steps: 100, 200.
    expect(deps.waits).toEqual([75, 150]);
  });

  it('honours a published Retry-After, capped by the configured ceiling', async () => {
    const deps = deterministicDeps();
    const scripted = scriptedTransport([
      {
        kind: 'failed',
        failure: failure({ status: 429, afterWrite: 'no', retryAfterMs: 999_999 }),
      },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, { ...OPTIONS, maxAttempts: 2 }, deps);

    await client.readTransportProjection('tr_1');

    expect(deps.waits).toEqual([OPTIONS.retryMaxDelayMs]);
  });

  it('does not retry a grant refusal — #156 error policy 8 forbids a retry storm', async () => {
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ status: 403, afterWrite: 'no' }) },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deterministicDeps());

    await client.readTransportProjection('tr_1');

    expect(scripted.calls()).toBe(1);
  });

  it('does not retry validation, no-service or an expired quote', () => {
    for (const [failureClass, raw] of [
      ['validation', failure({ status: 422 })],
      ['no_service', failure({ status: 400, providerCode: 'no_service_area' })],
      ['quote_expired', failure({ status: 409, providerCode: 'quote_expired' })],
    ] as const) {
      expect(classifyMoovoFailure(raw)).toBe(failureClass);
      expect(moovoRetryDisposition('read_transport_projection', failureClass, raw)).toBe('no_retry');
    }
  });

  it('classifies a quota refusal wearing a 403 as a rate limit, not an auth failure', () => {
    expect(classifyMoovoFailure(failure({ status: 403, providerCode: 'quota_exceeded' }))).toBe(
      'rate_limited',
    );
    expect(classifyMoovoFailure(failure({ status: 403 }))).toBe('authorization');
  });

  it('a 401 asks for one refresh, which this client does not perform', () => {
    // The disposition is REPORTED and acted on by nothing here: minting and
    // refreshing belong to the SDK client inside the transport (OxyHQ/oxy#878).
    expect(moovoRetryDisposition('read_transport_projection', 'authentication', failure({ status: 401 }))).toBe(
      'retry_after_refresh',
    );
  });
});

describe('#156 items 9 and 10 — nothing sensitive reaches a log', () => {
  /**
   * Every assertion in this block is case-INSENSITIVE, and that is not
   * fussiness. The first version of this suite asserted
   * `.not.toContain('Calle Mayor')` against a redactor that lower-cased its own
   * output, so the check passed while the street name sat in the log line —
   * a check that could not fail. The sibling assertion that DID fail was the
   * one written `/Calle Mayor/i`.
   */
  const forbidden = (haystack: string, needle: string) =>
    expect(haystack.toLowerCase()).not.toContain(needle.toLowerCase());

  it('keeps a machine code and DROPS anything shaped like prose', () => {
    expect(redactMoovoProviderCode('NO_SERVICE_AREA')).toBe('no_service_area');
    expect(redactMoovoProviderCode('quote.expired-2')).toBe('quote.expired-2');
    // A sentence is dropped whole rather than scrubbed: half a sentence is
    // still a sentence, and this is where an address would arrive.
    expect(redactMoovoProviderCode('Rejected for Buyer Name at Calle Mayor 4')).toBeUndefined();
    expect(redactMoovoProviderCode('a'.repeat(65))).toBeUndefined();
  });

  it('there is no field on a transport failure that could carry free text', () => {
    // The structural half of #156 item 9. `MoovoTransportFailure` has four
    // members and none of them is a message, so a transport CANNOT hand prose
    // to the client, whatever a future implementer intends.
    const sample: MoovoTransportFailure = {
      status: 422,
      providerCode: 'invalid_destination',
      afterWrite: 'no',
      retryAfterMs: 100,
    };
    expect(Object.keys(sample).sort()).toEqual([
      'afterWrite',
      'providerCode',
      'retryAfterMs',
      'status',
    ]);
  });

  it('never carries a bearer token or the idempotency key into the log shape', () => {
    const logged = safeMoovoFailureLog(
      'book_transport',
      'corr-1',
      failure({
        status: 401,
        afterWrite: 'unknown',
        providerCode: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc is invalid',
      }),
    );
    const serialised = JSON.stringify(logged);
    forbidden(serialised, 'eyJhbGciOiJIUzI1NiJ9');
    forbidden(serialised, 'rfi_01HQ');
    expect(logged).toMatchObject({
      operation: 'book_transport',
      correlationId: 'corr-1',
      failureClass: 'authentication',
      disposition: 'reconcile_before_retry',
      afterWrite: 'unknown',
    });
    // The whitespace-bearing code was dropped rather than truncated.
    expect(logged.providerCode).toBeUndefined();
    // The per-attempt correlation id is present; the per-ORDER idempotency key
    // is not, because that one is a stable handle across every retry.
    expect(Object.keys(logged)).not.toContain('idempotencyKey');
  });

  it('the client logs no request payload — an address never reaches the log call', async () => {
    const warn = vi.spyOn((await import('../../../lib/logger.js')).log.general, 'warn');
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ status: 422, providerCode: 'invalid_destination' }) },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deterministicDeps());

    await client.bookTransport(REQUEST);

    expect(warn).toHaveBeenCalled();
    const serialised = JSON.stringify(warn.mock.calls);
    // The request carried both addresses and the source reference; none of
    // them may appear, and the positive control is that the call happened at
    // all and named the operation.
    forbidden(serialised, 'Calle Mayor');
    forbidden(serialised, 'Rua Augusta');
    forbidden(serialised, 'Madrid');
    forbidden(serialised, 'rfi_01HQ');
    expect(serialised).toContain('book_transport');
    warn.mockRestore();
  });
});

describe('#156 item 10 — metrics name an operation and an outcome and nothing else', () => {
  it('counts by operation and outcome', async () => {
    const scripted = scriptedTransport([{ kind: 'ok', value: HANDLE }]);
    const client = createMoovoLogisticsClient(scripted.transport, OPTIONS, deterministicDeps());

    await client.bookTransport(REQUEST);
    await client.bookTransport(REQUEST);

    expect(moovoClientMetrics()).toEqual({ 'book_transport:ok': 2 });
  });

  it('carries no source reference, transport id or order in a metric key', async () => {
    const scripted = scriptedTransport([
      { kind: 'failed', failure: failure({ status: 500, afterWrite: 'no' }) },
    ]);
    const client = createMoovoLogisticsClient(scripted.transport, { ...OPTIONS, maxAttempts: 1 }, deterministicDeps());

    await client.readTransportProjection('tr_secret_id');

    const keys = Object.keys(moovoClientMetrics());
    expect(keys).toEqual(['read_transport_projection:unavailable']);
    expect(keys.join(' ')).not.toContain('tr_secret_id');
  });
});

describe('the coarse reason a caller outside the domain sees', () => {
  it('keeps ambiguity distinct from unreachable — the distinction the tuple was widened for', () => {
    const ambiguous = failure({ afterWrite: 'unknown' });
    const clean = failure({ afterWrite: 'no' });
    expect(moovoUnavailableReasonFor('book_transport', 'timeout', ambiguous)).toBe(
      'provider_outcome_ambiguous',
    );
    expect(moovoUnavailableReasonFor('read_transport_projection', 'timeout', clean)).toBe(
      'provider_unreachable',
    );
  });

  it('a refused request reads as provider_refused rather than unreachable', () => {
    expect(
      moovoUnavailableReasonFor('read_transport_projection', 'validation', failure({ status: 422 })),
    ).toBe('provider_refused');
  });
});
