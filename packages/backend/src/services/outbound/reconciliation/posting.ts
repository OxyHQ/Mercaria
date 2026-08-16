/**
 * Booking a network's commission to the ledger (#67 conversion requirements 7
 * and 8, acceptance 4).
 *
 * ## The whole rule is TWO TARGETS AND TWO DELTAS
 *
 * Everything a transaction's lifetime can do to the book falls out of two
 * numbers and what is already booked against them:
 *
 * - **Recognition target** — the commission when the network says the money is
 *   EARNED (`AFFILIATE_EARNED_STATES`), otherwise zero.
 * - **Settlement target** — the commission when the network says it has PAID,
 *   otherwise zero.
 *
 * Each posting is the difference between a target and what the existing
 * postings already moved. That single rule covers every case #67 names and
 * several it does not, without one special branch per case:
 *
 * | The network says | Recognition | Settlement | Postings |
 * |---|---|---|---|
 * | `pending` | 0 | 0 | none — **a pending commission books NOTHING** |
 * | `approved` | commission | 0 | an accrual |
 * | `approved` → `paid` | unchanged | commission | a settlement |
 * | `paid` with no prior approval | commission | commission | an accrual AND a settlement |
 * | `approved` → `declined`/`reversed` | 0 | 0 | a reversal of what was accrued |
 * | `reversed` → `approved` again | commission | 0 | a NEW accrual at a new revision |
 * | a corrected commission while approved | the new amount | 0 | an accrual of the difference |
 * | `paid` → `reversed` (a clawback) | 0 | 0 | a reversal AND a negative settlement |
 *
 * It is also idempotent by construction rather than by a flag: re-running
 * against the same facts computes deltas of zero, so there is nothing to book.
 * The unique claim in `postingRepository` is the second layer, for a literal
 * double-apply within one revision.
 *
 * **`pending` books nothing, and that is the rule this domain exists to
 * enforce.** A pending commission is a claim the network may still decline, and
 * booking one is the invented sale trust principle 4 forbids — revenue that
 * exists in Mercaria's book and nowhere in the world.
 *
 * ## There is no `reverseTransaction(id)` here, deliberately
 *
 * The ledger's own rule: a correction is a NEW balanced REVERSING transaction,
 * because a helper that derived a correction from what is STORED would make it
 * a function of Mercaria's bookkeeping rather than of what the network decided.
 * Every plan below is computed from the network's current word plus the book,
 * and the ledger transaction it produces is an ordinary balanced one.
 *
 * ## No FX, ever
 *
 * Every posting is booked in the commission's OWN currency, which is what makes
 * "sums to zero per currency" hold with no rate involved at all. A network
 * reports in the advertiser's currency and a rate moving between the report and
 * the payout would change an amount somebody else decided.
 */

import {
  AFFILIATE_EARNED_STATES,
  assertSafeMoneyAmount,
  type AffiliateCommissionPostingKind,
  type AffiliateTransactionState,
  type CurrencyCode,
  type LedgerTransactionKind,
} from '@mercaria/shared-types';
import type { LedgerEntryInput } from '../../../db/payments/ledgerRepository.js';
import { insertLedgerTransaction } from '../../../db/payments/ledgerRepository.js';
import {
  claimAffiliateCommissionPosting,
  listAffiliateCommissionPostings,
  type AffiliateCommissionPostingRow,
} from '../../../db/affiliateOutbound/postingRepository.js';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';

/** One balanced movement this observation owes the book. */
export interface AffiliateCommissionPostingPlan {
  readonly kind: AffiliateCommissionPostingKind;
  readonly ledgerKind: LedgerTransactionKind;
  readonly description: string;
  /** SIGNED minor units: this posting's movement on `affiliate_receivable`. */
  readonly receivableMinor: number;
  readonly currency: CurrencyCode;
  readonly entries: readonly LedgerEntryInput[];
}

/**
 * A STRING discriminant, for the reason every union in this domain has one:
 * without `strictNullChecks` a boolean-literal discriminant does not narrow.
 */
export type AffiliateCommissionPostingPlanResult =
  | { readonly outcome: 'planned'; readonly postings: readonly AffiliateCommissionPostingPlan[] }
  | {
      readonly outcome: 'refused';
      readonly reason: 'currency_restated';
      readonly detail: string;
    };

