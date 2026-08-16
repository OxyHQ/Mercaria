/**
 * Attribution creation and conflict resolution (#142, API 5).
 *
 * ## Last valid touch wins (ADR 0005 D4), and what that means as writes
 *
 * One ACTIVE attribution per (program, subject) — the partial unique index.
 * A newer valid touch SUPERSEDES the standing winner: the old row keeps every
 * byte of its losing evidence and moves to `superseded`; the new row is
 * inserted naming its predecessor (`supersedesAttributionId`), both inside one
 * transaction, in that order — resolve first, insert second, so the partial
 * unique index never sees two winners and the predecessor FK always resolves.
 * An older touch arriving late LOSES: the standing winner is retained and the
 * outcome says so. Ties on the evidence time resolve by touch id, descending —
 * arbitrary but deterministic, exactly as D4 pins.
 *
 * ## Refusals are RECORDED, not thrown
 *
 * A suspended partner losing NEW attribution (issue #142 §ReferralPartner) and
 * a retired program blocking NEW attribution (identity/uniqueness 7) are
 * ordinary outcomes a caller and a partner-support question both need answers
 * about — so they return `{outcome: 'refused', reason}` and append their
 * `referral_events` row, which COMMITS. A throw would roll the audit trail
 * back with the refusal, leaving "it silently didn't happen", the one thing
 * ADR 0005 D16 forbids. Historical records are untouched in both cases:
 * existing attributions keep converting per policy, which the conversion
 * service honors by never consulting partner state.
 *
 * ## What an attribution can never be created FROM
 *
 * The input is a TOUCH row — evidence recorded by `touch.service.ts` from the
 * three first-party kinds. There is no path from an email, a card, a phone
 * number, a device fingerprint or an affiliate click (#67) into this resolver,
 * because none of them can become a touch (A1/A2, and the closed touch-kind
 * CHECK).
 */

import type { ReferralConflictReason, ReferralSubjectKind } from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findActiveProgramVersion, findProgramVersionById } from '../../db/referrals/programRepository.js';
import { findPartnerById } from '../../db/referrals/partnerRepository.js';
import { findTouchById, type ReferralTouchRow } from '../../db/referrals/touchRepository.js';
import {
  closeAttribution,
  findActiveAttribution,
  findAttributionById,
  insertAttribution,
  type ReferralAttributionRow,
} from '../../db/referrals/attributionRepository.js';
import {
  insertSubjectRedirect,
  resolveSubjectRef,
} from '../../db/referrals/subjectRedirectRepository.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import { resolvePinnedRewardRuleRef } from './rewards/rule.service.js';
import { enforcementPermitsAttribution } from './integrity/effects.js';
import { readEnforcementEffects } from './integrity/enforcement.service.js';
import {
  assessSelfReferral,
  selfReferralPermitsAttribution,
} from './integrity/self-referral.js';
import { collectSelfReferralFacts } from './integrity/self-referral.service.js';
import { evaluateReferralPilotAdmission } from '../referral-pilot/pilot.service.js';

/** How the resolver answered. Every arm is an ANSWER, including the refusals. */
export type AttributionOutcome =
  | { outcome: 'created'; attribution: ReferralAttributionRow }
  | {
      outcome: 'superseded_previous';
      attribution: ReferralAttributionRow;
      superseded: ReferralAttributionRow;
    }
  | { outcome: 'retained_existing'; attribution: ReferralAttributionRow }
  | { outcome: 'refused'; reason: ReferralConflictReason };

/**
 * Resolve a recorded touch into the winner for its (program, subject) scope.
 */
