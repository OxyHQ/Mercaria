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
import {
  ALL_CURRENCY_CODES,
  CURRENCY_PRECISION,
  type AddressSnapshot,
  type CurrencyCode,
  type DualMoney,
  type FxRateSnapshot,
  type Money,
  type OrderStatus,
  type PaymentInfo,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  ConnectorProvider,
  ExchangeResult,
  NormalizedInventoryLevel,
  NormalizedOrder,
  NormalizedOrderCustomer,
  NormalizedOrderLine,
  NormalizedProduct,
  NormalizedVariant,
  PushFulfillment,
  PushProduct,
  PushProductResult,
  PushVariant,
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
/**
 * Order webhook topics registered on connect for near-real-time order sync. The
 * inbound handler gates on the connection's `orders` direction, so registering
 * them unconditionally (like the product topics) is safe — a connection with
 * orders `off` simply ignores the delivery.
 */
const ORDER_WEBHOOK_TOPICS = ['orders/create', 'orders/updated'] as const;
/**
 * Inventory webhook topic registered on connect for near-real-time stock sync. The
 * inbound handler gates on the connection's `inventory` direction, so registering
 * it unconditionally (like the order topics) is safe — a connection with inventory
 * `off` simply ignores the delivery.
 */
const INVENTORY_WEBHOOK_TOPICS = ['inventory_levels/update'] as const;
/** Shopify's cap on `inventory_item_ids` per `inventory_levels.json` request. */
const INVENTORY_ITEMS_PER_REQUEST = 50;
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
  inventory_item_id: z.union([z.number(), z.string()]).nullable().optional(),
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

/** A create/update product mutation response — only the assigned id is consumed. */
const productMutationResponseSchema = z.object({
  product: z.object({ id: z.union([z.number(), z.string()]) }),
});

/** One inventory level row: an item's available at a single location. */
const inventoryLevelSchema = z.object({
  inventory_item_id: z.union([z.number(), z.string()]),
  available: z.number().nullable().optional(),
});

/** The `inventory_levels.json` response — a flat list of per-(item, location) rows. */
const inventoryLevelsResponseSchema = z.object({
  inventory_levels: z.array(inventoryLevelSchema).default([]),
});

/** One fulfillment order (the modern Shopify fulfillment unit) — id + status only. */
const fulfillmentOrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string().nullable().optional(),
});

/** The `orders/{id}/fulfillment_orders.json` response. */
const fulfillmentOrdersResponseSchema = z.object({
  fulfillment_orders: z.array(fulfillmentOrderSchema).default([]),
});

// --- Shopify ORDER schemas (only the fields we consume) ---------------------

/** A Shopify money bag: a decimal string amount in a named currency. */
const shopifyMoneyBagSchema = z.object({
  amount: z.string(),
  currency_code: z.string().optional(),
});

/** A Shopify money "set": the same amount in shop + presentment currency. */
const shopifyMoneySetSchema = z.object({
  shop_money: shopifyMoneyBagSchema,
  presentment_money: shopifyMoneyBagSchema.optional(),
});

const shopifyOrderLineSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  product_id: z.union([z.number(), z.string()]).nullable().optional(),
  variant_id: z.union([z.number(), z.string()]).nullable().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  variant_title: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  quantity: z.number().default(1),
  price: z.string().optional(),
  price_set: shopifyMoneySetSchema.optional(),
});

const shopifyOrderAddressSchema = z.object({
  name: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  address1: z.string().nullable().optional(),
  address2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  province: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

const shopifyOrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  currency: z.string().optional(),
  presentment_currency: z.string().nullable().optional(),
  financial_status: z.string().nullable().optional(),
  fulfillment_status: z.string().nullable().optional(),
  subtotal_price: z.string().nullable().optional(),
  total_tax: z.string().nullable().optional(),
  total_discounts: z.string().nullable().optional(),
  total_price: z.string().nullable().optional(),
  subtotal_price_set: shopifyMoneySetSchema.optional(),
  total_tax_set: shopifyMoneySetSchema.optional(),
  total_discounts_set: shopifyMoneySetSchema.optional(),
  total_shipping_price_set: shopifyMoneySetSchema.optional(),
  total_price_set: shopifyMoneySetSchema.optional(),
  customer: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      email: z.string().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  line_items: z.array(shopifyOrderLineSchema).default([]),
  shipping_address: shopifyOrderAddressSchema.nullable().optional(),
});

