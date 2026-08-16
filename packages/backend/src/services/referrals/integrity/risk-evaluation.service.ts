/**
 * Measuring a partner's behaviour, and recording what was measured (#148
 * "Risk signals", ADR 0005 D17).
 *
 * ## Everything it reads is Mercaria's own commerce record
 *
 * Touches this domain wrote, conversions it verified, rewards it accrued,
 * enforcement it imposed. Not one query in this file reads a request header, a
 * cookie, an IP, a user agent or anything from the payment domain but an
 * OUTCOME already recorded as a conversion state. That is D17's other half:
 * *"fraud evaluation reads Mercaria's own commerce facts — orders, refunds,
 * disputes, memberships, velocities. It never builds or consults a device or
 * contact fingerprint."*
 *
 * ## The FACTS type is the wall
 *
 * `collectRiskSignalFacts` returns a `ReferralRiskSignalFacts`, which has a
 * field for every permitted signal and none for any forbidden one. So the
 * detector in `risk-thresholds.ts` is pure and cannot be handed an identifier
 * even by a future caller that wanted to — there is no parameter to put one in.
 *
 * ## An UNMEASURED fact is left out, never zeroed
 *
 * A partner with no conversions in the window gets `conversionsInWindow: 0`
 * (which IS a measurement — we counted and found none) and NO refund rate at
 * all (which is not: a rate over zero conversions is undefined, and a zero
 * would put a clean refund rate on a record that has none). The sample floor in
 * `risk-thresholds.ts` is the second half of the same rule.
 *
 * ## Recording is not enforcing
 *
 * This service writes `referral_risk_signals` and NOTHING else. It imposes no
 * action, freezes no reward and suspends nobody — a signal is a reason to look.
 * `referral_enforcement_actions_forfeiture_basis_check` is what makes that
 * safe: an action built on these can never destroy money, whatever a future
 * caller decides to do with them.
 */

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type {
  ReferralRiskSignalFacts,
  ReferralRiskSubjectType,
} from '@mercaria/shared-types';
import { REFERRAL_RETENTION_POLICY } from '@mercaria/shared-types';
import { notFound } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import { findPartnerById } from '../../../db/referrals/partnerRepository.js';
import {
  referralAttributions,
  referralConversions,
  referralTouches,
} from '../../../db/schema/referrals.js';
import { referralEnforcementActions } from '../../../db/schema/referralIntegrity.js';
import {
  insertRiskSignals,
  type NewReferralRiskSignal,
  type ReferralRiskSignalRow,
} from '../../../db/referralIntegrity/riskSignalRepository.js';
import {
  deriveRiskSignals,
  REFERRAL_RISK_THRESHOLD_DEFAULTS,
  type ReferralRiskThresholds,
} from './risk-thresholds.js';

/** The window every velocity threshold is measured over. ADR 0005 D17: per DAY. */
const WINDOW_MS = 24 * 60 * 60 * 1_000;

/** 10_000 basis points is 100%. */
const BPS = 10_000;

/** How long a recorded signal is kept — `REFERRAL_RETENTION_POLICY.risk_signal`. */
const SIGNAL_RETENTION_DAYS = REFERRAL_RETENTION_POLICY.risk_signal.sweptAfterDays ?? 400;

/**
 * The conversion states that mean the money came back.
 *
 * `reversed` is #142's state for a conversion whose funding was undone — a
 * refund or a lost dispute. `rejected` is a conversion that never qualified,
 * which is a different fact and is deliberately NOT counted as a refund: a
 * partner whose conversions are refused for `zero_base` has an ineligible
 * cohort, not a refunding one, and folding the two would report the honest
 * retail referrer as a fraud risk.
 */
const REVERSED_CONVERSION_STATES = ['reversed'] as const;

/**
 * Measure one partner over the trailing window.
 *
 * Four bounded aggregates, all scoped to the partner: this is not a sweep and
 * it does not scan the table. Every one of them counts rows this domain wrote.
 */
