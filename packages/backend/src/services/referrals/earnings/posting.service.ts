/**
 * The ONE module in the referral domain that writes to the ledger (#145).
 *
 * `db/referrals/commissionBaseRepository.ts` reads it (that is #144's seam, and
 * its gate asserts the file contains no writer); `db/referralEarnings/partnerBalanceRepository.ts`
 * reads it for a balance; and this file calls `insertLedgerTransaction`. Three
 * files, named in
 * `services/referrals/rewards/__tests__/reward-funding-isolation.test.ts`, and
 * widening that list is a visible edit to it.
 *
 * ## Every entry point takes an OPEN TRANSACTION, and that is the guarantee
 *
 * `requireTransaction` refuses the root connection. Two things depend on it:
 *
 *  - The posting commits with the fact it books. A reward whose accrual
 *    committed without its ledger entries is money owed that the book does not
 *    know about, and the sweep would find it hours later.
 *  - The double-book guard below can ROLL BACK. It books the ledger transaction
 *    and then claims the idempotency key; a racer that got there in between
 *    makes the claim return nothing, and the only correct answer is to throw so
 *    the ledger write goes with it. Outside a transaction that throw would leave
 *    an orphan transaction in the book — a duplicate posting nobody can delete,
 *    because the append-only trigger refuses.
 *
 * ## Nothing here decides an AMOUNT
 *
 * The reward's net, the adjustment's delta and the batch's total are computed by
 * #144 and by the batch builder. This module is handed a magnitude and books it.
 * There is no rate, no percentage, no cap and no currency conversion in this
 * file, and a scanned gate says so.
 */

import {
  assertSafeMoneyAmount,
  type CurrencyCode,
  type ReferralLedgerPostingKind,
} from '@mercaria/shared-types';
import { insertLedgerTransaction } from '../../../db/payments/ledgerRepository.js';
import { requireTransaction } from '../../../db/moderation/transactionGuard.js';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import {
  findReferralLedgerPostingByKey,
  insertReferralLedgerPosting,
  referralLedgerPostingKey,
  type ReferralLedgerPostingRow,
} from '../../../db/referralEarnings/ledgerPostingRepository.js';
import type { ReferralRewardAdjustmentRow, ReferralRewardRow } from '../../../db/referrals/rewardRepository.js';
import type { ReferralPayoutBatchRow } from '../../../db/referralEarnings/payoutBatchRepository.js';
import { assertReferralPosting } from './accounts.js';
import {
  payoutSettledPosting,
  recoveryReceivedPosting,
  rewardAccruedPosting,
  rewardReversedPosting,
  type ReferralPosting,
} from './ledger-postings.js';

/**
 * Raised when two writers reached one posting concurrently.
 *
 * A distinct class, and it propagates: the caller's transaction rolls back,
 * taking the ledger transaction with it, and the retry converges on the row the
 * winner wrote. Swallowing it would leave a duplicate posting in an append-only
 * book, which nothing can remove.
 */
export class ConcurrentReferralPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentReferralPostingError';
  }
}

/** What one booking produced. `created: false` means it had already been booked. */
export interface ReferralPostingResult {
  posting: ReferralLedgerPostingRow;
  created: boolean;
}

/** The shared body: claim, book, record — in that order, in the caller's transaction. */
async function book(
  db: DatabaseOrTransaction,
  input: {
    kind: ReferralLedgerPostingKind;
    subjectId: string;
    partnerId: string;
    rewardId?: string;
    adjustmentId?: string;
    payoutBatchId?: string;
    amountMinor: number;
    currency: CurrencyCode;
    occurredAt: Date;
    posting: ReferralPosting;
    context: string;
  },
): Promise<ReferralPostingResult> {
  const tx = requireTransaction(db, input.context);
  assertSafeMoneyAmount(input.amountMinor, input.context);

  const key = referralLedgerPostingKey({ kind: input.kind, subjectId: input.subjectId });
  const already = await findReferralLedgerPostingByKey(tx, key);
  // Book NOTHING on a repeat — not even the same entries back. An append-only
  // ledger has no way to un-book a duplicate, so "already done" has to be
  // answered before any SQL that moves money.
  if (already) return { posting: already, created: false };

  // The boundary, walked on a REAL entry set at the one place it is written.
  assertReferralPosting(input.posting.entries, input.context);

  const transaction = await insertLedgerTransaction(
    tx,
    input.posting.transaction,
    input.posting.entries,
  );

  const claimed = await insertReferralLedgerPosting(tx, {
    partnerId: input.partnerId,
    kind: input.kind,
    subjectId: input.subjectId,
    ...(input.rewardId ? { rewardId: input.rewardId } : {}),
    ...(input.adjustmentId ? { adjustmentId: input.adjustmentId } : {}),
    ...(input.payoutBatchId ? { payoutBatchId: input.payoutBatchId } : {}),
    ledgerTransactionId: transaction.id,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt,
  });

  if (!claimed.created) {
    throw new ConcurrentReferralPostingError(
      `${input.context}: another writer booked \`${key}\` between the claim read and the write. ` +
        'This transaction is rolling back, which is what removes the ledger entries it had ' +
        'already written; the retry converges on the row the winner wrote.',
    );
  }
  return { posting: claimed.row, created: true };
}

