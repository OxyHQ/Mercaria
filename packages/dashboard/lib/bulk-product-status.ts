import { isAxiosError } from 'axios';
import type { Listing } from '@mercaria/shared-types';

export type BulkProductStatus = 'active' | 'draft' | 'archived';
export type SelectedProduct = Pick<Listing, 'id' | 'title'>;
export interface BulkStatusResult {
  updated: Listing[];
  remaining: (SelectedProduct & { outcome: 'failed' | 'notAttempted' })[];
}

/** Each response is authoritative. A failed or interrupted batch is never atomic. */
export async function applyProductStatus(
  products: readonly SelectedProduct[],
  status: BulkProductStatus,
  update: (id: string, status: BulkProductStatus) => Promise<Listing>,
  canContinue: () => boolean,
): Promise<BulkStatusResult> {
  const result: BulkStatusResult = { updated: [], remaining: [] };
  const unique = [...new Map(products.map((product) => [product.id, product])).values()];
  for (let index = 0; index < unique.length; index += 1) {
    if (!canContinue()) {
      result.remaining.push(
        ...unique.slice(index).map((product) => ({ ...product, outcome: 'notAttempted' as const })),
      );
      break;
    }
    const product = unique[index];
    try {
      const saved = await update(product.id, status);
      if (saved.id !== product.id || saved.status !== status)
        throw new Error('Unexpected product status response');
      result.updated.push(saved);
    } catch (error) {
      result.remaining.push({ ...product, outcome: 'failed' });
      if (
        isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        result.remaining.push(
          ...unique.slice(index + 1).map((item) => ({ ...item, outcome: 'notAttempted' as const })),
        );
        break;
      }
    }
  }
  return result;
}
