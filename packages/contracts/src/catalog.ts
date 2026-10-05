/**
 * The catalogue shapes another Oxy application may read: products, stores and
 * collections.
 *
 * ## Why these are not `Listing` / `StoreSummary`
 *
 * The storefront DTOs are shaped for Mercaria's own apps and carry things a
 * foreign application must never hold: connector provenance, variant SKUs and
 * barcodes, a manual collection's raw member ids and its automation rules, Oxy
 * media file ids instead of URLs. The backend builds every shape below FIELD BY
 * FIELD (`services/public-api/projection.ts`) — never by spreading a storefront
 * DTO — so a field added to `Listing` tomorrow reaches nobody unless somebody
 * adds it here on purpose.
 *
 * ## Current truth, not history
 *
 * Every read returns CURRENT facts. Prices are the listing's NATIVE currency,
 * converted by nothing. A price or an availability read from this contract is a
 * fact about the moment it was served and must not be persisted as
 * authoritative.
 *
 * ## Objects are open to additions
 *
 * Response objects strip keys they do not name (`z.object`), so a field added
 * in a later minor never fails an older parser, and the exported JSON Schema
 * leaves `additionalProperties` open for the same reason. Refs are the
 * exception (`refs.ts`).
 */

import { z } from 'zod';
import {
  CONDITION_GROUPS,
  CONDITION_KEY_GROUP,
  ITEM_CONDITION_KEYS,
  type ConditionGroup,
  type ItemConditionKey,
} from '@mercaria/shared-types';
import {
  MercariaCountSchema,
  MercariaHexColorSchema,
  MercariaHttpUrlSchema,
  MercariaIdSchema,
  MercariaImageSchema,
  MercariaMoneySchema,
  MercariaTimestampSchema,
} from './primitives';
import {
  MercariaCollectionRefSchema,
  MercariaProductRefSchema,
  MercariaStoreRefSchema,
  MercariaVariantRefSchema,
} from './refs';

// ── Products ────────────────────────────────────────────────────────────────

/**
 * Whether a product (or one purchase option) can be bought right now.
 *
 * - `in_stock`: live and buyable.
 * - `out_of_stock`: live, but no purchase option has stock.
 * - `sold`: a one-off item that has been sold. Still viewable, never buyable.
 */
export const MERCARIA_PRODUCT_AVAILABILITIES = ['in_stock', 'out_of_stock', 'sold'] as const;
export const MercariaProductAvailabilitySchema = z.enum(MERCARIA_PRODUCT_AVAILABILITIES);
export type MercariaProductAvailability = z.infer<typeof MercariaProductAvailabilitySchema>;

/** How a product page is ordered. `relevance` needs a search query. */
export const MERCARIA_PRODUCT_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc'] as const;
export const MercariaProductSortSchema = z.enum(MERCARIA_PRODUCT_SORTS);
export type MercariaProductSort = z.infer<typeof MercariaProductSortSchema>;

/** The item's condition, as its taxonomy key and the segment that key belongs to. */
export const MercariaProductConditionSchema = z
  .object({
    key: z.enum(ITEM_CONDITION_KEYS as readonly [ItemConditionKey, ...ItemConditionKey[]]),
    group: z.enum(CONDITION_GROUPS as readonly [ConditionGroup, ...ConditionGroup[]]),
  })
  .superRefine((condition, ctx) => {
    if (CONDITION_KEY_GROUP[condition.key] !== condition.group) {
      ctx.addIssue({ code: 'custom', path: ['group'], message: `must be the group of condition "${condition.key}"` });
    }
  });
export type MercariaProductCondition = z.infer<typeof MercariaProductConditionSchema>;

/**
 * Who sells a product. A store is referenced by id; a person is identified by
 * their Oxy user id, the one cross-application identity Oxy owns.
 */
export const MercariaSellerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('store'),
    store: MercariaStoreRefSchema,
    handle: MercariaIdSchema.describe('The store’s CURRENT handle — presentation, not identity.'),
    name: z.string(),
    logoUrl: MercariaHttpUrlSchema.nullable(),
  }),
  z.object({
    kind: z.literal('person'),
    oxyUserId: MercariaIdSchema,
    displayName: z.string(),
    username: z.string().describe('Oxy username without the leading `@`.'),
    avatarUrl: MercariaHttpUrlSchema.nullable(),
    isVerified: z.boolean(),
  }),
]);
export type MercariaSeller = z.infer<typeof MercariaSellerSchema>;

