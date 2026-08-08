/**
 * Idempotent dev seed for the Mercaria marketplace (PostgreSQL).
 *
 * Reseeds ONLY the marketplace tables and mirrors the imagery + structure of
 * `lib/mock-products.ts`, so the DB-backed `/feed` produces the same shelves the
 * frontend already consumes. It NEVER touches notifications, feedback, push
 * tokens or web-push subscriptions.
 *
 * Prices are stored in FAIR (⊜) as integer minor units at FAIR's 8-decimal
 * precision (1 ⊜ = 100_000_000 minor units). The spec `price`/`compareAtPrice`
 * fields below are MAJOR-unit FAIR values (e.g. 125 = ⊜125.00) and the `fair()`
 * builder scales them via `minorUnitsPerMajor('FAIR')`.
 *
 * ## Everything is written through the repositories and services
 *
 * Not through hand-built rows. A seed exists to produce data the application can
 * actually READ, and going around the write paths is precisely how a seed grows
 * rows no service would ever have written — an inconsistent facet, a rating with
 * no reviews behind it, a listing whose stock rollup disagrees with its levels.
 * So catalogue writes go through `catalog-write.service`, collections through
 * `collection.service`, the refund through `refund.service`, and the rating
 * aggregates through `review.service.recomputeAggregate`. Where no service owns
 * the write (the taxonomy, a store row, an already-paid order) the repository
 * that owns the table is used directly.
 *
 * The one visible consequence: the seed now obeys the application's own limits.
 * `config.catalog.maxImagesPerListing` caps a gallery at 12, and the PDP cycles
 * gallery images across the shade swatches 1:1 — so the multi-variant beauty
 * product is seeded with as many shades as the image cap allows, not the 18 the
 * old direct-to-Mongo write smuggled past it.
 *
 * ## Order and RMA numbers come from the SEQUENCES
 *
 * `nextOrderNumber` (`db/orders/orderRepository.ts`) is `nextval('order_number_seq')`
 * and the RMA one is its twin in `refundRepository`. The `Counter` collection is
 * gone; nothing here imports a Mongoose model.
 *
 * Run from `packages/backend`:
 *   NODE_ENV=development DATABASE_URL=… bun src/scripts/seed.ts
 */

import { uuidv7 } from '@oxyhq/db';
import type { CreateStoreProductInput, DualMoney, Money } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../db/postgres.js';
import { categories, listings } from '../db/schema/catalog.js';
import { STORE_PERMISSIONS, stores } from '../db/schema/stores.js';
import { orders, refunds } from '../db/schema/orders.js';
import { draftOrders } from '../db/schema/pos.js';
import { reviews, sellerProfiles } from '../db/schema/buyers.js';
import { insertCategory } from '../db/catalog/categoryRepository.js';
import { findVariantsByListing, type VariantRecord } from '../db/catalog/variantRepository.js';
import { insertStore, updateStoreColumns } from '../db/stores/storeRepository.js';
import { insertLocation } from '../db/stores/locationRepository.js';
import { insertOrder, nextOrderNumber } from '../db/orders/orderRepository.js';
import { insertReview } from '../db/buyers/reviewRepository.js';
import {
  adjustSellerSalesCount,
  ensureSellerProfile,
  setSellerRating,
} from '../db/buyers/sellerProfileRepository.js';
import { createP2PListing, createStoreProduct } from '../services/catalog-write.service.js';
import { createCollection } from '../services/collection.service.js';
import { createDiscount } from '../services/discount.service.js';
import { createTaxRate } from '../services/tax.service.js';
import { createCustomer, upsertOnPaid } from '../services/customer.service.js';
import { process as processRefund } from '../services/refund.service.js';
import { recomputeAggregate } from '../services/review.service.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import { minorUnitsPerMajor } from '../utils/money.js';
import { slugify } from '../utils/slug.js';

