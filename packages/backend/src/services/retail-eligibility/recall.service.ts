/**
 * Recalls and the emergency stop (#121 "Recall and emergency controls").
 *
 * ## The emergency path is one INSERT, and it is INDEPENDENT of source refresh
 *
 * Raising a `stop_sale` suppression stops new publication and new checkout in
 * the very next derivation, because eligibility is derived and this row is one
 * of its inputs. Nothing is queued, nothing is swept, no cache is invalidated,
 * and the ordinary catalogue-refresh path is not involved at all — which is
 * exactly what #121 acceptance 5 asks to be testable on its own.
 *
 * ## What this service does NOT do, and where each of those lives
 *
 * The issue's recall control has seven parts. Three are here: register the
 * recall, stop publication and checkout, preserve the audit and the evidence.
 * The other four belong to owners this domain must not reach into:
 *
 *  - finding the affected **customer orders and purchase orders** is the impact
 *    scan below, which returns SUBJECTS rather than joined rows — the caller in
 *    #127 (supplier RMA and recall logistics) owns what to do with them;
 *  - **notifying affected customers** is #126's transactional messaging;
 *  - **supplier cancellation, return or disposal** is #127;
 *  - **cancelling in-flight purchase orders** is #124's adapter work.
 *
 * A stub that pretended to do any of them would be worse than the named seam,
 * because a recall whose customer notification silently did nothing is the
 * failure this whole section exists to prevent.
 */

import type { RetailSuppressionScope } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  liftRetailSuppression,
  listLiveBlockingSuppressions,
  raiseRetailSuppression,
  type NewRetailSuppression,
  type RetailSuppressionRecord,
} from '../../db/retailEligibility/suppressionRepository.js';
import { appendRetailEligibilityAudit } from '../../db/retailEligibility/decisionRepository.js';
import { conflict } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/**
 * Raise a suppression, audited.
 *
 * A repeat converges on the live row rather than stacking a second one, and the
 * audit row is written either way — so "two operators reacted to one authority
 * notice" is visible even though only one suppression exists.
 */
export async function raiseRetailSuppressionAudited(
  input: NewRetailSuppression,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ suppression: RetailSuppressionRecord; created: boolean }> {
  const row = await raiseRetailSuppression(db, input);
  const created = row.raisedByOxyUserId === input.raisedByOxyUserId && row.reason === input.reason;
  await appendRetailEligibilityAudit(db, {
    action: 'suppression_raised',
    subjectTable: 'retail_suppressions',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.raisedByOxyUserId,
    detail: `${row.kind}/${row.severity} on ${row.scope} ${row.scopeRef}`,
  });
  // A recall is loud on purpose: it is the one act in this domain whose effect
  // is a catalogue going dark, and an operator watching logs should see it
  // without opening a dashboard.
  log.general.warn(
    {
      suppressionId: row.id,
      scope: row.scope,
      scopeRef: row.scopeRef,
      kind: row.kind,
      severity: row.severity,
      source: row.source,
      converged: !created,
    },
    '[RetailEligibility] a retail suppression is live',
  );
  return { suppression: row, created };
}

/**
 * Lift a suppression, audited on both outcomes.
 *
 * The row survives: what was suppressed, by whom, why, and for how long is the
 * record an incident review reads, and deleting it would erase the evidence
 * #121 item 6 requires be preserved.
 */
export async function liftRetailSuppressionAudited(
  input: { id: string; liftedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailSuppressionRecord> {
  const row = await liftRetailSuppression(db, input);
  if (!row) {
    await appendRetailEligibilityAudit(db, {
      action: 'suppression_lifted',
      subjectTable: 'retail_suppressions',
      subjectId: input.id,
      outcome: 'refused',
      reason: input.reason,
      actorOxyUserId: input.liftedByOxyUserId,
      detail: 'already lifted or unknown',
    });
    throw conflict(`Retail suppression ${input.id} is already lifted, or does not exist.`);
  }
  await appendRetailEligibilityAudit(db, {
    action: 'suppression_lifted',
    subjectTable: 'retail_suppressions',
    subjectId: row.id,
    outcome: 'applied',
    reason: input.reason,
    actorOxyUserId: input.liftedByOxyUserId,
  });
  log.general.warn(
    { suppressionId: row.id, scope: row.scope, scopeRef: row.scopeRef, kind: row.kind },
    '[RetailEligibility] a retail suppression was lifted',
  );
  return row;
}

/** One subject a live suppression reaches, and what raised it. */
export interface RetailSuppressionSubject {
  suppressionId: string;
  scope: RetailSuppressionScope;
  scopeRef: string;
  kind: RetailSuppressionRecord['kind'];
  severity: RetailSuppressionRecord['severity'];
  /** Whether in-flight orders and purchase orders need operator recovery too. */
  requiresRecovery: boolean;
}

/**
 * Every subject currently under a blocking suppression (#121 recall item 2).
 *
 * Returns SUBJECTS, not joined rows. The scan an incident actually needs spans
 * active offers, pending checkouts, customer orders and purchase orders — four
 * domains — and a function here that joined them would make this domain depend
 * on all four. #127 owns the recovery and composes over this list; the useful
 * thing this domain can say is exactly which suppliers, products, variants,
 * SKUs, categories, markets and brands are currently stopped, and which of
 * those need recovery rather than only a stop.
 */
export async function scanRetailSuppressionImpact(
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<RetailSuppressionSubject[]> {
  const rows = await listLiveBlockingSuppressions(db, { now });
  return rows.map((row) => ({
    suppressionId: row.id,
    scope: row.scope,
    scopeRef: row.scopeRef,
    kind: row.kind,
    severity: row.severity,
    requiresRecovery: row.severity === 'stop_sale_and_recover',
  }));
}
