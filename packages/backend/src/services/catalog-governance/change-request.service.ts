/**
 * The change-request lifecycle (#367 Workstream 12): plan, approve, apply,
 * reject, withdraw.
 *
 * ## `apply` is unreachable without a plan, and that is the epic's requirement
 *
 * "Show impact counts before moves, merges and deprecations" is not a screen
 * this domain remembers to render. `applyChangeRequest` takes a request ID and
 * nothing else — there is no parameter it could be handed that would let it act
 * on an unplanned change, and the plan cannot exist without its impact rows
 * (`insertChangeRequest` refuses a report with fewer measurements than the plan
 * declared) or execute while unmeasured
 * (`catalog_governance_change_requests_unmeasured_not_applied_check`).
 *
 * ## Three layers hold the second approval, and none of them is a convention
 *
 * `requiresSecondApproval` is snapshotted at PLAN time from the measured impact
 * and `CATALOG_FOUR_EYES_REQUIRED`; `approveChangeRequest` refuses a
 * self-approval in code with a message that says why; and
 * `catalog_governance_change_requests_approver_distinct_check` plus
 * `..._second_approval_check` refuse both at the row, so a service bug that
 * skipped the gate is refused by the database rather than by the reviewer who
 * did not notice.
 *
 * ## A correction is a new request
 *
 * Nothing here edits an applied request, and the freeze trigger refuses it.
 * `rewrite_audit_history` and `edit_applied_change_request` are named in
 * `CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES` so a scan can find them.
 */

import type {
  CatalogGovernanceAction,
  CatalogGovernanceChangeRequest,
  CatalogGovernanceChangeState,
  CatalogGovernanceImpactReport,
  CatalogGovernanceSubjectKind,
} from '@mercaria/shared-types';
import {
  CATALOG_GOVERNANCE_ACTION_DOMAINS,
  CATALOG_GOVERNANCE_ACTION_SUBJECTS,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findChangeRequest,
  insertChangeRequest,
  listChangeRequests,
  listImpactCounts,
  listImpactCountsForRequests,
  listOpenRequestsForSubject,
  lockChangeRequest,
  transitionChangeRequest,
  type CatalogGovernanceChangeRequestRow,
  type ChangeRequestFilter,
} from '../../db/catalogGovernance/changeRequestRepository.js';
import { recordAuditEvent } from '../../db/catalogGovernance/auditRepository.js';
import type { CatalogGovernanceActor } from './actor.js';
import { applyChange, DIRECT_APPLY_ACTIONS } from './apply.js';
import { measureImpact, reportFromStoredRows, requiresSecondApproval } from './impact.service.js';
import { requireGovernanceRole, roleForAction } from './role.service.js';

/** What a plan states. */
export interface PlanChangeInput {
  readonly action: CatalogGovernanceAction;
  readonly subjectId: string;
  readonly parameters: Record<string, unknown>;
  readonly reason: string;
}

/**
 * What planning produced.
 *
 * `otherOpenRequests` is a WARNING and never a refusal: two different changes
 * to one category can legitimately be planned at once — a rename and a redirect
 * — and a unique index would refuse the second. What an operator needs is to
 * see that somebody else is already mid-change on the thing they are about to
 * move.
 */
export interface PlannedChange {
  readonly request: CatalogGovernanceChangeRequest;
  readonly otherOpenRequests: readonly string[];
}

/**
 * Plan a change: measure the impact, decide whether it needs two people, and
 * record all of it in one transaction.
 *
 * The impact is measured OUTSIDE the transaction and the request is written
 * inside it. That is deliberate: twenty aggregate counts inside a write
 * transaction hold it open for the duration of the slowest one, on tables every
 * other governance read is queueing behind. What it costs is that the counts
 * are a measurement at a moment rather than a serializable snapshot — which is
 * what an impact estimate is anyway, and what `impact_measured_at` records.
 */
