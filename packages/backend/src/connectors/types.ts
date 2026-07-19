/**
 * Connector platform — the provider contract.
 *
 * A `ConnectorProvider` is ONE external commerce platform (Shopify first;
 * WooCommerce / Etsy / … follow as additional implementations behind this same
 * interface). The registry (`registry.ts`) resolves an id to its provider and
 * the sync service (`services/connector-sync.service.ts`) drives the provider
 * without knowing which platform it is talking to.
 *
 * A provider is responsible ONLY for talking to its platform and mapping the
 * platform's product shape into the platform-neutral `NormalizedProduct`. It
 * never touches Mercaria models — the sync service owns the write path (through
 * the `catalog-write.service` funnels) and all provenance/override bookkeeping.
 */

import type {
  AddressSnapshot,
  ConnectorProviderId,
  CurrencyCode,
  DualMoney,
  FxRateSnapshot,
  Money,
  OrderStatus,
  PaymentInfo,
} from '@mercaria/shared-types';

/**
 * Credential material a provider presents to authenticate against the external
 * platform. `accessToken` is the decrypted OAuth token (or API key); `shopDomain`
 * is the external shop host (`acme.myshopify.com`). This is the shape the sync
 * service reconstructs from a stored `Connection` (decrypting the token) for the
 * VERIFY / EXCHANGE steps, before the shop currency is known.
 */
export interface ConnectorAuth {
  /** The platform access token (OAuth) or API key — already decrypted. */
  accessToken: string;
  /** External shop host, e.g. `acme.myshopify.com`. */
  shopDomain: string;
}

/**
 * Full credentials for the DATA path (`fetchProducts`). Extends {@link ConnectorAuth}
 * with the shop's resolved Mercaria `CurrencyCode` so the provider can stamp
 * every pulled price in the shop's native currency (Mercaria stores native — no
 * FAIR conversion on the write side).
 */
export interface ConnectorCredentials extends ConnectorAuth {
  /** The shop's settlement currency, validated to a supported `CurrencyCode`. */
  shopCurrency: CurrencyCode;
}

/** The external shop's identity, as reported by the platform. */
export interface ShopIdentity {
  /** The platform's own shop id. */
  externalShopId: string;
  /** The canonical external shop host (`acme.myshopify.com`). */
  shopDomain: string;
  /**
   * The shop's currency as reported by the platform (raw ISO-4217 string). It may
   * be OUTSIDE Mercaria's supported `CurrencyCode` set — the sync service is the
   * one place that validates/maps it before any product is priced.
   */
  shopCurrency: string;
}

/** The result of exchanging an OAuth authorization code for an access token. */
export interface ExchangeResult extends ShopIdentity {
  /** The granted access token to persist (encrypted). */
  accessToken: string;
  /** The scopes the platform actually granted. */
  scopes: string[];
}

/** A single normalized variant, priced in the shop's native currency. */
export interface NormalizedVariant {
  /** Option-value assignments defining the variant (e.g. `[{Size, M}]`). */
  optionValues: { name: string; value: string }[];
  /** Selling price in the shop's native currency (integer minor units). */
  price: Money;
  /** Optional "compare at" (was) price, same currency. */
  compareAtPrice?: Money;
  /** Stock-keeping unit, when the platform provides one. */
  sku?: string;
  /** Barcode (UPC/EAN/ISBN, …), when provided. */
  barcode?: string;
  /** The platform's own variant id, when provided (stored as variant provenance). */
  externalVariantId?: string;
  /**
   * The platform's inventory-item id, when provided — the key of an inventory-level
   * update. Persisted on the Mercaria variant so the inventory sync (pull job +
   * `inventory_levels/update` webhook) maps a platform item id back to the variant.
   */
  externalInventoryItemId?: string;
  /** Inventory snapshot for this variant. */
  inventory: {
    /** Whether the platform tracks stock for this variant. */
    tracked: boolean;
    /** Units available (never negative). */
    available: number;
  };
}

