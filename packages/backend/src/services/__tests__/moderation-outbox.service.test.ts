/**
 * The outbox invariant: nothing is enqueued outside a transaction.
 *
 * `mongodb-memory-server` is not available, so `ModerationOutbox` is mocked and
 * these tests assert the GUARD rather than Mongo's behaviour — which is the part
 * that can actually regress. The guard is the whole reason a moderation report
 * cannot be answered 201 and then silently never delivered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClientSession } from 'mongoose';

const outboxUpdateOne = vi.fn();

vi.mock('../../models/moderation-outbox.js', () => ({
  ModerationOutbox: {
    updateOne: (...args: unknown[]) => outboxUpdateOne(...args),
  },
  MODERATION_OUTBOX_RETENTION_SECONDS: 1_209_600,
}));

const {
  enqueueModerationOutboxEvent,
  ModerationOutboxTransactionError,
  reportSubmitEventId,
  decisionApplyEventId,
  isRetryableDeliveryError,
} = await import('../moderation/moderation-outbox.service.js');

/** A session that is or is not inside a transaction — the only thing that matters. */
function fakeSession(inTransaction: boolean): ClientSession {
  return { inTransaction: () => inTransaction } as unknown as ClientSession;
}

beforeEach(() => {
  vi.clearAllMocks();
  outboxUpdateOne.mockResolvedValue({ upsertedCount: 1 });
});

describe('enqueueModerationOutboxEvent', () => {
  it('writes the row when the caller IS in a transaction', async () => {
    const session = fakeSession(true);

    const eventId = await enqueueModerationOutboxEvent(
      { eventId: 'moderation:report.submit:abc', kind: 'report.submit', payload: { reportId: 'abc' } },
      session,
    );

    expect(eventId).toBe('moderation:report.submit:abc');
    expect(outboxUpdateOne).toHaveBeenCalledTimes(1);

    // The caller's session must be passed through, or the row commits on its own
    // and the atomicity this whole design rests on is gone.
    const options = outboxUpdateOne.mock.calls[0]?.[2] as { session?: ClientSession; upsert?: boolean };
    expect(options.session).toBe(session);
    expect(options.upsert).toBe(true);
  });

  it('REFUSES to write when the session is not in a transaction', async () => {
    /**
     * The mistake this catches is a bare `startSession()` that nobody opened a
     * transaction on. It satisfies the required-parameter type perfectly, it
     * commits the row on its own, and it passes any test that only asserts the
     * row exists — then loses moderation work the day something restarts between
     * the two writes.
     */
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: 'moderation:report.submit:abc', kind: 'report.submit', payload: { reportId: 'abc' } },
        fakeSession(false),
      ),
    ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);

    // And nothing was written. A guard that threw AFTER writing would be worse
    // than none: the row would exist and the caller would think it did not.
    expect(outboxUpdateOne).not.toHaveBeenCalled();
  });

  it('names the offending event in the refusal, so the failure is actionable', async () => {
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: 'moderation:decision.apply:evt_9', kind: 'decision.apply', payload: { event: {} } },
        fakeSession(false),
      ),
    ).rejects.toThrow(/moderation:decision\.apply:evt_9/);
  });
});

describe('deterministic event ids', () => {
  it('derives the delivery id from the report, so a retry upserts one row', () => {
    expect(reportSubmitEventId('report-1')).toBe('moderation:report.submit:report-1');
    expect(reportSubmitEventId('report-1')).toBe(reportSubmitEventId('report-1'));
  });

  it('derives the decision id from the webhook event id', () => {
    expect(decisionApplyEventId('evt_1')).toBe('moderation:decision.apply:evt_1');
  });
});

describe('isRetryableDeliveryError', () => {
  it('honours an explicit retryable flag', () => {
    expect(isRetryableDeliveryError({ retryable: false })).toBe(false);
    expect(isRetryableDeliveryError({ retryable: true })).toBe(true);
  });

  it('treats an UNKNOWN error as retryable', () => {
    /**
     * The safe direction. Assuming a defect is permanent is how a recoverable
     * outage becomes lost moderation work; assuming it is transient only costs
     * attempts, which the backoff and the dead-letter cap bound.
     */
    expect(isRetryableDeliveryError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableDeliveryError({ retryable: 'no' })).toBe(true);
    expect(isRetryableDeliveryError(undefined)).toBe(true);
  });
});
