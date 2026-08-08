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

import type { CurrencyCode, ModerationEnforcementMode } from '@mercaria/shared-types';
import { log } from '../lib/logger.js';

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
 * Parse a finite floating-point environment variable, falling back to
 * `fallback` when the variable is unset, empty, or not a finite number. Used
 * for decimal tunables (e.g. FX rates like `0.49`) that `intEnv` would truncate.
 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a string environment variable, falling back to `fallback` when the
 * variable is unset or empty after trimming. Returns the TRIMMED value.
 */
function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw.trim();
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

/** The FX rate provider strategy. */
type FxProviderName = 'faircoin_explorer' | 'static';

/** The two valid FX provider identifiers, used to validate the env value. */
const FX_PROVIDERS: readonly FxProviderName[] = ['faircoin_explorer', 'static'];

/**
 * Resolve the configured FX provider. Defaults to the live FairCoin Explorer in
 * production and the static dev fallback otherwise (mirrors `mockPayEnabled`).
 * An explicitly-set but invalid `FX_PROVIDER` falls back to the default rather
 * than throwing at import time.
 */
function resolveFxProvider(): FxProviderName {
  const fallback: FxProviderName =
    process.env.NODE_ENV === 'production' ? 'faircoin_explorer' : 'static';
  const raw = process.env.FX_PROVIDER?.trim();
  if (!raw) {
    return fallback;
  }
  return FX_PROVIDERS.includes(raw as FxProviderName) ? (raw as FxProviderName) : fallback;
}

/** How much of an enforcement plan is allowed to actually happen. */
const ENFORCEMENT_MODES: readonly ModerationEnforcementMode[] = [
  'observe',
  'manual',
  'automatic',
];

/**
 * Resolve the enforcement mode, defaulting to the mode that changes nothing.
 *
 * An unrecognised value falls back to `observe` rather than throwing: a typo in a
 * deploy variable must not be able to turn enforcement UP, and it must not take
 * the API down either.
 */
function resolveEnforcementMode(): ModerationEnforcementMode {
  const raw = process.env.CROWDSOURCE_ENFORCEMENT_MODE?.trim();
  if (!raw) return 'observe';
  return ENFORCEMENT_MODES.includes(raw as ModerationEnforcementMode)
    ? (raw as ModerationEnforcementMode)
    : 'observe';
}

/**
 * Whether the CrowdSource integration is switched on.
 *
 * Requires BOTH halves of the round trip. A deployment with a service key and no
 * webhook secret sends reports that can never come back — cases open, juries
 * decide, and Mercaria never learns the outcome. That is worse than being off,
 * because it consumes real reviewers' time, so a half-configured integration is
 * treated as not configured and says so once at boot.
 *
 * The gate is on the DISPATCHER, never on intake. Reports taken while this is
 * false still get their outbox row, so switching it on delivers the backlog
 * rather than stranding it.
 */
function resolveCrowdSourceEnabled(): boolean {
  if (!boolEnv('CROWDSOURCE_ENABLED', false)) return false;

  const hasServiceKey = (process.env.CROWDSOURCE_SERVICE_KEY?.trim() ?? '') !== '';
  const hasWebhookSecret = (process.env.CROWDSOURCE_WEBHOOK_SECRET?.trim() ?? '') !== '';
  if (hasServiceKey && hasWebhookSecret) return true;

  const missing = [
    hasServiceKey ? undefined : 'CROWDSOURCE_SERVICE_KEY',
    hasWebhookSecret ? undefined : 'CROWDSOURCE_WEBHOOK_SECRET',
  ].filter((name): name is string => name !== undefined);
  log.general.error(
    { missing },
    '[CrowdSource] CROWDSOURCE_ENABLED is set but the integration is incomplete; ' +
      'staying OFF. Reports are still stored and will deliver once configured.',
  );
  return false;
}

