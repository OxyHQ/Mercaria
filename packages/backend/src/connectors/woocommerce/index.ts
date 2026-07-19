/**
 * WooCommerce connector provider (REST API `wc/v3`).
 *
 * PULL-ONLY (Fase 4 first cut). WooCommerce authorizes with a merchant-issued
 * consumer key/secret (NOT OAuth): `credentialStrategy: 'api_key'`. The store
 * admin creates a read-only REST API key in WooCommerce and pastes the pair into
 * Mercaria; the connect endpoint verifies it and stores it encrypted. Over HTTPS,
 * WooCommerce accepts the key/secret as HTTP Basic credentials — that is exactly
 * how {@link ConnectorAuth.accessToken} (`"consumerKey:consumerSecret"`) is used
 * here, base64-encoded into an `Authorization: Basic …` header.
 *
 *  - `verifyConnection` → GET `/wc/v3/data/currencies/current` — confirms the
 *    credentials AND reports the shop's settlement currency in one call.
 *  - `fetchProducts` → GET `/wc/v3/products?per_page=100&page=N` (paginated via the
 *    `X-WP-TotalPages` header), fetching each `variable` product's variations from
 *    `/wc/v3/products/{id}/variations` and mapping them into variants.
 *  - `normalizeProduct` is a PURE mapping (WooCommerce JSON → `NormalizedProduct`),
 *    pricing every variant in the shop's NATIVE currency (no FAIR conversion).
 *
 * The OAuth, order, push, inventory-pull and webhook methods the interface
 * requires are NOT part of this pull-only first cut and throw a clear
 * `notImplemented` — they are never reached by the products-pull path (connect via
 * API key, backfill, scheduled re-sync). ALL network I/O goes through the injected
 * {@link WooCommerceTransport}, which is SSRF-guarded (`safeFetch`, IP-pinned) —
 * a WooCommerce host is fully merchant-supplied, so SSRF validation matters.
 */

import { z } from 'zod';
import {
  CURRENCY_PRECISION,
  type CurrencyCode,
  type Money,
} from '@mercaria/shared-types';
import { validationError, MercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  ConnectorProvider,
  NormalizedProduct,
  NormalizedVariant,
  ShopIdentity,
} from '../types.js';
import { wooCommerceTransport, type WooCommerceHttpResponse, type WooCommerceTransport } from './http.js';

/** Max products/variations per page (the value the pull requests). */
const PAGE_LIMIT = 100;

// --- WooCommerce response schemas (only the fields we consume; extras ignored) ---

/** `GET /data/currencies/current` → the shop's active currency. */
const currencyResponseSchema = z.object({ code: z.string().min(1) });

/** A product OR variation attribute selection. On a variation, `option` is the value. */
const wooVariationAttributeSchema = z.object({
  name: z.string(),
  option: z.string().default(''),
});

/** A product-level attribute; `variation: true` marks it as a selectable option. */
const wooProductAttributeSchema = z.object({
  name: z.string(),
  variation: z.boolean().optional(),
  options: z.array(z.string()).default([]),
});

const wooImageSchema = z.object({ src: z.string() });
const wooCategorySchema = z.object({ id: z.union([z.number(), z.string()]) });

/**
 * A WooCommerce `manage_stock` flag: `true`/`false` on a product; a variation may
 * also report `'parent'`, meaning it inherits the parent product's stock setting.
 */
const wooManageStockSchema = z.union([z.boolean(), z.literal('parent')]);

/** One variation of a `variable` product (`GET /products/{id}/variations`). */
const wooVariationSchema = z.object({
  id: z.union([z.number(), z.string()]),
  price: z.string().default(''),
  regular_price: z.string().default(''),
  sale_price: z.string().default(''),
  sku: z.string().nullable().optional(),
  manage_stock: wooManageStockSchema.optional(),
  stock_quantity: z.number().nullable().optional(),
  attributes: z.array(wooVariationAttributeSchema).default([]),
});

/**
 * A WooCommerce product. `expandedVariations` is NOT a WooCommerce field — it is
 * the connector's expansion contract: `fetchProducts` fetches a `variable`
 * product's variations from the variations endpoint and passes them alongside the
 * product, and the pure `normalizeProduct` reads them when present.
 */
const wooProductSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  slug: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  type: z.string().default('simple'),
  date_modified_gmt: z.string().nullable().optional(),
  date_created_gmt: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  price: z.string().default(''),
  regular_price: z.string().default(''),
  sale_price: z.string().default(''),
  manage_stock: wooManageStockSchema.optional(),
  stock_quantity: z.number().nullable().optional(),
  attributes: z.array(wooProductAttributeSchema).default([]),
  images: z.array(wooImageSchema).default([]),
  categories: z.array(wooCategorySchema).default([]),
  expandedVariations: z.array(wooVariationSchema).optional(),
});

