/**
 * The moderation writes, against a REAL PostgreSQL database.
 *
 * Every other moderation test in this suite mocks its repositories, and that
 * mocking has exactly one blind spot — but it is the one that matters most here: a
 * mocked write accepts ANY statement, including one the SERVER would refuse, and a
 * mocked handle cannot tell a transaction from the root connection. A suite built
 * only on mocks stays green while `POST /reports` 500s on the very first report.
 *
 * Four properties live here and CANNOT live anywhere else:
 *
 *  - **the intake pair is atomic** — a failure after the report insert leaves no
 *    report row AND no outbox row, which is only observable if both writes really
 *    joined one transaction;
 *  - **the enqueue refuses the ROOT connection**, not merely a missing argument;
 *  - **a repeated enqueue leaves the existing row physically untouched**, asserted
 *    on `xmin` as well as the timestamps, so an `ON CONFLICT DO UPDATE` writing
 *    IDENTICAL values still fails this test;
 *  - **`SKIP LOCKED` really skips** — two concurrent dispatchers take one row each
 *    rather than one taking a row and the other blocking on it and coming back
 *    empty.
 *
 * ## What the Mongo original was for, and why the shape of the hazard changed
 *
 * The file it replaces existed to catch a Mongo-specific bug: naming
 * `createdAt`/`updatedAt` inside `$setOnInsert` on a schema declaring
 * `{ timestamps: true }` put one path under two operators and the server refused
 * the whole write, aborting the intake transaction with it. That exact bug cannot
 * exist here — but its second half can, and does: the "obvious" fix under Mongo
 * (let the ORM own the timestamps) left a `$set: { updatedAt }` on the update and
 * turned a repeated enqueue into a real write contending with the dispatcher's
 * live lease. `ON CONFLICT DO NOTHING` is the structural answer, and the
 * `xmin` assertion below is what holds it.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files in
 * parallel workers, so every id this file writes carries a per-run suffix and
 * teardown deletes exactly what it created. A `delete from moderation_outboxes`
 * here would silently empty the sibling decision and observe files mid-run.
 *
 * Ids alone do not scope a claim WITHOUT an `eventId`, though: its predicate is
 * `status = 'pending' AND available_at <= now`, which matches any sibling file's
 * due row — `expirySweeper.realdb.test.ts` fixtures and the webhook file's
 * `decision.apply` rows both qualified, and a `sweep-outbox-*` id really did
 * surface inside a claim assertion here (#151). So the two unscoped-claim tests
 * claim at a SYNTHETIC instant just after the epoch, having first moved their own
 * rows' `available_at` beneath it: at that instant this file's rows are the only
 * due rows in the table (a real row's `available_at` is decades later, and a
 * NULL `lease_until` fails the reclaim branch's comparison outright), and the
 * claim's own ORDER BY / SKIP LOCKED behavior is untouched. The same scoping
 * protects the siblings from US — an unscoped claim can no longer lease a
 * webhook row and bump the attempt count its file is about to assert on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres.js';
import {
  abuseReports,
  moderationEnforcements,
  moderationOutboxes,
} from '../../db/schema/moderation.js';
import {
  findAbuseReportById,
  insertAbuseReport,
} from '../../db/moderation/abuseReportRepository.js';
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  enqueueModerationOutboxEvent,
  findModerationOutboxEvent,
  releaseModerationOutboxEvent,
  renewModerationOutboxEvent,
} from '../../db/moderation/moderationOutboxRepository.js';
import { claimModerationEnforcement } from '../../db/moderation/moderationEnforcementRepository.js';
import { MissingTransactionError } from '../../db/moderation/transactionGuard.js';
import { insertListing } from '../../db/catalog/listingRepository.js';
import { listings } from '../../db/schema/catalog.js';
import { createAbuseReport } from '../moderation/report-intake.service.js';
import { buildReportInput } from '../moderation/evidence-snapshot.service.js';
import { reportSubmitEventId } from '../moderation/moderation-outbox.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7();

const createdReportIds: string[] = [];
const createdOutboxIds: string[] = [];
const createdDecisionIds: string[] = [];
const createdListingIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  const reportIds = createdReportIds.splice(0);
  const outboxIds = createdOutboxIds.splice(0);
  const decisionIds = createdDecisionIds.splice(0);
  if (outboxIds.length > 0) {
    await db.delete(moderationOutboxes).where(inArray(moderationOutboxes.id, outboxIds));
  }
  if (reportIds.length > 0) {
    await db.delete(abuseReports).where(inArray(abuseReports.id, reportIds));
  }
  if (decisionIds.length > 0) {
    await db
      .delete(moderationEnforcements)
      .where(inArray(moderationEnforcements.decisionId, decisionIds));
  }
  const listingIds = createdListingIds.splice(0);
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
});

/** Register a report AND the outbox row intake derives from it, for teardown. */
function trackReport(reportId: string): string {
  createdReportIds.push(reportId);
  createdOutboxIds.push(reportSubmitEventId(reportId));
  return reportId;
}

