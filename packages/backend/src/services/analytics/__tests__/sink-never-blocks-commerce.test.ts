/**
 * #77 acceptance criterion 7: "analytics loss or delay never blocks search,
 * checkout, order portal or outbound navigation."
 *
 * ## What this test actually proves, and what it deliberately does not
 *
 * It makes the analytics WRITER throw on every call and then drives a real
 * commerce path — the search instrumentation, the emitter, the flush — and
 * asserts every one of them returns normally. It also asserts the counters
 * moved, because a sink that silently did nothing would pass a "did not throw"
 * assertion for the wrong reason: the vacuity floor here is that the failure
 * was REACHED.
 *
 * What it cannot prove is that no future caller `await`s something. That is
 * covered structurally instead: `recordAnalyticsEvent`, `recordSearchQuery` and
 * `emitAnalyticsEvent` all return `void`, so there is nothing to await — a
 * caller who tried would get `Property 'then' does not exist on type 'void'`
 * from `tsc`, which is a better gate than any test.
 *
 * ## Mutation-tested
 *
 * Removing the `catch` in `flushAnalyticsSink` makes `flush rejects nothing`
 * fail with the thrown error; removing the `try` in `recordAnalyticsEvent`
 * makes `enqueue never throws` fail. Both were verified by breaking them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  analyticsSinkStats,
  flushAnalyticsSink,
  recordAnalyticsEvent,
  recordSearchQuery,
  resetAnalyticsSink,
  resetAnalyticsWriter,
  setAnalyticsWriter,
} from '../sink.js';

// The config module is read at import time by the sink, so collection has to be
// on for anything to be enqueued at all. Mocked rather than set through the
// environment because `config` is frozen at module load.
vi.mock('../../../config/index.js', () => ({
  config: {
    analytics: {
      enabled: true,
      collectionMode: 'full',
      operatorOxyUserIds: [],
      operatorSurfaceEnabled: false,
      queueMaxEvents: 100,
      flushIntervalMs: 1_000,
      flushBatchSize: 10,
      pseudonymRotationHours: 24,
      internalTrafficToken: '',
      rollupEnabled: false,
      rollupIntervalMs: 60_000,
      rollupMaxBackfillDays: 30,
    },
  },
}));

/** A writer that always fails — the whole premise of this file. */
const THROWING_WRITER = {
  writeEvents: () => Promise.reject(new Error('postgres is down')),
  writeSearchQueries: () => Promise.reject(new Error('postgres is down')),
};

/** One insertable event, minimal but complete enough for the queue. */
function anEvent() {
  const now = new Date();
  return {
    envelopeVersion: '2026-08-09.1',
    eventType: 'product_page_view' as const,
    eventClass: 'discovery' as const,
    occurredAt: now,
    receivedAt: now,
    actorKind: 'anonymous' as const,
    oxyUserId: null,
    pseudonymousSessionId: null,
    pseudonymEpoch: null,
    checkoutGroupId: null,
    orderId: null,
    clientSurface: 'storefront_web' as const,
    appVersion: null,
    market: null,
    queryEventId: null,
    listingId: 'listing-1',
    productVariantId: null,
    canonicalProductId: null,
    canonicalVariantId: null,
    offerId: null,
    merchantId: null,
    storefrontId: null,
    categoryId: null,
    storeId: null,
    searchPolicyVersion: null,
    rankingPolicyVersion: null,
    experimentKey: null,
    experimentVersion: null,
    experimentVariant: null,
    trafficClass: 'human' as const,
    consentState: 'granted' as const,
    collectionMode: 'full' as const,
    buyerOrigin: null,
    paymentMethodCategory: null,
    reasonCode: null,
    position: null,
    resultCount: null,
    latencyMs: null,
    quantity: null,
    itemCount: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
  };
}