/**
 * A platform-neutral product, the shape the sync service maps into
 * `CreateStoreProductInput`. `externalId` + `externalUpdatedAt` carry the
 * provenance used for upsert-by-external-key and newer-than checks.
 *
 * Images are ABSOLUTE platform CDN URLs — Mercaria's media chokepoint
 * (`resolveMedia`) passes absolute http(s) URLs through unchanged, so they are
 * stored as image "file ids" verbatim (no re-upload).
 */
export interface NormalizedProduct {
  /** The product's id on the external platform (upsert key with the connection). */
  externalId: string;
  /** The platform's `updated_at` for the product, when available. */
  externalUpdatedAt?: Date;
  /** Product title. */
  title: string;
  /** Product description (may contain HTML from the source platform). */
  description: string;
  /** URL-safe handle, when the platform provides one. */
  handle?: string;
  /** Manufacturer / brand. */
  vendor?: string;
  /** Merchandising product type. */
  productType?: string;
  /** Selectable options and their values (empty for single-variant products). */
  options: { name: string; values: string[] }[];
  /** Absolute image URLs (platform CDN), in gallery order. */
  imageUrls: string[];
  /**
   * The external collection ids/handles this product belongs to on the platform,
   * when the payload carries membership. The sync service maps these through the
   * connection's `collectionMapping` onto Mercaria `collectionIds`. NOTE: a
   * platform whose product payload omits collection membership (Shopify's REST
   * `products.json` does) leaves this empty — the mapping is a no-op then, and the
   * logic is provider-agnostic for platforms/payloads that DO carry it.
   */
  collectionRefs?: string[];
  /** Concrete variants (always ≥ 1). */
  variants: NormalizedVariant[];
  /** SEO overrides, when the platform exposes them. */
  seo?: { title?: string; description?: string };
}

/**
 * A platform-neutral inventory level: the total units available for one external
 * inventory item, SUMMED across every platform location (a single Mercaria target
 * location mirrors the shop-wide sellable total). `externalInventoryItemId` is the
 * key the sync service maps back to a Mercaria variant (via the variant's stored
 * `source.externalInventoryItemId`).
 */
export interface NormalizedInventoryLevel {
  /** The platform's inventory-item id (maps to a connector-sourced variant). */
  externalInventoryItemId: string;
  /** Total units available across the platform's locations (never negative). */
  available: number;
}

// --- PUSH (Mercaria → platform) ---------------------------------------------

/** One variant of a product being PUSHED out to an external platform. */
export interface PushVariant {
  /** Option-value assignments defining the variant (empty for single-variant). */
  optionValues: { name: string; value: string }[];
  /** Selling price in the listing's native currency (integer minor units). */
  price: Money;
  /** Optional "compare at" (was) price, same currency. */
  compareAtPrice?: Money;
  /** Stock-keeping unit, when set. */
  sku?: string;
  /** Barcode (UPC/EAN/ISBN, …), when set. */
  barcode?: string;
  /** Inventory snapshot for this variant. */
  inventory: {
    /** Whether Mercaria tracks stock for this variant. */
    tracked: boolean;
    /** Units available (never negative). */
    available: number;
  };
}

/**
 * A platform-neutral product being PUSHED to an external platform, built by the
 * sync service from a Mercaria `Listing` + its variants. `externalId` is present
 * only on an UPDATE (a listing already mapped to this connection) — its absence
 * means CREATE. Images are absolute URLs (only publicly-fetchable URLs are pushed).
 */
export interface PushProduct {
  /** The product's existing id on the platform; absent → create a new product. */
  externalId?: string;
  /** Product title. */
  title: string;
  /** Product description (HTML allowed). */
  description: string;
  /** Publish state to request on the platform. */
  status: 'active' | 'draft';
  /** URL-safe handle, when set. */
  handle?: string;
  /** Manufacturer / brand, when set. */
  vendor?: string;
  /** Merchandising product type, when set. */
  productType?: string;
  /** Selectable options and their values (empty for single-variant products). */
  options: { name: string; values: string[] }[];
  /** Absolute, publicly-fetchable image URLs, in gallery order. */
  imageUrls: string[];
  /** Concrete variants (always ≥ 1). */
  variants: PushVariant[];
  /** SEO overrides, when set. */
  seo?: { title?: string; description?: string };
}

