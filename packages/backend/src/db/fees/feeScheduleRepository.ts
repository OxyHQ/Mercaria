/**
 * `fee_schedules` and `fee_schedule_acceptances` — versioned policy rows and
 * their append-only acceptance audit trail (#88).
 *
 * ## The lifecycle writes are compare-and-swaps, like every guarded write here
 *
 * Activation and retirement CAS on the CURRENT status (`CONVENTIONS.md`: a
 * conditional write stays ONE statement), so two operators racing the same
 * button produce exactly one activation. Activation also SUPERSEDES the
 * previous active version of the same key inside the same transaction and
 * BEFORE the new one flips to active — the partial unique index
 * `fee_schedules_one_active_per_key` refuses any ordering that would leave two
 * active rows, so the sequence is load-bearing, not stylistic.
 *
 * The database triggers (`fee_schedules_immutable_once_active`,
 * `mercaria_fee_record_append_only`) are the enforcement that survives callers
 * that never reach this file; this repository is merely the polite writer.
 */

import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type {
  CurrencyCode,
  FeeRefundPolicy,
  FeeTaxTreatment,
  OrderSellerType,
  ProviderAccountOwnerType,
} from '@mercaria/shared-types';
import { feeScheduleAcceptances, feeSchedules } from '../schema/fees.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `fee_schedules`. */
export type FeeScheduleRow = typeof feeSchedules.$inferSelect;

/** One row of `fee_schedule_acceptances`. */
export type FeeScheduleAcceptanceRow = typeof feeScheduleAcceptances.$inferSelect;

/** A new DRAFT version, as the operator surface supplies it. */
export interface NewFeeSchedule {
  scheduleKey: string;
  version: number;
  name: string;
  merchantSummary: string;
  effectiveStart: Date;
  effectiveEnd?: Date;
  eligibleSellerType?: OrderSellerType;
  eligibleCurrency?: CurrencyCode;
  percentageBps: number;
  fixedFee?: { amount: number; currency: CurrencyCode };
  minFeeMinor?: number;
  maxFeeMinor?: number;
  taxTreatment?: FeeTaxTreatment;
  refundPolicy?: FeeRefundPolicy;
  termsVersion: string;
  createdByOxyUserId: string;
}

/** Insert one draft version. The CHECKs and unique indexes do the arguing. */
export async function insertFeeSchedule(
  db: DatabaseOrTransaction,
  input: NewFeeSchedule,
): Promise<FeeScheduleRow> {
  const [row] = await db
    .insert(feeSchedules)
    .values({
      scheduleKey: input.scheduleKey,
      version: input.version,
      name: input.name,
      merchantSummary: input.merchantSummary,
      effectiveStart: input.effectiveStart,
      ...(input.effectiveEnd ? { effectiveEnd: input.effectiveEnd } : {}),
      ...(input.eligibleSellerType ? { eligibleSellerType: input.eligibleSellerType } : {}),
      ...(input.eligibleCurrency ? { eligibleCurrency: input.eligibleCurrency } : {}),
      percentageBps: input.percentageBps,
      ...(input.fixedFee
        ? { fixedFeeAmount: input.fixedFee.amount, fixedFeeCurrency: input.fixedFee.currency }
        : {}),
      ...(input.minFeeMinor !== undefined ? { minFeeMinor: input.minFeeMinor } : {}),
      ...(input.maxFeeMinor !== undefined ? { maxFeeMinor: input.maxFeeMinor } : {}),
      ...(input.taxTreatment ? { taxTreatment: input.taxTreatment } : {}),
      ...(input.refundPolicy ? { refundPolicy: input.refundPolicy } : {}),
      termsVersion: input.termsVersion,
      createdByOxyUserId: input.createdByOxyUserId,
    })
    .returning();
  if (!row) {
    throw new Error(
      `Inserting fee schedule ${input.scheduleKey} v${String(input.version)} returned no row.`,
    );
  }
  return row;
}

/** One version by its row id, or `undefined`. */
export async function findFeeScheduleById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<FeeScheduleRow | undefined> {
  const [row] = await db.select().from(feeSchedules).where(eq(feeSchedules.id, id)).limit(1);
  return row;
}

/** Every version, oldest first — the operator listing. */
export async function listFeeSchedules(
  db: DatabaseOrTransaction,
  filter?: { scheduleKey?: string },
): Promise<FeeScheduleRow[]> {
  const base = db.select().from(feeSchedules);
  const query = filter?.scheduleKey
    ? base.where(eq(feeSchedules.scheduleKey, filter.scheduleKey))
    : base;
  return await query.orderBy(asc(feeSchedules.scheduleKey), asc(feeSchedules.version));
}

/**
 * Every ACTIVE version whose effective window contains `at` — what checkout's
 * schedule selection reads. The table is small (versions of a handful of
 * policies), so this is one indexed read per checkout, not per order.
 */