function outboxId(name: string): string {
  const id = `moderation:report.submit:${name}-${RUN}`;
  createdOutboxIds.push(id);
  return id;
}

function decisionId(name: string): string {
  const id = `${name}-${RUN}`;
  createdDecisionIds.push(id);
  return id;
}

/**
 * The row's physical version.
 *
 * `xmin` is the transaction that last wrote the tuple, so it changes on ANY
 * update — including one that writes identical values. That is what makes
 * "completely untouched" a claim about the ROW rather than about the columns a
 * test happened to look at, and it is what makes the untouched-row test below able
 * to fail against an `ON CONFLICT DO UPDATE` that sets the same data back.
 */
/** Both timestamp columns of one outbox row. */
async function timestampsOf(id: string): Promise<{ createdAt: Date; updatedAt: Date }> {
  const [row] = await db
    .select({ createdAt: moderationOutboxes.createdAt, updatedAt: moderationOutboxes.updatedAt })
    .from(moderationOutboxes)
    .where(eq(moderationOutboxes.id, id));
  if (row === undefined) throw new Error(`no outbox row '${id}' to read timestamps from`);
  return row;
}

async function physicalVersion(id: string): Promise<string> {
  const rows = await db.execute<{ xmin: string }>(
    sql`select xmin::text as xmin from ${moderationOutboxes} where ${moderationOutboxes.id} = ${id}`,
  );
  const version = rows[0]?.xmin;
  if (version === undefined) throw new Error(`no outbox row '${id}' to read xmin from`);
  return version;
}

