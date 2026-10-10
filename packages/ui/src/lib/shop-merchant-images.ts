/** Public Shop merchant artwork downloaded 2026-10-09 from /m/palomawool,
 * /m/nililotan and /m/milkmakeup. Exact URL lookup preserves future catalogue updates. */
const downloadedImages: Record<string, number> = {
  'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1773914536/logo.png?format=webp&width=64': require('../assets/shop-merchants/paloma-logo.webp'),
  'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1773914305/PWSS26_B-12.jpeg?width=800': require('../assets/shop-merchants/paloma-cover.jpg'),
  'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1784834046/logo.png?format=webp&width=64': require('../assets/shop-merchants/nili-logo.webp'),
  'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1783446974/Slice111.jpg.jpeg?width=800': require('../assets/shop-merchants/nili-cover.jpg'),
  'https://cdn.shopify.com/shop-assets/shopify_brokers/milkmakeup21.myshopify.com/1699543597/logo.png?format=webp&width=64': require('../assets/shop-merchants/milk-logo.webp'),
};

export function merchantImageSource(uri: string) {
  return downloadedImages[uri] ?? { uri };
}
