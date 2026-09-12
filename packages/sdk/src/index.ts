/**
 * `@mercaria.co/sdk` — the canonical integration boundary for Mercaria.
 *
 * Everything a consumer may rely on is exported from here, and nothing else is
 * part of the contract. Contract shapes are re-exported so a consumer never
 * imports Mercaria's private packages or keeps its own copy of a DTO.
 */

export {
  createMercariaClient,
  DEFAULT_MERCARIA_API_BASE_URL,
  DEFAULT_MERCARIA_TIMEOUT_MS,
  DEFAULT_MERCARIA_WEB_BASE_URL,
} from './client';
export type {
  MercariaClient,
  MercariaClientOptions,
  MercariaCollectionsApi,
  MercariaPageOptions,
  MercariaProductListOptions,
  MercariaProductSearchInput,
  MercariaProductsApi,
  MercariaRequestOptions,
  MercariaResolvedVariant,
  MercariaStoresApi,
} from './client';

export type {
  MercariaCollectionLinkTarget,
  MercariaHandleSource,
  MercariaLinks,
  MercariaProductLinkTarget,
} from './links';

export {
  collectionRef,
  formatMercariaRef,
  isMercariaRef,
  parseMercariaRef,
  parseMercariaRefString,
  productRef,
  storeRef,
  variantRef,
} from './refs';

export { iterateMercariaPages } from './pagination';

export {
  isMercariaError,
  MercariaAbortError,
  MercariaApiError,
  MercariaError,
  MercariaForbiddenError,
  MercariaGoneError,
  MercariaNetworkError,
  MercariaNotFoundError,
  MercariaRateLimitError,
  MercariaResponseError,
  MercariaTimeoutError,
  MercariaUnauthorizedError,
  MercariaUnavailableError,
  MercariaValidationError,
} from './errors';
export type { MercariaErrorCode, MercariaErrorOptions, MercariaRateLimitErrorOptions } from './errors';

export type { MercariaAccessTokenGetter } from './transport';
export type {
  MercariaAbortSignal,
  MercariaFetch,
  MercariaFetchInit,
  MercariaFetchResponse,
  MercariaHeadersLike,
} from './runtime';

export {
  MERCARIA_PRODUCT_AVAILABILITIES,
  MERCARIA_PRODUCT_SORTS,
  MERCARIA_PUBLIC_API_BASE_PATH,
  MERCARIA_PUBLIC_ERROR_CODES,
  MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
  MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
  MERCARIA_REF_KINDS,
} from './contract';
export type {
  ConditionGroup,
  CurrencyCode,
  ItemConditionKey,
  MercariaCollection,
  MercariaCollectionRef,
  MercariaImage,
  MercariaPage,
  MercariaProduct,
  MercariaProductAvailability,
  MercariaProductCondition,
  MercariaProductRef,
  MercariaProductSort,
  MercariaProductSummary,
  MercariaPublicErrorCode,
  MercariaPurchaseOption,
  MercariaRef,
  MercariaRefKind,
  MercariaSeller,
  MercariaStore,
  MercariaStoreRef,
  MercariaVariantRef,
  Money,
} from './contract';
