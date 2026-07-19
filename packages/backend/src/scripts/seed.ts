/**
 * Idempotent dev seed for the Mercaria catalog (`mercaria-development`).
 *
 * Reseeds ONLY the marketplace collections (Category, Store, SellerProfile,
 * Listing, ProductVariant). It NEVER touches Notification / Feedback / PushToken
 * collections. Mirrors the imagery + structure of `lib/mock-products.ts` so the
 * DB-backed `/feed` produces the same shelves the frontend already consumes.
 *
 * Prices are stored in FAIR (⊜) — the canonical settlement currency — as integer
 * minor units at FAIR's 8-decimal precision (1 ⊜ = 100_000_000 minor units). The
 * spec `price`/`compareAtPrice` fields below are MAJOR-unit FAIR values (e.g.
 * 125 = ⊜125.00) and the `fair()` builder scales them via
 * `minorUnitsPerMajor('FAIR')`. Because this seed `deleteMany`s the marketplace
 * collections first, RE-RUNNING IT is the dev migration path for the currency
 * change (no separate rescale migration here — that combined migration is a
 * later B2 deliverable).
 *
 * Run from `packages/backend`:
 *   NODE_ENV=development bun src/scripts/seed.ts
 */

import mongoose from 'mongoose';
import { connectDB } from '../lib/db.js';
import { log } from '../lib/logger.js';
import { slugify } from '../utils/slug.js';
import { Category } from '../models/category.js';
import { Store, ALL_STORE_PERMISSIONS, type IStoreMember } from '../models/store.js';
import { SellerProfile } from '../models/seller-profile.js';
import { Listing } from '../models/listing.js';
import { ProductVariant } from '../models/product-variant.js';
import { Location } from '../models/location.js';
import { InventoryLevel } from '../models/inventory-level.js';
import { Collection } from '../models/collection.js';
import { Discount } from '../models/discount.js';
import { TaxRate } from '../models/tax-rate.js';
import { Customer } from '../models/customer.js';
import { DraftOrder } from '../models/draft-order.js';
import { Order } from '../models/order.js';
import { Refund } from '../models/refund.js';
import { Review } from '../models/review.js';
import { nextOrderNumber } from '../models/counter.js';
import { process as processRefund } from '../services/refund.service.js';
import { createCollection, setCollectionProducts } from '../services/collection.service.js';
import { recomputeAggregate } from '../services/review.service.js';
import { minorUnitsPerMajor } from '../utils/money.js';
import { config } from '../config/index.js';
import type { DualMoney, Money } from '@mercaria/shared-types';

// FAKE dev owner — there is NO real Oxy account behind this id. Used only so the
// seeded stores/P2P listings have a deterministic owner in development.
const DEV_OWNER_OXY_USER_ID = '000000000000000000000001';
// A second FAKE dev seller for P2P listings.
const DEV_SELLER_OXY_USER_ID = '000000000000000000000002';

/** Canonical settlement currency for all seeded prices. */
const SEED_CURRENCY = 'FAIR' as const;

/**
 * Build a FAIR `Money` from a MAJOR-unit value (e.g. `fair(125)` = ⊜125.00),
 * scaling to integer minor units via the currency-precision map. Keeps the seed
 * free of hardcoded `1e8` magic and precision-aware if FAIR's precision changes.
 */
function fair(major: number): Money {
  return { amount: major * minorUnitsPerMajor(SEED_CURRENCY), currency: SEED_CURRENCY };
}

/**
 * Wrap a `Money` as `DualMoney` for a seeded order/refund. Seeded orders settle in
 * the store's currency AND are presented in it (the seed's `SEED_CURRENCY`), so the
 * shop and presentment sides are equal (distinct objects, no aliasing).
 */
function dual(money: Money): DualMoney {
  return { shop: { ...money }, presentment: { ...money } };
}

function categoryAsset(file: string): string {
  return `https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/${file}.png?width=640`;
}

