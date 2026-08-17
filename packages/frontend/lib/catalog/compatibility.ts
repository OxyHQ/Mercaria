/**
 * Compatibility and fitment on a product page — a NAMED, FAIL-CLOSED seam
 * (#367 workstream 5, workstream 9 §"Render compatibility/fitment from its
 * dedicated domain").
 *
 * ## Nothing is served, so nothing is rendered, and the reason is stated
 *
 * The compatibility domain is fully modelled and fully unwired.
 * `packages/shared-types/src/compatibility.ts` publishes the whole vocabulary —
 * `CompatibilityRelationView`, `AutomotiveFitmentView`, `VehicleReferenceView`,
 * applicability, verification state, evidence — and
 * `packages/backend/src/services/compatibility/` has **no importer anywhere
 * outside its own directory**. There is no route, no controller and no public
 * DTO on the wire.
 *
 * A storefront has exactly two honest options for that, and this is the second:
 *
 *  1. compose "compatible with" from something else — the product's attributes,
 *     its family, its title. Every one of those is a GUESS, and a wrong fitment
 *     claim is the failure mode with the highest cost in this whole epic: a
 *     brake pad that does not fit is a return at best.
 *  2. refuse, by name, and render nothing.
 *
 * So {@link resolveProductCompatibility} takes a product and answers
 * `unavailable` unconditionally, and {@link ProductCompatibility}'s available
 * branch carries the relation lists a real read would fill. There is no
 * parameter that could make it answer otherwise, and the function is the ONE
 * line the owning issue replaces — the `GuestSellerActivation` and
 * `resolveGuestPortalSubject` device, applied to a display domain.
 *
 * ## Why the type exists at all rather than the call site being absent
 *
 * A page that simply omitted the section would be indistinguishable from one
 * where somebody forgot it, and the next reader would compose the guess. The
 * refusal is a value the surface can render as "we do not publish fitment for
 * this yet", which is a true sentence, and the shape it refuses INTO is written
 * down so the read that closes it has a contract to satisfy.
 */

import type {
  AutomotiveFitmentView,
  CompatibilityRelationView,
} from '@mercaria/shared-types';

/** Why compatibility could not be shown. One member; see the header. */
export type ProductCompatibilityUnavailableReason = 'no_public_compatibility_surface';

export type ProductCompatibility =
  | {
      readonly state: 'available';
      /** What this product is compatible with, and what is compatible with it. */
      readonly relations: readonly CompatibilityRelationView[];
      readonly fitment: readonly AutomotiveFitmentView[];
    }
  | {
      readonly state: 'unavailable';
      readonly reason: ProductCompatibilityUnavailableReason;
    };

/**
 * Refuses, always.
 *
 * The parameter is deliberately kept: the signature a real read needs is the
 * signature this has, so closing the seam changes the body and no call site.
 */
export function resolveProductCompatibility(
  _canonicalProductId: string,
): ProductCompatibility {
  return { state: 'unavailable', reason: 'no_public_compatibility_surface' };
}
