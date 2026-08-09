/**
 * The ONE place the payment domain touches guest commerce — ADR 0006 B2/B3.
 *
 * `order-linkage.ts` exists because the payment domain must read ORDERS through
 * a projection it owns rather than reaching into the order repository from five
 * places. This file is the same decision for `guest_checkouts`, and the reason
 * is sharper: that table holds the encrypted contact, the routing HMAC and the
 * session the checkout was placed from, and every one of those is a value the
 * payment domain must never be able to obtain. A projection that returns ONE
 * opaque row id is a boundary the compiler enforces; "remember not to select the
 * ciphertext" is not.
 *
 * ## Why the payment domain needs this at all
 *
 * Exactly one thing: ADR 0006 G7 puts `guestCheckoutId` in the PaymentIntent's
 * metadata, so an operator reading Stripe's own dashboard can correlate a charge
 * to Mercaria's durable guest record without Mercaria having put a person in
 * there. The id is the correct value to carry precisely because it is inert —
 * it authorizes nothing (I2: every authorization path takes a `CommerceActor` or
 * a grant row), it survives the guest session's death (B2/G9), and it is
 * deterministic on replay because `guest_checkouts` is UNIQUE per checkout
 * group.
 *
 * Contrast what may NOT go in: `guest_sessions.id` is purgeable, so a purged id
 * in immutable provider metadata would be a dangling correlate; a token or its
 * hash is a credential; an email in any form is a person. None of them has a
 * function here to travel through.
 *
 * ## It reads, and it never writes
 *
 * There is deliberately no write path in this file. `guest_checkouts` has one
 * writer — the checkout transaction (`ensureGuestCheckout`) — and a payment
 * domain able to touch the row would be a second, running in a different
 * transaction, after the orders that reference it committed.
 */

import { eq } from 'drizzle-orm';
import { guestCheckouts } from '../../db/schema/guests.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';

/**
 * The `guest_checkouts` row id for a checkout group, or `undefined` when the
 * group has none.
 *
 * `undefined` is the ORDINARY answer, not a failure: an Oxy buyer's group has no
 * contact row at all, because their transactional channel is Oxy's own
 * notifications and copying an Oxy account's email into Mercaria would create
 * the profile mirror ADR 0003 D15 says does not exist. So callers branch on
 * presence rather than treating absence as an error.
 *
 * ONE column is selected. Not for speed — the row is small — but because the
 * select list is the boundary: adding `emailCiphertext` to it would be a visible
 * diff in a file whose whole purpose is that it cannot carry one.
 */
export async function findGuestCheckoutIdForGroup(
  checkoutGroupId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: guestCheckouts.id })
    .from(guestCheckouts)
    .where(eq(guestCheckouts.checkoutGroupId, checkoutGroupId))
    .limit(1);
  return row?.id;
}