export async function collectRiskSignalFacts(
  db: DatabaseOrTransaction,
  input: { partnerId: string; at: Date },
): Promise<ReferralRiskSignalFacts> {
  const windowStart = new Date(input.at.getTime() - WINDOW_MS);

  const [touchRow] = await db
    .select({ total: sql<string>`count(*)` })
    .from(referralTouches)
    .where(
      and(
        eq(referralTouches.partnerId, input.partnerId),
        gte(referralTouches.occurredAt, windowStart),
        lt(referralTouches.occurredAt, input.at),
      ),
    );

  const [conversionRow] = await db
    .select({
      total: sql<string>`count(*)`,
      reversed: sql<string>`count(*) filter (where ${inArray(
        referralConversions.state,
        [...REVERSED_CONVERSION_STATES],
      )})`,
    })
    .from(referralConversions)
    .innerJoin(
      referralAttributions,
      eq(referralConversions.attributionId, referralAttributions.id),
    )
    .where(
      and(
        eq(referralAttributions.partnerId, input.partnerId),
        gte(referralConversions.occurredAt, windowStart),
        lt(referralConversions.occurredAt, input.at),
      ),
    );

  const [priorRow] = await db
    .select({ total: sql<string>`count(*)` })
    .from(referralEnforcementActions)
    .where(
      and(
        eq(referralEnforcementActions.partnerId, input.partnerId),
        inArray(referralEnforcementActions.basis, ['identity_evidence', 'operator_finding']),
      ),
    );

  // postgres.js decodes `count(*)` (an int8) as a STRING, and drizzle types it
  // `number`. `Number(...)` at the boundary, once, rather than at each use —
  // a missed coercion here is arithmetic on a string, which concatenates
  // silently and reports a velocity of "0500".
  const touches = Number(touchRow?.total ?? 0);
  const conversions = Number(conversionRow?.total ?? 0);
  const reversed = Number(conversionRow?.reversed ?? 0);
  const priorEnforcement = Number(priorRow?.total ?? 0);

  const facts: ReferralRiskSignalFacts = {
    touchesInWindow: touches,
    conversionsInWindow: conversions,
    priorConfirmedEnforcementCount: priorEnforcement,
  };
  // A rate over zero conversions is UNDEFINED, not zero — see the docblock.
  // Left off the object entirely rather than set to 0, because `undefined`
  // means "not measured" everywhere in this domain and `0` would assert a
  // clean cohort nobody counted.
  if (conversions > 0) {
    return { ...facts, refundRateBps: Math.round((reversed * BPS) / conversions) };
  }
  return facts;
}

/**
 * Measure a partner and record whatever fired.
 *
 * Returns the rows written, which may legitimately be EMPTY — a partner within
 * every threshold produces no signals, and writing a "nothing found" row would
 * make the signal table a heartbeat with the findings buried in it. The
 * `referral_events` row is written only when something fired, for the same
 * reason.
 */
export async function evaluatePartnerRisk(input: {
  partnerId: string;
  at?: Date;
  thresholds?: ReferralRiskThresholds;
}): Promise<readonly ReferralRiskSignalRow[]> {
  const at = input.at ?? new Date();
  const thresholds = input.thresholds ?? REFERRAL_RISK_THRESHOLD_DEFAULTS;
  const db = getDb();

  return await db.transaction(async (tx) => {
    const partner = await findPartnerById(tx, input.partnerId);
    if (!partner) throw notFound('Referral partner not found');

    const facts = await collectRiskSignalFacts(tx, { partnerId: input.partnerId, at });
    const derived = deriveRiskSignals(facts, thresholds);
    if (derived.length === 0) return [];

    const windowStart = new Date(at.getTime() - WINDOW_MS);
    const expiresAt = new Date(at.getTime() + SIGNAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    const rows = await insertRiskSignals(
      tx,
      derived.map(
        (signal): NewReferralRiskSignal => ({
          partnerId: input.partnerId,
          subjectType: 'partner' satisfies ReferralRiskSubjectType,
          subjectId: input.partnerId,
          kind: signal.kind,
          severity: signal.severity,
          observedValue: signal.observedValue,
          thresholdValue: signal.thresholdValue,
          windowStart,
          windowEnd: at,
          recordedByKind: 'system',
          expiresAt,
        }),
      ),
    );

    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_risk_signal_recorded',
      actorKind: 'system',
      reason: `${rows.length} signal(s): ${derived.map((s) => s.kind).join(', ')}`,
    });
    return rows;
  });
}

/**
 * Record one signal an OPERATOR observed by hand.
 *
 * `manual_evidence` is the only kind whose CHECK requires an operator, and this
 * is the only writer that supplies one — a system-recorded "manual evidence"
 * would let an automated sweep produce the one kind a reviewer trusts most.
 */
export async function recordManualRiskSignal(input: {
  partnerId: string;
  subjectType: ReferralRiskSubjectType;
  subjectId: string;
  note: string;
  evidenceRef?: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralRiskSignalRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const partner = await findPartnerById(tx, input.partnerId);
    if (!partner) throw notFound('Referral partner not found');
    const [row] = await insertRiskSignals(tx, [
      {
        partnerId: input.partnerId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        kind: 'manual_evidence',
        severity: 'informational',
        observedValue: 1,
        windowStart: at,
        windowEnd: at,
        evidenceRef: input.evidenceRef,
        recordedByKind: 'operator',
        recordedByOxyUserId: input.actorOxyUserId,
        note: input.note.trim(),
        expiresAt: new Date(at.getTime() + SIGNAL_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
      },
    ]);
    await appendReferralEvent(tx, {
      subjectType: 'partner',
      subjectId: input.partnerId,
      action: 'partner_risk_signal_recorded',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `manual_evidence on ${input.subjectType}`,
    });
    return row;
  });
}
