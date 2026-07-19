/**
 * WooCommerce connector provider (REST API `wc/v3`).
 *
 * PULL + real-time webhooks (Shopify-parity cut). WooCommerce authorizes with a
 * merchant-issued consumer key/secret (NOT OAuth): `credentialStrategy: 'api_key'`.
 * The store admin creates a REST API key in WooCommerce and pastes the pair into
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
 *  - `fetchInventory` → re-reads the same product/variation `stock_quantity`, keyed by
 *    product/variation id (WooCommerce has no separate inventory-item id), summing to
 *    the provider-neutral `NormalizedInventoryLevel` the inventory sync consumes.
 *  - `fetchOrders`/`normalizeOrder` → GET `/wc/v3/orders?per_page=100&page=N`; each
 *    Woo order maps to a `NormalizedOrder`. Woo orders are SINGLE-currency, so every
 *    money is `shop === presentment` in the order's own currency (no fx conversion).
 *  - `registerWebhooks`/`deleteWebhooks` → WC REST `POST`/`DELETE /webhooks`. Each
 *    webhook is created with a per-connection `secret` and a per-connection delivery
 *    URL (`…/channels/webhooks/woocommerce/{connectionId}`) so the ingress route
 *    resolves the connection and verifies its stored secret (`webhook.ts`).
 *  - `normalizeProduct`/`normalizeOrder` are PURE mappings, pricing in the shop's
 *    NATIVE currency (no FAIR conversion).
 *
 * OUT OF SCOPE (throw a clear `notImplemented`): OAuth (`buildAuthorizeUrl`/
 * `exchangeCode` — api_key strategy) and PUSH (`pushProduct`/`pushFulfillment`).
 * WooCommerce PRODUCT PUSH (Mercaria → Woo) is intentionally left unimplemented —
 * the outbound direction (Woo → Mercaria) is served by the Mercaria WordPress plugin
 * (the channel-ingest `push_in` path), not by pushing from this pull connector.
 *
 * ALL network I/O goes through the injected {@link WooCommerceTransport}, which is
 * SSRF-guarded (`safeFetch`, IP-pinned) — a WooCommerce host is fully
 * merchant-supplied, so SSRF validation matters.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CURRENCY_PRECISION,
  type AddressSnapshot,
  type CurrencyCode,
  type DualMoney,
  type Money,
  type OrderStatus,
  type PaymentInfo,
} from '@mercaria/shared-types';
import { validationError, MercariaError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';
import type {
  ConnectorAuth,
  ConnectorCredentials,
  ConnectorProvider,
  NormalizedInventoryLevel,
  NormalizedOrder,
  NormalizedOrderCustomer,
  NormalizedOrderLine,
  NormalizedProduct,
  NormalizedVariant,
  ShopIdentity,
} from '../types.js';
import { REGISTERED_WEBHOOK_TOPICS } from './webhook.js';
import { wooCommerceTransport, type WooCommerceHttpResponse, type WooCommerceTransport } from './http.js';

/** Max products/variations/orders per page (the value the pull requests). */
const PAGE_LIMIT = 100;
/** The publish states of products the pull imports (drafts/private are skipped). */
const PRODUCT_STATUS = 'publish';

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