describe('the outbox write is ACCEPTED by a real server', () => {
  it('writes the row inside the caller transaction', async () => {
    const id = outboxId('accepted');

    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId: 'r1' } },
        tx,
      );
    });

    const row = await findModerationOutboxEvent(id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('report.submit');
    expect(row?.payload).toEqual({ reportId: 'r1' });
    expect(row?.attempts).toBe(0);
    // Set at insert and never advanced — without it the expiry sweep has nothing
    // to select on and the table grows forever, with no error and no symptom.
    expect(row?.expiresAt.getTime()).toBeGreaterThan(row?.createdAt.getTime() ?? 0);
  });

  it('is idempotent — a retry converges on the SAME row', async () => {
    const id = outboxId('idempotent');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.transaction(async (tx) => {
        await enqueueModerationOutboxEvent(
          { eventId: id, kind: 'report.submit', payload: { reportId: 'r2' } },
          tx,
        );
      });
    }

    const rows = await db
      .select({ id: moderationOutboxes.id })
      .from(moderationOutboxes)
      .where(eq(moderationOutboxes.id, id));
    expect(rows).toHaveLength(1);
  });

  it('leaves an existing row COMPLETELY untouched on a repeated enqueue', async () => {
    /**
     * "Same row" is not the same claim as "no write happened", and only the second
     * one is what the deterministic event id is for.
     *
     * A repeat is ordinary — a transaction retry, two concurrent duplicate
     * submissions, a reconciliation sweep re-deriving the event — and it runs
     * while the dispatcher is taking, renewing and completing leases on those same
     * rows. A write nobody needed contends with a lease write.
     *
     * Three assertions, and the third is the one that cannot be satisfied by a
     * `DO UPDATE` writing identical values back: `xmin` is the tuple's writing
     * transaction, so it moves on any update at all.
     */
    const id = outboxId('untouched');
    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId: 'r3' } },
        tx,
      );
    });

    const before = await timestampsOf(id);
    const versionBefore = await physicalVersion(id);

    // A repeat, far enough later that a bumped timestamp is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId: 'r3' } },
        tx,
      );
    });

    // `xmin` FIRST, deliberately: it is the strongest of the three and the only
    // one a `DO UPDATE` careful enough to leave every column alone would still
    // fail. Asserting it after the timestamps would let the weaker assertion
    // report first and leave the strong one unexercised.
    expect(await physicalVersion(id)).toBe(versionBefore);

    const after = await timestampsOf(id);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('re-enqueues while the dispatcher holds a LIVE lease, without disturbing it', async () => {
    /**
     * The failure the no-op property prevents: a reconciliation-shaped transaction
     * re-deriving an event while a dispatcher holds a lease on that same row. If
     * the repeat wrote, the two would contend — and worse, a `DO UPDATE` restoring
     * `status: 'pending'` would hand the row to a SECOND dispatcher while the
     * first is still delivering it.
     */
    const id = outboxId('contended');
    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId: 'r4' } },
        tx,
      );
    });

    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'live-dispatcher', eventId: id });
    expect(claimed?.id).toBe(id);

    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId: 'r4' } },
        tx,
      );
    });

    // The lease survived the repeat intact — same owner, still `processing`, and
    // still not claimable by anyone else.
    const after = await findModerationOutboxEvent(id);
    expect(after?.leaseOwner).toBe('live-dispatcher');
    expect(after?.attempts).toBe(1);
    expect(await claimModerationOutboxEvent({ leaseOwner: 'other', eventId: id })).toBeNull();
  });

  it('REFUSES the root connection, against the real driver', async () => {
    /**
     * `getDb()` satisfies `DatabaseOrTransaction`, and it is what every OTHER
     * repository in this codebase defaults that parameter to — so this is the
     * mistake you get by forgetting an argument, not by writing a wrong one.
     */
    const id = outboxId('refused');

    await expect(
      enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId: 'r5' } },
        getDb(),
      ),
    ).rejects.toBeInstanceOf(MissingTransactionError);

    expect(await findModerationOutboxEvent(id)).toBeUndefined();
  });

  it('ACCEPTS a nested (savepoint) transaction — the discriminator is `rollback`, not depth', async () => {
    /**
     * The vacuity guard for the refusal above, and a real requirement: a caller
     * that already opened a transaction and calls into another repository which
     * opens its own gets a SAVEPOINT handle. If the guard tested anything narrower
     * than "has a rollback function" it would refuse that legitimate case, and the
     * refusal test alone could not tell the two apart.
     */
    const id = outboxId('nested');

    await db.transaction(async (tx) => {
      await tx.transaction(async (nested) => {
        await enqueueModerationOutboxEvent(
          { eventId: id, kind: 'report.submit', payload: { reportId: 'r6' } },
          nested,
        );
      });
    });

    expect(await findModerationOutboxEvent(id)).toBeDefined();
  });
});

