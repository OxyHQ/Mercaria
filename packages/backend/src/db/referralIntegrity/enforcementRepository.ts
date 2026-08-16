/**
 * Reads and writes for `referral_enforcement_actions` and
 * `referral_enforcement_appeals` (#148, ADR 0005 D18).
 *
 * There is no delete function and no update of a decision column, on purpose:
 * #148 financial rule 3 (*"do not delete commission or ledger history"*) has a
 * sibling here — an enforcement record somebody could remove is not an audit
 * trail. Lifting an action is an UPDATE of the three lift columns, which the
 * table's trigger permits and every other column's change refuses.
 *
 * `findLiveEnforcementActions` narrows on `lifted_at is null` because that is
 * the indexed half; EXPIRY is applied by `deriveEnforcementEffects` against the
 * caller's clock, so the SQL and the derivation cannot disagree about "now" —
 * two places deciding what is in force is how a dashboard shows an expired hold
 * as current.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  ReferralEnforcementAction,
  ReferralEnforcementAppealState,
  ReferralEnforcementBasis,
  ReferralEnforcementScope,
  ReferralProhibitedConduct,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  referralEnforcementActions,
  referralEnforcementAppeals,
} from '../schema/referralIntegrity.js';

/** An action row as the services read it back. */
export type ReferralEnforcementActionRow = typeof referralEnforcementActions.$inferSelect;

/** An appeal row as the services read it back. */
export type ReferralEnforcementAppealRow = typeof referralEnforcementAppeals.$inferSelect;

/** How many actions one partner's read may return. */
const ACTION_PAGE_LIMIT = 200;

/** Insert one action. The table's CHECKs are the validation — see the schema. */
export async function insertEnforcementAction(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    action: ReferralEnforcementAction;
    scope: ReferralEnforcementScope;
    subjectId: string;
    programId?: string;
    basis: ReferralEnforcementBasis;
    conduct?: ReferralProhibitedConduct;
    reason: string;
    evidenceSignalIds: readonly string[];
    startsAt: Date;
    expiresAt?: Date;
    imposedByOxyUserId: string;
  },
): Promise<ReferralEnforcementActionRow> {
  const [row] = await db
    .insert(referralEnforcementActions)
    .values({
      partnerId: input.partnerId,
      action: input.action,
      scope: input.scope,
      subjectId: input.subjectId,
      programId: input.programId ?? null,
      basis: input.basis,
      conduct: input.conduct ?? null,
      reason: input.reason,
      evidenceSignalIds: [...input.evidenceSignalIds],
      startsAt: input.startsAt,
      expiresAt: input.expiresAt ?? null,
      imposedByOxyUserId: input.imposedByOxyUserId,
    })
    .returning();
  return row;
}

/**
 * Every action against a partner that has not been lifted.
 *
 * Expiry is NOT filtered here — see the file docblock. The caller applies it.
 */
