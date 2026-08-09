/**
 * Grouping a guest's sibling orders into ONE portal view — #106 DTO rule 7,
 * ADR 0003 D5.
 *
 * ## The SHAPE is here; the ACCESS is #108's
 *
 * A guest's orders are reachable only through a scoped
 * `guest_order_access_grants` row, and that table does not exist yet — so
 * `resolveGuestPortalSubject` in `order-access.service.ts` returns `null` and no
 * request can reach {@link buildGuestOrderPortalView} through a route. What
 * exists now is the projection and the two derivations it needs, written while
 * the reasoning is fresh, so #108 adds a grant table and a router and changes no
 * DTO.
 *
 * The function is deliberately NOT a stub that returns something plausible: it
 * takes an already-authorized checkout group and does real work. #108 supplies
 * the authorization; nothing here pretends to.
 *
 * ## Grouped by checkout group, because that is what a grant scopes
 *
 * There is no grant to "an email's orders" (T7/T11) and therefore no view of
 * one. The group is also the unit a guest actually thinks in — one basket, one
 * payment, one confirmation — which a multi-seller cart splits into sibling
 * orders that would otherwise arrive as unrelated rows.
 */

import type {
  GuestCheckoutClaimState,
  GuestCheckoutLifecycle,
  GuestOrderPortalView,
  Order as OrderDTO,
  OrderStatus,
} from '@mercaria/shared-types';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import { hydrateOrders } from '../order-hydration.service.js';
import { notFound } from '../../lib/errors/error-codes.js';

/**
 * Where a whole checkout group stands, derived from its orders.
 *
 * DERIVED and never stored, for the reason `guest_sessions` has no status
 * column: two representations of one fact can disagree, and the place that must
 * not happen is a portal telling a buyer their order is unpaid while the ledger
 * says otherwise.
 *
 * `mixed` is a real answer rather than a fallback. A multi-seller group whose
 * sellers are at different stages is ordinary once one order ships, and
 * collapsing it to the "worst" or the "latest" status would be an invented
 * fact — the buyer's remedy is to look at the orders, which the view carries.
 */
export function deriveGuestCheckoutLifecycle(
  statuses: readonly OrderStatus[],
): GuestCheckoutLifecycle {
  if (statuses.length === 0) {
    // Unreachable through the caller below, which refuses an empty group. Kept
    // total anyway: a lifecycle function that throws on an empty list would be
    // a second failure mode for the caller to handle.
    return 'mixed';
  }
  const distinct = new Set(statuses);
  if (distinct.size === 1) {
    const [only] = [...distinct];
    switch (only) {
      case 'pending_payment':
        return 'pending_payment';
      case 'cancelled':
        return 'cancelled';
      case 'refunded':
        return 'refunded';
      // `paid`, `processing`, `shipped` and `delivered` are all "the money
      // moved and fulfilment is under way" from the group's point of view; the
      // per-order status is what a buyer reads for detail, and duplicating the
      // whole order lifecycle at the group level would be a second, coarser
      // state machine to keep in step.
      case 'paid':
      case 'processing':
      case 'shipped':
      case 'delivered':
      case 'partially_refunded':
        return 'paid';
    }
  }
  return 'mixed';
}

/**
 * Whether the group has been claimed into an Oxy account (#109).
 *
 * Derived from the ORDERS, which is where ADR 0003 D6 puts the claim columns. A
 * claim is group-atomic by construction (D14: "a group can never be split"), so
 * the honest answer is normally unanimous — and `partial` exists so a
 * disagreement is VISIBLE rather than smoothed into whichever value happened to
 * come first. It is the same disagreement `readBuyerIdentityConsistency`
 * counts; a portal that hid it would leave the only observer of a split claim
 * being an operator who thought to look.
 */
export function deriveGuestCheckoutClaim(
  orders: readonly OrderRecord[],
): GuestCheckoutClaimState {
  const claimants = new Set(orders.map((order) => order.claimedByOxyUserId ?? ''));
  if (claimants.size !== 1) {
    return { status: 'partial' };
  }
  const [only] = [...claimants];
  if (only === '') {
    return { status: 'unclaimed' };
  }
  // Every order agrees on the claimant, so any one of them carries the pair —
  // and the identity CHECK guarantees the timestamp travels with the id.
  const claimedAt = orders.find((order) => order.claimedAt !== null)?.claimedAt;
  return {
    status: 'claimed',
    claimedByOxyUserId: only,
    ...(claimedAt ? { claimedAt: claimedAt.toISOString() } : {}),
  };
}

/**
 * Build the portal view for one ALREADY-AUTHORIZED checkout group.
 *
 * Takes the orders rather than a group id, so the read that scoped them — the
 * grant check — cannot be skipped by calling this instead. That is the
 * `findOrdersByCheckoutGroup` discipline: the caller proves ownership, this
 * composes the answer.
 *
 * The contact comes from the orders' own hydrated projection, so it is the
 * order's immutable snapshot and not a second read of a live record. All
 * siblings share one `guest_checkouts` row (its unique index on
 * `checkout_group_id` is what makes that structural), so taking the first
 * order's is taking the group's.
 */
export async function buildGuestOrderPortalView(
  checkoutGroupId: string,
  orders: readonly OrderRecord[],
): Promise<GuestOrderPortalView> {
  if (orders.length === 0) {
    throw notFound('Order not found');
  }

  const dtos: OrderDTO[] = await hydrateOrders([...orders]);
  const contact = dtos[0]?.buyerContact;
  if (!contact) {
    // A guest-origin order always has one — `orders_buyer_identity_check`
    // requires the foreign key and the FK is `RESTRICT`. Reaching here means
    // the group is not a guest's, which is a caller error rather than a
    // renderable state, and answering 404 beats serving a view with no contact.
    throw notFound('Order not found');
  }

  return {
    checkoutGroupId,
    lifecycle: deriveGuestCheckoutLifecycle(orders.map((order) => order.status)),
    claim: deriveGuestCheckoutClaim(orders),
    contact,
    orders: dtos,
  };
}
