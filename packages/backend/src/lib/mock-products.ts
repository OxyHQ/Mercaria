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
 */

import type {
  FeedSection,
  ProductFeedSection,
  MerchantFeedSection,
  CategoryFeedSection,
  ProductSummary,
  MerchantSummary,
  Category,
} from '@mercaria/shared-types';

/** Deterministic square placeholder image for a given seed. */
function placeholderImage(seed: string): string {
  return `https://picsum.photos/seed/${seed}/600/600`;
}

/** Deterministic square thumbnail image for a given seed. */
function thumbnailImage(seed: string): string {
  return `https://picsum.photos/seed/${seed}/240/240`;
}

/** Deterministic merchant cover image for a given seed (vertical, lifestyle). */
function coverImage(seed: string): string {
  return `https://picsum.photos/seed/${seed}/800/1000`;
}

/** Deterministic square category-tile image for a given seed. */
function categoryTileImage(seed: string): string {
  return `https://picsum.photos/seed/${seed}/400/400`;
}

/** Newly listed items — a mix of full-price and discounted products. */
const NEW_ARRIVALS_PRODUCTS: ProductSummary[] = [
  {
    id: 'na-1',
    brand: 'Aurora Audio',
    title: 'Wireless Over-Ear Headphones',
    imageUrl: placeholderImage('aurora-headphones'),
    rating: 4.9,
    reviewCount: 10300,
    price: { amount: 14800, currency: 'USD' },
  },
  {
    id: 'na-2',
    brand: 'Northwind',
    title: 'Merino Wool Crew Sweater',
    imageUrl: placeholderImage('northwind-sweater'),
    rating: 4.6,
    reviewCount: 842,
    price: { amount: 8900, currency: 'USD' },
    compareAtPrice: { amount: 12000, currency: 'USD' },
  },
  {
    id: 'na-3',
    brand: 'Field & Co.',
    title: 'Waxed Canvas Weekender Bag',
    imageUrl: placeholderImage('field-weekender'),
    rating: 4.8,
    reviewCount: 349,
    price: { amount: 19900, currency: 'USD' },
  },
  {
    id: 'na-4',
    brand: 'Lumen',
    title: 'Adjustable LED Desk Lamp',
    imageUrl: placeholderImage('lumen-lamp'),
    rating: 4.3,
    reviewCount: 1280,
    price: { amount: 5400, currency: 'USD' },
  },
  {
    id: 'na-5',
    brand: 'Terra Goods',
    title: 'Stoneware Coffee Mug Set',
    imageUrl: placeholderImage('terra-mugs'),
    rating: 4.7,
    reviewCount: 2110,
    price: { amount: 3600, currency: 'USD' },
  },
  {
    id: 'na-6',
    brand: 'Cascade',
    title: 'Insulated Stainless Bottle',
    imageUrl: placeholderImage('cascade-bottle'),
    rating: 4.5,
    reviewCount: 5600,
    price: { amount: 2900, currency: 'USD' },
  },
];

