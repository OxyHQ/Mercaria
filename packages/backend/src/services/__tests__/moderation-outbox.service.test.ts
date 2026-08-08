/**
 * The outbox invariant: nothing is enqueued outside a transaction.
 *
 * The guard moved with the port. Under Mongo it was `session.inTransaction()`;
 * under drizzle it is `requireTransaction`, which discriminates on whether the
 * handle has a `rollback` FUNCTION — the root `PostgresJsDatabase` does not, and
 * both a top-level transaction and a nested savepoint one do. That is what these
 * tests exercise, with a fake handle of each shape, and it is the part that can
 * actually regress: the guard is the whole reason a moderation report cannot be
 * answered 201 and then silently never delivered.
 *
 * `db.insert(...)` is faked rather than run, because what is under test here is
 * WHICH handle the write goes to and whether it happens at all. That the SQL is
 * accepted, that a repeat is a genuine no-op, and that the root connection is
 * refused against the REAL driver are all pinned in
 * `moderation-writes.realdb.test.ts`, which a mock structurally cannot do.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { MissingTransactionError } from '../../db/moderation/transactionGuard.js';
import { enqueueModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository.js';
import {
  decisionApplyEventId,
  isRetryableDeliveryError,
  reportSubmitEventId,
} from '../moderation/moderation-outbox.service.js';

const insert = vi.fn();
const values = vi.fn();
const onConflictDoNothing = vi.fn();
/**
 * Present, and expected to stay UNCALLED.
 *
 * `DO UPDATE` is the one spelling that reintroduces the bug the Mongo
 * `timestamps: false` flag existed to fix: a repeated enqueue becomes a real write
 * that contends with the dispatcher's live lease on that row. The realdb sibling
 * proves the row is untouched; this proves the statement never asks to update.
 */
const onConflictDoUpdate = vi.fn();

/**
 * A handle shaped like a drizzle transaction: it has a `rollback` FUNCTION.
 *
 * That property is the discriminator, not the name of the type — a savepoint
 * transaction has it too, which is why a nested enqueue is allowed.
 */
function fakeTransaction(): DatabaseOrTransaction {
  return {
    rollback: () => undefined,
    insert: (...args: unknown[]) => {
      insert(...args);
      return {
        values: (...valueArgs: unknown[]) => {
          values(...valueArgs);
          return {
            onConflictDoNothing: (...conflictArgs: unknown[]) => {
              onConflictDoNothing(...conflictArgs);
              return Promise.resolve([]);
            },
            onConflictDoUpdate: (...conflictArgs: unknown[]) => {
              onConflictDoUpdate(...conflictArgs);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as unknown as DatabaseOrTransaction;
}

/**
 * A handle shaped like the ROOT connection: everything a transaction has except
 * `rollback`.
 *
 * This is the mistake worth catching, and it is what every other repository in
 * this codebase DEFAULTS its `db` parameter to — so it is what you get by
 * forgetting an argument, not by writing a wrong one.
 */
function fakeRootDatabase(): DatabaseOrTransaction {
  // DERIVED from the transaction handle so the two differ by `rollback` and
  // nothing else — a hand-built second object could drift and quietly stop
  // testing the discriminator.
  const handle = fakeTransaction() as unknown as Record<string, unknown>;
  Reflect.deleteProperty(handle, 'rollback');
  return handle as unknown as DatabaseOrTransaction;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueModerationOutboxEvent', () => {
  it('writes the row when the caller IS in a transaction', async () => {
    const tx = fakeTransaction();

    const eventId = await enqueueModerationOutboxEvent(
      {
        eventId: 'moderation:report.submit:abc',
        kind: 'report.submit',
        payload: { reportId: 'abc' },
      },
      tx,
    );

    expect(eventId).toBe('moderation:report.submit:abc');
    expect(insert).toHaveBeenCalledTimes(1);

    const row = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.id).toBe('moderation:report.submit:abc');
    expect(row.kind).toBe('report.submit');
    expect(row.payload).toEqual({ reportId: 'abc' });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    // `expires_at` is stamped by the WRITER and swept by `expiryTargets`, so the
    // two must read the same retention. A row with no deadline would never be
    // reaped and Postgres has no TTL index to notice.
    expect(row.availableAt).toBeInstanceOf(Date);
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan((row.availableAt as Date).getTime());
  });

  it('conflicts with DO NOTHING, never DO UPDATE', async () => {
    await enqueueModerationOutboxEvent(
      { eventId: 'moderation:report.submit:abc', kind: 'report.submit', payload: { reportId: 'abc' } },
      fakeTransaction(),
    );

    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('REFUSES to write when handed the ROOT connection', async () => {
    /**
     * The mistake this catches is `enqueueModerationOutboxEvent(input, getDb())`
     * — or, worse, a defaulted parameter. It satisfies `DatabaseOrTransaction`
     * perfectly, it commits the row on its own, and it passes any test that only
     * asserts the row exists — then loses moderation work the day something
     * restarts between the two writes.
     */
    await expect(
      enqueueModerationOutboxEvent(
        {
          eventId: 'moderation:report.submit:abc',
          kind: 'report.submit',
          payload: { reportId: 'abc' },
        },
        fakeRootDatabase(),
      ),
    ).rejects.toBeInstanceOf(MissingTransactionError);

    // And nothing was written. A guard that threw AFTER writing would be worse
    // than none: the row would exist and the caller would think it did not.
    expect(insert).not.toHaveBeenCalled();
  });

  it('names the offending event in the refusal, so the failure is actionable', async () => {
    await expect(
      enqueueModerationOutboxEvent(
        {
          eventId: 'moderation:decision.apply:evt_9',
          kind: 'decision.apply',
          payload: { event: {} },
        },
        fakeRootDatabase(),
      ),
    ).rejects.toThrow(/moderation:decision\.apply:evt_9/);
  });
});

describe('deterministic event ids', () => {
  it('derives the delivery id from the report, so a retry converges on one row', () => {
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
