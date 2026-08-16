/**
 * The Mercaria marketplace taxonomy — the ONE definition of the category tree.
 *
 * It has two consumers with opposite jobs, which is why it lives in a module of
 * its own rather than inside either of them: `seed.ts` clears the marketplace
 * and rebuilds it for a developer, and `provision-taxonomy.ts` adds only what is
 * missing to a real database and deletes nothing. Two lists of one taxonomy
 * would disagree the first time somebody added a category to whichever file they
 * happened to open, and the disagreement would surface as products filed under a
 * slug the storefront does not render.
 *
 * The shape mirrors `lib/mock-products.ts`'s `SHOP_CATEGORIES` and the pill
 * imagery the storefront reads: seven top-level categories, each with four child
 * tiles, thirty-five rows in total.
 */

function categoryAsset(file: string): string {
  return `https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/${file}.png?width=640`;
}

/** Top-level categories + their child tiles, mirroring `SHOP_CATEGORIES`/pills. */
export const TAXONOMY: {
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
