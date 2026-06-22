/**
 * Mock home-feed data.
 *
 * Seed feed data backing the PUBLIC `GET /feed` endpoint while the marketplace
 * domain (real products, merchants, persistence) is built on top of the shell.
 *
 * The feed is an ordered list of discriminated `FeedSection`s: `'products'`
 * sections hold a row of `ProductSummary` cards, and `'merchants'` sections hold
 * a row of `MerchantSummary` (shop) cards. Typed strictly against the shared
 * `@mercaria/shared-types` contract so the feed endpoint exercises those DTOs
 * end to end.
 *
 * All image URLs are real, public Shopify CDN assets (merchant covers/logos and
 * product/category imagery on `cdn.shopify.com` / `shopify-assets.shopifycdn.com`)
 * so every tile and thumbnail resolves fast and looks like Shop.
 */

import type {
  FeedSection,
  ProductFeedSection,
  MerchantFeedSection,
  CategoryFeedSection,
  CategoryPillsFeedSection,
  ProductSummary,
  MerchantSummary,
  Category,
  CategoryPill,
} from '@mercaria/shared-types';

/**
 * Build a real Shopify category/pill tile URL from its static-upload `file`
 * name. Shared by `shop-by-category` tiles and the top `category-pills` row so
 * the long CDN prefix isn't repeated at every call site.
 */
function categoryAsset(file: string): string {
  return `https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/${file}.png?width=640`;
}

/**
 * Real Shopify product imagery reused across product shelves and merchant
 * thumbnails. Keyed by a short slug so a shelf slot and a merchant thumbnail can
 * point at the same real `cdn.shopify.com` asset.
 */
const PRODUCT_IMAGES = {
  // Standalone product-shelf items (real listings).
  lakeKimono:
    'https://cdn.shopify.com/s/files/1/0505/6125/files/LAKE_Webcrop_Spring2025_KimonoSet_Fog_1200x1800_469e4421-1758-44c8-a953-905daec8b878.jpg?width=384',
  ondoSocks:
    'https://cdn.shopify.com/s/files/1/0267/7024/3669/products/2white_2gray_7d9e64fe-4e69-4dcb-b3c5-27d34afdd12e.jpg?width=384',
  aviatorSweatshirt:
    'https://cdn.shopify.com/s/files/1/1149/5724/files/StudioSession-862_Web.jpg?width=384',
  huhaBikini:
    'https://cdn.shopify.com/s/files/1/0053/2244/0790/files/HUHA-Ecomm-1594-WebRes.jpg?width=384',
  // Merchant product imagery (also reused to fill out the shelves).
  palomaMopit:
    'https://cdn.shopify.com/s/files/1/0401/8048/2198/files/top_MOPIT_MARRON_1183_d6008e8f-8239-424f-90e5-4596aacfe399.jpg?width=256',
  palomaFranny:
    'https://cdn.shopify.com/s/files/1/0401/8048/2198/files/Franny-DROP-5-63066.jpg?width=256',
  palomaBeni:
    'https://cdn.shopify.com/s/files/1/0401/8048/2198/files/top_BENI_NEGRO46243.jpg?width=256',
  nililotanJenna:
    'https://cdn.shopify.com/s/files/1/0021/7595/9158/files/WRTW_00285_W12_JENNA_STONE_29b9bec8-0794-442c-90e7-8381a0cd218a.jpg?width=256',
  nililotanShon:
    'https://cdn.shopify.com/s/files/1/0021/7595/9158/files/S26_WRTW_10193_W12_SHONPANT_VINTAGEWASHEDADMIRALBLUE_aa00f7ac-4cb7-4052-bdd4-c5e145a74955.jpg?width=256',
  nililotanBalletFlat:
    'https://cdn.shopify.com/s/files/1/0021/7595/9158/files/C06_WRTW_12550_L142_BALLETFLAT_BLACK_4a_ad6ed509-d285-441c-858a-d1aac216a16d.jpg?width=256',
  jwpeiLexi:
    'https://cdn.shopify.com/s/files/1/0150/6292/5412/files/1SDS04-7Side.jpg?width=256',
  jwpeiSaraWhite:
    'https://cdn.shopify.com/s/files/1/0150/6292/5412/products/2MS01-2-1_7ff57dd7-f159-43a0-896e-180e66587a98.jpg?width=256',
  jwpeiSaraBlack:
    'https://cdn.shopify.com/s/files/1/0150/6292/5412/products/2MS01-1-1_36ae07d4-3e58-44b3-82bf-ca1c3304fcd7.jpg?width=256',
  telfarBolero:
    'https://cdn.shopify.com/s/files/1/0880/7204/files/TELFAR-INFINITY-BOLERO-JEEP-FRONT.jpg?width=256',
  telfarTank:
    'https://cdn.shopify.com/s/files/1/0880/7204/files/Pieced-Rib-Tank-WHITE___Short-Work-Skirt-KHAKI_9x16-R.jpg?width=256',
  telfarMabel:
    'https://cdn.shopify.com/s/files/1/0880/7204/files/MABEL_BLACK_2.jpg?width=256',
  agAdria:
    'https://cdn.shopify.com/s/files/1/0664/9036/8232/files/adria-cinched-low-rise-wide-leg-das1g75coph_1_250915110354.jpg?width=256',
  agHattie:
    'https://cdn.shopify.com/s/files/1/0664/9036/8232/files/FPD1F93VNSLSPKR_9.jpg?width=256',
  agAngel:
    'https://cdn.shopify.com/s/files/1/0664/9036/8232/files/EMP1F27HVNA_9.jpg?width=256',
} as const;

