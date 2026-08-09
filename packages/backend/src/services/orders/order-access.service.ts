/**
 * The ONE authority for "may this actor see this order" — #106 "Authorization
 * service", ADR 0003 D5/D13/D14/I3.
 *
 * ## Why one service, and not a check per controller
 *
 * #106 buyer-model rule 8 asks for it directly, and the reason is the shape of
 * the mistake it prevents. Before this module, order access was a filter column
 * chosen at each call site: `findOrderMatching({id, buyerOxyUserId})` here,
 * `{id, storeId}` there, `{id, sellerOxyUserId}` somewhere else. Every one of
 * them was correct, and every one of them had to be updated INDEPENDENTLY the
 * moment a second kind of owner existed — a claimed guest order is invisible to
 * a `buyer_oxy_user_id` filter, so the buyer list, the detail route, the cancel
 * route and the payment-status route each had their own chance to forget. One
 * union, one `switch`, one place to add a kind.
 *
 * ## The subject union has no common id field, for `CommerceActor`'s reason
 *
 * A shared `subject.id` would let a store id reach a buyer comparison and a
 * guest grant reach an Oxy one. With no common field, every consumer narrows on
 * `kind` and the compiler enforces invariant I1 at each branch (ADR 0003 D1).
 *
 * ## A cart credential is not an order credential, structurally (I3)
 *
 * {@link orderAccessSubjectForCommerceActor} maps a `guest` actor — a live cart
 * session — to NO SUBJECT, and an `anonymous` actor likewise. That is the whole
 * of #106's reject rule 4 and ADR 0003 I3: a `mgs_` token cannot become order
 * access one second after checkout or one month later, because the translation
 * that would carry it there returns `null`. Guest order access is a SEPARATE,
 * scoped, expiring credential (`guest_order_access_grants`, D5) and #108 owns
 * it; see {@link resolveGuestPortalSubject}, which publishes the contract and
 * refuses unconditionally until then.
 *
 * ## What this service is NOT
 *
 * It does not check store PERMISSIONS. `requireStorePermission('orders:read')`
 * already runs on the `/admin/stores/:storeId/*` router and is the thing that
 * decides whether a MEMBER may act for a store at all; this service answers the
 * different question of whether an ORDER belongs to the store they are acting
 * for. Folding the two together would put a permission matrix in the order
 * domain and an order predicate in the membership domain, and each would then
 * be checked in two places.
 *
 * It also takes no email, no phone, no order number and no contact field of any
 * kind — #106 reject rules 1, 2 and 5, held by the signature. An "order number
 * plus email" credential is not refused by a branch below; it is unrepresentable
 * in the parameter list (invariants I2/I4).
 */

import type { OrderBuyer, OrderSellerType } from '@mercaria/shared-types';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import type { CommerceActor } from '../commerce-actor.js';
import { accountWithBuyerAccess, orderBuyerOf } from './order-buyer.js';

/**
 * A live, scoped guest order-portal grant — ADR 0003 D5, owned by #108.
 *
 * The contract is stated here because this service is what will consume it, and
 * a contract invented later by whoever needs it is how a second, weaker one
 * appears. Three properties matter and each is a refusal in
 * {@link authorizeOrderAccess}: the SCOPE (`checkoutGroupId` — there is no
 * grant to "an email's orders"), the LIVENESS (`expiresAt` / `revokedAt`), and
 * the PROOF (`emailVerified`, true only when the chain includes a consumed
 * magic link).
 */
export interface GuestOrderPortalGrant {
  /** The `guest_order_access_grants` row id. An audit handle, not a credential. */
  readonly grantId: string;
  /** The ONE checkout group this grant authorizes, and nothing outside it. */
  readonly checkoutGroupId: string;
  /** True only when a magic-link exchange proved possession of the inbox (D17). */
  readonly emailVerified: boolean;
  /** Exchange: 15 minutes. Portal: 30 days. */
  readonly expiresAt: Date;
  /** Set by "secure my access", by a claim (D14) or by an operator. */
  readonly revokedAt: Date | null;
}

