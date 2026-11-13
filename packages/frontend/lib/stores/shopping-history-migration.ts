import type { ProductSummary } from '@mercaria/shared-types';

export interface ViewedProduct {
  owner: string;
  product: ProductSummary;
}

/** The persisted shape of "recently viewed" (`lib/stores/shopping-history.ts`). */
export const SHOPPING_HISTORY_VERSION = 1;

/**
 * Any older persisted state, as the current version: its viewed products and
 * nothing else. Version 0 also kept shopping conversations on the device; they
 * are the person's Alia conversations now, so a device copy is dropped rather
 * than carried.
 */
export function migrateShoppingHistory(persisted: unknown): { products: ViewedProduct[] } {
  const products =
    typeof persisted === 'object' && persisted !== null
      ? (persisted as { products?: unknown }).products
      : undefined;
  return { products: Array.isArray(products) ? (products as ViewedProduct[]) : [] };
}
