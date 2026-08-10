/**
 * `support_threads` and `support_messages` (#110 support thread).
 *
 * ## There is no message updater and no message deleter
 *
 * The table is append-only by trigger, so offering one would compile, ship and
 * raise in production. Not offering one is the cheaper guarantee — and the
 * property it protects is what makes a thread usable in a dispute: neither side
 * can edit what they said and neither can remove it.
 *
 * ## Reads go through `publicColumns`
 *
 * `author_oxy_user_id` and `author_grant_id` are registered protected, and the
 * reason is that ONE repository serves both sides: without the filter, the
 * seller's view would carry the buyer's account id and the buyer's would carry
 * the seller's staff account. Neither party is owed the other's identity, and
 * the buyer half is the correlation key #106 spends a column keeping out of a
 * merchant projection.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  SupportMessageAuthorKind,
  SupportRedactionKind,
} from '@mercaria/shared-types';
import { supportMessages, supportThreads } from '../schema/buyerRequests.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** A thread as any reader gets it. */
export interface SupportThreadRow {
  id: string;
  orderId: string;
  returnRequestId: string | null;
  state: 'open' | 'closed';
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const publicMessage = () => publicColumns(supportMessages, PROTECTED_COLUMNS);

/**
 * Get the thread for a subject, creating it if there is none.
 *
 * `ON CONFLICT DO NOTHING` against the two partial uniques plus a read-back, so
 * two people opening the conversation at once end in one thread. The empty
 * `RETURNING` set IS the "somebody got there first" answer.
 */
export async function ensureSupportThread(
  tx: DatabaseOrTransaction,
  subject: { orderId: string; returnRequestId?: string },
): Promise<SupportThreadRow> {
  await tx
    .insert(supportThreads)
    .values({
      orderId: subject.orderId,
      ...(subject.returnRequestId === undefined
        ? {}
        : { returnRequestId: subject.returnRequestId }),
    })
    .onConflictDoNothing();
  const found = await findSupportThread(subject, tx);
  if (!found) {
    // Unreachable through the insert above; a throw rather than a second insert
    // because a missing row here means the partial unique's predicate and this
    // read's predicate disagree, and retrying would loop rather than converge.
    throw new Error(
      `Support thread for order ${subject.orderId} was neither created nor found; the ` +
        'ensure predicate and the unique index predicate disagree.',
    );
  }
  return found;
}

/** The thread for one subject, or `undefined`. */
export async function findSupportThread(
  subject: { orderId: string; returnRequestId?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupportThreadRow | undefined> {
  const [row] = await db
    .select({
      id: supportThreads.id,
      orderId: supportThreads.orderId,
      returnRequestId: supportThreads.returnRequestId,
      state: supportThreads.state,
      closedAt: supportThreads.closedAt,
      createdAt: supportThreads.createdAt,
      updatedAt: supportThreads.updatedAt,
    })
    .from(supportThreads)
    .where(
      and(
        eq(supportThreads.orderId, subject.orderId),
        subject.returnRequestId === undefined
          ? isNull(supportThreads.returnRequestId)
          : eq(supportThreads.returnRequestId, subject.returnRequestId),
      ),
    )
    .limit(1);
  return row;
}

/** One thread by id, or `undefined`. */
export async function findSupportThreadById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupportThreadRow | undefined> {
  const [row] = await db
    .select({
      id: supportThreads.id,
      orderId: supportThreads.orderId,
      returnRequestId: supportThreads.returnRequestId,
      state: supportThreads.state,
      closedAt: supportThreads.closedAt,
      createdAt: supportThreads.createdAt,
      updatedAt: supportThreads.updatedAt,
    })
    .from(supportThreads)
    .where(eq(supportThreads.id, id))
    .limit(1);
  return row;
}

/** Every thread attached to one order, newest first. */
export async function listSupportThreadsForOrder(
  orderId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupportThreadRow[]> {
  return db
    .select({
      id: supportThreads.id,
      orderId: supportThreads.orderId,
      returnRequestId: supportThreads.returnRequestId,
      state: supportThreads.state,
      closedAt: supportThreads.closedAt,
      createdAt: supportThreads.createdAt,
      updatedAt: supportThreads.updatedAt,
    })
    .from(supportThreads)
    .where(eq(supportThreads.orderId, orderId))
    .orderBy(desc(supportThreads.createdAt));
}

/** Append one message. The body is already redacted — see `redaction.ts`. */
export async function insertSupportMessage(
  tx: DatabaseOrTransaction,
  input: {
    threadId: string;
    authorKind: SupportMessageAuthorKind;
    authorOxyUserId?: string;
    authorGrantId?: string;
    body: string;
    redactions: SupportRedactionKind[];
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(supportMessages)
    .values({
      threadId: input.threadId,
      authorKind: input.authorKind,
      ...(input.authorOxyUserId === undefined ? {} : { authorOxyUserId: input.authorOxyUserId }),
      ...(input.authorGrantId === undefined ? {} : { authorGrantId: input.authorGrantId }),
      body: input.body,
      redactions: input.redactions,
    })
    .returning({ id: supportMessages.id });
  if (!row) throw new Error('Support message insert returned no row');
  // A reply reopens the conversation and refreshes the thread's ordering key in
  // one statement. Reopening is deliberate: a closed thread that cannot be
  // reopened only teaches people to open a second one.
  await tx
    .update(supportThreads)
    .set({ state: 'open', closedAt: null, updatedAt: sql`now()` })
    .where(eq(supportThreads.id, input.threadId));
  return row;
}

/** One thread's messages, oldest first, without the protected author columns. */
export async function listSupportMessages(
  threadId: string,
  db: DatabaseOrTransaction = getDb(),
) {
  return db
    .select(publicMessage())
    .from(supportMessages)
    .where(eq(supportMessages.threadId, threadId))
    .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
}

/** A message as a reader gets it — no author identity. */
export type SupportMessageRow = Awaited<ReturnType<typeof listSupportMessages>>[number];

/**
 * Close a thread.
 *
 * Writes two columns on ONE row and reads nothing else, which is #110 support
 * rule 9 ("thread closure does not remove financial or dispute records") held by
 * what the statement cannot reach rather than by a promise: there is no join, no
 * cascade and no second table in it.
 */
export async function closeSupportThread(
  tx: DatabaseOrTransaction,
  id: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .update(supportThreads)
    .set({ state: 'closed', closedAt: now, updatedAt: sql`now()` })
    .where(and(eq(supportThreads.id, id), eq(supportThreads.state, 'open')))
    .returning({ id: supportThreads.id });
  return row !== undefined;
}
