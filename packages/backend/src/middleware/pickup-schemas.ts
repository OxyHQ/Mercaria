/**
 * Request schemas for location publication, nearby discovery and collection
 * (#93).
 *
 * Every one is `.strict()`. That is not house style applied mechanically — it
 * is what stops a field nobody designed from reaching a domain whose whole
 * point is what it does NOT store: a `precise`, a `homeAddress`, a
 * `buyerLatitude` on a merchant form would each be dropped silently by a
 * permissive schema and each would eventually be read by somebody.
 *
 * The one shape worth reading is {@link setLocalDiscoverySchema}: it ACCEPTS a
 * precise latitude and longitude, because the alternative is trusting a client
 * to round before sending and a client that rounds badly is the only thing
 * between a seller's home and a public response. The server rounds and stores
 * cell INDICES; `listing_local_discovery` has no coordinate column at all.
 */

import { z } from 'zod';
import {
  ITEM_CONDITION_KEYS,
  LOCATION_INVENTORY_SOURCES,
  LOCATION_PUBLICATION_STATES,
  PICKUP_IDENTITY_REQUIREMENTS,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS,
  MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS,
} from './pickup-enum-values.js';

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);
const country = z.string().trim().length(2).toUpperCase();
/** A BCP 47 tag, passed through to GoWay for a place's localized name. */
const locale = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/, 'Use a BCP 47 tag');

/** A comma-separated list narrowed to a closed set, dropping nothing silently. */
function commaList<T extends string>(values: readonly T[]) {
  return z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(z.enum(asEnumValues(values))).min(1));
}

/** `GET /nearby` — the public proximity read. */
export const nearbyQuerySchema = z
  .object({
    canonicalVariantId: z.string().trim().min(1).optional(),
    canonicalProductId: z.string().trim().min(1).optional(),
    latitude,
    longitude,
    /**
     * How the position was obtained, DECLARED by the client.
     *
     * It is a label on a log line and on the echoed origin, never a security
     * or eligibility input — a client's claim about its own sensor cannot be
     * verified and nothing branches on it. It exists so a rollout can tell
     * "shoppers who shared a location" from "shoppers who picked a city",
     * which are different products.
     */
    originSource: z.enum(['device', 'map_area', 'published_place']).optional(),
    radiusMetres: z.coerce.number().int().positive().optional(),
    country: country.optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    conditionKeys: commaList(ITEM_CONDITION_KEYS).optional(),
    /** #93 nearby rule 12 — the actor-specific half, asked for separately. */
    withCheckoutEligibility: z.enum(['true', 'false']).optional(),
    locale: locale.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    // GoWay's own opaque page cursor, passed through: base64url, at most the
    // 512 characters GoWay mints.
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, 'Use the cursor the previous page returned')
      .optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.canonicalVariantId === undefined) !== (query.canonicalProductId === undefined),
    {
      message: 'Ask about exactly one of canonicalVariantId or canonicalProductId',
      path: ['canonicalVariantId'],
    },
  );

/** `GET /nearby/places` — the manual-location fallback: a town the shopper types. */
export const nearbyPlacesQuerySchema = z
  .object({
    canonicalVariantId: z.string().trim().min(1).optional(),
    canonicalProductId: z.string().trim().min(1).optional(),
    q: z.string().trim().min(1).max(80).optional(),
    country: country.optional(),
    locale: locale.optional(),
    limit: z.coerce.number().int().min(1).max(5).optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.canonicalVariantId === undefined) !== (query.canonicalProductId === undefined),
    {
      message: 'Ask about exactly one of canonicalVariantId or canonicalProductId',
      path: ['canonicalVariantId'],
    },
  );

/** `GET /nearby/p2p` — coarse local discovery of P2P listings. */
export const nearbyP2pQuerySchema = z
  .object({
    latitude,
    longitude,
    country: country.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/**
 * `PUT /admin/stores/:storeId/locations/:id/publication`.
 *
 * The GoWay place and Mercaria's commerce fields, and nothing else: where the
 * shop is — its name, address, hours, contact, accessibility — is edited on the
 * place in GoWay (ADR 0013), and `.strict()` refuses a body that still sends it.
 */
export const upsertLocationPublicationSchema = z
  .object({
    goWayPlaceId: z.string().trim().min(1).max(128),
    pickupOffered: z.boolean(),
    pickupInstructions: z.string().trim().max(1000).optional(),
    identityRequirement: z.enum(asEnumValues(PICKUP_IDENTITY_REQUIREMENTS)).optional(),
    inventorySource: z.enum(asEnumValues(LOCATION_INVENTORY_SOURCES)),
    // REQUIRED, with no default anywhere in the stack. A default here would be
    // the deployment-wide freshness TTL #68 forbids, arriving through a form.
    stockConfirmationIntervalSeconds: z
      .number()
      .int()
      .min(MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS)
      .max(MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS),
    disclosesExactStock: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

/** `POST …/publication/state`. */
export const setPublicationStateSchema = z
  .object({ state: z.enum(asEnumValues(LOCATION_PUBLICATION_STATES)) })
  .strict();

/** `POST …/publication/pickup-pause`. */
export const setPickupPauseSchema = z
  .object({ paused: z.boolean(), reason: z.string().trim().max(300).optional() })
  .strict();

/** `POST /admin/stores/:storeId/orders/:id/pickup/ready`. */
export const markPickupReadySchema = z
  .object({ note: z.string().trim().max(300).optional() })
  .strict();

/**
 * `POST /admin/stores/:storeId/orders/:id/pickup/collect`.
 *
 * Exactly one of `code` and `override` — a request carrying both is refused
 * rather than resolved by a precedence rule, because "we tried the code and it
 * failed so we waved it through" and "we waved it through" are different
 * audits and a body that could mean either would make the trail unreadable.
 */
export const collectPickupSchema = z
  .object({
    code: z.string().trim().min(4).max(32).optional(),
    override: z
      .object({ reason: z.string().trim().min(3).max(300) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((body) => (body.code === undefined) !== (body.override === undefined), {
    message: 'Send either a collection code or an override with a reason, not both',
    path: ['code'],
  });

/** `POST …/pickup/cancel`. */
export const cancelPickupSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/** `POST …/pickup/rotate-code`. */
export const rotateCollectionCodeSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();

/**
 * `PUT /seller/listings/:listingId/local-discovery`.
 *
 * See the module docblock for why a precise coordinate is accepted here and
 * nowhere stored.
 */
export const setLocalDiscoverySchema = z
  .object({
    enabled: z.boolean(),
    latitude,
    longitude,
    areaLabel: z.string().trim().min(1).max(120),
    country,
    region: z.string().trim().max(120).optional(),
  })
  .strict();

/** `POST /internal/pickup/publications/:id/restriction`. */
export const setPublicationRestrictionSchema = z
  .object({ restricted: z.boolean(), reason: z.string().trim().min(3).max(300) })
  .strict();