describe('the outbox claim is a lease, and SKIP LOCKED makes it shareable', () => {
  async function enqueue(id: string, reportId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId: id, kind: 'report.submit', payload: { reportId } },
        tx,
      );
    });
  }

  /**
   * The synthetic instant the unscoped-claim tests claim at — see the module
   * docblock's scoping section. Two minutes past the epoch, so `SCOPED_DUE_AT`
   * sits strictly beneath it and every REAL row in the shared table sits decades
   * above it.
   */
  const SCOPED_NOW = new Date(120_000);
  const SCOPED_DUE_AT = new Date(0);

  /** Make exactly these rows due at `SCOPED_NOW`, and nothing else in the table. */
  async function scopeToThisFile(ids: string[]): Promise<void> {
    await db
      .update(moderationOutboxes)
      .set({ availableAt: SCOPED_DUE_AT })
      .where(inArray(moderationOutboxes.id, ids));
  }

  /**
   * A sibling-shaped row: `pending`, due at REAL time, with a `created_at` older
   * than anything this file enqueues — exactly what an expiry-sweep fixture or
   * the webhook file's `decision.apply` row looks like from here, except
   * deterministic. An UNSCOPED claim at real time takes this row first, because
   * the claim orders by `created_at`; the scoped claims below must never see it.
   * This is the race of #151, pinned, instead of waited for.
   */
  async function seedSiblingShapedRow(name: string): Promise<string> {
    const id = `sibling-${name}-${RUN}`;
    createdOutboxIds.push(id);
    await db.insert(moderationOutboxes).values({
      id,
      kind: 'report.submit',
      payload: { reportId: `sibling-${RUN}` },
      status: 'pending',
      attempts: 0,
      availableAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return id;
  }

  it('a claim leases the row and a second claim finds nothing', async () => {
    const id = outboxId('claim');
    await enqueue(id, 'r7');

    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'owner-a', eventId: id });
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);

    expect(await claimModerationOutboxEvent({ leaseOwner: 'owner-b', eventId: id })).toBeNull();
  });

  it('two CONCURRENT claims of ONE due row yield exactly one winner', async () => {
    const id = outboxId('race-one');
    await enqueue(id, 'r8');

    // Genuinely concurrent: two statements in flight on two pool connections. A
    // sequential pair would pass against a broken claim too, because the second
    // call would simply see a live lease.
    const [first, second] = await Promise.all([
      claimModerationOutboxEvent({ leaseOwner: 'owner-a', eventId: id }),
      claimModerationOutboxEvent({ leaseOwner: 'owner-b', eventId: id }),
    ]);

    const winners = [first, second].filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    // And the row counted the attempt exactly once, so a loser did not also
    // increment on its way to returning nothing.
    expect((await findModerationOutboxEvent(id))?.attempts).toBe(1);
  });

  it('two CONCURRENT claims of TWO due rows take one EACH', async () => {
    /**
     * Both dispatchers make progress and neither takes the other's row.
     *
     * **Honest limit, measured rather than assumed:** this does NOT discriminate
     * `SKIP LOCKED`. Removing `skip locked` from the claim leaves it green, and
     * the reason is a real property of the plan rather than luck — `LockRows` sits
     * BELOW `Limit`, so when the loser's `EvalPlanQual` recheck rejects the row the
     * winner just changed, the node simply yields the NEXT row and `LIMIT 1` takes
     * it. Correctness survives; only the WAIT is different. So this is kept as a
     * cheap guard against a claim that hands two dispatchers the same row, and the
     * test below is the one that actually pins the skip.
     */
    const sibling = await seedSiblingShapedRow('race-two');
    const first = outboxId('race-two-a');
    const second = outboxId('race-two-b');
    await enqueue(first, 'r9');
    await enqueue(second, 'r10');
    await scopeToThisFile([first, second]);

    const [a, b] = await Promise.all([
      claimModerationOutboxEvent({ leaseOwner: 'owner-a', now: SCOPED_NOW }),
      claimModerationOutboxEvent({ leaseOwner: 'owner-b', now: SCOPED_NOW }),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
    expect([a?.id, b?.id].sort()).toEqual([first, second].sort());
    // And the sibling's row was not perturbed on the way past — an unscoped
    // claim leasing it would bump the attempt count its own file asserts on.
    expect((await findModerationOutboxEvent(sibling))?.attempts).toBe(0);
  });

  it('a claim SKIPS a row another transaction is HOLDING rather than waiting for it', async () => {
    /**
     * The assertion that tells `SKIP LOCKED` from a plain `FOR UPDATE`.
     *
     * A concurrent pair cannot do it (see the test above): the loser recovers and
     * takes the free row either way, so the only observable difference is that it
     * WAITED. Here the oldest row is locked by a transaction that will not commit
     * until the claim has returned, so waiting is not survivable — with
     * `SKIP LOCKED` the claim steps over it and takes the free row immediately;
     * without, it blocks on a lock nobody is going to release and dies on the
     * `statement_timeout`.
     *
     * The timeout is what keeps the failure a RED rather than a hung suite, and
     * the `finally` is what stops a red from leaving the holder's lock open and
     * blocking teardown. Verified by mutation: deleting `skip locked` fails this
     * test with `57014 canceling statement due to statement timeout`.
     */
    const sibling = await seedSiblingShapedRow('skip-held');
    const first = outboxId('skip-held');
    const second = outboxId('skip-free');
    await enqueue(first, 'r13');
    await enqueue(second, 'r14');
    await scopeToThisFile([first, second]);

    let announceHeld: () => void = () => undefined;
    let releaseHolder: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      announceHeld = resolve;
    });

    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${moderationOutboxes.id} from ${moderationOutboxes}
            where ${moderationOutboxes.id} = ${first} for update`,
      );
      announceHeld();
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });
    await held;

    try {
      const claimed = await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '1000ms'`);
        return await claimModerationOutboxEvent({ leaseOwner: 'skipper', now: SCOPED_NOW }, tx);
      });
      expect(claimed?.id).toBe(second);
    } finally {
      releaseHolder();
      await holder;
    }

    expect((await findModerationOutboxEvent(sibling))?.attempts).toBe(0);
  });

  it('an EXPIRED processing lease is reclaimable, so a dead task strands nothing', async () => {
    const id = outboxId('expired');
    await enqueue(id, 'r11');

    const held = await claimModerationOutboxEvent({
      leaseOwner: 'dead-task',
      eventId: id,
      leaseMs: 1_000,
    });
    expect(held?.id).toBe(id);

    const later = new Date(Date.now() + 5_000);
    const reclaimed = await claimModerationOutboxEvent({
      leaseOwner: 'live-task',
      eventId: id,
      now: later,
    });
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.leaseOwner).toBe('live-task');
    // The attempt count carries across the reclaim; that is what the retryable
    // ceiling counts, so a row reclaimed forever still eventually dead-letters.
    expect(reclaimed?.attempts).toBe(2);
  });

  it('complete, renew and release all REFUSE a lease this owner no longer holds', async () => {
    const id = outboxId('owner-check');
    await enqueue(id, 'r12');

    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'owner-a', eventId: id });
    expect(claimed?.id).toBe(id);

    // The owner check is what stops a task whose lease was reclaimed from writing
    // a contradictory outcome over the task that now owns the row.
    expect(await completeModerationOutboxEvent(id, 'owner-b')).toBe(false);
    expect(await renewModerationOutboxEvent(id, 'owner-b', 60_000)).toBe(false);
    expect(
      await releaseModerationOutboxEvent({
        eventId: id,
        leaseOwner: 'owner-b',
        deadLettered: false,
        availableAt: new Date(),
        error: 'not mine',
      }),
    ).toBe(false);

    // The vacuity guard: the REAL owner still can, so the refusals above are the
    // owner check and not a transition that never works.
    expect(await renewModerationOutboxEvent(id, 'owner-a', 60_000)).toBe(true);
    expect(await completeModerationOutboxEvent(id, 'owner-a')).toBe(true);
    expect((await findModerationOutboxEvent(id))?.leaseOwner).toBeUndefined();
  });
});