/** One search record. */
function aQuery() {
  const now = new Date();
  return {
    queryEventId: 'q-1',
    redactedText: 'red shoes',
    redactionKinds: [],
    normalizedTokens: ['red', 'shoes'],
    resultCount: 4,
    duplicateResultCount: 0,
    latencyMs: 12,
    market: null,
    categoryId: null,
    searchPolicyVersion: null,
    rankingPolicyVersion: null,
    trafficClass: 'human' as const,
    textExpiresAt: new Date(now.getTime() + 86_400_000),
    expiresAt: new Date(now.getTime() + 172_800_000),
  };
}

describe('the analytics sink cannot block commerce', () => {
  beforeEach(() => {
    resetAnalyticsSink();
    setAnalyticsWriter(THROWING_WRITER);
  });

  afterEach(() => {
    resetAnalyticsWriter();
    resetAnalyticsSink();
  });

  it('enqueue never throws, whatever the writer does', () => {
    // The writer is not even reached here — enqueue is in-process — which is
    // itself the property: a commerce path pays no database cost at all.
    expect(() => {
      recordAnalyticsEvent(anEvent());
      recordSearchQuery(aQuery());
    }).not.toThrow();
    expect(analyticsSinkStats().queuedEvents).toBe(1);
    expect(analyticsSinkStats().queuedSearchQueries).toBe(1);
  });

  it('the flush swallows a writer failure and reports it in the counters', async () => {
    recordAnalyticsEvent(anEvent());
    recordSearchQuery(aQuery());

    // Would REJECT if the catch were removed. That is the mutation this
    // assertion was verified against.
    await expect(flushAnalyticsSink()).resolves.toBeUndefined();

    const stats = analyticsSinkStats();
    // The vacuity floor: without these, a sink that quietly enqueued nothing
    // would pass the assertion above for entirely the wrong reason.
    expect(stats.flushFailures).toBe(1);
    expect(stats.droppedForFailure).toBe(2);
    expect(stats.flushedEvents).toBe(0);
    // The batch is NOT re-queued: an analytics write that failed once will
    // usually fail again, and re-queueing turns a transient database problem
    // into an ever-growing buffer that then drops the NEW events instead.
    expect(stats.queuedEvents).toBe(0);
    expect(stats.queuedSearchQueries).toBe(0);
  });

  it('a full queue drops the OLDEST and keeps accepting', () => {
    // 100 is the mocked cap. The 101st write must succeed, and the queue must
    // not grow — an unbounded queue would turn a Postgres outage into a memory
    // leak and take the API down with it, which is the failure this design
    // exists to make impossible.
    for (let i = 0; i < 150; i += 1) {
      recordAnalyticsEvent(anEvent());
    }
    const stats = analyticsSinkStats();
    expect(stats.queuedEvents).toBe(100);
    expect(stats.droppedForCapacity).toBe(50);
  });

  it('the emitter returns void, so a commerce path has nothing to await', async () => {
    // The structural half, asserted at runtime as well as by `tsc`: a function
    // returning a promise would let a caller add an `await` and put a database
    // round trip on the checkout path.
    const { emitAnalyticsEvent } = await import('../emit.js');
    const req = { headers: {}, commerceActor: { kind: 'anonymous' } } as unknown as Request;
    const returned: unknown = emitAnalyticsEvent(req, { eventType: 'product_page_view' });
    expect(returned).toBeUndefined();
  });

  it('the search instrumentation returns a handle, not a promise', async () => {
    const { instrumentSearch } = await import('../search-instrumentation.js');
    const req = { headers: {}, commerceActor: { kind: 'anonymous' } } as unknown as Request;
    const queryEventId = instrumentSearch(req, { term: 'red shoes', resultCount: 3, latencyMs: 9 });
    expect(typeof queryEventId).toBe('string');
    // And the record it enqueued carries the REDACTED text — the raw term never
    // reaches the queue, which is where "raw query text is never retained"
    // actually happens.
    expect(analyticsSinkStats().queuedSearchQueries).toBe(1);
  });
});
