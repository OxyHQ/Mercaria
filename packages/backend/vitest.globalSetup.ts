import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One MongoDB replica set for the whole suite.
 *
 * A replica SET rather than a standalone, because the two properties the
 * moderation integration rests on only exist there: multi-document transactions
 * (a report and its outbox row commit together, or neither does) and the unique
 * indexes that make enforcement idempotent.
 *
 * ## Why this file exists at all
 *
 * The rest of this suite mocks Mongoose models, which is fine for logic but
 * cannot check the one thing a moderation write must get right: whether the
 * SERVER accepts the update document. A mocked `updateOne` accepts ANY update —
 * including one Mongo rejects outright. That is not weak evidence, it is no
 * evidence, and it looks identical to a passing test.
 *
 * The concrete bug that motivated this: naming `createdAt`/`updatedAt` inside
 * `$setOnInsert` on a schema declaring `{ timestamps: true }` makes Mongoose add
 * the same path under `$set` too, and Mongo rejects the WHOLE write with
 * "Updating the path 'updatedAt' would create a conflict at 'updatedAt'". Inside
 * the intake transaction the abort takes the report row with it, so every single
 * `POST /reports` 500s — while a mocked suite stays green.
 *
 * Tests that need the real server read `MERCARIA_TEST_MONGODB_URI`; the mocked
 * tests are untouched and still run without it.
 */
let replicaSet: MongoMemoryReplSet | null = null;

export async function setup(): Promise<void> {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MERCARIA_TEST_MONGODB_URI = replicaSet.getUri();
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
