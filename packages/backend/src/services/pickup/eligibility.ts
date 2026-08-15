/**
 * The derivations: may this location be DISCOVERED, and may this actor COLLECT
 * from it.
 *
 * Two questions, one vocabulary, and both answered from facts passed in. This
 * module imports no repository, no configuration and no database handle — the
 * #121 posture, for the reason #121 gives: the whole value of a derived verdict
 * is that it can be exercised against every combination of inputs without
 * building eleven tables' worth of fixtures, and a module that reads
 * `config.pickup` cannot be.
 *
 * ## Why the verdict is derived rather than stored
 *
 * The inputs sit on `location_publications`, `locations`, `stores`, `listings`,
 * `inventory_levels` and `provider_accounts` — six tables in four domains this
 * one does not own — plus three deployment levers and the clock. Storing a
 * verdict would mean six write paths had to remember to recompute it, and the
 * one that forgot would admit a shopper to a collection at a restricted
 * listing. This is #57's `deriveNativeCheckoutEligibility` divergence from the
 * one-stored-verdict rule, taken for the same reason and with the same payoff:
 * a moderation restriction stops a collection in the statement that applies it,
 * with no sweep in between.
 *
 * ## The buyer never sees a reason, and the reasons still matter
 *
 * A public nearby response OMITS a location it will not serve; it does not
 * explain. Given three published shop fronts and a per-reason answer, a client
 * varying one input at a time reads out a merchant's stock position, their
 * pause levers and their moderation state — #107's `guest_rollout_blocked`
 * reasoning, with more to lose. The codes exist for the merchant's own
 * dashboard (their location, their stock), for the operator trace and for the
 * structured log.
 *
 * ## Severity: `blocked` wins, and every reason is collected
 *
 * Unlike a first-failure gate, both derivations accumulate. A merchant looking
 * at "why is my shop not appearing" needs the whole list, because fixing one of
 * four reasons and reloading four times is how somebody gives up.
 */

import type {
  PickupBlockReason,
  PickupEligibility,
} from '@mercaria/shared-types';
import {
  DEFAULT_OPEN_HORIZON_HOURS,
  opensWithin,
  type LocationSchedule,
} from './hours.js';

/** What the PUBLICATION and its operational location say about themselves. */
export interface PickupLocationFacts {
  readonly publicationState: 'draft' | 'published' | 'withdrawn';
  readonly pickupOffered: boolean;
  readonly pickupPaused: boolean;
  readonly restricted: boolean;
  /** Whether a usable coordinate exists — #93 nearby rule 7's whole content. */
  readonly geocoded: boolean;
  /** `locations.is_active`: does this place route inventory at all. */
  readonly locationActive: boolean;
  /** Whether the owning store is live and unrestricted. */
  readonly storeActive: boolean;
  readonly schedule: LocationSchedule;
}

/** What the LISTING and the stock at this location say. */
export interface PickupInventoryFacts {
  /** `listings.status === 'active'` — a moderation restriction lands here. */
  readonly listingActive: boolean;
  readonly availableQuantity: number;
  /** When the level row was last written. */
  readonly stockConfirmedAt: Date;
  /** The location's OWN declared interval — never a deployment-wide TTL (#68). */
  readonly stockConfirmationIntervalSeconds: number;
}

/** Who is asking, and what the deployment currently permits them. */
export interface PickupActorFacts {
  readonly actorKind: 'oxy' | 'guest' | 'anonymous';
  readonly sellerType: 'store' | 'user';
  /**
   * Whether the seller can be paid. `undefined` means the question was not
   * asked — a public browse does not spend an indexed read per location on it —
   * and is treated as NOT blocking, because the checkout gate asks it for real
   * before any stock moves.
   */
  readonly sellerPaymentReady?: boolean;
}

/** The deployment levers, passed in so this module reads no configuration. */
export interface PickupLevers {
  readonly storePickupEnabled: boolean;
  readonly guestPickupEnabled: boolean;
  /** #85 has not landed; `false` here is `unrecorded`, and see the gate below. */
  readonly guestSellerActivated: boolean;
  readonly guestSellerActivationRequired: boolean;
  /** Whether #108's transport registry is non-empty. */
  readonly guestNotificationTransportAvailable: boolean;
  /** Whether this deployment demands one before serving a guest collection. */
  readonly guestNotificationTransportRequired: boolean;
}

/**
 * Whether a location may appear in a public nearby answer for one variant.
 *
 * Deliberately actor-free: #93 nearby rule 11 says browsing nearby availability
 * must not require signing in, and rule 12 asks for actor-specific checkout
 * eligibility to be a SEPARATE request. Keeping the two derivations apart is
 * what makes that possible without an anonymous caller getting a different set
 * of locations from a signed-in one.
 */
