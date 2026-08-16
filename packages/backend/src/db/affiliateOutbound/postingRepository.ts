/**
 * `affiliate_commission_postings` — the link between a network transaction and
 * the balanced ledger transaction it produced (#67).
 *
 * ## The claim is the idempotency, and it is the DATABASE's answer
 *
 * `UNIQUE(transaction_id, kind, revision)` claimed with
 * `ON CONFLICT DO NOTHING RETURNING`, in the SAME transaction as the ledger
 * write. The EMPTY result IS "already booked" — not an error to interpret, not
 * a read-then-write that two workers can both pass. A re-poll that re-observes
 * an approval therefore cannot double-credit revenue, and it cannot do so
 * because of a structural property rather than because of a flag somebody
 * remembers to pass.
 *
 * `revision` is in the key because a network may approve, reverse and approve
 * again: the second accrual is a DIFFERENT posting from the first, and without
 * the revision it would be silently swallowed as a duplicate — a commission
 * Mercaria earned and never booked, which is the quiet half of this domain's
 * failure mode.
 *
 * ## The amount is the movement on `affiliate_receivable`
 *
 * ONE meaning for one column, chosen so that the running sum over a
 * transaction's postings IS its outstanding receivable: an accrual is positive
 * (the network owes more), a reversal and a settlement are negative (it owes
 * less, because it took the commission back or because it paid). Recording each
 * posting's "headline" amount instead would make that sum meaningless, and the
 * delta arithmetic in `services/outbound/reconciliation/posting.ts` reads this
 * column back to decide what still needs booking.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { AffiliateCommissionPostingKind, CurrencyCode } from '@mercaria/shared-types';
import { affiliateCommissionPostings } from '../schema/affiliateOutbound.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One `affiliate_commission_postings` row. */
export type AffiliateCommissionPostingRow = typeof affiliateCommissionPostings.$inferSelect;

/**
 * Claim one posting.
 *
 * MUST be called in the same transaction as the {@link
 * import('../payments/ledgerRepository.js').insertLedgerTransaction} it names.
 * Split across two transactions, a crash between them leaves either a ledger
 * movement no commission record explains or a commission record pointing at a
 * transaction that was rolled back — and the foreign key would refuse the
 * second, which is the loud half; the first is the silent one.
 *
 * @returns the claimed row, or `undefined` when this (transaction, kind,
 *   revision) was already booked. `undefined` is an ordinary answer and the
 *   caller must NOT then write the ledger.
 */
export async function claimAffiliateCommissionPosting(
  db: DatabaseOrTransaction,
  input: {
    transactionId: string;
    ledgerTransactionId: string;
    kind: AffiliateCommissionPostingKind;
    revision: number;
    /** SIGNED minor units — this posting's movement on `affiliate_receivable`. */
    amountMinor: number;
    currency: CurrencyCode;
    postedAt: Date;
  },
): Promise<AffiliateCommissionPostingRow | undefined> {
  const [row] = await db
    .insert(affiliateCommissionPostings)
    .values({
      transactionId: input.transactionId,
      ledgerTransactionId: input.ledgerTransactionId,
      kind: input.kind,
      revision: input.revision,
      amountMinor: input.amountMinor,
      currency: input.currency,
      postedAt: input.postedAt,
    })
    .onConflictDoNothing({
      target: [
        affiliateCommissionPostings.transactionId,
        affiliateCommissionPostings.kind,
        affiliateCommissionPostings.revision,
      ],
    })
    .returning();
  return row;
}

/**
 * Every posting for one transaction, oldest first.
 *
 * Read back rather than derived from the transaction's current state, because
 * "what has already been booked" is a fact about the LEDGER and the transaction
 * row only records what the network last said. A transaction that was approved,
 * reversed and approved again has one state and three postings.
 */
export async function listAffiliateCommissionPostings(
  db: DatabaseOrTransaction,
  transactionId: string,
): Promise<readonly AffiliateCommissionPostingRow[]> {
  return db
    .select()
    .from(affiliateCommissionPostings)
    .where(eq(affiliateCommissionPostings.transactionId, transactionId))
    .orderBy(asc(affiliateCommissionPostings.postedAt), asc(affiliateCommissionPostings.revision));
}

/** The postings of one KIND for one transaction. The operator's trace narrows here. */
export async function listAffiliateCommissionPostingsOfKind(
  db: DatabaseOrTransaction,
  input: { transactionId: string; kind: AffiliateCommissionPostingKind },
): Promise<readonly AffiliateCommissionPostingRow[]> {
  return db
    .select()
    .from(affiliateCommissionPostings)
    .where(
      and(
        eq(affiliateCommissionPostings.transactionId, input.transactionId),
        eq(affiliateCommissionPostings.kind, input.kind),
      ),
    )
    .orderBy(asc(affiliateCommissionPostings.revision));
}
