/**
 * The #93 seam #105 left open, closed.
 *
 * `services/checkout/fulfilment-eligibility.ts` used to hold a function that
 * refused EVERY pickup because "no publication, freshness or collectable-
 * inventory state exists for a collection point". All three now exist, and this
 * module is what reads them. The refusal SHAPE is unchanged — a
 * `CheckoutRefusal` naming the seller keys, raised before any stock is
 * reserved — so nothing downstream of the gate learned that pickup became
 * possible.
 *
 * ## Where it runs, and why not one line earlier or later
 *
 * Beside the seller-readiness and destination gates, in `checkout.service` step
 * 4d-bis: after pricing (which is pure and in-memory) and BEFORE the
 * reservation loop. A collection this deployment cannot serve must never have
 * taken units off a shelf, and a refusal that arrives after a PaymentIntent
 * exists has already told the buyer the wrong thing.
 *
 * ## Every LINE is validated at the EXACT location, not the cart as a whole
 *
 * #93 pickup rule 14 ("mixed carts validate each seller location and fulfilment
 * path before payment creation") and acceptance 3 ("pickup reserves the exact
 * location's stock"). A cart with two items from one shop where only one is on
 * that shop's shelf is refused, naming the seller — because the alternative is
 * a buyer told to collect a parcel that is half short.
 *
 * ## What this does NOT do
 *
 * It reserves nothing, commits nothing and touches no inventory. The
 * reservation happens in `checkout.service`'s own loop, at the location this
 * gate resolved, through the EXISTING `reserve(variantId, qty, locationId)` —
 * whose guarded UPDATE has been race-safe at the location grain since the Mongo
 * port. #93 says "reserve stock at the exact selected location through the
 * existing race-safe inventory service", and the whole of the change that
 * needed is passing an id that was already a parameter.
 */

import type { PickupIdentityRequirement, PickupPaymentRequirement } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import type { CommerceActor } from '../commerce-actor.js';
import { findPickupCandidate } from '../../db/pickup/nearbyRepository.js';
import {
  findPublicationByLocationId,
  listActiveClosures,
  listOpeningHours,
} from '../../db/pickup/locationPublicationRepository.js';
import { hasGuestMessageTransport } from '../guest-portal/transport.js';
import { collectionCodesAvailable } from './collection-code.js';
import { derivePickupEligibility } from './eligibility.js';
import type { LocationSchedule } from './hours.js';

/** One line of the checkout, as the gate needs to see it. */
export interface PickupCheckoutLine {
  readonly sellerKey: string;
  readonly sellerType: 'store' | 'user';
  readonly variantId: string;
  readonly quantity: number;
}

/**
 * The snapshot a pickup order carries, resolved once for the whole checkout.
 *
 * Every field comes from the PUBLICATION. Nothing here is read off
 * `locations.address`, which is the operational address a pallet is delivered
 * to and which a merchant may deliberately not have published.
 */
export interface ResolvedPickup {
  readonly locationId: string;
  readonly publicationId: string;
  readonly storeId: string;
  readonly displayName: string;
  readonly publicLine1: string | null;
  readonly publicLine2: string | null;
  readonly publicCity: string | null;
  readonly publicRegion: string | null;
  readonly publicPostalCode: string | null;
  readonly publicCountry: string;
  readonly timezone: string;
  readonly pickupInstructions: string | null;
  readonly identityRequirement: PickupIdentityRequirement;
  readonly paymentRequirement: PickupPaymentRequirement;
}

/**
 * Resolve and validate a chosen collection point for a whole checkout.
 *
 * Refuses naming the SELLERS rather than the location, because a mixed cart's
 * remedy is to deselect one and a buyer cannot do that if the message names a
 * shop they did not choose. It says nothing about WHY beyond "collection is not
 * available", for the reason `eligibility.ts`'s docblock gives: a per-reason
 * answer is a way to read out a merchant's stock position one request at a
 * time.
 */
