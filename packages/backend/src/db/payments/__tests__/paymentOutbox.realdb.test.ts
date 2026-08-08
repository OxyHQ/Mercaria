/**
 * The payment outbox's own mechanism, against a REAL PostgreSQL database.
 *
 * The moderation outbox's semantics, ported: deterministic ids so a repeat
 * converges, the row IS the job, a claim is a lease with an OWNER check, and a
 * failure that cannot succeed becomes a visible `dead_letter`. Each of those is
 * a property of a concurrent UPDATE against real row locks, so each of them is
 * asserted here rather than reviewed.
 *
 * ## The one that a mock would get wrong in the dangerous direction
 *
 * `enqueue` must be a genuine NO-OP for a row that already exists. The Mongo
 * version needed `timestamps: false` on that one `updateOne` to achieve it, and
 * the tempting alternative — letting the ODM own the timestamps — cleared the
 * error while turning every repeat into a real write contending with the
 * dispatcher's live lease on the same row. Postgres gives the property natively
 * with `on conflict do nothing`; the test below is what stops someone
 * "improving" that into a `do update`.
 *
 * No cleanup between tests, and no TRUNCATE: vitest runs files in parallel
 * against ONE throwaway database, so a table-level statement here would take
 * another file's rows with it. Every id below is unique per run instead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { paymentOutboxes } from '../../schema/payments.js';
import {
  claimPaymentOutboxEvent,
  completePaymentOutboxEvent,
  enqueuePaymentOutboxEvent,
  failPaymentOutboxEvent,
  findPaymentOutboxEvent,
  renewPaymentOutboxEvent,
} from '../paymentOutboxRepository.js';
import type { Database } from '../../postgres.js';

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A far-future expiry — nothing here is testing the sweep. */
const EXPIRES_AT = new Date(Date.now() + 86_400_000);

let db: Database;
let closePostgres: typeof import('../../postgres.js').closePostgres;