export async function planChange(
  db: Database,
  actor: CatalogGovernanceActor,
  input: PlanChangeInput,
): Promise<PlannedChange> {
  // Planning needs `propose`; APPLYING needs the action's own role. Splitting
  // them is what makes the `propose` role mean anything — somebody who may draft
  // a taxonomy change and not publish it.
  requireGovernanceRole(actor, 'propose');

  const subjectKind = CATALOG_GOVERNANCE_ACTION_SUBJECTS[input.action];
  const domain = CATALOG_GOVERNANCE_ACTION_DOMAINS[input.action];

  const impact = await measureImpact(subjectKind, input.subjectId, db);
  const needsApproval = requiresSecondApproval(impact, config.catalog.fourEyesRequired);
  const now = new Date();

  const row = await db.transaction(async (tx) => {
    return insertChangeRequest(tx, {
      domain,
      action: input.action,
      subjectKind,
      subjectId: input.subjectId,
      parameters: input.parameters,
      reason: input.reason,
      requestedByOxyUserId: actor.oxyUserId,
      requestedAt: now,
      requiresSecondApproval: needsApproval,
      impactCoverage: impact.coverage,
      impactRelationsDeclared: impact.coverage === 'measured' ? impact.relationsDeclared : null,
      impactMeasuredAt: impact.coverage === 'measured' ? now : null,
      impactUnmeasuredReason: impact.unmeasuredReason ?? null,
      counts: impact.coverage === 'measured' ? impact.counts : [],
    });
  });

  await db.transaction(async (tx) => {
    await recordAuditEvent(tx, {
      domain,
      action: 'change_requested',
      subjectKind,
      subjectId: input.subjectId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: row.id,
      before: null,
      after: {
        action: input.action,
        parameters: input.parameters,
        impactTotal: impact.coverage === 'measured' ? impact.total : null,
        impactCoverage: impact.coverage,
        requiresSecondApproval: needsApproval,
      },
      at: now,
    });
  });

  const others = await listOpenRequestsForSubject(db, subjectKind, input.subjectId);

  return {
    request: projectRequest(row, impact),
    otherOpenRequests: others.filter((other) => other.id !== row.id).map((other) => other.id),
  };
}

/**
 * Approve a planned change.
 *
 * Refuses a self-approval by name rather than letting the CHECK do it, because
 * a constraint violation reaching an operator says
 * `catalog_governance_change_requests_approver_distinct_check` and this says
 * what to do instead. The CHECK stays, for the service bug that skips this.
 */
export async function approveChangeRequest(
  db: Database,
  actor: CatalogGovernanceActor,
  requestId: string,
  reason: string,
): Promise<CatalogGovernanceChangeRequest> {
  return db.transaction(async (tx) => {
    const row = await lockChangeRequest(tx, requestId);
    if (!row) throw notFound('Change request not found.');
    requireGovernanceRole(actor, roleForAction(row.action));

    if (row.state !== 'planned') {
      throw conflict(`This change request is ${row.state} and can no longer be approved.`);
    }
    if (row.requestedByOxyUserId === actor.oxyUserId) {
      throw conflict(
        'Four eyes means two people: this change was planned by you, so a different operator has to approve it.',
      );
    }

    const now = new Date();
    const approved = await transitionChangeRequest(tx, requestId, ['planned'], {
      state: 'approved',
      approvedByOxyUserId: actor.oxyUserId,
      approvedAt: now,
    });
    if (!approved) {
      throw conflict('This change request was decided by somebody else while you were reading it.');
    }

    await recordAuditEvent(tx, {
      domain: row.domain,
      action: 'change_approved',
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason,
      source: 'change_request',
      changeRequestId: requestId,
      before: { state: 'planned' },
      after: { state: 'approved' },
      at: now,
    });

    const counts = await listImpactCounts(tx, requestId);
    return projectRequest(approved, storedReport(approved, counts));
  });
}

/**
 * Apply a change.
 *
 * The valid entry states are `planned` for a change that needs one person and
 * `approved` for one that needs two, and the difference is read off the
 * SNAPSHOTTED `requires_second_approval` rather than re-derived — the threshold
 * and the flag both move, and re-deriving here would let a request approved
 * yesterday become unapprovable today, or the reverse.
 *
 * A driver that refuses moves the request to `failed` with the driver's own
 * detail, in the same transaction. `failed` is terminal on purpose: an apply
 * that half-ran is a fact an operator has to look at, and a surface that
 * quietly retried would turn one visible failure into a silent one. The remedy
 * is a new request, which is also the remedy for a correction.
 */
