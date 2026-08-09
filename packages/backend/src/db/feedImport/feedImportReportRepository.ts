/**
 * Reads and writes for `feed_import_reports`, `feed_import_report_entries` and
 * `feed_uploads` (#63 acceptance 4, Mapping UX 7).
 *
 * ## The counters and the entries are written together, and the CHECK is why
 *
 * `feed_import_reports_intake_total_check` is `scanned = valid + invalid`, so a
 * caller that computed its counters from the entries it managed to write would
 * fail the constraint the moment the entry cap truncated the list — which is
 * exactly the right failure, because it means the numbers and the evidence
 * disagree. The counters therefore come from the stage MANIFEST (which counts
 * every record) and the entries from the stage's bounded issue list, and the
 * report says how many entries it holds so a reader can see the truncation.
 *
 * ## Nothing here deletes a report
 *
 * Retention is `expiryTargets.ts`' job and it deletes on a deadline, which is a
 * policy. A repository function that removed one on request would be a way to
 * make an activation's justification disappear, and
 * `feed_configuration_versions.validated_report_id` is a RESTRICT foreign key
 * precisely so an active version's evidence cannot go without the version.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  FeedCompression,
  FeedImportReportMode,
  FeedIssueSeverity,
  FeedFieldRole,
  FeedRecordIssue,
  FeedRecordIssueCode,
  FeedUploadStatus,
} from '@mercaria/shared-types';
import { FEED_TOKEN_BEARING_ISSUE_CODES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { RETENTION_SECONDS } from '../expiryTargets.js';
import {
  feedImportReportEntries,
  feedImportReports,
  feedUploads,
} from '../schema/feedImport.js';

export type FeedImportReportRow = typeof feedImportReports.$inferSelect;
export type FeedImportReportEntryRow = typeof feedImportReportEntries.$inferSelect;
export type FeedUploadRow = typeof feedUploads.$inferSelect;

export interface RecordFeedReportInput {
  configurationId: string;
  versionId: string;
  mode: FeedImportReportMode;
  scanned: number;
  valid: number;
  invalid: number;
  changed: number;
  unchanged: number;
  matched: number;
  created: number;
  review: number;
  warnings: number;
  enumerationComplete: boolean;
  bytesRead: number;
  durationMs: number;
  failureNote: string | null;
  requestedByOxyUserId: string;
  issues: readonly FeedRecordIssue[];
  now: Date;
}

/**
 * Write one report and its entries, in ONE transaction handle.
 *
 * The caller supplies the handle so a validation report and the activation that
 * cites it commit together — an activation pointing at a report that rolled back
 * is a `validated_report_id` foreign key violation, which is the constraint
 * working and a 500 nobody can act on.
 */
export async function insertFeedImportReport(
  db: DatabaseOrTransaction,
  input: RecordFeedReportInput,
): Promise<FeedImportReportRow> {
  const expiresAt = new Date(input.now.getTime() + RETENTION_SECONDS.feedImportReport * 1_000);
  const [report] = await db
    .insert(feedImportReports)
    .values({
      configurationId: input.configurationId,
      versionId: input.versionId,
      mode: input.mode,
      scanned: input.scanned,
      valid: input.valid,
      invalid: input.invalid,
      changed: input.changed,
      unchanged: input.unchanged,
      matched: input.matched,
      created: input.created,
      review: input.review,
      warnings: input.warnings,
      enumerationComplete: input.enumerationComplete,
      bytesRead: input.bytesRead,
      durationMs: input.durationMs,
      failureNote: input.failureNote,
      requestedByOxyUserId: input.requestedByOxyUserId,
      expiresAt,
    })
    .returning();
  if (!report) throw new Error('feed_import_reports insert returned no row');

  if (input.issues.length > 0) {
    const entryExpiry = new Date(
      input.now.getTime() + RETENTION_SECONDS.feedImportReportEntry * 1_000,
    );
    await db.insert(feedImportReportEntries).values(
      input.issues.map((issue) => ({
        reportId: report.id,
        recordIndex: issue.recordIndex,
        issueCode: issue.code,
        severity: issue.severity,
        role: issue.role ?? null,
        sourceField: issue.sourceField ?? null,
        externalId: issue.externalId ?? null,
        // Belt and braces beside the CHECK: a token on a code outside the
        // permitted three is dropped here rather than raising a 23514 that
        // takes the whole report with it.
        observedToken: permitsToken(issue.code) ? (issue.observedToken ?? null) : null,
        expiresAt: entryExpiry,
      })),
    );
  }

  return report;
}

