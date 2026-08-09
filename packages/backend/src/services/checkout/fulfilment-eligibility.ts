/**
 * Revalidating a destination against every seller in the checkout, BEFORE any
 * stock is reserved and before any payment is created (#105 "Seller and
 * shipping eligibility").
 *
 * This is the seller-readiness gate's sibling, in the same position in
 * `checkout.service` and for the same reason: an eligibility question that
 * needs no inventory to answer must never have taken any, and a refusal that
 * arrives after a PaymentIntent exists has already told the buyer the wrong
 * thing.
 *
 * ## Every refusal names the SELLER, never just "invalid address"
 *
 * #105 eligibility rule 5, and it is not a copy preference: a mixed cart's
 * remedy is to DESELECT the seller that cannot serve the destination, and a
 * buyer cannot do that if the error does not say which one. The seller keys
 * this returns are the same `store:<id>` / `user:<id>` keys the client already
 * passes back in `sellerKeys` for a partial checkout, so the refusal is
 * directly actionable — the shape `assertSellerGroupsPaymentReady` established.
 *
 * ## What "unknown shipping is never free" means here, concretely
 *
 * #105 eligibility rule 6. Mercaria has ONE shipping cost source today: the
 * flat per-method rates in `config.orders.shippingRates` (Moovo owns real rates
 * and this repo must not recreate its zones — see `AGENTS.md` §Shipping). The
 * failure mode the rule warns about is a method whose rate is not configured
 * resolving to `undefined`, arithmetic turning that into `NaN` or `0`, and an
 * order shipping for nothing. {@link resolveShippingCostMinor} refuses instead,
 * so an unpriced method is a refusal and never a discount.
 *
 * ## Pickup fails CLOSED, and that is the whole of the #93 seam
 *
 * #105 eligibility rule 9 asks for pickup locations to be revalidated for
 * freshness, inventory and publication "through #93". #93 is not built: there
 * is no publication state, no pickup-specific inventory view and no per-location
 * hours anywhere in this schema. So {@link assertPickupLocationEligible} refuses
 * every pickup, naming the seller, rather than admitting a collection nobody
 * validated — an order a buyer is told to collect from a warehouse that never
 * offered collection is worse than an honest "not available here".
 *
 * The refusal is deliberately NOT a schema-level removal of `pickup` from the
 * destination union: the contract is what #93 fills in, and a contract that has
 * to be widened again is a contract two clients will disagree about. What #93
 * replaces is the body of ONE function, named below.
 */

import type { ShippingMethod } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { conflict, validationError } from '../../lib/errors/error-codes.js';
import type { CommerceActor } from '../commerce-actor.js';
import type { ResolvedFulfilment } from './destination.js';

/** One seller group as the eligibility gate needs to see it. */
export interface EligibilitySellerGroup {
  /** `store:<id>` or `user:<id>` — the key the client deselects by. */
  sellerKey: string;
  /** Whether this group is a store or a P2P individual. */
  sellerType: 'store' | 'user';
  /** The method chosen for this group, already defaulted. */
  shippingMethod: ShippingMethod;
}

/**
 * Refuse a destination no configured market accepts.
 *
 * The deployment-wide allow-list (`CHECKOUT_DESTINATION_COUNTRIES`) is
 * Mercaria's own market policy and is EMPTY by default, which means
 * unrestricted — exactly today's behaviour, so no existing authenticated
 * checkout changes. The lever exists because a marketplace that launches in one
 * market needs a way to say so that is not "hope nobody types a far-away
 * country", and because #105 asks for the destination country to be validated
 * against what the payment flow supports.
 *
 * It is checked ONCE for the whole checkout, not per seller, because it is a
 * property of the deployment. The per-seller half is
 * {@link assertSellerGroupsAcceptDestination}.
 */
export function assertDestinationCountrySupported(country: string): void {
  const supported = config.checkout.destinationCountries;
  if (supported.length === 0) return;
  if (supported.includes(country)) return;
  throw conflict(
    `We cannot deliver to ${country} yet. Deliveries are available to: ${supported.join(', ')}.`,
  );
}

/**
 * The flat cost of a shipping method, or a refusal.
 *
 * See the module docblock: the point of resolving it through a function rather
 * than indexing the config is that an unconfigured method has one honest
 * answer, and "free" is not it.
 */