export async function attributeTouch(touchId: string): Promise<AttributionOutcome> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const touch = await findTouchById(tx, touchId);
    if (!touch) throw notFound('Referral touch not found');
    if (touch.trafficClass !== 'organic') {
      throw validationError('A non-organic touch is never attribution-eligible');
    }
    const now = new Date();
    if (touch.attributionWindowExpiresAt.getTime() <= now.getTime()) {
      throw conflict('The touch is outside its attribution window');
    }

    // The pin happens at ATTRIBUTION time (ADR 0005 D19): the CURRENT active
    // version of the touch's program. A retired/paused/ended program has none
    // — rule 7's prospective block.
    const touchVersion = await findProgramVersionById(tx, touch.programVersionId);
    if (!touchVersion) throw notFound('Referral program version not found');
    const version = await findActiveProgramVersion(tx, touchVersion.programId);
    if (!version) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: touch.partnerId,
        action: 'attribution_refused',
        actorKind: 'system',
        reason: `Program ${touchVersion.programId} has no active version (touch ${touch.id})`,
      });
      return { outcome: 'refused', reason: 'program_retired' };
    }

    // A suspended partner loses NEW attribution; historical commissions
    // continue per policy — nothing here touches existing rows.
    const partner = await findPartnerById(tx, touch.partnerId);
    if (!partner) throw notFound('Referral partner not found');
    if (partner.state !== 'approved') {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: partner.id,
        action: 'attribution_refused',
        actorKind: 'system',
        reason: `Partner is ${partner.state} (touch ${touch.id})`,
      });
      return { outcome: 'refused', reason: 'partner_suspended' };
    }

    // #148: the SCOPED enforcement gate, read through the one derivation the
    // three gates share. It sits BELOW the partner-state check deliberately —
    // that check is #142's coarse posture and this is the granularity #148
    // adds, so a `new_attribution_suspension` refuses NEW attribution while
    // the partner's already-vested rewards keep settling (acceptance 2).
    const effects = await readEnforcementEffects(tx, partner.id, now);
    if (!enforcementPermitsAttribution(effects, version.programId)) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: partner.id,
        action: 'attribution_refused',
        actorKind: 'system',
        reason: `Enforcement suspends new attribution (touch ${touch.id})`,
      });
      return { outcome: 'refused', reason: 'enforcement_suspended' };
    }

    const subject = await deriveSubject(tx, touch, version.qualifyingEventPolicy);
    if (!version.eligibleSubjectKinds.includes(subject.subjectKind)) {
      throw validationError(
        `The program does not attribute ${subject.subjectKind} subjects`,
      );
    }

    // #148 / ADR 0005 D7: the self-referral detector, which the vocabulary has
    // carried since #142 with nothing computing it. THREE-valued, and only
    // `permitted` attributes — a `review` verdict refuses the attribution and
    // records the evidence, because attributing first and reviewing later
    // means a reward accrues on a conversion nobody has looked at.
    const selfReferral = assessSelfReferral(
      await collectSelfReferralFacts(tx, {
        partner,
        subject: {
          subjectKind: subject.subjectKind,
          oxyUserId: touch.oxyUserId,
          merchantId: touch.merchantCandidateRef,
        },
      }),
    );
    if (!selfReferralPermitsAttribution(selfReferral)) {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: partner.id,
        action: 'attribution_refused',
        actorKind: 'system',
        reason:
          `Self-referral ${selfReferral.verdict} on ` +
          `${'evidence' in selfReferral ? selfReferral.evidence.join(', ') : 'no evidence'} ` +
          `(touch ${touch.id})`,
      });
      return { outcome: 'refused', reason: 'self_referral' };
    }

    // #149: the BOUNDED PILOT gate, and the ONLY place it is called.
    //
    // It sits BELOW every #142/#148 check and ABOVE the winner comparison,
    // which is the position that makes acceptance 5 true: a pilot bound refuses
    // a NEW attribution and touches nothing that already exists, so a live stop
    // never supersedes a standing winner and never reaches a conversion, a
    // reward, a hold, a payout batch or an appeal. It is also the position that
    // costs least — the subject is already derived, so the entry count is the
    // only read this adds, and it is skipped entirely when no cohort is active.
    //
    // ONE refusal reason reaches the caller. Which of the nine bounds fired is
    // on the `referral_events` row: a caller that could tell "not allow-listed"
    // from "entry budget spent" could read the pilot's bounds out of it.
    const admission = await evaluateReferralPilotAdmission(
      {
        programId: version.programId,
        partnerId: partner.id,
        subjectKind: subject.subjectKind,
        // A touch carries no market — deliberately, since a market is a
        // property of an order rather than of a click — so a market-scoped stop
        // covers nothing today and the publish path refuses to create one.
        market: null,
        at: now,
      },
      tx,
    );
    if (admission.outcome === 'refused') {
      await appendReferralEvent(tx, {
        subjectType: 'partner',
        subjectId: partner.id,
        action: 'attribution_refused',
        actorKind: 'system',
        reason: `Pilot refused: ${admission.reason} (touch ${touch.id})`,
      });
      return { outcome: 'refused', reason: 'pilot_not_admitted' };
    }

    const scope = { programId: version.programId, ...subject };
    const existing = await findActiveAttribution(tx, scope);
    if (existing && !newTouchWins(touch, existing)) {
      return { outcome: 'retained_existing', attribution: existing };
    }

    const windowMs = version.attributionWindowDays * 24 * 60 * 60 * 1_000;
    // ADR 0005 D19: the rule VERSION is pinned here and nowhere later. The
    // program names a rule (`commission_rule_ref`); what an attribution records
    // is `<ruleId>@v<version>` for the version live at THIS moment, so a rate
    // change afterwards creates a new version that governs nothing already
    // attributed. A rule with no published version yet carries its bare ref
    // through — attribution is never blocked by an unpublished rule, and the
    // accrual refuses later with the recorded `no_pinned_rule_version`.
    const ruleVersionRef = await resolvePinnedRewardRuleRef(tx, version.commissionRuleRef);
    const create = {
      ...scope,
      programVersionId: version.id,
      partnerId: partner.id,
      winningTouchId: touch.id,
      winningCodeId: touch.codeId,
      evidenceTouchKind: touch.touchKind,
      evidenceOccurredAt: touch.occurredAt,
      attributionPolicy: version.attributionPolicy,
      ruleVersionRef,
      expiresAt: new Date(touch.occurredAt.getTime() + windowMs),
      originalActorKind: touch.actorKind,
    };

    if (existing) {
      const superseded = await closeAttribution(tx, {
        id: existing.id,
        to: 'superseded',
        conflictReason: 'competing_touch',
        at: now,
      });
      if (!superseded) {
        // A concurrent resolver got there first; the transaction retries from
        // a fresh read rather than guessing.
        throw conflict('The standing attribution changed while resolving — retry');
      }
      const inserted = await insertAttribution(tx, {
        ...create,
        supersedesAttributionId: existing.id,
      });
      if (inserted === null) {
        throw conflict('A concurrent attribution won this subject — retry');
      }
      await appendReferralEvent(tx, {
        subjectType: 'attribution',
        subjectId: existing.id,
        action: 'attribution_superseded',
        actorKind: 'system',
        reason: `Later touch ${touch.id} won under last_touch`,
      });
      await appendReferralEvent(tx, {
        subjectType: 'attribution',
        subjectId: inserted.id,
        action: 'attribution_created',
        actorKind: 'system',
        reason: `Touch ${touch.id} attributed ${subject.subjectKind} to partner ${partner.id}`,
      });
      return { outcome: 'superseded_previous', attribution: inserted, superseded };
    }

    const inserted = await insertAttribution(tx, create);
    if (inserted === null) {
      // The concurrent-create race: another resolver inserted between our read
      // and our write. Their row is the winner to compare against on retry.
      throw conflict('A concurrent attribution won this subject — retry');
    }
    await appendReferralEvent(tx, {
      subjectType: 'attribution',
      subjectId: inserted.id,
      action: 'attribution_created',
      actorKind: 'system',
      reason: `Touch ${touch.id} attributed ${subject.subjectKind} to partner ${partner.id}`,
    });
    return { outcome: 'created', attribution: inserted };
  });
}

