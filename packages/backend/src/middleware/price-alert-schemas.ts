/**
 * Request schemas for the price-alert surfaces (#79).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a schema cannot accept a value the database CHECK
 * then refuses. `.strict()` is doing real work here, specifically:
 *
 *  - **No schema carries `proximityScope: 'nearby_pickup'`.** The value is in
 *    the tuple, the column and the CHECK, and the ENUM below is a NARROWER
 *    subset — the `role_email` device from #83. #74's `resolvePickupProximity`
 *    refuses every request because #93 publishes no collection points, so an
 *    alert scoped that way could never fire, and accepting a subscription that
 *    is silently dead is worse than refusing it by name.
 *  - **No schema carries an email ADDRESS.** `emailOptIn` is a boolean; where
 *    the address would come from is #79's open question and this domain stores
 *    none (`transport.ts`). A field able to carry one would be the first half
 *    of a contact mirror ADR 0003 D15 says does not exist.
 *  - **No schema carries a state a service decides.** `triggered` and `deleted`
 *    are not in the patch's enum: the first is what a `once` alert becomes when
 *    it fires and the second is what DELETE does, and a client able to set
 *    either could make an alert claim it had notified somebody.
 *  - **No schema carries an alert POLICY VERSION.** It is a code constant that
 *    partly decides a trigger's identity; a caller able to name one could mint
 *    a second notification for one observation by inventing a version.
 *  - **No schema carries a merchant-facing filter.** There is no
 *    `canonicalProductId` query on any operator route and no `oxyUserId`
 *    anywhere, so "who is watching this" is not expressible (#79 abuse rule 6).
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  MAX_MONEY_MINOR_UNITS,
  PRICE_ALERT_AVAILABILITY_REQUIREMENTS,
  PRICE_ALERT_COMPARISON_BASES,
  PRICE_ALERT_MINUTES_PER_DAY,
  PRICE_ALERT_REPEAT_POLICIES,
  PRICE_ALERT_SELLER_SCOPES,
  PRICE_ALERT_SPLIT_RESOLUTIONS,
  type ConditionGroup,
  type CurrencyCode,
  type PriceAlertAvailabilityRequirement,
  type PriceAlertComparisonBasis,
  type PriceAlertRepeatPolicy,
  type PriceAlertSellerScope,
  type PriceAlertSplitResolution,
} from '@mercaria/shared-types';

const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const BASIS_VALUES = PRICE_ALERT_COMPARISON_BASES as readonly [
  PriceAlertComparisonBasis,
  ...PriceAlertComparisonBasis[],
];
const SELLER_SCOPE_VALUES = PRICE_ALERT_SELLER_SCOPES as readonly [
  PriceAlertSellerScope,
  ...PriceAlertSellerScope[],
];
const AVAILABILITY_VALUES = PRICE_ALERT_AVAILABILITY_REQUIREMENTS as readonly [
  PriceAlertAvailabilityRequirement,
  ...PriceAlertAvailabilityRequirement[],
];
const REPEAT_POLICY_VALUES = PRICE_ALERT_REPEAT_POLICIES as readonly [
  PriceAlertRepeatPolicy,
  ...PriceAlertRepeatPolicy[],
];
const SPLIT_RESOLUTION_VALUES = PRICE_ALERT_SPLIT_RESOLUTIONS as readonly [
  PriceAlertSplitResolution,
  ...PriceAlertSplitResolution[],
];

const entityId = z.string().trim().min(1).max(64);

/**
 * A money amount, BOUNDED.
 *
 * `z.number().int()` alone accepts `1e300` — the ceiling is what makes the
 * check real, and this is the boundary a target is CONSTRUCTED at.
 */
const money = z
  .object({
    amount: z.number().int().positive().max(MAX_MONEY_MINOR_UNITS),
    currency: z.enum(CURRENCY_VALUES),
  })
  .strict();