/**
 * Who is asking. Exactly one kind per request, resolved by the caller's own
 * middleware, and deliberately with NO common id field.
 */
export type OrderAccessSubject =
  /** The original Oxy buyer, or the Oxy account that claimed a guest order. */
  | { readonly kind: 'oxy_account'; readonly oxyUserId: string }
  /** A scoped guest order-portal session (#108). */
  | { readonly kind: 'guest_portal'; readonly grant: GuestOrderPortalGrant }
  /** A member acting for a store, whose permission the router already checked. */
  | { readonly kind: 'store_member'; readonly storeId: string }
  /** An individual P2P seller reading an order they must fulfil. */
  | { readonly kind: 'p2p_seller'; readonly sellerOxyUserId: string }
  /** Mercaria staff on the payment-operator allow-list. */
  | { readonly kind: 'operator'; readonly operatorOxyUserId: string };

/** Why access was GRANTED. Bounded, so an audit line can name it. */
export const ORDER_ACCESS_GRANT_REASONS = [
  'original_oxy_buyer',
  'claiming_oxy_account',
  'guest_portal_grant',
  'store_member',
  'p2p_seller',
  'operator',
] as const;

/** One of {@link ORDER_ACCESS_GRANT_REASONS}. */
export type OrderAccessGrantReason = (typeof ORDER_ACCESS_GRANT_REASONS)[number];

/**
 * Why access was REFUSED.
 *
 * Bounded and distinct so the matrix is testable and an operator trace can say
 * which wall an attempt hit. It is NOT what an HTTP caller learns: every
 * refusal is answered 404 by the routes, because "this order exists but is not
 * yours" is a fact about somebody else's purchase.
 */
export const ORDER_ACCESS_DENIAL_REASONS = [
  /** A cart session or no credential at all — I3, reject rule 4. */
  'credential_not_order_scoped',
  /** An Oxy account that is neither the original buyer nor the claimant. */
  'not_the_buyer',
  /** A guest order nobody has claimed: no Oxy account owns it yet. */
  'order_unclaimed',
  /** The grant authorizes a different checkout group — reject rule 1. */
  'grant_scope_mismatch',
  'grant_expired',
  'grant_revoked',
  /** A grant with no proven inbox behind it (D17). */
  'grant_not_email_verified',
  /** A sibling seller reaching for another seller's order — reject rule 3. */
  'not_this_sellers_order',
] as const;

/** One of {@link ORDER_ACCESS_DENIAL_REASONS}. */
export type OrderAccessDenialReason = (typeof ORDER_ACCESS_DENIAL_REASONS)[number];

/** The verdict. A discriminated union, so a caller cannot read a reason it did not get. */
export type OrderAccessDecision =
  | { readonly allowed: true; readonly reason: OrderAccessGrantReason }
  | { readonly allowed: false; readonly reason: OrderAccessDenialReason };

/**
 * The order facts an access decision reads, and no others.
 *
 * Structural rather than `OrderRecord`: the decision needs six values and
 * naming them is what makes it obvious that a contact, a total, a line item and
 * a payment reference are not among them. Nothing here can be a credential.
 */
export interface OrderAccessFacts {
  readonly id: string;
  readonly buyer: OrderBuyer;
  readonly checkoutGroupId: string | null;
  readonly sellerType: OrderSellerType;
  readonly sellerOxyUserId: string | null;
  readonly storeId: string | null;
}

/**
 * The subject a commerce request's actor becomes — or `null`.
 *
 * `null` for a `guest` actor is the load-bearing line in this file: a live cart
 * session, however fresh, is not order access. It is also `null` for
 * `anonymous`. Neither is a special case to remember; both fall out of the
 * `switch`, and adding an actor kind without deciding this question will not
 * compile.
 */
