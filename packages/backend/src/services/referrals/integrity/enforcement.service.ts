/**
 * Imposing, lifting and reading scoped enforcement (#148 "Enforcement states",
 * ADR 0005 D18).
 *
 * ## Two actions are REPRESENTABLE and NOT IMPOSABLE here
 *
 * `partner_termination` and `commission_held` are in the vocabulary, in the
 * effect table and in every projection — an operator reading a partner's record
 * must be able to SEE them — and {@link imposeEnforcementAction} refuses both
 * BY NAME, pointing at the route that performs them. The `role_email` device
 * (#83), for the reason that one exists: a second way to terminate would be a
 * second writer of `referral_partners.state`, and a second way to freeze would
 * be a second writer of the reward state machine. #146's
 * `POST /internal/referrals/partners/:id/terminate` and #145's `.../freeze` are
 * those writers and stay so.
 *
 * The refusal names the alternative rather than saying "unrecognized action",
 * which is the difference between a reader learning the model and a reader
 * concluding the feature is broken.
 *
 * ## The forfeiture law is not checked here
 *
 * There is no `if (basis === 'risk_signal' && ...)` in this file, deliberately.
 * `referral_enforcement_actions_forfeiture_basis_check` refuses the row, so a
 * service bug, an operator with `psql` and a future caller that forgets all get
 * the same answer. What this file does is TRANSLATE that refusal into a
 * sentence, because a `23514` reaching an operator as a constraint name teaches
 * nobody anything.
 *
 * ## Lifting is a compensating record, never an edit
 *
 * The decision columns are frozen by trigger; a lift writes three more. So
 * #148 acceptance 3's *"reversible through compensating records"* is the only
 * shape available rather than the one somebody chose.
 */

