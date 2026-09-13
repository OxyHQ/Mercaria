/**
 * The public contract, taken from its ONE definition.
 *
 * Every shape and closed value set below is defined in Mercaria's shared-types
 * package (`src/public-api.ts`, plus the money and condition vocabularies it
 * names). That package is private and never published, so the build BUNDLES
 * what this module reaches — values into the JavaScript, declarations into the
 * `.d.ts` — and `scripts/smoke.mjs` fails the release if any shipped file still
 * names the private package. Nothing here re-declares a type: an SDK that kept
 * its own copy would be the second source of truth issue #1017 exists to
 * prevent.
 *
 * This is the only module in `src/` that imports the private package.
 */

export {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  CONDITION_KEY_GROUP,
  ITEM_CONDITION_KEYS,
  MERCARIA_PRODUCT_AVAILABILITIES,
  MERCARIA_PRODUCT_SORTS,
  MERCARIA_PUBLIC_API_BASE_PATH,
  MERCARIA_PUBLIC_ERROR_CODES,
  MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
  MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
  MERCARIA_REF_KINDS,
} from '@mercaria/shared-types';

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
} from '@mercaria/shared-types';
