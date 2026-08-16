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
 * Seven of the eight top-level entries mirror `lib/mock-products.ts`'s
 * `SHOP_CATEGORIES` and the pill imagery the storefront reads, each with four
 * child tiles. The eighth is the internal holding pen described below.
 */

function categoryAsset(file: string): string {
  return `https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/${file}.png?width=640`;
}

/**
 * Whether a category is a shelf a shopper browses or an internal holding pen.
 *
 * ## The `is_active` mechanism this rests on, because the next reader should not
 * have to re-derive it
 *
 * Every SHOPPER-VISIBLE read of `categories` filters `is_active`:
 * `findActiveCategories` (the `GET /categories` browse tree and
 * `feed.service`'s shelves) and `findActiveCategoryBySlug` (the single-category
 * read). Every WRITE and GUARD path ignores it: `findCategoryBySlug` (the
 * catalogue write resolver, which materializes `listings.category_slugs`),
 * `categorySlugExists` (the connector's `CONNECTOR_DEFAULT_CATEGORY_SLUG`
 * guard) and `findCategoryById`.
 *
 * So an INACTIVE category is one a product can be filed under and a shopper can
 * never browse into. That is exactly what a default import destination needs to
 * be, and it is a property of those five functions rather than a convention —
 * changing any of them to filter differently is what would break it.
 *
 * ## Why this is a discriminated union rather than an `isActive` flag
 *
 * A flag would leave `{ isActive: false, pillImage: …, children: […] }`
 * representable and meaningless. An internal category has no pill image and no
 * child tiles because nothing renders it, and the union is what makes that
 * unstatable rather than merely unstated.
 *
 * A STRING discriminant, not a boolean: this package compiles with
 * `strict: false`, so without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant.
 */
export type TaxonomyCategory =
  | {
      readonly listing: 'shopper_facing';
      readonly name: string;
      readonly slug: string;
      readonly pillImage: string;
      readonly children: readonly { name: string; slug: string; image: string }[];
    }
  | {
      readonly listing: 'internal_only';
      readonly name: string;
      readonly slug: string;
    };

/**
 * The slug a connector files an imported product under until somebody
 * categorises it — the value `CONNECTOR_DEFAULT_CATEGORY_SLUG` names.
 *
 * ## Why it exists at all, rather than pointing the connector at `home`
 *
 * Whatever slug the connector defaults to, EVERY product from EVERY connected
 * store lands there. Pointing it at a real shelf costs one irreversible bit on
 * the first import: "a human filed this under Home" and "nobody has looked at
 * this yet" become the same state, and that distinction is the entire input to
 * re-categorisation. It also puts a whole third-party catalogue on a shelf
 * shoppers browse, which this taxonomy — fashion, beauty, home, fitness, baby,
 * food — has no correct answer for when the store sells electronics.
 *
 * ## Why it is NOT called `uncategorized`
 *
 * That word is already taken in this codebase, for the opposite state.
 * `listings.category_id` and `seller_drafts.category_id` are both `restrict`
 * specifically so a delete cannot "promote an orphaned listing into
 * uncategorized, which is a real and different state" — meaning NO category at
 * all — and `sell-yours`'s publication gate treats that as a missing category
 * and blocks on it.
 *
 * A listing filed here carries a category id and a non-empty `category_slugs`,
 * so it PASSES that gate. Naming it `uncategorized` would give one word two
 * meanings, and the collision lands exactly on a check whose whole job is to
 * refuse the other one. `imported` says what is true instead: it arrived from a
 * connected store and no human has filed it.
 */
export const IMPORT_HOLDING_CATEGORY_SLUG = 'imported';

/**
 * How many `categories` rows the taxonomy describes.
 *
 * Lives beside the data because it is a property OF the data. It is what
 * `provision-taxonomy.ts` measures its own counters against, so a walk that
 * silently skipped a branch of the union cannot report success.
 */
export function taxonomySize(): number {
  return TAXONOMY.reduce(
    (total, entry) => total + 1 + (entry.listing === 'shopper_facing' ? entry.children.length : 0),
    0,
  );
}

/** Top-level categories + their child tiles, mirroring `SHOP_CATEGORIES`/pills. */
export const TAXONOMY: readonly TaxonomyCategory[] = [
  {
    listing: 'shopper_facing',
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
    listing: 'shopper_facing',
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
    listing: 'shopper_facing',
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
    listing: 'shopper_facing',
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
    listing: 'shopper_facing',
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
    listing: 'shopper_facing',
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
    listing: 'shopper_facing',
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
  {
    listing: 'internal_only',
    name: 'Imported',
    slug: IMPORT_HOLDING_CATEGORY_SLUG,
  },
];