/** Newly listed items — a mix of full-price and discounted products. */
const NEW_ARRIVALS_PRODUCTS: ProductSummary[] = [
  {
    id: 'na-1',
    brand: 'LAKE',
    title: 'DreamModal Kimono Pajama Set',
    imageUrl: PRODUCT_IMAGES.lakeKimono,
    rating: 4.9,
    reviewCount: 349,
    price: { amount: 14800, currency: 'USD' },
  },
  {
    id: 'na-2',
    brand: 'Aviator Nation',
    title: 'Logo Crewneck Sweatshirt',
    imageUrl: PRODUCT_IMAGES.aviatorSweatshirt,
    rating: 4.6,
    reviewCount: 504,
    price: { amount: 17500, currency: 'USD' },
  },
  {
    id: 'na-3',
    brand: 'Paloma Wool',
    title: 'Mopit Top',
    imageUrl: PRODUCT_IMAGES.palomaMopit,
    rating: 4.8,
    reviewCount: 1183,
    price: { amount: 12500, currency: 'USD' },
  },
  {
    id: 'na-4',
    brand: 'Nili Lotan',
    title: 'Jenna Cotton Pant',
    imageUrl: PRODUCT_IMAGES.nililotanJenna,
    rating: 4.7,
    reviewCount: 285,
    price: { amount: 39000, currency: 'USD' },
  },
  {
    id: 'na-5',
    brand: 'Telfar',
    title: 'Infinity Bolero',
    imageUrl: PRODUCT_IMAGES.telfarBolero,
    rating: 4.9,
    reviewCount: 1750,
    price: { amount: 16000, currency: 'USD' },
  },
  {
    id: 'na-6',
    brand: 'AG Jeans',
    title: 'Adria Cinched Wide-Leg Jean',
    imageUrl: PRODUCT_IMAGES.agAdria,
    rating: 4.4,
    reviewCount: 1390,
    price: { amount: 24500, currency: 'USD' },
  },
];

