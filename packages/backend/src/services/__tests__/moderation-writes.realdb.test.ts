/**
 * The moderation writes, against a REAL MongoDB replica set.
 *
 * Every other moderation test in this suite mocks its models, and that mocking
 * has exactly one blind spot — but it is the one that matters most here: a mocked
 * `updateOne` accepts ANY update document, including one the server rejects
 * outright. A suite built only on mocks stays green while `POST /reports` 500s on
 * the very first report.
 *
 * The concrete bug this file exists to catch: naming `createdAt`/`updatedAt`
 * inside `$setOnInsert` on a schema declaring `{ timestamps: true }`. Mongoose
 * adds `updatedAt` to `$set` itself on an upsert, the path lands in two operators
 * of one update document, and Mongo refuses the whole write —
 * "Updating the path 'updatedAt' would create a conflict at 'updatedAt'". Inside
 * the intake transaction the abort takes the report row with it, so the failure
 * is total and silent. `createdAt` alone is harmless; naming BOTH is fatal.
 *
 * A replica SET rather than a standalone, because transactions and unique indexes
 * are the two properties under test and neither exists without one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

const uri = process.env.MERCARIA_TEST_MONGODB_URI;

let AbuseReport: typeof import('../../models/abuse-report.js').AbuseReport;
let ModerationOutbox: typeof import('../../models/moderation-outbox.js').ModerationOutbox;
let ModerationEnforcement: typeof import('../../models/moderation-enforcement.js').ModerationEnforcement;
let enqueueModerationOutboxEvent: typeof import('../moderation/moderation-outbox.service.js').enqueueModerationOutboxEvent;
let ModerationOutboxTransactionError: typeof import('../moderation/moderation-outbox.service.js').ModerationOutboxTransactionError;
let claimModerationOutboxEvent: typeof import('../moderation/moderation-outbox.service.js').claimModerationOutboxEvent;
let createAbuseReport: typeof import('../moderation/report-intake.service.js').createAbuseReport;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  await mongoose.connect(uri, { dbName: 'mercaria-moderation-test' });

  ({ AbuseReport } = await import('../../models/abuse-report.js'));
  ({ ModerationOutbox } = await import('../../models/moderation-outbox.js'));
  ({ ModerationEnforcement } = await import('../../models/moderation-enforcement.js'));
  ({
    enqueueModerationOutboxEvent,
    ModerationOutboxTransactionError,
    claimModerationOutboxEvent,
  } = await import('../moderation/moderation-outbox.service.js'));
  ({ createAbuseReport } = await import('../moderation/report-intake.service.js'));

  // Unique indexes are half of what is under test; Mongoose builds them lazily.
  await Promise.all([
    AbuseReport.syncIndexes(),
    ModerationOutbox.syncIndexes(),
    ModerationEnforcement.syncIndexes(),
  ]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([
    AbuseReport.deleteMany({}),
    ModerationOutbox.deleteMany({}),
    ModerationEnforcement.deleteMany({}),
  ]);
});

async function inTransaction<T>(fn: (s: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let out: T | undefined;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out as T;
  } finally {
    await session.endSession();
  }
}

describe('the outbox write is ACCEPTED by a real server', () => {
  it('writes the row — no $setOnInsert / timestamps path conflict', async () => {
    /**
     * The assertion that a mock cannot make. If `$setOnInsert` named `createdAt`
     * AND `updatedAt` while the schema declares `{ timestamps: true }`, this
     * throws MongoServerError before writing anything.
     */
    await inTransaction(async (session) => {
      await enqueueModerationOutboxEvent(
        { eventId: 'moderation:report.submit:real-1', kind: 'report.submit', payload: { reportId: 'real-1' } },
        session,
      );
    });

    const row = await ModerationOutbox.findById('moderation:report.submit:real-1').lean();
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');

    // `timestamps: true` populated both, which is why naming them in the update
    // document would have been the bug rather than the fix.
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a retry upserts the SAME row', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await inTransaction(async (session) => {
        await enqueueModerationOutboxEvent(
          { eventId: 'moderation:report.submit:real-2', kind: 'report.submit', payload: { reportId: 'real-2' } },
          session,
        );
      });
    }

    expect(await ModerationOutbox.countDocuments({})).toBe(1);
    // Still claimable once — a retry must not resurrect a processed row either.
    expect(await ModerationOutbox.findById('moderation:report.submit:real-2').lean()).not.toBeNull();
  });

  it('leaves an existing row COMPLETELY untouched on a repeated enqueue', async () => {
    /**
     * "Same row" is not the same claim as "no write happened", and only the
     * second one is what the deterministic event id is for.
     *
     * If the schema lets Mongoose own the timestamps, it adds `$set: {updatedAt}`
     * to the upsert — so a repeat is a genuine WRITE that merely happens to leave
     * the domain fields alone. A repeat is ordinary (a transaction retry, two
     * concurrent duplicate submissions, a reconciliation sweep re-deriving the
     * event), and it runs while the dispatcher is taking, renewing and completing
     * leases on those same rows. A write nobody needed contends with a lease
     * write, and the contention aborts the transaction.
     *
     * `modifiedCount: 0` is the property; `updatedAt` unchanged is its
     * observable edge.
     */
    const eventId = 'moderation:report.submit:real-untouched';
    await inTransaction(async (session) => {
      await enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'real-untouched' } },
        session,
      );
    });

    const before = await ModerationOutbox.findById(eventId).lean();
    expect(before).not.toBeNull();

    // A repeat, far enough later that a bumped timestamp is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await inTransaction(async (session) => {
      await enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'real-untouched' } },
        session,
      );
    });

    const after = await ModerationOutbox.findById(eventId).lean();
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
  });

  it('re-enqueues inside a transaction without conflicting with a live lease', async () => {
    /**
     * The failure the no-op property prevents: a reconciliation-shaped
     * transaction re-deriving an event while the dispatcher holds a lease on that
     * same row. If the repeat writes, the two contend and the transaction can
     * abort with `NoSuchTransaction` — moderation work lost to a sweep that was
     * supposed to be harmless.
     *
     * **Honest limit of this test:** it passed both WITH and WITHOUT the defect on
     * this single-node replica set, so it did not discriminate here and is not the
     * evidence for the fix — the `updatedAt` assertion above is, and that one did
     * fail before the fix and pass after. This is kept as a cheap guard against a
     * hard regression, not offered as proof.
     */
    const eventId = 'moderation:report.submit:real-contended';
    await inTransaction(async (session) => {
      await enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'real-contended' } },
        session,
      );
    });

    // The dispatcher takes the row and is actively working it.
    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'live-dispatcher' });
    expect(claimed?._id).toBe(eventId);

    await expect(
      inTransaction(async (session) => {
        await enqueueModerationOutboxEvent(
          { eventId, kind: 'report.submit', payload: { reportId: 'real-contended' } },
          session,
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('still refuses to write outside a transaction, against the real driver', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        enqueueModerationOutboxEvent(
          { eventId: 'moderation:report.submit:real-3', kind: 'report.submit', payload: { reportId: 'real-3' } },
          session,
        ),
      ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
    } finally {
      await session.endSession();
    }
    expect(await ModerationOutbox.countDocuments({})).toBe(0);
  });

  it('a claim reads the row back and leases it', async () => {
    await inTransaction(async (session) => {
      await enqueueModerationOutboxEvent(
        { eventId: 'moderation:report.submit:real-4', kind: 'report.submit', payload: { reportId: 'real-4' } },
        session,
      );
    });

    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'test-owner' });
    expect(claimed?._id).toBe('moderation:report.submit:real-4');
    expect(claimed?.attempts).toBe(1);

    // A second claim finds nothing: the lease is live and owned.
    expect(await claimModerationOutboxEvent({ leaseOwner: 'other-owner' })).toBeNull();
  });
});