export interface WebConfig {
  /**
   * The storefront origin, used to build permalinks.
   *
   * A permalink is where MERCARIA's own users see an object — it is provenance on
   * the case, and no jury client ever fetches it. That is the whole reason
   * evidence carries bare Oxy file ids instead: a reviewer's browser resolving a
   * URL on this host would tell the host when its content is under review.
   */
  readonly origin: string;
}

export interface CrowdSourceConfig {
  /** Whether the outbox dispatcher delivers. Never gates the durable record. */
  readonly enabled: boolean;
  /**
   * `applicationId:credentialId:secret` — ONE opaque value, parsed by the SDK.
   *
   * There is deliberately no `CROWDSOURCE_APP_ID` here or anywhere else, and
   * adding one would be a security regression rather than a convenience.
   * `applicationId` is read OFF this credential; a separate variable holding it
   * could only ever disagree with the credential, and any surface able to carry
   * an `applicationId` independently is the cross-tenant IDOR the tenancy model
   * exists to prevent.
   */
  readonly serviceKey: string;
  /** Optional override; the SDK defaults to the one deployment. */
  readonly baseUrl?: string;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly enforcementMode: ModerationEnforcementMode;
}

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

export interface FxConfig {
  /**
   * Which rate provider to use. `'faircoin_explorer'` hits the live FairCoin
   * Explorer (FAIR→USD only); `'static'` uses the env-configured `staticRates`.
   */
  readonly provider: FxProviderName;
  /** TTL (seconds) the resolved rates are cached for (Redis + in-process). */
  readonly cacheTtlSeconds: number;
  /** Base URL of the FairCoin Explorer (the `/api/price` endpoint is appended). */
  readonly faircoinExplorerBaseUrl: string;
  /** Per-request timeout (ms) for the upstream provider fetch. */
  readonly requestTimeoutMs: number;
  /**
   * Dev/last-resort fallback rates: how many fiat units ONE FAIR is worth
   * (`1 FAIR = staticRates[X]` of currency X). FAIR→FAIR is always 1 and is
   * never stored here. Keyed by the non-FAIR `CurrencyCode`s.
   */
  readonly staticRates: Readonly<Partial<Record<Exclude<CurrencyCode, 'FAIR'>, number>>>;
}

export interface PostgresConfig {
  /**
   * `DATABASE_URL`. ABSENT means "Postgres is not configured here", not "this
   * deployment is broken".
   *
   * Mercaria is mid-migration from MongoDB: Mongo is still the store every
   * request reads and writes, and a task with no `DATABASE_URL` must boot and
   * serve exactly as it does today. `connectPostgres()` is the only thing that
   * requires it, and it is called by nothing yet — so this stays optional until
   * the cutover, at which point it becomes required and this comment goes away.
   */
  readonly url?: string;
  /** postgres.js pool ceiling per task. */
  readonly maxPoolSize: number;
  /** Seconds an idle pooled connection is kept before being closed. */
  readonly idleTimeoutSeconds: number;
  /** Seconds to wait for a new connection before failing the query. */
  readonly connectTimeoutSeconds: number;
  /**
   * Seconds a connection may live before being recycled. Bounded so a pool
   * behind a load balancer (RDS Proxy, a failover) cannot pin itself to a
   * retired endpoint indefinitely.
   */
  readonly maxLifetimeSeconds: number;
}