/**
 * Book a reward's accrual: debit `referral_expense`, credit `referral_payable`.
 *
 * Called from #144's accrual, INSIDE its transaction, so the reward row and the
 * money it represents commit together. A reward that existed without its posting
 * would be an obligation the book had never heard of.
 */
export async function bookRewardAccrual(
  db: DatabaseOrTransaction,
  input: { reward: ReferralRewardRow; occurredAt?: Date },
): Promise<ReferralPostingResult> {
  const amountMinor = input.reward.netAmountMinor;
  return await book(db, {
    kind: 'reward_accrued',
    subjectId: input.reward.id,
    partnerId: input.reward.partnerId,
    rewardId: input.reward.id,
    amountMinor,
    currency: input.reward.currency,
    occurredAt: input.occurredAt ?? input.reward.accruedAt,
    context: `referral reward accrual ${input.reward.id}`,
    posting: rewardAccruedPosting({
      partnerId: input.reward.partnerId,
      amountMinor: BigInt(amountMinor),
      currency: input.reward.currency,
      rewardId: input.reward.id,
      description: `Referral reward accrued for partner ${input.reward.partnerId}`,
    }),
  });
}

/**
 * Book a reward's reversal: debit `referral_payable`, credit `referral_expense`.
 *
 * A ZERO delta books nothing at all and returns `created: false` with no row —
 * `ledger_entries_amount_nonzero_check` refuses a zero leg outright, and #144
 * deliberately still WRITES the adjustment row in that case ("we looked and
 * nothing had moved" is a different fact from "nobody looked"). So the two
 * records diverge here on purpose: the adjustment trail is complete and the book
 * carries only movements.
 */
export async function bookRewardReversal(
  db: DatabaseOrTransaction,
  input: { reward: ReferralRewardRow; adjustment: ReferralRewardAdjustmentRow },
): Promise<ReferralPostingResult | undefined> {
  const magnitude = -input.adjustment.deltaAmountMinor;
  if (magnitude <= 0) return undefined;
  return await book(db, {
    kind: 'reward_reversed',
    subjectId: input.adjustment.id,
    partnerId: input.reward.partnerId,
    rewardId: input.reward.id,
    adjustmentId: input.adjustment.id,
    amountMinor: magnitude,
    currency: input.adjustment.currency,
    occurredAt: input.adjustment.occurredAt,
    context: `referral reward reversal ${input.adjustment.id}`,
    posting: rewardReversedPosting({
      partnerId: input.reward.partnerId,
      amountMinor: BigInt(magnitude),
      currency: input.adjustment.currency,
      rewardId: input.reward.id,
      adjustmentId: input.adjustment.id,
      description:
        `Referral reward reversed (${input.adjustment.cause}) for partner ` +
        `${input.reward.partnerId}`,
    }),
  });
}

/**
 * Book a settled payout: debit `referral_payable`, credit `provider_clearing`.
 *
 * The amount is the batch's `net_payout_minor` re-read from the row rather than
 * passed in, so the figure booked is the figure the batch says it paid — and a
 * settlement that re-derived a smaller payable set has already written the new
 * total onto the batch before it reaches here.
 */
export async function bookPayoutSettlement(
  db: DatabaseOrTransaction,
  input: { batch: ReferralPayoutBatchRow; occurredAt: Date },
): Promise<ReferralPostingResult> {
  return await book(db, {
    kind: 'payout_settled',
    subjectId: input.batch.id,
    partnerId: input.batch.partnerId,
    payoutBatchId: input.batch.id,
    amountMinor: input.batch.netPayoutMinor,
    currency: input.batch.currency,
    occurredAt: input.occurredAt,
    context: `referral payout batch ${input.batch.id}`,
    posting: payoutSettledPosting({
      partnerId: input.batch.partnerId,
      amountMinor: BigInt(input.batch.netPayoutMinor),
      currency: input.batch.currency,
      payoutBatchId: input.batch.id,
      description: `Referral payout settled for partner ${input.batch.partnerId}`,
    }),
  });
}

/**
 * Book money a partner paid back: debit `provider_clearing`, credit
 * `referral_payable` (ADR 0005 R7's recovery beyond offset).
 *
 * `recoveryRef` is the operator's own handle for the money — a bank reference, a
 * rail reversal id — and it is the idempotency subject, so recording the same
 * recovery twice converges and two genuinely different recoveries are two rows.
 * There is no automatic path to this function: R7 makes recovery an explicit,
 * recorded operator action, and the only caller is the operator surface.
 */
export async function bookPartnerRecovery(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    amountMinor: number;
    currency: CurrencyCode;
    recoveryRef: string;
    occurredAt: Date;
    description: string;
  },
): Promise<ReferralPostingResult> {
  return await book(db, {
    kind: 'recovery_received',
    subjectId: input.recoveryRef,
    partnerId: input.partnerId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt,
    context: `referral partner recovery ${input.recoveryRef}`,
    posting: recoveryReceivedPosting({
      partnerId: input.partnerId,
      amountMinor: BigInt(input.amountMinor),
      currency: input.currency,
      recoveryRef: input.recoveryRef,
      description: input.description,
    }),
  });
}
