/**
 * Partner lifecycle (#142, API 2): application, invitation, approval,
 * suspension, reinstatement, termination and appeals.
 *
 * The partner record is SEPARATE from the public identity (Oxy owns that) and
 * from the payout beneficiary (#146 owns that); what this service manages is
 * standing — ADR 0005 D2's one-record-per-owner enrollment and D18's
 * suspension semantics. The consequence of `suspended` — no NEW attribution
 * while historical commissions continue per policy — is enforced where
 * attribution is created (`attribution.service.ts`), not here: suspension
 * gates a LOOP-shaped decision, never a durable record.
 *
 * Every transition appends its `referral_events` row in the same transaction.
 */

import type {
  ReferralPartnerOwnerType,
  ReferralPromotionMethod,
} from '@mercaria/shared-types';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import {
  findPartnerById,
  insertPartner,
  transitionPartnerState,
  type ReferralPartnerRow,
} from '../../db/referrals/partnerRepository.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';

/**
 * Self-serve application (ADR 0005 D2: enrollment is free and self-serve —
 * fraud controls are the defense, not gatekeeping at the door). Converges on
 * the existing record when the owner already has one, whatever its state:
 * one partner record per owner, ever.
 */
export async function applyAsPartner(input: {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
  displayName: string;
  termsVersion: string;
  promotionMethods: readonly ReferralPromotionMethod[];
  at?: Date;
}): Promise<{ partner: ReferralPartnerRow; created: boolean }> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const { row, created } = await insertPartner(tx, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      displayName: input.displayName,
      state: 'applied',
      at,
      termsVersion: input.termsVersion,
      promotionMethods: input.promotionMethods,
    });
    if (created) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: row.id,
        action: 'partner_applied',
        actorKind: 'partner',
        actorRef: input.ownerId,
        reason: `Applied accepting terms ${input.termsVersion}`,
      });
    }
    return { partner: row, created };
  });
}

/** Operator invitation — the same convergence rule as an application. */
export async function invitePartner(input: {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
  displayName: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<{ partner: ReferralPartnerRow; created: boolean }> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const { row, created } = await insertPartner(tx, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      displayName: input.displayName,
      state: 'invited',
      at,
      promotionMethods: [],
    });
    if (created) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: row.id,
        action: 'partner_invited',
        actorKind: 'operator',
        actorRef: input.actorOxyUserId,
        reason: input.reason,
      });
    }
    return { partner: row, created };
  });
}

/** Approve an applied or invited partner. Idempotent on an already-approved one. */
export async function approvePartner(input: {
  partnerId: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionPartnerState(tx, {
      id: input.partnerId,
      expected: ['applied', 'invited'],
      to: 'approved',
      at,
    });
    if (!row) {
      const existing = await requirePartner(tx, input.partnerId);
      if (existing.state === 'approved') return existing;
      throw conflict(`Partner is ${existing.state} and cannot be approved`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: row.id,
      action: 'partner_approved',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/**
 * Suspend an approved partner (ADR 0005 D18): new attribution stops
 * immediately — the attribution service reads this state — while everything
 * durable stays exactly where it is.
 */
export async function suspendPartner(input: {
  partnerId: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionPartnerState(tx, {
      id: input.partnerId,
      expected: ['approved'],
      to: 'suspended',
      at,
      riskState: 'under_review',
    });
    if (!row) {
      const existing = await requirePartner(tx, input.partnerId);
      throw conflict(`Partner is ${existing.state} and cannot be suspended`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: row.id,
      action: 'partner_suspended',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/** Reinstate a suspended partner — everything resumes where it stopped (D18). */
export async function reinstatePartner(input: {
  partnerId: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionPartnerState(tx, {
      id: input.partnerId,
      expected: ['suspended'],
      to: 'approved',
      at,
      riskState: 'cleared',
    });
    if (!row) {
      const existing = await requirePartner(tx, input.partnerId);
      throw conflict(`Partner is ${existing.state}, not suspended`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: row.id,
      action: 'partner_reinstated',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/** Terminate enrollment — terminal for the record's standing, never a deletion. */
export async function terminatePartner(input: {
  partnerId: string;
  actorOxyUserId: string;
  reason: string;
  confirmedFraud: boolean;
  at?: Date;
}): Promise<ReferralPartnerRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionPartnerState(tx, {
      id: input.partnerId,
      expected: ['applied', 'invited', 'approved', 'suspended'],
      to: 'terminated',
      at,
      riskState: input.confirmedFraud ? 'confirmed_fraud' : undefined,
    });
    if (!row) {
      const existing = await requirePartner(tx, input.partnerId);
      if (existing.state === 'terminated') return existing;
      throw conflict(`Partner is ${existing.state} and cannot be terminated`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: row.id,
      action: 'partner_terminated',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

async function requirePartner(
  db: Parameters<typeof findPartnerById>[0],
  id: string,
): Promise<ReferralPartnerRow> {
  const row = await findPartnerById(db, id);
  if (!row) throw notFound('Referral partner not found');
  return row;
}
