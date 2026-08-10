/**
 * Request schemas for the watchlist surfaces (#81).
 *
 * Every schema is `.strict()` and every value tuple comes from
 * `@mercaria/shared-types`, so a schema cannot accept a value the database CHECK
 * then refuses. What `.strict()` is doing here specifically:
 *
 *  - **No schema carries a `visibility` field.** A watchlist is private and
 *    there is exactly one visibility (#81 privacy rule 1); a request shape able
 *    to carry `public` or a share token would be the first half of a sharing
 *    feature arriving without a product decision, a privacy review or a
 *    migration.
 *  - **No schema carries a price-alert field.** #79 owns alerts and has not
 *    shipped, so there is no key an HTTP caller could set to ask for one —
 *    which is a stronger statement than a handler that ignores it.
 *  - **No schema carries a TOTAL, a basis, a completeness or an FX rate.** Every
 *    one of those is DERIVED from offers and quotes the server reads; a body
 *    able to propose one would be a client able to state what its own basket
 *    cost, which is the shape `checkoutSchema` refuses `amount` and `paid` for.
 *  - **No schema carries a `version` the server would trust as the new one.**
 *    `expectedVersion` is what the client HAS, never what it wants the list to
 *    become: the server advances the version itself, so a client cannot skip a
 *    concurrent edit by naming a higher number.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  MAX_MONEY_MINOR_UNITS,
  WATCHLIST_ITEM_SPLIT_RESOLUTIONS,
  WATCHLIST_MAX_DESCRIPTION_LENGTH,
  WATCHLIST_MAX_ICON_LENGTH,
  WATCHLIST_MAX_ITEM_QUANTITY,
  WATCHLIST_MAX_ITEMS_PER_LIST,
  WATCHLIST_MAX_NAME_LENGTH,
  WATCHLIST_MAX_NOTE_LENGTH,
  WATCHLIST_TEMPLATE_KEYS,
  type ConditionGroup,
  type CurrencyCode,
  type WatchlistItemSplitResolution,
  type WatchlistTemplateKey,
} from '@mercaria/shared-types';

const CURRENCY_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];
const CONDITION_GROUP_VALUES = CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]];
const TEMPLATE_VALUES = WATCHLIST_TEMPLATE_KEYS as readonly [
  WatchlistTemplateKey,
  ...WatchlistTemplateKey[],
];
const SPLIT_RESOLUTION_VALUES = WATCHLIST_ITEM_SPLIT_RESOLUTIONS as readonly [
  WatchlistItemSplitResolution,
  ...WatchlistItemSplitResolution[],
];

const entityId = z.string().trim().min(1).max(64);
const listName = z.string().trim().min(1).max(WATCHLIST_MAX_NAME_LENGTH);
const description = z.string().trim().min(1).max(WATCHLIST_MAX_DESCRIPTION_LENGTH);
const icon = z.string().trim().min(1).max(WATCHLIST_MAX_ICON_LENGTH);
/** Upper-case ISO 3166-1 alpha-2, matching the column's own CHECK. */
const market = z.string().trim().regex(/^[A-Z]{2}$/);
const note = z.string().trim().min(1).max(WATCHLIST_MAX_NOTE_LENGTH);
/**
 * A version a client READ. `int()` alone accepts `1e300`, so the ceiling is what
 * makes the check real — the `assertSafeMoneyAmount` lesson applied to a counter.
 */
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** A target amount in minor units, bounded exactly as every other money input is. */
const minorUnits = z.number().int().min(0).max(MAX_MONEY_MINOR_UNITS);

/** `POST /watchlists` — create a list, optionally from a template. */
export const createWatchlistSchema = z
  .object({
    name: listName.optional(),
    displayCurrency: z.enum(CURRENCY_VALUES),
    description: description.optional(),
    icon: icon.optional(),
    market: market.optional(),
    templateKey: z.enum(TEMPLATE_VALUES).optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.templateKey !== undefined, {
    message: 'Provide a name, or a template to take one from.',
  });

/** `PATCH /watchlists/:watchlistId` — rename, re-describe, or change the currency. */
export const updateWatchlistSchema = z
  .object({
    expectedVersion: version,
    name: listName.optional(),
    // `null` CLEARS. `undefined` (absent) leaves alone. Two different requests,
    // and a shape that could not express the first would make a description
    // permanent once written.
    description: description.nullable().optional(),
    icon: icon.nullable().optional(),
    displayCurrency: z.enum(CURRENCY_VALUES).optional(),
    market: market.nullable().optional(),
  })
  .strict();

/** `DELETE /watchlists/:watchlistId` and every other version-guarded write. */
export const watchlistVersionSchema = z.object({ expectedVersion: version }).strict();

/** `POST /watchlists/:watchlistId/duplicate` — copy a list (#81 UX rule 7). */
export const duplicateWatchlistSchema = z.object({ name: listName.optional() }).strict();

/** `POST /watchlists/:watchlistId/items` — add one product. */
export const addWatchlistItemSchema = z
  .object({
    expectedVersion: version,
    canonicalProductId: entityId,
    quantity: z.number().int().min(1).max(WATCHLIST_MAX_ITEM_QUANTITY).optional(),
    preferredCanonicalVariantId: entityId.optional(),
    preferredConditionGroup: z.enum(CONDITION_GROUP_VALUES).optional(),
    preferredMerchantId: entityId.optional(),
    targetAmount: minorUnits.optional(),
    targetCurrency: z.enum(CURRENCY_VALUES).optional(),
    note: note.optional(),
  })
  .strict();

/** `PATCH /watchlists/:watchlistId/items/:itemId` — change one entry. */
export const updateWatchlistItemSchema = z
  .object({
    expectedVersion: version,
    quantity: z.number().int().min(1).max(WATCHLIST_MAX_ITEM_QUANTITY).optional(),
    preferredCanonicalVariantId: entityId.nullable().optional(),
    preferredConditionGroup: z.enum(CONDITION_GROUP_VALUES).nullable().optional(),
    preferredMerchantId: entityId.nullable().optional(),
    targetAmount: minorUnits.nullable().optional(),
    targetCurrency: z.enum(CURRENCY_VALUES).nullable().optional(),
    note: note.nullable().optional(),
  })
  .strict();

/**
 * `PUT /watchlists/:watchlistId/items/order` — the COMPLETE ordering.
 *
 * The cap is the per-list item limit, so a body cannot be used to make the
 * server allocate an unbounded array before the service has even read the list.
 */
export const reorderWatchlistItemsSchema = z
  .object({
    expectedVersion: version,
    itemIds: z.array(entityId).min(1).max(WATCHLIST_MAX_ITEMS_PER_LIST),
  })
  .strict();

/** `POST /watchlists/:watchlistId/items/:itemId/resolve-split` — answer a split. */
export const resolveWatchlistSplitSchema = z
  .object({
    expectedVersion: version,
    resolution: z.enum(SPLIT_RESOLUTION_VALUES),
  })
  .strict();