/** Build a clear, honest error for a method the WooCommerce connector does not support. */
function notImplementedError(method: string): MercariaError {
  return new MercariaError({
    code: ErrorCodes.INTERNAL_ERROR,
    httpStatus: 501,
    message: `WooCommerce connector does not implement "${method}" (unsupported: OAuth connect + product/fulfillment push).`,
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
    // WooCommerce has no separate inventory-item id — stock lives on the
    // product/variation itself, so the variation id IS the inventory-item key the
    // inventory sync maps back to this variant (`source.externalInventoryItemId`).
    externalInventoryItemId: String(variation.id),
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
    // A simple product's stock lives on the product itself → the product id is the
    // inventory-item key the inventory sync maps back to this variant.
    externalInventoryItemId: String(product.id),
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

// --- WooCommerce ORDER schemas (only the fields we consume) ------------------

/** Placeholder variant title when a line carries no attribute meta. */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/** One entry of a line item's `meta_data` — variation attributes surface here. */
const wooOrderLineMetaSchema = z.object({
  display_key: z.string().nullable().optional(),
  display_value: z.string().nullable().optional(),
});

/** One WooCommerce order line item. */
const wooOrderLineSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().nullable().optional(),
  product_id: z.union([z.number(), z.string()]).nullable().optional(),
  variation_id: z.union([z.number(), z.string()]).nullable().optional(),
  quantity: z.number().default(1),
  /** Pre-discount line total (WooCommerce's per-line "subtotal"). */
  subtotal: z.string().default('0'),
  /** Post-discount line total. */
  total: z.string().default('0'),
  sku: z.string().nullable().optional(),
  meta_data: z.array(wooOrderLineMetaSchema).default([]),
});

/** A WooCommerce billing/shipping address block. */
const wooOrderAddressSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  address_1: z.string().nullable().optional(),
  address_2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

/** One refund entry on an order (its presence marks a partial/full refund). */
const wooRefundSchema = z.object({ total: z.string().nullable().optional() });

/** A WooCommerce order (`GET /orders`). */
const wooOrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  number: z.union([z.number(), z.string()]).nullable().optional(),
  status: z.string().default('pending'),
  currency: z.string().default(''),
  date_created_gmt: z.string().nullable().optional(),
  date_modified_gmt: z.string().nullable().optional(),
  total: z.string().default('0'),
  total_tax: z.string().default('0'),
  shipping_total: z.string().default('0'),
  discount_total: z.string().default('0'),
  customer_id: z.union([z.number(), z.string()]).nullable().optional(),
  billing: wooOrderAddressSchema.nullable().optional(),
  shipping: wooOrderAddressSchema.nullable().optional(),
  line_items: z.array(wooOrderLineSchema).default([]),
  refunds: z.array(wooRefundSchema).default([]),
});

const ordersResponseSchema = z.array(wooOrderSchema);

type WooOrder = z.infer<typeof wooOrderSchema>;
type WooOrderLine = z.infer<typeof wooOrderLineSchema>;
type WooOrderAddress = z.infer<typeof wooOrderAddressSchema>;

/** True when a raw currency string is a supported Mercaria `CurrencyCode`. */
function isSupportedCurrencyCode(code: string | null | undefined): code is CurrencyCode {
  return typeof code === 'string' && (ALL_CURRENCY_CODES as readonly string[]).includes(code);
}

/**
 * A single-currency `DualMoney`: WooCommerce orders carry no presentment currency, so
 * shop === presentment (the SAME `Money`), mirroring how the Shopify mapper collapses
 * the two when presentment matches shop.
 */
function singleDualMoney(amount: number, currency: CurrencyCode): DualMoney {
  const money: Money = { amount, currency };
  return { shop: money, presentment: money };
}

/**
 * Map a WooCommerce order `status` (+ whether the order has any refunds) to a Mercaria
 * order + payment status. `processing` = payment received / being prepared → `paid`;
 * `completed` = fulfilled → `shipped`; a `processing`/`completed` order carrying refunds
 * becomes `partially_refunded`; `refunded`/`cancelled`/`failed`/`on-hold`/`pending` map
 * to their nearest Mercaria states.
 */
function mapWooStatus(
  status: string,
  hasRefunds: boolean,
): { status: OrderStatus; paymentStatus: PaymentInfo['status'] } {
  switch (status) {
    case 'completed':
      return hasRefunds
        ? { status: 'partially_refunded', paymentStatus: 'paid' }
        : { status: 'shipped', paymentStatus: 'paid' };
    case 'processing':
      return hasRefunds
        ? { status: 'partially_refunded', paymentStatus: 'paid' }
        : { status: 'paid', paymentStatus: 'paid' };
    case 'refunded':
      return { status: 'refunded', paymentStatus: 'refunded' };
    case 'cancelled':
      return { status: 'cancelled', paymentStatus: 'unpaid' };
    case 'failed':
      return { status: 'pending_payment', paymentStatus: 'failed' };
    case 'on-hold':
    case 'pending':
    default:
      return { status: 'pending_payment', paymentStatus: 'unpaid' };
  }
}

