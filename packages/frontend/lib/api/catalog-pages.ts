import type {
  ApiResponse,
  BrandPage,
  CatalogCorrectionField,
  CatalogCorrectionReceipt,
  CatalogCorrectionSubject,
  CatalogProductBrowsePage,
  ProductFamilyPage,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Brand and product-family PAGE client (#72).
 *
 * `/catalog-pages/*` is the COMPOSED read — identity plus verified
 * relationships plus current offer summaries plus navigation. It is deliberately
 * separate from `/canonical-products` and `/product-families`, which serve
 * catalogue identity only and carry no price.
 *
 * There is no write here beyond a CORRECTION, and a correction is a dispute
 * rather than an edit: it reaches an operator review queue and changes nothing
 * about the page.
 */

/** Filters a brand or family product grid accepts, in their wire spelling. */
export interface CatalogBrowseParams {
  /** Category SLUGS, comma-joined by the caller's array. */
  categories?: readonly string[];
  families?: readonly string[];
  conditionGroups?: readonly string[];
  availability?: readonly string[];
  market?: string;
  /** `key:value` or `key:min..max`, the SAME spelling `GET /search` accepts. */
  attributes?: readonly string[];
  limit?: number;
  cursor?: string;
}

/** Comma-join the list parameters, dropping the ones the caller left out. */
function browseQuery(params: CatalogBrowseParams | undefined): Record<string, string | number> {
  if (params === undefined) return {};
  const query: Record<string, string | number> = {};
  const list = (values: readonly string[] | undefined): string | undefined =>
    values === undefined || values.length === 0 ? undefined : values.join(',');

  const categories = list(params.categories);
  if (categories !== undefined) query.categories = categories;
  const families = list(params.families);
  if (families !== undefined) query.families = families;
  const conditionGroups = list(params.conditionGroups);
  if (conditionGroups !== undefined) query.conditionGroups = conditionGroups;
  const availability = list(params.availability);
  if (availability !== undefined) query.availability = availability;
  const attributes = list(params.attributes);
  if (attributes !== undefined) query.attributes = attributes;
  if (params.market !== undefined) query.market = params.market;
  if (params.limit !== undefined) query.limit = params.limit;
  if (params.cursor !== undefined) query.cursor = params.cursor;
  return query;
}

/**
 * Fetch a brand page by id, slug or ALIAS.
 *
 * A merged brand answers with the winner and reports the redirect IN the 200,
 * so the client rewrites its address bar and renders the page it already has —
 * a 301 would cost a second round trip on every stale link.
 */
export async function fetchBrandPage(handle: string, market?: string): Promise<BrandPage> {
  const { data } = await apiClient.get<ApiResponse<BrandPage>>(
    `/catalog-pages/brands/${encodeURIComponent(handle)}`,
    { params: market === undefined ? {} : { market } },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load brand');
  }
  return data.data;
}

/** One KEYSET page of a brand's canonical products. */
export async function fetchBrandProducts(
  handle: string,
  params?: CatalogBrowseParams,
): Promise<CatalogProductBrowsePage> {
  const { data } = await apiClient.get<ApiResponse<CatalogProductBrowsePage>>(
    `/catalog-pages/brands/${encodeURIComponent(handle)}/products`,
    { params: browseQuery(params) },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load brand products');
  }
  return data.data;
}

/** Fetch a product-family page by id, slug or alias. */
export async function fetchProductFamilyPage(
  handle: string,
  params?: { market?: string; currency?: string },
): Promise<ProductFamilyPage> {
  const { data } = await apiClient.get<ApiResponse<ProductFamilyPage>>(
    `/catalog-pages/families/${encodeURIComponent(handle)}`,
    { params: params ?? {} },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load product family');
  }
  return data.data;
}

/** One KEYSET page of a family's generations. */
export async function fetchProductFamilyProducts(
  handle: string,
  params?: CatalogBrowseParams,
): Promise<CatalogProductBrowsePage> {
  const { data } = await apiClient.get<ApiResponse<CatalogProductBrowsePage>>(
    `/catalog-pages/families/${encodeURIComponent(handle)}/products`,
    { params: browseQuery(params) },
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load family products');
  }
  return data.data;
}

/**
 * Dispute a published fact.
 *
 * Names a FIELD from a closed set and carries no free text — see the backend's
 * `services/catalog-pages/correction.service.ts` for why. Submitting confers
 * nothing: the response is a queue item id, not an edit.
 */
export async function submitCatalogCorrection(input: {
  subject: CatalogCorrectionSubject;
  handle: string;
  field: CatalogCorrectionField;
}): Promise<CatalogCorrectionReceipt> {
  const { data } = await apiClient.post<ApiResponse<CatalogCorrectionReceipt>>(
    '/catalog-pages/corrections',
    input,
  );
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to submit the correction');
  }
  return data.data;
}
