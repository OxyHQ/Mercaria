/**
 * The ONE place the referral domain reads the payment ledger (#144, ADR 0005
 * "The reward-base contract").
 *
 * ADR 0001 D3 gave up Stripe's `application_fee_amount`, so Mercaria's
 * commission exists NOWHERE except `ledger_transactions`/`ledger_entries`. A
 * reward defined as a share of commission can therefore only be computed from
 * ledger facts — an order total, a cart subtotal, a fee schedule applied
 * client-side or a `#88` snapshot re-read are all different numbers, and three
 * of the four are the buyer's money rather than Mercaria's income.
 *
 * ## Why the grain is the PAYMENT and not the order
 *
 * The commission entry is the RESIDUAL of a whole charge — gross minus the sum
 * of the sellers' nets, booked once per `charge_succeeded` with no `order_id`
 * on the entry, because the residual is not divisible into per-order pieces
 * without re-running the fee arithmetic that ADR 0001 D3 deliberately does not
 * keep. Splitting it here would be a SECOND derivation of commission, which is
 * exactly what the ledger being the only home is meant to prevent. So a
 * `connected_marketplace` base is "the commission Mercaria realized on this
 * CHECKOUT" — which is also the honest reading of ADR 0005 D11's "the referred
 * buyer's first qualifying order": their first purchase is the checkout, not
 * one seller's slice of it.
 *
 * ## Realized means net of refunds, and the sign convention says how
 *
 * `commission_revenue`'s normal balance is a CREDIT, so an earned commission is
 * a NEGATIVE entry and commission returned on a refund is a POSITIVE one
 * (`ledger-postings.refundPosting`). The realized base is therefore the
 * NEGATED sum, and every refund shrinks it without any subtraction being
 * written anywhere — which is what makes the reversal path a re-read rather
 * than an arithmetic reconstruction.
 *
 * ## This file is a named exception in the isolation gate
 *
 * `reward-funding-isolation.test.ts` fails the build if any other module in the
 * referral domain imports the ledger, the payment schema or the fee domain.
 * This one may, it reads and never writes, and it selects two columns.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { ledgerEntries, ledgerTransactions } from '../schema/ledger.js';

/**
 * What the ledger says about one payment's commission.
 *
 * A STRING discriminant, not a boolean: this backend compiles with
 * `strict: false`, so TypeScript does not narrow a union on a boolean-literal
 * discriminant and `if (!result.found)` would leave the caller holding the
 * whole union.
 */
export type RealizedCommission =
  | {
      outcome: 'realized';
      /** Net of refunds, in minor units of {@link RealizedCommission.currency}. Never negative. */
      amountMinor: number;
      currency: CurrencyCode;
      /**
       * The last ledger transaction that contributed to this figure — the
       * "version" of the funding record. A later refund books a new
       * transaction, so a changed version is exactly the signal that a
       * previously computed base has moved.
       */
      lastTransactionId: string;
      observedAt: Date;
    }
  | { outcome: 'no_postings' }
  /**
   * More than one currency of commission against one payment. Not summed and
   * not picked between: adding a EUR amount to a USD one to reach a base is
   * arithmetic on two different things, which is the reason the ledger's own
   * balance rule is per currency.
   */
  | { outcome: 'ambiguous_currency'; currencies: readonly string[] };

/**
 * The commission Mercaria has actually realized on one payment.
 *
 * A negative net (more commission returned than was ever earned — a
 * cross-currency refund asymmetry, ADR 0001 D7) is reported as ZERO rather than
 * as a negative base: a reward is never negative, and a base below zero would
 * make one representable through arithmetic instead of through a reversal
 * record.
 */
export async function readRealizedCommissionForPayment(
  db: DatabaseOrTransaction,
  paymentId: string,
): Promise<RealizedCommission> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      total: sql<string>`sum(${ledgerEntries.amountMinor})`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerTransactions.paymentId, paymentId),
        eq(ledgerEntries.account, 'commission_revenue'),
      ),
    )
    .groupBy(ledgerEntries.currency);

  if (rows.length === 0) return { outcome: 'no_postings' };
  if (rows.length > 1) {
    return { outcome: 'ambiguous_currency', currencies: rows.map((row) => row.currency).sort() };
  }

  const [only] = rows;
  // postgres.js decodes `sum()` over `int8` as a STRING while drizzle types it
  // loosely; `BigInt` is the only coercion that cannot silently concatenate.
  const netCredit = -BigInt(only.total);
  const amountMinor = netCredit > 0n ? Number(netCredit) : 0;

  const [latest] = await db
    .select({ id: ledgerTransactions.id, createdAt: ledgerTransactions.createdAt })
    .from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
    .where(
      and(
        eq(ledgerTransactions.paymentId, paymentId),
        eq(ledgerEntries.account, 'commission_revenue'),
      ),
    )
    // `(created_at, id)` and never the id alone: `@oxyhq/db`'s uuid v7 is NOT
    // monotonic within a millisecond, so ordering by the key would make the
    // recorded version flicker between two postings booked in one statement.
    .orderBy(desc(ledgerTransactions.createdAt), desc(ledgerTransactions.id))
    .limit(1);

  return {
    outcome: 'realized',
    amountMinor,
    currency: only.currency,
    lastTransactionId: latest.id,
    observedAt: latest.createdAt,
  };
}