import {
  REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS,
  type ReferralEnforcementAction,
  type ReferralEnforcementActionView,
  type ReferralEnforcementBasis,
  type ReferralEnforcementEffects,
  type ReferralEnforcementPartnerView,
  type ReferralEnforcementScope,
  type ReferralProhibitedConduct,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import { findPartnerById } from '../../../db/referrals/partnerRepository.js';
import {
  findEnforcementActionById,
  findEnforcementActionsForPartner,
  findLiveEnforcementActions,
  insertEnforcementAction,
  liftEnforcementAction,
  type ReferralEnforcementActionRow,
} from '../../../db/referralIntegrity/enforcementRepository.js';
import { deriveEnforcementEffects, enforcementActionIsLive } from './effects.js';

/**
 * The actions this surface will not perform, and where each is performed.
 *
 * A `Record` rather than a list plus a message, so an entry added here carries
 * its alternative with it — a refusal that cannot say what to do instead is one
 * whoever hits it works around.
 */
export const ENFORCEMENT_ACTIONS_PERFORMED_ELSEWHERE: Partial<
  Record<ReferralEnforcementAction, string>
> = {
  partner_termination:
    'POST /internal/referrals/partners/:partnerId/terminate — #146 owns the enrollment ' +
    'transition and its confirmed-fraud decision, and a second writer of ' +
    'referral_partners.state could disagree with it',
  commission_held:
    'POST /internal/referrals/partners/:partnerId/freeze — #145 owns the reward state ' +
    'machine, and a freeze recorded here without moving the rewards would be an ' +
    'enforcement record that enforces nothing',
};

/** Every scope an action of each kind may legitimately carry. */
const ACTION_SCOPES: Record<ReferralEnforcementAction, readonly ReferralEnforcementScope[]> = {
  monitoring: ['partner', 'program_partner', 'instrument', 'attribution', 'conversion', 'reward'],
  commission_held: ['reward', 'partner'],
  attribution_invalidated: ['attribution'],
  conversion_rejected: ['conversion'],
  partner_warning: ['partner', 'program_partner'],
  new_link_suspension: ['partner'],
  new_attribution_suspension: ['partner'],
  payout_hold: ['partner'],
  program_removal: ['program_partner'],
  partner_termination: ['partner'],
  permanent_restriction: ['partner'],
  cleared: ['partner', 'program_partner', 'instrument', 'attribution', 'conversion', 'reward'],
};

/** The row, as an OPERATOR reads it. Every field named. */
export function toEnforcementActionView(
  row: ReferralEnforcementActionRow,
): ReferralEnforcementActionView {
  return {
    id: row.id,
    action: row.action as ReferralEnforcementAction,
    scope: row.scope as ReferralEnforcementScope,
    subjectId: row.subjectId,
    partnerId: row.partnerId,
    programId: row.programId ?? undefined,
    basis: row.basis as ReferralEnforcementBasis,
    conduct: (row.conduct ?? undefined) as ReferralProhibitedConduct | undefined,
    reason: row.reason,
    evidenceSignalIds: row.evidenceSignalIds,
    financialEffect:
      REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS[row.action as ReferralEnforcementAction],
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    liftedAt: row.liftedAt?.toISOString(),
    liftReason: row.liftReason ?? undefined,
    appealState: row.appealState,
    imposedByOxyUserId: row.imposedByOxyUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The row, as the PARTNER reads it.
 *
 * A different TYPE rather than a filtered one — #106's `MerchantOrder` device.
 * There is no operator identity, no evidence list, no subject id and no basis,
 * and `REFERRAL_ENFORCEMENT_PARTNER_FORBIDDEN_FIELDS` names all of them as
 * values so the omission is scanned statically AND walked at runtime.
 *
 * `appealable` is DERIVED rather than stored: an action already lifted, already
 * appealed or recorded as a clearance is not one to appeal, and a stored flag
 * would be right until the first of those changed.
 */
export function toEnforcementPartnerView(
  row: ReferralEnforcementActionRow,
  at: Date,
): ReferralEnforcementPartnerView {
  const action = row.action as ReferralEnforcementAction;
  return {
    id: row.id,
    action,
    conduct: (row.conduct ?? undefined) as ReferralProhibitedConduct | undefined,
    reason: row.reason,
    financialEffect: REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS[action],
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    liftedAt: row.liftedAt?.toISOString(),
    appealState: row.appealState,
    appealable:
      action !== 'cleared' &&
      action !== 'monitoring' &&
      row.appealState === 'none' &&
      enforcementActionIsLive(
        {
          action,
          programId: row.programId,
          startsAt: row.startsAt,
          expiresAt: row.expiresAt,
          liftedAt: row.liftedAt,
        },
        at,
      ),
  };
}

/**
 * What is in force against a partner right now.
 *
 * The ONE function the three gates call, so `instrument.service`,
 * `attribution.service` and `payability` cannot hold three opinions. It reads
 * the partner's own state as well as the live actions — see
 * `deriveEnforcementEffects`'s docblock for why that unification is here rather
 * than beside each caller.
 */
export async function readEnforcementEffects(
  db: DatabaseOrTransaction,
  partnerId: string,
  at: Date = new Date(),
): Promise<ReferralEnforcementEffects> {
  const partner = await findPartnerById(db, partnerId);
  if (!partner) throw notFound('Referral partner not found');
  const rows = await findLiveEnforcementActions(db, partnerId);
  return deriveEnforcementEffects(
    rows.map((row) => ({
      action: row.action as ReferralEnforcementAction,
      programId: row.programId,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      liftedAt: row.liftedAt,
    })),
    partner.state,
    at,
  );
}

/**
 * Impose one action.
 *
 * The database holds the invariants; this validates the two things a CHECK
 * cannot see — that the action is one this surface performs, and that the scope
 * is one the action may carry — and translates a constraint violation into a
 * sentence.
 */
export async function imposeEnforcementAction(input: {
  partnerId: string;
  action: ReferralEnforcementAction;
  scope: ReferralEnforcementScope;
  subjectId: string;
  programId?: string;
  basis: ReferralEnforcementBasis;
  conduct?: ReferralProhibitedConduct;
  reason: string;
  evidenceSignalIds?: readonly string[];
  expiresAt?: Date;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralEnforcementActionView> {
  const performedElsewhere = ENFORCEMENT_ACTIONS_PERFORMED_ELSEWHERE[input.action];
  if (performedElsewhere !== undefined) {
    throw validationError(
      `${input.action} is not imposed through this surface. Use ${performedElsewhere}.`,
    );
  }
  if (!ACTION_SCOPES[input.action].includes(input.scope)) {
    throw validationError(
      `${input.action} cannot be scoped to ${input.scope}; permitted scopes are ` +
        `${ACTION_SCOPES[input.action].join(', ')}`,
    );
  }
  // The one rule stated here as well as in the CHECK, because the sentence is
  // the point. The CHECK is what ENFORCES it — remove this and a forfeiting
  // action on a signal basis still has no row shape.
  if (
    REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS[input.action] === 'forfeits' &&
    input.basis === 'risk_signal'
  ) {
    throw validationError(
      `${input.action} destroys earned money and may not rest on a risk signal. ` +
        'ADR 0005 D17: signals freeze, only first-party identity evidence voids. ' +
        'Freeze the rewards and open a review instead.',
    );
  }

  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const partner = await findPartnerById(tx, input.partnerId);
    if (!partner) throw notFound('Referral partner not found');

    let row: ReferralEnforcementActionRow;
    try {
      row = await insertEnforcementAction(tx, {
        partnerId: input.partnerId,
        action: input.action,
        scope: input.scope,
        subjectId: input.subjectId,
        programId: input.programId,
        basis: input.basis,
        conduct: input.conduct,
        reason: input.reason.trim(),
        evidenceSignalIds: input.evidenceSignalIds ?? [],
        startsAt: at,
        expiresAt: input.expiresAt,
        imposedByOxyUserId: input.actorOxyUserId,
      });
    } catch (error) {
      // The live partial unique. Two operators reaching one conclusion is the
      // ORDINARY case, and answering it with a 500 would make the second one
      // think the surface is broken.
      if (isUniqueViolationOn(error, 'referral_enforcement_actions_live_key')) {
        throw conflict(
          `A live ${input.action} already stands against this ${input.scope}. ` +
            'Lift it before imposing another.',
        );
      }
      throw error;
    }

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_enforcement_imposed',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `${input.action} (${input.scope}, ${input.basis}): ${input.reason.trim()}`,
    });

    return toEnforcementActionView(row);
  });
}

/**
 * Lift one action, attributably.
 *
 * Idempotent against a second lifter: the repository's predicate carries
 * `lifted_at is null` and its empty result IS the "already lifted" answer, so a
 * retried request converges rather than replacing the first operator's reason.
 */
export async function liftEnforcement(input: {
  actionId: string;
  reason: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralEnforcementActionView> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw validationError('A lift requires a reason');

  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const existing = await findEnforcementActionById(tx, input.actionId);
    if (!existing) throw notFound('Enforcement action not found');
    if (existing.liftedAt != null) {
      throw conflict('That enforcement action has already been lifted');
    }

    const row = await liftEnforcementAction(tx, {
      id: input.actionId,
      liftedByOxyUserId: input.actorOxyUserId,
      liftReason: reason,
      at,
    });
    if (!row) throw conflict('That enforcement action has already been lifted');

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: existing.partnerId,
      action: 'partner_enforcement_lifted',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `${existing.action} (${existing.scope}): ${reason}`,
    });

    return toEnforcementActionView(row);
  });
}

/** A partner's whole enforcement history, as an OPERATOR reads it. */
export async function readEnforcementHistory(
  partnerId: string,
): Promise<readonly ReferralEnforcementActionView[]> {
  const db = getDb();
  const rows = await findEnforcementActionsForPartner(db, partnerId);
  return rows.map(toEnforcementActionView);
}

/** A partner's own enforcement history, as the PARTNER reads it. */
export async function readEnforcementForPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
  at: Date = new Date(),
): Promise<readonly ReferralEnforcementPartnerView[]> {
  const rows = await findEnforcementActionsForPartner(db, partnerId);
  return rows.map((row) => toEnforcementPartnerView(row, at));
}

/**
 * Whether an error is a unique violation on one named index.
 *
 * The SQLSTATE lives on `cause`, never on `error.code` — a ported
 * `err.code === '23505'` matches nothing against a drizzle error.
 */
function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } })?.cause;
  return cause?.code === '23505' && cause?.constraint_name === constraint;
}
