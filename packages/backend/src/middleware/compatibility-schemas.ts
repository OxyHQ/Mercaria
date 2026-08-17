/**
 * Request schemas for the public compatibility and fitment reads (#367 step 8,
 * ADR 0007 D8).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types` rather than being retyped, so a schema cannot accept a
 * value the database CHECK then refuses.
 *
 * ## What `.strict()` is doing here, specifically
 *
 * No schema in this file carries an `applicability`, `applicabilities`,
 * `verification` or `includeUnpublished` field, so **no HTTP caller can narrow a
 * fitment read to the rows that say yes.** That is the one filter this domain must
 * never expose: an exclusion is an ordinary `automotive_fitments` row whose
 * applicability is `does_not_apply`, so a read narrowed to `applies` answers a
 * confident yes for every vehicle somebody explicitly excluded — the exact failure
 * the four-valued applicability exists to prevent, arriving through a query
 * parameter. `automotiveFitmentRepository`'s `FitmentLookupFilter` accepts those
 * narrowings because a merchandising caller that has already resolved a verdict
 * legitimately needs them; a shopper's URL is not that caller.
 *
 * Nor is there a `verification` parameter. Which verification states may speak is
 * the PUBLICATION POLICY in `compatibility.service` and `fitment.service` — a
 * positive claim publishes only at `verified`, a negative one from a wider set —
 * and a request able to widen it would let a caller read an unreviewed guess that
 * a brake pad fits their car as though Mercaria had checked.
 *
 * ## And there is no write schema at all
 *
 * A compatibility claim arrives from a manufacturer publication, a source record,
 * a merchant assertion or the matcher, and becomes canonical only through
 * `compatibility_claims` and a verification (ADR 0007 D7). A public write surface
 * would be a way to publish a fit nobody asserted, which is the highest-cost
 * wrong answer in this epic.
 */

import { z } from 'zod';
import {
  COMPATIBILITY_RELATION_KINDS,
  TYPED_COMPATIBILITY_TARGET_KEY_PATTERN,
  TYPED_COMPATIBILITY_TARGET_TYPES,
  VEHICLE_MAX_YEAR,
  VEHICLE_MIN_YEAR,
  type CompatibilityRelationKind,
  type TypedCompatibilityTargetType,
} from '@mercaria/shared-types';

const KIND_VALUES = COMPATIBILITY_RELATION_KINDS as readonly [
  CompatibilityRelationKind,
  ...CompatibilityRelationKind[],
];
const TARGET_TYPE_VALUES = TYPED_COMPATIBILITY_TARGET_TYPES as readonly [
  TypedCompatibilityTargetType,
  ...TypedCompatibilityTargetType[],
];

const entityId = z.string().trim().min(1).max(64);

/** ISO 3166-1 alpha-2, matching the relation table's own market CHECK. */
const market = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/);

/**
 * A model year, bounded by the SAME constants the schema's CHECK is rendered from.
 *
 * 1885–2100 rather than a bare `int()`: a year outside it is a parsing accident on
 * the caller's side — a price read as a year, a two-digit year expanded wrongly —
 * and admitting one asks the fitment read about a car that will never exist, which
 * answers `unknown` and reads as "we have no data for your vehicle".
 */
const modelYear = z.coerce.number().int().min(VEHICLE_MIN_YEAR).max(VEHICLE_MAX_YEAR);

/** A comma-separated query value, as a browser and a fetch client both send it. */
function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
}

/** How many rows either list read may EXAMINE. */
const relationLimit = z.coerce.number().int().min(1).max(200);
const fitmentLimit = z.coerce.number().int().min(1).max(200);

/**
 * `GET /compatibility/relations` — both directions, one route.
 *
 * Exactly one selector, refused at the schema rather than at the service, so an
 * ambiguous request never reaches a query. The two directions share a route
 * because they are one index read of one table in two directions; they do NOT
 * share a selector, because a request naming both a subject and a target is
 * asking a third question ("does A fit B") that this read does not answer and
 * that a `typed` target makes non-trivial.
 *
 * The count is over SELECTORS, not over parameters: `targetType` and `targetKey`
 * are one selector and must arrive together, which the second refinement states
 * on its own rather than folding into the count — otherwise a lone `targetType`
 * would satisfy "exactly one" and select every typed target of that type.
 */
export const compatibilityRelationsQuerySchema = z
  .object({
    subjectProductId: entityId.optional(),
    subjectVariantId: entityId.optional(),
    targetFamilyId: entityId.optional(),
    targetProductId: entityId.optional(),
    targetVariantId: entityId.optional(),
    targetType: z.enum(TARGET_TYPE_VALUES).optional(),
    targetKey: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(new RegExp(TYPED_COMPATIBILITY_TARGET_KEY_PATTERN))
      .optional(),
    kinds: commaList(KIND_VALUES).optional(),
    market: market.optional(),
    limit: relationLimit.optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.subjectProductId ? 1 : 0) +
        (query.subjectVariantId ? 1 : 0) +
        (query.targetFamilyId ? 1 : 0) +
        (query.targetProductId ? 1 : 0) +
        (query.targetVariantId ? 1 : 0) +
        (query.targetType !== undefined || query.targetKey !== undefined ? 1 : 0) ===
      1,
    {
      message:
        'Provide exactly one of subjectProductId, subjectVariantId, targetFamilyId, targetProductId, targetVariantId, or the targetType/targetKey pair',
    },
  )
  .refine((query) => (query.targetType === undefined) === (query.targetKey === undefined), {
    message: 'targetType and targetKey identify one typed target and must be sent together',
  });

/**
 * `GET /compatibility/fitments` — which vehicles this part is stated to fit.
 *
 * Exactly one subject. No applicability and no verification parameter; see the
 * module header for why either would be a way to publish a confident yes for an
 * excluded vehicle.
 */
export const partFitmentsQuerySchema = z
  .object({
    subjectProductId: entityId.optional(),
    subjectVariantId: entityId.optional(),
    limit: fitmentLimit.optional(),
  })
  .strict()
  .refine(
    (query) => (query.subjectProductId ? 1 : 0) + (query.subjectVariantId ? 1 : 0) === 1,
    { message: 'Provide exactly one of subjectProductId or subjectVariantId' },
  );

/**
 * `GET /compatibility/fitments/verdict` — does this part fit this car.
 *
 * `makeId` is REQUIRED and the three narrower levels are optional, because that
 * is the shape of a shopper part way down the picker: a make alone is a real
 * question with a real answer (the make-scoped statements), and the narrower
 * levels only add statements. The server widens UPWARD from the narrowest id
 * given and ignores the caller's copies of the levels above it, so a mismatched
 * pair cannot collect another vehicle's exclusions — which is why `makeId` being
 * present alongside a `configurationId` is accepted rather than refused: it is
 * not read.
 */
export const fitmentVerdictQuerySchema = z
  .object({
    subjectProductId: entityId.optional(),
    subjectVariantId: entityId.optional(),
    makeId: entityId,
    modelId: entityId.optional(),
    generationId: entityId.optional(),
    configurationId: entityId.optional(),
    year: modelYear.optional(),
  })
  .strict()
  .refine(
    (query) => (query.subjectProductId ? 1 : 0) + (query.subjectVariantId ? 1 : 0) === 1,
    { message: 'Provide exactly one of subjectProductId or subjectVariantId' },
  );

/** `GET /compatibility/vehicles/generations/:generationId/configurations?year=`. */
export const vehicleConfigurationsQuerySchema = z
  .object({ year: modelYear.optional() })
  .strict();
