/**
 * The guest-P2P checkout gate — server-authoritative, by seller type, and
 * default CLOSED (#112, ADR 0003 D18, ADR 0006 G18).
 *
 * ## Where it runs, and why twice
 *
 * `checkout.service` calls {@link assertGuestP2PCheckoutAllowed} at group
 * construction — before the readiness gate, before any reservation, before an
 * order row exists — so a refusal has taken no stock and leaked nothing about
 * the cart. It calls {@link assertGuestP2PPaymentAllowed} again immediately
 * before the rail is opened, over the orders that were actually created.
 *
 * The second call is #112 checkout behaviour 2 ("revalidate seller and listing
 * guest eligibility immediately before payment creation") and it is what makes
 * acceptance 6 — "mixed carts cannot accidentally charge an ineligible P2P
 * group" — true of the CHARGE rather than of the plan. A Mercaria checkout
 * opens ONE PaymentIntent per checkout group covering every order in it, so the
 * only place that can guarantee no P2P group is on a charge is the statement
 * before the charge. It is deliberately not a repeat of the first call's inputs
 * either: it reads the created ORDERS, so a group that reached order placement
 * through some future path the first gate does not sit on is still refused.
 *
 * Failing there is safe and the shape already existed: `openCheckoutPayment`'s
 * caller rethrows a `MercariaError` unchanged, the orders stay `pending_payment`
 * with their reservations, and the reservation sweep releases them. Nothing is
 * charged, which is the only property that matters at that point.
 *
 * ## Why it refuses unconditionally today
 *
 * `readGuestP2PAuthorization` has no member meaning yes — see
 * `authorization.ts` for why #112's recorded outcome is no-go and why the
 * decision arrives with the flag rather than before it. The policy
 * (`policy.ts`) and the derivation (`eligibility.ts`) are published and
 * exercised through the operator trace, so a go decision wires an evaluator
 * that already runs into the one branch below.
 *
 * ## One reason code, and it names only the P2P sellers
 *
 * `p2p_seller_excluded`, for every criterion and every future dimension: a
 * refusal spanning several conditions gets ONE code so a client cannot vary one
 * input at a time and read out the switchboard (the `guest_rollout_blocked` and
 * `retail_line_ineligible` decision). The message names the offending seller
 * KEYS and nothing else — a mixed cart's remedy is to deselect them through the
 * `sellerKeys` partial-checkout mechanism that already exists, and a refusal
 * that does not say which sellers leaves the buyer nothing to do. It mentions
 * nothing about the cart's contents, so a rejection leaks no inventory.
 */

import type { GuestCheckoutGroupAvailability, OrderSellerType } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import type { CartOwner } from '../../db/buyers/cartRepository.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import type { CommerceActor } from '../commerce-actor.js';
import { readGuestP2PAuthorization } from './authorization.js';

/** One seller group, as the gate needs to see it. */
export interface GuestP2PSellerGroup {
  /** `store:<id>`, `user:<id>` or the retail pseudo-key — what a client deselects by. */
  readonly sellerKey: string;
  /** The order's seller kind. Only `user` is a P2P individual. */
  readonly sellerType: OrderSellerType;
}

/**
 * The P2P groups in a checkout, sorted, or an empty list.
 *
 * `user` is the only seller kind that is a person: `store` is a business and
 * `platform` is Mercaria's own retail. Named rather than inlined so the
 * question "which of these is an individual" is asked in one place — the
 * payment-stage gate below filters ORDERS rather than groups and states the
 * same predicate over its own row shape, which is the only place it is
 * repeated and the reason both are one line long.
 */
export function p2pSellerKeys(groups: readonly GuestP2PSellerGroup[]): string[] {
  return groups
    .filter((group) => group.sellerType === 'user')
    .map((group) => group.sellerKey)
    .sort();
}

/**
 * Whether a dated decision authorizes any bounded scope of guest P2P checkout.
 *
 * Constant `false` today, and the TYPE is why: `GuestP2PAuthorization` has no
 * member meaning yes (see `authorization.ts`). It is a function rather than a
 * constant so a go decision changes one body, and it is written as a comparison
 * against the one state that exists so the diff adding a second member is a
 * diff to this line.
 */
function guestP2PAuthorized(): boolean {
  const { state } = readGuestP2PAuthorization();
  return state !== 'not_authorized';
}

/**
 * Whether a guest may check these groups out.
 *
 * A pure predicate with no throw, so the cart can render the same verdict
 * before checkout that checkout will enforce (#112 "All restrictions must be
 * explicit server policy and visible before checkout"). It answers for the
 * ACTOR the server resolved, never for a kind a client claimed.
 */