// FAKE dev owner — there is NO real Oxy account behind this id. Used only so the
// seeded stores/P2P listings have a deterministic owner in development.
const DEV_OWNER_OXY_USER_ID = '000000000000000000000001';
// A second FAKE dev seller for P2P listings.
const DEV_SELLER_OXY_USER_ID = '000000000000000000000002';
// The FAKE dev buyer behind the seeded POS sale and storefront orders.
const DEV_BUYER_OXY_USER_ID = '000000000000000000000003';

/** The native currency all seeded prices are stored in. */
const SEED_CURRENCY = 'FAIR' as const;

/** Milliseconds in one day, for staggering the seeded orders across the report window. */
const DAY_MS = 86_400_000;

/**
 * Build a FAIR `Money` from a MAJOR-unit value (e.g. `fair(125)` = ⊜125.00),
 * scaling to integer minor units via the currency-precision map. Keeps the seed
 * free of hardcoded `1e8` magic and precision-aware if FAIR's precision changes.
 *
 * A catalogue price is a SINGLE-currency native `Money` — two columns
 * (`*_amount` + `*_currency`) — because the catalogue stores the seller's own
 * currency and never converts. Only TRANSACTED amounts become `DualMoney`.
 */
function fair(major: number): Money {
  return { amount: major * minorUnitsPerMajor(SEED_CURRENCY), currency: SEED_CURRENCY };
}

/**
 * Wrap a `Money` as the `DualMoney` every transacted amount on an order or a
 * refund carries — FOUR columns, shop + presentment.
 *
 * Seeded orders settle in the store's currency AND are presented in it (the
 * seed's `SEED_CURRENCY`), so the two sides are equal — distinct objects, so no
 * caller can mutate one through the other.
 */
function dual(money: Money): DualMoney {
  return { shop: { ...money }, presentment: { ...money } };
}

/**
 * A seeded variant's price as a `Money`.
 *
 * `product_variants.price_*` is nullable — the two columns are absent TOGETHER —
 * so the read has to narrow rather than assert. Every variant this seed creates
 * carries a price, so an absent one is a bug in the seed and says so.
 */
