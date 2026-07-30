/**
 * Delivering one stored report to CrowdSource.
 *
 * Runs from the outbox dispatcher, never from a request handler. The reporter was
 * already told their report was received — that is what the 201 meant — so this is
 * allowed to fail and be retried without them ever knowing.
 *
 * Re-delivering the same report is safe: the SDK derives the idempotency key from
 * `externalReportId`, so CrowdSource returns the SAME `reportId` rather than
 * opening a second case. That property is what makes at-least-once delivery
 * acceptable here, and it is also why nothing in the composed payload may vary
 * between attempts — see `evidence-snapshot.service.ts`.
 */

import { AbuseReport, type IAbuseReport } from '../../models/abuse-report.js';
import { log } from '../../lib/logger.js';
import { getCrowdSourceClient } from './crowdsource-client.js';
import {
  buildReportInput,
  ModerationSubjectMissingError,
  ModerationSubjectUnsupportedError,
} from './evidence-snapshot.service.js';
import type { ModerationOutboxEvent } from './moderation-outbox.service.js';

/**
 * Raised when the outbox row names a report that is not there.
 *
 * Not retryable: the row outlived its report, which the intake transaction makes
 * impossible in normal operation, so retrying only spins.
 */
class ReportVanishedError extends Error {
  readonly retryable = false;

  constructor(reportId: string) {
    super(`Moderation outbox row references report '${reportId}', which no longer exists.`);
    this.name = 'ReportVanishedError';
  }
}

/** Raised when the dispatcher runs without a configured client. Retryable. */
class CrowdSourceUnconfiguredError extends Error {
  readonly retryable = true;

  constructor() {
    super('CrowdSource is not configured; the report stays queued for a later attempt.');
    this.name = 'CrowdSourceUnconfiguredError';
  }
}

/**
 * Record that a report can never be delivered, and stop.
 *
 * A deleted listing is the common case and is not an error in any useful sense —
 * a seller took their item down before a jury saw it. The report stays as a local
 * record with the reason on it, and the outbox row dead-letters because the error
 * is marked non-retryable.
 */
async function markUndeliverable(report: IAbuseReport, reason: string): Promise<void> {
  await AbuseReport.updateOne(
    { _id: report._id },
    { $set: { localStatus: 'delivery_failed', localStatusReason: reason.slice(0, 300) } },
  );
}

export async function deliverReport(event: ModerationOutboxEvent): Promise<void> {
  const reportId = event.payload.reportId;
  if (reportId === undefined) {
    throw new ReportVanishedError('(missing reportId in payload)');
  }

  const report = await AbuseReport.findById(reportId).lean<IAbuseReport | null>();
  if (!report) throw new ReportVanishedError(reportId);

  /**
   * Already delivered — a redelivery of a row whose completion did not persist.
   * Nothing to do, and completing the row is the right outcome.
   */
  if (report.crowdSourceReportId !== undefined) return;

  const client = getCrowdSourceClient();
  if (client === undefined) throw new CrowdSourceUnconfiguredError();

  let built;
  try {
    built = await buildReportInput(report);
  } catch (error: unknown) {
    if (
      error instanceof ModerationSubjectMissingError ||
      error instanceof ModerationSubjectUnsupportedError
    ) {
      await markUndeliverable(report, error.message);
    }
    throw error;
  }

  const response = await client.reports.create(built.input);

  await AbuseReport.updateOne(
    { _id: report._id },
    {
      $set: {
        localStatus: 'delivered',
        crowdSourceReportId: response.reportId,
        crowdSourceCaseId: response.caseId,
        snapshotHash: built.snapshotHash,
        deliveredAt: new Date(),
      },
      $unset: { localStatusReason: '' },
    },
  );

  log.moderation.info(
    {
      reportId,
      crowdSourceReportId: response.reportId,
      reportedType: report.reportedType,
    },
    '[Moderation] report delivered',
  );
}