const ordersResponseSchema = z.object({
  orders: z.array(shopifyOrderSchema).default([]),
});

type ShopifyVariant = z.infer<typeof shopifyVariantSchema>;
type ShopifyProduct = z.infer<typeof shopifyProductSchema>;
type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;
type ShopifyMoneySet = z.infer<typeof shopifyMoneySetSchema>;

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
    externalVariantId: String(variant.id),
    inventory: {
      tracked: variant.inventory_management != null,
      available: Math.max(0, variant.inventory_quantity ?? 0),
    },
  };
  if (variant.inventory_item_id != null) {
    normalized.externalInventoryItemId = String(variant.inventory_item_id);
  }
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

/** Format integer minor units back to a Shopify decimal price string (major units). */
function minorToDecimalString(amount: number, currency: CurrencyCode): string {
  const precision = CURRENCY_PRECISION[currency];
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(precision + 1, '0');
  const intPart = digits.slice(0, digits.length - precision);
  const fraction = precision > 0 ? `.${digits.slice(digits.length - precision)}` : '';
  return `${negative ? '-' : ''}${intPart}${fraction}`;
}

/** True when a raw currency string is a supported Mercaria `CurrencyCode`. */
function isSupportedCurrencyCode(code: string | null | undefined): code is CurrencyCode {
  return typeof code === 'string' && (ALL_CURRENCY_CODES as readonly string[]).includes(code);
}

/**
 * Build a `DualMoney` from a Shopify money "set". The `shop` side reads the shop
 * money (falling back to the flat string field when the set is absent); the
 * `presentment` side reads the presentment money ONLY when the order's presentment
 * currency both differs from the shop currency AND is a supported code — otherwise
 * both sides are the byte-identical shop amount.
 */
function dualMoneyFromSet(
  set: ShopifyMoneySet | undefined,
  fallbackAmount: string | null | undefined,
  shopCurrency: CurrencyCode,
  presentmentCurrency: CurrencyCode,
): DualMoney {
  const shopAmount = set?.shop_money.amount ?? fallbackAmount ?? '0';
  const shop: Money = { amount: decimalStringToMinor(shopAmount, shopCurrency), currency: shopCurrency };
  if (presentmentCurrency !== shopCurrency && set?.presentment_money) {
    return {
      shop,
      presentment: {
        amount: decimalStringToMinor(set.presentment_money.amount, presentmentCurrency),
        currency: presentmentCurrency,
      },
    };
  }
  return { shop, presentment: shop };
}

/** Multiply a per-unit `DualMoney` by an integer quantity (both sides). */
function multiplyDual(unit: DualMoney, quantity: number): DualMoney {
  return {
    shop: { amount: unit.shop.amount * quantity, currency: unit.shop.currency },
    presentment: { amount: unit.presentment.amount * quantity, currency: unit.presentment.currency },
  };
}

/** Map Shopify's financial/fulfillment status to a Mercaria order + payment status. */
function mapShopifyStatus(
  financial: string | null | undefined,
  fulfillment: string | null | undefined,
): { status: OrderStatus; paymentStatus: PaymentInfo['status'] } {
  switch (financial) {
    case 'paid':
      return { status: fulfillment === 'fulfilled' ? 'shipped' : 'paid', paymentStatus: 'paid' };
    case 'partially_refunded':
      return { status: 'partially_refunded', paymentStatus: 'paid' };
    case 'refunded':
      return { status: 'refunded', paymentStatus: 'refunded' };
    case 'voided':
      return { status: 'cancelled', paymentStatus: 'failed' };
    case 'authorized':
      return { status: 'pending_payment', paymentStatus: 'authorized' };
    default:
      return { status: 'pending_payment', paymentStatus: 'unpaid' };
  }
}

/**
 * Derive the shop→presentment `FxRateSnapshot` from the order's grand total (the
 * ratio of presentment to shop major units). Returns undefined when the two
 * currencies match (no conversion happened).
 */
