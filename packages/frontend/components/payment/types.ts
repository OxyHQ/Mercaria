import type { CheckoutPaymentHandoff } from '@mercaria/shared-types';

/**
 * What every platform's card step is handed, and what it may report back.
 *
 * The two implementations behind this contract are genuinely different products
 * — Stripe's PaymentSheet on iOS and Android, its Payment Element on the web —
 * and neither can run on the other's platform. The contract keeps that split
 * from reaching the checkout screen, which only ever knows that the buyer has
 * "finished with the sheet" and that the SERVER is what decides whether they
 * paid.
 *
 * ## `onCompleted` does NOT mean paid
 *
 * It means the buyer got to the end of the sheet without cancelling. The screen
 * responds by POLLING the payment-status endpoint, because a client cannot
 * assert `paid` (#45 invariant 6): a sheet result is a UI event, and only a
 * verified webhook moves an order. Naming the callback `onPaid` would invite
 * exactly the mistake the architecture forbids.
 */
export interface CardPaymentStepProps {
  /** The server's handoff — client secret, amount, and the key to use. */
  payment: CheckoutPaymentHandoff;
  /**
   * The buyer reached the end of the sheet. The caller starts polling; it does
   * NOT mark anything paid.
   */
  onCompleted: () => void;
  /** The buyer backed out. Their orders stay payable until the reservation expires. */
  onCancelled: () => void;
  /** The rail refused, with a message safe to show. Never a provider payload. */
  onFailed: (message: string) => void;
}
