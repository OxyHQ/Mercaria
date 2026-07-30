/**
 * Storing a report and, when there is somewhere to send it, the promise to deliver
 * it — in ONE operation.
 *
 * This is the only part of the integration a user waits for. A 201 from
 * `POST /reports` means the report row and its outbox row committed together. It
 * does NOT mean CrowdSource accepted anything — CrowdSource may be unreachable,
 * mid-deploy or not yet configured, and the reporter is told their report was
 * received either way, because it was.
 *
 * The transaction is the whole mechanism. Two writes outside one give two failure
 * modes that are both SILENT: a report with no delivery row (the report exists,
 * nothing will ever send it, and nobody finds out until somebody asks why a case
 * never opened) or a delivery row whose report was rolled back (a worker looking
 * up an id that does not exist). Neither surfaces as an error at the moment it
 * happens, which is exactly why this has to be atomic rather than carefully
 * ordered.
 *
 * The one report with NO delivery row is the one whose type has no subject
 * provider, and that is a different claim entirely: not "delivery failed" but
 * "there was never a route out of this application for this kind of object". Those
 * two must not be conflated, which is why they are different `localStatus` values
 * and why the absent route is WRITTEN DOWN as a reason rather than inferred from a
 * missing row months later.
 */

import mongoose, { type ClientSession } from 'mongoose';
import {
  ABUSE_REPORT_CATEGORIES,
  ABUSE_REPORTED_TYPES,
  type AbuseReportCategory,
  type AbuseReportedType,
} from '@mercaria/shared-types';
import { AbuseReport, type IAbuseReport } from '../../models/abuse-report.js';
import { conflict, validationError } from '../../lib/errors/error-codes.js';
import {
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from './moderation-outbox.service.js';
import { subjectProviderFor } from './subjects/registry.js';

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

export interface CreateAbuseReportArgs {
  reporterOxyUserId: string;
  reportedType: AbuseReportedType;
  reportedId: string;
  categories: AbuseReportCategory[];
  details?: string;
}

export interface CreateAbuseReportResult {
  report: IAbuseReport;
  /**
   * The durable delivery row.
   *
   * Absent exactly when the reported type has no subject provider — the report was
   * stored and there is nothing to deliver it, by design rather than by failure.
   */
  outboxEventId?: string;
}

/**
 * Refuses an identifier that is not a string, at the point the QUERY is built.
 *
 * The route validates its body, but a type is erased at runtime and a truthiness
 * check happily passes `{$ne: null}`. Handed that, `findOne` matches an UNRELATED
 * report and this function answers "you already reported this" about somebody
 * else's row — and the insert would then store an operator where an id belongs.
 *
 * The guard lives here rather than at the route because `createAbuseReport` is
 * exported: a queue worker, a backfill script or a future admin path is under no
 * obligation to have passed the route's validation, and a guard that exists at one
 * caller is a guard that holds until the second one arrives.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`createAbuseReport: ${field} must be a non-empty string.`);
  }
  return value;
}

/**
 * Narrows a validated string back to the union.
 *
 * A type PREDICATE rather than a bare `includes` call, because `includes` returns
 * a boolean and leaves the value widened to `string` — which then reaches the
 * Mongoose query as an unnarrowed type and either fails to compile or, with a
 * cast, lets an unvalidated value through. The predicate is what makes the
 * validation and the type agree.
 */
function isReportedType(value: string): value is AbuseReportedType {
  return (ABUSE_REPORTED_TYPES as readonly string[]).includes(value);
}

function isReportCategory(value: string): value is AbuseReportCategory {
  return (ABUSE_REPORT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Why a report is not going anywhere, in words an operator can read.
 *
 * Stored ON the row rather than left to be inferred from a missing outbox row. A
 * missing row is also what a LOST WRITE looks like, and the two need to be
 * distinguishable months later without re-deriving which types had providers at
 * the time. Bounded by the schema's 300-character limit.
 */
function localOnlyReason(reportedType: string): string {
  return (
    `Mercaria has no moderation subject provider for '${reportedType}', so this report ` +
    'is recorded locally and is not sent for community review.'
  );
}

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    }, TRANSACTION_OPTIONS);
    if (result === undefined) {
      throw new Error('Report intake transaction completed without a result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Delivery is queued when — and only when — the reported type has a subject
 * provider. A type without one is stored at `received` with the reason recorded,
 * which is the behaviour the application would have had before CrowdSource
 * existed: the report is a receipt and a local record, and nothing else happens.
 *
 * That branch is precisely why the two writes stay in ONE transaction rather than
 * being ordered carefully. The condition is read BEFORE the transaction body
 * decides anything, so `localStatus` and the presence of an outbox row are decided
 * together from one fact — a report can never commit as `queued` with nothing to
 * deliver it, nor as `received` with a delivery row that will try anyway.
 *
 * Intake deliberately does not read `crowdSource.enabled`. A report taken while
 * the integration is off still gets its delivery row, so switching it on delivers
 * the backlog instead of stranding it — the DISPATCHER is what is gated, not the
 * durable record. Nothing here is conditional on a third party's state; only on
 * whether this application knows how to describe the object at all.
 */
export async function createAbuseReport(
  input: CreateAbuseReportArgs,
): Promise<CreateAbuseReportResult> {
  const reporterOxyUserId = requireIdentifier(input.reporterOxyUserId, 'reporterOxyUserId');
  const reportedId = requireIdentifier(input.reportedId, 'reportedId');
  const reportedTypeInput = requireIdentifier(input.reportedType, 'reportedType');
  if (!isReportedType(reportedTypeInput)) {
    throw validationError(
      `createAbuseReport: reportedType '${reportedTypeInput}' is not a reportable type.`,
    );
  }
  const reportedType: AbuseReportedType = reportedTypeInput;

  if (input.categories.length === 0) {
    throw validationError('createAbuseReport: at least one category is required.');
  }
  for (const category of input.categories) {
    if (typeof category !== 'string' || !isReportCategory(category)) {
      throw validationError(`createAbuseReport: unknown category '${String(category)}'.`);
    }
  }

  const deliverable = subjectProviderFor(reportedType) !== undefined;

  return await inTransaction(async (session) => {
    const existing = await AbuseReport.findOne({
      reporterOxyUserId,
      reportedId,
      reportedType,
    })
      .session(session)
      .lean<IAbuseReport | null>();
    if (existing) {
      throw conflict('You have already reported this item.');
    }

    const [report] = await AbuseReport.create(
      [
        {
          reportedType,
          reportedId,
          reporterOxyUserId,
          categories: input.categories,
          ...(input.details === undefined ? {} : { details: input.details }),
          localStatus: deliverable ? 'queued' : 'received',
          ...(deliverable ? {} : { localStatusReason: localOnlyReason(reportedType) }),
        },
      ],
      { session },
    );

    if (!deliverable) return { report };

    const outboxEventId = await enqueueModerationOutboxEvent(
      {
        eventId: reportSubmitEventId(report._id.toHexString()),
        kind: 'report.submit',
        payload: { reportId: report._id.toHexString() },
      },
      session,
    );

    return { report, outboxEventId };
  });
}