describe('createAbuseReport against a real database', () => {
  it('commits the report AND its outbox row together', async () => {
    const listingId = uuidv7();

    const result = await createAbuseReport({
      reporterOxyUserId: `reporter-1-${RUN}`,
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['counterfeit'],
      details: 'Obvious fake.',
    });
    trackReport(result.report.id);

    const stored = await findAbuseReportById(result.report.id);
    expect(stored?.localStatus).toBe('queued');

    const outbox = await findModerationOutboxEvent(reportSubmitEventId(result.report.id));
    expect(outbox).toBeDefined();
    expect(outbox?.payload.reportId).toBe(result.report.id);
  });

  it('a failure AFTER the report insert leaves no report row and no outbox row', async () => {
    /**
     * The atomicity assertion, and the reason both repositories take a
     * `DatabaseOrTransaction` rather than reaching for `getDb()` themselves.
     *
     * A repository that ignored the handle it was passed would commit its row on
     * its own connection and SURVIVE this rollback — which is precisely the
     * "answered 201, never delivered" failure, and precisely what no mocked test
     * can see. Composed here rather than driven through `createAbuseReport`
     * because the service has no reachable failure between its two writes, and a
     * property this important should not be pinned only where a bug is convenient
     * to inject.
     */
    const listingId = uuidv7();
    const reporter = `reporter-atomic-${RUN}`;
    let reportId = '';
    let eventId = '';

    await expect(
      db.transaction(async (tx) => {
        const report = await insertAbuseReport(
          {
            reportedType: 'listing',
            reportedId: listingId,
            reporterOxyUserId: reporter,
            categories: ['counterfeit'],
            localStatus: 'queued',
          },
          tx,
        );
        reportId = report.id;
        eventId = reportSubmitEventId(report.id);
        await enqueueModerationOutboxEvent(
          { eventId, kind: 'report.submit', payload: { reportId: report.id } },
          tx,
        );
        throw new Error('delivery bookkeeping failed after both writes');
      }),
    ).rejects.toThrow(/delivery bookkeeping failed/);

    expect(reportId).not.toBe('');
    expect(await findAbuseReportById(reportId)).toBeUndefined();
    expect(await findModerationOutboxEvent(eventId)).toBeUndefined();
  });

  it('stores a type with no provider and writes NO outbox row', async () => {
    const result = await createAbuseReport({
      reporterOxyUserId: `reporter-2-${RUN}`,
      reportedType: 'seller',
      reportedId: `some-oxy-user-${RUN}`,
      categories: ['scam'],
    });
    trackReport(result.report.id);

    expect(result.outboxEventId).toBeUndefined();
    expect(await findModerationOutboxEvent(reportSubmitEventId(result.report.id))).toBeUndefined();

    const stored = await findAbuseReportById(result.report.id);
    expect(stored?.localStatus).toBe('received');
    expect(stored?.localStatusReason).toMatch(/no moderation subject provider/i);
  });

  it('the unique index — not just the read — stops a duplicate report', async () => {
    const listingId = uuidv7();
    const args = {
      reporterOxyUserId: `reporter-3-${RUN}`,
      reportedType: 'listing' as const,
      reportedId: listingId,
      categories: ['counterfeit' as const],
    };

    const first = await createAbuseReport(args);
    trackReport(first.report.id);

    await expect(createAbuseReport(args)).rejects.toThrow(/already reported/i);

    const rows = await db
      .select({ id: abuseReports.id })
      .from(abuseReports)
      .where(eq(abuseReports.reporterOxyUserId, args.reporterOxyUserId));
    expect(rows).toHaveLength(1);
  });

  it('two CONCURRENT duplicate submissions produce ONE report and ONE conflict', async () => {
    /**
     * The race the read-first check cannot win, and the reason the unique
     * violation is mapped back onto the same 409. Both reads miss; the index
     * refuses the loser; the loser's reporter must see the same answer the
     * sequential case gives, not a 500 for double-tapping.
     */
    const args = {
      reporterOxyUserId: `reporter-race-${RUN}`,
      reportedType: 'listing' as const,
      reportedId: uuidv7(),
      categories: ['counterfeit' as const],
    };

    const outcomes = await Promise.allSettled([
      createAbuseReport(args),
      createAbuseReport(args),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') trackReport(outcome.value.report.id);
    }

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    for (const outcome of rejected) {
      if (outcome.status === 'rejected') {
        expect(String((outcome.reason as Error).message)).toMatch(/already reported/i);
      }
    }

    const rows = await db
      .select({ id: abuseReports.id })
      .from(abuseReports)
      .where(eq(abuseReports.reporterOxyUserId, args.reporterOxyUserId));
    expect(rows).toHaveLength(1);
  });

  it('a DIFFERENT reporter may report the same listing — one case, many reports', async () => {
    const listingId = uuidv7();
    const first = await createAbuseReport({
      reporterOxyUserId: `reporter-4a-${RUN}`,
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['counterfeit'],
    });
    const second = await createAbuseReport({
      reporterOxyUserId: `reporter-4b-${RUN}`,
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['misleading_listing'],
    });
    trackReport(first.report.id);
    trackReport(second.report.id);

    // Two reports, two outbox rows, one subject — CrowdSource's dedup key is what
    // collapses them into a single case, and it can only do that if both arrive.
    const reports = await db
      .select({ id: abuseReports.id })
      .from(abuseReports)
      .where(eq(abuseReports.reportedId, listingId));
    expect(reports).toHaveLength(2);

    expect(await findModerationOutboxEvent(reportSubmitEventId(first.report.id))).toBeDefined();
    expect(await findModerationOutboxEvent(reportSubmitEventId(second.report.id))).toBeDefined();
  });
});

describe('the composed report is byte-identical between deliveries', () => {
  /** One user-owned listing, registered for teardown. */
  async function seedListing(): Promise<string> {
    const row = await insertListing(
      {
        ownerType: 'user',
        oxyUserId: `seller-${RUN}`,
        storeId: null,
        productTypeDefinitionId: null,
        title: 'A reported item',
        description: 'Body text',
        condition: 'new',
        conditionAssertion: 'seller_declared',
        conditionSourceLabel: null,
        conditionAcknowledgedAt: null,
        status: 'active',
        categoryId: null,
        categorySlugs: [],
        tags: ['handmade'],
        priceRangeMinAmount: 1000,
        priceRangeMinCurrency: 'FAIR',
        priceRangeMaxAmount: 1000,
        priceRangeMaxCurrency: 'FAIR',
        hasInventory: true,
        variantCount: 1,
        longitude: null,
        latitude: null,
        vendor: null,
        productType: null,
        handle: null,
        seoTitle: null,
        seoDescription: null,
        sourceConnectionId: null,
        sourceProvider: null,
        sourceExternalId: null,
        sourceExternalUpdatedAt: null,
        overriddenFields: [],
        rating: 0,
        reviewCount: 0,
        favoriteCount: 0,
        publishedAt: new Date(),
      },
      [],
      [],
    );
    createdListingIds.push(row.id);
    return row.id;
  }

  it('two builds of ONE report serialize identically, minutes apart', async () => {
    /**
     * The rule that makes at-least-once delivery safe, asserted rather than
     * reviewed.
     *
     * CrowdSource's ingress fingerprints the whole `{externalReportId, envelope}`
     * to detect an external id reused with DIFFERENT content, and answers 409 when
     * it changes. That 409 is not retryable — no number of attempts turns two
     * payloads into one report — so anything non-deterministic in the composition
     * converts a perfectly legitimate outbox retry into a permanent dead letter,
     * days later, with nothing having failed in any test.
     *
     * A `new Date()` anywhere in the composed input is the whole class of bug, and
     * the sleep is what makes it observable: two builds in the same millisecond
     * would agree even with a wall-clock field in them.
     */
    const listingId = await seedListing();
    const created = await createAbuseReport({
      reporterOxyUserId: `reporter-deterministic-${RUN}`,
      reportedType: 'listing',
      reportedId: listingId,
      // Two categories mapping to two DIFFERENT codes, so the sorted-and-deduped
      // allegation list is genuinely exercised rather than trivially one element.
      categories: ['misleading_listing', 'counterfeit'],
      details: 'Obvious fake.',
    });
    trackReport(created.report.id);

    const first = await buildReportInput(created.report);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await buildReportInput(created.report);

    expect(JSON.stringify(second.input)).toBe(JSON.stringify(first.input));
    // The snapshot hash is the same claim one level down: same material in, same
    // digest out, so a decision stays attributable to the version reviewed.
    expect(second.snapshotHash).toBe(first.snapshotHash);
  });

  it('submittedAt is the REPORT’s createdAt, never the moment of delivery', async () => {
    /**
     * The specific field the module comment names, pinned against the row rather
     * than against "some earlier time" — an assertion that only checked
     * `submittedAt < now` would pass against a `new Date()` from the previous
     * statement.
     */
    const listingId = await seedListing();
    const created = await createAbuseReport({
      reporterOxyUserId: `reporter-submitted-at-${RUN}`,
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['counterfeit'],
    });
    trackReport(created.report.id);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const built = await buildReportInput(created.report);

    expect(built.input.submittedAt).toEqual(created.report.createdAt);
    // And the external id is the row's own id verbatim — it is half of
    // CrowdSource's idempotency key, which is why ids were carried across the
    // migration rather than remapped.
    expect(built.input.externalReportId).toBe(created.report.id);
  });

  it('the allegation list is sorted and deduped, whatever order the shopper ticked', async () => {
    /**
     * Two categories that mean the SAME baseline claim collapse to one allegation
     * — a shopper ticking both must not appear to allege it twice — and the order
     * is the sort's, not the request's.
     */
    const listingId = await seedListing();
    const created = await createAbuseReport({
      reporterOxyUserId: `reporter-allegations-${RUN}`,
      reportedType: 'listing',
      reportedId: listingId,
      // `stolen_goods` and `prohibited_item` both map to `commerce.prohibited_item`.
      categories: ['stolen_goods', 'counterfeit', 'prohibited_item'],
    });
    trackReport(created.report.id);

    const built = await buildReportInput(created.report);
    const codes = built.input.allegations.map((allegation) =>
      typeof allegation === 'string' ? allegation : allegation.code,
    );
    expect(codes).toEqual(['commerce.counterfeit', 'commerce.prohibited_item']);
  });
});

describe('the enforcement idempotency key is a real unique index', () => {
  it('refuses a second claim of the same decisionId + revision + action', async () => {
    const decision = decisionId('dec-replay');
    const base = {
      decisionId: decision,
      revision: 1,
      action: 'restrict' as const,
      subjectType: 'listing' as const,
      subjectId: uuidv7(),
      reason: 'first',
    };

    const first = await claimModerationEnforcement(base);
    expect(first).not.toBeNull();

    // `null`, not a throw: a duplicate is an ANSWER, and telling it apart from a
    // database failure by inspecting an exception is what the port removed.
    const second = await claimModerationEnforcement({ ...base, reason: 'second' });
    expect(second).toBeNull();

    const rows = await db
      .select({ id: moderationEnforcements.id })
      .from(moderationEnforcements)
      .where(eq(moderationEnforcements.decisionId, decision));
    expect(rows).toHaveLength(1);
  });

  it('PERMITS a later revision to claim its own restore', async () => {
    /**
     * Why `revision` is in the key, and the half that actually discriminates: a
     * key of `(decision_id, action)` passes the replay test above and FAILS this
     * one. A correction is a new revision, and its `restore` must be a different
     * action from the `restrict` it supersedes — otherwise an accepted appeal
     * loses the insert, does nothing, and the listing stays down forever with the
     * case saying it was fine.
     */
    const decision = decisionId('dec-correction');
    const base = {
      decisionId: decision,
      subjectType: 'listing' as const,
      subjectId: uuidv7(),
      reason: 'r',
    };

    expect(await claimModerationEnforcement({ ...base, revision: 1, action: 'restrict' })).not.toBeNull();
    expect(await claimModerationEnforcement({ ...base, revision: 2, action: 'restore' })).not.toBeNull();
    // And the same action at a LATER revision is also its own claim — a second
    // correction re-restricting after an appeal was itself overturned.
    expect(await claimModerationEnforcement({ ...base, revision: 3, action: 'restrict' })).not.toBeNull();

    const rows = await db
      .select({ id: moderationEnforcements.id })
      .from(moderationEnforcements)
      .where(eq(moderationEnforcements.decisionId, decision));
    expect(rows).toHaveLength(3);
  });
});