/**
 * D4's comparison: strictly later evidence wins; an exact tie resolves by
 * touch id (descending), deterministically.
 */
function newTouchWins(touch: ReferralTouchRow, standing: ReferralAttributionRow): boolean {
  const newTime = touch.occurredAt.getTime();
  const standingTime = standing.evidenceOccurredAt.getTime();
  if (newTime !== standingTime) return newTime > standingTime;
  const standingTouchId = standing.winningTouchId;
  if (standingTouchId === null) return true;
  if (touch.id === standingTouchId) return false;
  return touch.id > standingTouchId;
}

/** Operator invalidation — the deterministic-identity void, never a score's. */
export async function invalidateAttribution(input: {
  attributionId: string;
  actorOxyUserId: string;
  reason: string;
  conflictReason?: Extract<ReferralConflictReason, 'self_referral' | 'operator_invalidation'>;
  at?: Date;
}): Promise<ReferralAttributionRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await closeAttribution(tx, {
      id: input.attributionId,
      to: 'invalidated',
      conflictReason: input.conflictReason ?? 'operator_invalidation',
      at,
    });
    if (!row) {
      const existing = await findAttributionById(tx, input.attributionId);
      if (!existing) throw notFound('Referral attribution not found');
      throw conflict(`The attribution is ${existing.state}, not active`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'attribution',
      subjectId: row.id,
      action: 'attribution_invalidated',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/**
 * Operator correction — append-only: the old row moves to `corrected`, and the
 * successor is a NEW row naming it through `supersedesAttributionId`, carrying
 * the corrected partner with every pinned term copied verbatim. Nothing else
 * is correctable: the subject, the evidence and the pinned versions are what
 * the record IS.
 */
export async function correctAttribution(input: {
  attributionId: string;
  correctedPartnerId: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<{ corrected: ReferralAttributionRow; successor: ReferralAttributionRow }> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const existing = await findAttributionById(tx, input.attributionId);
    if (!existing) throw notFound('Referral attribution not found');
    if (existing.state !== 'active') {
      throw conflict(`The attribution is ${existing.state}, not active`);
    }
    const partner = await findPartnerById(tx, input.correctedPartnerId);
    if (!partner) throw notFound('Corrected partner not found');

    const corrected = await closeAttribution(tx, {
      id: existing.id,
      to: 'corrected',
      conflictReason: 'operator_correction',
      at,
    });
    if (!corrected) throw conflict('The attribution changed while correcting — retry');

    const successor = await insertAttribution(tx, {
      supersedesAttributionId: existing.id,
      programId: existing.programId,
      subjectKind: existing.subjectKind,
      subjectRef: existing.subjectRef,
      programVersionId: existing.programVersionId,
      partnerId: partner.id,
      winningTouchId: existing.winningTouchId ?? undefined,
      winningCodeId: existing.winningCodeId,
      evidenceTouchKind: existing.evidenceTouchKind,
      evidenceOccurredAt: existing.evidenceOccurredAt,
      attributionPolicy: existing.attributionPolicy,
      ruleVersionRef: existing.ruleVersionRef,
      expiresAt: existing.expiresAt,
      originalActorKind: existing.originalActorKind,
    });
    if (successor === null) {
      throw conflict('A concurrent attribution holds this subject — retry');
    }
    await appendReferralEvent(tx, {
      subjectType: 'attribution',
      subjectId: existing.id,
      action: 'attribution_corrected',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return { corrected, successor };
  });
}

/**
 * Record an identity-merge redirect (issue #142, identity/uniqueness 6).
 * History keeps its references; reads and new attributions resolve through the
 * redirect. Idempotent on an identical re-record.
 */
export async function recordSubjectMerge(input: {
  subjectKind: ReferralSubjectKind;
  fromRef: string;
  toRef: string;
  actorOxyUserId: string;
  reason: string;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const row = await insertSubjectRedirect(tx, {
      subjectKind: input.subjectKind,
      fromRef: input.fromRef,
      toRef: input.toRef,
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    if (row === null) {
      throw conflict(`${input.subjectKind}:${input.fromRef} already redirects somewhere`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'attribution',
      subjectId: row.id,
      action: 'subject_merge_redirected',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
  });
}

/**
 * Derive the referred SUBJECT from a touch, resolved through merge redirects.
 * A merchant-activation program refers the merchant candidate; everything else
 * refers the acting identity — guest checkout scope or Oxy account.
 */
async function deriveSubject(
  db: DatabaseOrTransaction,
  touch: ReferralTouchRow,
  qualifyingEventPolicy: string,
): Promise<{ subjectKind: ReferralSubjectKind; subjectRef: string }> {
  if (qualifyingEventPolicy === 'merchant_activation') {
    if (touch.merchantCandidateRef === null) {
      throw validationError('A merchant-referral touch carries no merchant candidate');
    }
    return {
      subjectKind: 'merchant',
      subjectRef: await resolveSubjectRef(db, 'merchant', touch.merchantCandidateRef),
    };
  }
  if (touch.actorKind === 'oxy_user') {
    if (touch.oxyUserId === null) {
      throw validationError('An oxy_user touch carries no Oxy user id');
    }
    return {
      subjectKind: 'oxy_user',
      subjectRef: await resolveSubjectRef(db, 'oxy_user', touch.oxyUserId),
    };
  }
  if (touch.guestSessionRef === null) {
    throw validationError('A guest touch carries no guest session reference');
  }
  return {
    subjectKind: 'guest_checkout',
    subjectRef: await resolveSubjectRef(db, 'guest_checkout', touch.guestSessionRef),
  };
}
