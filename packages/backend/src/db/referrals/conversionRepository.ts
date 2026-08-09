/**
 * Reads and writes for `referral_conversions` — verified milestones, derived
 * only from durable source events.
 *
 * The insert is idempotent BY CONSTRUCTION: the idempotency key is
 * deterministic from the source event and the insert is
 * `onConflictDoNothing` on it plus a re-read, so a redelivered source event —
 * an outbox retry, a reconciliation sweep re-deriving the same fact — converges
 * on the row it already made. The `moderation_outboxes` discipline: a repeat is
 * a genuine no-op, not a write contending with anything.
 *
 * State transitions are single-statement CAS from expected states, each
 * carrying the bounded reason the CHECKs demand.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  ReferralConversionReasonCode,
  ReferralConversionSource,
  ReferralConversionState,
  ReferralConversionType,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralConversions } from '../schema/referrals.js';

/** A conversion row as the services read it back. */
export type ReferralConversionRow = typeof referralConversions.$inferSelect;

/** The durable source event a conversion is derived from. */
export interface ConversionSourceEvent {
  sourceKind: ReferralConversionSource;
  sourceRef: string;
  sourceEventId: string;
}

/**
 * The deterministic idempotency key for a source event — stated ONCE, here,
 * so every deriver and every test computes the same spelling.
 */
export function conversionIdempotencyKey(source: ConversionSourceEvent): string {
  return `refconv:${source.sourceKind}:${source.sourceEventId}`;
}

export async function findConversionByIdempotencyKey(
  db: DatabaseOrTransaction,
  idempotencyKey: string,
): Promise<ReferralConversionRow | undefined> {
  const [row] = await db
    .select()
    .from(referralConversions)
    .where(eq(referralConversions.idempotencyKey, idempotencyKey));
  return row;
}

/**
 * Record a conversion, converging on the row a replay already made.
 *
 * `onConflictDoNothing` is deliberately ARBITER-LESS: this table carries TWO
 * unique indexes over the same fact (the idempotency key, which is DERIVED
 * from `(source_kind, source_event_id)`, and the source-event key itself), and
 * Postgres checks them in no deterministic order — a `DO NOTHING` targeting
 * only one would let a legitimate concurrent replay RAISE on the other,
 * intermittently. Measured: the targeted form flaked exactly that way under
 * two concurrent derivations. Because the key is deterministic, any conflict
 * on either index is the same fact ("this source event is already recorded"),
 * so skipping on both is convergence, not a swallowed disagreement — and a
 * divergent DERIVATION (same event, different attribution) still surfaces,
 * because the caller compares the surviving row's attribution after the
 * re-read.
 */
export async function upsertConversion(
  db: DatabaseOrTransaction,
  input: ConversionSourceEvent & {
    attributionId: string;
    programVersionId: string;
    conversionType: ReferralConversionType;
    occurredAt: Date;
    state: Extract<ReferralConversionState, 'pending' | 'rejected'>;
    reasonCode?: ReferralConversionReasonCode;
    revenueBaseRef?: string;
  },
): Promise<{ row: ReferralConversionRow; created: boolean }> {
  const idempotencyKey = conversionIdempotencyKey(input);
  const [inserted] = await db
    .insert(referralConversions)
    .values({
      attributionId: input.attributionId,
      programVersionId: input.programVersionId,
      conversionType: input.conversionType,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      sourceEventId: input.sourceEventId,
      idempotencyKey,
      occurredAt: input.occurredAt,
      state: input.state,
      reasonCode: input.reasonCode ?? null,
      revenueBaseRef: input.revenueBaseRef ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, created: true };

  const existing = await findConversionByIdempotencyKey(db, idempotencyKey);
  if (!existing) {
    throw new Error(
      `referral_conversions upsert for ${idempotencyKey} conflicted with a row that then ` +
        'could not be read back.',
    );
  }
  return { row: existing, created: false };
}

export async function findConversionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralConversionRow | undefined> {
  const [row] = await db
    .select()
    .from(referralConversions)
    .where(eq(referralConversions.id, id));
  return row;
}

/**
 * One conversion-state transition, as a CAS from a SET of expected states.
 * The reason and verification time travel with the transitions that define
 * them, matching the table's own CHECKs.
 */
export async function transitionConversionState(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralConversionState[];
    to: ReferralConversionState;
    at: Date;
    reasonCode?: ReferralConversionReasonCode;
    correctedByConversionId?: string;
    revenueBaseRef?: string;
  },
): Promise<ReferralConversionRow | undefined> {
  const [row] = await db
    .update(referralConversions)
    .set({
      state: input.to,
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      ...(input.to === 'eligible' ? { verifiedAt: input.at } : {}),
      ...(input.correctedByConversionId !== undefined
        ? { correctedByConversionId: input.correctedByConversionId }
        : {}),
      ...(input.revenueBaseRef !== undefined ? { revenueBaseRef: input.revenueBaseRef } : {}),
    })
    .where(
      and(
        eq(referralConversions.id, input.id),
        inArray(referralConversions.state, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/** An attribution's conversions, newest first. */
export async function listConversionsByAttribution(
  db: DatabaseOrTransaction,
  attributionId: string,
): Promise<ReferralConversionRow[]> {
  return await db
    .select()
    .from(referralConversions)
    .where(eq(referralConversions.attributionId, attributionId))
    .orderBy(desc(referralConversions.createdAt));
}
