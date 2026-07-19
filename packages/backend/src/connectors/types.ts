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

import type { ConnectorProviderId, CurrencyCode, Money } from '@mercaria/shared-types';

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
  /** Concrete variants (always ≥ 1). */
  variants: NormalizedVariant[];
  /** SEO overrides, when the platform exposes them. */
  seo?: { title?: string; description?: string };
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