export function orderAccessSubjectForCommerceActor(
  actor: CommerceActor,
): OrderAccessSubject | null {
  switch (actor.kind) {
    case 'oxy':
      return { kind: 'oxy_account', oxyUserId: actor.oxyUserId };
    case 'guest':
      // I3, and the reason this is a `return null` rather than a check further
      // down: there is no order-scoped credential in a `GuestActor` to examine.
      // `presentedGuestSessionId` on an OxyActor is likewise never read here —
      // its only legitimate consumers are cart merge (#104) and claim (#109).
      return null;
    case 'anonymous':
      return null;
  }
}

/**
 * The #108 seam, CLOSED — and closed as a pure translation rather than a
 * lookup.
 *
 * #106 wrote this function expecting #108 to replace its body with "hash the
 * presented `mgp_` token, resolve the row, apply D5's liveness rules". It does
 * all three, and none of them happens here: `services/guest-portal/` owns the
 * token shape, the hash, the indexed lookup and the liveness predicate, and
 * this module receives an already-resolved grant.
 *
 * The divergence is deliberate and it is in the direction #106's own docblock
 * argues for two paragraphs above. `authorizeOrderAccess` is "pure, total and
 * side-effect free — no database, no clock beyond the one passed in, no
 * configuration", which is what makes the six accepts and six rejects a table a
 * test can drive; putting a `getDb()` call in the same module would give this
 * file a database dependency for the sake of one function, and every consumer
 * of the pure decision would inherit it.
 *
 * It still returns `null` for the ordinary case — no portal credential on this
 * request — because a throw would turn an anonymous browse into a 500.
 */
export function resolveGuestPortalSubject(
  grant: GuestOrderPortalGrant | null | undefined,
): OrderAccessSubject | null {
  if (grant === null || grant === undefined) return null;
  return { kind: 'guest_portal', grant };
}

/**
 * The six facts an access decision reads, projected from a stored order.
 *
 * Kept beside {@link OrderAccessFacts} rather than in the repository, so the
 * projection and the decision stay in one file and cannot drift: adding a field
 * to the decision without deciding where it comes from will not compile. The
 * `OrderRecord` import is type-only, so this module still reaches no database.
 */
export function orderAccessFactsFromRecord(order: OrderRecord): OrderAccessFacts {
  return {
    id: order.id,
    buyer: orderBuyerOf(order),
    checkoutGroupId: order.checkoutGroupId,
    sellerType: order.sellerType,
    sellerOxyUserId: order.sellerOxyUserId,
    storeId: order.storeId,
  };
}

/**
 * May this subject see this order?
 *
 * Pure, total and side-effect free — no database, no clock beyond the one
 * passed in, no configuration. That is what makes the six accepts and the six
 * rejects of #106's authorization section a TABLE a test can drive rather than
 * a behaviour assembled from four routes.
 *
 * @param now - The instant grant liveness is judged against. Injected so the
 *   expiry branch is testable without waiting; every caller passes `new Date()`.
 */
