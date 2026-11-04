/**
 * Reads and writes for `feed_upload_sessions` — a direct upload of a feed file
 * from the client to storage (`services/feed-import/upload-session.service.ts`).
 *
 * Every transition is GUARDED by the status it leaves (`fromStatuses`), so two
 * requests racing one session — a client polling while it completes, a retried
 * complete — cannot both move it: the loser's update matches no row and the
 * service re-reads what the winner wrote.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
  FeedCompression,
  FeedUploadSessionFailure,
  FeedUploadSessionStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import { feedUploadSessions } from '../schema/feedImport.js';

export type FeedUploadSessionRow = typeof feedUploadSessions.$inferSelect;

export interface InsertFeedUploadSessionInput {
  configurationId: string;
  filename: string;
  compression: FeedCompression;
  byteSize: number;
  contentDigest: string;
  oxyUploadId: string | null;
  oxyFileId: string | null;
  status: Extract<FeedUploadSessionStatus, 'uploading' | 'proof_required' | 'verifying'>;
  proofOffset: number | null;
  proofLength: number | null;
  openedByOxyUserId: string;
  now: Date;
}

/**
 * Insert a session, or answer `undefined` when another OPEN session already
 * drives the same storage upload (`feed_upload_sessions_open_upload_key`).
 *
 * The empty result set IS the conflict answer (house invariants): the arbiter's
 * `WHERE` predicate is repeated on the `ON CONFLICT`, or Postgres cannot infer
 * the partial index.
 */
export async function insertFeedUploadSession(
  db: DatabaseOrTransaction,
  input: InsertFeedUploadSessionInput,
): Promise<FeedUploadSessionRow | undefined> {
  const [row] = await db
    .insert(feedUploadSessions)
    .values({
      configurationId: input.configurationId,
      filename: input.filename,
      compression: input.compression,
      byteSize: input.byteSize,
      contentDigest: input.contentDigest,
      oxyUploadId: input.oxyUploadId,
      oxyFileId: input.oxyFileId,
      status: input.status,
      proofOffset: input.proofOffset,
      proofLength: input.proofLength,
      openedByOxyUserId: input.openedByOxyUserId,
      expiresAt: new Date(input.now.getTime() + RETENTION_SECONDS.feedUploadSession * 1_000),
    })
    .onConflictDoNothing({
      target: feedUploadSessions.oxyUploadId,
      where: sql`${feedUploadSessions.status} in ('uploading', 'verifying') and ${feedUploadSessions.oxyUploadId} is not null`,
    })
    .returning();
  return row;
}

export async function findFeedUploadSession(
  db: DatabaseOrTransaction,
  sessionId: string,
): Promise<FeedUploadSessionRow | undefined> {
  const [row] = await db
    .select()
    .from(feedUploadSessions)
    .where(eq(feedUploadSessions.id, sessionId))
    .limit(1);
  return row;
}

/** The OPEN session driving one storage upload, if any. */
export async function findOpenFeedUploadSessionByOxyUpload(
  db: DatabaseOrTransaction,
  oxyUploadId: string,
): Promise<FeedUploadSessionRow | undefined> {
  const [row] = await db
    .select()
    .from(feedUploadSessions)
    .where(
      and(
        eq(feedUploadSessions.oxyUploadId, oxyUploadId),
        isNotNull(feedUploadSessions.oxyUploadId),
        inArray(feedUploadSessions.status, [
          'uploading',
          'verifying',
        ] satisfies FeedUploadSessionStatus[]),
      ),
    )
    .limit(1);
  return row;
}

/** What one guarded transition writes. Only the columns a transition may move. */
export interface FeedUploadSessionTransition {
  status: FeedUploadSessionStatus;
  oxyFileId?: string;
  feedUploadId?: string;
  failure?: FeedUploadSessionFailure;
}

/**
 * Move a session out of one of `fromStatuses`. Returns the new row, or
 * `undefined` when the session was no longer in any of them (somebody else
 * moved it first).
 */
export async function transitionFeedUploadSession(
  db: DatabaseOrTransaction,
  input: {
    sessionId: string;
    fromStatuses: readonly FeedUploadSessionStatus[];
    to: FeedUploadSessionTransition;
  },
): Promise<FeedUploadSessionRow | undefined> {
  const [row] = await db
    .update(feedUploadSessions)
    .set({
      status: input.to.status,
      ...(input.to.oxyFileId === undefined ? {} : { oxyFileId: input.to.oxyFileId }),
      ...(input.to.feedUploadId === undefined ? {} : { feedUploadId: input.to.feedUploadId }),
      ...(input.to.failure === undefined ? {} : { failure: input.to.failure }),
    })
    .where(
      and(
        eq(feedUploadSessions.id, input.sessionId),
        inArray(feedUploadSessions.status, [...input.fromStatuses]),
      ),
    )
    .returning();
  return row;
}