export function deriveLocationDiscoverability(
  location: PickupLocationFacts,
  inventory: PickupInventoryFacts,
  at: Date,
): readonly PickupBlockReason[] {
  const reasons: PickupBlockReason[] = [];

  if (location.publicationState !== 'published') reasons.push('location_not_published');
  if (!location.locationActive) reasons.push('location_not_active');
  if (!location.storeActive) reasons.push('store_unavailable');
  if (location.restricted) reasons.push('location_restricted');
  // An ungeocoded location is not at distance zero — it is NOT NEARBY. #93
  // nearby rule 7 verbatim, and the direction that matters: reading absence as
  // "here" would put every unpinned warehouse at the top of every result.
  if (!location.geocoded) reasons.push('location_not_geocoded');
  if (!location.pickupOffered) reasons.push('pickup_not_offered');
  if (location.pickupPaused) reasons.push('pickup_paused');
  if (!inventory.listingActive) reasons.push('listing_unavailable');
  if (inventory.availableQuantity <= 0) reasons.push('no_collectable_stock');
  if (isStockStale(inventory, at)) reasons.push('inventory_stale');
  if (!opensWithin(location.schedule, at, DEFAULT_OPEN_HORIZON_HOURS)) {
    reasons.push('location_closed');
  }

  // Sorted HERE and not only in `derivePickupEligibility`: the merchant
  // dashboard reads this list directly, and a set of reasons that reorders
  // between two loads of the same page reads as something having changed.
  return dedupe(reasons);
}

/**
 * Whether THIS actor may check out for collection at this location.
 *
 * The discoverability conjunction plus the actor's own. It is a superset by
 * construction — a location nobody may discover is a location nobody may
 * collect from — and stating it that way rather than repeating the clauses is
 * what stops the two answers drifting into disagreement.
 */
export function derivePickupEligibility(input: {
  location: PickupLocationFacts;
  inventory: PickupInventoryFacts;
  actor: PickupActorFacts;
  levers: PickupLevers;
  at: Date;
}): PickupEligibility {
  const reasons: PickupBlockReason[] = [
    ...deriveLocationDiscoverability(input.location, input.inventory, input.at),
  ];

  if (!input.levers.storePickupEnabled) reasons.push('store_pickup_disabled');

  // A P2P seller has no publication, no collection desk and no staff. #93 P2P
  // rule 6 keeps a proximity hint separate from a merchant's collection
  // promise, and this is the enforcement: a `user` seller is refused whatever
  // the actor, so store guest pickup can never become P2P guest pickup
  // (acceptance 13) and there is no lever to flip.
  if (input.actor.sellerType === 'user') reasons.push('p2p_pickup_not_available');

  if (input.actor.sellerPaymentReady === false) reasons.push('seller_not_payment_ready');

  if (input.actor.actorKind === 'guest') {
    reasons.push(...guestReasons(input.levers));
  }

  return reasons.length === 0
    ? { verdict: 'eligible' }
    : { verdict: 'blocked', reasons: dedupe(reasons) };
}

/**
 * #93's "Guest store pickup readiness" conjunction, minus the seven conditions
 * the discoverability derivation already covers.
 *
 * The three that are genuinely guest-specific:
 *
 *  - **The deployment's own guest-pickup lever.** Independent of
 *    `GUEST_COMMERCE_ENABLED` and of the store lever, so guest collection can
 *    be withdrawn without taking authenticated collection or the guest cart
 *    down with it (#93 operations rule 9).
 *  - **#85's activation.** Reusing #107's EXISTING
 *    `GUEST_SELLER_ACTIVATION_REQUIRED` rather than inventing a parallel one:
 *    "is this merchant activated for guest checkout" already has one answer and
 *    a second lever could only disagree with it. `guestSellerActivated` cannot
 *    be true today, so with the flag on every guest collection is refused by
 *    name — the fail-closed direction.
 *  - **A transactional transport.** #93 readiness condition 6. #108 ships the
 *    portal with an EMPTY transport registry and nothing sends, so demanding
 *    one unconditionally would make guest collection unreachable on every
 *    deployment. The lever (`GUEST_PICKUP_REQUIRE_NOTIFICATION_TRANSPORT`,
 *    default off) is what lets a deployment that has wired mail insist on it,
 *    and the default reflects the fact that a guest already reaches their order
 *    through #108's pulled confirmation grant rather than through an email.
 *
 * Readiness condition 8 ("collection verification is implemented where
 * required") needs no clause at all: `PICKUP_ENABLED` demands
 * `PICKUP_COLLECTION_CODE_KEY`, so a deployment that can offer collection can
 * always mint a code.
 */
function guestReasons(levers: PickupLevers): readonly PickupBlockReason[] {
  const reasons: PickupBlockReason[] = [];
  if (!levers.guestPickupEnabled) reasons.push('guest_pickup_disabled');
  if (levers.guestSellerActivationRequired && !levers.guestSellerActivated) {
    reasons.push('guest_seller_not_activated');
  }
  if (levers.guestNotificationTransportRequired && !levers.guestNotificationTransportAvailable) {
    reasons.push('guest_notifications_unavailable');
  }
  return reasons;
}

/**
 * Whether the stock figure is older than the location's own declared interval.
 *
 * Read against the LOCATION's number and never a deployment default — #68's
 * prohibition on a global freshness TTL, applied at the grain that varies. A
 * till writing through in seconds and a nightly connector run are both honest;
 * treating them as equally fresh is what would put a sold-out shelf on a map.
 *
 * A `stockConfirmedAt` in the FUTURE is treated as fresh rather than as an
 * error: clock skew between an ECS task and Postgres is real and small, and
 * refusing on it would delist a location for a fact about our own clocks.
 */
function isStockStale(inventory: PickupInventoryFacts, at: Date): boolean {
  const ageSeconds = (at.getTime() - inventory.stockConfirmedAt.getTime()) / 1000;
  return ageSeconds > inventory.stockConfirmationIntervalSeconds;
}

/** Stable, sorted, de-duplicated reasons — a list a merchant reads twice must not reorder. */
function dedupe(reasons: readonly PickupBlockReason[]): readonly PickupBlockReason[] {
  return [...new Set(reasons)].sort();
}
