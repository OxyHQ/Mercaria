/**
 * The ONE posting the subscription domain books, and its arithmetic.
 *
 * A merchant subscription is not a new way to move money — it is a new ACCOUNT
 * (`subscription_revenue`) on the existing ledger, written through the existing
 * single writer, subject to the existing balance refusal and the existing
 * append-only trigger. There is deliberately no reversal helper here for the
 * same reason there is none in the payment domain: a correction is a REVERSING
 * transaction an operator decided on, and a function that derived one from what
 * is stored would make the correction a function of the mistake.
 *
 * ## Booked in the currency the money LANDED in
 *
 * #47's rule, and it applies unchanged: the platform balance moves in Stripe's
 * settlement currency, which is not always the invoice's. Reading `net` and
 * `fee` off the balance transaction is what makes `provider_clearing` a real
 * account balance rather than a running total of amounts that were charged
 * somewhere. `gross = net + fee` by construction, so the transaction cannot fail
 * to balance for an arithmetic reason.
 *
 * ## The fee leg is OMITTED when there is no fee
 *
 * `ledger_entries_amount_nonzero_check` refuses a zero amount, and rightly: a
 * zero entry conveys nothing, survives every balance check and accumulates. A
 * fully-discounted invoice books nothing at all — the caller checks for a zero
 * gross before it gets here, because a transaction of no entries is not a
 * transaction.
 */

import { assertSafeLedgerAmount, type CurrencyCode } from '@mercaria/shared-types';
import type { LedgerEntryInput } from '../../db/payments/ledgerRepository.js';

/** What the rail says one settled subscription invoice did to the balance. */
export interface SubscriptionSettlement {
  /** What landed on the platform balance, in its own currency's minor units. */
  netMinor: number;
  /** What the provider kept. Zero is legitimate and omits the expense leg. */
  feeMinor: number;
  /** The currency the balance actually moved in. */
  currency: CurrencyCode;
}

/**
 * The balanced entries for one settled subscription invoice.
 *
 * @throws {RangeError} When an amount is outside the ledger column's range —
 *   raised against the POSTING rather than the INSERT, so the error names this
 *   builder (`ledgerRepository`'s rule).
 */
export function subscriptionInvoicePaidEntries(
  input: SubscriptionSettlement,
): LedgerEntryInput[] {
  if (!Number.isInteger(input.netMinor) || !Number.isInteger(input.feeMinor)) {
    throw new RangeError(
      'A subscription settlement is minor units and must be whole; received ' +
        `net=${String(input.netMinor)} fee=${String(input.feeMinor)}.`,
    );
  }
  if (input.netMinor < 0 || input.feeMinor < 0) {
    throw new RangeError(
      'A settled subscription invoice cannot have a negative net or fee; a credit is an ' +
        'operator `adjustment`, which is the existing mechanism.',
    );
  }

  const net = BigInt(input.netMinor);
  const fee = BigInt(input.feeMinor);
  const gross = net + fee;
  if (gross === 0n) {
    throw new RangeError(
      'A subscription invoice that settled for nothing books nothing. The caller must not ' +
        'reach this builder with a zero gross — a ledger transaction of no entries is not one.',
    );
  }

  assertSafeLedgerAmount(net, 'subscription_invoice_paid.provider_clearing');
  assertSafeLedgerAmount(gross, 'subscription_invoice_paid.subscription_revenue');

  const entries: LedgerEntryInput[] = [];
  // Positive is a DEBIT: funds arrived on the platform balance.
  if (net > 0n) {
    entries.push({ account: 'provider_clearing', currency: input.currency, amountMinor: net });
  }
  if (fee > 0n) {
    assertSafeLedgerAmount(fee, 'subscription_invoice_paid.processor_expense');
    entries.push({ account: 'processor_expense', currency: input.currency, amountMinor: fee });
  }
  // Negative is a CREDIT: revenue recognised.
  entries.push({
    account: 'subscription_revenue',
    currency: input.currency,
    amountMinor: -gross,
  });
  return entries;
}