/** Build a variant title from a line's attribute `meta_data` (skips internal `_`-keys). */
function variantTitleFromMeta(meta: WooOrderLine['meta_data']): string {
  const parts: string[] = [];
  for (const entry of meta) {
    const key = entry.display_key ?? '';
    const value = entry.display_value ?? '';
    if (key.trim() !== '' && !key.startsWith('_') && value.trim() !== '') {
      parts.push(value);
    }
  }
  return parts.length > 0 ? parts.join(' / ') : DEFAULT_VARIANT_TITLE;
}

/**
 * Map one WooCommerce order line to a `NormalizedOrderLine` in `currency`. The
 * per-unit price is derived from the line's PRE-discount `subtotal` (WooCommerce's
 * per-line subtotal — discounts are captured at the order level, matching Shopify),
 * and `lineTotal = unitPrice * quantity` holds exactly.
 */
function toOrderLine(line: WooOrderLine, currency: CurrencyCode): NormalizedOrderLine {
  const quantity = line.quantity > 0 ? line.quantity : 1;
  const lineSubtotalMinor = decimalStringToMinor(line.subtotal.trim() !== '' ? line.subtotal : '0', currency);
  const unitMinor = Math.round(lineSubtotalMinor / quantity);
  const unitPrice = singleDualMoney(unitMinor, currency);
  const result: NormalizedOrderLine = {
    title: line.name ?? 'Item',
    variantTitle: variantTitleFromMeta(line.meta_data),
    quantity,
    unitPrice,
    lineTotal: singleDualMoney(unitMinor * quantity, currency),
  };
  if (line.product_id != null) {
    result.externalProductId = String(line.product_id);
  }
  // WooCommerce reports `variation_id: 0` for a non-variable line — treat as absent.
  if (line.variation_id != null && String(line.variation_id) !== '0') {
    result.externalVariantId = String(line.variation_id);
  }
  if (line.sku != null && line.sku.trim() !== '') {
    result.sku = line.sku;
  }
  return result;
}

/** Map the order's customer (skips the guest `customer_id: 0`), when present. */
function mapWooCustomer(order: WooOrder): NormalizedOrderCustomer | undefined {
  const customer: NormalizedOrderCustomer = {};
  const customerId = order.customer_id != null ? String(order.customer_id) : undefined;
  if (customerId && customerId !== '0') {
    customer.externalId = customerId;
  }
  const email = order.billing?.email;
  if (email && email.trim() !== '') {
    customer.email = email;
  }
  const name = [order.billing?.first_name, order.billing?.last_name]
    .filter((p) => p && p.trim() !== '')
    .join(' ')
    .trim();
  if (name) {
    customer.name = name;
  }
  return Object.keys(customer).length > 0 ? customer : undefined;
}

/**
 * Map the order's destination to an `AddressSnapshot`: prefer the shipping address,
 * falling back to billing when shipping has no street line. Returns undefined only
 * when the order carries neither block.
 */
function mapWooAddress(
  shipping: WooOrderAddress | null | undefined,
  billing: WooOrderAddress | null | undefined,
): AddressSnapshot | undefined {
  const src = shipping && (shipping.address_1 ?? '').trim() !== '' ? shipping : billing ?? shipping;
  if (!src) {
    return undefined;
  }
  const recipientName = [src.first_name, src.last_name]
    .filter((p) => p && p.trim() !== '')
    .join(' ')
    .trim();
  const snapshot: AddressSnapshot = {
    recipientName,
    line1: src.address_1 ?? '',
    city: src.city ?? '',
    postalCode: src.postcode ?? '',
    country: src.country ?? '',
  };
  if (src.address_2 && src.address_2.trim() !== '') {
    snapshot.line2 = src.address_2;
  }
  if (src.state && src.state.trim() !== '') {
    snapshot.region = src.state;
  }
  if (src.phone && src.phone.trim() !== '') {
    snapshot.phone = src.phone;
  }
  return snapshot;
}