export function guestP2PBlockedSellerKeys(
  actor: CommerceActor,
  groups: readonly GuestP2PSellerGroup[],
): string[] {
  if (actor.kind !== 'guest') return [];
  if (guestP2PAuthorized()) return [];
  return p2pSellerKeys(groups);
}

/**
 * What the CART tells a buyer about this group, before they reach checkout.
 *
 * #112 default state 1 and "All restrictions must be explicit server policy and
 * visible before checkout": the cart may show a P2P group, and the same server
 * rule that will refuse the checkout says so on the group itself, so nothing
 * about the refusal is a surprise at the payment step.
 *
 * `undefined` for an Oxy owner, so the field is ABSENT rather than
 * `available` on every authenticated cart — a client that cannot read it
 * renders exactly what it rendered before, and absence is never "blocked".
 *
 * It takes a `CartOwner` rather than a `CommerceActor` because that is what the
 * cart path holds; `cartOwnerForActor` is still the ONE translation between the
 * two, and this function performs none of its own — it switches on the owner's
 * `kind`, the same mechanism, one union along.
 */
export function guestCheckoutAvailabilityFor(
  owner: CartOwner,
  group: GuestP2PSellerGroup,
): GuestCheckoutGroupAvailability | undefined {
  switch (owner.kind) {
    case 'oxy_user':
      return undefined;
    case 'guest_session':
      if (guestP2PAuthorized()) return { status: 'available' };
      return group.sellerType === 'user'
        ? { status: 'blocked', reason: 'p2p_seller_excluded', signInResolves: true }
        : { status: 'available' };
  }
}

/**
 * Refuse a guest checkout containing an individual seller — at group
 * construction, before anything is reserved.
 *
 * A no-op for every non-guest actor. An Oxy buyer's P2P checkout is untouched
 * by this whole domain, which is #112 acceptance 9's other half: a no-go
 * decision leaves both authenticated P2P checkout and guest STORE checkout
 * exactly as they were.
 */
export function assertGuestP2PCheckoutAllowed(input: {
  actor: CommerceActor;
  groups: readonly GuestP2PSellerGroup[];
}): void {
  const blocked = guestP2PBlockedSellerKeys(input.actor, input.groups);
  if (blocked.length === 0) return;

  const authorization = readGuestP2PAuthorization();
  // `authorizationState`, not `authorization`: the logger redacts a field of
  // that name (it is an HTTP header), so the operator would read `[REDACTED]`
  // where the one fact they came for should be.
  log.guest.warn(
    {
      sellerKeys: blocked,
      authorizationState: authorization.state,
      decision: authorization.decision.documentPath,
    },
    '[Guest] P2P checkout refused — no dated decision authorizes any bounded scope',
  );
  throw checkoutRefusal(
    'p2p_seller_excluded',
    `Buying from an individual seller needs an Oxy account: ${blocked.join(', ')}. ` +
      'Sign in, or remove those items to check out with the rest.',
  );
}

/**
 * The pre-payment revalidation seam.
 *
 * Takes the orders about to be charged rather than the groups that were
 * planned, so it is a statement about the charge. The refusal is the SAME
 * reason code and the same sentence: from the buyer's side nothing new has
 * happened, and a second vocabulary here would let a client tell how far into
 * a checkout it got.
 */
export function assertGuestP2PPaymentAllowed(input: {
  actor: CommerceActor;
  orders: readonly { readonly id: string; readonly sellerType: OrderSellerType }[];
}): void {
  if (input.actor.kind !== 'guest' || guestP2PAuthorized()) return;
  // ORDER ids, not seller keys: this refusal is about what is on the charge,
  // and an order id is the handle an operator traces from. Sorted, so two
  // occurrences of one incident produce the same log line.
  const blockedOrderIds = input.orders
    .filter((order) => order.sellerType === 'user')
    .map((order) => order.id)
    .sort();
  if (blockedOrderIds.length === 0) return;

  log.guest.error(
    { orderIds: blockedOrderIds },
    '[Guest] P2P orders reached payment creation for a guest — refusing before the rail is ' +
      'opened; nothing is charged and the reservation sweep releases the stock',
  );
  throw checkoutRefusal(
    'p2p_seller_excluded',
    'Buying from an individual seller needs an Oxy account. Nothing has been charged — sign ' +
      'in, or remove those items to check out with the rest.',
  );
}
