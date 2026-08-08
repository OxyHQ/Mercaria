/**
 * Reads and writes for `disputes`.
 *
 * A dispute arrives, changes several times and closes, and every one of those is
 * a redeliverable event about the SAME provider object — so the create is an
 * upsert on `UNIQUE(provider, provider_dispute_id)` and the state changes are
 * compare-and-swaps. That split matters: the row may be refreshed freely
 * (nothing about `status` is a ledger fact), while the two transitions that DO
 * book money — opening and closing — must happen exactly once each, and here
 * that is a returned row rather than a flag anybody has to remember to check.
 *
 * Like every module beside it, each function takes a `DatabaseOrTransaction`,
 * because the claim and the ledger posting it authorises commit together or the
 * books disagree with the rail.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type {
  DisputeOutcome,
  DisputeStatus,
  Money,
  PaymentProviderId,
  RefundReversalState,
} from '@mercaria/shared-types';
import { disputes } from '../schema/payments.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `disputes`. */
export type DisputeRow = typeof disputes.$inferSelect;

/** A dispute as the rail first reported it. */
export interface UpsertDisputeInput {
  provider: PaymentProviderId;
  providerDisputeId: string;
  paymentId: string;
  /** The seller order, when the group leaves no ambiguity about which one. */
  orderId?: string;
  /** What the rail actually took off the platform balance. Zero for an inquiry. */
  amount: Money;
  /** The rail's dispute fee, in the same currency. */
  feeMinor: number;
  reason?: string;
  status: DisputeStatus;
  evidenceDueBy?: Date;
}

/** What the upsert did, and the row it left. */
export interface UpsertedDispute {
  row: DisputeRow;
  /**
   * `true` only when this call INSERTED the row.
   *
   * The gate on booking `dispute_created`, and the reason the insert is the
   * claim rather than a read-then-write: Stripe redelivers `charge.dispute.created`
   * freely, and two of them debiting the ledger would double a disputed amount
   * the platform was debited once.
   */
  created: boolean;
}

/**
 * Record a dispute, or refresh the one already recorded.
 *
 * `on conflict do update` and not `do nothing`, because a dispute legitimately
 * moves — `needs_response` to `under_review`, a deadline extended, an inquiry
 * escalating into a real chargeback with an amount where it had none. None of
 * those is a ledger fact, so refreshing destroys no accounting; the two that ARE
 * ledger facts go through {@link claimDisputeOutcome} instead.
 *
 * The amount and fee are refreshed too, and deliberately: an inquiry that
 * becomes a chargeback reports its balance movement only at that point, and a
 * row frozen at zero would leave the ledger unable to book what was taken.
 */
export async function upsertDispute(
  db: DatabaseOrTransaction,
  input: UpsertDisputeInput,
): Promise<UpsertedDispute> {
  const id = uuidv7();
  const [row] = await db
    .insert(disputes)
    .values({
      id,
      provider: input.provider,
      providerDisputeId: input.providerDisputeId,
      paymentId: input.paymentId,
      amountAmount: input.amount.amount,
      amountCurrency: input.amount.currency,
      feeAmount: input.feeMinor,
      status: input.status,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.evidenceDueBy ? { evidenceDueBy: input.evidenceDueBy } : {}),
    })
    .onConflictDoUpdate({
      target: [disputes.provider, disputes.providerDisputeId],
      set: {
        amountAmount: input.amount.amount,
        amountCurrency: input.amount.currency,
        feeAmount: input.feeMinor,
        status: input.status,
        updatedAt: new Date(),
        // Attribution is only ever ADDED, never cleared: an operator (or a
        // single-seller group) may have resolved which order this is about, and
        // a later redelivery carrying no attribution must not undo it.
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.evidenceDueBy ? { evidenceDueBy: input.evidenceDueBy } : {}),
      },
    })
    .returning();
  if (!row) {
    throw new Error(
      `Dispute ${input.provider}/${input.providerDisputeId} was not written.`,
    );
  }
  return { row, created: row.id === id };
}

/**
 * Claim the right to book a dispute's OPENING debit, exactly once.
 *
 * A compare-and-swap on `opened_booked_at IS NULL` with a non-zero amount, and
 * the returned row is the authority to write `dispute_created`. Two conditions,
 * because two different things would otherwise book wrongly: a redelivered
 * `charge.dispute.created` (already booked), and an INQUIRY (nothing was
 * debited, so there is nothing to book — and an inquiry that later escalates
 * gains its amount on the row that already exists and is claimed then, which is
 * why this is not gated on the insert instead).
 */
