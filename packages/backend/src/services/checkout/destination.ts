/**
 * Turning a `CheckoutDestination` plus a `CommerceActor` into ONE resolved
 * fulfilment target (#105 "Actor rules").
 *
 * This module is the whole of the actor half of #105, and every rule in it is
 * structural rather than a validation branch somebody has to remember:
 *
 *  - **A guest can never reference an Oxy user's saved address.** Not because a
 *    check refuses it, but because reading the address book needs an
 *    `oxyUserId` and {@link addressBookOwnerForActor} is the only source of
 *    one — and it is a `switch` on `kind` over a union with no common `id`
 *    field (ADR 0003 D1/I1). The guest branch has nothing to pass, so the call
 *    does not type-check. This is `cartOwnerForActor`'s mechanism, one domain
 *    over, deliberately.
 *  - **An inline authenticated address is not saved unless separately and
 *    explicitly requested.** `saveToAddressBook` is a distinct opt-in field
 *    with a default of absent, and the persistence happens in a distinct call
 *    the caller makes AFTER the order is placed — so a failure to save can
 *    never fail a checkout, and a checkout can never grow the address book as a
 *    side effect.
 *  - **Pickup requires no invented shipping address.** The pickup branch
 *    produces no `NormalizedCheckoutAddress` at all; there is no code path that
 *    could fabricate a street for a collection.
 *  - **Contact is never taken from an Oxy profile.** Nothing here reads Oxy.
 *    Absent contact is absent.
 *
 * ## The v1 `addressId` contract
 *
 * `normalizeCheckoutContract` maps a v1 `{addressId}` body onto
 * `{type: 'saved_address', addressId}` before anything else runs. That is a
 * VERSIONED CONTRACT and not a compatibility shim: a shipped mobile build
 * cannot be recalled, and the alternative is refusing a real buyer's checkout
 * over a field name. It retires when the supported client versions have
 * migrated (#105 migration rule 7). Sending both spellings is a 400, because a
 * precedence rule between two names for one field is a thing nobody would
 * remember correctly.
 */

