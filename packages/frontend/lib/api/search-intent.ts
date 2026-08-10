import type {
  ApiResponse,
  SearchFilters,
  SearchResponse,
  ShoppingIntentRequest,
  ShoppingIntentResult,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Natural-language shopping intent (#95) and the canonical search it plans.
 *
 * TWO calls rather than one, and the split is the server's contract rather
 * than a client convenience: `POST /search-intent` returns an INTERPRETATION and
 * never runs a search, so a shopper can see what Mercaria understood BEFORE
 * paying for results (#95 client rule 3), and editing a chip re-runs the SEARCH
 * without re-parsing (#95 client rules 2 and 5).
 *
 * Neither call names a provider, a model or a prompt. Provider choice and
 * prompt logic stay on the server (#95 model-boundary rule 8), and the request
 * schema is `.strict()` — so a client that tried would be refused rather than
 * quietly honoured.
 */

/** Interpret one query. Never runs a search. */
export async function interpretShoppingIntent(
  request: ShoppingIntentRequest,
): Promise<ShoppingIntentResult> {
  const { data } = await apiClient.post<ApiResponse<ShoppingIntentResult>>(
    '/search-intent',
    request,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'We could not read that search');
  }
  return data.data;
}

/**
 * Run the canonical search (#70) with the filters an interpretation produced.
 *
 * The filters are SERIALIZED from the interpretation rather than composed here:
 * `SearchFilters` is #70's wire shape and the interpretation already carries an
 * instance of it, so a client that rebuilt one could disagree with the plan
 * whose enforcement report it is showing.
 */
export async function runCanonicalSearch(
  term: string,
  filters: SearchFilters,
  limit = 20,
): Promise<SearchResponse> {
  const params: Record<string, string> = { q: term, limit: String(limit) };
  if (filters.categorySlugs !== undefined) params.categories = filters.categorySlugs.join(',');
  if (filters.brandIds !== undefined) params.brandIds = filters.brandIds.join(',');
  if (filters.market !== undefined) params.market = filters.market;
  if (filters.conditionGroups !== undefined) {
    params.conditionGroups = filters.conditionGroups.join(',');
  }
  if (filters.availability !== undefined) params.availability = filters.availability.join(',');
  if (filters.offerKinds !== undefined) params.offerKinds = filters.offerKinds.join(',');
  if (filters.officialChannelOnly === true) params.officialChannelOnly = 'true';
  if (filters.merchantIds !== undefined) params.merchantIds = filters.merchantIds.join(',');
  if (filters.price !== undefined) {
    params.priceCurrency = filters.price.currency;
    if (filters.price.minMinor !== undefined) params.priceMin = String(filters.price.minMinor);
    if (filters.price.maxMinor !== undefined) params.priceMax = String(filters.price.maxMinor);
  }
  if (filters.attributes !== undefined) {
    // #70's wire form for an attribute filter: `key:value` or `key:min..max`.
    params.attributes = filters.attributes
      .map((attribute) =>
        attribute.value !== undefined
          ? `${attribute.key}:${attribute.value}`
          : `${attribute.key}:${attribute.minNumber ?? ''}..${attribute.maxNumber ?? ''}`,
      )
      .join(',');
  }
  const { data } = await apiClient.get<ApiResponse<SearchResponse>>('/search', { params });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Search is unavailable');
  }
  return data.data;
}
