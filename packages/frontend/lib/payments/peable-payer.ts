/**
 * The pure half of the storefront's Peable payment (ADR 0009 D13).
 *
 * The payment itself is Peable's sheet (`PeableSheetCheckout`, through
 * `components/payment/PeablePaymentSheet.tsx`); what is left here are the two
 * decisions Mercaria makes around it, unit-tested where the component cannot be
 * (`vitest.config.ts` runs `lib/**` only).
 *
 * Nothing here decides that a payment succeeded. The paid state is Mercaria's
 * payment aggregate, moved only by a verified gateway event and read through
 * `GET /checkout/:checkoutGroupId/payment-status`.
 */

import type { PaymentStatus } from '@mercaria/shared-types';
import type { SheetOutcome } from '@peable.to/sdk/checkout/ui';

/**
 * Where a redirect-based confirmation (3-D Secure) returns the buyer: the
 * storefront's return route, which only POLLS the server. The return proves
 * nothing (ADR 0006 G10); the group id authorizes nothing either — the status
 * endpoint scopes its answer to the caller.
 */
export function checkoutReturnUrl(origin: string, checkoutGroupId: string): string {
  const url = new URL('/checkout/return', origin);
  url.searchParams.set('checkoutGroupId', checkoutGroupId);
  return url.toString();
}

/**
 * What the server's payment status tells the sheet. Only `succeeded` is shown
 * as paid and only `canceled` as over; a `failed` attempt is a decline the
 * buyer recovers from in the sheet itself, and everything else is still
 * waiting on the gateway.
 */
export function sheetOutcome(status: PaymentStatus | undefined): SheetOutcome {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'canceled') return 'failed';
  return null;
}
