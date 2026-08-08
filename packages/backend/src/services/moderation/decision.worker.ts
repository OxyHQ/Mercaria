/**
 * Applying one inbound decision.
 *
 * Runs from the outbox dispatcher, NOT from the webhook handler. The webhook must
 * answer fast and must not do enforcement inline: a slow handler makes CrowdSource
 * retry a delivery it already made, and an enforcement failure mid-handler would
 * leave the delivery unacknowledged with half its actions applied.
 *
 * So the receiver's only job is to verify the signature and durably record the
 * event; this is what turns it into effects, with the outbox's retry and
 * dead-letter behaviour around it.
 *
 * ## Which object a decision is about
 *
 * The decision names a CASE, not a Mercaria noun — CrowdSource has no idea what a
 * listing is. The local report is the join: it holds `crowdSourceCaseId` alongside
 * the `reportedType`/`reportedId` that opened the case, so the subject is resolved
 * from Mercaria's OWN row rather than from anything in the payload. That matters
 * for more than convenience: taking a subject id off the wire would let a
 * compromised or buggy sender direct enforcement at any listing in the catalogue.
 */

import { DecisionSchema } from '@oxyhq/crowdsource-contracts';
import {
  findOldestAbuseReportForCase,
  markAbuseReportsDecided,
} from '../../db/moderation/abuseReportRepository.js';
import type { ModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository.js';
import { log } from '../../lib/logger.js';
import { enforceDecision, type EnforcementSubject } from './enforcement.service.js';

/** Raised when the queued event is not a decision this version understands. */
class UnusableDecisionEventError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'UnusableDecisionEventError';
  }
}

/**
 * Raised when no local report matches the case.
 *
 * RETRYABLE, unlike the other failures here, and the distinction is deliberate. A
 * decision can legitimately arrive before the delivery response that recorded the
 * case id has been written — the two race — so the safe reading of "no report for
 * this case" is "not yet", not "never". The outbox's backoff and its eventual
 * dead-letter handle the case where it really never arrives.
 */
class UnmatchedCaseError extends Error {
  readonly retryable = true;

  constructor(caseId: string) {
    super(`No local report is associated with CrowdSource case '${caseId}'.`);
    this.name = 'UnmatchedCaseError';
  }
}

export async function applyDecisionEvent(event: ModerationOutboxEvent): Promise<void> {
  const raw = event.payload.event;
  if (raw === undefined) {
    throw new UnusableDecisionEventError('Decision outbox row carried no event payload.');
  }

  /**
   * Parsed with the CONTRACT's schema rather than trusted.
   *
   * The webhook receiver verified the signature, which proves the bytes came from
   * CrowdSource — it does not prove they are a shape this code can act on. A newer
   * server may send a decision with fields this version has never seen, and the
   * parse is what turns that into an explicit refusal instead of an enforcement
   * driven by `undefined`.
   */
  const parsed = DecisionSchema.safeParse(
    (raw as { data?: { decision?: unknown } }).data?.decision,
  );
  if (!parsed.success) {
    throw new UnusableDecisionEventError(
      `Decision payload did not match the contract: ${parsed.error.message}`,
    );
  }
  const decision = parsed.data;

  const report = await findOldestAbuseReportForCase(decision.caseId);
  if (!report) throw new UnmatchedCaseError(decision.caseId);

  const subject: EnforcementSubject = {
    type: report.reportedType,
    id: report.reportedId,
  };

  const outcomes = await enforceDecision(decision, subject);

  /**
   * Every report about this object learns the outcome, not just the one that
   * opened the case.
   *
   * Several shoppers reporting one counterfeit listing all get their reports
   * resolved by the single decision that answered them — which is the whole point
   * of one case per incident. Marking only the first would leave the rest looking
   * permanently unanswered.
   */
  await markAbuseReportsDecided(report.reportedType, report.reportedId, new Date());

  log.moderation.info(
    {
      caseId: decision.caseId,
      decisionId: decision.id,
      revision: decision.revision,
      outcome: decision.outcome,
      subjectType: subject.type,
      subjectId: subject.id,
      outcomes: outcomes.map((entry) => `${entry.action}:${entry.result}`),
    },
    '[Moderation] decision applied',
  );
}
