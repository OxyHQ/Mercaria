/**
 * The ONE translation from a request's `CommerceActor` to a cart's
 * `CartOwner` (#104, ADR 0003 D8).
 *
 * Two unions, both without a common `id` field, and one function between them.
 * That is the whole mechanism behind invariant I1 — "a guest id is never
 * accepted where an Oxy user id is expected": the compiler forces a `switch` on
 * `kind` here, and nowhere else in the cart path is an owner constructed, so
 * there is no second place for the mapping to be got wrong.
 *
 * `anonymous` maps to `null` rather than to some empty owner. A caller that
 * wants a cart for an anonymous actor gets nothing to pass to the repository,
 * which is the type-level statement of ADR 0003 T10: browsing creates no row.
 * Issuing a session is a separate, explicit, rate-limited act
 * (`issueGuestActor`), reachable only from an eligible stateful write.
 */

import type { CartOwner } from '../db/buyers/cartRepository.js';
import { config } from '../config/index.js';
import type { CommerceActor } from './commerce-actor.js';

/**
 * The owner whose cart this actor may read and write, or `null` when the actor
 * owns no cart.
 *
 * A guest actor maps to `null` when guest CARTS are switched off
 * (`GUEST_CART_ENABLED=false`) even though guest sessions themselves keep
 * resolving. The two flags are deliberately independent: the session flag is
 * about minting credentials, this one is about whether a credential may own
 * commerce state, and #105–#107's guest CHECKOUT gets a third. Collapsing them
 * would mean an incident on one surface took down the others.
 */
export function cartOwnerForActor(actor: CommerceActor): CartOwner | null {
  switch (actor.kind) {
    case 'oxy':
      return { kind: 'oxy_user', oxyUserId: actor.oxyUserId };
    case 'guest':
      return config.guest.cartEnabled
        ? { kind: 'guest_session', guestSessionId: actor.guestSessionId }
        : null;
    case 'anonymous':
      return null;
  }
}

/**
 * Whether an actor with no cart of its own may have a guest session ISSUED for
 * the write it is attempting.
 *
 * Only a genuinely anonymous actor qualifies: an Oxy actor already owns a cart,
 * and a guest actor already has a session (its `null` owner above means guest
 * carts are switched off, which issuing another session would not fix).
 */
export function mayIssueGuestCart(actor: CommerceActor): boolean {
  return actor.kind === 'anonymous' && config.guest.enabled && config.guest.cartEnabled;
}