/**
 * PURE: map a raw WooCommerce order into a `NormalizedOrder`. WooCommerce is
 * single-currency, so every money is `shop === presentment` in the order's own
 * currency (falling back to the connection's shop currency when the order omits it or
 * reports an unsupported code) and there is no fx-rate snapshot. Order-level totals are
 * read from WooCommerce's authoritative fields; the subtotal is the sum of line totals
 * so items and `totals.subtotal` stay internally consistent.
 */
export function normalizeWooCommerceOrder(raw: unknown, shopCurrency: CurrencyCode): NormalizedOrder {
  const parsed = wooOrderSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(`Malformed WooCommerce order: ${parsed.error.message}`);
  }
  const order = parsed.data;
  const currency: CurrencyCode = isSupportedCurrencyCode(order.currency) ? order.currency : shopCurrency;

  const lines = order.line_items.map((line) => toOrderLine(line, currency));
  if (lines.length === 0) {
    throw validationError(`WooCommerce order ${String(order.id)} has no line items`);
  }

  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotal.shop.amount, 0);
  const totals = {
    subtotal: singleDualMoney(subtotalMinor, currency),
    discountTotal: singleDualMoney(decimalStringToMinor(order.discount_total || '0', currency), currency),
    tax: singleDualMoney(decimalStringToMinor(order.total_tax || '0', currency), currency),
    shipping: singleDualMoney(decimalStringToMinor(order.shipping_total || '0', currency), currency),
    grandTotal: singleDualMoney(decimalStringToMinor(order.total || '0', currency), currency),
  };

  const { status, paymentStatus } = mapWooStatus(order.status, order.refunds.length > 0);

  const normalized: NormalizedOrder = {
    externalId: String(order.id),
    status,
    paymentStatus,
    shopCurrency: currency,
    presentmentCurrency: currency,
    lines,
    totals,
  };
  if (order.number != null && String(order.number).trim() !== '') {
    normalized.externalNumber = String(order.number);
  }
  // WooCommerce GMT timestamps carry no offset — append `Z` to read them as UTC.
  const updatedAt = order.date_modified_gmt ?? order.date_created_gmt;
  if (updatedAt && updatedAt.trim() !== '') {
    normalized.externalUpdatedAt = new Date(`${updatedAt}Z`);
  }
  if (order.date_created_gmt && order.date_created_gmt.trim() !== '') {
    normalized.createdAt = new Date(`${order.date_created_gmt}Z`);
  }
  const customer = mapWooCustomer(order);
  if (customer) {
    normalized.customer = customer;
  }
  const shippingAddress = mapWooAddress(order.shipping, order.billing);
  if (shippingAddress) {
    normalized.shippingAddress = shippingAddress;
  }
  return normalized;
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

/** Parse a `page` cursor (a 1-based page number as a string), or start at page 1. */
function pageFromCursor(cursor: string | undefined): number {
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isInteger(page) || page < 1) {
    throw validationError(`Invalid WooCommerce page cursor: ${cursor}`);
  }
  return page;
}

/** A `POST /webhooks` response — only the created subscription's id is consumed. */
const webhookCreateResponseSchema = z.object({ id: z.union([z.number(), z.string()]) });

/**
 * Construct a WooCommerce provider over `transport`. The default transport is the
 * real SSRF-safe one; tests inject a fake to exercise the mapping/paging logic.
 */