export function authorizeOrderAccess(
  subject: OrderAccessSubject,
  order: OrderAccessFacts,
  now: Date,
): OrderAccessDecision {
  switch (subject.kind) {
    case 'oxy_account': {
      // The ORIGINAL buyer and the CLAIMANT are two different accepts and are
      // reported as two different reasons, because they are two different
      // facts: one placed the order, the other was later given ownership of it.
      // `accountWithBuyerAccess` is the single derivation both read, so the
      // detail route and the list predicate cannot drift apart.
      if (order.buyer.origin === 'oxy') {
        return order.buyer.oxyUserId === subject.oxyUserId
          ? { allowed: true, reason: 'original_oxy_buyer' }
          : { allowed: false, reason: 'not_the_buyer' };
      }
      const claimant = accountWithBuyerAccess(order.buyer);
      if (claimant === undefined) {
        // An unclaimed guest order, or an external import. Distinguished from
        // `not_the_buyer` so the matrix says WHICH wall was hit — and note it
        // is reached the same way after an audited unclaim (D6 permits
        // value → NULL), which is #106 reject rule 6: revoking a claim revokes
        // the access, with no second mechanism to keep in step.
        return { allowed: false, reason: 'order_unclaimed' };
      }
      return claimant === subject.oxyUserId
        ? { allowed: true, reason: 'claiming_oxy_account' }
        : { allowed: false, reason: 'not_the_buyer' };
    }

    case 'guest_portal': {
      const { grant } = subject;
      // The SCOPE first. An order with no checkout group (a connector import)
      // can never match, because `null === anything` is false — stated as a
      // comparison rather than as a null guard so there is no branch in which a
      // missing group could be read as a wildcard.
      if (order.checkoutGroupId !== grant.checkoutGroupId) {
        return { allowed: false, reason: 'grant_scope_mismatch' };
      }
      if (grant.revokedAt !== null) return { allowed: false, reason: 'grant_revoked' };
      if (grant.expiresAt.getTime() <= now.getTime()) {
        return { allowed: false, reason: 'grant_expired' };
      }
      // D17: retrospective reads of a placed order need proof of the inbox. A
      // `post_checkout` grant (`emailVerified: false`) tracks STATUS from the
      // device that bought — #108 decides what that narrower view contains, and
      // full order access is not it.
      if (!grant.emailVerified) {
        return { allowed: false, reason: 'grant_not_email_verified' };
      }
      return { allowed: true, reason: 'guest_portal_grant' };
    }

    case 'store_member': {
      // `sellerType` is tested as well as `storeId`, so a P2P order that
      // somehow carried a store id could not be reached from a store. The pair
      // is what `orders_seller_exclusivity_check` guarantees; asking for both
      // means this decision does not depend on that guarantee holding.
      return order.sellerType === 'store' && order.storeId === subject.storeId
        ? { allowed: true, reason: 'store_member' }
        : { allowed: false, reason: 'not_this_sellers_order' };
    }

    case 'p2p_seller': {
      return order.sellerType === 'user' && order.sellerOxyUserId === subject.sellerOxyUserId
        ? { allowed: true, reason: 'p2p_seller' }
        : { allowed: false, reason: 'not_this_sellers_order' };
    }

    case 'operator': {
      // Unconditional, and that is the point of an operator allow-list: the
      // gate is membership of `PAYMENT_OPERATOR_OXY_USER_IDS`, checked by
      // `requirePaymentOperator` before a subject of this kind can exist. A
      // second condition here would be a second, weaker gate.
      return { allowed: true, reason: 'operator' };
    }
  }
}

/**
 * The database predicate a subject's LIST read is scoped by.
 *
 * The list path cannot use {@link authorizeOrderAccess}: filtering a million
 * rows in JavaScript is not an authorization strategy. So the scope is a
 * separate translation — and because two representations of one rule can
 * disagree, `order-access.realdb.test.ts` drives the SAME order matrix through
 * both and fails if a scoped read and the pure decision ever answer
 * differently.
 *
 * `null` means "this subject lists no orders": a portal grant lists by GROUP
 * (#108's own read, scoped by `checkout_group_id`) rather than by a buyer-style
 * predicate, and an operator does not get an unbounded list of everybody's
 * orders — the operator surface opens from a named handle (#50's five), never
 * from an enumeration.
 */
export function orderListScopeForSubject(subject: OrderAccessSubject): OrderListScope | null {
  switch (subject.kind) {
    case 'oxy_account':
      return { kind: 'buyer_or_claimant', oxyUserId: subject.oxyUserId };
    case 'store_member':
      return { kind: 'store', storeId: subject.storeId };
    case 'p2p_seller':
      return { kind: 'p2p_seller', sellerOxyUserId: subject.sellerOxyUserId };
    case 'guest_portal':
      return null;
    case 'operator':
      return null;
  }
}

/** The three list predicates a subject can be scoped by. */
export type OrderListScope =
  | { readonly kind: 'buyer_or_claimant'; readonly oxyUserId: string }
  | { readonly kind: 'store'; readonly storeId: string }
  | { readonly kind: 'p2p_seller'; readonly sellerOxyUserId: string };
