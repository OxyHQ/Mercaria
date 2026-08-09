/**
 * Mercaria's reference to a supplier, and the digest of what was sent under it
 * (#124 submission orchestration 4 and 6, idempotency 1–3).
 *
 * ## The reference IS the purchase order id
 *
 * ADR 0004 D6.6 makes the purchase-order id the external reference every
 * supplier draw carries, and #118 refused a `po_number` sequence for the same
 * reason a second reference is refused here: two identities for one record can
 * be quoted at each other, and the reconciliation that has to match a
 * supplier's statement line to a purchase order then has two things to try.
 *
 * The prefix exists so a human reading a supplier's dashboard knows whose order
 * it is, and so a supplier's own search finds every Mercaria order at once. It
 * is a code CONSTANT and not configuration: a deployment that changed it would
 * make every in-flight order's convergence lookup miss, which is exactly the
 * failure that places a second supplier order.
 *
 * ## The idempotency key is derived, never generated
 *
 * `po:<purchaseOrderId>` for a submission, `cancel:<purchaseOrderId>` for a
 * cancellation. Byte-identical across every retry of the same act, so a
 * provider that honours idempotency keys returns what it already did rather
 * than doing it again — the `pi:<paymentId>` shape from the payment domain,
 * which is where this repository already learned that a key derived from a
 * freshly-minted row id differs between two racers and defeats itself.
 */

import type { SupplierOrderDraft } from '@mercaria/shared-types';
import { canonicalJson, digestSupplierValue } from './redact.js';

/** The prefix every Mercaria reference at a supplier carries. */
const CLIENT_REFERENCE_PREFIX = 'mercaria-po';

/** `mercaria-po-<purchaseOrderId>` — what a supplier stores as our reference. */
export function deriveSupplierClientReference(purchaseOrderId: string): string {
  return `${CLIENT_REFERENCE_PREFIX}-${purchaseOrderId}`;
}

/**
 * The purchase order a client reference names, or `null`.
 *
 * The inverse of the above, used when a provider echoes the reference back in a
 * webhook. It answers `null` rather than throwing on anything unrecognised,
 * because an event carrying somebody else's reference is a real thing that
 * happens on a shared endpoint and is not an error in this process.
 */
export function parseSupplierClientReference(clientReference: string): string | null {
  const prefix = `${CLIENT_REFERENCE_PREFIX}-`;
  if (!clientReference.startsWith(prefix)) return null;
  const id = clientReference.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/** `po:<purchaseOrderId>` — the submission idempotency key. */
export function deriveSubmissionIdempotencyKey(purchaseOrderId: string): string {
  return `po:${purchaseOrderId}`;
}

/** `cancel:<purchaseOrderId>` — the cancellation idempotency key. */
export function deriveCancellationIdempotencyKey(purchaseOrderId: string): string {
  return `cancel:${purchaseOrderId}`;
}

/**
 * The sha-256 of the canonical submission request.
 *
 * What it is FOR: a resubmission whose request differs from one that may
 * already have been applied is not a retry, it is a second and different order,
 * and the orchestration refuses it. The digest is what makes "differs" a fact
 * rather than a comparison somebody would have to write against a request that
 * was never stored.
 *
 * The destination is INCLUDED, which is what makes the digest an exact-match
 * oracle over a specific person's home address and therefore PROTECTED
 * (`db/protectedColumns.ts`). Excluding it would be worse than storing the
 * address: a resubmission that changed only the street would then read as the
 * same request and be sent without a second thought.
 */
export function digestSupplierOrderRequest(draft: SupplierOrderDraft): string {
  return digestSupplierValue(canonicalJson(draft));
}

/**
 * The sha-256 of one polled observation's content — its identity when the
 * provider gives no event id.
 *
 * Composed from the facts that make two observations DIFFERENT, and
 * deliberately not from the whole response: a provider that includes a
 * server timestamp or a request id in every payload would otherwise make every
 * poll a new event, and the dedupe this hash exists for would never fire once.
 */
export function digestPolledObservation(input: {
  providerAccountId: string;
  externalOrderId: string | null;
  clientReference: string | null;
  providerState: string;
  observedAt: string;
  trackingNumbers: readonly string[];
}): string {
  return digestSupplierValue(
    canonicalJson({
      providerAccountId: input.providerAccountId,
      externalOrderId: input.externalOrderId,
      clientReference: input.clientReference,
      providerState: input.providerState,
      observedAt: input.observedAt,
      trackingNumbers: [...input.trackingNumbers].sort(),
    }),
  );
}
