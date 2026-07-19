/**
 * Shopify connector provider (REST Admin API `2024-10`).
 *
 * OAuth: `buildAuthorizeUrl` → merchant authorizes → the public callback calls
 * `exchangeCode` (POST `/admin/oauth/access_token`) to obtain the access token,
 * then enriches it with the shop identity via `verifyConnection`. The DATA path
 * (`verifyConnection`, `fetchProducts`) hits the REST Admin API with an
 * `X-Shopify-Access-Token` header and paginates via the `Link` header's
 * `page_info` cursor.
 *
 * ALL network I/O goes through the injected {@link ShopifyTransport}, which is
 * SSRF-guarded (`*.myshopify.com` allowlist + `@oxyhq/core/server` primitives).
 * The transport is injectable so the provider is unit-testable without Shopify.
 * `normalizeProduct` is a PURE mapping (Shopify JSON → `NormalizedProduct`),
 * pricing every variant in the shop's native currency (no FAIR conversion).
 */

import { z } from 'zod';
import { CURRENCY_PRECISION, type CurrencyCode, type Money } from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  ConnectorProvider,
  ExchangeResult,
  NormalizedProduct,
  NormalizedVariant,
  ShopIdentity,
} from '../types.js';
import { getShopifyCredentials } from './config.js';
import { shopifyTransport, type ShopifyHttpResponse, type ShopifyTransport } from './http.js';

/** The pinned Shopify Admin API version. */
const API_VERSION = '2024-10';
/** Max products per page (Shopify's REST ceiling). */
const PAGE_LIMIT = 250;
/**
 * Product webhook topics registered on connect for near-real-time sync. Delete is
 * an ARCHIVE in Mercaria (never a hard-delete) — see the connector-sync service.
 */
const PRODUCT_WEBHOOK_TOPICS = ['products/create', 'products/update', 'products/delete'] as const;
/** Shopify's placeholder option name for products with no real options. */
const DEFAULT_OPTION_NAME = 'title';
/** Shopify's placeholder single-variant value. */
const DEFAULT_OPTION_VALUE = 'Default Title';

// --- Shopify response schemas (only the fields we consume; extras are ignored) ---

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
});

const shopSchema = z.object({
  shop: z.object({
    id: z.union([z.number(), z.string()]),
    myshopify_domain: z.string().optional(),
    currency: z.string().min(1),
  }),
});

const shopifyOptionSchema = z.object({
  name: z.string(),
  values: z.array(z.string()).default([]),
});

const shopifyVariantSchema = z.object({
  id: z.union([z.number(), z.string()]),
  price: z.string(),
  compare_at_price: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  inventory_quantity: z.number().optional(),
  inventory_management: z.string().nullable().optional(),
  option1: z.string().nullable().optional(),
  option2: z.string().nullable().optional(),
  option3: z.string().nullable().optional(),
});

const shopifyImageSchema = z.object({ src: z.string() });

const shopifyProductSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  body_html: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  handle: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  options: z.array(shopifyOptionSchema).default([]),
  images: z.array(shopifyImageSchema).default([]),
  variants: z.array(shopifyVariantSchema).default([]),
});

const productsResponseSchema = z.object({
  products: z.array(shopifyProductSchema).default([]),
});

const webhookResponseSchema = z.object({
  webhook: z.object({ id: z.union([z.number(), z.string()]) }),
});

type ShopifyVariant = z.infer<typeof shopifyVariantSchema>;
type ShopifyProduct = z.infer<typeof shopifyProductSchema>;

/**
 * Parse a Shopify decimal price string (major units, e.g. `"19.99"`) into integer
 * minor units for `currency`, using pure integer/string math (never a float, so
 * `"19.99"` is exactly `1999`). Extra fraction digits beyond the currency's
 * precision are rounded half-up. Throws on a malformed or unsafe value.
 */
function decimalStringToMinor(value: string, currency: CurrencyCode): number {
  const precision = CURRENCY_PRECISION[currency];
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw validationError(`Cannot parse Shopify price "${value}" for ${currency}`);
  }
  const [intPart, fracRaw = ''] = trimmed.split('.');
  const fracForPrecision = fracRaw.slice(0, precision).padEnd(precision, '0');
  let minor = Number(intPart) * 10 ** precision + Number(fracForPrecision || '0');
  if (fracRaw.length > precision && Number(fracRaw[precision]) >= 5) {
    minor += 1;
  }
  if (!Number.isSafeInteger(minor)) {
    throw validationError(`Shopify price "${value}" exceeds the safe integer range`);
  }
  return minor;
}