describe('createAbuseReport against a real replica set', () => {
  it('commits the report AND its outbox row together', async () => {
    const listingId = new Types.ObjectId().toHexString();

    const result = await createAbuseReport({
      reporterOxyUserId: 'reporter-1',
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['counterfeit'],
      details: 'Obvious fake.',
    });

    /**
     * The end-to-end proof the mocked test cannot give: both documents are
     * really in the database, written by one transaction the server accepted.
     */
    const stored = await AbuseReport.findById(result.report._id).lean();
    expect(stored?.localStatus).toBe('queued');

    const outbox = await ModerationOutbox.findById(
      `moderation:report.submit:${result.report._id.toHexString()}`,
    ).lean();
    expect(outbox).not.toBeNull();
    expect(outbox?.payload.reportId).toBe(result.report._id.toHexString());
  });

  it('stores a type with no provider and writes NO outbox row', async () => {
    const result = await createAbuseReport({
      reporterOxyUserId: 'reporter-1',
      reportedType: 'seller',
      reportedId: 'some-oxy-user',
      categories: ['scam'],
    });

    expect(result.outboxEventId).toBeUndefined();
    expect(await ModerationOutbox.countDocuments({})).toBe(0);

    const stored = await AbuseReport.findById(result.report._id).lean();
    expect(stored?.localStatus).toBe('received');
    expect(stored?.localStatusReason).toMatch(/no moderation subject provider/i);
  });

  it('the unique index — not just the read — stops a duplicate report', async () => {
    const listingId = new Types.ObjectId().toHexString();
    const args = {
      reporterOxyUserId: 'reporter-1',
      reportedType: 'listing' as const,
      reportedId: listingId,
      categories: ['counterfeit' as const],
    };

    await createAbuseReport(args);
    await expect(createAbuseReport(args)).rejects.toThrow(/already reported/i);
    expect(await AbuseReport.countDocuments({})).toBe(1);
  });

  it('a DIFFERENT reporter may report the same listing — one case, many reports', async () => {
    const listingId = new Types.ObjectId().toHexString();
    await createAbuseReport({
      reporterOxyUserId: 'reporter-1',
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['counterfeit'],
    });
    await createAbuseReport({
      reporterOxyUserId: 'reporter-2',
      reportedType: 'listing',
      reportedId: listingId,
      categories: ['misleading_listing'],
    });

    // Two reports, two outbox rows, one subject — CrowdSource's dedup key is what
    // collapses them into a single case, and it can only do that if both arrive.
    expect(await AbuseReport.countDocuments({})).toBe(2);
    expect(await ModerationOutbox.countDocuments({})).toBe(2);
  });
});

