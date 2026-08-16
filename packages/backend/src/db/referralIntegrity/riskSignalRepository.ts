/**
 * Reads and writes for `referral_risk_signals` (#148 "Risk signals").
 *
 * There is no UPDATE function — the table's trigger refuses one anyway, and a
 * function that could only ever raise is worse than none. There IS no delete
 * function either: deletion here is the shared expiry sweep's, driven off
 * `expires_at` through `db/expiryTargets.ts`, which is the one place retention
 * is expressed so a second deleter cannot disagree with the policy.
 *
 * Every function takes and returns COUNTS, RATES and ROW IDS. Nothing in this
 * file has a parameter that could carry an email, a card, an address or a
 * device — the columns do not exist, which is the enforcement.
 */

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type {
  ReferralRiskSignalKind,
  ReferralRiskSignalSeverity,
  ReferralRiskSubjectType,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralRiskSignals } from '../schema/referralIntegrity.js';

/** A signal row as the services read it back. */
export type ReferralRiskSignalRow = typeof referralRiskSignals.$inferSelect;

/** How many signals one read may return. */
const SIGNAL_PAGE_LIMIT = 200;

/** What one recorded signal carries. */
export interface NewReferralRiskSignal {
  partnerId: string;
  subjectType: ReferralRiskSubjectType;
  subjectId: string;
  programId?: string;
  kind: ReferralRiskSignalKind;
  severity: ReferralRiskSignalSeverity;
  observedValue: number;
  thresholdValue?: number;
  windowStart: Date;
  windowEnd: Date;
  evidenceRef?: string;
  recordedByKind: 'system' | 'operator';
  recordedByOxyUserId?: string;
  note?: string;
  expiresAt: Date;
}

/**
 * Record signals.
 *
 * A batch insert rather than one call per signal: a single evaluation of one
 * partner produces several, and writing them one at a time would let a failure
 * halfway leave a review case whose evidence is the first three of five
 * reasons — which reads, to whoever opens it, exactly like a partner with three
 * problems rather than five.
 */
export async function insertRiskSignals(
  db: DatabaseOrTransaction,
  signals: readonly NewReferralRiskSignal[],
): Promise<ReferralRiskSignalRow[]> {
  if (signals.length === 0) return [];
  return await db
    .insert(referralRiskSignals)
    .values(
      signals.map((signal) => ({
        partnerId: signal.partnerId,
        subjectType: signal.subjectType,
        subjectId: signal.subjectId,
        programId: signal.programId ?? null,
        kind: signal.kind,
        severity: signal.severity,
        observedValue: signal.observedValue,
        thresholdValue: signal.thresholdValue ?? null,
        windowStart: signal.windowStart,
        windowEnd: signal.windowEnd,
        evidenceRef: signal.evidenceRef ?? null,
        recordedByKind: signal.recordedByKind,
        recordedByOxyUserId: signal.recordedByOxyUserId ?? null,
        note: signal.note ?? null,
        expiresAt: signal.expiresAt,
      })),
    )
    .returning();
}

/** One partner's signals, newest first. */
export async function findRiskSignalsForPartner(
  db: DatabaseOrTransaction,
  partnerId: string,
  since?: Date,
): Promise<ReferralRiskSignalRow[]> {
  const predicate =
    since === undefined
      ? eq(referralRiskSignals.partnerId, partnerId)
      : and(
          eq(referralRiskSignals.partnerId, partnerId),
          gte(referralRiskSignals.createdAt, since),
        );
  return await db
    .select()
    .from(referralRiskSignals)
    .where(predicate)
    .orderBy(desc(referralRiskSignals.createdAt))
    .limit(SIGNAL_PAGE_LIMIT);
}

/**
 * Signals by id — what an enforcement action's `evidence_signal_ids` resolve
 * to, for an operator reading the case.
 *
 * A row that has passed its retention and been swept resolves to NOTHING, and
 * the caller reports the gap rather than filling it. That is the division
 * `REFERRAL_RETENTION_POLICY` draws deliberately: the DECISION outlives the
 * working papers, so an action stays explicable after its evidence expires.
 */
export async function findRiskSignalsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<ReferralRiskSignalRow[]> {
  if (ids.length === 0) return [];
  return await db
    .select()
    .from(referralRiskSignals)
    .where(inArray(referralRiskSignals.id, [...ids]))
    .orderBy(desc(referralRiskSignals.createdAt));
}