/** One way to buy a product: a variant with its own price and stock. */
export const MercariaPurchaseOptionSchema = z.object({
  ref: MercariaVariantRefSchema,
  title: z.string().describe('The variant’s display title (e.g. `Blue / M`).'),
  price: MercariaMoneySchema,
  compareAtPrice: MercariaMoneySchema.nullable().describe('The pre-discount price when on sale, else null.'),
  availability: MercariaProductAvailabilitySchema.exclude(['sold']),
});
export type MercariaPurchaseOption = z.infer<typeof MercariaPurchaseOptionSchema>;

const productSummaryShape = {
  ref: MercariaProductRefSchema,
  title: z.string(),
  primaryImage: MercariaImageSchema.nullable().describe('The first gallery image, or null.'),
  price: MercariaMoneySchema.describe('The lowest current purchase-option price.'),
  compareAtPrice: MercariaMoneySchema.nullable().describe('The cheapest option’s pre-discount price when on sale.'),
  priceRange: z
    .object({ min: MercariaMoneySchema, max: MercariaMoneySchema })
    .nullable()
    .describe('The span across purchase options, or null when they all cost the same.'),
  availability: MercariaProductAvailabilitySchema,
  condition: MercariaProductConditionSchema,
  seller: MercariaSellerSchema,
  url: MercariaHttpUrlSchema.describe('The canonical Mercaria web URL for this product.'),
};

/** A product as a card renders it — what search and store/collection grids serve. */
export const MercariaProductSummarySchema = z.object(productSummaryShape);
export type MercariaProductSummary = z.infer<typeof MercariaProductSummarySchema>;

/** A product as a detail view or a hydrated attachment renders it. */
export const MercariaProductSchema = z
  .object({
    ...productSummaryShape,
    description: z.string(),
    images: z.array(MercariaImageSchema).describe('The full ordered gallery.'),
    purchaseOptions: z.array(MercariaPurchaseOptionSchema),
    updatedAt: MercariaTimestampSchema.describe('When the product last changed.'),
    viewer: z
      .object({ saved: z.boolean() })
      .nullable()
      .describe('Facts about the CALLER when the request carried a valid Oxy session; null anonymously.'),
  })
  .superRefine((product, ctx) => {
    // A variant is resolved THROUGH its product, so an option naming another
    // product would make a variant ref resolve to the wrong thing.
    product.purchaseOptions.forEach((option, index) => {
      if (option.ref.productId !== product.ref.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['purchaseOptions', index, 'ref', 'productId'],
          message: 'must be the id of the product it belongs to',
        });
      }
    });
  });
export type MercariaProduct = z.infer<typeof MercariaProductSchema>;

// ── Stores and collections ──────────────────────────────────────────────────

/**
 * A public storefront.
 *
 * `oxyAccountId` is the Oxy account that owns the store (ADR 0012) — usually an
 * organization, sometimes a person's own account. It is the one cross-app key
 * for a business (`~/Oxy/docs/api-conventions.md`, "Cross-app references"), so
 * another Oxy product (GoWay matching a place to its shop) joins on it and
 * fetches the account's facts from Oxy. Who may ACT for the store is never
 * published: no member, role, permission or override reaches this shape.
 */
export const MercariaStoreSchema = z.object({
  ref: MercariaStoreRefSchema,
  oxyAccountId: MercariaIdSchema.describe(
    'The Oxy account (usually an organization) that owns this store. An opaque Oxy id: resolve it through Oxy, never parse it.',
  ),
  handle: MercariaIdSchema.describe('The CURRENT handle — presentation, not identity.'),
  name: z.string(),
  description: z.string().nullable(),
  logoUrl: MercariaHttpUrlSchema.nullable(),
  coverImageUrl: MercariaHttpUrlSchema.nullable(),
  brandColor: MercariaHexColorSchema,
  rating: z.number().min(0).max(5).nullable().describe('Average rating 0–5, or null with no reviews.'),
  reviewCount: MercariaCountSchema,
  url: MercariaHttpUrlSchema.describe('The canonical Mercaria web URL for this store.'),
});
export type MercariaStore = z.infer<typeof MercariaStoreSchema>;

/** A published, curated collection of one store's products. */
export const MercariaCollectionSchema = z.object({
  ref: MercariaCollectionRefSchema,
  store: MercariaStoreRefSchema,
  title: z.string(),
  description: z.string().nullable(),
  image: MercariaImageSchema.nullable(),
  url: MercariaHttpUrlSchema.describe('The canonical Mercaria web URL for this collection.'),
});
export type MercariaCollection = z.infer<typeof MercariaCollectionSchema>;