/** The result of pushing a product: the platform id to persist as the mapping. */
export interface PushProductResult {
  /** The product's id on the external platform (create → new; update → same). */
  externalId: string;
}

/**
 * A fulfillment being PUSHED to an external platform: mark the mapped external
 * order fulfilled/shipped, attaching a tracking number when Mercaria captured one.
 * Line-level (partial) fulfillment is a deferred edge — the core marks the whole
 * order fulfilled.
 */
export interface PushFulfillment {
  /** The platform's order id (the connector order's `source.externalId`). */
  externalOrderId: string;
  /** Tracking number to attach, when Mercaria has one. */
  trackingNumber?: string;
}

// --- ORDERS (platform → Mercaria) -------------------------------------------

/** One line of an order pulled from an external platform. */
export interface NormalizedOrderLine {
  /** Line/product title at purchase time. */
  title: string;
  /** Variant title at purchase time (e.g. `Size / M`). */
  variantTitle: string;
  /** Quantity ordered. */
  quantity: number;
  /** Unit price, in shop + presentment currency. */
  unitPrice: DualMoney;
  /** `unitPrice * quantity`, in shop + presentment currency. */
  lineTotal: DualMoney;
  /** The platform's product id for the line, when provided. */
  externalProductId?: string;
  /** The platform's variant id for the line, when provided. */
  externalVariantId?: string;
  /** SKU, when provided. */
  sku?: string;
}

/** The buyer/customer attached to a pulled order, when the platform provides one. */
export interface NormalizedOrderCustomer {
  /** The platform's customer id, when provided. */
  externalId?: string;
  /** Customer email, when provided. */
  email?: string;
  /** Customer display name, when provided. */
  name?: string;
}

/**
 * A platform-neutral order, the shape the sync service upserts into a Mercaria
 * `Order`. `externalId` + `externalUpdatedAt` carry the provenance used for the
 * idempotent upsert-by-external-key. Every money field is a `DualMoney` — `shop`
 * is the store's settlement currency, `presentment` what the buyer paid.
 */
export interface NormalizedOrder {
  /** The order's id on the external platform (upsert key with the connection). */
  externalId: string;
  /** The platform's `updated_at` for the order, when available. */
  externalUpdatedAt?: Date;
  /** The platform's human order number/name (e.g. `#1001`), when provided. */
  externalNumber?: string;
  /** The platform's order creation time, when provided. */
  createdAt?: Date;
  /** The Mercaria lifecycle status mapped from the platform's order state. */
  status: OrderStatus;
  /** The Mercaria payment status mapped from the platform's financial state. */
  paymentStatus: PaymentInfo['status'];
  /** The store's settlement currency for this order (the connection's shop currency). */
  shopCurrency: CurrencyCode;
  /** The buyer's presentment currency (falls back to the shop currency). */
  presentmentCurrency: CurrencyCode;
  /** The shop→presentment rate snapshot, when the two currencies differ. */
  fxRate?: FxRateSnapshot;
  /** Concrete order lines (always ≥ 1). */
  lines: NormalizedOrderLine[];
  /** Order money totals, each in shop + presentment currency. */
  totals: {
    subtotal: DualMoney;
    discountTotal: DualMoney;
    tax: DualMoney;
    shipping: DualMoney;
    grandTotal: DualMoney;
  };
  /** The buyer/customer, when the platform provides one. */
  customer?: NormalizedOrderCustomer;
  /** The shipping destination, when the platform provides a usable address. */
  shippingAddress?: AddressSnapshot;
}

/**
 * A single external-commerce platform. One implementation per platform; the
 * registry maps a {@link ConnectorProviderId} to its instance.
 */
export interface ConnectorProvider {
  /** The platform this provider talks to. */
  readonly id: ConnectorProviderId;
  /** How the platform is authorized: an OAuth app or a static API key/secret. */
  readonly credentialStrategy: 'oauth' | 'api_key';