function permitsToken(code: FeedRecordIssueCode): boolean {
  return FEED_TOKEN_BEARING_ISSUE_CODES.includes(code);
}

export async function findFeedImportReport(
  db: DatabaseOrTransaction,
  reportId: string,
): Promise<FeedImportReportRow | undefined> {
  const [row] = await db
    .select()
    .from(feedImportReports)
    .where(eq(feedImportReports.id, reportId))
    .limit(1);
  return row;
}

export async function listFeedImportReports(
  db: DatabaseOrTransaction,
  configurationId: string,
  limit: number,
): Promise<FeedImportReportRow[]> {
  return db
    .select()
    .from(feedImportReports)
    .where(eq(feedImportReports.configurationId, configurationId))
    .orderBy(desc(feedImportReports.createdAt))
    .limit(limit);
}

/** One report's entries, in FEED order — which is the order a merchant reads. */
export async function listFeedImportReportEntries(
  db: DatabaseOrTransaction,
  reportId: string,
  limit: number,
): Promise<FeedImportReportEntryRow[]> {
  return db
    .select()
    .from(feedImportReportEntries)
    .where(eq(feedImportReportEntries.reportId, reportId))
    .orderBy(feedImportReportEntries.recordIndex)
    .limit(limit);
}

/** How many of each issue code one report holds — the diagnosis read. */
export async function summarizeFeedImportReport(
  db: DatabaseOrTransaction,
  reportId: string,
): Promise<{ issueCode: FeedRecordIssueCode; severity: FeedIssueSeverity; count: number }[]> {
  const rows = await db
    .select({
      issueCode: feedImportReportEntries.issueCode,
      severity: feedImportReportEntries.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(feedImportReportEntries)
    .where(eq(feedImportReportEntries.reportId, reportId))
    .groupBy(feedImportReportEntries.issueCode, feedImportReportEntries.severity);
  return rows;
}

/** The roles a report's entries mention. Used by the mapping UI's hints. */
export async function reportedRoles(
  db: DatabaseOrTransaction,
  reportId: string,
): Promise<FeedFieldRole[]> {
  const rows = await db
    .selectDistinct({ role: feedImportReportEntries.role })
    .from(feedImportReportEntries)
    .where(eq(feedImportReportEntries.reportId, reportId));
  return rows.flatMap((row) => (row.role === null ? [] : [row.role]));
}

export interface InsertFeedUploadInput {
  configurationId: string;
  filename: string;
  byteSize: number;
  contentDigest: string;
  storageKey: string;
  compression: FeedCompression;
  uploadedByOxyUserId: string;
  now: Date;
}

export async function insertFeedUpload(
  db: DatabaseOrTransaction,
  input: InsertFeedUploadInput,
): Promise<FeedUploadRow> {
  const [row] = await db
    .insert(feedUploads)
    .values({
      configurationId: input.configurationId,
      filename: input.filename,
      byteSize: input.byteSize,
      contentDigest: input.contentDigest,
      storageKey: input.storageKey,
      compression: input.compression,
      uploadedByOxyUserId: input.uploadedByOxyUserId,
      expiresAt: new Date(input.now.getTime() + RETENTION_SECONDS.feedUpload * 1_000),
    })
    .returning();
  if (!row) throw new Error('feed_uploads insert returned no row');
  return row;
}

export async function findFeedUpload(
  db: DatabaseOrTransaction,
  uploadId: string,
): Promise<FeedUploadRow | undefined> {
  const [row] = await db.select().from(feedUploads).where(eq(feedUploads.id, uploadId)).limit(1);
  return row;
}

export async function listFeedUploads(
  db: DatabaseOrTransaction,
  configurationId: string,
  limit: number,
): Promise<FeedUploadRow[]> {
  return db
    .select()
    .from(feedUploads)
    .where(eq(feedUploads.configurationId, configurationId))
    .orderBy(desc(feedUploads.createdAt))
    .limit(limit);
}

/**
 * Mark an upload's state.
 *
 * `consumed` carries its timestamp (a CHECK pairs them); `missing` deliberately
 * does not — it is a discovery about the filesystem rather than an event, and
 * dating it would suggest somebody knows when the artefact went.
 */
export async function setFeedUploadStatus(
  db: DatabaseOrTransaction,
  input: { uploadId: string; status: FeedUploadStatus; now: Date },
): Promise<void> {
  await db
    .update(feedUploads)
    .set({
      status: input.status,
      consumedAt: input.status === 'consumed' ? input.now : null,
    })
    .where(and(eq(feedUploads.id, input.uploadId)));
}
