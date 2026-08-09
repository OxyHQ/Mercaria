/**
 * Conversion upsert from durable source events (#142, API 6).
 *
 * ## No client-created paid state
 *
 * The ONLY input is a durable source event named by its aggregate and event id
 * — the payment domain's "verified provider evidence" posture: the callers are
 * internal services holding a fact that already committed (a payment-success
 * processing, a merchant activation), never an HTTP body. Nothing here is
 * mounted on a route.
 *
 * ## Replay is convergence
 *
 * The idempotency key is deterministic from the source event
 * (`conversionIdempotencyKey`), so an outbox retry, a redelivered webhook
 * consequence or a reconciliation sweep re-deriving the fact lands on the row
 * it already made — asserted against a real database, not assumed. One source
 * event pays one partner: the second unique index refuses a different
 * attribution claiming the same event (identity/uniqueness 5 — no split at
 * launch).
 *
 * ## A guest claim creates NOTHING here (ADR 0005 D6/A3)
 *
 * When a guest purchase is later claimed into an Oxy account (#109), the claim
 * moves the ORDER. The attribution does not move and this service is not
 * called again with a new event id — and if the claim flow replays the
 * original source event, the idempotency key converges on the one conversion
 * that already exists. One attribution, one conversion, however many times the
 * order changes hands.
 *
 * ## Historical commissions continue for a suspended partner
 *
 * Deliberately NO partner-state read anywhere in this file: suspension gates
 * NEW attribution (in `attribution.service.ts`), while a conversion against an
 * attribution that already exists keeps flowing per policy (issue #142
 * §ReferralPartner). Withholding money a partner already earned is #145/#146's
 * payout-gate decision, not a conversion fact.
 */

import type {
  ReferralConversionReasonCode,
  ReferralConversionType,
} from '@mercaria/shared-types';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import {
  attributionCanConvertAt,
  findAttributionById,
} from '../../db/referrals/attributionRepository.js';
import {
  findConversionById,
  transitionConversionState,
  upsertConversion,
  type ConversionSourceEvent,
  type ReferralConversionRow,
} from '../../db/referrals/conversionRepository.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';

/**
 * Record a conversion from a durable source event, converging on a replay.
 *
 * An attribution past its window or no longer active still RECORDS the
 * conversion — as `rejected` with the bounded reason — because an effect that
 * did not happen must be distinguishable from one that silently vanished
 * (ADR 0005 D16).
 */
export async function recordConversionFromSourceEvent(
  input: ConversionSourceEvent & {
    attributionId: string;
    conversionType: ReferralConversionType;
    occurredAt: Date;
    revenueBaseRef?: string;
  },
): Promise<{ conversion: ReferralConversionRow; created: boolean }> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const attribution = await findAttributionById(tx, input.attributionId);
    if (!attribution) throw notFound('Referral attribution not found');

    const convertible = attributionCanConvertAt(attribution, input.occurredAt);
    const reasonCode: ReferralConversionReasonCode | undefined = convertible
      ? undefined
      : attribution.state === 'active'
        ? 'attribution_expired'
        : 'other';

    const { row, created } = await upsertConversion(tx, {
      attributionId: attribution.id,
      programVersionId: attribution.programVersionId,
      conversionType: input.conversionType,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      sourceEventId: input.sourceEventId,
      occurredAt: input.occurredAt,
      state: convertible ? 'pending' : 'rejected',
      reasonCode,
      revenueBaseRef: input.revenueBaseRef,
    });
    if (created) {
      await appendReferralEvent(tx, {
        subjectType: 'conversion',
        subjectId: row.id,
        action: 'conversion_recorded',
        actorKind: 'system',
        reason: `${input.sourceKind} event ${input.sourceEventId} → ${row.state}`,
      });
    } else if (row.attributionId !== input.attributionId) {
      // The same source event arriving for a DIFFERENT attribution is not a
      // replay — it is two derivers disagreeing, and convergence would hide it.
      throw conflict(
        `Source event ${input.sourceEventId} already converted under attribution ${row.attributionId}`,
      );
    }
    return { conversion: row, created };
  });
}

/** Mark a pending conversion verified-eligible, from a durable verification. */
export async function verifyConversion(input: {
  conversionId: string;
  at?: Date;
  revenueBaseRef?: string;
}): Promise<ReferralConversionRow> {
  return await transition({
    conversionId: input.conversionId,
    expected: ['pending'],
    to: 'eligible',
    at: input.at,
    action: 'conversion_verified',
    reason: 'Source milestone verified',
    revenueBaseRef: input.revenueBaseRef,
  });
}

/** Reject a pending conversion with its bounded reason. */
export async function rejectConversion(input: {
  conversionId: string;
  reasonCode: ReferralConversionReasonCode;
  reason: string;
  at?: Date;
}): Promise<ReferralConversionRow> {
  return await transition({
    conversionId: input.conversionId,
    expected: ['pending'],
    to: 'rejected',
    at: input.at,
    action: 'conversion_rejected',
    reason: input.reason,
    reasonCode: input.reasonCode,
  });
}

/**
 * Reverse an eligible conversion — the funding ceased to exist (a refund, a
 * fraud invalidation). The row stays; the reversal is its state and reason.
 */
export async function reverseConversion(input: {
  conversionId: string;
  reasonCode: Extract<ReferralConversionReasonCode, 'refund_reversed' | 'fraud_invalidated'>;
  reason: string;
  at?: Date;
}): Promise<ReferralConversionRow> {
  return await transition({
    conversionId: input.conversionId,
    expected: ['eligible', 'pending'],
    to: 'reversed',
    at: input.at,
    action: 'conversion_reversed',
    reason: input.reason,
    reasonCode: input.reasonCode,
  });
}

async function transition(input: {
  conversionId: string;
  expected: readonly ('pending' | 'eligible')[];
  to: 'eligible' | 'rejected' | 'reversed';
  at?: Date;
  action: 'conversion_verified' | 'conversion_rejected' | 'conversion_reversed';
  reason: string;
  reasonCode?: ReferralConversionReasonCode;
  revenueBaseRef?: string;
}): Promise<ReferralConversionRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionConversionState(tx, {
      id: input.conversionId,
      expected: input.expected,
      to: input.to,
      at,
      reasonCode: input.reasonCode,
      revenueBaseRef: input.revenueBaseRef,
    });
    if (!row) {
      const existing = await findConversionById(tx, input.conversionId);
      if (!existing) throw notFound('Referral conversion not found');
      if (existing.state === input.to) return existing;
      throw conflict(`The conversion is ${existing.state} and cannot become ${input.to}`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'conversion',
      subjectId: row.id,
      action: input.action,
      actorKind: 'system',
      reason: input.reason,
    });
    return row;
  });
}