export async function claimDisputeOpening(
  db: DatabaseOrTransaction,
  disputeId: string,
): Promise<DisputeRow | undefined> {
  const [row] = await db
    .update(disputes)
    .set({ openedBookedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(disputes.id, disputeId),
        isNull(disputes.openedBookedAt),
        sql`${disputes.amountAmount} > 0`,
      ),
    )
    .returning();
  return row;
}

/**
 * Close a dispute with its outcome, exactly once.
 *
 * A compare-and-swap on `closed_at IS NULL`, and the returned row is the
 * authority to book `dispute_won` or `dispute_lost`. A redelivered
 * `charge.dispute.closed` matches nothing, so the second one books nothing —
 * which is the whole of the convergence property for the two transactions that
 * move a disputed amount back out of the holding account.
 */
export async function claimDisputeOutcome(
  db: DatabaseOrTransaction,
  input: { disputeId: string; outcome: DisputeOutcome; status: DisputeStatus; closedAt?: Date },
): Promise<DisputeRow | undefined> {
  const closedAt = input.closedAt ?? new Date();
  const [row] = await db
    .update(disputes)
    .set({
      outcome: input.outcome,
      status: input.status,
      closedAt,
      updatedAt: new Date(),
    })
    .where(and(eq(disputes.id, input.disputeId), isNull(disputes.closedAt)))
    .returning();
  return row;
}

/**
 * Claim the rail's reversal object for a dispute that did not have one.
 *
 * The same compare-and-swap the refund path uses, against the same failure: two
 * tasks recovering one lost dispute would take a seller's money twice for a
 * chargeback that happened once.
 */
export async function claimDisputeRecovery(
  db: DatabaseOrTransaction,
  input: { disputeId: string; providerReversalId: string },
): Promise<DisputeRow | undefined> {
  const [row] = await db
    .update(disputes)
    .set({
      providerReversalId: input.providerReversalId,
      recoveryState: 'succeeded' as const,
      updatedAt: new Date(),
    })
    .where(and(eq(disputes.id, input.disputeId), isNull(disputes.providerReversalId)))
    .returning();
  return row;
}

/** Record that the seller-side recovery will not happen, or is not needed. */
export async function setDisputeRecoveryState(
  db: DatabaseOrTransaction,
  input: { disputeId: string; recoveryState: RefundReversalState },
): Promise<void> {
  await db
    .update(disputes)
    .set({ recoveryState: input.recoveryState, updatedAt: new Date() })
    .where(and(eq(disputes.id, input.disputeId), isNull(disputes.providerReversalId)));
}

/** Attribute a dispute to one seller order, if it is not attributed already. */
export async function attributeDisputeToOrder(
  db: DatabaseOrTransaction,
  input: { disputeId: string; orderId: string },
): Promise<DisputeRow | undefined> {
  const [row] = await db
    .update(disputes)
    .set({ orderId: input.orderId, updatedAt: new Date() })
    .where(and(eq(disputes.id, input.disputeId), isNull(disputes.orderId)))
    .returning();
  return row;
}

/** One dispute by the rail's own id for it — the inbound-event correlation. */
export async function findDisputeByProviderId(
  db: DatabaseOrTransaction,
  provider: PaymentProviderId,
  providerDisputeId: string,
): Promise<DisputeRow | undefined> {
  const [row] = await db
    .select()
    .from(disputes)
    .where(
      and(eq(disputes.provider, provider), eq(disputes.providerDisputeId, providerDisputeId)),
    )
    .limit(1);
  return row;
}

/** One dispute by Mercaria's own id. */
export async function findDisputeById(
  db: DatabaseOrTransaction,
  disputeId: string,
): Promise<DisputeRow | undefined> {
  const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  return row;
}

/** Every dispute against one payment, newest first — the operator trace. */
export async function listDisputesForPayment(
  db: DatabaseOrTransaction,
  paymentId: string,
): Promise<DisputeRow[]> {
  return await db
    .select()
    .from(disputes)
    .where(eq(disputes.paymentId, paymentId))
    .orderBy(desc(disputes.createdAt));
}

/**
 * Open disputes whose evidence deadline is soonest — the operator queue.
 *
 * Bounded by `limit` rather than returning everything: this is a working queue
 * for a person, and a query that can grow without limit is one that eventually
 * times out on the day it is most needed.
 */
export async function listOpenDisputes(
  db: DatabaseOrTransaction,
  limit = 50,
): Promise<DisputeRow[]> {
  return await db
    .select()
    .from(disputes)
    .where(isNull(disputes.closedAt))
    .orderBy(sql`${disputes.evidenceDueBy} asc nulls last`)
    .limit(limit);
}