/** Discounted items — every entry carries a `compareAtPrice`. */
const ON_SALE_PRODUCTS: ProductSummary[] = [
  {
    id: 'os-1',
    brand: 'ONDO',
    title: 'Cotton No Show Socks, 4-Pack',
    imageUrl: PRODUCT_IMAGES.ondoSocks,
    rating: 4.7,
    reviewCount: 10260,
    price: { amount: 4940, currency: 'USD' },
    compareAtPrice: { amount: 5200, currency: 'USD' },
  },
  {
    id: 'os-2',
    brand: 'huha',
    title: 'High Rise Bikini',
    imageUrl: PRODUCT_IMAGES.huhaBikini,
    rating: 4.8,
    reviewCount: 863,
    price: { amount: 2400, currency: 'USD' },
    compareAtPrice: { amount: 3200, currency: 'USD' },
  },
  {
    id: 'os-3',
    brand: 'JW PEI',
    title: 'Sara Mule, White',
    imageUrl: PRODUCT_IMAGES.jwpeiSaraWhite,
    rating: 4.6,
    reviewCount: 11500,
    price: { amount: 8900, currency: 'USD' },
    compareAtPrice: { amount: 12000, currency: 'USD' },
  },
  {
    id: 'os-4',
    brand: 'Nili Lotan',
    title: 'Leather Ballet Flat',
    imageUrl: PRODUCT_IMAGES.nililotanBalletFlat,
    rating: 4.7,
    reviewCount: 128,
    price: { amount: 42500, currency: 'USD' },
    compareAtPrice: { amount: 55000, currency: 'USD' },
  },
  {
    id: 'os-5',
    brand: 'Paloma Wool',
    title: 'Beni Top',
    imageUrl: PRODUCT_IMAGES.palomaBeni,
    rating: 4.9,
    reviewCount: 1400,
    price: { amount: 7900, currency: 'USD' },
    compareAtPrice: { amount: 9900, currency: 'USD' },
  },
  {
    id: 'os-6',
    brand: 'AG Jeans',
    title: 'Hattie Crop Jean',
    imageUrl: PRODUCT_IMAGES.agHattie,
    rating: 4.4,
    reviewCount: 13900,
    price: { amount: 16500, currency: 'USD' },
    compareAtPrice: { amount: 22500, currency: 'USD' },
  },
];

/**
 * Featured shops for the "Worth the hype" merchant carousel. Brand colors are
 * muted, earthy tones (matching the editorial reference) so the bottom gradient
 * reads as a tasteful brand wash under the text + thumbnails. `textTone` is set
 * per color (darker washes → `'light'` text; lighter washes → `'dark'` text).
 */
