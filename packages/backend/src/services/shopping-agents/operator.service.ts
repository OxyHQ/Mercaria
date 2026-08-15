/**
 * What an operator may see, and the much longer list of what they may not
 * (#97 cost 6, privacy 3).
 *
 * #97 cost rule 6 asks that queue lag, evaluation cost, notification yield and
 * duplicate suppression be MONITORED. Every one of those is an AGGREGATE, and
 * that is the whole of this surface: counts by state, the age of the oldest
 * pending job, and the split between what was delivered and what was withheld.
 *
 * ## There is no trace, and that is the decision
 *
 * Every other operator surface in this repo opens a trace from some handle —
 * a payment id, a checkout group, a subject key. This one opens from NOTHING.
 * A saved agent is a person's stated intent, expressed in their own
 * constraints, with their own note beside it; #97 privacy 3 says those are
 * visible to their owner and to authorized services, and an operator reading
 * one is neither. #81 reached the same place and built no operator surface at
 * all; this domain builds the aggregates because a queue nobody can see the lag
 * of is a queue nobody notices has stopped.
 *
 * So there is no function here that takes an agent id, an account id or a
 * canonical product, and none may be added. "Who is watching this product" is
 * unrepresentable rather than refused.
 */

import { readShoppingAgentEvaluationSummary } from '../../db/shoppingAgents/shoppingAgentEvaluationRepository.js';
import { readShoppingAgentFindingSummaryCounts } from '../../db/shoppingAgents/shoppingAgentFindingRepository.js';
import { readShoppingAgentNotificationSummary } from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';
import { readShoppingAgentTriggerSummary } from '../../db/shoppingAgents/shoppingAgentTriggerRepository.js';

/** Everything the operator surface reports. Counts only. */
export interface ShoppingAgentMetrics {
  readonly triggers: Readonly<Record<string, number>>;
  /** Milliseconds the oldest pending fan-out has been waiting. Queue LAG. */
  readonly triggerOldestPendingAgeMs: number | null;
  readonly evaluations: Readonly<Record<string, number>>;
  readonly evaluationOldestPendingAgeMs: number | null;
  readonly findings: Readonly<Record<string, number>>;
  readonly notifications: Readonly<Record<string, number>>;
  /**
   * How many notifications were WITHHELD, by reason.
   *
   * The duplicate-suppression figure #97 cost rule 6 asks for, and the reason
   * a suppression leaves a row at all: a table of messages that were sent can
   * never answer how many were not.
   */
  readonly suppressions: Readonly<Record<string, number>>;
}

export async function readShoppingAgentMetrics(
  now: Date = new Date(),
): Promise<ShoppingAgentMetrics> {
  const triggers = await readShoppingAgentTriggerSummary();
  const evaluations = await readShoppingAgentEvaluationSummary();
  const findings = await readShoppingAgentFindingSummaryCounts();
  const notifications = await readShoppingAgentNotificationSummary();

  return {
    triggers: {
      pending: triggers.pending,
      processing: triggers.processing,
      done: triggers.done,
      dead_letter: triggers.deadLetter,
    },
    triggerOldestPendingAgeMs: ageMs(triggers.oldestPendingAvailableAt, now),
    evaluations: {
      pending: evaluations.pending,
      processing: evaluations.processing,
      done: evaluations.done,
      dead_letter: evaluations.deadLetter,
    },
    evaluationOldestPendingAgeMs: ageMs(evaluations.oldestPendingAvailableAt, now),
    findings: {
      qualified: findings.qualified,
      not_qualified: findings.notQualified,
      incomplete: findings.incomplete,
    },
    notifications: {
      queued: notifications.queued,
      delivering: notifications.delivering,
      delivered: notifications.delivered,
      failed: notifications.failed,
      dead_letter: notifications.deadLetter,
      suppressed: notifications.suppressed,
    },
    suppressions: {
      cooldown_active: notifications.suppressedCooldownActive,
      not_materially_better: notifications.suppressedNotMateriallyBetter,
      agent_not_enabled: notifications.suppressedAgentNotEnabled,
      agent_deleted: notifications.suppressedAgentDeleted,
      finding_superseded: notifications.suppressedFindingSuperseded,
      destination_no_longer_eligible: notifications.suppressedDestinationNoLongerEligible,
      channel_unavailable: notifications.suppressedChannelUnavailable,
    },
  };
}

/**
 * How long the oldest pending job has been due.
 *
 * NEGATIVE is meaningful and is not clamped: a job whose `available_at` is in
 * the future is backing off rather than lagging, and reporting that as zero
 * would make a queue in a retry storm look healthy.
 */
function ageMs(availableAt: Date | undefined, now: Date): number | null {
  if (availableAt === undefined) return null;
  return now.getTime() - availableAt.getTime();
}