export function resolveShippingCostMinor(method: ShippingMethod): number {
  const rate = config.orders.shippingRates[method];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw conflict(
      `Delivery by ${method} is not available right now. Choose another delivery option.`,
    );
  }
  return rate;
}

/**
 * The #93 seam.
 *
 * Today it refuses, because there is nothing to validate against — see the
 * module docblock. When #93 lands, THIS function grows a real body (resolve the
 * location, assert it belongs to the seller, assert it is published for
 * collection, assert it is fresh, assert the lines are collectable there) and
 * nothing else in the checkout path changes: the contract, the snapshot and the
 * refusal shape are all already in place around it.
 */
export function assertPickupLocationEligible(
  locationId: string,
  groups: readonly EligibilitySellerGroup[],
): never {
  if (locationId.length === 0) {
    throw validationError('A pickup destination needs a location.');
  }
  throw conflict(
    `Collection in person is not available yet for ${describeSellers(groups)}. ` +
      'Choose a delivery address instead.',
  );
}

/**
 * The P2P gate — ADR 0003 D18, ADR 0006 G18, #105 actor rule 7.
 *
 * A guest checkout whose group is a `user` seller is refused at GROUP
 * construction, server-side, and is deselectable through the existing
 * `sellerKeys` mechanism — the same seam and the same refusal shape as the
 * payment-readiness gate. #112 owns any future reversal and its evidence; there
 * is no flag here to flip, deliberately, because the criteria are not met and a
 * dormant switch reads as a decision already taken.
 */
export function assertGuestSellerTypesAllowed(
  actor: CommerceActor,
  groups: readonly EligibilitySellerGroup[],
): void {
  if (actor.kind !== 'guest') return;
  const p2p = groups.filter((group) => group.sellerType === 'user');
  if (p2p.length === 0) return;
  throw conflict(
    `Buying from an individual seller needs an Oxy account: ${describeSellers(p2p)}. ` +
      'Sign in, or remove those items to check out with the rest.',
  );
}

/**
 * Revalidate the resolved destination against every selected seller.
 *
 * The per-seller half. Today the only seller-specific dimension Mercaria can
 * answer is the fulfilment METHOD (each group carries its own, #105 eligibility
 * rule 8), because there is no per-seller destination policy anywhere in this
 * schema and inventing one would be recreating the shipping zones Moovo owns
 * (rule 3). What the loop does have is the right SHAPE: it accumulates a list
 * of offending seller keys and refuses naming them, so a seller-scoped policy
 * source — a Moovo capability lookup, a store market setting — drops into this
 * one loop without changing the refusal a client already handles.
 *
 * Inventory is deliberately untouched: this runs before the reservation loop,
 * so a rejection here has taken no stock and leaks none. A refusal names seller
 * keys and a country and nothing about what is in the cart (rule: "inventory is
 * not leaked by a rejection").
 */
export function assertSellerGroupsAcceptDestination(input: {
  actor: CommerceActor;
  fulfilment: ResolvedFulfilment;
  groups: readonly EligibilitySellerGroup[];
}): void {
  assertGuestSellerTypesAllowed(input.actor, input.groups);

  if (input.fulfilment.kind === 'pickup') {
    assertPickupLocationEligible(input.fulfilment.locationId, input.groups);
  }

  assertDestinationCountrySupported(input.fulfilment.address.country);

  // Every group's METHOD must be one this deployment can actually price, and
  // the refusal names the groups whose selection failed rather than the first.
  const unpriceable = input.groups.filter((group) => {
    const rate = config.orders.shippingRates[group.shippingMethod];
    return typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0;
  });
  if (unpriceable.length > 0) {
    throw conflict(
      `The delivery option chosen for ${describeSellers(unpriceable)} is not available. ` +
        'Choose another delivery option for them.',
    );
  }

  // A `pickup` METHOD without a `pickup` DESTINATION is the mixed case rule 2
  // is about: the buyer selected collection for one seller while sending a
  // postal address, and honouring either half alone would be guessing.
  const mismatched = input.groups.filter((group) => group.shippingMethod === 'pickup');
  if (mismatched.length > 0) {
    throw conflict(
      `Collection was chosen for ${describeSellers(mismatched)} but this order has a delivery ` +
        'address. Choose collection for the whole order, or a delivery option for them.',
    );
  }
}

/** A stable, sorted, comma-joined seller-key list for a refusal message. */
function describeSellers(groups: readonly EligibilitySellerGroup[]): string {
  return [...groups.map((group) => group.sellerKey)].sort().join(', ');
}
