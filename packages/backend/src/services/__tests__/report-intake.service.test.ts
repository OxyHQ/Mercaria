/**
 * Report intake: the report and its delivery row commit together, or not at all.
 *
 * The two behaviours worth pinning are the two that are INVISIBLE in the 201 a
 * reporter receives:
 *
 *   1. A deliverable type gets an outbox row, written with the SAME session the
 *      report was written with, inside a transaction.
 *   2. A type with no subject provider gets NO outbox row at all, and records why
 *      in words — rather than being refused, which would make adopting CrowdSource
 *      a breaking change for every report surface not yet wired to it.
 *
 * `mongodb-memory-server` is not available, so the models and the mongoose
 * session are mocked. That is enough: what can regress here is the COUPLING, and
 * the coupling is expressed entirely in which calls receive which session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const reportFindOne = vi.fn();
const reportCreate = vi.fn();
const enqueueModerationOutboxEvent = vi.fn();

/** Records whether a transaction was open when each write happened. */
let inTransaction = false;
const sessionCalls: { write: string; inTransaction: boolean }[] = [];

const session = {
  inTransaction: () => inTransaction,
  withTransaction: async (fn: () => Promise<void>) => {
    inTransaction = true;
    try {
      await fn();
    } finally {
      inTransaction = false;
    }
  },
  endSession: vi.fn(),
};

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongoose')>();
  return {
    ...actual,
    default: { ...actual.default, startSession: async () => session },
    startSession: async () => session,
  };
});

vi.mock('../../models/abuse-report.js', () => ({
  AbuseReport: {
    findOne: (...args: unknown[]) => reportFindOne(...args),
    create: (...args: unknown[]) => reportCreate(...args),
  },
}));

vi.mock('../moderation/moderation-outbox.service.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../moderation/moderation-outbox.service.js')
  >();
  return {
    ...actual,
    enqueueModerationOutboxEvent: (...args: unknown[]) => {
      sessionCalls.push({ write: 'outbox', inTransaction });
      return enqueueModerationOutboxEvent(...args);
    },
  };
});

const { createAbuseReport } = await import('../moderation/report-intake.service.js');

const REPORT_ID = new Types.ObjectId();

beforeEach(() => {
  vi.clearAllMocks();
  sessionCalls.length = 0;
  inTransaction = false;
  reportFindOne.mockReturnValue({
    session: () => ({ lean: async () => null }),
  });
  reportCreate.mockImplementation(async (docs: Record<string, unknown>[]) => {
    sessionCalls.push({ write: 'report', inTransaction });
    return [{ ...docs[0], _id: REPORT_ID, createdAt: new Date() }];
  });
  enqueueModerationOutboxEvent.mockResolvedValue('moderation:report.submit:x');
});

describe('createAbuseReport — deliverable type (listing)', () => {
  it('writes the report AND its outbox row inside ONE transaction', async () => {
    const result = await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'listing',
      reportedId: new Types.ObjectId().toHexString(),
      categories: ['counterfeit'],
    });

    expect(result.outboxEventId).toBeDefined();

    // Both writes happened, and BOTH happened with a transaction open. This is
    // the invariant: two writes outside one transaction give two silent failure
    // modes (a report nothing will send; a row whose report was rolled back).
    expect(sessionCalls).toEqual([
      { write: 'report', inTransaction: true },
      { write: 'outbox', inTransaction: true },
    ]);

    // And the outbox call received the caller's session, not one of its own.
    expect(enqueueModerationOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: `moderation:report.submit:${REPORT_ID.toHexString()}`,
        kind: 'report.submit',
      }),
      session,
    );
  });

  it("marks the report 'queued', because delivery is genuinely owed", async () => {
    await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'listing',
      reportedId: new Types.ObjectId().toHexString(),
      categories: ['unsafe_product'],
    });

    const doc = reportCreate.mock.calls[0]?.[0][0] as Record<string, unknown>;
    expect(doc.localStatus).toBe('queued');
    expect(doc.localStatusReason).toBeUndefined();
  });
});

describe('createAbuseReport — type with no subject provider (seller)', () => {
  it('STORES the report and enqueues nothing', async () => {
    const result = await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'seller',
      reportedId: 'seller-oxy-id',
      categories: ['scam'],
    });

    expect(result.outboxEventId).toBeUndefined();
    expect(enqueueModerationOutboxEvent).not.toHaveBeenCalled();

    /**
     * No outbox row is created AT ALL — not one a worker skips later. A row for
     * an undeliverable type would dead-letter a report that is not defective.
     */
    expect(sessionCalls).toEqual([{ write: 'report', inTransaction: true }]);
  });

  it("records WHY in words, rather than leaving it to be inferred", async () => {
    await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'store',
      reportedId: new Types.ObjectId().toHexString(),
      categories: ['spam'],
    });

    const doc = reportCreate.mock.calls[0]?.[0][0] as Record<string, unknown>;
    expect(doc.localStatus).toBe('received');

    /**
     * A missing outbox row is ALSO what a lost write looks like. The reason makes
     * the two distinguishable months later without re-deriving which types had
     * providers at the time.
     */
    expect(doc.localStatusReason).toContain('store');
    expect(String(doc.localStatusReason)).toMatch(/no moderation subject provider/i);
  });

  it('is NOT refused — the API accepts more than it delivers', async () => {
    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'seller',
        reportedId: 'seller-oxy-id',
        categories: ['other'],
      }),
    ).resolves.toBeDefined();
  });
});

describe('createAbuseReport — validation', () => {
  it('rejects a reportedType outside the union', async () => {
    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        // Deliberately outside the union: a client bug, and a 400.
        reportedType: 'order' as never,
        reportedId: 'x',
        categories: ['spam'],
      }),
    ).rejects.toThrow(/not a reportable type/);
  });

  it('rejects a non-string reportedId before it reaches the query', async () => {
    /**
     * `{$ne: null}` passes a truthiness check, matches an UNRELATED report, and
     * would make the duplicate check answer about somebody else's row.
     */
    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: { $ne: null } as never,
        categories: ['spam'],
      }),
    ).rejects.toThrow(/must be a non-empty string/);
    expect(reportFindOne).not.toHaveBeenCalled();
  });

  it('rejects an empty category list', async () => {
    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: new Types.ObjectId().toHexString(),
        categories: [],
      }),
    ).rejects.toThrow(/at least one category/);
  });
});

describe('createAbuseReport — duplicates', () => {
  it('refuses a second report of the same object by the same reporter', async () => {
    reportFindOne.mockReturnValue({
      session: () => ({ lean: async () => ({ _id: REPORT_ID }) }),
    });

    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: new Types.ObjectId().toHexString(),
        categories: ['counterfeit'],
      }),
    ).rejects.toThrow(/already reported/i);

    expect(reportCreate).not.toHaveBeenCalled();
    expect(enqueueModerationOutboxEvent).not.toHaveBeenCalled();
  });
});