export interface AppConfig {
  readonly pagination: PaginationConfig;
  readonly catalog: CatalogConfig;
  readonly feed: FeedConfig;
  readonly cart: CartConfig;
  readonly orders: OrdersConfig;
  readonly fx: FxConfig;
  readonly web: WebConfig;
  readonly crowdSource: CrowdSourceConfig;
  readonly postgres: PostgresConfig;
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
  fx: Object.freeze({
    provider: resolveFxProvider(),
    cacheTtlSeconds: intEnv('FX_CACHE_TTL_SECONDS', 300),
    faircoinExplorerBaseUrl: strEnv('FX_FAIRCOIN_EXPLORER_BASE_URL', 'https://explorer.fairco.in'),
    requestTimeoutMs: intEnv('FX_REQUEST_TIMEOUT_MS', 5_000),
    // Dev / last-resort fallback rates (how many units of the currency ONE FAIR
    // is worth). The live provider ONLY yields FAIR→USD, so every other quote is
    // served from here. These defaults are the FAIR→USD anchor (~0.49) times an
    // approximate USD→currency rate — good enough for dev and a graceful
    // degraded fallback, but PRODUCTION MUST supply a real multi-currency FX
    // source (override each `FX_STATIC_RATE_*`, or add a multi-fiat provider);
    // do not trust these frozen approximations for real presentment.
    staticRates: Object.freeze({
      USD: numEnv('FX_STATIC_RATE_USD', 0.49),
      EUR: numEnv('FX_STATIC_RATE_EUR', 0.45),
      GBP: numEnv('FX_STATIC_RATE_GBP', 0.39),
      CAD: numEnv('FX_STATIC_RATE_CAD', 0.67),
      AUD: numEnv('FX_STATIC_RATE_AUD', 0.75),
      JPY: numEnv('FX_STATIC_RATE_JPY', 73.5),
      CHF: numEnv('FX_STATIC_RATE_CHF', 0.43),
      CNY: numEnv('FX_STATIC_RATE_CNY', 3.53),
      SEK: numEnv('FX_STATIC_RATE_SEK', 5.15),
      NOK: numEnv('FX_STATIC_RATE_NOK', 5.24),
      DKK: numEnv('FX_STATIC_RATE_DKK', 3.38),
      PLN: numEnv('FX_STATIC_RATE_PLN', 1.96),
      MXN: numEnv('FX_STATIC_RATE_MXN', 8.3),
      BRL: numEnv('FX_STATIC_RATE_BRL', 2.45),
      INR: numEnv('FX_STATIC_RATE_INR', 40.7),
      NZD: numEnv('FX_STATIC_RATE_NZD', 0.81),
      ZAR: numEnv('FX_STATIC_RATE_ZAR', 9.07),
      SGD: numEnv('FX_STATIC_RATE_SGD', 0.66),
      HKD: numEnv('FX_STATIC_RATE_HKD', 3.82),
      AED: numEnv('FX_STATIC_RATE_AED', 1.80),
    }),
  }),
  web: Object.freeze({
    origin: strEnv('WEB_URL', 'https://mercaria.co'),
  }),
  crowdSource: Object.freeze({
    enabled: resolveCrowdSourceEnabled(),
    serviceKey: strEnv('CROWDSOURCE_SERVICE_KEY', ''),
    ...(process.env.CROWDSOURCE_BASE_URL?.trim()
      ? { baseUrl: process.env.CROWDSOURCE_BASE_URL.trim() }
      : {}),
    outboxBatchSize: intEnv('CROWDSOURCE_OUTBOX_BATCH_SIZE', 50),
    outboxPollIntervalMs: intEnv('CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS', 5_000),
    enforcementMode: resolveEnforcementMode(),
  }),
  postgres: Object.freeze({
    // Spread-when-present, like `crowdSource.baseUrl` above: the property is
    // ABSENT rather than an empty string, so `if (!config.postgres.url)` reads
    // as "not configured" and no caller can mistake `''` for a URL.
    ...(process.env.DATABASE_URL?.trim() ? { url: process.env.DATABASE_URL.trim() } : {}),
    maxPoolSize: intEnv('PG_MAX_POOL_SIZE', 20),
    idleTimeoutSeconds: intEnv('PG_IDLE_TIMEOUT_SECONDS', 30),
    connectTimeoutSeconds: intEnv('PG_CONNECT_TIMEOUT_SECONDS', 10),
    maxLifetimeSeconds: intEnv('PG_MAX_LIFETIME_SECONDS', 1_800),
  }),
});
