/** Repair only the local Shop preview artwork; use after seed on mercaria_dev. */
import { connectPostgres, closePostgres } from '../db/postgres.js';
import { findStoreByHandle, updateStoreColumns } from '../db/stores/storeRepository.js';

const database = new URL(process.env.DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.port !== '5435' ||
  database.pathname !== '/mercaria_dev' ||
  process.env.NODE_ENV === 'production'
) {
  throw new Error('This preview fixture requires the local mercaria_dev database on port 5435.');
}

const artwork = {
  palomawool: {
    logoFileId:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1773914536/logo.png?format=webp&width=64',
    coverFileId:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/palomawool.myshopify.com/1773914305/PWSS26_B-12.jpeg?width=800',
  },
  nililotan: {
    logoFileId:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1784834046/logo.png?format=webp&width=64',
    coverFileId:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/nili-lotan.myshopify.com/1783446974/Slice111.jpg.jpeg?width=800',
  },
  milkmakeup: {
    logoFileId:
      'https://cdn.shopify.com/shop-assets/shopify_brokers/milkmakeup21.myshopify.com/1699543597/logo.png?format=webp&width=64',
    coverFileId: null,
  },
};
await connectPostgres();
try {
  for (const [handle, patch] of Object.entries(artwork)) {
    const store = await findStoreByHandle(handle);
    if (
      !store ||
      (store.logoFileId === patch.logoFileId && store.coverFileId === patch.coverFileId)
    )
      continue;
    await updateStoreColumns(store.id, patch);
    console.log(`Updated local preview artwork: ${handle}`);
  }
} finally {
  await closePostgres();
}
