import type {
  ApiResponse,
  CanonicalProductPage,
  ConditionGroup,
  CurrencyCode,
  OfferComparisonIntent,
  PriceHistoryResponse,
  PriceSeriesMeasure,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * The canonical product page API client (#71).
 *
 * ONE request for the page: identity, configurations, the ranked comparison and
 * the verified channels arrive together because they were read together. The
 * client deliberately does NOT assemble them from `/canonical-products`,
 * `/offers` and `/offer-comparison` — those are three different moments, and a
 * ranked offer whose row fell outside another endpoint's window would silently
 * render as nothing at all.
 *
 * Price history is a SEPARATE call, and that split is deliberate too: it is an
 * independently levered surface that answers 404 on a deployment which has not
 * enabled public reads, and folding it in would make a whole product page fail
 * for a chart nobody was promised.
 */

/** What narrows one page read. Every field is optional and the server decides the defaults. */
export interface ProductPageParams {
  /** Scope the offers to ONE configuration (#71 acceptance 4). */
  canonicalVariantId?: string;
  /** ISO 3166-1 alpha-2. Absent means unrestricted. */
  market?: string;
  /**
   * The display currency for a signed-OUT viewer.
   *
   * Ignored by the server for a signed-in buyer, whose stored preference is
   * authoritative — a preference they set is a decision and a link somebody
   * sent them is not.
   */
  currency?: CurrencyCode;
  intent?: OfferComparisonIntent;
  limit?: number;
}

/** Fetch one canonical product page. Throws on an unresolvable product (404). */
export async function fetchProductPage(
  handle: string,
  params?: ProductPageParams,
): Promise<CanonicalProductPage> {
  const { data } = await apiClient.get<ApiResponse<CanonicalProductPage>>(
    `/product-page/${encodeURIComponent(handle)}`,
    { params },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load product');
  }
  return data.data;
}

/** What one price-history request names. Every part is REQUIRED by #78's contract. */
export interface ProductPriceHistoryParams {
  canonicalProductId: string;
  segment: ConditionGroup;
  measure: PriceSeriesMeasure;
  currency: CurrencyCode;
  from: string;
  to: string;
}

/**
 * Fetch one price-history series (#78).
 *
 * Every parameter is named because the contract requires it: a chart with no
 * declared segment, measure and currency is a number that cannot be wrong
 * because it does not say what it is about.
 */
export async function fetchProductPriceHistory(
  params: ProductPriceHistoryParams,
): Promise<PriceHistoryResponse> {
  const { data } = await apiClient.get<ApiResponse<PriceHistoryResponse>>('/price-history', {
    params,
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load price history');
  }
  return data.data;
}