export async function applyChangeRequest(
  db: Database,
  actor: CatalogGovernanceActor,
  requestId: string,
): Promise<CatalogGovernanceChangeRequest> {
  const preflight = await findChangeRequest(db, requestId);
  if (!preflight) throw notFound('Change request not found.');
  requireGovernanceRole(actor, roleForAction(preflight.action));

  if (!DIRECT_APPLY_ACTIONS.includes(preflight.action)) {
    throw conflict(
      `${preflight.action} is applied through its own operator route, not through this one.`,
    );
  }

  return db.transaction(async (tx) => {
    const row = await lockChangeRequest(tx, requestId);
    if (!row) throw notFound('Change request not found.');

    // Typed as the full state union rather than inferred from the literals: an
    // inferred `readonly ['approved']` makes `.includes` demand that exact
    // member, so the check would not compile against a row state — and the
    // tempting fix is a cast, which would silently accept any state at all.
    const entryStates: readonly CatalogGovernanceChangeState[] = row.requiresSecondApproval
      ? ['approved']
      : ['planned', 'approved'];
    if (!entryStates.includes(row.state)) {
      throw conflict(
        row.requiresSecondApproval && row.state === 'planned'
          ? 'This change is large enough to need a second operator. Have somebody else approve it first.'
          : `This change request is ${row.state} and can no longer be applied.`,
      );
    }
    if (row.impactCoverage !== 'measured') {
      throw conflict(
        'This change was planned without a usable impact measurement, so it cannot be applied. Re-plan it — the reason is on the request.',
      );
    }

    let result: Awaited<ReturnType<typeof applyChange>>;
    try {
      result = await applyChange(db, tx, {
        action: row.action,
        subjectId: row.subjectId,
        parameters: row.parameters,
        actorOxyUserId: actor.oxyUserId,
      });
    } catch (error) {
      // The transaction is already poisoned by whatever the driver did, so the
      // `failed` stamp cannot be written here — one failed statement aborts the
      // WHOLE transaction in PostgreSQL, and an UPDATE issued afterwards raises
      // `25P02` and hides the real cause. The request stays in its entry state
      // and the error propagates with the driver's own message.
      log.general.error(
        { requestId, action: row.action, subjectId: row.subjectId, err: error },
        'catalog governance apply raised',
      );
      throw error;
    }

    const now = new Date();

    if (result.outcome === 'refused') {
      const failed = await transitionChangeRequest(tx, requestId, [...entryStates], {
        state: 'failed',
        failureDetail: result.detail,
      });
      if (!failed) throw conflict('This change request was decided by somebody else.');
      await recordAuditEvent(tx, {
        domain: row.domain,
        action: 'change_failed',
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        actorKind: 'operator',
        actorOxyUserId: actor.oxyUserId,
        reason: result.detail,
        source: 'change_request',
        changeRequestId: requestId,
        before: { state: row.state },
        after: { state: 'failed' },
        at: now,
      });
      const counts = await listImpactCounts(tx, requestId);
      return projectRequest(failed, storedReport(failed, counts));
    }

    const applied = await transitionChangeRequest(tx, requestId, [...entryStates], {
      state: 'applied',
      appliedAt: now,
    });
    if (!applied) throw conflict('This change request was applied by somebody else.');

    await recordAuditEvent(tx, {
      domain: row.domain,
      action: row.action,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: row.reason,
      source: 'change_request',
      changeRequestId: requestId,
      before: { state: row.state, parameters: row.parameters },
      after: result.after,
      at: now,
    });
    await recordAuditEvent(tx, {
      domain: row.domain,
      action: 'change_applied',
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: row.reason,
      source: 'change_request',
      changeRequestId: requestId,
      before: { state: row.state },
      after: { state: 'applied' },
      at: now,
    });

    const counts = await listImpactCounts(tx, requestId);
    return projectRequest(applied, storedReport(applied, counts));
  });
}

/** Reject a planned or approved change. Terminal, attributable, with a reason. */
export async function rejectChangeRequest(
  db: Database,
  actor: CatalogGovernanceActor,
  requestId: string,
  reason: string,
): Promise<CatalogGovernanceChangeRequest> {
  return decide(db, actor, requestId, 'rejected', 'change_rejected', reason, false);
}

/**
 * Withdraw a change you planned.
 *
 * The one decision the REQUESTER may take on their own request, because closing
 * your own request is not a review outcome — demanding a second operator for it
 * would leave a mistaken plan sitting in the queue until somebody else noticed.
 */
export async function withdrawChangeRequest(
  db: Database,
  actor: CatalogGovernanceActor,
  requestId: string,
  reason: string,
): Promise<CatalogGovernanceChangeRequest> {
  return decide(db, actor, requestId, 'withdrawn', 'change_withdrawn', reason, true);
}