import type {
  CheckoutDestination,
  CheckoutInput,
  ShippingMethod,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { findAddress } from '../../db/buyers/addressRepository.js';
import { forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import type { CommerceActor } from '../commerce-actor.js';
import {
  normalizeCheckoutAddress,
  normalizeCheckoutContact,
  type NormalizedCheckoutAddress,
  type NormalizedCheckoutContact,
} from './contact.js';

/**
 * The buyer whose saved addresses may be read.
 *
 * A one-field object rather than a bare string, for the reason ADR 0003 D1
 * gives for the actor union itself: a bare `string` parameter accepts a guest
 * session id just as happily as an Oxy account id, and the whole point of the
 * exercise is that those two id spaces must not be interchangeable at a call
 * site. Naming the field makes the mistake visible in a diff.
 */
export interface AddressBookOwner {
  readonly oxyUserId: string;
}

/**
 * The ONE actor to address-book translation.
 *
 * `null` for a guest and for an anonymous caller: neither owns an address book,
 * and there is nothing to hand a repository. That is the type-level statement
 * of #105 actor rule 2 — see the module docblock.
 */
export function addressBookOwnerForActor(actor: CommerceActor): AddressBookOwner | null {
  switch (actor.kind) {
    case 'oxy':
      return { oxyUserId: actor.oxyUserId };
    case 'guest':
      return null;
    case 'anonymous':
      return null;
  }
}

/** Ship to a validated postal address. */
export interface ShippingFulfilment {
  kind: 'shipping';
  /** The immutable snapshot each seller order will carry. */
  address: NormalizedCheckoutAddress;
  /** Which contract branch produced it — recorded in structured logs. */
  source: 'saved_address' | 'inline_shipping_address';
  /**
   * The buyer explicitly asked to keep this address, with an optional label.
   * Present ONLY on the inline branch, and only for an Oxy actor.
   */
  saveToAddressBook?: { label?: string };
}

/** Collect in person. Carries no address, by construction. */
export interface PickupFulfilment {
  kind: 'pickup';
  locationId: string;
  pickupContact: NormalizedCheckoutContact;
}

/** Where this checkout's goods go, resolved and validated. */
export type ResolvedFulfilment = ShippingFulfilment | PickupFulfilment;

/** Everything #105 resolves out of a checkout body before pricing starts. */
export interface ResolvedCheckoutContract {
  fulfilment: ResolvedFulfilment;
  /**
   * The buyer's contact for this checkout.
   *
   * Guaranteed present for a guest actor (a `guest_checkouts` row cannot exist
   * without it — ADR 0003 D4) and optional for an Oxy actor, whose
   * transactional channel is their Oxy account.
   */
  contact?: NormalizedCheckoutContact;
  /** Explicit, separate, defaulting to false (#105 privacy rules 1-2). */
  marketingOptIn: boolean;
  /** The shipping method this fulfilment implies, before per-seller selection. */
  impliedShippingMethod: ShippingMethod | undefined;
}

/**
 * Collapse the two contract versions into one destination, refusing an
 * ambiguous body.
 *
 * Exported so the contract-version tests can drive it directly: "an old client
 * still works" is a claim about THIS function, and asserting it at the HTTP
 * boundary as well is belt and braces rather than the primary evidence.
 */
export function destinationFromInput(input: CheckoutInput): CheckoutDestination {
  if (input.destination && input.addressId !== undefined) {
    throw validationError(
      'Send either `destination` or the legacy `addressId`, not both.',
    );
  }
  if (input.destination) return input.destination;
  if (input.addressId !== undefined) {
    // The v1 contract, mapped rather than special-cased: from here on there is
    // exactly one destination shape in the system, and no downstream code
    // learns that an older client exists.
    return { type: 'saved_address', addressId: input.addressId };
  }
  throw validationError('A checkout needs a delivery destination.');
}

/**
 * Resolve, validate and authorize the destination and contact of one checkout.
 *
 * Runs BEFORE any stock is reserved and before any payment exists — a question
 * that needs no inventory to answer must never have taken any, which is the
 * ordering `checkout.service` already applies to pricing, seller readiness and
 * currency eligibility.
 */
export async function resolveCheckoutContract(
  actor: CommerceActor,
  input: CheckoutInput,
): Promise<ResolvedCheckoutContract> {
  const destination = destinationFromInput(input);
  const contact = input.contact ? normalizeCheckoutContact(input.contact) : undefined;

  if (actor.kind === 'guest' && contact === undefined) {
    // #105 actor rule 1. Refused HERE rather than at the schema, because the
    // requirement is a property of the ACTOR and a schema cannot see one: the
    // same body is complete for an Oxy buyer and incomplete for a guest.
    throw validationError('Guest checkout needs an email address to send your receipt to.');
  }

  const fulfilment = await resolveFulfilment(actor, destination);

  return {
    fulfilment,
    ...(contact ? { contact } : {}),
    marketingOptIn: input.marketingOptIn === true,
    impliedShippingMethod: fulfilment.kind === 'pickup' ? 'pickup' : undefined,
  };
}

/** The destination half, with the actor rules applied. */
async function resolveFulfilment(
  actor: CommerceActor,
  destination: CheckoutDestination,
): Promise<ResolvedFulfilment> {
  switch (destination.type) {
    case 'saved_address': {
      const owner = addressBookOwnerForActor(actor);
      if (!owner) {
        // A guest naming a saved address is refused with the reason, not with
        // "address not found": the address book is an account feature and
        // saying so is what tells the buyer that signing in is the remedy. It
        // leaks nothing — the id was theirs to invent, and no lookup ran.
        throw forbidden('Saved addresses are part of an Oxy account. Enter an address instead.');
      }
      const address = await findAddress(owner.oxyUserId, destination.addressId);
      if (!address) {
        throw notFound('Address not found');
      }
      return {
        kind: 'shipping',
        // Re-normalized rather than trusted: a row written before #105's rules
        // existed can carry a value they would now refuse, and the fulfilment
        // snapshot is the thing a carrier and an invoice read. Normalizing here
        // also means the saved and inline branches cannot diverge.
        address: normalizeCheckoutAddress({
          recipientName: address.recipientName,
          line1: address.line1,
          ...(address.line2 !== null ? { line2: address.line2 } : {}),
          city: address.city,
          ...(address.region !== null ? { region: address.region } : {}),
          postalCode: address.postalCode,
          country: address.country,
          ...(address.phone !== null ? { phone: address.phone } : {}),
        }),
        source: 'saved_address',
      };
    }

    case 'inline_shipping_address': {
      if (actor.kind === 'guest' && !config.guest.inlineDestinationEnabled) {
        // The #105 lever, independent of the cart lever — see `config`. A guest
        // whose credential still owns a cart is told plainly that checkout is
        // off rather than being handed a validation error about a field.
        throw forbidden('Guest checkout is temporarily unavailable. Sign in to place this order.');
      }
      if (actor.kind === 'anonymous') {
        throw forbidden('Add something to your cart before checking out.');
      }
      const address = normalizeCheckoutAddress(destination.address);
      // Saving is an Oxy-account act. A guest asking for it is not an error —
      // a shared form can send the field — it simply cannot happen, and the
      // absence of the key here is what makes it unable to.
      const owner = addressBookOwnerForActor(actor);
      const wantsSave = owner !== null && destination.saveToAddressBook === true;
      const label = destination.saveLabel?.trim();
      return {
        kind: 'shipping',
        address,
        source: 'inline_shipping_address',
        ...(wantsSave
          ? { saveToAddressBook: label ? { label } : {} }
          : {}),
      };
    }

    case 'pickup': {
      if (actor.kind === 'anonymous') {
        throw forbidden('Add something to your cart before checking out.');
      }
      if (actor.kind === 'guest' && !config.guest.inlineDestinationEnabled) {
        throw forbidden('Guest checkout is temporarily unavailable. Sign in to place this order.');
      }
      const locationId = destination.locationId.trim();
      if (locationId.length === 0) {
        throw validationError('A pickup destination needs a location.');
      }
      return {
        kind: 'pickup',
        locationId,
        pickupContact: normalizeCheckoutContact(destination.pickupContact),
      };
    }
  }
}
