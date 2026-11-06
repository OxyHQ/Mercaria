/**
 * The postings the subscription domain books, and their arithmetic: a paid
 * invoice, in fiat when a card paid it and in FAIR when FairCoin did
 * ({@link subscriptionInvoicePaidInFaircoinEntries}).
 *
 * A merchant subscription is not a new way to move money — it is a new ACCOUNT
 * (`subscription_revenue`) on the existing ledger, written through the existing
 * single writer, subject to the existing balance refusal and the existing
 * append-only trigger. There is deliberately no reversal helper here for the
 * same reason there is none in the payment domain: a correction is a REVERSING
 * transaction an operator decided on, and a function that derived one from what
 * is stored would make the correction a function of the mistake.
 *
 * ## What the rail tells it, and what it does not
 *
 * The caller supplies `net` and `fee` in one currency, and `gross = net + fee`
 * by construction, so the transaction cannot fail to balance for an arithmetic
 * reason. On Peable's native engine the caller has a card-paid invoice's paid
 * amount and no settlement detail, so it books that amount as `net` with a zero
 * fee — the stated fee gap in `peable/events.ts` — rather than inventing a
 * figure.
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
export function subscriptionInvoicePaidEntries(input: SubscriptionSettlement): LedgerEntryInput[] {
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

/**
 * What a plan invoice paid in FairCoin brought in: FAIR, in the Peable wallet of
 * the Oxy organization that owns Mercaria's application.
 */
export interface SubscriptionFaircoinReceipt {
  /** The FAIR the payment received, in FAIR's minor units (10⁻⁸). */
  fairMinor: number;
}

/**
 * The balanced entries for one plan invoice paid in FairCoin.
 *
 * ```
 * faircoin_received     +fair  (debit — the coins arrived in the `oxy` organization's wallet)
 * subscription_revenue  −fair  (credit — revenue recognised, in the unit received)
 * ```
 *
 * Booked in FAIR and only in FAIR. `provider_clearing` is NOT touched: it is
 * the platform's fiat balance at Peable, and no fiat reached it — the payer's
 * wallet paid the organization's own address (Peable ADR 0021 D5), which Peable
 * never holds. The fiat price the payment was quoted at is a snapshot on the
 * invoice's audit row, never an amount here: booking it would invent a
 * conversion nobody made. There is no processor leg because there is no
 * processor — a FairCoin payment carries no fee (Peable ADR 0021 D6).
 *
 * @throws {RangeError} On a non-positive or fractional amount, or one outside
 *   the ledger column's range — a FairCoin payment that received nothing is not
 *   a receipt, and the caller refuses it before reaching here.
 */
export function subscriptionInvoicePaidInFaircoinEntries(
  input: SubscriptionFaircoinReceipt,
): LedgerEntryInput[] {
  if (!Number.isInteger(input.fairMinor) || input.fairMinor <= 0) {
    throw new RangeError(
      'A FairCoin plan payment is a positive whole number of FAIR minor units; received ' +
        `${String(input.fairMinor)}.`,
    );
  }
  const fair = BigInt(input.fairMinor);
  assertSafeLedgerAmount(fair, 'subscription_invoice_paid.faircoin_received');
  return [
    // Positive is a DEBIT: FAIR arrived in the organization's wallet.
    { account: 'faircoin_received', currency: 'FAIR', amountMinor: fair },
    // Negative is a CREDIT: revenue recognised, in FAIR.
    { account: 'subscription_revenue', currency: 'FAIR', amountMinor: -fair },
  ];
}