/** Top-level categories + their child tiles, mirroring `SHOP_CATEGORIES`/pills. */
const TAXONOMY: {
  name: string;
  slug: string;
  pillImage: string;
  children: { name: string; slug: string; image: string }[];
}[] = [
  {
    name: 'Women',
    slug: 'women',
    pillImage: categoryAsset('20260326_1_L1_womenswear_pill'),
    children: [
      { name: 'Dresses', slug: 'dresses', image: categoryAsset('20260326_27_L2_womenswear_dresses') },
      { name: 'Shirts', slug: 'shirts', image: categoryAsset('20260326_314_L3_womenswear_shirts_tops_shirts') },
      { name: 'Sneakers', slug: 'sneakers', image: categoryAsset('20260326_188_L3_womenswear_shoes_sneakers') },
      { name: 'Pants', slug: 'pants', image: categoryAsset('20260326_26_L2_womenswear_pants') },
    ],
  },
  {
    name: 'Men',
    slug: 'men',
    pillImage: categoryAsset('20260326_2_L1_menswear_pill'),
    children: [
      { name: 'Hoodies', slug: 'hoodies', image: categoryAsset('20260326_318_L3_menswear_shirts_tops_hoodies') },
      { name: 'Pants', slug: 'mens-pants', image: categoryAsset('20260326_17_L2_menswear_pants') },
      { name: 'T-shirts', slug: 't-shirts', image: categoryAsset('20260326_317_L3_menswear_shirts_tops_t_shirts') },
      { name: 'Sneakers', slug: 'mens-sneakers', image: categoryAsset('20260326_205_L3_menswear_shoes_sneakers') },
    ],
  },
  {
    name: 'Beauty',
    slug: 'beauty',
    pillImage: categoryAsset('20260326_5_L1_beauty_pill'),
    children: [
      { name: 'Lotion & moisturizer', slug: 'lotion-moisturizer', image: categoryAsset('20260326_55_L3_beauty_skin_care_lotion_moisturizer') },
      { name: 'Hair styling products', slug: 'hair-styling-products', image: categoryAsset('20260326_206_L3_beauty_hair_care_hair_styling_products') },
      { name: 'Anti-aging kits', slug: 'anti-aging-kits', image: categoryAsset('20260326_59_L3_beauty_skin_care_anti_aging_kits') },
      { name: 'Perfume & cologne', slug: 'perfume-cologne', image: categoryAsset('20260417_66_L2_beauty_perfume_cologne') },
    ],
  },
  {
    name: 'Home',
    slug: 'home',
    pillImage: categoryAsset('20260326_6_L1_home_pill'),
    children: [
      { name: 'Blankets', slug: 'blankets', image: categoryAsset('20260326_90_L3_home_bedding_blankets') },
      { name: 'Rugs', slug: 'rugs', image: categoryAsset('20260326_77_L3_home_decor_rugs') },
      { name: 'Home fragrances', slug: 'home-fragrances', image: categoryAsset('20260417_79_L3_home_decor_home_fragrances') },
      { name: 'Household appliances', slug: 'household-appliances', image: categoryAsset('20260326_95_L2_home_household_appliances') },
    ],
  },
  {
    name: 'Fitness & nutrition',
    slug: 'fitness-nutrition',
    pillImage: categoryAsset('20260326_69_L1_fitness_nutrition_pill'),
    children: [
      { name: 'Exercise equipment', slug: 'exercise-equipment', image: categoryAsset('20260326_250_L2_fitness_nutrition_exercise_equipment') },
      { name: 'Supplements', slug: 'supplements', image: categoryAsset('20260326_242_L3_fitness_nutrition_vitamins_supplements_supplements') },
      { name: 'Vitamins', slug: 'vitamins', image: categoryAsset('20260326_241_L3_fitness_nutrition_vitamins_supplements_vitamins') },
      { name: 'Drinks & shakes', slug: 'drinks-shakes', image: categoryAsset('20260326_246_L3_fitness_nutrition_nutrition_drinks_shakes') },
    ],
  },
  {
    name: 'Baby & toddler',
    slug: 'baby-toddler',
    pillImage: categoryAsset('20260326_209_L1_baby_toddler_pill'),
    children: [
      { name: 'Formula', slug: 'formula', image: categoryAsset('20260326_219_L3_baby_toddler_nursing_feeding_formula') },
      { name: 'Strollers & travel', slug: 'strollers-travel', image: categoryAsset('20260326_225_L2_baby_toddler_strollers_travel') },
      { name: 'Diapers', slug: 'diapers', image: categoryAsset('20260326_224_L2_baby_toddler_diapers') },
      { name: 'Outfits', slug: 'outfits', image: categoryAsset('20260326_211_L3_baby_toddler_clothing_outfits') },
    ],
  },
  {
    name: 'Food & drinks',
    slug: 'food-drinks',
    pillImage: categoryAsset('20260326_251_L1_food_drinks_pill'),
    children: [
      { name: 'Coffee', slug: 'coffee', image: categoryAsset('20260326_252_L2_food_drinks_coffee') },
      { name: 'Tea', slug: 'tea', image: categoryAsset('20260326_253_L2_food_drinks_tea') },
      { name: 'Candy & chocolate', slug: 'candy-chocolate', image: categoryAsset('20260417_254_L2_food_drinks_candy_chocolate') },
      { name: 'Snacks', slug: 'snacks', image: categoryAsset('20260326_255_L2_food_drinks_snacks') },
    ],
  },
];

/** Product imagery reused from the mock feed. */
const IMG = {
  palomaMopit: 'https://cdn.shopify.com/s/files/1/0401/8048/2198/files/top_MOPIT_MARRON_1183_d6008e8f-8239-424f-90e5-4596aacfe399.jpg?width=256',
  palomaFranny: 'https://cdn.shopify.com/s/files/1/0401/8048/2198/files/Franny-DROP-5-63066.jpg?width=256',
  palomaBeni: 'https://cdn.shopify.com/s/files/1/0401/8048/2198/files/top_BENI_NEGRO46243.jpg?width=256',
  nililotanJenna: 'https://cdn.shopify.com/s/files/1/0021/7595/9158/files/WRTW_00285_W12_JENNA_STONE_29b9bec8-0794-442c-90e7-8381a0cd218a.jpg?width=256',
  nililotanShon: 'https://cdn.shopify.com/s/files/1/0021/7595/9158/files/S26_WRTW_10193_W12_SHONPANT_VINTAGEWASHEDADMIRALBLUE_aa00f7ac-4cb7-4052-bdd4-c5e145a74955.jpg?width=256',
  nililotanBalletFlat: 'https://cdn.shopify.com/s/files/1/0021/7595/9158/files/C06_WRTW_12550_L142_BALLETFLAT_BLACK_4a_ad6ed509-d285-441c-858a-d1aac216a16d.jpg?width=256',
  lakeKimono: 'https://cdn.shopify.com/s/files/1/0505/6125/files/LAKE_Webcrop_Spring2025_KimonoSet_Fog_1200x1800_469e4421-1758-44c8-a953-905daec8b878.jpg?width=384',
  huhaBikini: 'https://cdn.shopify.com/s/files/1/0053/2244/0790/files/HUHA-Ecomm-1594-WebRes.jpg?width=384',
} as const;

/** The single option axis name for the multi-variant beauty product. */
const SHADE_OPTION_NAME = 'Shade';

/** Shopify CDN base for the Brilliant Eye Brightener per-shade product imagery. */
const EYE_BRIGHTENER_IMG_BASE = 'https://cdn.shopify.com/s/files/1/0582/2885/files/';
/** Width applied to each gallery/swatch image. */
const EYE_BRIGHTENER_IMG_WIDTH = 800;

/**
 * Brilliant Eye Brightener shades, in fixed swatch order, mapped to their real
 * (verified-200) CDN image file. The PDP's swatch component cycles the listing
 * `gallery` images by index, so shade order here MUST equal gallery order — the
 * derived `EYE_BRIGHTENER_GALLERY` keeps that 1:1 alignment automatically.
 */