/** True when a product's options are Shopify's single-variant placeholder. */
function isPlaceholderOptions(options: { name: string; values: string[] }[]): boolean {
  return (
    options.length === 1 &&
    options[0].name.trim().toLowerCase() === DEFAULT_OPTION_NAME &&
    options[0].values.length === 1 &&
    options[0].values[0] === DEFAULT_OPTION_VALUE
  );
}

/** Pull a variant's option values (option1..3) paired with the product option names. */
function variantOptionValues(
  variant: ShopifyVariant,
  optionNames: string[],
): { name: string; value: string }[] {
  const rawValues = [variant.option1, variant.option2, variant.option3];
  const pairs: { name: string; value: string }[] = [];
  for (let i = 0; i < optionNames.length; i += 1) {
    const value = rawValues[i];
    if (value !== null && value !== undefined && value !== '') {
      pairs.push({ name: optionNames[i], value });
    }
  }
  return pairs;
}

/** Map one Shopify variant into a `NormalizedVariant` priced in `shopCurrency`. */
function normalizeVariant(
  variant: ShopifyVariant,
  optionNames: string[],
  shopCurrency: CurrencyCode,
): NormalizedVariant {
  const price: Money = {
    amount: decimalStringToMinor(variant.price, shopCurrency),
    currency: shopCurrency,
  };
  const normalized: NormalizedVariant = {
    optionValues: variantOptionValues(variant, optionNames),
    price,
    inventory: {
      tracked: variant.inventory_management != null,
      available: Math.max(0, variant.inventory_quantity ?? 0),
    },
  };
  if (variant.compare_at_price != null && variant.compare_at_price.trim() !== '') {
    normalized.compareAtPrice = {
      amount: decimalStringToMinor(variant.compare_at_price, shopCurrency),
      currency: shopCurrency,
    };
  }
  if (variant.sku != null && variant.sku.trim() !== '') {
    normalized.sku = variant.sku;
  }
  if (variant.barcode != null && variant.barcode.trim() !== '') {
    normalized.barcode = variant.barcode;
  }
  return normalized;
}

/** PURE: map a raw Shopify product into a `NormalizedProduct` in `shopCurrency`. */
export function normalizeShopifyProduct(raw: unknown, shopCurrency: CurrencyCode): NormalizedProduct {
  const parsed = shopifyProductSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(`Malformed Shopify product: ${parsed.error.message}`);
  }
  const product: ShopifyProduct = parsed.data;

  const rawOptions = product.options.map((o) => ({ name: o.name, values: [...o.values] }));
  const placeholder = isPlaceholderOptions(rawOptions);
  const options = placeholder ? [] : rawOptions;
  const optionNames = options.map((o) => o.name);

  const variants = product.variants.map((v) => normalizeVariant(v, optionNames, shopCurrency));
  if (variants.length === 0) {
    throw validationError(`Shopify product ${String(product.id)} has no variants`);
  }

  const normalized: NormalizedProduct = {
    externalId: String(product.id),
    title: product.title,
    description: product.body_html ?? '',
    options,
    imageUrls: product.images.map((img) => img.src),
    variants,
  };
  if (product.updated_at) {
    normalized.externalUpdatedAt = new Date(product.updated_at);
  }
  if (product.handle) {
    normalized.handle = product.handle;
  }
  if (product.vendor && product.vendor.trim() !== '') {
    normalized.vendor = product.vendor;
  }
  if (product.product_type && product.product_type.trim() !== '') {
    normalized.productType = product.product_type;
  }
  return normalized;
}

