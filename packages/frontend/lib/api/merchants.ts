import type {
  ApiResponse,
  MerchantCatalogPage,
  MerchantOfferPage,
  MerchantPage,
} from "@mercaria/shared-types";
import apiClient from "./client";

/**
 * The merchant page API client (#73).
 *
 * `/merchants/:idOrSlug/page` is the identity, standing, channels, brands and
 * offer mix; `/catalog` and `/offers` are the two browses. All three are public
 * reads with no viewer-specific hydration, so nothing here attaches a
 * credential of its own — `apiClient` carries whichever one the session has and
 * the server ignores it for these routes.
 *
 * There is deliberately NO follow call here. A native store's follow identity
 * lives on the STORE route (`mercaria.store`), and a merchant page reaching for
 * one would be the second follow identity for one shop that #73's native-store
 * rule 3 forbids — the enforcement is that this module has no such function and
 * a scanned gate fails the build if one appears.
 */

/** One page's worth of catalogue cards. Matches the server's own default. */
const DEFAULT_PAGE_LIMIT = 24;

/** Query parameters both browses accept. `sellers` selects the marketplace lens. */
export interface MerchantBrowseParams {
  storefrontId?: string;
  sellers?: "this_merchant" | "all";
  categoryId?: string;
  brandId?: string;
  market?: string;
  conditionGroups?: readonly string[];
  availability?: readonly string[];
  limit?: number;
  cursor?: string;
}

function unwrap<T>(payload: ApiResponse<T>, fallback: string): T {
  if (!payload.success || !payload.data) {
    throw new Error(payload.error ?? payload.message ?? fallback);
  }
  return payload.data;
}

/** Fetch a merchant's page. Throws on a suppressed or unknown merchant (404). */
export async function fetchMerchantPage(idOrSlug: string): Promise<MerchantPage> {
  const { data } = await apiClient.get<ApiResponse<MerchantPage>>(
    `/merchants/${encodeURIComponent(idOrSlug)}/page`,
  );
  return unwrap(data, "Failed to load merchant");
}

/**
 * Fetch one KEYSET page of a merchant's deduplicated catalogue.
 *
 * `cursor` is opaque and passed back verbatim — never an offset. A merchant's
 * catalogue changes while somebody is scrolling it, and an offset silently
 * skips or repeats cards exactly when it does.
 */
export async function fetchMerchantCatalog(
  idOrSlug: string,
  params?: MerchantBrowseParams,
): Promise<MerchantCatalogPage> {
  const { data } = await apiClient.get<ApiResponse<MerchantCatalogPage>>(
    `/merchants/${encodeURIComponent(idOrSlug)}/catalog`,
    { params: { limit: DEFAULT_PAGE_LIMIT, ...params } },
  );
  return unwrap(data, "Failed to load merchant catalogue");
}

/** Fetch one KEYSET page of the offer-level view. */
export async function fetchMerchantOffers(
  idOrSlug: string,
  params?: MerchantBrowseParams,
): Promise<MerchantOfferPage> {
  const { data } = await apiClient.get<ApiResponse<MerchantOfferPage>>(
    `/merchants/${encodeURIComponent(idOrSlug)}/offers`,
    { params: { limit: DEFAULT_PAGE_LIMIT, ...params } },
  );
  return unwrap(data, "Failed to load merchant offers");
}
