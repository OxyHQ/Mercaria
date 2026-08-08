/**
 * What a charge became on the PLATFORM balance, and what Stripe kept.
 *
 * Extracted from `stripe-event-router.ts` when #50's reconciliation sweep needed
 * the same answer. It is the one figure a payment CANNOT succeed without, so two
 * copies of this arithmetic would eventually book a webhook's success and a
 * sweep's success at different amounts — which is the same money in the ledger
 * twice with two different values and nothing to say which is right.
 *
 * ## Why it is read at the moment of success, and not later
 *
 * Both figures come from the charge's BALANCE TRANSACTION, which is the only
 * place Stripe states a charge in the platform's own settlement currency (ADR
 * 0001 D8, fact 5) and the fee it deducted (D5). Every consequence of a success
 * needs them: the ledger books the charge in the currency the money landed in,
 * and the seller transfers are sized from that same figure and must be
 * denominated in that same currency.
 *
 * Reading them at the moment of application means they are captured INSIDE the
 * compare-and-swap that moves the payment to `succeeded`, so the rate that
 * produced the platform amount is stored with it and the two can never come from
 * different moments. The alternative — booking in presentment now and converting
 * at settlement — would leave `merchant_payable` holding a debt in one currency
 * that was paid in another, which no report could ever net to zero.
 *
 * ## An unavailable balance transaction is RETRYABLE, never assumed
 *
 * For a card charge Stripe creates it with the charge, so this is available
 * essentially always; asynchronous methods are what leave it pending, and ADR
 * 0001 D3 excludes those from the launch precisely because their money moves
 * later than their events. Retrying is the only honest answer when it is
 * missing: guessing a 1:1 conversion would book a USD figure as euros, and
 * defaulting the fee to zero would understate `processor_expense` permanently —
 * a wrong number in the accounts is worse than a late one.
 *
 * The retryable ERROR is what carries that through both callers: the event
 * processor backs the row off and tries again, and the reconciliation sweep
 * catches it and leaves the payment where it is until the next pass.
 */

import type Stripe from 'stripe';
import type { CurrencyCode, FxRateSnapshot, Money } from '@mercaria/shared-types';
import { PaymentProviderError } from '../provider.js';
import { retrieveStripeChargeWithBalance } from './client.js';

/** The two figures a success has to carry with it. */
export interface StripeSettlementRead {
  platform: { amount: Money; rate: FxRateSnapshot };
  feeMinor: bigint;
}

/**
 * A fact this version needs and cannot see YET.
 *
 * Retryable on purpose: a balance transaction that has not been created is one
 * that will be, and treating it as permanent would dead-letter a payment that
 * genuinely succeeded.
 */
function unavailable(message: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message,
    retryable: true,
  });
}

/**
 * Read the platform amount, its rate and the processing fee for one intent.
 *
 * @throws {PaymentProviderError} Retryable, when the charge or its balance
 *   transaction is not readable yet. Never returns a guess — see the docblock.
 */
export async function readStripeSettlement(
  intent: Stripe.PaymentIntent,
): Promise<StripeSettlementRead> {
  const latest: unknown = intent.latest_charge;
  const chargeId =
    typeof latest === 'string'
      ? latest
      : typeof latest === 'object' && latest !== null && 'id' in latest
        ? String((latest as { id: unknown }).id)
        : undefined;
  if (chargeId === undefined || chargeId === '') {
    throw unavailable(
      `Stripe PaymentIntent ${intent.id} reports 'succeeded' but names no charge; the balance ` +
        'transaction it settles through is not readable yet.',
    );
  }

  const charge = await retrieveStripeChargeWithBalance(chargeId);
  const balance: unknown = charge.balance_transaction;
  if (typeof balance !== 'object' || balance === null) {
    throw unavailable(
      `Stripe charge ${chargeId} has no balance transaction yet; the platform amount and fee ` +
        'cannot be captured, and a success must not be booked without them.',
    );
  }

  const transaction = balance as Stripe.BalanceTransaction;
  return {
    platform: {
      amount: {
        amount: transaction.amount,
        currency: transaction.currency.toUpperCase() as CurrencyCode,
      },
      rate: {
        from: intent.currency.toUpperCase() as CurrencyCode,
        to: transaction.currency.toUpperCase() as CurrencyCode,
        // `null` when no conversion happened, which is the same-currency case
        // and is exactly a rate of one. Stated rather than left absent because
        // the snapshot's whole purpose is to be reproducible, and "there was no
        // rate" and "the rate is unknown" must not look alike.
        rate: transaction.exchange_rate ?? 1,
        provider: 'stripe',
        asOf: new Date(transaction.created * 1_000).toISOString(),
      },
    },
    feeMinor: BigInt(transaction.fee),
  };
}