/** Discounted items — every entry carries a `compareAtPrice`. */
const ON_SALE_PRODUCTS: ProductSummary[] = [
  {
    id: 'os-1',
    brand: 'Vega Tech',
    title: 'Mechanical Keyboard, Tactile',
    imageUrl: placeholderImage('vega-keyboard'),
    rating: 4.8,
    reviewCount: 3420,
    price: { amount: 7900, currency: 'USD' },
    compareAtPrice: { amount: 11900, currency: 'USD' },
  },
  {
    id: 'os-2',
    brand: 'Solace',
    title: 'Linen Throw Blanket',
    imageUrl: placeholderImage('solace-blanket'),
    rating: 4.4,
    reviewCount: 690,
    price: { amount: 4500, currency: 'USD' },
    compareAtPrice: { amount: 6500, currency: 'USD' },
  },
  {
    id: 'os-3',
    brand: 'Pace Athletics',
    title: 'Lightweight Running Trainers',
    imageUrl: placeholderImage('pace-trainers'),
    rating: 4.6,
    reviewCount: 8740,
    price: { amount: 7200, currency: 'USD' },
    compareAtPrice: { amount: 11000, currency: 'USD' },
  },
  {
    id: 'os-4',
    brand: 'Orchard',
    title: 'Cast Iron Skillet, 10-inch',
    imageUrl: placeholderImage('orchard-skillet'),
    rating: 4.9,
    reviewCount: 15400,
    price: { amount: 3300, currency: 'USD' },
    compareAtPrice: { amount: 4900, currency: 'USD' },
  },
  {
    id: 'os-5',
    brand: 'Halcyon',
    title: 'Noise-Isolating Earbuds',
    imageUrl: placeholderImage('halcyon-earbuds'),
    rating: 4.2,
    reviewCount: 1960,
    price: { amount: 5900, currency: 'USD' },
    compareAtPrice: { amount: 9900, currency: 'USD' },
  },
  {
    id: 'os-6',
    brand: 'Maple Row',
    title: 'Solid Oak Cutting Board',
    imageUrl: placeholderImage('maple-board'),
    rating: 4.7,
    reviewCount: 503,
    price: { amount: 4100, currency: 'USD' },
    compareAtPrice: { amount: 5800, currency: 'USD' },
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
    handle: 'aurora-audio',
    name: 'Aurora Audio',
    coverImageUrl: coverImage('aurora-audio-cover'),
    brandColor: 'rgb(132,112,93)',
    rating: 4.9,
    reviewCount: 10300,
    textTone: 'light',
    products: [
      {
        id: 'na-1',
        title: 'Wireless Over-Ear Headphones',
        imageUrl: thumbnailImage('aurora-headphones'),
      },
      {
        id: 'os-5',
        title: 'Noise-Isolating Earbuds',
        imageUrl: thumbnailImage('halcyon-earbuds'),
      },
      {
        id: 'mer-1-3',
        title: 'Portable Bluetooth Speaker',
        imageUrl: thumbnailImage('aurora-speaker'),
      },
    ],
  },
  {
    id: 'mer-2',
    handle: 'northwind',
    name: 'Northwind',
    coverImageUrl: coverImage('northwind-cover'),
    brandColor: 'rgb(126,122,112)',
    rating: 4.7,
    reviewCount: 8700,
    textTone: 'light',
    products: [
      {
        id: 'na-2',
        title: 'Merino Wool Crew Sweater',
        imageUrl: thumbnailImage('northwind-sweater'),
      },
      {
        id: 'mer-2-2',
        title: 'Flannel Overshirt',
        imageUrl: thumbnailImage('northwind-flannel'),
      },
    ],
  },
  {
    id: 'mer-3',
    handle: 'field-and-co',
    name: 'Field & Co.',
    coverImageUrl: coverImage('field-and-co-cover'),
    brandColor: 'rgb(160,156,154)',
    rating: 4.8,
    reviewCount: 3490,
    textTone: 'dark',
    products: [
      {
        id: 'na-3',
        title: 'Waxed Canvas Weekender Bag',
        imageUrl: thumbnailImage('field-weekender'),
      },
      {
        id: 'mer-3-2',
        title: 'Leather Dopp Kit',
        imageUrl: thumbnailImage('field-dopp'),
      },
      {
        id: 'mer-3-3',
        title: 'Canvas Field Tote',
        imageUrl: thumbnailImage('field-tote'),
      },
    ],
  },
  {
    id: 'mer-4',
    handle: 'lumen',
    name: 'Lumen',
    coverImageUrl: coverImage('lumen-cover'),
    brandColor: 'rgb(110,179,181)',
    rating: 4.6,
    reviewCount: 1400,
    textTone: 'light',
    products: [
      {
        id: 'na-4',
        title: 'Adjustable LED Desk Lamp',
        imageUrl: thumbnailImage('lumen-lamp'),
      },
      {
        id: 'mer-4-2',
        title: 'Warm Floor Lamp',
        imageUrl: thumbnailImage('lumen-floor-lamp'),
      },
    ],
  },
  {
    id: 'mer-5',
    handle: 'terra-goods',
    name: 'Terra Goods',
    coverImageUrl: coverImage('terra-goods-cover'),
    brandColor: 'rgb(155,144,122)',
    rating: 4.7,
    reviewCount: 2110,
    textTone: 'light',
    products: [
      {
        id: 'na-5',
        title: 'Stoneware Coffee Mug Set',
        imageUrl: thumbnailImage('terra-mugs'),
      },
      {
        id: 'mer-5-2',
        title: 'Hand-Glazed Dinner Plates',
        imageUrl: thumbnailImage('terra-plates'),
      },
      {
        id: 'mer-5-3',
        title: 'Ceramic Pour-Over Set',
        imageUrl: thumbnailImage('terra-pourover'),
      },
    ],
  },
];

/**
 * Top-level shop categories, each with exactly four featured subcategory tiles
 * rendered as a 2×2 grid inside a `CategoryCard`. Tile ids are stable
 * (`<categoryId>-<kebab-slug>`) and seed deterministic placeholder images so
 * every tile is distinct but stable across reloads.
 */
