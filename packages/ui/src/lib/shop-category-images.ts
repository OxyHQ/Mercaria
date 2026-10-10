/** Local copies of public Shop imagery, downloaded 2026-10-09.
 * Pills are 128px; the 28 Home category mosaic images are 384px.
 * Asset lookup only: category identity, ordering and destinations remain API-owned.
 * Exact source URLs avoid overriding a later image/version supplied by the catalog.
 * Category assets: https://shop.app/categories/7/electronics and the home feed.
 * Automotive: https://shop.app/products/8086480912680/front-ceramic-brake-pads-cp2358-db2358-premier-performance-auto-parts
 * Digital: https://shop.app/products/8068678516919/mr-frog-3d-stl-file-smiling-friends-inspired-keychain-for-fdm-resin-printing
 */
const downloadedImages: Record<string, number> = {
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_1_L1_womenswear_pill.png?width=640": require("../assets/shop-categories/women.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_2_L1_menswear_pill.png?width=640": require("../assets/shop-categories/men.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_5_L1_beauty_pill.png?width=640": require("../assets/shop-categories/beauty.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_6_L1_home_pill.png?width=640": require("../assets/shop-categories/home.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_69_L1_fitness_nutrition_pill.png?width=640": require("../assets/shop-categories/fitness.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_209_L1_baby_toddler_pill.png?width=640": require("../assets/shop-categories/baby.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_251_L1_food_drinks_pill.png?width=640": require("../assets/shop-categories/food.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_205_L3_menswear_shoes_sneakers.png?width=128": require("../assets/shop-categories/footwear.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_7_L1_electronics_pill.png?width=128": require("../assets/shop-categories/electronics.png"),
  "https://cdn.shopify.com/s/files/1/0691/9864/3496/products/2bf212_b73399cde0d4442992389d691f7bd019_mv2_2_886f54bd-935a-49f8-a194-ac382df524d9.jpg?v=1674612803&width=128": require("../assets/shop-categories/automotive.jpg"),
  "https://cdn.shopify.com/s/files/1/0575/8006/0855/files/DSC00847.jpg?width=128": require("../assets/shop-categories/digital.jpg"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_27_L2_womenswear_dresses.png?width=640": require("../assets/shop-categories/mosaic-women-dresses.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_314_L3_womenswear_shirts_tops_shirts.png?width=640": require("../assets/shop-categories/mosaic-women-shirts.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_188_L3_womenswear_shoes_sneakers.png?width=640": require("../assets/shop-categories/mosaic-women-sneakers.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_26_L2_womenswear_pants.png?width=640": require("../assets/shop-categories/mosaic-women-pants.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_318_L3_menswear_shirts_tops_hoodies.png?width=640": require("../assets/shop-categories/mosaic-men-hoodies.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_17_L2_menswear_pants.png?width=640": require("../assets/shop-categories/mosaic-men-mens-pants.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_317_L3_menswear_shirts_tops_t_shirts.png?width=640": require("../assets/shop-categories/mosaic-men-t-shirts.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_205_L3_menswear_shoes_sneakers.png?width=640": require("../assets/shop-categories/mosaic-men-mens-sneakers.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_55_L3_beauty_skin_care_lotion_moisturizer.png?width=640": require("../assets/shop-categories/mosaic-beauty-lotion-moisturizer.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_206_L3_beauty_hair_care_hair_styling_products.png?width=640": require("../assets/shop-categories/mosaic-beauty-hair-styling-products.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_59_L3_beauty_skin_care_anti_aging_kits.png?width=640": require("../assets/shop-categories/mosaic-beauty-anti-aging-kits.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260417_66_L2_beauty_perfume_cologne.png?width=640": require("../assets/shop-categories/mosaic-beauty-perfume-cologne.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_90_L3_home_bedding_blankets.png?width=640": require("../assets/shop-categories/mosaic-home-blankets.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_77_L3_home_decor_rugs.png?width=640": require("../assets/shop-categories/mosaic-home-rugs.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260417_79_L3_home_decor_home_fragrances.png?width=640": require("../assets/shop-categories/mosaic-home-home-fragrances.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_95_L2_home_household_appliances.png?width=640": require("../assets/shop-categories/mosaic-home-household-appliances.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_250_L2_fitness_nutrition_exercise_equipment.png?width=640": require("../assets/shop-categories/mosaic-fitness-nutrition-exercise-equipment.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_242_L3_fitness_nutrition_vitamins_supplements_supplements.png?width=640": require("../assets/shop-categories/mosaic-fitness-nutrition-supplements.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_241_L3_fitness_nutrition_vitamins_supplements_vitamins.png?width=640": require("../assets/shop-categories/mosaic-fitness-nutrition-vitamins.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_246_L3_fitness_nutrition_nutrition_drinks_shakes.png?width=640": require("../assets/shop-categories/mosaic-fitness-nutrition-drinks-shakes.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_219_L3_baby_toddler_nursing_feeding_formula.png?width=640": require("../assets/shop-categories/mosaic-baby-toddler-formula.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_225_L2_baby_toddler_strollers_travel.png?width=640": require("../assets/shop-categories/mosaic-baby-toddler-strollers-travel.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_224_L2_baby_toddler_diapers.png?width=640": require("../assets/shop-categories/mosaic-baby-toddler-diapers.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_211_L3_baby_toddler_clothing_outfits.png?width=640": require("../assets/shop-categories/mosaic-baby-toddler-outfits.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_252_L2_food_drinks_coffee.png?width=640": require("../assets/shop-categories/mosaic-food-drinks-coffee.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_253_L2_food_drinks_tea.png?width=640": require("../assets/shop-categories/mosaic-food-drinks-tea.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260417_254_L2_food_drinks_candy_chocolate.png?width=640": require("../assets/shop-categories/mosaic-food-drinks-candy-chocolate.png"),
  "https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_255_L2_food_drinks_snacks.png?width=640": require("../assets/shop-categories/mosaic-food-drinks-snacks.png"),
};

export function categoryImageSource(uri: string) {
  return downloadedImages[uri] ?? { uri };
}
