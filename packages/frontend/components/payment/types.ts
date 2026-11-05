import type { CheckoutPaymentHandoff } from '@mercaria/shared-types';

/**
 * What every platform's card step is handed, and what it may report back.
 *
 * The two implementations behind this contract are genuinely different: on the
 * web, Peable's Elements mount the acquirer's secure fields into this page; on
 * iOS and Android, where those fields have no native counterpart, the buyer
 * pays on Peable's hosted page in the system browser. The contract keeps that
 * split from reaching the checkout screens, which only ever know that the buyer
 * has finished with the step and that the SERVER decides whether they paid.
 *
 * ## `onCompleted` does NOT mean paid
 *
 * It means the buyer got to the end of the step without an error the step
 * could see. The screen responds by POLLING the payment-status endpoint,
 * because a client cannot assert `paid` (#45 invariant 6): only a verified
 * gateway event moves an order. Naming the callback `onPaid` would invite
 * exactly the mistake the architecture forbids.
 */
export interface CardPaymentStepProps {
  /** The server's handoff: the rail's payment, the payer's secret, the amount and surfaces. */
  payment: CheckoutPaymentHandoff;
  /**
   * The checkout group, for the 3-D Secure return route
   * (`/checkout/return?checkoutGroupId=…`), which only polls the server.
   */
  checkoutGroupId: string;
  /**
   * The buyer finished the step. The caller polls; it does NOT mark anything
   * paid.
   */
  onCompleted: () => void;
  /** The buyer backed out. Their orders stay payable until the reservation expires. */
  onCancelled?: () => void;
  /** The attempt failed, with a message safe to show. Never a provider payload. */
  onFailed: (message: string) => void;
}
