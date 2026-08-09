/**
 * Self-review detection (#76 verification rule 6): "sellers and merchants cannot
 * review their own target through related accounts WHERE DETECTABLE".
 *
 * The qualifier is in the issue and it is honest, so this file is explicit about
 * what Mercaria can see and what it cannot.
 *
 * ## What IS detectable, and it is two independent layers
 *
 *  1. **The purchase itself.** Every verified review spends an eligibility, and
 *     every eligibility names an order line. If the SELLER of that order is the
 *     author, the review is a seller rating their own sale whatever scope it
 *     claims — including `product`, which has no owner of its own to compare
 *     against. This layer therefore covers all five scopes with one check, and
 *     it is the one that cannot be routed around by choosing a different target.
 *  2. **Ownership of the target.** A P2P seller reviewing themselves, a store
 *     member reviewing their own listing, and a merchant's operator reviewing
 *     the merchant. `store_members` IS the "related accounts" signal Mercaria
 *     has: a person who can act for a store is not an arm's-length reviewer of
 *     it, whichever account they used to buy.
 *
 * ## What is NOT detectable, stated rather than implied
 *
 * A seller who buys their own product from a DIFFERENT seller is invisible here,
 * and so is a friend, a second personal Oxy account with no store membership, and
 * an agency reviewing a client. Nothing in Mercaria's data distinguishes those
 * from a genuine buyer, and inventing a heuristic (same shipping address, same
 * device, same payment instrument) would mean reading exactly the buyer-contact
 * and payment data #76 spends its privacy section keeping out of this domain.
 * So they are out of scope, deliberately, and this file does not pretend
 * otherwise.
 */

import type { ReviewScope } from '@mercaria/shared-types';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { findListingById } from '../../db/catalog/listingRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { findActiveLinkByMerchant } from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import { findMerchantById } from '../../db/commerce-graph/merchantRepository.js';
import { getDb } from '../../db/postgres.js';
import { forbidden } from '../../lib/errors/error-codes.js';

/** Everyone who can act for a store — the "related accounts" Mercaria can see. */
async function storeMemberIds(storeId: string): Promise<Set<string>> {
  const store = await findStoreById(storeId);
  return new Set((store?.members ?? []).map((member) => member.oxyUserId));
}

/** The message every branch raises, so a refusal never says WHICH relation it found. */
function refuse(): never {
  // Deliberately uniform: naming the relation would tell an author which of
  // their accounts Mercaria has associated with which store, which is a fact
  // about somebody else's membership as often as it is about their own.
  throw forbidden('You cannot review your own listing, store, merchant or sale');
}

/**
 * Layer 1 — the author is the seller on the order the eligibility came from.
 *
 * Applies to EVERY scope, because every verified review is backed by an order
 * and an order always names its seller. A P2P seller who bought from themselves
 * and a store member who bought from their own store both land here.
 */
export async function assertNotSelfPurchase(
  authorOxyUserId: string,
  orderId: string,
): Promise<void> {
  const order = await findOrderById(orderId);
  if (!order) return;

  if (order.sellerType === 'user' && order.sellerOxyUserId === authorOxyUserId) refuse();
  if (order.sellerType === 'store' && order.storeId) {
    const members = await storeMemberIds(order.storeId);
    if (members.has(authorOxyUserId)) refuse();
  }
}

/**
 * Layer 2 — the author owns, or can act for, the TARGET.
 *
 * Independent of layer 1 on purpose: an unverified review (which policy may
 * allow) spends no eligibility and names no order, so layer 1 has nothing to
 * read. This one still holds.
 *
 * `product` has no branch and that is not an omission: a canonical product
 * belongs to nobody in this database — it is the shared identity many sellers'
 * listings point at (ADR 0002 D6) — so there is no ownership relation to test.
 * Layer 1 is what covers a product review, through the purchase that earned it.
 */
export async function assertNotSelfTarget(
  authorOxyUserId: string,
  scope: ReviewScope,
  targetId: string,
): Promise<void> {
  switch (scope) {
    case 'p2p_seller':
      if (targetId === authorOxyUserId) refuse();
      return;

    case 'p2p_listing': {
      const listing = await findListingById(targetId);
      if (!listing) return;
      if (listing.ownerType === 'user' && listing.oxyUserId === authorOxyUserId) refuse();
      if (listing.ownerType === 'store' && listing.storeId) {
        const members = await storeMemberIds(listing.storeId);
        if (members.has(authorOxyUserId)) refuse();
      }
      return;
    }

    case 'merchant': {
      const merchant = await findMerchantById(getDb(), targetId);
      // The verified claimant is the person #83 established operates this
      // merchant. Reviewing a merchant you were verified as the operator of is
      // the clearest case there is.
      if (merchant?.claimedByOxyUserId === authorOxyUserId) refuse();
      // …and so is anyone who can act for the native store it resolves through,
      // which is how a merchant's staff are reachable without a second identity
      // system (ADR 0002 D4: several verified OPERATORS arrive through
      // `store_members`, never through a second verified claim).
      const link = await findActiveLinkByMerchant(getDb(), targetId);
      if (link) {
        const members = await storeMemberIds(link.storeId);
        if (members.has(authorOxyUserId)) refuse();
      }
      return;
    }

    case 'native_transaction':
    case 'product':
      // Both are covered by layer 1, which every verified review runs through.
      return;
  }
}
