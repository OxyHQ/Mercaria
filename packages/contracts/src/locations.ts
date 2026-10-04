/**
 * A store's physical locations — its shop fronts — and what is on their shelves.
 *
 * ## Where a location IS is not here
 *
 * A location trades from a GoWay place (Mercaria ADR 0013): its name, address,
 * position, hours and their exceptions, photos, rating and every attribute are
 * the PLACE's, and another application reads them from GoWay with
 * `goWayPlaceId`. This contract carries Mercaria's half only — which store the
 * shop front belongs to, whether and on what terms it offers collection, and
 * whether Mercaria's own discovery routes shoppers to it right now. A field
 * that restated a place fact would be a second answer to "when does this shop
 * open", which is exactly what the ADR exists to prevent.
 *
 * ## A location is public only while its place names it back
 *
 * A location is served while it is published, live and unrestricted, its store
 * is live, AND its GoWay place names it back as its business
 * (`commerce.mercaria.store` = the location id, asserted by the place's
 * claimant or by GoWay). That last clause is checked against GoWay on every
 * read, so a link that breaks takes the location out of every answer at the
 * next read. `docs/public-api.md` has the status table.
 *
 * ## Stock is a bounded word, and a number only by the merchant's choice
 *
 * `availability` is `in_stock | low_stock | out_of_stock`, cut at the
 * location's OWN low-stock threshold. `exactQuantity` is present only where the
 * merchant opted in to disclosing it — a consumer that wants "3 left" reads a
 * property that is usually absent, which is the shape that makes the default
 * safe. A count older than the location's own confirmation interval proves
 * nothing about the shelf now, so it reads `out_of_stock` and carries no
 * number, whatever it said.
 */

import { z } from 'zod';
import {
  LOCATION_AVAILABILITY_STATES,
  PICKUP_IDENTITY_REQUIREMENTS,
  PICKUP_PAYMENT_REQUIREMENTS,
  type LocationAvailabilityState,
  type PickupIdentityRequirement,
  type PickupPaymentRequirement,
} from '@mercaria/shared-types';
import { MercariaProductSummarySchema } from './catalog';
import {
  MercariaCountSchema,
  MercariaHttpUrlSchema,
  MercariaIdSchema,
  MercariaTimestampSchema,
} from './primitives';
import { MercariaLocationRefSchema, MercariaStoreRefSchema } from './refs';

/**
 * Whether a product is on the shelf at one location right now.
 *
 * - `in_stock`: a fresh count above the location's low-stock threshold.
 * - `low_stock`: a fresh count above zero, at or below that threshold.
 * - `out_of_stock`: nothing there, or no count confirmed recently enough to say.
 */
export const MERCARIA_LOCATION_AVAILABILITIES = LOCATION_AVAILABILITY_STATES;
export const MercariaLocationAvailabilitySchema = z.enum(
  MERCARIA_LOCATION_AVAILABILITIES as readonly [LocationAvailabilityState, ...LocationAvailabilityState[]],
);
export type MercariaLocationAvailability = z.infer<typeof MercariaLocationAvailabilitySchema>;

/** What a person must present to collect an order here. */
export const MercariaPickupIdentityRequirementSchema = z.enum(
  PICKUP_IDENTITY_REQUIREMENTS as readonly [PickupIdentityRequirement, ...PickupIdentityRequirement[]],
);

/** How a collection is paid for. Every Mercaria collection is paid at checkout. */
export const MercariaPickupPaymentRequirementSchema = z.enum(
  PICKUP_PAYMENT_REQUIREMENTS as readonly [PickupPaymentRequirement, ...PickupPaymentRequirement[]],
);

/** The terms on which a location offers collection. */
export const MercariaLocationPickupSchema = z.object({
  identityRequirement: MercariaPickupIdentityRequirementSchema,
  paymentRequirement: MercariaPickupPaymentRequirementSchema,
  instructions: z.string().nullable().describe('What to do on arrival, in the merchant’s words, or null.'),
});
export type MercariaLocationPickup = z.infer<typeof MercariaLocationPickupSchema>;

/** The store a location belongs to, as a card names it. */
export const MercariaLocationStoreSchema = z.object({
  ref: MercariaStoreRefSchema,
  handle: MercariaIdSchema.describe('The store’s CURRENT handle — presentation, not identity.'),
  name: z.string(),
  logoUrl: MercariaHttpUrlSchema.nullable(),
});
export type MercariaLocationStore = z.infer<typeof MercariaLocationStoreSchema>;

/** One of a store's shop fronts. Its place facts are GoWay's: read them with `goWayPlaceId`. */
export const MercariaLocationSchema = z.object({
  ref: MercariaLocationRefSchema,
  goWayPlaceId: MercariaIdSchema.describe(
    'The GoWay place this location trades from, which names it back. Read the name, address, hours, ' +
      'photos and rating from GoWay with it; an opaque GoWay id, never parsed.',
  ),
  store: MercariaLocationStoreSchema,
  pickup: MercariaLocationPickupSchema.nullable().describe(
    'The collection terms when the merchant offers collection here, else null.',
  ),
  discoverable: z
    .boolean()
    .describe(
      'Whether Mercaria’s own nearby search and collection checkout route shoppers here right now. ' +
        'False says nothing about why.',
    ),
  url: MercariaHttpUrlSchema.describe('The canonical Mercaria web URL for this location: its store’s page, opened on it.'),
});
export type MercariaLocation = z.infer<typeof MercariaLocationSchema>;

/** A product, and whether it is on the shelf at one location. */
export const MercariaLocationProductSchema = z.object({
  product: MercariaProductSummarySchema,
  availability: MercariaLocationAvailabilitySchema,
  exactQuantity: MercariaCountSchema.optional().describe(
    'Units on the shelf, present only where the merchant discloses exact stock and the count is fresh.',
  ),
  stockConfirmedAt: MercariaTimestampSchema.describe(
    'When the count was last confirmed: the oldest of the fresh counts it rests on, or the latest when none is fresh.',
  ),
});
export type MercariaLocationProduct = z.infer<typeof MercariaLocationProductSchema>;