const productsResponseSchema = z.array(wooProductSchema);
const variationsResponseSchema = z.array(wooVariationSchema);

type WooProduct = z.infer<typeof wooProductSchema>;
type WooVariation = z.infer<typeof wooVariationSchema>;
type WooManageStock = z.infer<typeof wooManageStockSchema>;

/** Build a clear, honest error for a method outside the pull-only first cut. */
function notImplementedError(method: string): MercariaError {
  return new MercariaError({
    code: ErrorCodes.INTERNAL_ERROR,
    httpStatus: 501,
    message: `WooCommerce connector does not implement "${method}" (pull-only: verifyConnection, fetchProducts, normalizeProduct).`,
  });
}

/** Throw {@link notImplementedError} — used for the interface's SYNCHRONOUS methods. */
function notImplemented(method: string): never {
  throw notImplementedError(method);
}

/**
 * Parse a WooCommerce decimal price string (major units, e.g. `"19.99"`) into
 * integer minor units for `currency`, using pure integer/string math (never a
 * float, so `"19.99"` is exactly `1999`). Extra fraction digits beyond the
 * currency's precision are rounded half-up. Throws on a malformed/unsafe value.
 * Mirrors the Shopify provider's parser — WooCommerce prices are the same decimal
 * string shape, and each provider owns its platform's price parsing.
 */
function decimalStringToMinor(value: string, currency: CurrencyCode): number {
  const precision = CURRENCY_PRECISION[currency];
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw validationError(`Cannot parse WooCommerce price "${value}" for ${currency}`);
  }
  const [intPart, fracRaw = ''] = trimmed.split('.');
  const fracForPrecision = fracRaw.slice(0, precision).padEnd(precision, '0');
  let minor = Number(intPart) * 10 ** precision + Number(fracForPrecision || '0');
  if (fracRaw.length > precision && Number(fracRaw[precision]) >= 5) {
    minor += 1;
  }
  if (!Number.isSafeInteger(minor)) {
    throw validationError(`WooCommerce price "${value}" exceeds the safe integer range`);
  }
  return minor;
}

/**
 * Resolve a WooCommerce selling price + optional compare-at from its price fields.
 * WooCommerce exposes `regular_price` (the base "was" price), `sale_price` (the
 * discounted price when on sale) and `price` (the effective price). Mercaria's
 * selling price is the effective `price` (falling back to `regular_price`); the
 * compare-at is `regular_price` ONLY when the item is on sale and the regular
 * exceeds the effective (so a stale/equal regular never shows a fake discount).
 */
function resolvePrices(
  priceStr: string,
  regularStr: string,
  saleStr: string,
  currency: CurrencyCode,
): { price: Money; compareAtPrice?: Money } {
  const effective = priceStr.trim() !== '' ? priceStr : regularStr;
  if (effective.trim() === '') {
    throw validationError('WooCommerce product/variant has no price');
  }
  const price: Money = { amount: decimalStringToMinor(effective, currency), currency };
  if (saleStr.trim() !== '' && regularStr.trim() !== '') {
    const regularMinor = decimalStringToMinor(regularStr, currency);
    if (regularMinor > price.amount) {
      return { price, compareAtPrice: { amount: regularMinor, currency } };
    }
  }
  return { price };
}

/** The parent product's stock setting, used when a variation defers with `'parent'`. */
interface ParentStock {
  tracked: boolean;
  quantity: number | null;
}

/** Resolve a `{ tracked, available }` inventory snapshot from a `manage_stock` flag. */
function resolveInventory(
  manageStock: WooManageStock | undefined,
  stockQuantity: number | null | undefined,
  parent: ParentStock,
): { tracked: boolean; available: number } {
  if (manageStock === true) {
    return { tracked: true, available: Math.max(0, stockQuantity ?? 0) };
  }
  if (manageStock === 'parent') {
    return { tracked: parent.tracked, available: Math.max(0, parent.quantity ?? 0) };
  }
  return { tracked: false, available: 0 };
}

/** Map one WooCommerce variation into a `NormalizedVariant` priced in `shopCurrency`. */
function variationToVariant(
  variation: WooVariation,
  shopCurrency: CurrencyCode,
  parent: ParentStock,
): NormalizedVariant {
  const { price, compareAtPrice } = resolvePrices(
    variation.price,
    variation.regular_price,
    variation.sale_price,
    shopCurrency,
  );
  const variant: NormalizedVariant = {
    optionValues: variation.attributes
      .filter((a) => a.option.trim() !== '')
      .map((a) => ({ name: a.name, value: a.option })),
    price,
    externalVariantId: String(variation.id),
    inventory: resolveInventory(variation.manage_stock, variation.stock_quantity, parent),
  };
  if (compareAtPrice) {
    variant.compareAtPrice = compareAtPrice;
  }
  if (variation.sku != null && variation.sku.trim() !== '') {
    variant.sku = variation.sku;
  }
  return variant;
}

