/**
 * `referral_ledger_postings` — the bridge between a referral fact and the
 * balanced ledger transaction that booked it (#145).
 *
 * The idempotency guarantee is the DATABASE's and nothing else's: the key is
 * derived from the SUBJECT, the insert is `ON CONFLICT DO NOTHING` on the unique
 * index over it, and the empty `RETURNING` set IS the "already booked" answer.
 * A read-then-write lets two workers both see "no" and book the same reward
 * twice, and there is no error to catch that would tell them apart — Postgres
 * cannot distinguish a duplicate key from a dropped connection inside a `catch`,
 * which is why nothing here has one.
 *
 * This module writes NO ledger rows. `services/referrals/earnings/posting.service.ts`
 * is the one place that calls `insertLedgerTransaction`, and it takes the claim
 * from here first — so a claim that already exists short-circuits BEFORE any
 * money is booked, which is what makes the pair idempotent as a unit rather than
 * two idempotent halves whose composition is not.
 */

import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { CurrencyCode, ReferralLedgerPostingKind } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralLedgerPostings } from '../schema/referralEarnings.js';

/** A posting row as the services read it back. */
export type ReferralLedgerPostingRow = typeof referralLedgerPostings.$inferSelect;

/**
 * The deterministic key of one posting — stated ONCE, here, so every writer and
 * every test computes the same spelling.
 *
 * The SUBJECT is what makes it stable across retries, and each kind's subject is
 * the thing that can happen at most once:
 *
 * - `reward_accrued` keys on the REWARD, which `UNIQUE(conversion_id)` already
 *   makes one per conversion.
 * - `reward_reversed` keys on the ADJUSTMENT row, whose own key already carries
 *   `(reward, cause, source)` — so a redelivered refund webhook converges twice
 *   over.
 * - `payout_settled` keys on the BATCH, so a retried settlement books once.
 * - `recovery_received` keys on the operator's own reference for the money that
 *   came back, because two recoveries from one partner are two real events.
 */
export function referralLedgerPostingKey(input: {
  kind: ReferralLedgerPostingKind;
  subjectId: string;
}): string {
  return `refledg:${input.kind}:${input.subjectId}`;
}

/** Everything a posting row is born with. */
export interface CreateReferralLedgerPostingInput {
  partnerId: string;
  kind: ReferralLedgerPostingKind;
  subjectId: string;
  rewardId?: string;
  adjustmentId?: string;
  payoutBatchId?: string;
  ledgerTransactionId: string;
  /** A positive magnitude — the sign lives in `ledger_entries`. */
  amountMinor: number;
  currency: CurrencyCode;
  occurredAt: Date;
}

/**
 * Record that a posting was booked, converging on the row a replay already made.
 *
 * @returns `created: false` when this exact posting already exists, in which
 *   case NOTHING is written — not even the same values back, which would move a
 *   row's `xmin` and make a genuine no-op indistinguishable from a second
 *   posting.
 */
export async function insertReferralLedgerPosting(
  db: DatabaseOrTransaction,
  input: CreateReferralLedgerPostingInput,
): Promise<{ row: ReferralLedgerPostingRow; created: boolean }> {
  const idempotencyKey = referralLedgerPostingKey({
    kind: input.kind,
    subjectId: input.subjectId,
  });

  const [inserted] = await db
    .insert(referralLedgerPostings)
    .values({
      partnerId: input.partnerId,
      kind: input.kind,
      rewardId: input.rewardId ?? null,
      adjustmentId: input.adjustmentId ?? null,
      payoutBatchId: input.payoutBatchId ?? null,
      ledgerTransactionId: input.ledgerTransactionId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      idempotencyKey,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: referralLedgerPostings.idempotencyKey })
    .returning();

  if (inserted) return { row: inserted, created: true };

  const existing = await findReferralLedgerPostingByKey(db, idempotencyKey);
  if (!existing) {
    throw new Error(
      `referral_ledger_postings insert for ${idempotencyKey} conflicted with a row that then ` +
        'could not be read back.',
    );
  }
  return { row: existing, created: false };
}

/** Whether a posting has already been booked, without writing anything. */
export async function findReferralLedgerPostingByKey(
  db: DatabaseOrTransaction,
  idempotencyKey: string,
): Promise<ReferralLedgerPostingRow | undefined> {
  const [row] = await db
    .select()
    .from(referralLedgerPostings)
    .where(eq(referralLedgerPostings.idempotencyKey, idempotencyKey));
  return row;
}

/** One partner's postings, newest first — the operator trace's spine. */
export async function listReferralLedgerPostingsForPartner(
  db: DatabaseOrTransaction,
  input: { partnerId: string; limit: number },
): Promise<ReferralLedgerPostingRow[]> {
  return await db
    .select()
    .from(referralLedgerPostings)
    .where(eq(referralLedgerPostings.partnerId, input.partnerId))
    .orderBy(desc(referralLedgerPostings.occurredAt), desc(referralLedgerPostings.id))
    .limit(input.limit);
}