beforeAll(async () => {
  const postgres = await import('../../postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/** Enqueue one row with an id unique to this test. */
async function enqueue(name: string, availableAt?: Date): Promise<string> {
  const id = `payment:payment_succeeded:${RUN}-${name}`;
  await enqueuePaymentOutboxEvent(db, {
    id,
    eventType: 'payment_succeeded',
    payload: { paymentId: `pay-${name}` },
    expiresAt: EXPIRES_AT,
    ...(availableAt ? { availableAt } : {}),
  });
  return id;
}

describe('enqueue converges on one row', () => {
  it('reports the first write and NOT the repeat', async () => {
    const id = `payment:payment_succeeded:${RUN}-converge`;
    const first = await enqueuePaymentOutboxEvent(db, {
      id,
      eventType: 'payment_succeeded',
      payload: { paymentId: 'pay-converge' },
      expiresAt: EXPIRES_AT,
    });
    const second = await enqueuePaymentOutboxEvent(db, {
      id,
      eventType: 'payment_succeeded',
      payload: { paymentId: 'pay-converge' },
      expiresAt: EXPIRES_AT,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('leaves an existing row COMPLETELY untouched on a repeat', async () => {
    const id = await enqueue('untouched');
    const before = await findPaymentOutboxEvent(db, id);
    expect(before).toBeDefined();

    // A repeat is ordinary — a transaction retry, two concurrent duplicate
    // events, a reconciliation sweep re-deriving the same fact — and it happens
    // while the dispatcher may hold a live lease on this very row.
    await enqueuePaymentOutboxEvent(db, {
      id,
      eventType: 'payment_succeeded',
      payload: { paymentId: 'DIFFERENT' },
      expiresAt: new Date(Date.now() + 1_000),
    });

    const after = await findPaymentOutboxEvent(db, id);
    // Every field, not just `updated_at`: a `do update` would also have replaced
    // the payload with the second caller's, which is the more damaging half.
    expect(after).toEqual(before);
  });
});

describe('a claim is a lease with an owner check', () => {
  it('claims a due row, marks it processing and counts the attempt', async () => {
    const id = await enqueue('claimable');
    const claimed = await claimPaymentOutboxEvent(db, {
      leaseOwner: 'task-a',
      leaseMs: 60_000,
      eventId: id,
    });
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe('processing');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseOwner).toBe('task-a');
  });

  it('does not hand the same live claim to a second task', async () => {
    const id = await enqueue('exclusive');
    const first = await claimPaymentOutboxEvent(db, {
      leaseOwner: 'task-a',
      leaseMs: 60_000,
      eventId: id,
    });
    const second = await claimPaymentOutboxEvent(db, {
      leaseOwner: 'task-b',
      leaseMs: 60_000,
      eventId: id,
    });
    expect(first?.id).toBe(id);
    expect(second).toBeUndefined();
  });

  it('reclaims a row whose lease has EXPIRED — a dead task strands nothing', async () => {
    const id = await enqueue('reclaimable');
    await claimPaymentOutboxEvent(db, { leaseOwner: 'dead-task', leaseMs: 60_000, eventId: id });

    // Simulate the lease having run out, rather than sleeping for a minute.
    await db
      .update(paymentOutboxes)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(paymentOutboxes.id, id));

    const reclaimed = await claimPaymentOutboxEvent(db, {
      leaseOwner: 'live-task',
      leaseMs: 60_000,
      eventId: id,
    });
    expect(reclaimed?.leaseOwner).toBe('live-task');
    // The attempt count carries across the reclaim, which is what eventually
    // dead-letters a row that no task can ever finish.
    expect(reclaimed?.attempts).toBe(2);
  });

  it('will not complete a lease this task does not own', async () => {
    const id = await enqueue('not-mine');
    await claimPaymentOutboxEvent(db, { leaseOwner: 'task-a', leaseMs: 60_000, eventId: id });

    expect(await completePaymentOutboxEvent(db, id, 'task-b')).toBe(false);
    expect(await completePaymentOutboxEvent(db, id, 'task-a')).toBe(true);

    const row = await findPaymentOutboxEvent(db, id);
    expect(row?.status).toBe('processed');
    expect(row?.processedAt).toBeInstanceOf(Date);
    expect(row?.leaseOwner).toBeNull();
  });

  it('will not renew a lease this task does not own', async () => {
    const id = await enqueue('renew');
    await claimPaymentOutboxEvent(db, { leaseOwner: 'task-a', leaseMs: 60_000, eventId: id });
    expect(await renewPaymentOutboxEvent(db, id, 'task-b', 60_000)).toBe(false);
    expect(await renewPaymentOutboxEvent(db, id, 'task-a', 60_000)).toBe(true);
  });

  it('does not claim a row that is not due yet', async () => {
    const id = await enqueue('future', new Date(Date.now() + 3_600_000));
    const claimed = await claimPaymentOutboxEvent(db, {
      leaseOwner: 'task-a',
      leaseMs: 60_000,
      eventId: id,
    });
    expect(claimed).toBeUndefined();
  });
});

describe('a failure is released with backoff, or dead-lettered visibly', () => {
  it('returns a retryable failure to pending, with its error and its next attempt time', async () => {
    const id = await enqueue('retry');
    await claimPaymentOutboxEvent(db, { leaseOwner: 'task-a', leaseMs: 60_000, eventId: id });

    const availableAt = new Date(Date.now() + 4_000);
    const released = await failPaymentOutboxEvent(db, {
      eventId: id,
      leaseOwner: 'task-a',
      error: 'upstream timed out',
      deadLetter: false,
      availableAt,
    });
    expect(released).toBe(true);

    const row = await findPaymentOutboxEvent(db, id);
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBe('upstream timed out');
    expect(row?.availableAt.getTime()).toBe(availableAt.getTime());
    // The lease is gone, so any task may take it when it comes due.
    expect(row?.leaseOwner).toBeNull();
  });

  it('dead-letters a permanent failure and keeps it VISIBLE with its error', async () => {
    const id = await enqueue('dead');
    await claimPaymentOutboxEvent(db, { leaseOwner: 'task-a', leaseMs: 60_000, eventId: id });

    await failPaymentOutboxEvent(db, {
      eventId: id,
      leaseOwner: 'task-a',
      error: 'no handler for this event type in this version',
      deadLetter: true,
      availableAt: new Date(Date.now() + 60_000),
    });

    const row = await findPaymentOutboxEvent(db, id);
    expect(row?.status).toBe('dead_letter');
    expect(row?.lastError).toContain('no handler');

    // …and it is NOT claimable again. A dead letter that kept being retried
    // would bury the fact that it needs a human under an attempt count nobody
    // reads.
    const claimed = await claimPaymentOutboxEvent(db, {
      leaseOwner: 'task-b',
      leaseMs: 60_000,
      eventId: id,
    });
    expect(claimed).toBeUndefined();
  });

  it('truncates an enormous error rather than failing its own CHECK', async () => {
    const id = await enqueue('long-error');
    await claimPaymentOutboxEvent(db, { leaseOwner: 'task-a', leaseMs: 60_000, eventId: id });
    await failPaymentOutboxEvent(db, {
      eventId: id,
      leaseOwner: 'task-a',
      error: 'x'.repeat(5_000),
      deadLetter: false,
      availableAt: new Date(),
    });
    const row = await findPaymentOutboxEvent(db, id);
    expect(row?.lastError).toHaveLength(2_000);
  });
});
