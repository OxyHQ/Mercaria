/** Local copies of public Shop imagery, downloaded 2026-10-09 at 128px.
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
};

export function categoryImageSource(uri: string) {
  return downloadedImages[uri] ?? { uri };
}
