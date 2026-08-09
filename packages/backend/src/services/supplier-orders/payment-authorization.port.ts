/**
 * The seam onto #123: may this purchase order be submitted to a supplier at all
 * (#124 submission orchestration 2, "revalidate that submission is authorized
 * by the payment state from #123")?
 *
 * ## Why a PORT and not a direct read
 *
 * The question is "is this a PAID, captured `mercaria_retail` order", and
 * neither half of that is answerable today. `orders` has no `commercial_role`
 * and no `platform` seller type — #123 owns that widening (ADR 0004 D1) — so a
 * direct read would have to invent the column or guess from the absence of a
 * seller, and both are the shape that silently starts authorizing things.
 *
 * There were three options and two of them are wrong:
 *
 *  - Read the order's `status = 'paid'` and call it authorized. That is wrong
 *    in the direction that costs money: a marketplace order is also `paid`, and
 *    procuring against one would buy goods for an order a connected merchant is
 *    already fulfilling.
 *  - Import #123's reader from a branch that has not merged. A build that
 *    compiles on one machine.
 *  - Define the narrow port, ship a default that honestly refuses, and let #123
 *    supply the real one. That is this file — `services/attributes/offer-facts.port.ts`'s
 *    arrangement (#94), for the same reason.
 *
 * ## The default REFUSES, so nothing is authorized by omission
 *
 * {@link unauthorizedPaymentReader} answers
 * `authorization_reader_not_registered` for every order, so a deployment
 * without #123 places no supplier orders at all and says why. That is the
 * fail-closed direction: the alternative is a deployment that procures against
 * whatever happens to be `paid`.
 *
 * ## What #123 supplies, and nothing more
 *
 * ONE function. It returns a SNAPSHOT rather than a query builder, so this
 * domain cannot issue its own order queries — "is this order authorized for
 * procurement" then has exactly one definition, which is #123's.
 */

import type { ProcurementSubmissionAuthorization } from '@mercaria/shared-types';

/** The one function #123 registers. */
export type ProcurementPaymentAuthorizationReader = (
  orderId: string,
) => Promise<ProcurementSubmissionAuthorization>;

/**
 * The default reader: every order is refused, by name.
 *
 * `authorization_reader_not_registered` is its own refusal reason and not one
 * of the substantive ones, so an operator reading a refused submission can tell
 * "this deployment has no retail checkout" from "this order was never paid" —
 * two conditions with completely different next actions.
 */
export const unauthorizedPaymentReader: ProcurementPaymentAuthorizationReader = async () =>
  await Promise.resolve({ authorized: false, reason: 'authorization_reader_not_registered' });

let reader: ProcurementPaymentAuthorizationReader = unauthorizedPaymentReader;

/**
 * Register the real reader.
 *
 * Re-registering REPLACES, deliberately: startup ordering across lazily
 * imported modules is not something a port should have an opinion about, and a
 * duplicate registration is a configuration mistake that shows up as the wrong
 * reader answering rather than as a boot failure — `registerSupplierAdapter`'s
 * reasoning, one domain over.
 */
export function registerProcurementPaymentAuthorizationReader(
  next: ProcurementPaymentAuthorizationReader,
): void {
  reader = next;
}

/** Restore the refusing default. Exists for tests, which must not leak a reader. */
export function resetProcurementPaymentAuthorizationReader(): void {
  reader = unauthorizedPaymentReader;
}

/** Whether a supplier order may be placed for this customer order, right now. */
export async function readProcurementPaymentAuthorization(
  orderId: string,
): Promise<ProcurementSubmissionAuthorization> {
  return await reader(orderId);
}