function deriveFxRate(
  grand: DualMoney,
  shopCurrency: CurrencyCode,
  presentmentCurrency: CurrencyCode,
  asOf: string,
): FxRateSnapshot | undefined {
  if (presentmentCurrency === shopCurrency) {
    return undefined;
  }
  const shopMajor = grand.shop.amount / 10 ** CURRENCY_PRECISION[shopCurrency];
  const presentmentMajor = grand.presentment.amount / 10 ** CURRENCY_PRECISION[presentmentCurrency];
  const rate = shopMajor > 0 ? presentmentMajor / shopMajor : 1;
  return { from: shopCurrency, to: presentmentCurrency, rate, asOf };
}

/** Map a Shopify order address to Mercaria's `AddressSnapshot` shape. */
function mapShopifyAddress(addr: ShopifyOrder['shipping_address']): AddressSnapshot | undefined {
  if (!addr) {
    return undefined;
  }
  const recipientName = (
    addr.name ?? [addr.first_name, addr.last_name].filter((p) => p).join(' ')
  ).trim();
  const snapshot: AddressSnapshot = {
    recipientName,
    line1: addr.address1 ?? '',
    city: addr.city ?? '',
    postalCode: addr.zip ?? '',
    country: addr.country_code ?? addr.country ?? '',
  };
  if (addr.address2) snapshot.line2 = addr.address2;
  if (addr.province) snapshot.region = addr.province;
  if (addr.phone) snapshot.phone = addr.phone;
  return snapshot;
}

/** Map the Shopify customer, when present, to the neutral customer shape. */
function mapShopifyCustomer(raw: ShopifyOrder['customer']): NormalizedOrderCustomer | undefined {
  if (!raw) {
    return undefined;
  }
  const customer: NormalizedOrderCustomer = {};
  if (raw.id !== undefined) customer.externalId = String(raw.id);
  if (raw.email) customer.email = raw.email;
  const name = [raw.first_name, raw.last_name].filter((p) => p).join(' ').trim();
  if (name) customer.name = name;
  return Object.keys(customer).length > 0 ? customer : undefined;
}

/** PURE: map a raw Shopify order into a `NormalizedOrder` priced in `shopCurrency`. */
export function normalizeShopifyOrder(raw: unknown, shopCurrency: CurrencyCode): NormalizedOrder {
  const parsed = shopifyOrderSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(`Malformed Shopify order: ${parsed.error.message}`);
  }
  const order: ShopifyOrder = parsed.data;

  const presentmentCurrency: CurrencyCode = isSupportedCurrencyCode(order.presentment_currency)
    ? order.presentment_currency
    : shopCurrency;

  const totals = {
    subtotal: dualMoneyFromSet(order.subtotal_price_set, order.subtotal_price, shopCurrency, presentmentCurrency),
    discountTotal: dualMoneyFromSet(order.total_discounts_set, order.total_discounts, shopCurrency, presentmentCurrency),
    tax: dualMoneyFromSet(order.total_tax_set, order.total_tax, shopCurrency, presentmentCurrency),
    shipping: dualMoneyFromSet(order.total_shipping_price_set, '0', shopCurrency, presentmentCurrency),
    grandTotal: dualMoneyFromSet(order.total_price_set, order.total_price, shopCurrency, presentmentCurrency),
  };

  const lines: NormalizedOrderLine[] = order.line_items.map((item) => {
    const unitPrice = dualMoneyFromSet(item.price_set, item.price, shopCurrency, presentmentCurrency);
    const line: NormalizedOrderLine = {
      title: item.title ?? item.name ?? 'Item',
      variantTitle: item.variant_title ?? DEFAULT_OPTION_VALUE,
      quantity: item.quantity,
      unitPrice,
      lineTotal: multiplyDual(unitPrice, item.quantity),
    };
    if (item.product_id !== null && item.product_id !== undefined) {
      line.externalProductId = String(item.product_id);
    }
    if (item.variant_id !== null && item.variant_id !== undefined) {
      line.externalVariantId = String(item.variant_id);
    }
    if (item.sku) line.sku = item.sku;
    return line;
  });
  if (lines.length === 0) {
    throw validationError(`Shopify order ${String(order.id)} has no line items`);
  }

  const { status, paymentStatus } = mapShopifyStatus(order.financial_status, order.fulfillment_status);
  const asOf = order.updated_at ?? order.created_at ?? new Date().toISOString();

  const normalized: NormalizedOrder = {
    externalId: String(order.id),
    status,
    paymentStatus,
    shopCurrency,
    presentmentCurrency,
    lines,
    totals,
  };
  if (order.name) normalized.externalNumber = order.name;
  if (order.updated_at) normalized.externalUpdatedAt = new Date(order.updated_at);
  if (order.created_at) normalized.createdAt = new Date(order.created_at);
  const fxRate = deriveFxRate(totals.grandTotal, shopCurrency, presentmentCurrency, asOf);
  if (fxRate) normalized.fxRate = fxRate;
  const customer = mapShopifyCustomer(order.customer);
  if (customer) normalized.customer = customer;
  const shippingAddress = mapShopifyAddress(order.shipping_address);
  if (shippingAddress) normalized.shippingAddress = shippingAddress;
  return normalized;
}