/** Every posting for one reward, oldest first — accrual then each reversal. */
export async function listReferralLedgerPostingsForReward(
  db: DatabaseOrTransaction,
  rewardId: string,
): Promise<ReferralLedgerPostingRow[]> {
  return await db
    .select()
    .from(referralLedgerPostings)
    .where(eq(referralLedgerPostings.rewardId, rewardId))
    .orderBy(asc(referralLedgerPostings.occurredAt), asc(referralLedgerPostings.id));
}

/** The postings a batch produced. At most one, and zero until it settles. */
export async function listReferralLedgerPostingsForBatch(
  db: DatabaseOrTransaction,
  batchId: string,
): Promise<ReferralLedgerPostingRow[]> {
  return await db
    .select()
    .from(referralLedgerPostings)
    .where(eq(referralLedgerPostings.payoutBatchId, batchId))
    .orderBy(asc(referralLedgerPostings.createdAt));
}

/**
 * Which of a set of rewards have NO accrual posting — the reconciliation
 * sweep's `ledger_posting_missing` probe.
 *
 * Written as a read over the candidate ids the caller already holds rather than
 * a left join from `referral_rewards`, so the sweep keeps its own paging and
 * this stays a question about a bounded set. The same shape
 * `paymentsMissingLedgerKind` uses one domain over, and for the same reason.
 */
export async function rewardsMissingAccrualPosting(
  db: DatabaseOrTransaction,
  rewardIds: readonly string[],
): Promise<Set<string>> {
  if (rewardIds.length === 0) return new Set();
  const found = await db
    .selectDistinct({ rewardId: referralLedgerPostings.rewardId })
    .from(referralLedgerPostings)
    .where(
      and(
        eq(referralLedgerPostings.kind, 'reward_accrued'),
        inArray(referralLedgerPostings.rewardId, [...rewardIds]),
      ),
    );
  const booked = new Set(found.map((row) => row.rewardId).filter((id): id is string => id !== null));
  return new Set(rewardIds.filter((id) => !booked.has(id)));
}

/**
 * What one reward's postings NET to on the partner's payable, in minor units.
 *
 * Accruals credit the payable and reversals debit it, so the net obligation the
 * postings describe for one reward is `accrued − reversed`. This is the figure
 * the sweep compares against `referral_rewards.net_amount_minor`, and it is read
 * from the POSTINGS rather than recomputed from the reward, or the comparison
 * would be a check that cannot fail.
 *
 * `sum()` over an int8 column comes back as NUMERIC, which postgres.js hands
 * back as a STRING — reading it as a number would silently lose precision on
 * exactly the figure this exists to reconcile.
 */
export async function sumRewardPostingObligation(
  db: DatabaseOrTransaction,
  rewardId: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(
        case when ${referralLedgerPostings.kind} = 'reward_accrued'
          then ${referralLedgerPostings.amountMinor}
          else -${referralLedgerPostings.amountMinor}
        end
      ), 0)`,
    })
    .from(referralLedgerPostings)
    .where(
      and(
        eq(referralLedgerPostings.rewardId, rewardId),
        inArray(referralLedgerPostings.kind, ['reward_accrued', 'reward_reversed']),
      ),
    );
  return Number(row.total);
}

/**
 * Batches that reached `paid` and booked NOTHING — the sweep's
 * `payout_without_ledger_posting` probe.
 *
 * A left join rather than a candidate-set read, because the population is
 * bounded by the paid batches themselves and there is no caller-held page to
 * scope it to.
 */
export async function findPaidBatchesWithoutPosting(
  db: DatabaseOrTransaction,
  input: { batchIds: readonly string[] },
): Promise<Set<string>> {
  if (input.batchIds.length === 0) return new Set();
  const found = await db
    .selectDistinct({ batchId: referralLedgerPostings.payoutBatchId })
    .from(referralLedgerPostings)
    .where(
      and(
        eq(referralLedgerPostings.kind, 'payout_settled'),
        inArray(referralLedgerPostings.payoutBatchId, [...input.batchIds]),
      ),
    );
  const booked = new Set(found.map((row) => row.batchId).filter((id): id is string => id !== null));
  return new Set(input.batchIds.filter((id) => !booked.has(id)));
}

/**
 * Partners with at least one posting, newest activity first — the reconciliation
 * sweep's resumable cursor population.
 *
 * Keyset paged on the PARTNER id rather than on a timestamp: the sweep visits
 * every partner exactly once per pass and a timestamp cursor would revisit
 * whoever moved during it.
 */
export async function listPartnersWithPostings(
  db: DatabaseOrTransaction,
  input: { afterPartnerId?: string; limit: number },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ partnerId: referralLedgerPostings.partnerId })
    .from(referralLedgerPostings)
    .where(
      input.afterPartnerId
        ? gt(referralLedgerPostings.partnerId, input.afterPartnerId)
        : undefined,
    )
    .orderBy(asc(referralLedgerPostings.partnerId))
    .limit(input.limit);
  return rows.map((row) => row.partnerId);
}
