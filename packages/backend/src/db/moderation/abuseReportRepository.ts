/**
 * `abuse_reports` — a user telling Mercaria that something is wrong.
 *
 * Nothing to do with `report.service.ts` or `/admin/stores/:storeId/reports/*`,
 * which are the store SALES ANALYTICS surface and share only the English word.
 *
 * ## The duplicate check is a read AND an index, and only one of them holds
 *
 * `findAbuseReportByReporterAndObject` exists so intake can answer a reporter with
 * a friendly 409 instead of a driver error. It does NOT make the report unique:
 * two taps on a report button race, both reads miss, and
 * `abuse_reports_reporter_reported_key` is what refuses the loser. Intake maps
 * that refusal onto the same 409, so the racing case and the sequential case are
 * indistinguishable to the client — which is the only reason the read is worth
 * keeping at all.
 *
 * ## Absent optionals are `undefined`, never `null`
 *
 * A field Mongo left ABSENT is `NULL` here. Every consumer of these records —
 * `report-delivery.worker`'s `crowdSourceReportId !== undefined` check,
 * `evidence-snapshot.service`'s `details === undefined` branch — was written
 * against `undefined`, so the normalization happens once, at this edge, rather
 * than as a `?? undefined` at each reader that would be easy to forget at the one
 * that matters.
 */