/** Map a `simple` (non-variable) product into its single `NormalizedVariant`. */
function simpleVariant(product: WooProduct, shopCurrency: CurrencyCode): NormalizedVariant {
  const { price, compareAtPrice } = resolvePrices(
    product.price,
    product.regular_price,
    product.sale_price,
    shopCurrency,
  );
  const variant: NormalizedVariant = {
    optionValues: [],
    price,
    externalVariantId: String(product.id),
    inventory: resolveInventory(product.manage_stock, product.stock_quantity, {
      tracked: false,
      quantity: null,
    }),
  };
  if (compareAtPrice) {
    variant.compareAtPrice = compareAtPrice;
  }
  if (product.sku != null && product.sku.trim() !== '') {
    variant.sku = product.sku;
  }
  return variant;
}

/** Build the selectable options (product attributes flagged `variation: true`). */
function toOptions(product: WooProduct): { name: string; values: string[] }[] {
  return product.attributes
    .filter((a) => a.variation === true && a.options.length > 0)
    .map((a) => ({ name: a.name, values: [...a.options] }));
}

/** Build the variant list: a variable product's variations, else a single variant. */
function buildVariants(
  product: WooProduct,
  shopCurrency: CurrencyCode,
  variations: WooVariation[],
): NormalizedVariant[] {
  if (product.type === 'variable' && variations.length > 0) {
    const parent: ParentStock = {
      tracked: product.manage_stock === true,
      quantity: product.stock_quantity ?? null,
    };
    return variations.map((v) => variationToVariant(v, shopCurrency, parent));
  }
  return [simpleVariant(product, shopCurrency)];
}

/** Map an already-parsed WooCommerce product (+ its variations) to a `NormalizedProduct`. */
function normalizeParsed(
  product: WooProduct,
  shopCurrency: CurrencyCode,
  variations: WooVariation[],
): NormalizedProduct {
  const options = toOptions(product);
  const variants = buildVariants(product, shopCurrency, variations);
  if (variants.length === 0) {
    throw validationError(`WooCommerce product ${String(product.id)} has no variants`);
  }

  const normalized: NormalizedProduct = {
    externalId: String(product.id),
    title: product.name,
    description: product.description ?? '',
    options,
    imageUrls: product.images.map((img) => img.src),
    variants,
  };
  // WooCommerce GMT timestamps carry no offset — append `Z` to read them as UTC.
  const updatedAt = product.date_modified_gmt ?? product.date_created_gmt;
  if (updatedAt && updatedAt.trim() !== '') {
    normalized.externalUpdatedAt = new Date(`${updatedAt}Z`);
  }
  if (product.slug && product.slug.trim() !== '') {
    normalized.handle = product.slug;
  }
  const collectionRefs = product.categories.map((c) => String(c.id));
  if (collectionRefs.length > 0) {
    normalized.collectionRefs = collectionRefs;
  }
  return normalized;
}

/**
 * PURE: map a raw WooCommerce product into a `NormalizedProduct` in `shopCurrency`.
 * For a `variable` product, embed the fetched variations under `expandedVariations`
 * (as `fetchProducts` does); when absent, a single variant is derived from the
 * product's own price/stock fields.
 */
export function normalizeWooCommerceProduct(raw: unknown, shopCurrency: CurrencyCode): NormalizedProduct {
  const parsed = wooProductSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(`Malformed WooCommerce product: ${parsed.error.message}`);
  }
  return normalizeParsed(parsed.data, shopCurrency, parsed.data.expandedVariations ?? []);
}

/** The WooCommerce REST base for a site: `{site}/wp-json/wc/v3` (https-normalized). */
function apiBase(shopDomain: string): string {
  const trimmed = shopDomain.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return `${withScheme.replace(/\/+$/, '')}/wp-json/wc/v3`;
}

/** HTTP Basic header from the `"consumerKey:consumerSecret"` credential (over HTTPS). */
function authHeaders(auth: ConnectorAuth): Record<string, string> {
  const basic = Buffer.from(auth.accessToken, 'utf8').toString('base64');
  return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
}

/** The canonical site identifier stored on the connection (the https origin/base URL). */
function siteIdentifier(shopDomain: string): string {
  const trimmed = shopDomain.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Throw a clear error when a WooCommerce response is not a 2xx. */
function assertOk(response: WooCommerceHttpResponse, context: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw validationError(`WooCommerce ${context} failed (HTTP ${response.status})`);
  }
}

/** Parse a JSON body or throw a clear error. */
function parseJson(response: WooCommerceHttpResponse, context: string): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw validationError(`WooCommerce ${context} returned a non-JSON body`);
  }
}