/** What one transaction's existing postings already moved. */
interface BookedSoFar {
  readonly currency: CurrencyCode | null;
  /** Net movement on `affiliate_receivable` from accruals and reversals. */
  readonly recognizedMinor: number;
  /** How much of the receivable a settlement has already discharged. */
  readonly settledMinor: number;
}

/**
 * Read the book back.
 *
 * The transaction ROW carries only what the network last said; what has been
 * BOOKED is a property of the postings, and a transaction that was approved,
 * reversed and approved again has one state and three postings. Deriving the
 * deltas from the state alone would double-book the second approval.
 */
function summarizeBooked(postings: readonly AffiliateCommissionPostingRow[]): BookedSoFar {
  let recognizedMinor = 0;
  let settledMinor = 0;
  let currency: CurrencyCode | null = null;
  for (const posting of postings) {
    currency = posting.currency as CurrencyCode;
    if (posting.kind === 'settlement') {
      // A settlement CREDITS the receivable, so its stored amount is negative
      // and what it discharged is the negation.
      settledMinor -= posting.amountMinor;
    } else {
      recognizedMinor += posting.amountMinor;
    }
  }
  return { currency, recognizedMinor, settledMinor };
}

/**
 * What this observation owes the book.
 *
 * PURE with respect to everything but its two inputs, and unit-tested directly:
 * the whole of #67's money behaviour is in this function, and a case that only
 * arises after four polls (approve, reverse, approve, pay) is not one anybody
 * would drive through a database.
 */
export function planAffiliateCommissionPostings(input: {
  readonly state: AffiliateTransactionState;
  readonly commission: { readonly amount: number; readonly currency: CurrencyCode };
  readonly networkTransactionId: string;
  readonly booked: readonly AffiliateCommissionPostingRow[];
}): AffiliateCommissionPostingPlanResult {
  const booked = summarizeBooked(input.booked);
  const currency = input.commission.currency;

  if (booked.currency !== null && booked.currency !== currency) {
    // Netting a EUR accrual against a GBP commission is arithmetic on two
    // different things. This is refused rather than resolved, because every
    // resolution invents a rate the network never quoted — and a rate here
    // would change an amount somebody else decided.
    return {
      outcome: 'refused',
      reason: 'currency_restated',
      detail:
        `Transaction ${input.networkTransactionId} is booked in ${booked.currency} and the ` +
        `network now reports ${currency}. A commission cannot be re-denominated after it has ` +
        'been booked: the correction is a reversal in the original currency and a fresh ' +
        'accrual in the new one, which is an operator decision rather than a poll’s.',
    };
  }

  assertSafeMoneyAmount(input.commission.amount, 'affiliate commission');

  const earned = AFFILIATE_EARNED_STATES.includes(input.state);
  const recognitionTarget = earned ? input.commission.amount : 0;
  const settlementTarget = input.state === 'paid' ? input.commission.amount : 0;

  const recognitionDelta = recognitionTarget - booked.recognizedMinor;
  const settlementDelta = settlementTarget - booked.settledMinor;

  const postings: AffiliateCommissionPostingPlan[] = [];

  // Recognition FIRST: a transaction reported straight to `paid` accrues and
  // then settles, and settling a receivable that was never created would leave
  // `affiliate_receivable` permanently negative for that transaction.
  if (recognitionDelta > 0) {
    postings.push({
      kind: 'accrual',
      ledgerKind: 'affiliate_commission_accrued',
      description: `Affiliate commission accrued for ${input.networkTransactionId}`,
      receivableMinor: recognitionDelta,
      currency,
      entries: [
        { account: 'affiliate_receivable', currency, amountMinor: BigInt(recognitionDelta) },
        {
          account: 'affiliate_commission_revenue',
          currency,
          amountMinor: BigInt(-recognitionDelta),
        },
      ],
    });
  } else if (recognitionDelta < 0) {
    const magnitude = -recognitionDelta;
    postings.push({
      kind: 'reversal',
      ledgerKind: 'affiliate_commission_reversed',
      description: `Affiliate commission reversed for ${input.networkTransactionId}`,
      receivableMinor: recognitionDelta,
      currency,
      entries: [
        { account: 'affiliate_receivable', currency, amountMinor: BigInt(-magnitude) },
        { account: 'affiliate_commission_revenue', currency, amountMinor: BigInt(magnitude) },
      ],
    });
  }

  if (settlementDelta !== 0) {
    // A NEGATIVE settlement is a clawback of commission the network already
    // paid — rare, real, and unrepresentable if this only handled the positive
    // direction. Both directions are one expression rather than two branches,
    // so neither can drift from the other.
    postings.push({
      kind: 'settlement',
      ledgerKind: 'affiliate_commission_settled',
      description:
        settlementDelta > 0
          ? `Affiliate commission settled for ${input.networkTransactionId}`
          : `Affiliate commission settlement reversed for ${input.networkTransactionId}`,
      receivableMinor: -settlementDelta,
      currency,
      entries: [
        { account: 'platform_funds', currency, amountMinor: BigInt(settlementDelta) },
        { account: 'affiliate_receivable', currency, amountMinor: BigInt(-settlementDelta) },
      ],
    });
  }

  return { outcome: 'planned', postings };
}