const WORTH_THE_HYPE_MERCHANTS: MerchantSummary[] = [
  {
    id: 'mer-1',
    handle: 'palomawool',
    name: 'Paloma Wool',
    coverImageUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1773914305/PWSS26_B-12.jpeg?width=800',
    logoUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1716557836/paloma-wool-logo-white.png?width=480',
    brandColor: 'rgb(132,112,93)',
    rating: 4.9,
    reviewCount: 1400,
    textTone: 'light',
    products: [
      { id: 'mer-1-p1', title: 'Mopit Top', imageUrl: PRODUCT_IMAGES.palomaMopit },
      { id: 'mer-1-p2', title: 'Franny', imageUrl: PRODUCT_IMAGES.palomaFranny },
      { id: 'mer-1-p3', title: 'Beni Top', imageUrl: PRODUCT_IMAGES.palomaBeni },
    ],
  },
  {
    id: 'mer-2',
    handle: 'nililotan',
    name: 'Nili Lotan',
    coverImageUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1776437673/NILILOTAN_HS26EDITORIAL_LOOK13_99140_NLO_053_02.jpeg?width=800',
    logoUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1738866286/NL_logo_cream1.png?width=480',
    brandColor: 'rgb(126,122,112)',
    rating: 4.7,
    reviewCount: 128,
    textTone: 'light',
    products: [
      { id: 'mer-2-p1', title: 'Jenna Cotton Pant', imageUrl: PRODUCT_IMAGES.nililotanJenna },
      { id: 'mer-2-p2', title: 'Shon Cotton Pant', imageUrl: PRODUCT_IMAGES.nililotanShon },
      { id: 'mer-2-p3', title: 'Leather Ballet Flat', imageUrl: PRODUCT_IMAGES.nililotanBalletFlat },
    ],
  },
  {
    id: 'mer-3',
    handle: 'jwpei',
    name: 'JW PEI',
    coverImageUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/friday-by-jw-pei.myshopify.com/1779693940/email.jpg.jpeg?width=800',
    logoUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/friday-by-jw-pei.myshopify.com/1762914900/20251112-103440.png?width=480',
    brandColor: 'rgb(160,156,154)',
    rating: 4.6,
    reviewCount: 11500,
    textTone: 'light',
    products: [
      { id: 'mer-3-p1', title: 'Lexi Terry Slide Sandal', imageUrl: PRODUCT_IMAGES.jwpeiLexi },
      { id: 'mer-3-p2', title: 'Sara Mule White', imageUrl: PRODUCT_IMAGES.jwpeiSaraWhite },
      { id: 'mer-3-p3', title: 'Sara Mule Black', imageUrl: PRODUCT_IMAGES.jwpeiSaraBlack },
    ],
  },
  {
    id: 'mer-4',
    handle: 'telfar',
    name: 'Telfar',
    coverImageUrl:
      'https://cdn.shopify.com/s/files/1/0880/7204/files/MABEL_BLACK_2.jpg?width=800',
    logoUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/shop-telfar.myshopify.com/1762383097/TELFAR_LOGOScopy.png?width=480',
    brandColor: 'rgb(155,144,122)',
    rating: 4.9,
    reviewCount: 17500,
    textTone: 'light',
    products: [
      { id: 'mer-4-p1', title: 'Infinity Bolero', imageUrl: PRODUCT_IMAGES.telfarBolero },
      { id: 'mer-4-p2', title: 'Logo Rib Tank', imageUrl: PRODUCT_IMAGES.telfarTank },
      { id: 'mer-4-p3', title: 'Mabel Bag', imageUrl: PRODUCT_IMAGES.telfarMabel },
    ],
  },
  {
    id: 'mer-5',
    handle: 'agjeans',
    name: 'AG Jeans',
    coverImageUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/agjeans-store.myshopify.com/1780589308/AG_SU26_D2_16x9_ShopApp.jpg.jpeg?width=800',
    logoUrl:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/agjeans-store.myshopify.com/1717008477/shop-app-ag-logo.png?width=480',
    brandColor: 'rgb(110,179,181)',
    rating: 4.4,
    reviewCount: 13900,
    textTone: 'dark',
    products: [
      { id: 'mer-5-p1', title: 'Adria Cinched Jean', imageUrl: PRODUCT_IMAGES.agAdria },
      { id: 'mer-5-p2', title: 'Hattie Crop Jean', imageUrl: PRODUCT_IMAGES.agHattie },
      { id: 'mer-5-p3', title: 'Angel Extended Jean', imageUrl: PRODUCT_IMAGES.agAngel },
    ],
  },
];

/**
 * Top-level shop categories, each with exactly four featured subcategory tiles
 * rendered as a 2×2 grid inside a `CategoryCard`. Tile ids are stable
 * (`<categoryId>-<kebab-slug>`) and each tile uses the real Shopify category
 * image for that subcategory.
 */
