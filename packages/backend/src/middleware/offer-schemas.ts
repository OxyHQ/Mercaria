/**
 * Request schemas for the offer surfaces (#57).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types` rather than being retyped, so a schema cannot accept
 * a value the database CHECK then refuses.
 *
 * `.strict()` is doing real work here, and specifically: no schema in this file
 * carries a `checkoutEligible`, `sellerRole`, `isMarketplace` or `freshness`
 * field, so no HTTP caller can propose any of them. All four are DERIVED — from
 * live listing state, from two foreign keys and from a deadline against the
 * clock — and a request shape able to carry one would be the second authority
 * this domain exists without.
 *
 * Nor is there a schema for creating an offer. External offers arrive through
 * an in-process ingestion call (#62) that already holds a verified
 * `source_records` row; native offers are a projection nobody submits. A public
 * write surface for offers would be a way to publish a price nobody observed.
 */

import { z } from 'zod';
import {
  OFFER_AVAILABILITY_STATES,
  OFFER_CONDITIONS,
  OFFER_KINDS,
  OFFER_RETIREMENT_REASONS,
  type OfferAvailability,
  type OfferCondition,
  type OfferKind,
  type OfferRetirementReason,
} from '@mercaria/shared-types';

const KIND_VALUES = OFFER_KINDS as readonly [OfferKind, ...OfferKind[]];
const AVAILABILITY_VALUES = OFFER_AVAILABILITY_STATES as readonly [
  OfferAvailability,
  ...OfferAvailability[],
];
const CONDITION_VALUES = OFFER_CONDITIONS as readonly [OfferCondition, ...OfferCondition[]];
const RETIREMENT_REASON_VALUES = OFFER_RETIREMENT_REASONS as readonly [
  OfferRetirementReason,
  ...OfferRetirementReason[],
];

const entityId = z.string().trim().min(1).max(64);
/** ISO 3166-1 alpha-2, matching `offers_country_check` rather than approximating it. */
const country = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);

/** A comma-separated query value, as a browser and a fetch client both send it. */
function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
}

/**
 * `GET /offers` — the comparison read.
 *
 * Exactly one scope, refused at the schema rather than at the service, so an
 * ambiguous request never reaches a query. `includeStale` exists because an
 * operator investigating a lapsed offer needs to see it, and it defaults to
 * excluding: a buyer-facing comparison must not show terms the source stopped
 * standing behind (issue external rule 3).
 */
export const offerListQuerySchema = z
  .object({
    canonicalVariantId: entityId.optional(),
    canonicalProductId: entityId.optional(),
    country: country.optional(),
    kinds: commaList(KIND_VALUES).optional(),
    availability: commaList(AVAILABILITY_VALUES).optional(),
    conditions: commaList(CONDITION_VALUES).optional(),
    includeStale: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.canonicalVariantId ? 1 : 0) + (query.canonicalProductId ? 1 : 0) === 1,
    { message: 'Provide exactly one of canonicalVariantId or canonicalProductId' },
  );

/**
 * `POST /internal/offers/:id/retire` — an operator's own hand.
 *
 * The reason is bounded and MANDATORY, the `payment_repairs` discipline: an
 * unattributed removal of a seller's offer from a comparison is not one anybody
 * can audit. The `reason` value set excludes nothing — an operator may record
 * that a source vanished — because the operator is stating what they OBSERVED,
 * and narrowing it to `operator` would lose that.
 */
export const offerRetireSchema = z
  .object({
    reason: z.enum(RETIREMENT_REASON_VALUES),
    note: z.string().trim().min(10).max(2_000),
  })
  .strict();

/** `POST /internal/offers/listings/:listingId/converge` — run one job now. */
export const offerConvergeSchema = z.object({}).strict();
