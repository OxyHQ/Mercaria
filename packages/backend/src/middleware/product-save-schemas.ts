/**
 * Request schemas for the product-save surfaces (#80).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a schema cannot accept a value the database
 * CHECK then refuses.
 *
 * `.strict()` is doing real work here, and specifically:
 *
 *  - **No schema carries a `visibility` field.** A saved list is private and
 *    there is exactly one visibility (#80 privacy rule 6); a request shape able
 *    to carry `public` would be the first half of a public wishlist arriving
 *    without a product decision, a privacy review or a migration.
 *  - **No schema carries a price-alert field.** #80 API rule 6 requires that
 *    saving creates no alert; there is no key an HTTP caller could set to ask
 *    for one, which is a stronger statement than a handler that ignores it.
 *  - **No schema carries a save COUNT or a `saveCount` override.** The counter
 *    is derived from rows (#80 counter rule 1) and a body able to propose one
 *    would be a second writer of the number the aggregate exists to be the only
 *    authority for.
 *  - **`sourceContext` is restricted to the CLIENT-emittable subset.**
 *    `favorite_migration` and `split_resolution` are the server's own, and a
 *    client able to claim the first would make "how many saves did the
 *    migration create" unanswerable.
 */

import { z } from 'zod';
import {
  CLIENT_PRODUCT_SAVE_SOURCE_CONTEXTS,
  CONDITION_GROUPS,
  LISTING_SAVE_INTENTS,
  PRODUCT_SAVE_SPLIT_RESOLUTIONS,
  type ConditionGroup,
  type ListingSaveIntent,
  type ProductSaveSourceContext,
  type ProductSaveSplitResolution,
} from '@mercaria/shared-types';

const SOURCE_CONTEXT_VALUES = CLIENT_PRODUCT_SAVE_SOURCE_CONTEXTS as readonly [
  ProductSaveSourceContext,
  ...ProductSaveSourceContext[],
];
const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const SPLIT_RESOLUTION_VALUES = PRODUCT_SAVE_SPLIT_RESOLUTIONS as readonly [
  ProductSaveSplitResolution,
  ...ProductSaveSplitResolution[],
];
const LISTING_SAVE_INTENT_VALUES = LISTING_SAVE_INTENTS as readonly [
  ListingSaveIntent,
  ...ListingSaveIntent[],
];

const entityId = z.string().trim().min(1).max(64);

/** `POST /product-saves` — save a canonical product. */
export const saveProductSchema = z
  .object({
    canonicalProductId: entityId,
    sourceContext: z.enum(SOURCE_CONTEXT_VALUES),
    preferredCanonicalVariantId: entityId.optional(),
    preferredConditionGroup: z.enum(CONDITION_GROUP_VALUES).optional(),
    preferredMerchantId: entityId.optional(),
  })
  .strict();

/**
 * `PATCH /product-saves/:canonicalProductId` — change the preferences.
 *
 * `.nullable()` on each, because "leave it alone" (the key absent) and "clear
 * it" (the key present and null) are different requests, and a PATCH that
 * cannot tell them apart makes a preferred variant impossible to remove.
 * `.refine` requires at least one key so an empty body is a 400 rather than a
 * silent no-op that reads as success.
 */
export const updateProductSaveSchema = z
  .object({
    preferredCanonicalVariantId: entityId.nullable().optional(),
    preferredConditionGroup: z.enum(CONDITION_GROUP_VALUES).nullable().optional(),
    preferredMerchantId: entityId.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Name at least one preference to change.',
  });

/** `POST /product-saves/:saveId/resolve-split` — answer a split ambiguity. */
export const resolveSplitSchema = z
  .object({ resolution: z.enum(SPLIT_RESOLUTION_VALUES) })
  .strict();

/**
 * `POST /favorites/:listingId` — the OPTIONAL intent #80 adds.
 *
 * Optional and defaulted to nothing rather than to `listing_save`: an absent
 * intent must leave an existing save's intent exactly as it was, so a v1
 * client's plain save cannot downgrade a pin the buyer set deliberately. The
 * DEFAULT for a new row lives on the column, where every writer gets it.
 */
export const favoriteIntentSchema = z
  .object({ intent: z.enum(LISTING_SAVE_INTENT_VALUES).optional() })
  .strict();

/** `GET /saved-items` — the merged, keyset-paginated list. */
export const savedItemsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** `GET /internal/product-saves/counters/drift`. */
export const counterDriftQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    productCursor: entityId.optional(),
    listingCursor: entityId.optional(),
  })
  .strict();

/** `POST /internal/product-saves/counters/rebuild`. */
export const rebuildCountersSchema = z
  .object({
    canonicalProductId: entityId.optional(),
    listingId: entityId.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

/** `POST /internal/product-saves/migrations` — run one migration page. */
export const runMigrationSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).default(100),
    cursor: entityId.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/**
 * `DELETE /internal/product-saves/subjects/:oxyUserId` — #80 privacy rule 5.
 *
 * The reason is REQUIRED and non-trivial. An erasure is irreversible and is the
 * one action on this surface that destroys a person's data, so an operator
 * states why in the same request — the `payment_repairs` discipline, applied to
 * the one power here that needs it.
 */
export const eraseSubjectSchema = z
  .object({ reason: z.string().trim().min(8).max(500) })
  .strict();