/** What {@link bookAffiliateCommissionPostings} actually wrote. */
export interface BookedAffiliateCommission {
  readonly kind: AffiliateCommissionPostingKind;
  readonly ledgerTransactionId: string;
  readonly receivableMinor: number;
  readonly currency: CurrencyCode;
}

/**
 * Write the plan.
 *
 * MUST be called inside the transaction that recorded the observation. The
 * claim and the ledger write are in the same statement sequence for
 * `postingRepository`'s reason, and the OBSERVATION has to be there too: an
 * observation that committed without its posting would be classified
 * `unchanged` by the next poll and the accrual would never be booked — a
 * commission Mercaria earned, recorded and never recognized.
 *
 * The claim runs BEFORE the ledger write. `ON CONFLICT DO NOTHING RETURNING`
 * with an empty result IS "already booked", and skipping the ledger write on
 * that answer is what makes a re-poll a no-op rather than a second credit.
 */
export async function bookAffiliateCommissionPostings(
  tx: DatabaseOrTransaction,
  input: {
    readonly transactionId: string;
    readonly revision: number;
    readonly postings: readonly AffiliateCommissionPostingPlan[];
    readonly now: Date;
  },
): Promise<readonly BookedAffiliateCommission[]> {
  const written: BookedAffiliateCommission[] = [];
  for (const plan of input.postings) {
    const ledger = await insertLedgerTransaction(
      tx,
      { kind: plan.ledgerKind, description: plan.description },
      plan.entries,
    );
    const claimed = await claimAffiliateCommissionPosting(tx, {
      transactionId: input.transactionId,
      ledgerTransactionId: ledger.id,
      kind: plan.kind,
      revision: input.revision,
      amountMinor: plan.receivableMinor,
      currency: plan.currency,
      postedAt: input.now,
    });
    if (!claimed) {
      // The claim was already held by an earlier apply of this exact revision.
      // The ledger transaction just written has no commission record pointing at
      // it, so the caller MUST roll back — which it does, because this throws
      // inside the per-transaction transaction. Reaching here means two workers
      // computed the same revision under the row lock, which the lock forbids;
      // it is a fault to surface rather than a duplicate to swallow.
      throw new Error(
        `Affiliate posting ${plan.kind} revision ${String(input.revision)} for transaction ` +
          `${input.transactionId} was already claimed. The row lock taken before classification ` +
          'is what makes a revision unique to one applier; reaching here means it was not held.',
      );
    }
    written.push({
      kind: plan.kind,
      ledgerTransactionId: ledger.id,
      receivableMinor: plan.receivableMinor,
      currency: plan.currency,
    });
  }
  return written;
}

/** Read what a transaction has already had booked. Re-exported for the apply path. */
export async function readBookedAffiliatePostings(
  db: DatabaseOrTransaction,
  transactionId: string,
): Promise<readonly AffiliateCommissionPostingRow[]> {
  return listAffiliateCommissionPostings(db, transactionId);
}