function variantPrice(variant: VariantRecord): Money {
  if (variant.priceAmount === null || variant.priceCurrency === null) {
    throw new Error(`Seeded variant ${variant.id} has no price; the seed always writes one.`);
  }
  return { amount: variant.priceAmount, currency: variant.priceCurrency };
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
 *
 * The full catalogue is kept here; how many of them are SEEDED is decided by
 * {@link EYE_BRIGHTENER_SHADE_FILES} below.
 */
const EYE_BRIGHTENER_ALL_SHADE_FILES: readonly { shade: string; file: string }[] = [
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
 * The shades this seed actually creates — the leading
 * `config.catalog.maxImagesPerListing` of the catalogue above.
 *
 * The gallery cap IS the shade cap here, and that is not an arbitrary trim: the
 * PDP renders one gallery image per swatch by index, so a shade past the last
 * image would show another shade's photo. The old seed wrote the `Listing`
 * document directly and shipped all 18 past a limit `catalog-write.service`
 * enforces on every real product creation; going through the service means the
 * seed obeys the same rule the API does. Raising `MAX_IMAGES_PER_LISTING` raises
 * the shade count with it.
 */
const EYE_BRIGHTENER_SHADE_FILES = EYE_BRIGHTENER_ALL_SHADE_FILES.slice(
  0,
  config.catalog.maxImagesPerListing,
);

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
 * persisted on the listing is recomputed from the seeded rows, so these are the
 * single source of truth for the seeded rating.
 */
const EYE_BRIGHTENER_REVIEW_DISTRIBUTION: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> = {
  5: 33,
  4: 3,
  3: 2,
  2: 1,
  1: 1,
} as const;

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

/**
 * A single variant within a store product. `price`/`compareAtPrice` are
 * MAJOR-unit FAIR (⊜); `available` is the per-variant stock (0 = sold out).
 * `optionValues` assigns this variant's value for each of the product's options
 * (e.g. `[{ name: 'Shade', value: 'Stella' }]`); an EMPTY list is the single
 * default variant of a product with no option axes.
 */
interface StoreVariantSpec {
  optionValues: { name: string; value: string }[];
  price: number;
  compareAtPrice?: number;
  available: number;
}

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

/**
 * A store-product spec for the seed.
 *
 * There is no product-level price/stock any more: `catalog-write.service`
 * derives `priceRange`, `hasInventory` and `variantCount` from the variants it
 * creates, so a second copy of those numbers here could only ever disagree with
 * what the service computes. A single-variant product is one entry in
 * {@link variants} with no `optionValues`.
 */
interface StoreProductSpec {
  title: string;
  description: string;
  categorySlug: string;
  /** Primary image; also the first gallery image when `gallery` is set. */
  image: string;
  /** Extra gallery images beyond `image` (the PDP cycles these across swatches). */
  gallery?: string[];
  /** Option axes (e.g. `{ name: 'Shade', values: [...] }`). Empty ⇒ one default variant. */
  options?: { name: string; values: string[] }[];
  /** One spec per concrete SKU; at least one. */
  variants: StoreVariantSpec[];
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
      {
        title: 'Mopit Top',
        description: 'Sculptural knit top in marrón.',
        categorySlug: 'shirts',
        image: IMG.palomaMopit,
        productType: 'Knitwear',
        variants: [{ optionValues: [], price: 125, available: 8 }],
      },
      {
        title: 'Franny',
        description: 'Drop 5 ready-to-wear piece.',
        categorySlug: 'dresses',
        image: IMG.palomaFranny,
        productType: 'Dresses',
        variants: [{ optionValues: [], price: 189, available: 5 }],
      },
      {
        title: 'Beni Top',
        description: 'Negro knit top.',
        categorySlug: 'shirts',
        image: IMG.palomaBeni,
        productType: 'Knitwear',
        extraTags: ['sale'],
        variants: [{ optionValues: [], price: 79, compareAtPrice: 99, available: 12 }],
      },
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
      {
        title: 'Jenna Cotton Pant',
        description: 'Relaxed cotton pant in stone.',
        categorySlug: 'pants',
        image: IMG.nililotanJenna,
        productType: 'Pants',
        variants: [{ optionValues: [], price: 390, available: 6 }],
      },
      {
        title: 'Shon Cotton Pant',
        description: 'Vintage washed admiral blue cotton pant.',
        categorySlug: 'pants',
        image: IMG.nililotanShon,
        productType: 'Pants',
        variants: [{ optionValues: [], price: 390, available: 4 }],
      },
      {
        title: 'Leather Ballet Flat',
        description: 'Black leather ballet flat.',
        categorySlug: 'sneakers',
        image: IMG.nililotanBalletFlat,
        productType: 'Shoes',
        extraTags: ['sale'],
        variants: [{ optionValues: [], price: 425, compareAtPrice: 550, available: 3 }],
      },
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

/** One seeded review, before it has an id. */
interface SeedReview {
  authorOxyUserId: string;
  rating: number;
  title: string;
  body: string;
}

/**
 * Expand a star-bucket distribution into the reviews to write for one listing,
 * NEWEST FIRST — highest stars first, each paired with a rotating snippet and a
 * deterministic fake author id.
 *
 * The author ids do NOT map to real Oxy accounts; the read layer's profile
 * hydration omits them, which the PDP renders as an anonymous review. They are
 * distinct per position, which is what keeps
 * `reviews_author_oxy_user_id_listing_id_key` (one review per buyer per listing)
 * satisfied.
 */
function buildListingReviews(
  distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>,
): SeedReview[] {
  const ratings: number[] = [];
  for (const star of [5, 4, 3, 2, 1] as const) {
    for (let i = 0; i < distribution[star]; i += 1) {
      ratings.push(star);
    }
  }

  return ratings.map((rating, index) => {
    const snippet = REVIEW_SNIPPETS[index % REVIEW_SNIPPETS.length];
    return {
      // Deterministic fake author id (1-based, zero-padded to a 24-char hex id).
      authorOxyUserId: (index + 1).toString(16).padStart(24, '0'),
      rating,
      title: snippet.title,
      body: snippet.body,
    };
  });
}

/**
 * Clear the marketplace tables.
 *
 * ## Only SIX tables are named, and every other one goes by a declared cascade
 *
 * Each explicit delete below exists because something holds an `ON DELETE
 * RESTRICT` reference that would otherwise refuse it: `refunds`, `reviews` and
 * `draft_orders` all restrict `orders`; `orders` and `listings` both restrict
 * `stores`; `orders` restricts `customers`; `listings` restricts `categories`.
 * Everything else in the marketplace set — `store_members`, `locations`,
 * `customers`, `tax_rates`, `collections` (+ rules + memberships), `discounts`
 * (+ codes), `listing_images`, `listing_options`, `product_variants` (+ option
 * values), `inventory_levels`, `favorites`, `cart_items`, and every order and
 * refund child row — is removed by a foreign key the schema already declares.
 *
 * **`locations` is deliberately NOT deleted directly, and that was measured
 * rather than assumed.** `connections.sync_settings_target_location_id` is
 * RESTRICT, so `DELETE FROM locations` raises 23503 whenever a store has a
 * connector pinned to one; deleting the STORE removes the connection and the
 * location together and succeeds. `customers` is the same shape one table over.
 *
 * Nothing here touches `notifications`, `feedback`, `push_tokens`,
 * `web_push_subscriptions`, `addresses`, `user_preferences`, `carts` or the
 * moderation tables — the seed reseeds the marketplace, not the whole database.
 */
async function clearMarketplace(db: Database): Promise<void> {
  await db.delete(refunds);
  await db.delete(reviews);
  await db.delete(draftOrders);
  await db.delete(orders);
  await db.delete(listings);
  await db.delete(stores);
  await db.delete(categories);
  await db.delete(sellerProfiles);
}

/** Counters reported in the seed's completion log. */
interface SeedCounts {
  categories: number;
  stores: number;
  sellerProfiles: number;
  listings: number;
  variants: number;
  collections: number;
  discounts: number;
  taxRates: number;
  customers: number;
  posOrders: number;
  storefrontOrders: number;
  refunds: number;
  reviews: number;
}

/** The seeded taxonomy: every category slug mapped to its row id. */
async function seedCategories(counts: SeedCounts): Promise<void> {
  for (const [topIndex, top] of TAXONOMY.entries()) {
    const parent = await insertCategory({
      name: top.name,
      slug: top.slug,
      ancestorSlugs: [],
      imageUrl: top.pillImage,
      position: topIndex,
    });
    counts.categories += 1;

    for (const [childIndex, child] of top.children.entries()) {
      await insertCategory({
        name: child.name,
        slug: child.slug,
        parentId: parent.id,
        ancestorSlugs: [top.slug],
        imageUrl: child.image,
        position: childIndex,
      });
      counts.categories += 1;
    }
  }
}

/** The SKU for one seeded variant — store handle + product + its option values. */
function skuFor(storeHandle: string, productTitle: string, spec: StoreVariantSpec): string {
  const optionSlug = spec.optionValues.map((o) => slugify(o.value)).join('-');
  const base = `${slugify(storeHandle)}-${slugify(productTitle)}`;
  return optionSlug ? `${base}-${optionSlug}` : base;
}

/** Translate a product spec into the payload `catalog-write.service` accepts. */
function toStoreProductInput(
  storeSpec: StoreSpec,
  product: StoreProductSpec,
): CreateStoreProductInput {
  const input: CreateStoreProductInput = {
    title: product.title,
    description: product.description,
    category: product.categorySlug,
    imageFileIds: [product.image, ...(product.gallery ?? [])],
    tags: [storeSpec.name.toLowerCase(), product.categorySlug, ...(product.extraTags ?? [])],
    options: (product.options ?? []).map((o) => ({ name: o.name, values: [...o.values] })),
    variants: product.variants.map((spec) => ({
      optionValues: spec.optionValues.map((o) => ({ name: o.name, value: o.value })),
      price: fair(spec.price),
      ...(spec.compareAtPrice !== undefined
        ? { compareAtPrice: fair(spec.compareAtPrice) }
        : {}),
      sku: skuFor(storeSpec.handle, product.title, spec),
      inventory: { tracked: true, available: spec.available },
    })),
    vendor: storeSpec.name,
  };
  if (product.productType !== undefined) {
    input.productType = product.productType;
  }
  return input;
}

/**
 * Seed one store: the store row, its default location, its products, the
 * published reviews on the reviewable ones, and — for the demo store — its
 * collections, discounts, tax rate, customer, orders and refund.
 */
async function seedStore(storeSpec: StoreSpec, counts: SeedCounts): Promise<void> {
  const store = await insertStore(
    {
      handle: storeSpec.handle,
      name: storeSpec.name,
      description: storeSpec.description,
      brandColor: storeSpec.brandColor,
      defaultCurrency: SEED_CURRENCY,
      logoFileId: storeSpec.logoFileId,
      coverFileId: storeSpec.coverFileId,
    },
    [{ oxyUserId: DEV_OWNER_OXY_USER_ID, role: 'owner', permissions: [...STORE_PERMISSIONS] }],
  );
  counts.stores += 1;

  // `textTone`, `rating` and `reviewCount` are DISPLAY columns `insertStore` does
  // not take: the tone is a brand choice and the rating is the aggregate over
  // `targetType: 'store'` reviews, of which the seed writes none. They are
  // fabricated here so the "Worth the hype" merchant shelf — which orders by
  // `rating desc, product_count desc` and renders both figures on the card — has
  // something to show, exactly as the pre-port seed did.
  await updateStoreColumns(store.id, {
    textTone: storeSpec.textTone,
    rating: storeSpec.rating,
    reviewCount: storeSpec.reviewCount,
  });

  // Every store gets a default location; store inventory routes here, and
  // `createStoreProduct` resolves it to stock each new variant.
  const defaultLocation = await insertLocation(store.id, {
    name: 'Default',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });

  // Title → listing id for this store, so collections and orders can reference
  // products by the name they are written under above.
  const listingIdByTitle = new Map<string, string>();

  for (const product of storeSpec.products) {
    const listingId = await createStoreProduct(store.id, toStoreProductInput(storeSpec, product));
    listingIdByTitle.set(product.title, listingId);
    counts.listings += 1;
    counts.variants += product.variants.length;
  }

  await seedReviews(listingIdByTitle, counts);

  if (storeSpec.handle === 'palomawool') {
    await seedMerchandising(store.id, listingIdByTitle, counts);
    await seedCommerce(store.id, defaultLocation.id, listingIdByTitle, counts);
  }
}

/**
 * Seed published reviews for a store's reviewable products and recompute each
 * reviewed listing's `{ rating, reviewCount }` aggregate from what was written.
 *
 * The recompute is the point: a seed that writes reviews and leaves the
 * denormalized aggregate at zero renders a shelf with no stars while the PDP
 * lists forty reviews. `review.service.recomputeAggregate` is the same function
 * the request path and the drift sweep use, so the two cannot disagree.
 *
 * `review.service.createReview` is deliberately NOT used: it gates on a
 * qualifying prior order from the author, and these forty authors are fabricated
 * ids with no purchase history. The repository write is the honest way to state
 * that these are fixtures.
 */
async function seedReviews(
  listingIdByTitle: ReadonlyMap<string, string>,
  counts: SeedCounts,
): Promise<void> {
  const plan: { title: string; distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> }[] = [
    { title: 'Brilliant Eye Brightener', distribution: EYE_BRIGHTENER_REVIEW_DISTRIBUTION },
    ...Object.entries(SECONDARY_REVIEW_DISTRIBUTIONS).map(([title, distribution]) => ({
      title,
      distribution,
    })),
  ];

  for (const entry of plan) {
    const listingId = listingIdByTitle.get(entry.title);
    if (!listingId) continue;

    const built = buildListingReviews(entry.distribution);
    if (built.length === 0) continue;

    // Written OLDEST FIRST. `reviews.created_at` defaults to the write's own
    // `now()`, so insertion order IS the chronology every review page reads back
    // (`created_at desc, id desc`, with a k-sortable uuid v7 breaking a tie
    // inside one millisecond). `buildListingReviews` returns them newest-first so
    // the star ordering and the snippet pairing stay readable there; walking it
    // backwards here is what makes the top-rated review the newest one.
    for (let index = built.length - 1; index >= 0; index -= 1) {
      const review = built[index];
      await insertReview({
        targetType: 'listing',
        targetId: listingId,
        authorOxyUserId: review.authorOxyUserId,
        rating: review.rating,
        title: review.title,
        body: review.body,
      });
      counts.reviews += 1;
    }

    await recomputeAggregate('listing', listingId);
  }
}

/**
 * Demo merchandising for the first store: one MANUAL collection (Editor's Picks:
 * Mopit + Franny), one AUTOMATED collection (On Sale: tag = 'sale'), two
 * discounts and a tax rate.
 *
 * All four go through their services, which is what materializes the collection
 * memberships into `listing_collections` and normalizes the discount codes.
 */
async function seedMerchandising(
  storeId: string,
  listingIdByTitle: ReadonlyMap<string, string>,
  counts: SeedCounts,
): Promise<void> {
  const editorPicks = ['Mopit Top', 'Franny'].flatMap((title) => {
    const id = listingIdByTitle.get(title);
    return id ? [id] : [];
  });

  await createCollection(storeId, {
    title: "Editor's Picks",
    handle: 'editors-picks',
    type: 'manual',
    sortOrder: 'manual',
    productIds: editorPicks,
  });

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
  counts.collections += 2;

  await createDiscount(storeId, {
    title: 'Welcome 15% off',
    method: 'code',
    codes: ['WELCOME15'],
    valueType: 'percentage',
    value: 1500,
    appliesTo: { scope: 'order' },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  });
  await createDiscount(storeId, {
    title: 'Always-on 5% off',
    method: 'automatic',
    valueType: 'percentage',
    value: 500,
    appliesTo: { scope: 'order' },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  });
  counts.discounts += 2;

  await createTaxRate(storeId, {
    name: 'US Sales Tax',
    rateBps: 800,
    region: { country: 'US' },
    appliesToShipping: false,
    priority: 0,
    isActive: true,
  });
  counts.taxRates += 1;
}

/** One seeded storefront sale: which product, how many, and how long ago it was paid. */
interface StorefrontOrderSpec {
  title: string;
  quantity: number;
  daysAgo: number;
}

/** The online orders staggered across the report window. */
const STOREFRONT_ORDERS: readonly StorefrontOrderSpec[] = [
  { title: 'Franny', quantity: 1, daysAgo: 2 },
  { title: 'Beni Top', quantity: 3, daysAgo: 5 },
  { title: 'Mopit Top', quantity: 1, daysAgo: 5 },
  { title: 'Franny', quantity: 2, daysAgo: 12 },
  { title: 'Beni Top', quantity: 1, daysAgo: 20 },
];

/**
 * Demo commerce for the first store: a related customer, a completed POS sale, a
 * partial refund against it, and a handful of staggered storefront orders.
 *
 * Orders are written already-`paid` through `insertOrder` rather than created
 * pending and advanced through `order.service.transition`: the transition path
 * COMMITS reserved stock, and a seeded order never reserved any, so routing
 * through it would decrement inventory the seed just set. What the seed does take
 * from the real path is `customer.service.upsertOnPaid` — the same call the paid
 * transition makes — so the customer's lifetime `orderCount`/`totalSpent` are
 * DERIVED from the orders rather than hand-written beside them.
 */
async function seedCommerce(
  storeId: string,
  locationId: string,
  listingIdByTitle: ReadonlyMap<string, string>,
  counts: SeedCounts,
): Promise<void> {
  const posListingId = listingIdByTitle.get('Mopit Top');
  if (!posListingId) return;

  const [posVariant] = await findVariantsByListing(posListingId);
  if (!posVariant) return;

  const customer = await createCustomer(storeId, {
    oxyUserId: DEV_BUYER_OXY_USER_ID,
    displayName: 'Mara Vidal',
    email: 'mara.vidal@example.com',
    tags: ['vip', 'in-store'],
  });
  counts.customers += 1;

  // The POS sale: two units of the Mopit Top, picked up in store.
  const posQuantity = 2;
  const posUnitPrice = variantPrice(posVariant);
  const posLineTotal: Money = {
    amount: posUnitPrice.amount * posQuantity,
    currency: posUnitPrice.currency,
  };
  const posPaidAt = new Date();

  const posOrder = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOxyUserId: DEV_BUYER_OXY_USER_ID,
    sellerType: 'store',
    storeId,
    customerId: customer.id,
    sourceChannel: 'pos',
    shippingAddress: {
      recipientName: 'Mara Vidal',
      line1: 'In-store',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shippingMethod: 'pickup',
    shippingLabel: 'Pickup',
    shippingCost: dual(fair(0)),
    totals: {
      subtotal: dual(posLineTotal),
      discountTotal: dual(fair(0)),
      shipping: dual(fair(0)),
      tax: dual(fair(0)),
      grandTotal: dual(posLineTotal),
    },
    status: 'paid',
    paymentStatus: 'paid',
    paymentProvider: 'mock',
    paymentPaidAt: posPaidAt,
    checkoutGroupId: uuidv7(),
    items: [
      {
        listingId: posListingId,
        variantId: posVariant.id,
        title: 'Mopit Top',
        variantTitle: posVariant.title,
        optionValues: [],
        unitPrice: dual(posUnitPrice),
        quantity: posQuantity,
        lineTotal: dual(posLineTotal),
        locationId,
      },
    ],
    statusHistory: [
      { status: 'paid', at: posPaidAt, byOxyUserId: DEV_OWNER_OXY_USER_ID, note: 'pos sale' },
    ],
    appliedDiscounts: [],
    taxLines: [],
  });
  counts.posOrders += 1;
  await upsertOnPaid(storeId, DEV_BUYER_OXY_USER_ID, posLineTotal);

  // A PARTIAL refund on that paid sale: refund + restock one of the two units.
  // The refund (1 unit) is less than the grand total (2 units), so the order lands
  // in `partially_refunded`, an RMA-numbered refund row is created from
  // `rma_number_seq`, the variant's stock rises by one at the register's location,
  // and the customer's lifetime spend drops by the refunded amount.
  await processRefund(
    storeId,
    posOrder.id,
    {
      lineItems: [{ variantId: posVariant.id, quantity: 1, restock: true }],
      reason: 'Customer returned one unit',
    },
    DEV_OWNER_OXY_USER_ID,
  );
  counts.refunds += 1;

  // ONLINE storefront orders staggered across the last few weeks, so the reports
  // return non-trivial data: the summary shows both the `storefront` and `pos`
  // channels, the sales-over-time report spans multiple day buckets, and
  // top-products has a real units ranking. `paid_at` is what the reports bucket on
  // (`coalesce(paid_at, created_at)`), which is why it is staggered and
  // `created_at` — written by the row's own default — is not.
  const now = Date.now();
  for (const spec of STOREFRONT_ORDERS) {
    const listingId = listingIdByTitle.get(spec.title);
    if (!listingId) continue;
    const [variant] = await findVariantsByListing(listingId);
    if (!variant) continue;

    const unitPrice = variantPrice(variant);
    const lineTotal: Money = {
      amount: unitPrice.amount * spec.quantity,
      currency: unitPrice.currency,
    };
    const shipping: Money = {
      amount: config.orders.shippingRates.standard,
      currency: unitPrice.currency,
    };
    const grandTotal: Money = {
      amount: lineTotal.amount + shipping.amount,
      currency: unitPrice.currency,
    };
    const paidAt = new Date(now - spec.daysAgo * DAY_MS);

    await insertOrder({
      orderNumber: await nextOrderNumber(),
      buyerOxyUserId: DEV_BUYER_OXY_USER_ID,
      sellerType: 'store',
      storeId,
      sourceChannel: 'storefront',
      shippingAddress: {
        recipientName: 'Mara Vidal',
        line1: 'Carrer de Mallorca 1',
        city: 'Barcelona',
        postalCode: '08001',
        country: 'ES',
      },
      shippingMethod: 'standard',
      shippingLabel: 'Standard shipping',
      shippingCost: dual(shipping),
      totals: {
        subtotal: dual(lineTotal),
        discountTotal: dual(fair(0)),
        shipping: dual(shipping),
        tax: dual(fair(0)),
        grandTotal: dual(grandTotal),
      },
      status: 'paid',
      paymentStatus: 'paid',
      paymentProvider: 'mock',
      paymentPaidAt: paidAt,
      checkoutGroupId: uuidv7(),
      items: [
        {
          listingId,
          variantId: variant.id,
          title: spec.title,
          variantTitle: variant.title,
          optionValues: [],
          unitPrice: dual(unitPrice),
          quantity: spec.quantity,
          lineTotal: dual(lineTotal),
          locationId,
        },
      ],
      statusHistory: [
        {
          status: 'paid',
          at: paidAt,
          byOxyUserId: DEV_OWNER_OXY_USER_ID,
          note: 'storefront sale',
        },
      ],
      appliedDiscounts: [],
      taxLines: [],
    });
    counts.storefrontOrders += 1;
    await upsertOnPaid(storeId, DEV_BUYER_OXY_USER_ID, grandTotal);
  }
}

/**
 * The P2P (secondhand) side: one seller profile with its marketplace aggregates,
 * plus the individual seller's listings.
 *
 * `createP2PListing` hides the variant model behind a flat `price`/`quantity`
 * API and lazily creates the seller profile itself, so the aggregates are set
 * first and the listings follow.
 */
async function seedP2P(counts: SeedCounts): Promise<void> {
  await ensureSellerProfile(DEV_SELLER_OXY_USER_ID);
  await setSellerRating(DEV_SELLER_OXY_USER_ID, 4.8, 23);
  await adjustSellerSalesCount(DEV_SELLER_OXY_USER_ID, 41);
  counts.sellerProfiles += 1;

  for (const spec of P2P_LISTINGS) {
    await createP2PListing(DEV_SELLER_OXY_USER_ID, {
      title: spec.title,
      description: spec.description,
      price: fair(spec.price),
      condition: 'used',
      category: spec.categorySlug,
      imageFileIds: [spec.image],
      tags: ['secondhand', spec.categorySlug],
      quantity: spec.available,
    });
    counts.listings += 1;
    counts.variants += 1;
  }
}

async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    log.general.error('Refusing to seed in production without ALLOW_PROD_SEED=true');
    process.exit(1);
  }

  const db = await connectPostgres();

  log.general.info(
    'Clearing the marketplace tables (refunds, reviews, draft orders, orders, ' +
      'listings, stores, categories, seller profiles — everything else follows ' +
      'by a declared foreign key)',
  );
  await clearMarketplace(db);

  const counts: SeedCounts = {
    categories: 0,
    stores: 0,
    sellerProfiles: 0,
    listings: 0,
    variants: 0,
    collections: 0,
    discounts: 0,
    taxRates: 0,
    customers: 0,
    posOrders: 0,
    storefrontOrders: 0,
    refunds: 0,
    reviews: 0,
  };

  await seedCategories(counts);
  for (const storeSpec of STORES) {
    await seedStore(storeSpec, counts);
  }
  await seedP2P(counts);

  log.general.info(counts, 'Mercaria catalog seed complete');
}

seed()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Seed failed');
    try {
      await closePostgres();
    } catch (closeErr) {
      log.general.error({ err: closeErr }, 'Failed to close the Postgres pool after a seed error');
    }
    process.exit(1);
  });