const EYE_BRIGHTENER_SHADE_FILES: readonly { shade: string; file: string }[] = [
  { shade: 'Muna', file: '0607_Web_Assets_PDP_BEB_Muna_Updated.jpg?v=1686098841' },
  { shade: 'Stella', file: '0607_Web_Assets_PDP_BEB_Stella_Updated.jpg?v=1686098841' },
  { shade: 'Gia', file: '0607_Web_Assets_PDP_BEB_Gia_Updated.jpg?v=1686098841' },
  { shade: 'Estrella', file: '0607_Web_Assets_PDP_BEB_Estrella_Updated.jpg?v=1686098841' },
  { shade: 'Racquel', file: '0607_Web_Assets_PDP_BEB_Raquel_Updated.jpg?v=1686098841' },
  { shade: 'Betty', file: '0607_Web_Assets_PDP_BEB_Betty_Updated.jpg?v=1686098841' },
  { shade: 'Callie', file: '0607_Web_Assets_PDP_BEB_Cali_Updated.jpg?v=1686098841' },
  { shade: 'Emma', file: '0607_Web_Assets_PDP_BEB_Emma_Updated.jpg?v=1686098841' },
  { shade: 'Anise', file: '0607_Web_Assets_PDP_BEB_Anise_Updated.jpg?v=1762181890' },
  { shade: 'Pili', file: '0607_Web_Assets_PDP_BEB_Pili_Updated.jpg?v=1686098841' },
  { shade: 'Tara', file: '0607_Web_Assets_PDP_BEB_Tara_Updated.jpg?v=1686098841' },
  { shade: 'Mieko', file: '0607_Web_Assets_PDP_BEB_Mieko_Updated.jpg?v=1686098841' },
  { shade: 'Aurora', file: '0607_Web_Assets_PDP_BEB_Aurora_Updated.jpg?v=1686098841' },
  { shade: 'Aylin', file: '0607_Web_Assets_PDP_BEB_Aylin_Updated.jpg?v=1686098841' },
  { shade: 'Shenna', file: '0607_Web_Assets_PDP_BEB_Shenna_Updated.jpg?v=1686098841' },
  { shade: 'Izzy', file: '0607_Web_Assets_PDP_BEB_Izzy_Updated.jpg?v=1686098841' },
  { shade: 'Thrive Turquoise', file: '10thAnniversary_PDP_ThriveTurq_Component.jpg?v=1741292677' },
  { shade: 'Trish', file: '10thAnniversary_PDP_Trish_Component.jpg?v=1741292722' },
] as const;

/**
 * Shade names for the Brilliant Eye Brightener (the `Shade` option `values`),
 * in fixed swatch order. Order drives swatch order on the PDP.
 */
const EYE_BRIGHTENER_SHADES: readonly string[] = EYE_BRIGHTENER_SHADE_FILES.map((s) => s.shade);

/**
 * Gallery imagery for the multi-variant beauty product (Brilliant Eye
 * Brightener). The PDP cycles these images across the shade swatches by index,
 * so this is the same order as `EYE_BRIGHTENER_SHADES` — swatch[i] shows
 * shade[i]'s image.
 */
const EYE_BRIGHTENER_GALLERY: readonly string[] = EYE_BRIGHTENER_SHADE_FILES.map(
  (s) => `${EYE_BRIGHTENER_IMG_BASE}${s.file}&width=${EYE_BRIGHTENER_IMG_WIDTH}`,
);

/** Base shade price (MAJOR-unit FAIR ⊜) for every Brilliant Eye Brightener variant. */
const EYE_BRIGHTENER_PRICE = 26;
/** Original (pre-sale) price for the shades flagged on sale. */
const EYE_BRIGHTENER_COMPARE_AT_PRICE = 34;
/** Per-variant stock for an in-stock shade. */
const EYE_BRIGHTENER_STOCK = 14;
/** Shades that are sold out (`available: 0` ⇒ `inStock: false`). */
const EYE_BRIGHTENER_SOLD_OUT_SHADES: readonly string[] = ['Gia', 'Emma', 'Aurora', 'Izzy'];
/** Shades currently on sale (carry a `compareAtPrice`). */
const EYE_BRIGHTENER_SALE_SHADES: readonly string[] = ['Stella', 'Betty'];

/**
 * Review distribution for the Brilliant Eye Brightener, keyed by star value.
 * Counts total 40 and average ≈4.6, mirroring the original Shop PDP's
 * distribution (≈82% 5★ / 7% 4★ / 5% 3★ / 3% 2★ / 4% 1★). The aggregate
 * persisted on the listing is recomputed from the seeded docs, so these are the
 * single source of truth for the seeded rating.
 */
const EYE_BRIGHTENER_REVIEW_DISTRIBUTION: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> = {
  5: 33,
  4: 3,
  3: 2,
  2: 1,
  1: 1,
} as const;

/** Newest seeded review is this many days old; the rest spread back from here. */
const REVIEW_SPREAD_DAYS = 60;
/** Milliseconds in one day, for spreading `createdAt` across the review window. */
const DAY_MS = 86_400_000;

/**
 * A handful of secondary review distributions for single-variant store products,
 * so they aren't all empty next to the headline multi-variant product. Keyed by
 * product title; each value totals 3–8 reviews skewed positive.
 */
const SECONDARY_REVIEW_DISTRIBUTIONS: Readonly<
  Record<string, Readonly<Record<1 | 2 | 3 | 4 | 5, number>>>
> = {
  'Mopit Top': { 5: 5, 4: 2, 3: 1, 2: 0, 1: 0 },
  Franny: { 5: 4, 4: 1, 3: 0, 2: 0, 1: 0 },
  'Jenna Cotton Pant': { 5: 3, 4: 2, 3: 0, 2: 1, 1: 0 },
};

/**
 * Rotating makeup-review snippets (`title` + `body`) cycled across the seeded
 * reviews by index, so each review reads like a real short product review.
 */
