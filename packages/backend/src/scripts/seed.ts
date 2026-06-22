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
import { minorUnitsPerMajor } from '../utils/money.js';
import type { Money } from '@mercaria/shared-types';

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

/** A store-product spec for the seed. `price`/`compareAtPrice` are MAJOR-unit FAIR (⊜). */
interface StoreProductSpec {
  title: string;
  description: string;
  categorySlug: string;
  image: string;
  price: number;
  compareAtPrice?: number;
  available: number;
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
      { title: 'Mopit Top', description: 'Sculptural knit top in marrón.', categorySlug: 'shirts', image: IMG.palomaMopit, price: 125, available: 8 },
      { title: 'Franny', description: 'Drop 5 ready-to-wear piece.', categorySlug: 'dresses', image: IMG.palomaFranny, price: 189, available: 5 },
      { title: 'Beni Top', description: 'Negro knit top.', categorySlug: 'shirts', image: IMG.palomaBeni, price: 79, compareAtPrice: 99, available: 12 },
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
      { title: 'Jenna Cotton Pant', description: 'Relaxed cotton pant in stone.', categorySlug: 'pants', image: IMG.nililotanJenna, price: 390, available: 6 },
      { title: 'Shon Cotton Pant', description: 'Vintage washed admiral blue cotton pant.', categorySlug: 'pants', image: IMG.nililotanShon, price: 390, available: 4 },
      { title: 'Leather Ballet Flat', description: 'Black leather ballet flat.', categorySlug: 'sneakers', image: IMG.nililotanBalletFlat, price: 425, compareAtPrice: 550, available: 3 },
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

  log.general.info('Clearing marketplace collections (Category, Store, SellerProfile, Listing, ProductVariant)');
  await Promise.all([
    Category.deleteMany({}),
    Store.deleteMany({}),
    SellerProfile.deleteMany({}),
    Listing.deleteMany({}),
    ProductVariant.deleteMany({}),
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

    for (const [index, product] of storeSpec.products.entries()) {
      const ref = categoryRef(product.categorySlug);
      const listing = await Listing.create({
        ownerType: 'store',
        storeId,
        title: product.title,
        description: product.description,
        condition: 'new',
        status: 'active',
        categoryId: ref.categoryId,
        categorySlugs: ref.categorySlugs,
        images: [{ fileId: product.image, position: 0 }],
        tags: [storeSpec.name.toLowerCase(), product.categorySlug],
        options: [],
        priceRange: {
          min: fair(product.price),
          max: fair(product.price),
        },
        hasInventory: product.available > 0,
        variantCount: 1,
        rating: storeSpec.rating,
        reviewCount: 0,
        publishedAt: new Date(now.getTime() - index * 1000),
      });
      listingCount += 1;

      await ProductVariant.create({
        listingId: String(listing._id),
        title: 'Default Title',
        optionValues: [],
        sku: `${slugify(storeSpec.handle)}-${slugify(product.title)}`,
        price: fair(product.price),
        ...(product.compareAtPrice
          ? { compareAtPrice: fair(product.compareAtPrice) }
          : {}),
        inventory: { tracked: true, available: product.available, committed: 0, levels: [] },
        position: 0,
      });
      variantCount += 1;
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