describe('the enforcement idempotency key is a real unique index', () => {
  it('refuses a second claim of the same decisionId+revision+action', async () => {
    const base = {
      decisionId: 'dec_real_1',
      revision: 1,
      action: 'restrict' as const,
      subjectType: 'listing',
      subjectId: new Types.ObjectId().toHexString(),
      applied: true,
      reason: 'first',
    };

    await ModerationEnforcement.create(base);
    await expect(ModerationEnforcement.create({ ...base, reason: 'second' })).rejects.toThrow();
    expect(await ModerationEnforcement.countDocuments({})).toBe(1);
  });

  it('ALLOWS the same action at a different revision', async () => {
    /**
     * Why `revision` is in the key. A correction is a new revision, and its
     * `restore` must be a different action from the `restrict` it supersedes —
     * otherwise an accepted appeal loses the insert and the listing stays down
     * forever, with the case saying it was fine.
     */
    const base = {
      decisionId: 'dec_real_2',
      subjectType: 'listing',
      subjectId: new Types.ObjectId().toHexString(),
      applied: true,
      reason: 'r',
    };

    await ModerationEnforcement.create({ ...base, revision: 1, action: 'restrict' });
    await ModerationEnforcement.create({ ...base, revision: 2, action: 'restore' });
    expect(await ModerationEnforcement.countDocuments({})).toBe(2);
  });
});
