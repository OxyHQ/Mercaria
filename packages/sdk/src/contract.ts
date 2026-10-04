/**
 * The public contract, taken from its ONE definition.
 *
 * Every schema, type, closed value set and error code below is defined in
 * Mercaria's `@mercaria/contracts` package (zod 4), with the money and
 * condition vocabularies it names from `@mercaria/shared-types`. Both packages
 * are private and never published, so the build BUNDLES what this module
 * reaches — values into the JavaScript, declarations into the `.d.ts` — and
 * `scripts/smoke.mjs` fails the release if any shipped file still names a
 * private package. `zod` itself is the SDK's one runtime dependency.
 *
 * The SDK parses every response with these schemas and runs every query it
 * sends through the same schema the server validates it with. Nothing here
 * re-declares a type: an SDK that kept its own copy would be the second source
 * of truth issue #1017 exists to prevent.
 *
 * This is the only module in `src/` that imports a private package.
 */

export {
  MERCARIA_PRODUCT_AVAILABILITIES,
  MERCARIA_PRODUCT_SORTS,
  MERCARIA_PUBLIC_API_BASE_PATH,
  MERCARIA_PUBLIC_ERROR_CODES,
  MERCARIA_PUBLIC_LIST_MAX_OFFSET,
  MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT,
  MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
  MERCARIA_REF_KINDS,
  MercariaCollectionPageSchema,
  MercariaCollectionRefSchema,
  MercariaCollectionSchema,
  MercariaErrorBodySchema,
  MercariaPageQuerySchema,
  MercariaProductRefSchema,
  MercariaProductSchema,
  MercariaProductSearchQuerySchema,
  MercariaProductSummaryPageSchema,
  MercariaRefSchema,
  MercariaStoreLookupQuerySchema,
  MercariaStoreProductsQuerySchema,
  MercariaStoreRefSchema,
  MercariaStoreSchema,
  MercariaVariantRefSchema,
  classifyRequestIssues,
} from '@mercaria/contracts';

export type {
  MercariaCollection,
  MercariaCollectionRef,
  MercariaErrorDetails,
  MercariaImage,
  MercariaMoney,
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
} from '@mercaria/contracts';

export type { ConditionGroup, CurrencyCode, ItemConditionKey } from '@mercaria/shared-types';