/** Read `X-WP-TotalPages` (the WordPress REST pagination header), defaulting to 1. */
function totalPagesFromHeaders(response: WooCommerceHttpResponse): number {
  const raw = response.headers['x-wp-totalpages'];
  const parsed = raw ? Number(raw) : 1;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Construct a WooCommerce provider over `transport`. The default transport is the
 * real SSRF-safe one; tests inject a fake to exercise the mapping/paging logic.
 */
export function createWooCommerceProvider(
  transport: WooCommerceTransport = wooCommerceTransport,
): ConnectorProvider {
  /** Fetch every variation of a `variable` product, paginating the variations endpoint. */
  async function fetchAllVariations(
    creds: ConnectorCredentials,
    productId: string,
  ): Promise<WooVariation[]> {
    const all: WooVariation[] = [];
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({ per_page: String(PAGE_LIMIT), page: String(page) });
      const response = await transport.get(
        `${apiBase(creds.shopDomain)}/products/${encodeURIComponent(productId)}/variations?${params.toString()}`,
        authHeaders(creds),
      );
      assertOk(response, 'variation list');
      const parsed = variationsResponseSchema.safeParse(parseJson(response, 'variation list'));
      if (!parsed.success) {
        throw validationError(`Unexpected WooCommerce variations payload: ${parsed.error.message}`);
      }
      all.push(...parsed.data);
      const totalPages = totalPagesFromHeaders(response);
      if (parsed.data.length === 0 || page >= totalPages) {
        return all;
      }
      page += 1;
    }
  }

  async function verifyConnection(auth: ConnectorAuth): Promise<ShopIdentity> {
    const response = await transport.get(
      `${apiBase(auth.shopDomain)}/data/currencies/current`,
      authHeaders(auth),
    );
    assertOk(response, 'currency lookup');
    const parsed = currencyResponseSchema.safeParse(parseJson(response, 'currency lookup'));
    if (!parsed.success) {
      throw validationError(`Unexpected WooCommerce currency payload: ${parsed.error.message}`);
    }
    const site = siteIdentifier(auth.shopDomain);
    return { externalShopId: site, shopDomain: site, shopCurrency: parsed.data.code };
  }

  return {
    id: 'woocommerce',
    credentialStrategy: 'api_key',

    // WooCommerce authorizes with a static API key/secret (see connect-key), not
    // an OAuth authorize→callback exchange. `buildAuthorizeUrl` is synchronous, so
    // it throws; the promise-returning methods reject.
    buildAuthorizeUrl: () => notImplemented('buildAuthorizeUrl'),
    exchangeCode: () => Promise.reject(notImplementedError('exchangeCode')),

    verifyConnection,

    async fetchProducts(creds: ConnectorCredentials, cursor?: string) {
      const page = cursor ? Number(cursor) : 1;
      if (!Number.isInteger(page) || page < 1) {
        throw validationError(`Invalid WooCommerce page cursor: ${cursor}`);
      }
      const params = new URLSearchParams({
        per_page: String(PAGE_LIMIT),
        page: String(page),
        status: 'publish',
      });
      const response = await transport.get(
        `${apiBase(creds.shopDomain)}/products?${params.toString()}`,
        authHeaders(creds),
      );
      assertOk(response, 'product list');
      const parsed = productsResponseSchema.safeParse(parseJson(response, 'product list'));
      if (!parsed.success) {
        throw validationError(`Unexpected WooCommerce products payload: ${parsed.error.message}`);
      }

      const products: NormalizedProduct[] = [];
      for (const product of parsed.data) {
        const variations =
          product.type === 'variable'
            ? await fetchAllVariations(creds, String(product.id))
            : [];
        products.push(normalizeParsed(product, creds.shopCurrency, variations));
      }

      const totalPages = totalPagesFromHeaders(response);
      const nextCursor = page < totalPages ? String(page + 1) : undefined;
      return nextCursor ? { products, nextCursor } : { products };
    },

    normalizeProduct: normalizeWooCommerceProduct,

    // --- Not part of the pull-only first cut (never reached by products pull) ---
    // Promise-returning methods reject; `normalizeOrder` is synchronous and throws.
    pushProduct: () => Promise.reject(notImplementedError('pushProduct')),
    fetchOrders: () => Promise.reject(notImplementedError('fetchOrders')),
    normalizeOrder: () => notImplemented('normalizeOrder'),
    fetchInventory: () => Promise.reject(notImplementedError('fetchInventory')),
    pushFulfillment: () => Promise.reject(notImplementedError('pushFulfillment')),
    registerWebhooks: () => Promise.reject(notImplementedError('registerWebhooks')),
    deleteWebhooks: () => Promise.reject(notImplementedError('deleteWebhooks')),
  };
}

/** The default WooCommerce provider (real SSRF-safe transport). */
export const wooCommerceProvider: ConnectorProvider = createWooCommerceProvider();