const SHOP_CATEGORIES: Category[] = [
  {
    id: 'cat-women',
    name: 'Women',
    slug: 'women',
    subcategories: [
      { id: 'cat-women-dresses', name: 'Dresses', slug: 'dresses', imageUrl: categoryAsset('20260326_27_L2_womenswear_dresses') },
      { id: 'cat-women-shirts', name: 'Shirts', slug: 'shirts', imageUrl: categoryAsset('20260326_314_L3_womenswear_shirts_tops_shirts') },
      { id: 'cat-women-sneakers', name: 'Sneakers', slug: 'sneakers', imageUrl: categoryAsset('20260326_188_L3_womenswear_shoes_sneakers') },
      { id: 'cat-women-pants', name: 'Pants', slug: 'pants', imageUrl: categoryAsset('20260326_26_L2_womenswear_pants') },
    ],
  },
  {
    id: 'cat-men',
    name: 'Men',
    slug: 'men',
    subcategories: [
      { id: 'cat-men-hoodies', name: 'Hoodies', slug: 'hoodies', imageUrl: categoryAsset('20260326_318_L3_menswear_shirts_tops_hoodies') },
      { id: 'cat-men-pants', name: 'Pants', slug: 'pants', imageUrl: categoryAsset('20260326_17_L2_menswear_pants') },
      { id: 'cat-men-t-shirts', name: 'T-shirts', slug: 't-shirts', imageUrl: categoryAsset('20260326_317_L3_menswear_shirts_tops_t_shirts') },
      { id: 'cat-men-sneakers', name: 'Sneakers', slug: 'sneakers', imageUrl: categoryAsset('20260326_205_L3_menswear_shoes_sneakers') },
    ],
  },
  {
    id: 'cat-beauty',
    name: 'Beauty',
    slug: 'beauty',
    subcategories: [
      {
        id: 'cat-beauty-lotion-moisturizer',
        name: 'Lotion & moisturizer',
        slug: 'lotion-moisturizer',
        imageUrl: categoryAsset('20260326_55_L3_beauty_skin_care_lotion_moisturizer'),
      },
      {
        id: 'cat-beauty-hair-styling-products',
        name: 'Hair styling products',
        slug: 'hair-styling-products',
        imageUrl: categoryAsset('20260326_206_L3_beauty_hair_care_hair_styling_products'),
      },
      {
        id: 'cat-beauty-anti-aging-kits',
        name: 'Anti-aging kits',
        slug: 'anti-aging-kits',
        imageUrl: categoryAsset('20260326_59_L3_beauty_skin_care_anti_aging_kits'),
      },
      {
        id: 'cat-beauty-perfume-cologne',
        name: 'Perfume & cologne',
        slug: 'perfume-cologne',
        imageUrl: categoryAsset('20260417_66_L2_beauty_perfume_cologne'),
      },
    ],
  },
  {
    id: 'cat-home',
    name: 'Home',
    slug: 'home',
    subcategories: [
      { id: 'cat-home-blankets', name: 'Blankets', slug: 'blankets', imageUrl: categoryAsset('20260326_90_L3_home_bedding_blankets') },
      { id: 'cat-home-rugs', name: 'Rugs', slug: 'rugs', imageUrl: categoryAsset('20260326_77_L3_home_decor_rugs') },
      {
        id: 'cat-home-home-fragrances',
        name: 'Home fragrances',
        slug: 'home-fragrances',
        imageUrl: categoryAsset('20260417_79_L3_home_decor_home_fragrances'),
      },
      {
        id: 'cat-home-household-appliances',
        name: 'Household appliances',
        slug: 'household-appliances',
        imageUrl: categoryAsset('20260326_95_L2_home_household_appliances'),
      },
    ],
  },
  {
    id: 'cat-fitness-nutrition',
    name: 'Fitness & nutrition',
    slug: 'fitness-nutrition',
    subcategories: [
      {
        id: 'cat-fitness-nutrition-exercise-equipment',
        name: 'Exercise equipment',
        slug: 'exercise-equipment',
        imageUrl: categoryAsset('20260326_250_L2_fitness_nutrition_exercise_equipment'),
      },
      {
        id: 'cat-fitness-nutrition-supplements',
        name: 'Supplements',
        slug: 'supplements',
        imageUrl: categoryAsset('20260326_242_L3_fitness_nutrition_vitamins_supplements_supplements'),
      },
      {
        id: 'cat-fitness-nutrition-vitamins',
        name: 'Vitamins',
        slug: 'vitamins',
        imageUrl: categoryAsset('20260326_241_L3_fitness_nutrition_vitamins_supplements_vitamins'),
      },
      {
        id: 'cat-fitness-nutrition-drinks-shakes',
        name: 'Drinks & shakes',
        slug: 'drinks-shakes',
        imageUrl: categoryAsset('20260326_246_L3_fitness_nutrition_nutrition_drinks_shakes'),
      },
    ],
  },
  {
    id: 'cat-baby-toddler',
    name: 'Baby & toddler',
    slug: 'baby-toddler',
    subcategories: [
      { id: 'cat-baby-toddler-formula', name: 'Formula', slug: 'formula', imageUrl: categoryAsset('20260326_219_L3_baby_toddler_nursing_feeding_formula') },
      {
        id: 'cat-baby-toddler-strollers-travel',
        name: 'Strollers & travel',
        slug: 'strollers-travel',
        imageUrl: categoryAsset('20260326_225_L2_baby_toddler_strollers_travel'),
      },
      { id: 'cat-baby-toddler-diapers', name: 'Diapers', slug: 'diapers', imageUrl: categoryAsset('20260326_224_L2_baby_toddler_diapers') },
      { id: 'cat-baby-toddler-outfits', name: 'Outfits', slug: 'outfits', imageUrl: categoryAsset('20260326_211_L3_baby_toddler_clothing_outfits') },
    ],
  },
  {
    id: 'cat-food-drinks',
    name: 'Food & drinks',
    slug: 'food-drinks',
    subcategories: [
      { id: 'cat-food-drinks-coffee', name: 'Coffee', slug: 'coffee', imageUrl: categoryAsset('20260326_252_L2_food_drinks_coffee') },
      { id: 'cat-food-drinks-tea', name: 'Tea', slug: 'tea', imageUrl: categoryAsset('20260326_253_L2_food_drinks_tea') },
      {
        id: 'cat-food-drinks-candy-chocolate',
        name: 'Candy & chocolate',
        slug: 'candy-chocolate',
        imageUrl: categoryAsset('20260417_254_L2_food_drinks_candy_chocolate'),
      },
      { id: 'cat-food-drinks-snacks', name: 'Snacks', slug: 'snacks', imageUrl: categoryAsset('20260326_255_L2_food_drinks_snacks') },
    ],
  },
];