export async function findLiveEnforcementActions(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralEnforcementActionRow[]> {
  return await db
    .select()
    .from(referralEnforcementActions)
    .where(
      and(
        eq(referralEnforcementActions.partnerId, partnerId),
        isNull(referralEnforcementActions.liftedAt),
      ),
    )
    .orderBy(desc(referralEnforcementActions.createdAt))
    .limit(ACTION_PAGE_LIMIT);
}

/** One partner's whole enforcement history, newest first. */
export async function findEnforcementActionsForPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralEnforcementActionRow[]> {
  return await db
    .select()
    .from(referralEnforcementActions)
    .where(eq(referralEnforcementActions.partnerId, partnerId))
    .orderBy(desc(referralEnforcementActions.createdAt))
    .limit(ACTION_PAGE_LIMIT);
}

/** One action by id. */
export async function findEnforcementActionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralEnforcementActionRow | undefined> {
  const [row] = await db
    .select()
    .from(referralEnforcementActions)
    .where(eq(referralEnforcementActions.id, id));
  return row;
}

/**
 * Lift an action, idempotently against a second lifter.
 *
 * A conditional UPDATE whose empty `RETURNING` set IS the "already lifted"
 * answer — a read-then-write lets two operators both see "live" and the second
 * one's reason silently replaces the first's. `cleared` is excluded by the
 * table's own CHECK rather than here: a clearance has nothing to undo.
 */
export async function liftEnforcementAction(
  db: DatabaseOrTransaction,
  input: { id: string; liftedByOxyUserId: string; liftReason: string; at: Date },
): Promise<ReferralEnforcementActionRow | undefined> {
  const [row] = await db
    .update(referralEnforcementActions)
    .set({
      liftedAt: input.at,
      liftedByOxyUserId: input.liftedByOxyUserId,
      liftReason: input.liftReason,
    })
    .where(
      and(
        eq(referralEnforcementActions.id, input.id),
        isNull(referralEnforcementActions.liftedAt),
      ),
    )
    .returning();
  return row;
}

/** Record an appeal's state on the action it is against. */
export async function setEnforcementAppealState(
  db: DatabaseOrTransaction,
  input: { id: string; appealState: ReferralEnforcementAppealState },
): Promise<void> {
  await db
    .update(referralEnforcementActions)
    .set({ appealState: input.appealState })
    .where(eq(referralEnforcementActions.id, input.id));
}

/**
 * Open an appeal.
 *
 * `ON CONFLICT DO NOTHING` against the open-appeal partial unique, so two
 * submissions from a partner's two devices converge on one row and the empty
 * `RETURNING` set is the "already open" answer. The independence CHECKs live on
 * the table; this function does not compare identities, because a service-layer
 * comparison is one a service bug can walk around.
 */
export async function insertEnforcementAppeal(
  db: DatabaseOrTransaction,
  input: {
    actionId: string;
    partnerId: string;
    imposedByOxyUserId: string;
    submittedByOxyUserId: string;
    submittedReason: string;
    submittedAt: Date;
  },
): Promise<ReferralEnforcementAppealRow | undefined> {
  const [row] = await db
    .insert(referralEnforcementAppeals)
    .values({
      actionId: input.actionId,
      partnerId: input.partnerId,
      state: 'open',
      imposedByOxyUserId: input.imposedByOxyUserId,
      submittedByOxyUserId: input.submittedByOxyUserId,
      submittedReason: input.submittedReason,
      submittedAt: input.submittedAt,
    })
    .onConflictDoNothing({
      target: referralEnforcementAppeals.actionId,
      where: sql`${referralEnforcementAppeals.state} = 'open'`,
    })
    .returning();
  return row;
}

/** The open appeal against one action, when there is one. */
export async function findOpenAppealForAction(
  db: DatabaseOrTransaction,
  actionId: string,
): Promise<ReferralEnforcementAppealRow | undefined> {
  const [row] = await db
    .select()
    .from(referralEnforcementAppeals)
    .where(
      and(
        eq(referralEnforcementAppeals.actionId, actionId),
        eq(referralEnforcementAppeals.state, 'open'),
      ),
    );
  return row;
}

/** One appeal by id. */
export async function findEnforcementAppealById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralEnforcementAppealRow | undefined> {
  const [row] = await db
    .select()
    .from(referralEnforcementAppeals)
    .where(eq(referralEnforcementAppeals.id, id));
  return row;
}

/**
 * Decide an open appeal, idempotently.
 *
 * The predicate carries `state = 'open'`, so a second decider's write returns
 * nothing rather than overwriting the first decision — and the table's
 * independence CHECK refuses a decider who imposed the action or who submitted
 * the appeal, whatever this function passes.
 */
export async function decideEnforcementAppeal(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    state: 'accepted' | 'rejected';
    decidedByOxyUserId: string;
    decisionReason: string;
    at: Date;
  },
): Promise<ReferralEnforcementAppealRow | undefined> {
  const [row] = await db
    .update(referralEnforcementAppeals)
    .set({
      state: input.state,
      decidedByOxyUserId: input.decidedByOxyUserId,
      decisionReason: input.decisionReason,
      decidedAt: input.at,
    })
    .where(
      and(
        eq(referralEnforcementAppeals.id, input.id),
        eq(referralEnforcementAppeals.state, 'open'),
      ),
    )
    .returning();
  return row;
}

/** Every appeal a partner has filed, newest first. */
export async function findAppealsForPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralEnforcementAppealRow[]> {
  return await db
    .select()
    .from(referralEnforcementAppeals)
    .where(eq(referralEnforcementAppeals.partnerId, partnerId))
    .orderBy(desc(referralEnforcementAppeals.createdAt))
    .limit(ACTION_PAGE_LIMIT);
}