  /**
   * Build the platform's OAuth authorize URL the merchant's browser is sent to.
   * `state` is an opaque, server-signed CSRF token the callback re-validates.
   */
  buildAuthorizeUrl(params: {
    shopDomain: string;
    redirectUri: string;
    state: string;
    scopes: string[];
  }): string;

  /**
   * Exchange an OAuth authorization `code` for an access token, and enrich it
   * with the shop's identity (id + canonical domain + currency).
   */
  exchangeCode(params: {
    shopDomain: string;
    code: string;
    redirectUri: string;
  }): Promise<ExchangeResult>;

  /** Verify credentials by fetching the shop's identity from the platform. */
  verifyConnection(auth: ConnectorAuth): Promise<ShopIdentity>;

  /**
   * Fetch one page of products. `cursor` is the opaque pagination token returned
   * as `nextCursor` by the previous call (absent on the first page). The returned
   * `nextCursor` is absent on the last page.
   */
  fetchProducts(
    creds: ConnectorCredentials,
    cursor?: string,
  ): Promise<{ products: NormalizedProduct[]; nextCursor?: string }>;

  /**
   * Map ONE raw platform product into a {@link NormalizedProduct}, pricing every
   * variant in `shopCurrency` (the shop's validated native currency).
   */
  normalizeProduct(raw: unknown, shopCurrency: CurrencyCode): NormalizedProduct;

  /**
   * PUSH a product to the platform: CREATE when `product.externalId` is absent,
   * or UPDATE the mapped external product when present. Returns the platform id to
   * persist as the connection mapping (`Listing.externalRefs`).
   */
  pushProduct(auth: ConnectorAuth, product: PushProduct): Promise<PushProductResult>;

  /**
   * Fetch one page of orders. `cursor` is the opaque pagination token returned as
   * `nextCursor` by the previous call (absent on the first page); the returned
   * `nextCursor` is absent on the last page. Every money field is priced in
   * `creds.shopCurrency` (`shop`) + the order's presentment currency.
   */
  fetchOrders(
    creds: ConnectorCredentials,
    cursor?: string,
  ): Promise<{ orders: NormalizedOrder[]; nextCursor?: string }>;

  /**
   * Map ONE raw platform order (an `orders/*` webhook payload, or a page entry)
   * into a {@link NormalizedOrder}. `shopCurrency` is the connection's validated
   * settlement currency; the presentment side is read from the order when the
   * platform reports it, else falls back to the shop currency.
   */
  normalizeOrder(raw: unknown, shopCurrency: CurrencyCode): NormalizedOrder;

  /**
   * Fetch the current inventory levels for the given external inventory-item ids,
   * each summed across the platform's locations. The provider batches internally to
   * respect the platform's per-request id cap. Returns one entry per item that the
   * platform reports a level for (items with no level are omitted). Used by the
   * inventory pull job and the `inventory_levels/update` webhook.
   */
  fetchInventory(
    auth: ConnectorAuth,
    params: { inventoryItemIds: string[] },
  ): Promise<NormalizedInventoryLevel[]>;

  /**
   * PUSH a fulfillment to the platform for a connector order that Mercaria has
   * fulfilled/shipped. Idempotent: when the external order has no open fulfillment
   * work left (already fulfilled), it is a no-op. Attaches tracking when present.
   */
  pushFulfillment(auth: ConnectorAuth, fulfillment: PushFulfillment): Promise<void>;

  /**
   * Register the provider's product webhooks (create/update/delete) pointing at
   * `address` (the public inbound-webhook URL). Returns the platform's ids for the
   * created subscriptions, to persist on the `Connection` and delete on
   * disconnect. The set of topics is the provider's own concern.
   */
  registerWebhooks(auth: ConnectorAuth, params: { address: string }): Promise<string[]>;

  /**
   * Delete the given webhook subscriptions by their platform ids. Idempotent: an
   * already-absent subscription is treated as success (not an error).
   */
  deleteWebhooks(auth: ConnectorAuth, webhookIds: string[]): Promise<void>;
}
