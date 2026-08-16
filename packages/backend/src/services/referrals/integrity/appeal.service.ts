/**
 * The independent appeal path (#148 control 14, acceptance 3).
 *
 * ## Independence is the ROW's shape, not a comparison here
 *
 * `referral_enforcement_appeals_independence_check` refuses a decider who
 * imposed the action and a decider who submitted the appeal. This file passes
 * the identities and does not compare them, for the same reason #55's four eyes
 * is a partial unique rather than a service comparison: a comparison in a
 * service is one a second caller can be written without.
 *
 * The `imposed_by_oxy_user_id` is SNAPSHOTTED onto the appeal at submission,
 * because a CHECK may not contain a subquery and therefore cannot reach the
 * action's own column. The snapshot is safe precisely because the action's
 * decision columns are frozen by trigger — there is no later value for it to
 * drift from.
 *
 * ## An accepted appeal LIFTS the action; it does not delete it
 *
 * ADR 0005 D18 and #148 financial rule 9: *"appeal reversal uses compensating
 * records"*. So an overturn writes the appeal's decision AND the action's three
 * lift columns, and the original decision — its reason, its basis, its evidence
 * — stays exactly as it was recorded. What a partner gets back is the effect,
 * never the erasure.
 *
 * ## What is deliberately absent
 *
 * There is no "withdraw my appeal", no "re-appeal", and no operator route that
 * OPENS one. A partner opens their own appeal or nobody does: an operator who
 * could open an appeal on somebody's behalf could open one they then decide,
 * and the independence CHECK would be satisfied by two accounts one person
 * holds. A partner who wants to stop pursuing an appeal simply stops.
 */

import type { ReferralEnforcementAppealState } from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import {
  decideEnforcementAppeal,
  findAppealsForPartner,
  findEnforcementActionById,
  findEnforcementAppealById,
  findOpenAppealForAction,
  insertEnforcementAppeal,
  liftEnforcementAction,
  setEnforcementAppealState,
  type ReferralEnforcementAppealRow,
} from '../../../db/referralIntegrity/enforcementRepository.js';

/** An appeal as an operator or its own partner reads it. */
export interface ReferralEnforcementAppealView {
  id: string;
  actionId: string;
  state: ReferralEnforcementAppealState;
  submittedReason: string;
  /** ISO-8601. */
  submittedAt: string;
  decisionReason?: string;
  /** ISO-8601. */
  decidedAt?: string;
}

/**
 * The projection.
 *
 * It carries NEITHER identity — not the imposer, not the decider, not the
 * submitter. An operator reading a case gets the identities off
 * `referral_events`, which is the audit trail and is operator-only; a partner
 * must never learn which employee decided against them, because naming them
 * invites exactly the retaliation an allow-listed review surface exists to
 * prevent. One projection for both readers is then safe, which is why there is
 * one rather than two that could disagree.
 */
export function toEnforcementAppealView(
  row: ReferralEnforcementAppealRow,
): ReferralEnforcementAppealView {
  return {
    id: row.id,
    actionId: row.actionId,
    state: row.state,
    submittedReason: row.submittedReason,
    submittedAt: row.submittedAt.toISOString(),
    decisionReason: row.decisionReason ?? undefined,
    decidedAt: row.decidedAt?.toISOString(),
  };
}

/**
 * Open an appeal against one action, as the partner.
 *
 * The action must belong to the appealing partner — checked here rather than
 * left to the route, because the route mounts twice (an individual's own
 * surface and a store's) and one check in the service is one answer to
 * "is this yours".
 */
export async function openEnforcementAppeal(input: {
  actionId: string;
  partnerId: string;
  submittedByOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralEnforcementAppealView> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw validationError('An appeal requires a reason');

  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const action = await findEnforcementActionById(tx, input.actionId);
    // ONE answer for "no such action" and "somebody else's action": a
    // distinguishable response is an enumeration oracle over every partner's
    // enforcement record, which is the one thing a competitor would pay for.
    if (!action || action.partnerId !== input.partnerId) {
      throw notFound('Enforcement action not found');
    }
    if (action.liftedAt != null) {
      throw conflict('That enforcement action has already been lifted');
    }
    if (action.action === 'cleared' || action.action === 'monitoring') {
      throw validationError('There is nothing to appeal: that record imposes nothing');
    }

    const row = await insertEnforcementAppeal(tx, {
      actionId: input.actionId,
      partnerId: input.partnerId,
      imposedByOxyUserId: action.imposedByOxyUserId,
      submittedByOxyUserId: input.submittedByOxyUserId,
      submittedReason: reason,
      submittedAt: at,
    });
    if (!row) {
      // The open-appeal partial unique refused. Two submissions from one
      // partner's two devices is the ORDINARY case; the existing row is the
      // right answer to both.
      const existing = await findOpenAppealForAction(tx, input.actionId);
      if (!existing) throw conflict('An appeal against that action is already open');
      return toEnforcementAppealView(existing);
    }

    await setEnforcementAppealState(tx, { id: input.actionId, appealState: 'open' });
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_enforcement_appealed',
      actorKind: 'partner',
      actorRef: input.submittedByOxyUserId,
      reason: `${action.action} (${action.scope}): ${reason}`,
    });
    return toEnforcementAppealView(row);
  });
}

/**
 * Decide an open appeal, as a DIFFERENT operator.
 *
 * `accepted` lifts the action in the same transaction: an appeal that succeeds
 * and leaves the effect in force is one nobody would file twice. `rejected`
 * lifts nothing and the action runs its own course — including its expiry,
 * which is why an expiring action is the kinder default for a signal-based
 * hold.
 */
export async function decideAppeal(input: {
  appealId: string;
  decision: 'accepted' | 'rejected';
  reason: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralEnforcementAppealView> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw validationError('An appeal decision requires a reason');

  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const existing = await findEnforcementAppealById(tx, input.appealId);
    if (!existing) throw notFound('Appeal not found');
    if (existing.state !== 'open') throw conflict('That appeal has already been decided');
    // Stated here as well as in the CHECK, because the sentence is the point:
    // an operator told "violates constraint …_independence_check" learns
    // nothing, and the CHECK is what actually refuses the row either way.
    if (existing.imposedByOxyUserId === input.actorOxyUserId) {
      throw validationError(
        'An appeal is decided by somebody other than the operator who imposed the action',
      );
    }
    if (existing.submittedByOxyUserId === input.actorOxyUserId) {
      throw validationError('An appeal is not decided by the partner who submitted it');
    }

    const row = await decideEnforcementAppeal(tx, {
      id: input.appealId,
      state: input.decision,
      decidedByOxyUserId: input.actorOxyUserId,
      decisionReason: reason,
      at,
    });
    if (!row) throw conflict('That appeal has already been decided');

    await setEnforcementAppealState(tx, {
      id: existing.actionId,
      appealState: input.decision,
    });
    if (input.decision === 'accepted') {
      // The compensating record: the action is LIFTED, never edited and never
      // deleted. Its reason, basis and evidence stay exactly as recorded.
      await liftEnforcementAction(tx, {
        id: existing.actionId,
        liftedByOxyUserId: input.actorOxyUserId,
        liftReason: `Appeal accepted: ${reason}`,
        at,
      });
    }

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: existing.partnerId,
      action: 'partner_enforcement_appeal_decided',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `${input.decision}: ${reason}`,
    });
    return toEnforcementAppealView(row);
  });
}

/** One partner's appeals, newest first. */
export async function readAppealsForPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<readonly ReferralEnforcementAppealView[]> {
  const rows = await findAppealsForPartner(db, partnerId);
  return rows.map(toEnforcementAppealView);
}
