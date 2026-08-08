/**
 * Report intake: the report and its delivery row commit together, or not at all.
 *
 * The two behaviours worth pinning here are the two that are INVISIBLE in the 201
 * a reporter receives:
 *
 *   1. A deliverable type gets an outbox row, written with the SAME transaction
 *      handle the report was written with.
 *   2. A type with no subject provider gets NO outbox row at all, and records why
 *      in words — rather than being refused, which would make adopting CrowdSource
 *      a breaking change for every report surface not yet wired to it.
 *
 * The repositories are mocked and the transaction is faked, because what can
 * regress here is the COUPLING, and the coupling is expressed entirely in which
 * calls receive which handle. Whether the transaction is REAL — whether a failure
 * after the report insert leaves no report row — is not a question a mock can
 * answer, and is pinned in `moderation-writes.realdb.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uuidv7 } from '@oxyhq/db';

const findDuplicate = vi.fn();
const insertAbuseReport = vi.fn();
const enqueueModerationOutboxEvent = vi.fn();

/**
 * The handle `getDb().transaction(fn)` hands its callback.
 *
 * A distinct OBJECT, because the assertion below is identity: both writes must
 * receive this exact handle. A helper that quietly ran against `getDb()` would
 * type-check, would pass any "the row exists" test, and would have lost the
 * atomicity the whole design rests on.
 */
const tx = { rollback: () => undefined, marker: 'the-transaction' };

/** Which handle each write received, in order. */
const writes: { write: string; handle: unknown }[] = [];

vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({
    transaction: async <T,>(fn: (handle: typeof tx) => Promise<T>): Promise<T> => await fn(tx),
  }),
}));

vi.mock('../../db/moderation/abuseReportRepository.js', () => ({
  ABUSE_REPORT_DUPLICATE_CONSTRAINT: 'abuse_reports_reporter_reported_key',
  findAbuseReportByReporterAndObject: (...args: unknown[]) => findDuplicate(...args),
  insertAbuseReport: (...args: unknown[]) => {
    writes.push({ write: 'report', handle: args[1] });
    return insertAbuseReport(...args);
  },
}));

vi.mock('../../db/moderation/moderationOutboxRepository.js', () => ({
  enqueueModerationOutboxEvent: (...args: unknown[]) => {
    writes.push({ write: 'outbox', handle: args[1] });
    return enqueueModerationOutboxEvent(...args);
  },
}));

const { createAbuseReport } = await import('../moderation/report-intake.service.js');

const REPORT_ID = uuidv7();

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  findDuplicate.mockResolvedValue(undefined);
  insertAbuseReport.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: REPORT_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  enqueueModerationOutboxEvent.mockResolvedValue('moderation:report.submit:x');
});

describe('createAbuseReport — deliverable type (listing)', () => {
  it('writes the report AND its outbox row with ONE transaction handle', async () => {
    const result = await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'listing',
      reportedId: uuidv7(),
      categories: ['counterfeit'],
    });

    expect(result.outboxEventId).toBeDefined();

    // Both writes happened, in order, and BOTH received the transaction handle —
    // not `getDb()`. This is the invariant: two writes outside one transaction
    // give two silent failure modes (a report nothing will send; a row whose
    // report was rolled back).
    expect(writes).toEqual([
      { write: 'report', handle: tx },
      { write: 'outbox', handle: tx },
    ]);

    expect(enqueueModerationOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: `moderation:report.submit:${REPORT_ID}`,
        kind: 'report.submit',
        payload: { reportId: REPORT_ID },
      }),
      tx,
    );
  });

  it("marks the report 'queued', because delivery is genuinely owed", async () => {
    await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'listing',
      reportedId: uuidv7(),
      categories: ['unsafe_product'],
    });

    const input = insertAbuseReport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.localStatus).toBe('queued');
    expect(input.localStatusReason).toBeUndefined();
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
    expect(writes).toEqual([{ write: 'report', handle: tx }]);
  });

  it('records WHY in words, rather than leaving it to be inferred', async () => {
    await createAbuseReport({
      reporterOxyUserId: 'user-1',
      reportedType: 'store',
      reportedId: uuidv7(),
      categories: ['spam'],
    });

    const input = insertAbuseReport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.localStatus).toBe('received');

    /**
     * A missing outbox row is ALSO what a lost write looks like. The reason makes
     * the two distinguishable months later without re-deriving which types had
     * providers at the time.
     */
    expect(input.localStatusReason).toContain('store');
    expect(String(input.localStatusReason)).toMatch(/no moderation subject provider/i);

    // And it fits `abuse_reports_local_status_reason_length_check`, which would
    // otherwise turn a local-only report into a 23514 at intake.
    expect(String(input.localStatusReason).length).toBeLessThanOrEqual(300);
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
     * Drizzle binds parameters, so the Mongo-era `{$ne: null}` operator injection
     * is gone — but a non-string still reaches the INSERT and stores an object
     * where an id belongs, and the duplicate read has to be asked about a real id
     * to mean anything. The guard is also why this service stays safe for callers
     * that never passed the route's validation.
     */
    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: { $ne: null } as never,
        categories: ['spam'],
      }),
    ).rejects.toThrow(/must be a non-empty string/);
    expect(findDuplicate).not.toHaveBeenCalled();
  });

  it('rejects an empty category list', async () => {
    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: uuidv7(),
        categories: [],
      }),
    ).rejects.toThrow(/at least one category/);
  });
});

describe('createAbuseReport — duplicates', () => {
  it('refuses a second report of the same object by the same reporter', async () => {
    findDuplicate.mockResolvedValue({ id: REPORT_ID });

    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: uuidv7(),
        categories: ['counterfeit'],
      }),
    ).rejects.toThrow(/already reported/i);

    expect(insertAbuseReport).not.toHaveBeenCalled();
    expect(enqueueModerationOutboxEvent).not.toHaveBeenCalled();
  });

  it('maps the unique-index violation onto the SAME conflict, so a race reads alike', async () => {
    /**
     * The read above loses a genuine race: two taps, both reads miss, and
     * `abuse_reports_reporter_reported_key` refuses the loser. Under Mongo that
     * surfaced as an unhandled driver error — a 500 for doing exactly what the
     * other tap did. Mapping it here makes the racing and sequential cases
     * indistinguishable to the client, which is the only thing that makes the
     * read-first check worth keeping.
     *
     * Caught OUTSIDE the transaction on purpose: a 23505 aborts the transaction it
     * happens in, so a catch INSIDE would fail on its next statement.
     */
    const violation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'abuse_reports_reporter_reported_key',
    });
    insertAbuseReport.mockRejectedValue(violation);

    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: uuidv7(),
        categories: ['counterfeit'],
      }),
    ).rejects.toThrow(/already reported/i);
  });

  it('does NOT swallow an unrelated database failure as a duplicate', async () => {
    /**
     * The vacuity guard for the mapping above. A `catch` that answered "already
     * reported" for any failure would satisfy the previous test and hide every
     * real outage behind a 409 the reporter would believe.
     */
    insertAbuseReport.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(
      createAbuseReport({
        reporterOxyUserId: 'user-1',
        reportedType: 'listing',
        reportedId: uuidv7(),
        categories: ['counterfeit'],
      }),
    ).rejects.toThrow(/connection terminated/);
  });
});