export function createWooCommerceProvider(
  transport: WooCommerceTransport = wooCommerceTransport,
): ConnectorProvider {
  /** Fetch every variation of a `variable` product, paginating the variations endpoint. */
  async function fetchAllVariations(
    auth: ConnectorAuth,
    productId: string,
  ): Promise<WooVariation[]> {
    const all: WooVariation[] = [];
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({ per_page: String(PAGE_LIMIT), page: String(page) });
      const response = await transport.get(
        `${apiBase(auth.shopDomain)}/products/${encodeURIComponent(productId)}/variations?${params.toString()}`,
        authHeaders(auth),
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

  /**
   * Fetch ONE page of published products (raw + parsed) + its total page count.
   * Shared by `fetchProducts` (which normalizes each product) and `fetchInventory`
   * (which reads stock only), so both page the same `/products` endpoint identically.
   */
  async function fetchProductsPage(
    auth: ConnectorAuth,
    page: number,
  ): Promise<{ products: WooProduct[]; totalPages: number }> {
    const params = new URLSearchParams({
      per_page: String(PAGE_LIMIT),
      page: String(page),
      status: PRODUCT_STATUS,
    });
    const response = await transport.get(
      `${apiBase(auth.shopDomain)}/products?${params.toString()}`,
      authHeaders(auth),
    );
    assertOk(response, 'product list');
    const parsed = productsResponseSchema.safeParse(parseJson(response, 'product list'));
    if (!parsed.success) {
      throw validationError(`Unexpected WooCommerce products payload: ${parsed.error.message}`);
    }
    return { products: parsed.data, totalPages: totalPagesFromHeaders(response) };
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
    // WooCommerce signs webhooks with a per-webhook `secret` (not one app-wide secret),
    // so a fresh secret is minted per connection and set on every webhook (see
    // `webhook.ts`); the ingress route verifies with the connection's stored secret.
    webhookSecretStrategy: 'per_connection',

    // WooCommerce authorizes with a static API key/secret (see connect-key), not
    // an OAuth authorize→callback exchange. `buildAuthorizeUrl` is synchronous, so
    // it throws; `exchangeCode` rejects.
    buildAuthorizeUrl: () => notImplemented('buildAuthorizeUrl'),
    exchangeCode: () => Promise.reject(notImplementedError('exchangeCode')),

    verifyConnection,

    async fetchProducts(creds: ConnectorCredentials, cursor?: string) {
      const page = pageFromCursor(cursor);
      const { products: rawProducts, totalPages } = await fetchProductsPage(creds, page);
      const products: NormalizedProduct[] = [];
      for (const product of rawProducts) {
        const variations =
          product.type === 'variable' ? await fetchAllVariations(creds, String(product.id)) : [];
        products.push(normalizeParsed(product, creds.shopCurrency, variations));
      }
      const nextCursor = page < totalPages ? String(page + 1) : undefined;
      return nextCursor ? { products, nextCursor } : { products };
    },

    normalizeProduct: normalizeWooCommerceProduct,

    async fetchOrders(creds: ConnectorCredentials, cursor?: string) {
      const page = pageFromCursor(cursor);
      const params = new URLSearchParams({ per_page: String(PAGE_LIMIT), page: String(page) });
      const response = await transport.get(
        `${apiBase(creds.shopDomain)}/orders?${params.toString()}`,
        authHeaders(creds),
      );
      assertOk(response, 'order list');
      const parsed = ordersResponseSchema.safeParse(parseJson(response, 'order list'));
      if (!parsed.success) {
        throw validationError(`Unexpected WooCommerce orders payload: ${parsed.error.message}`);
      }
      const orders = parsed.data.map((order) => normalizeWooCommerceOrder(order, creds.shopCurrency));
      const totalPages = totalPagesFromHeaders(response);
      const nextCursor = page < totalPages ? String(page + 1) : undefined;
      return nextCursor ? { orders, nextCursor } : { orders };
    },

    normalizeOrder: normalizeWooCommerceOrder,

    async fetchInventory(
      auth: ConnectorAuth,
      params: { inventoryItemIds: string[] },
    ): Promise<NormalizedInventoryLevel[]> {
      // WooCommerce has no inventory-item endpoint — stock lives on the product /
      // variation itself. Re-page the catalog and emit a level for each REQUESTED item
      // that TRACKS stock (an untracked item reports no number → omitted, matching the
      // Shopify semantics where an item with no level is left out).
      const wanted = new Set(params.inventoryItemIds);
      if (wanted.size === 0) {
        return [];
      }
      const levels: NormalizedInventoryLevel[] = [];
      let page = 1;
      for (;;) {
        const { products, totalPages } = await fetchProductsPage(auth, page);
        for (const product of products) {
          if (product.type === 'variable') {
            const parent: ParentStock = {
              tracked: product.manage_stock === true,
              quantity: product.stock_quantity ?? null,
            };
            const variations = await fetchAllVariations(auth, String(product.id));
            for (const variation of variations) {
              const id = String(variation.id);
              if (!wanted.has(id)) {
                continue;
              }
              const inv = resolveInventory(variation.manage_stock, variation.stock_quantity, parent);
              if (inv.tracked) {
                levels.push({ externalInventoryItemId: id, available: inv.available });
              }
            }
          } else {
            const id = String(product.id);
            if (!wanted.has(id)) {
              continue;
            }
            const inv = resolveInventory(product.manage_stock, product.stock_quantity, {
              tracked: false,
              quantity: null,
            });
            if (inv.tracked) {
              levels.push({ externalInventoryItemId: id, available: inv.available });
            }
          }
        }
        if (products.length === 0 || page >= totalPages) {
          return levels;
        }
        page += 1;
      }
    },

    async registerWebhooks(
      auth: ConnectorAuth,
      params: { address: string; connectionId: string; secret?: string },
    ): Promise<string[]> {
      if (!params.secret) {
        throw validationError('WooCommerce webhook registration requires a per-connection secret');
      }
      // A per-CONNECTION delivery URL so the ingress route resolves the exact
      // connection (and thus its stored secret) for HMAC verification.
      const deliveryUrl = `${params.address.replace(/\/+$/, '')}/${encodeURIComponent(params.connectionId)}`;
      const headers = { ...authHeaders(auth), 'Content-Type': 'application/json' };
      const ids: string[] = [];
      for (const topic of REGISTERED_WEBHOOK_TOPICS) {
        const response = await transport.post(
          `${apiBase(auth.shopDomain)}/webhooks`,
          headers,
          JSON.stringify({
            name: `Mercaria ${topic}`,
            topic,
            delivery_url: deliveryUrl,
            secret: params.secret,
            status: 'active',
          }),
        );
        assertOk(response, `webhook create (${topic})`);
        const parsed = webhookCreateResponseSchema.safeParse(parseJson(response, 'webhook create'));
        if (!parsed.success) {
          throw validationError(`Unexpected WooCommerce webhook payload: ${parsed.error.message}`);
        }
        ids.push(String(parsed.data.id));
      }
      return ids;
    },

    async deleteWebhooks(auth: ConnectorAuth, webhookIds: string[]): Promise<void> {
      for (const id of webhookIds) {
        // `force=true` permanently deletes (without it WooCommerce only trashes it).
        const response = await transport.del(
          `${apiBase(auth.shopDomain)}/webhooks/${encodeURIComponent(id)}?force=true`,
          authHeaders(auth),
        );
        // 200 = deleted, 404 = already gone. Either is success (idempotent).
        if (response.status !== 200 && response.status !== 404) {
          throw validationError(`WooCommerce webhook delete failed (HTTP ${response.status})`);
        }
      }
    },

    // --- Unsupported: OUTBOUND product/fulfillment PUSH (see the file header). The
    // Woo → Mercaria direction is served by the Mercaria WordPress plugin, not here.
    pushProduct: () => Promise.reject(notImplementedError('pushProduct')),
    pushFulfillment: () => Promise.reject(notImplementedError('pushFulfillment')),
  };
}

/** The default WooCommerce provider (real SSRF-safe transport). */
export const wooCommerceProvider: ConnectorProvider = createWooCommerceProvider();
