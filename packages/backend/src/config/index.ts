/**
 * Application configuration.
 *
 * A typed, frozen object of tunables read from the environment with sane
 * defaults. Every magic number used by the marketplace domain lives here so it
 * can be adjusted per-deployment via env vars without touching code.
 *
 * Values are read ONCE at module load. The object (and its nested groups) is
 * deeply frozen so no code can mutate config at runtime.
 */

/**
 * Parse an integer environment variable, falling back to `fallback` when the
 * variable is unset, empty, or not a finite integer.
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a boolean environment variable. Truthy values are `1`, `true`, `yes`
 * and `on` (case-insensitive); everything else (including unset) yields
 * `fallback`.
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const MINUTE_MS = 60_000;

export interface PaginationConfig {
  /** Default page size when the client does not specify a `limit`. */
  readonly defaultPageSize: number;
  /** Hard upper bound on `limit`; larger requests are clamped to this. */
  readonly maxPageSize: number;
}

export interface CatalogConfig {
  /** Maximum number of variants a single product (Listing) may have. */
  readonly maxVariantsPerProduct: number;
  /** Maximum number of gallery images a single listing may have. */
  readonly maxImagesPerListing: number;
}

export interface FeedConfig {
  /** TTL (seconds) of the assembled home feed cached in Redis. */
  readonly cacheTtlSeconds: number;
  /** Number of products in the "New arrivals" shelf. */
  readonly newArrivalsSize: number;
  /** Number of products in the "On sale" shelf. */
  readonly onSaleSize: number;
  /** Number of stores in the "Worth the hype" merchant shelf. */
  readonly merchantsSize: number;
  /** Number of top-level categories shown in the "Shop by category" shelf. */
  readonly categoriesSize: number;
  /** Number of subcategory tiles shown per category card (2×2 grid). */
  readonly categoryTilesPerCard: number;
  /** Number of thumbnails shown on a store/merchant card. */
  readonly storeCardThumbnails: number;
}

export interface CartConfig {
  /**
   * Hard upper bound on the quantity of a single variant a cart line may hold.
   * Untracked variants (no inventory ceiling) are clamped to this; tracked
   * variants are additionally clamped to their live `available`.
   */
  readonly maxQuantityPerItem: number;
}

export interface OrdersConfig {
  /**
   * How long an inventory reservation (a `pending_payment` order) is held
   * before the maintenance job may expire it and release the stock.
   */
  readonly reservationTtlMs: number;
  /**
   * Whether the test-only mock-pay endpoint is enabled. Off in production.
   */
  readonly mockPayEnabled: boolean;
  /**
   * Flat shipping cost (integer minor units) for each shipping method, added to
   * the order subtotal at checkout.
   */
  readonly shippingRates: {
    /** Cost of standard shipping. */
    readonly standard: number;
    /** Cost of express shipping. */
    readonly express: number;
    /** Cost of pickup (typically free). */
    readonly pickup: number;
  };
  /**
   * TTL of a checkout idempotency claim in Redis. A replayed checkout within
   * this window returns the original orders instead of creating duplicates.
   */
  readonly idempotencyTtlMs: number;
  /**
   * `available` at or below which a tracked variant counts as "low stock" for
   * the store dashboard's low-stock metric.
   */
  readonly lowStockThreshold: number;
}

export interface AppConfig {
  readonly pagination: PaginationConfig;
  readonly catalog: CatalogConfig;
  readonly feed: FeedConfig;
  readonly cart: CartConfig;
  readonly orders: OrdersConfig;
}

/**
 * The single, frozen application config. Import this everywhere instead of
 * inlining magic numbers or reading `process.env` directly for tunables.
 */
export const config: AppConfig = Object.freeze({
  pagination: Object.freeze({
    defaultPageSize: intEnv('PAGE_SIZE_DEFAULT', 20),
    maxPageSize: intEnv('PAGE_SIZE_MAX', 100),
  }),
  catalog: Object.freeze({
    maxVariantsPerProduct: intEnv('MAX_VARIANTS_PER_PRODUCT', 100),
    maxImagesPerListing: intEnv('MAX_IMAGES_PER_LISTING', 12),
  }),
  feed: Object.freeze({
    cacheTtlSeconds: intEnv('FEED_CACHE_TTL_SECONDS', 60),
    newArrivalsSize: intEnv('FEED_NEW_ARRIVALS_SIZE', 12),
    onSaleSize: intEnv('FEED_ON_SALE_SIZE', 12),
    merchantsSize: intEnv('FEED_MERCHANTS_SIZE', 8),
    categoriesSize: intEnv('FEED_CATEGORIES_SIZE', 8),
    categoryTilesPerCard: intEnv('FEED_CATEGORY_TILES_PER_CARD', 4),
    storeCardThumbnails: intEnv('FEED_STORE_CARD_THUMBNAILS', 3),
  }),
  cart: Object.freeze({
    maxQuantityPerItem: intEnv('CART_MAX_QUANTITY_PER_ITEM', 99),
  }),
  orders: Object.freeze({
    reservationTtlMs: intEnv('RESERVATION_TTL_MS', 15 * MINUTE_MS),
    mockPayEnabled:
      process.env.NODE_ENV === 'production' ? false : boolEnv('MOCK_PAY_ENABLED', true),
    shippingRates: Object.freeze({
      standard: intEnv('SHIPPING_RATE_STANDARD', 500),
      express: intEnv('SHIPPING_RATE_EXPRESS', 1500),
      pickup: intEnv('SHIPPING_RATE_PICKUP', 0),
    }),
    idempotencyTtlMs: intEnv('CHECKOUT_IDEMPOTENCY_TTL_MS', 10 * MINUTE_MS),
    lowStockThreshold: intEnv('LOW_STOCK_THRESHOLD', 5),
  }),
});