const REVIEW_SNIPPETS: readonly { title: string; body: string }[] = [
  { title: 'Gorgeous everyday glow', body: 'Blends in seconds with my fingertips and lasts all day. My new go-to.' },
  { title: 'Brightens tired eyes', body: 'Instantly makes me look more awake. A little goes a long way.' },
  { title: 'Buttery and natural', body: 'Creamy formula that never looks cakey or settles into fine lines.' },
  { title: 'Perfect inner-corner pop', body: 'The shimmer is subtle but noticeable — great for a no-makeup makeup look.' },
  { title: 'Holy grail highlighter', body: "I've repurchased three times. Works on eyes, cheeks, and brow bone." },
  { title: 'Lit-from-within finish', body: 'Catches the light beautifully without any chunky glitter. Love it.' },
  { title: 'So easy to use', body: 'No brushes needed. Swipe, blend, done. Travels great too.' },
  { title: 'Lovely on mature skin', body: 'Doesn’t emphasize texture at all, which most highlighters do on me.' },
  { title: 'Wears all day', body: 'Still glowing after a 10-hour shift. Impressive staying power.' },
  { title: 'Beautiful shade range', body: 'Found my exact match. Pigment is true to the swatch.' },
  { title: 'Subtle but effective', body: 'Just the right amount of shine for the office. Not over the top.' },
  { title: 'Good, not life-changing', body: 'Nice glow but I expected a touch more pigment for the price.' },
  { title: 'Creased a little on me', body: 'Pretty color, but it moved into my crease by midday. Primer helped.' },
  { title: 'Not for me', body: 'The shimmer was too sheer for what I wanted. Might suit others though.' },
  { title: 'Disappointed', body: 'Arrived fine but the formula felt drier than I remembered. Wouldn’t reorder.' },
] as const;

/** Build the per-shade variant specs for the Brilliant Eye Brightener. */
function buildEyeBrightenerVariants(): StoreVariantSpec[] {
  return EYE_BRIGHTENER_SHADES.map((shade) => {
    const variant: StoreVariantSpec = {
      optionValues: [{ name: SHADE_OPTION_NAME, value: shade }],
      price: EYE_BRIGHTENER_PRICE,
      available: EYE_BRIGHTENER_SOLD_OUT_SHADES.includes(shade) ? 0 : EYE_BRIGHTENER_STOCK,
    };
    if (EYE_BRIGHTENER_SALE_SHADES.includes(shade)) {
      variant.compareAtPrice = EYE_BRIGHTENER_COMPARE_AT_PRICE;
    }
    return variant;
  });
}

