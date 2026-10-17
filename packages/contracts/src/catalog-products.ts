/**
 * The COMPARISON catalogue another Oxy application may read: canonical
 * products (ADR 0002) and every current offer for each, native or external.
 *
 * ## Two grains, deliberately two shapes
 *
 * `catalog.ts`'s `MercariaProduct` is the SELLABLE product — one listing, one
 * seller, purchase options and stock. A catalog product here is the MODEL
 * ("iPhone 16 Pro 256 GB"), the thing every seller of it is compared under. Its
 * offers come from Mercaria's own stores and people (`native`) and from the
 * retailers and open-data sources Mercaria ingests (`external`, `affiliate`,
 * `informational`). A native offer names the sellable product it is, so a
 * consumer can follow it into `catalog.ts`'s shapes; an external one names the
 * Mercaria redirect a click must go through.
 *
 * ## Mercaria owns these facts; a consumer reads them
 *
 * Canonical identity, matching, offers and prices are Mercaria's
 * (`~/Oxy/docs/api-conventions.md`, "Cross-app references"). A consumer — Clarity
 * searching products, an agent comparing prices — persists a
 * `MercariaCatalogProductRef` and reads current facts here every time. Nothing
 * in this file is a feed to copy: a price is a fact about the moment it was
 * served.
 *
 * ## Order is Mercaria's, prices are native
 *
 * Offers arrive in the order Mercaria's versioned comparison ranks them, which
 * the consumer must not re-rank as if it were Mercaria's ("best offer" is a
 * claim about that policy). Every price is in the offer's NATIVE currency;
 * nothing here converts one. A price in a currency Mercaria does not model is
 * `null` rather than a number a consumer would format wrongly.
 */

import { z } from 'zod';
import {
  OFFER_AVAILABILITY_STATES,
  OFFER_KINDS,
  type OfferAvailability,
  type OfferKind,
} from '@mercaria/shared-types';
import { MercariaProductConditionSchema } from './catalog';
import {
  MercariaCountSchema,
  MercariaHttpUrlSchema,
  MercariaIdSchema,
  MercariaImageSchema,
  MercariaMoneySchema,
  MercariaTimestampSchema,
} from './primitives';
import {
  MercariaCatalogProductRefSchema,
  MercariaStoreRefSchema,
  MercariaVariantRefSchema,
} from './refs';

/**
 * What an offer is (ADR 0002 D18).
 *
 * - `native`: sold on Mercaria, by one of its stores or people. Buyable here.
 * - `external`: a retailer's own page, followed through Mercaria's redirect.
 * - `affiliate`: as `external`, under a tracked commercial relationship.
 * - `informational`: an observed price with nowhere to send a buyer — a
 *   crowd-sourced shelf price, for instance.
 */
export const MERCARIA_OFFER_KINDS = OFFER_KINDS as readonly [OfferKind, ...OfferKind[]];
export const MercariaOfferKindSchema = z.enum(MERCARIA_OFFER_KINDS);
export type MercariaOfferKind = z.infer<typeof MercariaOfferKindSchema>;

/** Whether the offer can be had now. `unknown` is a real answer: most sources do not say. */
export const MERCARIA_OFFER_AVAILABILITIES = OFFER_AVAILABILITY_STATES as readonly [
  OfferAvailability,
  ...OfferAvailability[],
];
export const MercariaOfferAvailabilitySchema = z.enum(MERCARIA_OFFER_AVAILABILITIES);
export type MercariaOfferAvailability = z.infer<typeof MercariaOfferAvailabilitySchema>;

/** A GTIN in its canonical 14-digit form. */
export const MercariaGtinSchema = z.string().regex(/^\d{14}$/, 'must be a 14-digit GTIN');

/**
 * Who an offer is from.
 *
 * A `merchant` is a seller Mercaria knows from outside — a retailer, a chain,
 * a marketplace seller — named with the domain its channel trades on when it
 * has one. A `store` and a `person` sell on Mercaria itself and are named the
 * way `catalog.ts`'s `MercariaSeller` names them.
 */
export const MercariaOfferSellerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merchant'),
    name: z.string(),
    domain: z.string().nullable().describe('The channel’s own hostname, or null.'),
  }),
  z.object({
    kind: z.literal('store'),
    store: MercariaStoreRefSchema,
    handle: MercariaIdSchema.describe('The store’s CURRENT handle — presentation, not identity.'),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('person'),
    oxyUserId: MercariaIdSchema,
    displayName: z.string(),
  }),
  z.object({ kind: z.literal('unknown') }),
]);
export type MercariaOfferSeller = z.infer<typeof MercariaOfferSellerSchema>;

/**
 * What following an offer does.
 *
 * - `mercaria_checkout`: a native offer, bought on Mercaria. `purchaseOption`
 *   is the variant ref `products.getVariant` hydrates; `url` is its page.
 * - `outbound`: a retailer's page, reached ONLY through Mercaria's redirect.
 *   `path` is relative to the API origin that served this body (the SDK's
 *   `links.outbound` makes it absolute). The redirect re-checks the offer at
 *   click time, so the retailer's own URL is deliberately not published. Render
 *   the link with `rel` and name `destinationHost` beside it.
 * - `none`: nothing to follow — an informational price, or a native offer that
 *   cannot be bought right now.
 */