/**
 * Round category pills shown in a single horizontal row at the very top of the
 * feed. `id` reuses the real `SHOP_CATEGORIES` ids so each pill links to its
 * category, and each pill uses the real Shopify L1 category pill image.
 */
const CATEGORY_PILLS: CategoryPill[] = [
  { id: 'cat-women', name: 'Women', slug: 'women', imageUrl: categoryAsset('20260326_1_L1_womenswear_pill') },
  { id: 'cat-men', name: 'Men', slug: 'men', imageUrl: categoryAsset('20260326_2_L1_menswear_pill') },
  { id: 'cat-beauty', name: 'Beauty', slug: 'beauty', imageUrl: categoryAsset('20260326_5_L1_beauty_pill') },
  { id: 'cat-home', name: 'Home', slug: 'home', imageUrl: categoryAsset('20260326_6_L1_home_pill') },
  {
    id: 'cat-fitness-nutrition',
    name: 'Fitness & nutrition',
    slug: 'fitness-nutrition',
    imageUrl: categoryAsset('20260326_69_L1_fitness_nutrition_pill'),
  },
  {
    id: 'cat-baby-toddler',
    name: 'Baby & toddler',
    slug: 'baby-toddler',
    imageUrl: categoryAsset('20260326_209_L1_baby_toddler_pill'),
  },
  {
    id: 'cat-food-drinks',
    name: 'Food & drinks',
    slug: 'food-drinks',
    imageUrl: categoryAsset('20260326_251_L1_food_drinks_pill'),
  },
];

/** Round category-pills row, rendered at the very top of the home feed. */
const CATEGORY_PILLS_SECTION: CategoryPillsFeedSection = {
  kind: 'category-pills',
  id: 'category-pills',
  pills: CATEGORY_PILLS,
};

/** Newly listed items section. */
const NEW_ARRIVALS: ProductFeedSection = {
  kind: 'products',
  id: 'new-arrivals',
  title: 'New arrivals',
  products: NEW_ARRIVALS_PRODUCTS,
};

/** Shop-by-category section (each card carries its own header). */
const SHOP_CATEGORIES_SECTION: CategoryFeedSection = {
  kind: 'categories',
  id: 'shop-by-category',
  categories: SHOP_CATEGORIES,
};

/** Featured shops section. */
const WORTH_THE_HYPE: MerchantFeedSection = {
  kind: 'merchants',
  id: 'worth-the-hype',
  title: 'Worth the hype',
  merchants: WORTH_THE_HYPE_MERCHANTS,
};

/** Discounted items section. */
const ON_SALE: ProductFeedSection = {
  kind: 'products',
  id: 'on-sale',
  title: 'On sale',
  products: ON_SALE_PRODUCTS,
};

/** Ordered sections rendered top-to-bottom on the home feed. */
export const FEED_SECTIONS: FeedSection[] = [
  CATEGORY_PILLS_SECTION,
  NEW_ARRIVALS,
  SHOP_CATEGORIES_SECTION,
  WORTH_THE_HYPE,
  ON_SALE,
];