const quietHours = z
  .object({
    startMinute: z.number().int().min(0).max(PRICE_ALERT_MINUTES_PER_DAY - 1),
    endMinute: z.number().int().min(0).max(PRICE_ALERT_MINUTES_PER_DAY - 1),
    // An IANA zone name, checked against the RUNTIME rather than a list —
    // `isSupportedTimeZone` in the service. The pattern here only bounds the
    // shape so an unbounded string cannot reach `Intl`.
    timeZone: z.string().trim().min(1).max(64),
  })
  .strict();

const market = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, 'market must be an ISO 3166-1 alpha-2 code');

/** `POST /price-alerts`. */
export const createPriceAlertSchema = z
  .object({
    canonicalProductId: entityId,
    canonicalVariantId: entityId.optional(),
    target: money,
    basis: z.enum(BASIS_VALUES),
    conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).max(CONDITION_GROUPS.length).optional(),
    market: market.optional(),
    sellerScope: z.enum(SELLER_SCOPE_VALUES).optional(),
    merchantId: entityId.optional(),
    storefrontId: entityId.optional(),
    availabilityRequirement: z.enum(AVAILABILITY_VALUES).optional(),
    minimumAvailableQuantity: z.number().int().min(1).max(1_000_000).optional(),
    requirePickupAvailable: z.boolean().optional(),
    repeatPolicy: z.enum(REPEAT_POLICY_VALUES).optional(),
    resetThreshold: money.optional(),
    cooldownSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
    quietHours: quietHours.optional(),
    locale: z.string().trim().min(2).max(35).optional(),
    emailOptIn: z.boolean().optional(),
  })
  .strict();

/** `PATCH /price-alerts/:alertId`. `null` clears; absence leaves alone. */
export const updatePriceAlertSchema = z
  .object({
    target: money.optional(),
    basis: z.enum(BASIS_VALUES).optional(),
    conditionGroups: z.array(z.enum(CONDITION_GROUP_VALUES)).max(CONDITION_GROUPS.length).optional(),
    market: market.nullable().optional(),
    sellerScope: z.enum(SELLER_SCOPE_VALUES).optional(),
    merchantId: entityId.nullable().optional(),
    storefrontId: entityId.nullable().optional(),
    availabilityRequirement: z.enum(AVAILABILITY_VALUES).optional(),
    minimumAvailableQuantity: z.number().int().min(1).max(1_000_000).nullable().optional(),
    requirePickupAvailable: z.boolean().optional(),
    repeatPolicy: z.enum(REPEAT_POLICY_VALUES).optional(),
    resetThreshold: money.nullable().optional(),
    cooldownSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60).nullable().optional(),
    quietHours: quietHours.nullable().optional(),
    locale: z.string().trim().min(2).max(35).nullable().optional(),
    emailOptIn: z.boolean().optional(),
    // Exactly the two a BUYER decides — issue notification 8's one-tap pause and
    // its undo. See the module docblock for the two that are missing.
    state: z.enum(['enabled', 'paused']).optional(),
  })
  .strict();

/** `POST /price-alerts/:alertId/resolve-split`. */
export const resolvePriceAlertSplitSchema = z
  .object({ resolution: z.enum(SPLIT_RESOLUTION_VALUES) })
  .strict();

/** `GET /price-alerts`. */
export const listPriceAlertsQuerySchema = z
  .object({
    canonicalProductId: entityId.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .strict();

/**
 * `GET /price-alerts/suggestion`.
 *
 * The currency is REQUIRED. An optional one would mean answering "what is this
 * worth" in a currency the caller did not name, and a suggested target in the
 * wrong currency is a number a buyer would set an alert on.
 */
export const priceAlertSuggestionQuerySchema = z
  .object({
    canonicalProductId: entityId,
    currency: z.enum(CURRENCY_VALUES),
    market: market.optional(),
    conditionGroups: z
      .union([z.enum(CONDITION_GROUP_VALUES), z.array(z.enum(CONDITION_GROUP_VALUES))])
      .optional(),
  })
  .strict();