/** A persisted-review spec built for the seed (one document per entry). */
interface SeedReviewDoc {
  authorOxyUserId: string;
  targetType: 'listing';
  listingId: string;
  rating: number;
  title: string;
  body: string;
  status: 'published';
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Build the published-review documents for one listing from a star-bucket
 * distribution. Ratings are expanded from the distribution (newest first), each
 * paired with a rotating snippet and a deterministic fake author id, and
 * `createdAt` is spread back over {@link REVIEW_SPREAD_DAYS} from `now`. The
 * author ids do NOT map to real Oxy accounts — the read layer's profile
 * hydration omits them, which the PDP renders as an anonymous review.
 */
function buildListingReviews(
  listingId: string,
  distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>,
  now: Date,
): SeedReviewDoc[] {
  // Expand the distribution highest-star-first into a flat rating list.
  const ratings: number[] = [];
  for (const star of [5, 4, 3, 2, 1] as const) {
    for (let i = 0; i < distribution[star]; i += 1) {
      ratings.push(star);
    }
  }

  const total = ratings.length;
  const stepMs = total > 1 ? (REVIEW_SPREAD_DAYS * DAY_MS) / (total - 1) : 0;

  return ratings.map((rating, index) => {
    const snippet = REVIEW_SNIPPETS[index % REVIEW_SNIPPETS.length];
    // Newest review is `now`; each subsequent one steps further into the past.
    const createdAt = new Date(now.getTime() - index * stepMs);
    // Deterministic fake author id (1-based, zero-padded to a 24-char hex id).
    const authorOxyUserId = (index + 1).toString(16).padStart(24, '0');
    return {
      authorOxyUserId,
      targetType: 'listing',
      listingId,
      rating,
      title: snippet.title,
      body: snippet.body,
      status: 'published',
      createdAt,
      updatedAt: createdAt,
    };
  });
}

/**
 * A single variant within a multi-variant store product. `price`/`compareAtPrice`
 * are MAJOR-unit FAIR (⊜); `available` is the per-variant stock (0 = sold out).
 * `optionValues` assigns this variant's value for each of the product's options
 * (e.g. `[{ name: 'Shade', value: 'Stella' }]`).
 */
interface StoreVariantSpec {
  optionValues: { name: string; value: string }[];
  price: number;
  compareAtPrice?: number;
  available: number;
}

/**
 * A store-product spec for the seed. `price`/`compareAtPrice` are MAJOR-unit FAIR (⊜).
 *
 * Single-variant products set only `price`/`available` (one default variant with
 * `optionValues: []`). Multi-variant products instead declare `options` (the
 * option axes, e.g. `Shade`) AND `variants` (one spec per concrete SKU); when
 * present, the product-level `price`/`available` act as the denormalized
 * faceting fallback and are NOT used to build a variant.
 */
interface StoreProductSpec {
  title: string;
  description: string;
  categorySlug: string;
  /** Primary image; also the first gallery image when `gallery` is set. */
  image: string;
  /** Extra gallery images beyond `image` (the PDP cycles these across swatches). */
  gallery?: string[];
  price: number;
  compareAtPrice?: number;
  available: number;
  /** Option axes (e.g. `{ name: 'Shade', values: [...] }`). Empty ⇒ single default variant. */
  options?: { name: string; values: string[] }[];
  /** One spec per concrete SKU. Required (and only used) when `options` is set. */
  variants?: StoreVariantSpec[];
  /** Merchandising product type (e.g. `Knitwear`). */
  productType?: string;
  /** Extra tags beyond the default `[storeName, categorySlug]` (e.g. `['sale']`). */
  extraTags?: string[];
}

/** A store spec for the seed. */
interface StoreSpec {
  handle: string;
  name: string;
  description: string;
  brandColor: string;
  textTone: 'light' | 'dark';
  logoFileId: string;
  coverFileId: string;
  rating: number;
  reviewCount: number;
  products: StoreProductSpec[];
}

const STORES: StoreSpec[] = [
  {
    handle: 'palomawool',
    name: 'Paloma Wool',
    description: 'Independent Barcelona label of playful, sculptural knitwear and ready-to-wear.',
    brandColor: 'rgb(132,112,93)',
    textTone: 'light',
    logoFileId: 'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1716557836/paloma-wool-logo-white.png?width=480',
    coverFileId: 'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1773914305/PWSS26_B-12.jpeg?width=800',
    rating: 4.9,
    reviewCount: 1400,
    products: [
      { title: 'Mopit Top', description: 'Sculptural knit top in marrón.', categorySlug: 'shirts', image: IMG.palomaMopit, price: 125, available: 8, productType: 'Knitwear' },
      { title: 'Franny', description: 'Drop 5 ready-to-wear piece.', categorySlug: 'dresses', image: IMG.palomaFranny, price: 189, available: 5, productType: 'Dresses' },
      { title: 'Beni Top', description: 'Negro knit top.', categorySlug: 'shirts', image: IMG.palomaBeni, price: 79, compareAtPrice: 99, available: 12, productType: 'Knitwear', extraTags: ['sale'] },
    ],
  },
  {
    handle: 'nililotan',
    name: 'Nili Lotan',
    description: 'New York atelier known for elevated, effortless wardrobe staples.',
    brandColor: 'rgb(126,122,112)',
    textTone: 'light',
    logoFileId: 'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1738866286/NL_logo_cream1.png?width=480',
    coverFileId: 'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1776437673/NILILOTAN_HS26EDITORIAL_LOOK13_99140_NLO_053_02.jpeg?width=800',
    rating: 4.7,
    reviewCount: 128,
    products: [
      { title: 'Jenna Cotton Pant', description: 'Relaxed cotton pant in stone.', categorySlug: 'pants', image: IMG.nililotanJenna, price: 390, available: 6, productType: 'Pants' },
      { title: 'Shon Cotton Pant', description: 'Vintage washed admiral blue cotton pant.', categorySlug: 'pants', image: IMG.nililotanShon, price: 390, available: 4, productType: 'Pants' },
      { title: 'Leather Ballet Flat', description: 'Black leather ballet flat.', categorySlug: 'sneakers', image: IMG.nililotanBalletFlat, price: 425, compareAtPrice: 550, available: 3, productType: 'Shoes', extraTags: ['sale'] },
    ],
  },
  {
    handle: 'milkmakeup',
    name: 'Milk Makeup',
    description: 'Clean, vegan, cruelty-free beauty made for life on the go.',
    brandColor: 'rgb(214,71,107)',
    textTone: 'light',
    logoFileId: 'https://cdn.shopify.com/shop-assets/shopify_brokers/milkmakeup.myshopify.com/1716557836/milk-makeup-logo-white.png?width=480',
    coverFileId: 'https://cdn.shopify.com/s/files/1/0270/0589/3681/files/MILK-MAKEUP-Brilliant-Eye-Brightener-Cover_800x.jpg?width=800',
    rating: 4.8,
    reviewCount: 5200,
    products: [
      {
        title: 'Brilliant Eye Brightener',
        description:
          'A creamy, multi-use highlighter for eyes, cheeks, and brow bone. Swipe on and blend with fingertips for an instant lit-from-within glow.',
        categorySlug: 'lotion-moisturizer',
        image: EYE_BRIGHTENER_GALLERY[0],
        gallery: [...EYE_BRIGHTENER_GALLERY.slice(1)],
        // Product-level price/available are the denormalized faceting fallback
        // for a multi-variant product (the variants below are the real SKUs).
        price: EYE_BRIGHTENER_PRICE,
        available: EYE_BRIGHTENER_STOCK,
        productType: 'Makeup',
        options: [{ name: SHADE_OPTION_NAME, values: [...EYE_BRIGHTENER_SHADES] }],
        variants: buildEyeBrightenerVariants(),
      },
    ],
  },
];

/** P2P (secondhand) listing specs. `price` is a MAJOR-unit FAIR (⊜) value. */
interface P2PSpec {
  title: string;
  description: string;
  categorySlug: string;
  image: string;
  price: number;
  available: number;
}

const P2P_LISTINGS: P2PSpec[] = [
  {
    title: 'LAKE DreamModal Kimono Set (preloved)',
    description: 'Worn twice, freshly laundered. Size M.',
    categorySlug: 'dresses',
    image: IMG.lakeKimono,
    price: 65,
    available: 1,
  },
  {
    title: 'huha High Rise Bikini',
    description: 'New without tags, never worn. Size S.',
    categorySlug: 'shirts',
    image: IMG.huhaBikini,
    price: 18,
    available: 1,
  },
];

async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    log.general.error('Refusing to seed in production without ALLOW_PROD_SEED=true');
    process.exit(1);
  }

  await connectDB();

  log.general.info(
    'Clearing marketplace collections (Category, Store, SellerProfile, Listing, ProductVariant, Location, InventoryLevel, Collection, Discount, TaxRate, Customer, DraftOrder, Order, Refund, Review)',
  );
  await Promise.all([
    Category.deleteMany({}),
    Store.deleteMany({}),
    SellerProfile.deleteMany({}),
    Listing.deleteMany({}),
    ProductVariant.deleteMany({}),
    Location.deleteMany({}),
    InventoryLevel.deleteMany({}),
    Collection.deleteMany({}),
    Discount.deleteMany({}),
    TaxRate.deleteMany({}),
    Customer.deleteMany({}),
    DraftOrder.deleteMany({}),
    Order.deleteMany({}),
    Refund.deleteMany({}),
    Review.deleteMany({}),
  ]);

  // 1. Category taxonomy. Top-level uses its pill image; children get ancestorSlugs.
  const slugToCategoryId = new Map<string, string>();
  let categoryCount = 0;
  for (const [topIndex, top] of TAXONOMY.entries()) {
    const parent = await Category.create({
      name: top.name,
      slug: top.slug,
      parentId: null,
      ancestorSlugs: [],
      imageUrl: top.pillImage,
      position: topIndex,
      isActive: true,
    });
    const parentId = String(parent._id);
    slugToCategoryId.set(top.slug, parentId);
    categoryCount += 1;

    for (const [childIndex, child] of top.children.entries()) {
      const childDoc = await Category.create({
        name: child.name,
        slug: child.slug,
        parentId,
        ancestorSlugs: [top.slug],
        imageUrl: child.image,
        position: childIndex,
        isActive: true,
      });
      slugToCategoryId.set(child.slug, String(childDoc._id));
      categoryCount += 1;
    }
  }

  // Resolve a category slug to its id + denormalized [ancestor..., slug] path.
  function categoryRef(slug: string): { categoryId: string; categorySlugs: string[] } {
    const categoryId = slugToCategoryId.get(slug) ?? '';
    // A child's path is [parentSlug, childSlug]; a top-level's is [slug].
    const top = TAXONOMY.find((t) => t.children.some((c) => c.slug === slug));
    const categorySlugs = top ? [top.slug, slug] : [slug];
    return { categoryId, categorySlugs };
  }

  const now = new Date();
  let listingCount = 0;
  let variantCount = 0;
  let collectionCount = 0;
  let discountCount = 0;
  let taxRateCount = 0;
  let customerCount = 0;
  let posOrderCount = 0;
  let storefrontOrderCount = 0;
  let refundCount = 0;
  let reviewCount = 0;

  // 2 + 3. Stores and their products (ownerType 'store').
  for (const storeSpec of STORES) {
    const member: IStoreMember = {
      oxyUserId: DEV_OWNER_OXY_USER_ID,
      role: 'owner',
      permissions: [...ALL_STORE_PERMISSIONS],
      joinedAt: now,
    };
    const store = await Store.create({
      handle: storeSpec.handle,
      name: storeSpec.name,
      description: storeSpec.description,
      logoFileId: storeSpec.logoFileId,
      coverFileId: storeSpec.coverFileId,
      brandColor: storeSpec.brandColor,
      textTone: storeSpec.textTone,
      status: 'active',
      members: [member],
      policies: { returnWindowDays: 30 },
      defaultCurrency: SEED_CURRENCY,
      rating: storeSpec.rating,
      reviewCount: storeSpec.reviewCount,
      productCount: storeSpec.products.length,
    });
    const storeId = String(store._id);

    // Every store gets a default location; store inventory routes here.
    const defaultLocation = await Location.create({
      storeId,
      name: 'Default',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    });
    const defaultLocationId = String(defaultLocation._id);

    // Title → listing id for this store, so collections can reference products by title.
    const listingIdByTitle = new Map<string, string>();

    for (const [index, product] of storeSpec.products.entries()) {
      const ref = categoryRef(product.categorySlug);

      // Normalize single- vs multi-variant specs into one list of variants to
      // create. A spec WITHOUT `variants` is a single default variant built from
      // the product-level `price`/`compareAtPrice`/`available`.
      const variantSpecs: StoreVariantSpec[] = product.variants ?? [
        {
          optionValues: [],
          price: product.price,
          ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
          available: product.available,
        },
      ];

      // Denormalized price faceting spans every variant's price.
      const variantPrices = variantSpecs.map((v) => v.price);
      const minPrice = Math.min(...variantPrices);
      const maxPrice = Math.max(...variantPrices);
      // The listing has inventory if ANY variant has stock.
      const hasInventory = variantSpecs.some((v) => v.available > 0);

      // Gallery: primary image first, then any extra frames, all at increasing positions.
      const galleryFileIds = [product.image, ...(product.gallery ?? [])];

      const listing = await Listing.create({
        ownerType: 'store',
        storeId,
        title: product.title,
        description: product.description,
        condition: 'new',
        status: 'active',
        categoryId: ref.categoryId,
        categorySlugs: ref.categorySlugs,
        images: galleryFileIds.map((fileId, position) => ({ fileId, position })),
        tags: [storeSpec.name.toLowerCase(), product.categorySlug, ...(product.extraTags ?? [])],
        options: product.options ?? [],
        vendor: storeSpec.name,
        ...(product.productType ? { productType: product.productType } : {}),
        priceRange: {
          min: fair(minPrice),
          max: fair(maxPrice),
        },
        hasInventory,
        variantCount: variantSpecs.length,
        rating: storeSpec.rating,
        reviewCount: 0,
        publishedAt: new Date(now.getTime() - index * 1000),
      });
      listingCount += 1;
      listingIdByTitle.set(product.title, String(listing._id));

      // One ProductVariant + matching InventoryLevel per spec. A multi-variant
      // SKU's title is its joined option values (e.g. `Stella`); a default
      // variant keeps the `Default Title` sentinel. The SKU stays unique by
      // suffixing the slugified option values.
      for (const [variantIndex, variantSpec] of variantSpecs.entries()) {
        const optionSlug = variantSpec.optionValues.map((o) => slugify(o.value)).join('-');
        const sku = optionSlug
          ? `${slugify(storeSpec.handle)}-${slugify(product.title)}-${optionSlug}`
          : `${slugify(storeSpec.handle)}-${slugify(product.title)}`;
        const variantTitle =
          variantSpec.optionValues.length > 0
            ? variantSpec.optionValues.map((o) => o.value).join(' / ')
            : 'Default Title';

        const variant = await ProductVariant.create({
          listingId: String(listing._id),
          title: variantTitle,
          optionValues: variantSpec.optionValues,
          sku,
          price: fair(variantSpec.price),
          ...(variantSpec.compareAtPrice
            ? { compareAtPrice: fair(variantSpec.compareAtPrice) }
            : {}),
          inventory: { tracked: true, available: variantSpec.available, committed: 0, levels: [] },
          position: variantIndex,
        });
        variantCount += 1;

        // Store variant: stock at the store's default location. The level sum
        // equals the variant scalar `available`, keeping the rollup consistent.
        await InventoryLevel.create({
          variantId: String(variant._id),
          listingId: String(listing._id),
          locationId: defaultLocationId,
          available: variantSpec.available,
          committed: 0,
        });
      }
    }

    // 3a. Seed published reviews for this store's reviewable products. The
    // headline multi-variant product (Brilliant Eye Brightener) gets the full
    // ~4.6-avg distribution; a few single-variant products get a small positive
    // set so they aren't all empty. Each reviewed listing's denormalized
    // `{ rating, reviewCount }` aggregate is recomputed from the inserted docs.
    const reviewPlan: { title: string; distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> }[] = [
      { title: 'Brilliant Eye Brightener', distribution: EYE_BRIGHTENER_REVIEW_DISTRIBUTION },
      ...Object.entries(SECONDARY_REVIEW_DISTRIBUTIONS).map(([title, distribution]) => ({
        title,
        distribution,
      })),
    ];
    for (const plan of reviewPlan) {
      const reviewedListingId = listingIdByTitle.get(plan.title);
      if (!reviewedListingId) continue;
      const reviews = buildListingReviews(reviewedListingId, plan.distribution, now);
      if (reviews.length === 0) continue;
      await Review.insertMany(reviews);
      reviewCount += reviews.length;
      // Recompute the denormalized aggregate so the listing's stored
      // `{ rating, reviewCount }` matches the seeded reviews.
      await recomputeAggregate('listing', reviewedListingId);
    }

    // 3b. Demo collections for the first store (Paloma Wool): one MANUAL
    // (Editor's Picks: Mopit + Franny) and one AUTOMATED (On Sale: tag = 'sale').
    // Routed through the service so membership materializes onto Listing.collectionIds.
    if (storeSpec.handle === 'palomawool') {
      await createCollection(storeId, {
        title: "Editor's Picks",
        handle: 'editors-picks',
        type: 'manual',
        sortOrder: 'manual',
      });
      const editorPicks = [listingIdByTitle.get('Mopit Top'), listingIdByTitle.get('Franny')].filter(
        (id): id is string => typeof id === 'string',
      );
      const editorsCollection = await Collection.findOne({ storeId, handle: 'editors-picks' }).lean<
        { _id: mongoose.Types.ObjectId } | null
      >();
      if (editorsCollection) {
        await setCollectionProducts(storeId, String(editorsCollection._id), editorPicks);
      }

      await createCollection(storeId, {
        title: 'On Sale',
        handle: 'on-sale',
        type: 'automated',
        rules: {
          appliesDisjunctively: false,
          conditions: [{ field: 'tag', operator: 'contains', value: 'sale' }],
        },
        sortOrder: 'price_asc',
      });

      collectionCount += 2;

      // 3c. Demo discounts for the first store: one CODE (`WELCOME15`, 15% off the
      // order) and one AUTOMATIC (5% off every order). Both stack with nothing.
      await Discount.create({
        storeId,
        title: 'Welcome 15% off',
        method: 'code',
        codes: [{ code: 'WELCOME15', usageCount: 0 }],
        valueType: 'percentage',
        value: 1500,
        appliesTo: { scope: 'order' },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        startsAt: now,
        isActive: true,
      });
      await Discount.create({
        storeId,
        title: 'Always-on 5% off',
        method: 'automatic',
        codes: [],
        valueType: 'percentage',
        value: 500,
        appliesTo: { scope: 'order' },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        startsAt: now,
        isActive: true,
      });
      discountCount += 2;

      // 3d. Demo tax rate for the first store: 8% US sales tax (country-wide).
      await TaxRate.create({
        storeId,
        name: 'US Sales Tax',
        rateBps: 800,
        region: { country: 'US' },
        appliesToShipping: false,
        priority: 0,
        isActive: true,
      });
      taxRateCount += 1;

      // 3e. A sample store customer + one completed POS sale (sourceChannel 'pos').
      // Demonstrates the B5 register flow: a draft converts to a paid Order related
      // to a Customer whose lifetime stats reflect that order.
      const POS_CUSTOMER_OXY_USER_ID = '000000000000000000000003';
      const posListingId = listingIdByTitle.get('Mopit Top');
      const posVariant = posListingId
        ? await ProductVariant.findOne({ listingId: posListingId }).lean<{
            _id: mongoose.Types.ObjectId;
            title: string;
            price: Money;
          } | null>()
        : null;

      if (posListingId && posVariant) {
        const posQuantity = 2;
        const unitPrice = posVariant.price;
        const lineTotal: Money = {
          amount: unitPrice.amount * posQuantity,
          currency: unitPrice.currency,
        };
        const now2 = new Date();

        const posCustomer = await Customer.create({
          storeId,
          oxyUserId: POS_CUSTOMER_OXY_USER_ID,
          isWalkIn: false,
          displayName: 'Mara Vidal',
          email: 'mara.vidal@example.com',
          tags: ['vip', 'in-store'],
          groupTags: [],
          stats: { orderCount: 1, totalSpent: lineTotal, lastOrderAt: now2 },
        });
        customerCount += 1;

        const posOrder = await Order.create({
          orderNumber: await nextOrderNumber(),
          buyerOxyUserId: POS_CUSTOMER_OXY_USER_ID,
          sellerType: 'store',
          storeId,
          customerId: String(posCustomer._id),
          sourceChannel: 'pos',
          items: [
            {
              listingId: posListingId,
              variantId: String(posVariant._id),
              title: 'Mopit Top',
              variantTitle: posVariant.title,
              optionValues: [],
              unitPrice: dual(unitPrice),
              quantity: posQuantity,
              lineTotal: dual(lineTotal),
              locationId: defaultLocationId,
            },
          ],
          shippingAddressSnapshot: {
            recipientName: 'Mara Vidal',
            line1: 'In-store',
            city: 'Barcelona',
            postalCode: '08001',
            country: 'ES',
          },
          shipping: { method: 'pickup', label: 'Pickup', cost: dual(fair(0)), trackingNumber: null },
          totals: {
            subtotal: dual(lineTotal),
            discountTotal: dual(fair(0)),
            shipping: dual(fair(0)),
            tax: dual(fair(0)),
            grandTotal: dual(lineTotal),
          },
          appliedDiscounts: [],
          taxLines: [],
          status: 'paid',
          statusHistory: [{ status: 'paid', at: now2, byOxyUserId: DEV_OWNER_OXY_USER_ID, note: 'pos sale' }],
          payment: { status: 'paid', provider: 'oxy_pay', paidAt: now2 },
          checkoutGroupId: new mongoose.Types.ObjectId().toString(),
        });
        posOrderCount += 1;

        // 3f. A sample PARTIAL refund on that paid POS sale: refund + restock one
        // of the two units. The refund (1-unit net) < grandTotal (2 units) so the
        // order lands in `partially_refunded`; stock for the variant rises by 1;
        // an RMA-numbered Refund doc is created; the customer's totalSpent drops.
        await processRefund(
          storeId,
          String(posOrder._id),
          {
            lineItems: [{ variantId: String(posVariant._id), quantity: 1, restock: true }],
            reason: 'Customer returned one unit',
          },
          DEV_OWNER_OXY_USER_ID,
        );
        refundCount += 1;

        // 3g. A handful of ONLINE storefront paid orders, staggered across the
        // last few weeks, so the B7 reports return non-trivial data: the summary
        // shows both `storefront` and `pos` channels, the sales-over-time report
        // spans multiple day buckets, and top-products has a real units ranking.
        // Each references a real seeded product of this store.
        const DAY_MS = 86_400_000;
        const storefrontSpecs: { title: string; quantity: number; daysAgo: number }[] = [
          { title: 'Franny', quantity: 1, daysAgo: 2 },
          { title: 'Beni Top', quantity: 3, daysAgo: 5 },
          { title: 'Mopit Top', quantity: 1, daysAgo: 5 },
          { title: 'Franny', quantity: 2, daysAgo: 12 },
          { title: 'Beni Top', quantity: 1, daysAgo: 20 },
        ];
        for (const spec of storefrontSpecs) {
          const listingId = listingIdByTitle.get(spec.title);
          if (!listingId) continue;
          const variant = await ProductVariant.findOne({ listingId }).lean<{
            _id: mongoose.Types.ObjectId;
            title: string;
            price: Money;
          } | null>();
          if (!variant) continue;

          const paidAt = new Date(now.getTime() - spec.daysAgo * DAY_MS);
          const lineTotal: Money = {
            amount: variant.price.amount * spec.quantity,
            currency: variant.price.currency,
          };
          const grandTotal: Money = {
            amount: lineTotal.amount + config.orders.shippingRates.standard,
            currency: lineTotal.currency,
          };
          await Order.create({
            orderNumber: await nextOrderNumber(),
            buyerOxyUserId: POS_CUSTOMER_OXY_USER_ID,
            sellerType: 'store',
            storeId,
            sourceChannel: 'storefront',
            items: [
              {
                listingId,
                variantId: String(variant._id),
                title: spec.title,
                variantTitle: variant.title,
                optionValues: [],
                unitPrice: dual(variant.price),
                quantity: spec.quantity,
                lineTotal: dual(lineTotal),
                locationId: defaultLocationId,
              },
            ],
            shippingAddressSnapshot: {
              recipientName: 'Mara Vidal',
              line1: 'Carrer de Mallorca 1',
              city: 'Barcelona',
              postalCode: '08001',
              country: 'ES',
            },
            shipping: {
              method: 'standard',
              label: 'Standard shipping',
              cost: dual({ amount: config.orders.shippingRates.standard, currency: lineTotal.currency }),
              trackingNumber: null,
            },
            totals: {
              subtotal: dual(lineTotal),
              discountTotal: dual(fair(0)),
              shipping: dual({ amount: config.orders.shippingRates.standard, currency: lineTotal.currency }),
              tax: dual(fair(0)),
              grandTotal: dual(grandTotal),
            },
            appliedDiscounts: [],
            taxLines: [],
            status: 'paid',
            statusHistory: [{ status: 'paid', at: paidAt, byOxyUserId: DEV_OWNER_OXY_USER_ID, note: 'storefront sale' }],
            payment: { status: 'paid', provider: 'oxy_pay', paidAt },
            checkoutGroupId: new mongoose.Types.ObjectId().toString(),
          });
          storefrontOrderCount += 1;
        }
      }
    }
  }

  // 4. A seller profile for the P2P dev seller, plus several P2P listings.
  await SellerProfile.create({
    oxyUserId: DEV_SELLER_OXY_USER_ID,
    isVerified: true,
    rating: 4.8,
    reviewCount: 23,
    salesCount: 41,
  });

  for (const [index, spec] of P2P_LISTINGS.entries()) {
    const ref = categoryRef(spec.categorySlug);
    const listing = await Listing.create({
      ownerType: 'user',
      oxyUserId: DEV_SELLER_OXY_USER_ID,
      title: spec.title,
      description: spec.description,
      condition: 'used',
      status: 'active',
      categoryId: ref.categoryId,
      categorySlugs: ref.categorySlugs,
      images: [{ fileId: spec.image, position: 0 }],
      tags: ['secondhand', spec.categorySlug],
      options: [],
      priceRange: {
        min: fair(spec.price),
        max: fair(spec.price),
      },
      hasInventory: spec.available > 0,
      variantCount: 1,
      publishedAt: new Date(now.getTime() - (index + 100) * 1000),
    });
    listingCount += 1;

    await ProductVariant.create({
      listingId: String(listing._id),
      title: 'Default Title',
      optionValues: [],
      price: fair(spec.price),
      inventory: { tracked: true, available: spec.available, committed: 0, levels: [] },
      position: 0,
    });
    variantCount += 1;
  }

  log.general.info(
    {
      categories: categoryCount,
      stores: STORES.length,
      sellerProfiles: 1,
      listings: listingCount,
      variants: variantCount,
      collections: collectionCount,
      discounts: discountCount,
      taxRates: taxRateCount,
      customers: customerCount,
      posOrders: posOrderCount,
      storefrontOrders: storefrontOrderCount,
      refunds: refundCount,
      reviews: reviewCount,
    },
    'Mercaria catalog seed complete',
  );
}

seed()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Seed failed');
    try {
      await mongoose.connection.close();
    } catch (closeErr) {
      log.general.error({ err: closeErr }, 'Failed to close mongoose connection after seed error');
    }
    process.exit(1);
  });