import { and, asc, eq } from 'drizzle-orm';
import type {
  AbuseReportCategory,
  AbuseReportLocalStatus,
  AbuseReportedType,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { abuseReports } from '../schema/moderation.js';

/** The unique index that actually stops a duplicate report. */
export const ABUSE_REPORT_DUPLICATE_CONSTRAINT = 'abuse_reports_reporter_reported_key';

/** Bound on the operator-facing explanation — `abuse_reports_local_status_reason_length_check`. */
const MAX_REASON_LENGTH = 300;

/** One stored report, with absent optionals as `undefined`. */
export interface AbuseReportRecord {
  id: string;
  reportedType: AbuseReportedType;
  reportedId: string;
  reporterOxyUserId: string;
  categories: AbuseReportCategory[];
  details?: string;
  localStatus: AbuseReportLocalStatus;
  localStatusReason?: string;
  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  snapshotHash?: string;
  deliveredAt?: Date;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

type AbuseReportRow = typeof abuseReports.$inferSelect;

/**
 * `categories` is a bare `text[]` in the schema, so drizzle infers `string[]`.
 *
 * The CHECK constraint `abuse_reports_categories_check` is what makes every stored
 * element a real category, and it is rendered from the same
 * `ABUSE_REPORT_CATEGORIES` tuple the type comes from — so the narrowing here
 * restates a database guarantee rather than trusting the caller. It stays a
 * function so the one place that does it is greppable.
 */
function toCategories(values: string[]): AbuseReportCategory[] {
  return values as AbuseReportCategory[];
}

function toRecord(row: AbuseReportRow): AbuseReportRecord {
  return {
    id: row.id,
    reportedType: row.reportedType,
    reportedId: row.reportedId,
    reporterOxyUserId: row.reporterOxyUserId,
    categories: toCategories(row.categories),
    ...(row.details === null ? {} : { details: row.details }),
    localStatus: row.localStatus,
    ...(row.localStatusReason === null ? {} : { localStatusReason: row.localStatusReason }),
    ...(row.crowdSourceReportId === null ? {} : { crowdSourceReportId: row.crowdSourceReportId }),
    ...(row.crowdSourceCaseId === null ? {} : { crowdSourceCaseId: row.crowdSourceCaseId }),
    ...(row.snapshotHash === null ? {} : { snapshotHash: row.snapshotHash }),
    ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The report this reporter already filed about this object, if any. */
export async function findAbuseReportByReporterAndObject(
  reporterOxyUserId: string,
  reportedType: AbuseReportedType,
  reportedId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AbuseReportRecord | undefined> {
  const [row] = await db
    .select()
    .from(abuseReports)
    .where(
      and(
        eq(abuseReports.reporterOxyUserId, reporterOxyUserId),
        eq(abuseReports.reportedType, reportedType),
        eq(abuseReports.reportedId, reportedId),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : undefined;
}

/** Store a new report. */
export async function insertAbuseReport(
  input: {
    reportedType: AbuseReportedType;
    reportedId: string;
    reporterOxyUserId: string;
    categories: readonly AbuseReportCategory[];
    details?: string;
    localStatus: AbuseReportLocalStatus;
    localStatusReason?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<AbuseReportRecord> {
  const [row] = await db
    .insert(abuseReports)
    .values({
      reportedType: input.reportedType,
      reportedId: input.reportedId,
      reporterOxyUserId: input.reporterOxyUserId,
      categories: [...input.categories],
      details: input.details ?? null,
      localStatus: input.localStatus,
      localStatusReason: input.localStatusReason ?? null,
    })
    .returning();
  return toRecord(row);
}

/** One report by id. */
export async function findAbuseReportById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AbuseReportRecord | undefined> {
  const [row] = await db.select().from(abuseReports).where(eq(abuseReports.id, id)).limit(1);
  return row ? toRecord(row) : undefined;
}

/** Record a successful delivery and what CrowdSource gave back. */
export async function markAbuseReportDelivered(
  id: string,
  receipt: {
    crowdSourceReportId: string;
    crowdSourceCaseId: string;
    snapshotHash: string;
    deliveredAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(abuseReports)
    .set({
      localStatus: 'delivered',
      crowdSourceReportId: receipt.crowdSourceReportId,
      crowdSourceCaseId: receipt.crowdSourceCaseId,
      snapshotHash: receipt.snapshotHash,
      deliveredAt: receipt.deliveredAt,
      // Cleared to NULL, never `''`: an empty string is a VALUE, and a reason
      // nobody wrote must read as absent rather than as a blank explanation.
      localStatusReason: null,
    })
    .where(eq(abuseReports.id, id));
}

/**
 * Record that a report can never be delivered, and why.
 *
 * Truncated HERE rather than relying on the CHECK to catch it: the reason is
 * composed from an error message, which is the one string on this table nothing
 * else bounds. The CHECK stays as the backstop for a future writer that forgets.
 */
export async function markAbuseReportUndeliverable(
  id: string,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(abuseReports)
    .set({ localStatus: 'delivery_failed', localStatusReason: reason.slice(0, MAX_REASON_LENGTH) })
    .where(eq(abuseReports.id, id));
}

/**
 * The report that opened a case — the OLDEST one carrying its id.
 *
 * A decision names a CASE, never a Mercaria noun, so this is the join that
 * resolves which object it is about. Oldest first because that is the report whose
 * subject actually opened the case; a later report merged into it describes the
 * same object anyway, but the ordering makes the answer deterministic rather than
 * dependent on which row Postgres happened to return.
 */
export async function findOldestAbuseReportForCase(
  caseId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AbuseReportRecord | undefined> {
  const [row] = await db
    .select()
    .from(abuseReports)
    .where(eq(abuseReports.crowdSourceCaseId, caseId))
    .orderBy(asc(abuseReports.createdAt), asc(abuseReports.id))
    .limit(1);
  return row ? toRecord(row) : undefined;
}

/**
 * Mark EVERY report about one object decided.
 *
 * Several shoppers reporting one counterfeit listing are all answered by the
 * single decision that resolved them — which is the whole point of one case per
 * incident. Marking only the report that opened the case would leave the rest
 * looking permanently unanswered.
 *
 * @returns How many reports learned the outcome.
 */
export async function markAbuseReportsDecided(
  reportedType: AbuseReportedType,
  reportedId: string,
  decidedAt: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(abuseReports)
    .set({ localStatus: 'decided', decidedAt })
    .where(
      and(eq(abuseReports.reportedType, reportedType), eq(abuseReports.reportedId, reportedId)),
    )
    .returning({ id: abuseReports.id });
  return rows.length;
}