async function decide(
  db: Database,
  actor: CatalogGovernanceActor,
  requestId: string,
  state: 'rejected' | 'withdrawn',
  auditAction: 'change_rejected' | 'change_withdrawn',
  reason: string,
  requesterOnly: boolean,
): Promise<CatalogGovernanceChangeRequest> {
  return db.transaction(async (tx) => {
    const row = await lockChangeRequest(tx, requestId);
    if (!row) throw notFound('Change request not found.');
    requireGovernanceRole(actor, requesterOnly ? 'propose' : roleForAction(row.action));

    if (requesterOnly && row.requestedByOxyUserId !== actor.oxyUserId) {
      throw conflict('Only the operator who planned a change may withdraw it. Reject it instead.');
    }
    if (row.state !== 'planned' && row.state !== 'approved') {
      throw conflict(`This change request is ${row.state} and can no longer be ${state}.`);
    }

    const now = new Date();
    const decided = await transitionChangeRequest(tx, requestId, ['planned', 'approved'], { state });
    if (!decided) throw conflict('This change request was decided by somebody else.');

    await recordAuditEvent(tx, {
      domain: row.domain,
      action: auditAction,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason,
      source: 'change_request',
      changeRequestId: requestId,
      before: { state: row.state },
      after: { state },
      at: now,
    });

    const counts = await listImpactCounts(tx, requestId);
    return projectRequest(decided, storedReport(decided, counts));
  });
}

/** One request with its measurements. */
export async function readChangeRequest(
  db: DatabaseOrTransaction,
  requestId: string,
): Promise<CatalogGovernanceChangeRequest> {
  const row = await findChangeRequest(db, requestId);
  if (!row) throw notFound('Change request not found.');
  const counts = await listImpactCounts(db, requestId);
  return projectRequest(row, storedReport(row, counts));
}

/** The operator queue, each row carrying its own measurements. */
export async function readChangeRequestQueue(
  db: DatabaseOrTransaction,
  filter: ChangeRequestFilter,
): Promise<CatalogGovernanceChangeRequest[]> {
  const rows = await listChangeRequests(db, filter);
  // One batched read for every page rather than one per row — the read that
  // renders a queue must not be an N+1, and #70's plan test is the precedent.
  const counts = await listImpactCountsForRequests(
    db,
    rows.map((row) => row.id),
  );
  const byRequest = new Map<string, typeof counts>();
  for (const entry of counts) {
    const bucket = byRequest.get(entry.changeRequestId) ?? [];
    bucket.push(entry);
    byRequest.set(entry.changeRequestId, bucket);
  }
  return rows.map((row) => projectRequest(row, storedReport(row, byRequest.get(row.id) ?? [])));
}

function storedReport(
  row: CatalogGovernanceChangeRequestRow,
  counts: readonly { referenceTable: string; referenceColumn: string; disposition: string; rowCount: number }[],
): CatalogGovernanceImpactReport {
  return reportFromStoredRows(
    row.subjectKind as CatalogGovernanceSubjectKind,
    row.subjectId,
    row.impactCoverage,
    row.impactRelationsDeclared ?? 0,
    counts.map((entry) => ({
      referenceTable: entry.referenceTable,
      referenceColumn: entry.referenceColumn,
      disposition: entry.disposition as CatalogGovernanceImpactReport['counts'][number]['disposition'],
      rowCount: entry.rowCount,
    })),
    row.impactUnmeasuredReason,
  );
}

function projectRequest(
  row: CatalogGovernanceChangeRequestRow,
  impact: CatalogGovernanceImpactReport,
): CatalogGovernanceChangeRequest {
  // The projection names every field explicitly — the `provider_accounts`
  // precedent. `parameters` is deliberately NOT in the DTO: it is the frozen
  // record of what was asked and belongs on the trace, not on every queue row.
  return {
    id: row.id,
    domain: row.domain,
    action: row.action,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    state: row.state,
    reason: row.reason,
    requestedByOxyUserId: row.requestedByOxyUserId,
    requestedAt: row.requestedAt.toISOString(),
    requiresSecondApproval: row.requiresSecondApproval,
    approvedByOxyUserId: row.approvedByOxyUserId ?? undefined,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : undefined,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : undefined,
    failureDetail: row.failureDetail ?? undefined,
    impact,
  };
}
