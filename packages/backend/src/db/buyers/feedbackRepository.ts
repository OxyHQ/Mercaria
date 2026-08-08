/**
 * `feedback` — a user's bug report, feature request or note about the product.
 *
 * The table name is SINGULAR, which is the one documented naming exception in
 * `schema/CONVENTIONS.md`: "feedback" is a mass noun, `feedbacks` is not a word,
 * and Mongoose's derived collection name being exactly that is a `pluralize()`
 * artifact rather than a decision to inherit.
 *
 * ## Every read here NAMES `email`, and that is the point
 *
 * `feedback.email` is registered in `db/protectedColumns.ts` — an optional
 * contact address a reporter typed in, on a table an operator surface would read
 * whole. The three reads below are the OWNER's own: every one of them is scoped
 * to `oxy_user_id`, so what comes back is the address the caller themselves
 * supplied, and the DTO has always echoed it. So this module opts in EXPLICITLY,
 * spreading `publicColumns` and then naming the one column it wants back. That
 * reads differently from an ordinary select and stays greppable, which is exactly
 * what the registry asks of a path that needs a protected column — and the
 * protection still stands for the admin surface that does not exist yet.
 *
 * ## `metadata` is three columns, not `jsonb`
 *
 * The TypeScript interface carried an index signature, but the Mongoose SCHEMA
 * declared only `platform`, `appVersion` and `deviceInfo`, and strict mode
 * dropped everything else — so no open-shaped data was ever stored, and the
 * caller narrows to those three. See `feedback.service`, which does the
 * narrowing the schema used to do silently.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { feedback } from '../schema/buyers.js';

/**
 * Every column of `feedback` INCLUDING the protected contact address.
 *
 * The explicit opt-in described in the module header. Adding a column to
 * `PROTECTED_COLUMNS.feedback` without adding it here withholds it from this
 * surface too, which is the fail-closed direction.
 */
const FEEDBACK_COLUMNS = {
  ...publicColumns(feedback, PROTECTED_COLUMNS),
  email: feedback.email,
} as const;

/** One row of `feedback`, contact address included. */
export type FeedbackRecord = SelectedRow<typeof FEEDBACK_COLUMNS>;

/** The columns a caller may set when submitting feedback. */
export interface NewFeedback {
  type: 'bug' | 'feature' | 'improvement' | 'other';
  rating?: number;
  message: string;
  email?: string;
  metadataPlatform?: string;
  metadataAppVersion?: string;
  metadataDeviceInfo?: string;
}

/**
 * Record a submission.
 *
 * `status` is left to the column default (`pending`) rather than passed: the DDL
 * is the authority for it, and nothing but a future review surface ever moves it.
 * Every optional field is written explicitly as NULL-or-value — a field Mongo
 * left ABSENT is NULL here, never `''`.
 */
export async function insertFeedback(
  oxyUserId: string,
  values: NewFeedback,
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedbackRecord> {
  const [row] = await db
    .insert(feedback)
    .values({
      oxyUserId,
      type: values.type,
      rating: values.rating ?? null,
      message: values.message,
      email: values.email ?? null,
      metadataPlatform: values.metadataPlatform ?? null,
      metadataAppVersion: values.metadataAppVersion ?? null,
      metadataDeviceInfo: values.metadataDeviceInfo ?? null,
    })
    .returning(FEEDBACK_COLUMNS);
  return row;
}

/**
 * One submission scoped to its author, or `null` — the scoping IS the
 * authorization.
 */
export async function findFeedback(
  oxyUserId: string,
  feedbackId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<FeedbackRecord | null> {
  const [row] = await db
    .select(FEEDBACK_COLUMNS)
    .from(feedback)
    .where(and(eq(feedback.id, feedbackId), eq(feedback.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

/**
 * A page of the author's own submissions, newest first, plus the total.
 *
 * The `id` tiebreaker is new. Mongo sorted on `createdAt` alone, so two
 * submissions written in the same millisecond had no defined order between
 * queries and an offset pager could show one twice and skip the other. `id` is a
 * uuid v7, whose time component agrees with `createdAt`.
 */
export async function findFeedbackPage(
  oxyUserId: string,
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: FeedbackRecord[]; total: number }> {
  const where = eq(feedback.oxyUserId, oxyUserId);

  const [rows, [totals]] = await Promise.all([
    db
      .select(FEEDBACK_COLUMNS)
      .from(feedback)
      .where(where)
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(feedback).where(where),
  ]);

  return { rows, total: totals?.count ?? 0 };
}
