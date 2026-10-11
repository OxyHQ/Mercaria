/**
 * Complete category imagery for the local storefront preview after seed:verticals
 * and seed:digital-3d. Only fills missing images or replaces the earlier Unsplash
 * preview images. Never runs against production. The UI bundles these Shop assets.
 * From the repository root:
 * bun run --cwd packages/backend src/scripts/seed-storefront-category-images.ts
 */
import { connectPostgres, closePostgres } from '../db/postgres.js';
import { findCategoryBySlug } from '../db/catalog/categoryRepository.js';
import { updateCategoryPresentation } from '../db/taxonomy/taxonomyRepository.js';

const database = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.port !== '5435' ||
  database.pathname !== '/mercaria_dev' ||
  process.env.NODE_ENV === 'production'
) {
  throw new Error('This preview fixture requires the local mercaria_dev database on port 5435.');
}

const images = {
  'brake-pad-automotive':
    'https://cdn.shopify.com/s/files/1/0691/9864/3496/products/2bf212_b73399cde0d4442992389d691f7bd019_mv2_2_886f54bd-935a-49f8-a194-ac382df524d9.jpg?v=1674612803&width=128',
  'digital-goods': 'https://cdn.shopify.com/s/files/1/0575/8006/0855/files/DSC00847.jpg?width=128',
  'footwear-footwear':
    'https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_205_L3_menswear_shoes_sneakers.png?width=128',
  'smartphone-electronics':
    'https://shopify-assets.shopifycdn.com/shop-assets/static_uploads/shop-categories/20260326_7_L1_electronics_pill.png?width=128',
};

await connectPostgres();
try {
  for (const [slug, imageUrl] of Object.entries(images)) {
    const category = await findCategoryBySlug(slug);
    if (
      !category ||
      (category.imageUrl && !category.imageUrl.startsWith('https://images.unsplash.com/'))
    )
      continue;
    await updateCategoryPresentation(category.id, { imageUrl });
    console.log(`Added preview image: ${slug}`);
  }
} finally {
  await closePostgres();
}
