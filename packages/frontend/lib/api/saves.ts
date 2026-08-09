import type {
  ApiResponse,
  ConditionGroup,
  ListingSaveContext,
  ListingSaveIntent,
  ProductSave,
  ProductSaveSourceContext,
  ProductSaveSplitResolution,
  SavedItemsPage,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Saves API client (#80).
 *
 * TWO surfaces, and keeping them apart is the whole point of the issue:
 *
 *  - `/product-saves` is the canonical PRODUCT save — "I want this phone",
 *    which survives the merchant who happened to be cheapest today delisting;
 *  - `/favorites` is the exact LISTING save — "I want THIS one", which is what
 *    a buyer means about a handmade piece, an unmatched P2P item, or a used
 *    copy whose seller photographs are the reason they saved it.
 *
 * `/saved-items` merges the two into one keyset-paginated list; which kinds it
 * draws from is the server's `PRODUCT_SAVE_READS` lever, reported back as
 * `readMode` so a client renders what it was actually given rather than what it
 * expected.
 */

/**
 * Unwrap the Mercaria envelope, or throw with whatever the server said.
 *
 * `ApiResponse.data` is optional because a failure envelope carries none, so
 * every read has to state what it does when the call did not succeed. Throwing
 * is what React Query turns into an error state; returning a half-built object
 * would render an empty saved list that looks like "you have saved nothing".
 */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/** One page of the merged saved list. Stable cursor (#80 API rule 7). */
export async function fetchSavedItems(params?: {
  limit?: number;
  cursor?: string;
}): Promise<SavedItemsPage> {
  const { data } = await apiClient.get<ApiResponse<SavedItemsPage>>('/saved-items', { params });
  return unwrap(data, 'Failed to load your saved items');
}

export interface SaveProductInput {
  canonicalProductId: string;
  sourceContext: ProductSaveSourceContext;
  preferredCanonicalVariantId?: string;
  preferredConditionGroup?: ConditionGroup;
  preferredMerchantId?: string;
}

/** Save a canonical product. Idempotent — a repeated tap returns the same save. */
export async function saveProduct(input: SaveProductInput): Promise<ProductSave> {
  const { data } = await apiClient.post<ApiResponse<{ save: ProductSave }>>(
    '/product-saves',
    input,
  );
  return unwrap(data, 'Failed to save that product').save;
}

/** Un-save a canonical product. Idempotent — un-saving twice is a success. */
export async function unsaveProduct(canonicalProductId: string): Promise<void> {
  await apiClient.delete(`/product-saves/${canonicalProductId}`);
}

/** Change a save's preferred configuration, condition segment or seller. */
export async function updateProductSave(
  canonicalProductId: string,
  preferences: {
    preferredCanonicalVariantId?: string | null;
    preferredConditionGroup?: ConditionGroup | null;
    preferredMerchantId?: string | null;
  },
): Promise<ProductSave> {
  const { data } = await apiClient.patch<ApiResponse<{ save: ProductSave }>>(
    `/product-saves/${canonicalProductId}`,
    preferences,
  );
  return unwrap(data, 'Failed to update that saved product').save;
}

/** Answer a split ambiguity — keep this product, move to the other, or keep both. */
export async function resolveSplitAmbiguity(
  saveId: string,
  resolution: ProductSaveSplitResolution,
): Promise<void> {
  await apiClient.post(`/product-saves/${saveId}/resolve-split`, { resolution });
}

/**
 * What a listing page needs to render `Save product` and `Save this listing` as
 * two different controls.
 *
 * `canonicalProductId` is absent when the listing has no confident canonical
 * mapping, and the page then shows the listing button alone — which is #80
 * listing rules 1 and 2, rendered rather than described.
 */
export async function fetchListingSaveContext(listingId: string): Promise<ListingSaveContext> {
  const { data } = await apiClient.get<ApiResponse<ListingSaveContext>>(
    `/product-saves/listings/${listingId}`,
  );
  return unwrap(data, 'Failed to read that listing');
}

/**
 * Save an exact listing.
 *
 * `intent` is optional on the wire and is sent as `listing_pin` only when the
 * buyer pressed a control that MEANT the exact listing while a product save was
 * also on offer — an omitted intent leaves an existing save's intent alone, so
 * this call can never quietly downgrade a pin.
 */
export async function saveListing(
  listingId: string,
  intent?: ListingSaveIntent,
): Promise<void> {
  await apiClient.post(`/favorites/${listingId}`, intent ? { intent } : {});
}

/** Un-save an exact listing. Idempotent. */
export async function unsaveListing(listingId: string): Promise<void> {
  await apiClient.delete(`/favorites/${listingId}`);
}