export async function listActiveFeeSchedules(
  db: DatabaseOrTransaction,
  at: Date,
): Promise<FeeScheduleRow[]> {
  return await db
    .select()
    .from(feeSchedules)
    .where(
      and(
        eq(feeSchedules.status, 'active'),
        lte(feeSchedules.effectiveStart, at),
        or(isNull(feeSchedules.effectiveEnd), gt(feeSchedules.effectiveEnd, at)),
      ),
    )
    .orderBy(asc(feeSchedules.scheduleKey), asc(feeSchedules.version));
}

/**
 * Activate one draft version, superseding the key's current active version.
 *
 * @returns The activated row, or `undefined` when the CAS matched nothing —
 *   the row is not a draft (already activated, or retired), which the caller
 *   reports rather than retries.
 */
export async function activateFeeSchedule(
  db: DatabaseOrTransaction,
  input: { id: string; approvedByOxyUserId: string; at?: Date },
): Promise<FeeScheduleRow | undefined> {
  return await db.transaction(async (tx) => {
    // Lock the target row FIRST and re-read its status inside the transaction:
    // two operators activating the same draft serialize here, and the loser sees
    // `active` and reports "nothing to do" instead of superseding anything. The
    // supersede below must run before the flip because the partial unique index
    // allows at most one active row per key — and it must never run for a target
    // that is not a draft, which is what this guard is for.
    const [current] = await tx
      .select()
      .from(feeSchedules)
      .where(eq(feeSchedules.id, input.id))
      .limit(1)
      .for('update');
    if (!current || current.status !== 'draft') return undefined;

    await tx
      .update(feeSchedules)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(feeSchedules.scheduleKey, current.scheduleKey),
          eq(feeSchedules.status, 'active'),
        ),
      );

    const [activated] = await tx
      .update(feeSchedules)
      .set({
        status: 'active',
        approvedByOxyUserId: input.approvedByOxyUserId,
        activatedAt: input.at ?? new Date(),
      })
      .where(and(eq(feeSchedules.id, input.id), eq(feeSchedules.status, 'draft')))
      .returning();
    return activated;
  });
}

/**
 * Retire one version — an active one being withdrawn without a replacement, or
 * a draft being abandoned. A superseded version stays `superseded`: it was
 * replaced, which is a different fact than withdrawn.
 */
export async function retireFeeSchedule(
  db: DatabaseOrTransaction,
  id: string,
): Promise<FeeScheduleRow | undefined> {
  const [row] = await db
    .update(feeSchedules)
    .set({ status: 'retired' })
    .where(
      and(
        eq(feeSchedules.id, id),
        or(eq(feeSchedules.status, 'active'), eq(feeSchedules.status, 'draft')),
      ),
    )
    .returning();
  return row;
}

/** An owner accepted one schedule version's terms. */
export interface NewFeeScheduleAcceptance {
  scheduleKey: string;
  scheduleVersion: number;
  termsVersion: string;
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
  acceptedByOxyUserId: string;
}

/**
 * Record an acceptance, converging on a replay.
 *
 * `ON CONFLICT DO NOTHING` against the owner+version unique index: a repeated
 * accept (a double-tap, a retried request) is the SAME consent and must not
 * duplicate the audit trail. The empty vs one-row `RETURNING` set is the
 * "already accepted" answer, exactly as the moderation event store reads it.
 */
export async function insertFeeScheduleAcceptance(
  db: DatabaseOrTransaction,
  input: NewFeeScheduleAcceptance,
): Promise<{ created: boolean; row: FeeScheduleAcceptanceRow }> {
  const [inserted] = await db
    .insert(feeScheduleAcceptances)
    .values(input)
    .onConflictDoNothing({
      target: [
        feeScheduleAcceptances.ownerType,
        feeScheduleAcceptances.ownerId,
        feeScheduleAcceptances.scheduleKey,
        feeScheduleAcceptances.scheduleVersion,
      ],
    })
    .returning();
  if (inserted) return { created: true, row: inserted };

  const existing = await findFeeScheduleAcceptance(db, input);
  if (!existing) {
    throw new Error(
      `Acceptance of ${input.scheduleKey} v${String(input.scheduleVersion)} by ` +
        `${input.ownerType}:${input.ownerId} conflicted but cannot be read back.`,
    );
  }
  return { created: false, row: existing };
}

/** One owner's acceptance of one schedule version, or `undefined`. */
export async function findFeeScheduleAcceptance(
  db: DatabaseOrTransaction,
  input: {
    ownerType: ProviderAccountOwnerType;
    ownerId: string;
    scheduleKey: string;
    scheduleVersion: number;
  },
): Promise<FeeScheduleAcceptanceRow | undefined> {
  const [row] = await db
    .select()
    .from(feeScheduleAcceptances)
    .where(
      and(
        eq(feeScheduleAcceptances.ownerType, input.ownerType),
        eq(feeScheduleAcceptances.ownerId, input.ownerId),
        eq(feeScheduleAcceptances.scheduleKey, input.scheduleKey),
        eq(feeScheduleAcceptances.scheduleVersion, input.scheduleVersion),
      ),
    )
    .limit(1);
  return row;
}