export async function resolvePickupForCheckout(input: {
  locationId: string;
  actor: CommerceActor;
  lines: readonly PickupCheckoutLine[];
  at: Date;
}): Promise<ResolvedPickup> {
  const locationId = input.locationId.trim();
  if (locationId === '') {
    throw checkoutRefusal('destination_incomplete', 'A pickup destination needs a location.');
  }

  const sellerKeys = [...new Set(input.lines.map((line) => line.sellerKey))].sort();

  if (!config.pickup.storePickupEnabled) {
    // The lever, refused with the same code and the same wording a genuinely
    // ineligible location gets. A buyer cannot act on the difference, and a
    // client that could tell them apart could map the switchboard.
    throw refuse(sellerKeys, ['store_pickup_disabled']);
  }

  const levers = {
    storePickupEnabled: config.pickup.storePickupEnabled,
    guestPickupEnabled: config.pickup.guestPickupEnabled,
    // #85 has not landed and there is no table to read. `false` is
    // `unrecorded`; whether that refuses is
    // `GUEST_SELLER_ACTIVATION_REQUIRED`'s decision, and reusing #107's flag
    // rather than adding a parallel one is deliberate — "is this merchant
    // activated for guest checkout" already has exactly one answer.
    guestSellerActivated: false,
    guestSellerActivationRequired: config.guest.checkoutRollout.sellerActivationRequired,
    guestNotificationTransportAvailable: hasGuestMessageTransport(),
    guestNotificationTransportRequired: config.pickup.guestPickupRequiresNotificationTransport,
  };

  // The publication is read ONCE, before the line loop: every line of one
  // checkout is collected from one place, so re-reading it per line would be N
  // statements answering one question — and the snapshot the order carries has
  // to be a single consistent view of the profile, not a per-line sample of it.
  const publication = await findPublicationByLocationId(locationId);
  if (!publication) throw refuse(sellerKeys, ['location_not_published']);

  const schedule = await loadSchedule(publication.id, publication.timezone, input.at);
  const blocked = new Set<string>();

  for (const line of input.lines) {
    const candidate = await findPickupCandidate({ locationId, variantId: line.variantId });
    if (!candidate) {
      blocked.add('location_not_published');
      continue;
    }

    // The unit count the LINE needs, not merely "some stock": a cart asking for
    // three when the shelf holds one is not collectable, and admitting it would
    // send a buyer to collect a parcel that is short (#93 pickup rule 14).
    if (candidate.available < line.quantity) blocked.add('no_collectable_stock');

    const eligibility = derivePickupEligibility({
      location: {
        publicationState: candidate.publicationState as 'draft' | 'published' | 'withdrawn',
        // Read from the row rather than assumed: the candidate read applies NO
        // eligibility predicate, precisely so a paused location produces a
        // "collection is not available" rather than a "location not found".
        pickupOffered: candidate.pickupOffered,
        pickupPaused: candidate.pickupPaused,
        restricted: candidate.restricted,
        geocoded: candidate.geocoded,
        locationActive: candidate.locationActive,
        storeActive: candidate.storeActive,
        schedule,
      },
      inventory: {
        listingActive: candidate.listingActive,
        availableQuantity: candidate.available,
        stockConfirmedAt: candidate.stockConfirmedAt,
        stockConfirmationIntervalSeconds: candidate.stockConfirmationIntervalSeconds,
      },
      actor: {
        actorKind: input.actor.kind,
        // A `user` seller is refused whatever the location says, which is what
        // makes store guest pickup structurally unable to become P2P guest
        // pickup (acceptance 13). Both sources are consulted so a mislabelled
        // group cannot widen it.
        sellerType:
          line.sellerType === 'user' || candidate.listingOwnerType === 'user' ? 'user' : 'store',
      },
      levers,
      at: input.at,
    });

    if (eligibility.verdict === 'blocked') {
      for (const reason of eligibility.reasons) blocked.add(reason);
    }
  }

  // Checked HERE and not only at publish time: the key can be removed from a
  // running deployment, and a location published while it was configured must
  // stop admitting collections the moment it is not.
  if (publication.identityRequirement !== 'order_number_only' && !collectionCodesAvailable()) {
    blocked.add('store_pickup_disabled');
  }

  if (blocked.size > 0) throw refuse(sellerKeys, [...blocked].sort());

  return {
    locationId,
    publicationId: publication.id,
    storeId: publication.storeId,
    displayName: publication.displayName,
    publicLine1: publication.publicLine1,
    publicLine2: publication.publicLine2,
    publicCity: publication.publicCity,
    publicRegion: publication.publicRegion,
    publicPostalCode: publication.publicPostalCode,
    publicCountry: publication.publicCountry,
    timezone: publication.timezone,
    pickupInstructions: publication.pickupInstructions,
    identityRequirement: publication.identityRequirement,
    paymentRequirement: publication.paymentRequirement,
  };
}

/** The publication's own schedule, for the hours half of the derivation. */
async function loadSchedule(
  publicationId: string,
  timezone: string,
  at: Date,
): Promise<LocationSchedule> {
  const today = at.toISOString().slice(0, 10);
  const [hours, closures] = await Promise.all([
    listOpeningHours([publicationId]),
    listActiveClosures([publicationId], today),
  ]);
  return {
    timezone,
    hours: hours.map((hour) => ({
      weekday: hour.weekday,
      opensMinute: hour.opensMinute,
      closesMinute: hour.closesMinute,
    })),
    closures: closures.map((closure) => ({
      id: closure.id,
      fromDate: closure.fromDate,
      throughDate: closure.throughDate,
      ...(closure.note === null ? {} : { note: closure.note }),
    })),
  };
}

/**
 * ONE refusal for every reason, naming the sellers and no reason at all.
 *
 * The reasons ARE logged — an operator debugging "why can nobody collect from
 * my shop" needs them, and a merchant reading their own dashboard gets them
 * through `derivePickupEligibility` directly. What they never do is reach the
 * buyer, for `guest_rollout_blocked`'s reason.
 */
function refuse(sellerKeys: readonly string[], reasons: readonly string[]): Error {
  log.general.warn({ sellerKeys, reasons }, '[Pickup] checkout refused a collection point');
  return checkoutRefusal(
    'destination_incomplete',
    `Collection in person is not available for ${sellerKeys.join(', ')} right now. ` +
      'Choose a delivery address instead.',
  );
}
