/**
 * The referral destination ALLOW-LIST — the one place a stored
 * `{destinationType, destinationRef}` pair becomes a Mercaria route.
 *
 * Issue #142: "Links must resolve only to allowlisted Mercaria routes and
 * cannot become an open redirect." The schema holds half of that (the closed
 * destination-type CHECK, no URL column anywhere); this module holds the other
 * half: the ONLY output is a relative PATH composed from a closed template and
 * a validated opaque id. There is no function here that accepts a URL, returns
 * an absolute URL, or interpolates anything a caller controls beyond an id
 * that must match {@link DESTINATION_REF_PATTERN} — so "arbitrary destination"
 * is not a rejected input, it is an inexpressible one.
 */

import type { ReferralDestinationType } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/**
 * What a destination reference may look like: the two id shapes this database
 * holds (24-hex ObjectId, uuid v7) and store handles. Anything with a slash,
 * a colon, a dot or a percent sign — anything that could steer a path — is
 * refused before it is stored.
 */
const DESTINATION_REF_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** A validated internal destination, ready to store on an instrument. */
export interface ReferralDestination {
  destinationType: ReferralDestinationType;
  /** Present exactly when the type addresses an entity. */
  destinationRef?: string;
}

/**
 * Validate a caller-supplied destination into the storable shape.
 *
 * @throws `validationError` when the type/ref pairing is incomplete or the
 *   reference is not a plain id.
 */
export function validateReferralDestination(input: {
  destinationType: ReferralDestinationType;
  destinationRef?: string;
}): ReferralDestination {
  if (input.destinationType === 'home') {
    if (input.destinationRef !== undefined) {
      throw validationError('A home destination carries no reference');
    }
    return { destinationType: 'home' };
  }
  const ref = input.destinationRef;
  if (ref === undefined || !DESTINATION_REF_PATTERN.test(ref)) {
    throw validationError(
      `A ${input.destinationType} destination requires a plain id reference`,
    );
  }
  return { destinationType: input.destinationType, destinationRef: ref };
}

/**
 * The relative Mercaria route a destination resolves to. A RELATIVE path —
 * never an absolute URL — so the storefront applies its own origin and no
 * stored value can point a browser off-site.
 */
export function referralDestinationPath(destination: ReferralDestination): string {
  switch (destination.destinationType) {
    case 'home':
      return '/';
    case 'listing': {
      const ref = requireRef(destination);
      return `/listings/${ref}`;
    }
    case 'collection': {
      const ref = requireRef(destination);
      return `/collections/${ref}`;
    }
    case 'store': {
      const ref = requireRef(destination);
      return `/stores/${ref}`;
    }
  }
}

/** The reference, re-validated at READ time — stored data is not exempt. */
function requireRef(destination: ReferralDestination): string {
  const ref = destination.destinationRef;
  if (ref === undefined || !DESTINATION_REF_PATTERN.test(ref)) {
    throw validationError(
      `A ${destination.destinationType} destination requires a plain id reference`,
    );
  }
  return ref;
}