/** The Shopify Admin API base for a shop. */
function apiBase(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${API_VERSION}`;
}

/** Throw a clear error when a Shopify response is not a 2xx. */
function assertOk(response: ShopifyHttpResponse, context: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw validationError(`Shopify ${context} failed (HTTP ${response.status})`);
  }
}

/** Parse a JSON body or throw a clear error. */
function parseJson(response: ShopifyHttpResponse, context: string): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw validationError(`Shopify ${context} returned a non-JSON body`);
  }
}

/**
 * Extract the `page_info` cursor from a `rel="next"` entry in the `Link` header,
 * or `undefined` when there is no next page.
 */
function nextCursorFromLink(link: string | undefined): string | undefined {
  if (!link) {
    return undefined;
  }
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) {
      const pageInfo = new URL(match[1]).searchParams.get('page_info');
      return pageInfo ?? undefined;
    }
  }
  return undefined;
}

/**
 * Construct a Shopify provider over `transport`. The default transport is the
 * real SSRF-safe one; tests inject a fake to exercise the mapping/paging logic.
 */
export function createShopifyProvider(transport: ShopifyTransport = shopifyTransport): ConnectorProvider {
  async function verifyConnection(auth: ConnectorAuth): Promise<ShopIdentity> {
    const response = await transport.get(`${apiBase(auth.shopDomain)}/shop.json`, {
      'X-Shopify-Access-Token': auth.accessToken,
      Accept: 'application/json',
    });
    assertOk(response, 'shop lookup');
    const parsed = shopSchema.safeParse(parseJson(response, 'shop lookup'));
    if (!parsed.success) {
      throw validationError(`Unexpected Shopify shop payload: ${parsed.error.message}`);
    }
    return {
      externalShopId: String(parsed.data.shop.id),
      shopDomain: parsed.data.shop.myshopify_domain ?? auth.shopDomain,
      shopCurrency: parsed.data.shop.currency,
    };
  }

  return {
    id: 'shopify',
    credentialStrategy: 'oauth',

    buildAuthorizeUrl({ shopDomain, redirectUri, state, scopes }) {
      const { clientId } = getShopifyCredentials();
      const params = new URLSearchParams({
        client_id: clientId,
        scope: scopes.join(','),
        redirect_uri: redirectUri,
        state,
      });
      return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
    },

    async exchangeCode({ shopDomain, code }): Promise<ExchangeResult> {
      const { clientId, clientSecret } = getShopifyCredentials();
      const response = await transport.post(
        `https://${shopDomain}/admin/oauth/access_token`,
        { 'Content-Type': 'application/json', Accept: 'application/json' },
        JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      );
      assertOk(response, 'token exchange');
      const parsed = tokenResponseSchema.safeParse(parseJson(response, 'token exchange'));
      if (!parsed.success) {
        throw validationError(`Unexpected Shopify token payload: ${parsed.error.message}`);
      }

      const identity = await verifyConnection({ accessToken: parsed.data.access_token, shopDomain });
      const grantedScopes = parsed.data.scope
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { ...identity, accessToken: parsed.data.access_token, scopes: grantedScopes };
    },

    verifyConnection,

    async fetchProducts(creds: ConnectorCredentials, cursor?: string) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) {
        params.set('page_info', cursor);
      }
      const response = await transport.get(
        `${apiBase(creds.shopDomain)}/products.json?${params.toString()}`,
        { 'X-Shopify-Access-Token': creds.accessToken, Accept: 'application/json' },
      );
      assertOk(response, 'product list');
      const parsed = productsResponseSchema.safeParse(parseJson(response, 'product list'));
      if (!parsed.success) {
        throw validationError(`Unexpected Shopify products payload: ${parsed.error.message}`);
      }
      const products = parsed.data.products.map((p) => normalizeShopifyProduct(p, creds.shopCurrency));
      const nextCursor = nextCursorFromLink(response.headers.link);
      return nextCursor ? { products, nextCursor } : { products };
    },

    normalizeProduct: normalizeShopifyProduct,

    async registerWebhooks(auth: ConnectorAuth, params: { address: string }): Promise<string[]> {
      const ids: string[] = [];
      for (const topic of PRODUCT_WEBHOOK_TOPICS) {
        const response = await transport.post(
          `${apiBase(auth.shopDomain)}/webhooks.json`,
          {
            'X-Shopify-Access-Token': auth.accessToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          JSON.stringify({ webhook: { topic, address: params.address, format: 'json' } }),
        );
        assertOk(response, `webhook create (${topic})`);
        const parsed = webhookResponseSchema.safeParse(parseJson(response, 'webhook create'));
        if (!parsed.success) {
          throw validationError(`Unexpected Shopify webhook payload: ${parsed.error.message}`);
        }
        ids.push(String(parsed.data.webhook.id));
      }
      return ids;
    },

    async deleteWebhooks(auth: ConnectorAuth, webhookIds: string[]): Promise<void> {
      for (const id of webhookIds) {
        const response = await transport.del(
          `${apiBase(auth.shopDomain)}/webhooks/${encodeURIComponent(id)}.json`,
          { 'X-Shopify-Access-Token': auth.accessToken, Accept: 'application/json' },
        );
        // 200 = deleted, 404 = already gone. Either is success (idempotent).
        if (response.status !== 200 && response.status !== 404) {
          throw validationError(`Shopify webhook delete failed (HTTP ${response.status})`);
        }
      }
    },
  };
}

/** The default Shopify provider (real SSRF-safe transport). */
export const shopifyProvider: ConnectorProvider = createShopifyProvider();