export const MercariaOfferActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mercaria_checkout'),
    purchaseOption: MercariaVariantRefSchema,
    url: MercariaHttpUrlSchema.describe('The sellable product’s Mercaria web URL.'),
  }),
  z.object({
    kind: z.literal('outbound'),
    path: z
      .string()
      .regex(/^\/out\/[A-Za-z0-9_.~-]+$/, 'must be a Mercaria redirect path')
      .describe('`/out/<token>`, relative to the API origin.'),
    destinationHost: z.string().min(1),
    rel: z.string().min(1).describe('The link relationship the link must be published under.'),
  }),
  z.object({
    kind: z.literal('none'),
    destinationHost: z
      .string()
      .nullable()
      .describe('The host the offer is on, when it has one — a disclosure, not a link.'),
  }),
]);
export type MercariaOfferAction = z.infer<typeof MercariaOfferActionSchema>;

/** The open-data source an offer's facts came from, named because its licence requires it. */
export const MercariaOfferSourceSchema = z.object({
  name: z.string(),
  homepage: MercariaHttpUrlSchema,
  licenceLabel: z
    .string()
    .describe('e.g. `ODbL 1.0`; empty when the provider’s own terms govern instead.'),
});
export type MercariaOfferSource = z.infer<typeof MercariaOfferSourceSchema>;

/** One current way to get a catalog product. */
export const MercariaOfferSchema = z.object({
  id: MercariaIdSchema,
  kind: MercariaOfferKindSchema,
  variantId: MercariaIdSchema.describe('The configuration this offer prices — one of `variants`.'),
  seller: MercariaOfferSellerSchema,
  price: MercariaMoneySchema.nullable().describe(
    'Native currency. Null when the source published none, or in a currency Mercaria does not model.',
  ),
  availability: MercariaOfferAvailabilitySchema,
  condition: MercariaProductConditionSchema.nullable().describe(
    'Null when the source stated no condition Mercaria could map.',
  ),
  observedAt: MercariaTimestampSchema.nullable().describe(
    'When Mercaria last observed these terms.',
  ),
  action: MercariaOfferActionSchema,
  source: MercariaOfferSourceSchema.nullable().describe(
    'Present for an offer ingested from an open-data provider; show its attribution.',
  ),
});
export type MercariaOffer = z.infer<typeof MercariaOfferSchema>;

/** The offers a search card summarises: a FACT about them, never a recommendation. */
export const MercariaOfferSummarySchema = z.object({
  count: MercariaCountSchema.describe('Current offers.'),
  availability: MercariaOfferAvailabilitySchema,
  lowestPrice: MercariaMoneySchema.nullable().describe(
    'The lowest current price, native currency; null when none can be stated.',
  ),
});
export type MercariaOfferSummary = z.infer<typeof MercariaOfferSummarySchema>;

const catalogProductSummaryShape = {
  ref: MercariaCatalogProductRefSchema,
  name: z.string().describe('The canonical model name, never a seller’s title.'),
  image: MercariaImageSchema.nullable(),
  url: MercariaHttpUrlSchema.describe('The canonical Mercaria product page.'),
};

/** A catalog product as a search card renders it. */
export const MercariaCatalogProductSummarySchema = z.object({
  ...catalogProductSummaryShape,
  offers: MercariaOfferSummarySchema.nullable().describe(
    'Null when no current offer exists: the product is still a useful answer, with no price.',
  ),
});
export type MercariaCatalogProductSummary = z.infer<typeof MercariaCatalogProductSummarySchema>;

/** One configuration of a catalog product. */
export const MercariaCatalogVariantSchema = z.object({
  id: MercariaIdSchema,
  name: z.string().nullable(),
  gtins: z.array(MercariaGtinSchema).describe('The configuration’s active, public GTINs.'),
});
export type MercariaCatalogVariant = z.infer<typeof MercariaCatalogVariantSchema>;

/** A catalog product's detail, with every current offer in Mercaria's ranked order. */
export const MercariaCatalogProductSchema = z
  .object({
    ...catalogProductSummaryShape,
    description: z.string().nullable(),
    images: z.array(MercariaImageSchema),
    variants: z.array(MercariaCatalogVariantSchema),
    offers: z
      .array(MercariaOfferSchema)
      .nullable()
      .describe(
        'Ranked. Null while Mercaria is not serving price comparison — never “nobody sells it”.',
      ),
  })
  .superRefine((product, ctx) => {
    const variantIds = new Set(product.variants.map((variant) => variant.id));
    product.offers?.forEach((offer, index) => {
      if (!variantIds.has(offer.variantId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['offers', index, 'variantId'],
          message: 'must be one of the product’s variants',
        });
      }
    });
  });
export type MercariaCatalogProduct = z.infer<typeof MercariaCatalogProductSchema>;
