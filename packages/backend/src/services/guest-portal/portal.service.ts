/**
 * What a portal credential can READ, and the one thing it can change about
 * itself (#108 portal experience, authorization).
 *
 * ## Two views, two TYPES, one authorization path
 *
 * {@link readGuestOrderPortalView} is the full picture and requires
 * `orders:read`, which only a verified credential can hold — and it goes
 * through `authorizeOrderAccess` per order, so #106's rules decide rather than
 * a second copy of them living here. {@link readGuestOrderStatusView} is the
 * bounded confirmation an unverified `post_checkout` credential may see, and it
 * is a different TYPE rather than a filtered one: a serializer that reached for
 * a total, an address, an item title or a contact on `GuestOrderStatusView`
 * fails `tsc`.
 *
 * ## The scope is the group, and the group is on the grant
 *
 * Every read below starts from `grant.checkoutGroupId` and there is no
 * parameter for a group id, an order id or an email. A caller cannot ask for
 * somebody else's orders because there is nowhere to put the request — which is
 * ADR 0003 T7 held by the signature rather than by a filter.
 *
 * The route still takes a `:groupId` and compares it to the grant's, and that
 * comparison is NOT redundant with the above: it is what makes a client holding
 * two credentials get a 404 instead of silently reading whichever group the
 * cookie happened to name.
 */

import type {
  GuestOrderPortalView,
  GuestOrderStatusEntry,
  GuestOrderStatusView,
  Order,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findOrdersInCheckoutGroup } from '../../db/orders/orderRepository.js';
import type { GuestOrderAccessGrantRow } from '../../db/guestPortal/grantRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { hydrateOrders } from '../order-hydration.service.js';
import {
  authorizeOrderAccess,
  orderAccessFactsFromRecord,
  type GuestOrderPortalGrant,
} from '../orders/order-access.service.js';
import {
  buildGuestOrderPortalView,
  deriveGuestCheckoutLifecycle,
} from '../orders/guest-order-portal.service.js';
import { enqueueGuestMessage } from './message.service.js';
import { secureGroupAccess } from './grant.service.js';
import { sellerLabel } from './message.service.js';

/** The `GuestOrderPortalGrant` contract #106 published, built from a row. */
export function toOrderPortalGrant(row: GuestOrderAccessGrantRow): GuestOrderPortalGrant {
  return {
    grantId: row.id,
    checkoutGroupId: row.checkoutGroupId,
    emailVerified: row.emailVerifiedAt !== null,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * The full portal view for a verified credential.
 *
 * Reads the group's orders unscoped (`findOrdersInCheckoutGroup` — the read
 * that deliberately takes no owner) and then authorizes EACH one through
 * `authorizeOrderAccess`. That looks like belt and braces and is not: the
 * unscoped read is the only one that can serve a grant, since a grant is not a
 * buyer and has no buyer predicate, so the per-order decision is where the
 * scope check actually happens. It also means a group that somehow contained a
 * foreign order would drop it rather than serve it.
 *
 * An empty result is a 404 and not an empty view: a group with no readable
 * orders is indistinguishable from a group that does not exist, and making them
 * distinguishable would turn a stale credential into a group-existence oracle.
 */
export async function readGuestOrderPortalView(
  grant: GuestOrderAccessGrantRow,
  now: Date,
): Promise<GuestOrderPortalView> {
  const subject = { kind: 'guest_portal' as const, grant: toOrderPortalGrant(grant) };
  const orders = await findOrdersInCheckoutGroup(grant.checkoutGroupId, getDb());
  const authorized = orders.filter(
    (order) => authorizeOrderAccess(subject, orderAccessFactsFromRecord(order), now).allowed,
  );
  if (authorized.length === 0) {
    throw notFound('Order not found');
  }
  return await buildGuestOrderPortalView(grant.checkoutGroupId, authorized);
}

/**
 * The BOUNDED confirmation view (#108 initial-confirmation rule 3).
 *
 * Deliberately does NOT run `authorizeOrderAccess`: that function refuses every
 * unverified grant, which is correct for full detail and would make this view
 * unreachable — and this view is precisely the thing ADR 0003 D17 places on the
 * pre-verification side of the line. The scope check it replaces it with is the
 * stronger one for what it serves: the credential names one checkout group, and
 * these are that group's orders.
 *
 * What it omits is the whole of its safety and is worth reading as a list:
 * money, addresses, item titles, discounts, payment references and the contact
 * in every form. What remains is what somebody who just paid already knows.
 */
export async function readGuestOrderStatusView(
  grant: GuestOrderAccessGrantRow,
): Promise<GuestOrderStatusView> {
  const orders = await findOrdersInCheckoutGroup(grant.checkoutGroupId, getDb());
  if (orders.length === 0) {
    throw notFound('Order not found');
  }
  const hydrated = await hydrateOrders([...orders]);
  return {
    checkoutGroupId: grant.checkoutGroupId,
    lifecycle: deriveGuestCheckoutLifecycle(orders.map((order) => order.status)),
    orders: hydrated.map(toStatusEntry),
  };
}

/** One sibling order, at the resolution an unverified credential may read. */
function toStatusEntry(order: Order): GuestOrderStatusEntry {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    // `Guest` is never the label here — this is the SELLER, and a seller has a
    // public identity by definition. An unresolvable one renders as the empty
    // string rather than an invented placeholder, which is the honest answer to
    // "who is this" when the profile read failed.
    sellerLabel: sellerLabel(order) ?? '',
    itemCount: order.items.length,
    placedAt: order.createdAt,
  };
}

/**
 * "Secure my access" — revoke every other credential for this group and tell
 * the contact inbox it happened (ADR 0003 diagram 10, #108 notification 12).
 *
 * The security notice is enqueued AFTER the revocation and best-effort: a
 * failure to send must not be why access stays open, and a person who pressed
 * this button has already been told by the UI that it worked.
 *
 * The notice goes to the contact inbox, which is the only address in play — so
 * a thief who somehow pressed it announces themselves to the victim, and the
 * victim who pressed it gets a record. Both are the correct outcome.
 */
export async function secureAccess(
  grant: GuestOrderAccessGrantRow,
  now: Date,
): Promise<{ revokedGrantIds: string[] }> {
  const revokedGrantIds = await secureGroupAccess({
    checkoutGroupId: grant.checkoutGroupId,
    keepGrantId: grant.id,
    now,
  });

  try {
    await enqueueGuestMessage(
      {
        checkoutGroupId: grant.checkoutGroupId,
        kind: 'access_security_notice',
        dedupeSuffix: grant.id,
      },
      getDb(),
    );
  } catch (err) {
    log.guest.error(
      { err, checkoutGroupId: grant.checkoutGroupId },
      '[GuestPortal] failed to enqueue the security notice; the revocation stands',
    );
  }

  return { revokedGrantIds };
}

/**
 * Whether a group's payment has already landed — the discriminator for #105's
 * `verified_before_payment` / `verified_after_payment` contact stage.
 *
 * Read off the ORDERS rather than the payment domain, deliberately: `lifecycle`
 * is what the portal already derives, and reaching into `payments` for a
 * classification the order status already carries would put a second reader on
 * the `order-linkage.ts` seam for no new information.
 */
export async function groupHasBeenPaid(checkoutGroupId: string): Promise<boolean> {
  const orders = await findOrdersInCheckoutGroup(checkoutGroupId, getDb());
  if (orders.length === 0) return false;
  return deriveGuestCheckoutLifecycle(orders.map((order) => order.status)) !== 'pending_payment';
}