/** Build one Shopify REST variant body from a `PushVariant` + the option order. */
function toShopifyVariantBody(variant: PushVariant, optionNames: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    price: minorToDecimalString(variant.price.amount, variant.price.currency),
    inventory_management: variant.inventory.tracked ? 'shopify' : null,
    inventory_quantity: variant.inventory.available,
  };
  if (variant.compareAtPrice) {
    body.compare_at_price = minorToDecimalString(variant.compareAtPrice.amount, variant.compareAtPrice.currency);
  }
  if (variant.sku) body.sku = variant.sku;
  if (variant.barcode) body.barcode = variant.barcode;
  // Pair each option value to option1..3 in the product's declared option order.
  const valueByName = new Map(variant.optionValues.map((o) => [o.name, o.value]));
  optionNames.forEach((name, index) => {
    const value = valueByName.get(name);
    if (value !== undefined) {
      body[`option${index + 1}`] = value;
    }
  });
  return body;
}

/** Build the Shopify REST product body (create/update) from a `PushProduct`. */
function buildShopifyProductBody(product: PushProduct): string {
  const optionNames = product.options.map((o) => o.name);
  const body: Record<string, unknown> = {
    title: product.title,
    body_html: product.description,
    status: product.status,
    variants: product.variants.map((v) => toShopifyVariantBody(v, optionNames)),
  };
  if (product.handle) body.handle = product.handle;
  if (product.vendor) body.vendor = product.vendor;
  if (product.productType) body.product_type = product.productType;
  if (product.options.length > 0) {
    body.options = product.options.map((o) => ({ name: o.name, values: [...o.values] }));
  }
  if (product.imageUrls.length > 0) {
    body.images = product.imageUrls.map((src) => ({ src }));
  }
  return JSON.stringify({ product: body });
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

/** Split `items` into consecutive chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Fulfillment-order statuses that still have OPEN work to fulfill. Anything else
 * (`closed`, `cancelled`, `incomplete`) has nothing to mark shipped, so pushing a
 * fulfillment against it is skipped — this is what makes a re-push idempotent.
 */
const OPEN_FULFILLMENT_STATUSES: readonly string[] = ['open', 'in_progress', 'scheduled'];

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

    async pushProduct(auth: ConnectorAuth, product: PushProduct): Promise<PushProductResult> {
      const headers = {
        'X-Shopify-Access-Token': auth.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      const body = buildShopifyProductBody(product);
      const response = product.externalId
        ? await transport.put(
            `${apiBase(auth.shopDomain)}/products/${encodeURIComponent(product.externalId)}.json`,
            headers,
            body,
          )
        : await transport.post(`${apiBase(auth.shopDomain)}/products.json`, headers, body);
      assertOk(response, product.externalId ? 'product update' : 'product create');
      const parsed = productMutationResponseSchema.safeParse(parseJson(response, 'product mutation'));
      if (!parsed.success) {
        throw validationError(`Unexpected Shopify product payload: ${parsed.error.message}`);
      }
      return { externalId: String(parsed.data.product.id) };
    },

    async fetchOrders(creds: ConnectorCredentials, cursor?: string) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      // Shopify forbids combining any filter with `page_info`; `status=any` is only
      // valid on the FIRST page (no cursor). Subsequent pages carry the cursor alone.
      if (cursor) {
        params.set('page_info', cursor);
      } else {
        params.set('status', 'any');
      }
      const response = await transport.get(
        `${apiBase(creds.shopDomain)}/orders.json?${params.toString()}`,
        { 'X-Shopify-Access-Token': creds.accessToken, Accept: 'application/json' },
      );
      assertOk(response, 'order list');
      const parsed = ordersResponseSchema.safeParse(parseJson(response, 'order list'));
      if (!parsed.success) {
        throw validationError(`Unexpected Shopify orders payload: ${parsed.error.message}`);
      }
      const orders = parsed.data.orders.map((o) => normalizeShopifyOrder(o, creds.shopCurrency));
      const nextCursor = nextCursorFromLink(response.headers.link);
      return nextCursor ? { orders, nextCursor } : { orders };
    },

    normalizeOrder: normalizeShopifyOrder,

    async fetchInventory(
      auth: ConnectorAuth,
      params: { inventoryItemIds: string[] },
    ): Promise<NormalizedInventoryLevel[]> {
      // Total available PER inventory item, summed across every Shopify location —
      // a single Mercaria target location mirrors the shop-wide sellable total.
      const totals = new Map<string, number>();
      for (const ids of chunk(params.inventoryItemIds, INVENTORY_ITEMS_PER_REQUEST)) {
        if (ids.length === 0) {
          continue;
        }
        const query = new URLSearchParams({
          inventory_item_ids: ids.join(','),
          limit: String(PAGE_LIMIT),
        });
        const response = await transport.get(
          `${apiBase(auth.shopDomain)}/inventory_levels.json?${query.toString()}`,
          { 'X-Shopify-Access-Token': auth.accessToken, Accept: 'application/json' },
        );
        assertOk(response, 'inventory levels');
        const parsed = inventoryLevelsResponseSchema.safeParse(parseJson(response, 'inventory levels'));
        if (!parsed.success) {
          throw validationError(`Unexpected Shopify inventory payload: ${parsed.error.message}`);
        }
        for (const level of parsed.data.inventory_levels) {
          const itemId = String(level.inventory_item_id);
          const available = Math.max(0, level.available ?? 0);
          totals.set(itemId, (totals.get(itemId) ?? 0) + available);
        }
      }
      return [...totals].map(([externalInventoryItemId, available]) => ({
        externalInventoryItemId,
        available,
      }));
    },

    async pushFulfillment(auth: ConnectorAuth, fulfillment: PushFulfillment): Promise<void> {
      const headers = {
        'X-Shopify-Access-Token': auth.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      // Modern fulfillment flow: read the order's fulfillment orders, then create a
      // fulfillment against each one that still has OPEN work (idempotent — an order
      // already fulfilled has no open fulfillment orders → this is a no-op).
      const listResponse = await transport.get(
        `${apiBase(auth.shopDomain)}/orders/${encodeURIComponent(fulfillment.externalOrderId)}/fulfillment_orders.json`,
        { 'X-Shopify-Access-Token': auth.accessToken, Accept: 'application/json' },
      );
      assertOk(listResponse, 'fulfillment orders lookup');
      const parsed = fulfillmentOrdersResponseSchema.safeParse(
        parseJson(listResponse, 'fulfillment orders lookup'),
      );
      if (!parsed.success) {
        throw validationError(`Unexpected Shopify fulfillment-orders payload: ${parsed.error.message}`);
      }

      const openOrders = parsed.data.fulfillment_orders.filter(
        (fo) => fo.status != null && OPEN_FULFILLMENT_STATUSES.includes(fo.status),
      );
      for (const fo of openOrders) {
        const body: Record<string, unknown> = {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }],
          notify_customer: true,
        };
        if (fulfillment.trackingNumber) {
          body.tracking_info = { number: fulfillment.trackingNumber };
        }
        const response = await transport.post(
          `${apiBase(auth.shopDomain)}/fulfillments.json`,
          headers,
          JSON.stringify({ fulfillment: body }),
        );
        assertOk(response, 'fulfillment create');
      }
    },

    async registerWebhooks(auth: ConnectorAuth, params: { address: string }): Promise<string[]> {
      const ids: string[] = [];
      for (const topic of [
        ...PRODUCT_WEBHOOK_TOPICS,
        ...ORDER_WEBHOOK_TOPICS,
        ...INVENTORY_WEBHOOK_TOPICS,
      ]) {
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
