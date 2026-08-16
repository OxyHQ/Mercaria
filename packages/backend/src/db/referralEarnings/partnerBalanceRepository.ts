/**
 * A referral partner's balance, DERIVED from `ledger_entries` and from nothing
 * else (#145 acceptance 1: reward balances are fully derivable from immutable
 * entries).
 *
 * ## This is the SECOND file in the referral domain allowed to read the ledger
 *
 * `db/referrals/commissionBaseRepository.ts` was the first and is #144's, and
 * its gate said in as many words that a referral domain able to POST to the
 * ledger "would be #145's earnings ledger arriving without its reconciliation
 * sweep, which ADR 0005 says ships WITH it". #145 is that arrival, the sweep
 * ships with it, and the exemption list in
 * `services/referrals/rewards/__tests__/reward-funding-isolation.test.ts` names
 * exactly three files now: this one, the commission reader, and the one service
 * module that writes. Widening it further is a visible edit to that list.
 *
 * ## There is no balance TABLE and none may be added
 *
 * `#145 ledger behaviour 1`: append-only postings or an equally strong immutable
 * journal, and a stored running total is neither. Two representations of one
 * fact can disagree, and the place that must not happen is a payout batch built
 * over a figure that drifted. Every read here is an aggregate over the entries.
 *
 * ## `sum()` over an int8 column is a STRING
 *
 * postgres.js decodes NUMERIC as a string while drizzle types it `number`, so a
 * bare read would concatenate rather than add on exactly the figure a payout is
 * built from. Every aggregate below is annotated `sql<string>` and coerced at
 * the boundary — a test that sums ONE row cannot catch the difference.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { ledgerEntries, ledgerTransactions } from '../schema/ledger.js';

/** One partner's position in one currency, as the ledger states it. */
export interface ReferralPartnerLedgerBalance {
  currency: CurrencyCode;
  /**
   * SIGNED, and positive means Mercaria owes it.
   *
   * `referral_payable` is credit-normal and a ledger credit is a NEGATIVE
   * amount, so the outstanding obligation is the negation of the account's sum.
   * A NEGATIVE result is a partner RECEIVABLE — ADR 0005 R7's post-payout
   * clawback, which is a real state rather than an error, and which future
   * accruals offset first.
   */
  outstandingMinor: number;
  /** What has actually been settled to this partner, ever. Never negative. */
  settledMinor: number;
}

/**
 * Every currency this partner has a `referral_payable` position in.
 *
 * Grouped in ONE statement over the owner index — `ledger_entries_owner_created_at_idx`
 * is partial on `owner_id is not null`, which is exactly this shape.
 */
export async function readReferralPartnerLedgerBalances(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<ReferralPartnerLedgerBalance[]> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      total: sql<string>`sum(${ledgerEntries.amountMinor})`,
      settled: sql<string>`coalesce(sum(
        case when ${ledgerTransactions.kind} = 'referral_payout'
          then ${ledgerEntries.amountMinor} else 0 end
      ), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerEntries.account, 'referral_payable'),
        eq(ledgerEntries.ownerType, 'referral_partner'),
        eq(ledgerEntries.ownerId, partnerId),
      ),
    )
    .groupBy(ledgerEntries.currency);

  return rows.map((row) => ({
    currency: row.currency as CurrencyCode,
    // The negation is the sign convention, not a correction: a credit is
    // negative, and what Mercaria OWES is the credit balance.
    //
    // `0 - x` rather than `-x`, and it is not a style choice: JavaScript's unary
    // minus over a zero yields NEGATIVE zero, so a settled partner's balance
    // came back as `-0` — which reads as a receivable to anything asking
    // `Object.is`, prints as `-0` in a log line and is a signed zero in a money
    // figure. Found by `referral-earnings.realdb.test.ts` on its first run.
    outstandingMinor: 0 - Number(row.total),
    settledMinor: Number(row.settled),
  }));
}

/** One currency's position, for the payout gate that only asks about one. */
export async function readReferralPartnerLedgerBalance(
  db: DatabaseOrTransaction,
  input: { partnerId: string; currency: CurrencyCode },
): Promise<ReferralPartnerLedgerBalance> {
  const balances = await readReferralPartnerLedgerBalances(db, input.partnerId);
  return (
    balances.find((balance) => balance.currency === input.currency) ?? {
      currency: input.currency,
      outstandingMinor: 0,
      settledMinor: 0,
    }
  );
}

/**
 * The GLOBAL per-currency sum of the two referral accounts.
 *
 * `referral_expense` is debit-normal and `referral_payable` credit-normal, so at
 * any instant the expense Mercaria has recognised equals what it owes plus what
 * it has paid — which nets to zero across the two accounts ONLY while nothing
 * has been settled. So this is not a zero-sum probe; it is the pair of running
 * figures the operator metrics report, and the sweep compares each side against
 * the rows that produced it.
 */
export async function readReferralAccountTotals(
  db: DatabaseOrTransaction,
): Promise<{ account: string; currency: string; totalMinor: number }[]> {
  const rows = await db
    .select({
      account: ledgerEntries.account,
      currency: ledgerEntries.currency,
      total: sql<string>`sum(${ledgerEntries.amountMinor})`,
    })
    .from(ledgerEntries)
    .where(
      sql`${ledgerEntries.account} in ('referral_expense', 'referral_payable')`,
    )
    .groupBy(ledgerEntries.account, ledgerEntries.currency);

  return rows.map((row) => ({
    account: row.account,
    currency: row.currency,
    totalMinor: Number(row.total),
  }));
}