const SHOP_CATEGORIES: Category[] = [
  {
    id: 'cat-women',
    name: 'Women',
    slug: 'women',
    subcategories: [
      { id: 'cat-women-dresses', name: 'Dresses', slug: 'dresses', imageUrl: categoryTileImage('cat-women-dresses') },
      { id: 'cat-women-shirts', name: 'Shirts', slug: 'shirts', imageUrl: categoryTileImage('cat-women-shirts') },
      { id: 'cat-women-sneakers', name: 'Sneakers', slug: 'sneakers', imageUrl: categoryTileImage('cat-women-sneakers') },
      { id: 'cat-women-pants', name: 'Pants', slug: 'pants', imageUrl: categoryTileImage('cat-women-pants') },
    ],
  },
  {
    id: 'cat-men',
    name: 'Men',
    slug: 'men',
    subcategories: [
      { id: 'cat-men-hoodies', name: 'Hoodies', slug: 'hoodies', imageUrl: categoryTileImage('cat-men-hoodies') },
      { id: 'cat-men-pants', name: 'Pants', slug: 'pants', imageUrl: categoryTileImage('cat-men-pants') },
      { id: 'cat-men-t-shirts', name: 'T-shirts', slug: 't-shirts', imageUrl: categoryTileImage('cat-men-t-shirts') },
      { id: 'cat-men-sneakers', name: 'Sneakers', slug: 'sneakers', imageUrl: categoryTileImage('cat-men-sneakers') },
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
        imageUrl: categoryTileImage('cat-beauty-lotion-moisturizer'),
      },
      {
        id: 'cat-beauty-hair-styling-products',
        name: 'Hair styling products',
        slug: 'hair-styling-products',
        imageUrl: categoryTileImage('cat-beauty-hair-styling-products'),
      },
      {
        id: 'cat-beauty-anti-aging-kits',
        name: 'Anti-aging kits',
        slug: 'anti-aging-kits',
        imageUrl: categoryTileImage('cat-beauty-anti-aging-kits'),
      },
      {
        id: 'cat-beauty-perfume-cologne',
        name: 'Perfume & cologne',
        slug: 'perfume-cologne',
        imageUrl: categoryTileImage('cat-beauty-perfume-cologne'),
      },
    ],
  },
  {
    id: 'cat-home',
    name: 'Home',
    slug: 'home',
    subcategories: [
      { id: 'cat-home-blankets', name: 'Blankets', slug: 'blankets', imageUrl: categoryTileImage('cat-home-blankets') },
      { id: 'cat-home-rugs', name: 'Rugs', slug: 'rugs', imageUrl: categoryTileImage('cat-home-rugs') },
      {
        id: 'cat-home-home-fragrances',
        name: 'Home fragrances',
        slug: 'home-fragrances',
        imageUrl: categoryTileImage('cat-home-home-fragrances'),
      },
      {
        id: 'cat-home-household-appliances',
        name: 'Household appliances',
        slug: 'household-appliances',
        imageUrl: categoryTileImage('cat-home-household-appliances'),
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
        imageUrl: categoryTileImage('cat-fitness-nutrition-exercise-equipment'),
      },
      {
        id: 'cat-fitness-nutrition-supplements',
        name: 'Supplements',
        slug: 'supplements',
        imageUrl: categoryTileImage('cat-fitness-nutrition-supplements'),
      },
      {
        id: 'cat-fitness-nutrition-vitamins',
        name: 'Vitamins',
        slug: 'vitamins',
        imageUrl: categoryTileImage('cat-fitness-nutrition-vitamins'),
      },
      {
        id: 'cat-fitness-nutrition-drinks-shakes',
        name: 'Drinks & shakes',
        slug: 'drinks-shakes',
        imageUrl: categoryTileImage('cat-fitness-nutrition-drinks-shakes'),
      },
    ],
  },
  {
    id: 'cat-baby-toddler',
    name: 'Baby & toddler',
    slug: 'baby-toddler',
    subcategories: [
      { id: 'cat-baby-toddler-formula', name: 'Formula', slug: 'formula', imageUrl: categoryTileImage('cat-baby-toddler-formula') },
      {
        id: 'cat-baby-toddler-strollers-travel',
        name: 'Strollers & travel',
        slug: 'strollers-travel',
        imageUrl: categoryTileImage('cat-baby-toddler-strollers-travel'),
      },
      { id: 'cat-baby-toddler-diapers', name: 'Diapers', slug: 'diapers', imageUrl: categoryTileImage('cat-baby-toddler-diapers') },
      { id: 'cat-baby-toddler-outfits', name: 'Outfits', slug: 'outfits', imageUrl: categoryTileImage('cat-baby-toddler-outfits') },
    ],
  },
  {
    id: 'cat-food-drinks',
    name: 'Food & drinks',
    slug: 'food-drinks',
    subcategories: [
      { id: 'cat-food-drinks-coffee', name: 'Coffee', slug: 'coffee', imageUrl: categoryTileImage('cat-food-drinks-coffee') },
      { id: 'cat-food-drinks-tea', name: 'Tea', slug: 'tea', imageUrl: categoryTileImage('cat-food-drinks-tea') },
      {
        id: 'cat-food-drinks-candy-chocolate',
        name: 'Candy & chocolate',
        slug: 'candy-chocolate',
        imageUrl: categoryTileImage('cat-food-drinks-candy-chocolate'),
      },
      { id: 'cat-food-drinks-snacks', name: 'Snacks', slug: 'snacks', imageUrl: categoryTileImage('cat-food-drinks-snacks') },
    ],
  },
];

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
  NEW_ARRIVALS,
  SHOP_CATEGORIES_SECTION,
  WORTH_THE_HYPE,
  ON_SALE,
];
