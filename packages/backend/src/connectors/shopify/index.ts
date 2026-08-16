/**
 * Shopify connector provider (REST Admin API `2026-07`).
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
  type DiscountValueType,
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
  NormalizedOrderDiscount,
  NormalizedOrderLine,
  NormalizedOrderTaxLine,
  NormalizedProduct,
  NormalizedVariant,
  PlatformWebhookSubscription,
  PushFulfillment,
  PushFulfillmentLine,
  PushProduct,
  PushProductResult,
  PushVariant,
  ShopIdentity,
  VariantSet,
} from '../types.js';
import {
  classifyWebhookHttpStatus,
  reconcileWebhookSubscriptions,
  type WebhookProbe,
} from '../webhook-registration.js';
import { parseProviderTimestamp } from '../timestamps.js';
import { getShopifyCredentials } from './config.js';
import { shopifyTransport, type ShopifyHttpResponse, type ShopifyTransport } from './http.js';

/**
 * This connector's provider id. It is also the FX source recorded on an imported
 * order's rate snapshot, since the rate is reconstructed from amounts Shopify
 * reported rather than quoted by any Mercaria FX provider.
 */
const PROVIDER_ID = 'shopify';
/**
 * The pinned Shopify Admin API version.
 *
 * Exported for `scripts/e2e/shopify/preflight.ts`, which refuses a real-store
 * verification run whose pinned version Shopify no longer serves AS ITSELF. It
 * has to read THIS constant rather than restate it: an unsupported version does
 * not 404 — Shopify falls forward to the oldest accessible stable version — so a
 * preflight carrying its own copy would go on reporting the version it was
 * written with, which is the answer that check exists to prevent.
 *
 * ## Why `2026-07`
 *
 * It is the newest stable version, and the Shopify Partner app's own Webhooks
 * API version is set to it. That agreement is the point: REST responses and
 * webhook payloads go through the SAME normalizers below, so a split between
 * the two would feed one function two shapes and is strictly worse than either
 * version chosen consistently.
 *
 * The predecessors: `2024-10` retired around 2025-10-16 and Shopify fell forward
 * to `2025-10`, which the pin was moved to so the declaration matched the wire.
 * `2025-10` stops being served as itself on **2026-10-16 15:00 UTC**, so it was
 * also the accessible version with the least time left; `2026-07` runs to
 * 2027-07-16. Both dates are Shopify's published schedule, read from
 * https://shopify.dev/docs/api/usage/versioning — nothing here restates them as
 * a constant, because `accessibleUntil` in `scripts/e2e/shopify/preflight.ts`
 * DERIVES the deadline from the quarterly cadence and refuses a verification run
 * past it, and `http.ts` warns once per shop when the served version differs
 * from the requested one.
 *
 * ## What was checked before moving, and what could NOT be established
 *
 * READ, from Shopify's CURRENT REST reference — which self-reports
 * `api_version: 2026-07` on every page: every endpoint this connector calls is
 * documented, with every field the zod schemas below REQUIRE — `shop` (id,
 * myshopify_domain, currency), `product` (id, title, body_html, handle, vendor,
 * product_type, updated_at, options, images, variants), `product-variant` (id,
 * price, compare_at_price, sku, barcode, inventory_item_id, inventory_quantity,
 * inventory_management, option1/2/3), `collect`, `smartcollection`, `order`
 * (including every `*_set` money set), `inventorylevel` (inventory_item_id,
 * available, and the 50-id cap {@link INVENTORY_ITEMS_PER_REQUEST} mirrors),
 * `fulfillmentorder` (id, status, line_items with fulfillable_quantity),
 * `fulfillment` (POST with line_items_by_fulfillment_order) and `webhook` (id,
 * address, topic, plus all six topics in {@link SHOPIFY_WEBHOOK_TOPICS}). The
 * rate-limit contract `http.ts` implements is unchanged — bucket 40, leak
 * 2/second on standard, `X-Shopify-Shop-Api-Call-Limit: 32/40`, HTTP 429 with a
 * fractional `Retry-After` in seconds — and so is pagination: `Link` with
 * `rel="next"`, a `page_info` cursor and a `limit` ceiling of 250
 * ({@link PAGE_LIMIT}). No schema below was widened to accommodate this move,
 * which is the load-bearing half of that sentence: a schema loosened to make a
 * bump pass is how a renamed field gets stored as if it were complete.
 *
 * **That reference route RESOLVES its version rather than echoing it, and the
 * control matters because the naive check cannot fail.** An ACCESSIBLE version
 * renders itself (`2025-10`→2025-10, `2026-04`→2026-04) while an INACCESSIBLE
 * one falls back to latest (`2019-04`, `2025-01`, `2099-01` all render 2026-07),
 * and an invented resource under a valid version hard-404s. **That is the DOCS
 * SITE and it is the OPPOSITE of the API**, which falls FORWARD to the OLDEST
 * accessible stable version — do not read one as evidence about the other; a
 * retired pin gets the oldest accessible version on the wire, never the latest.
 * So a page that loaded IS evidence the resource is documented in the version
 * asked for, and says nothing about what a retired pin would be served. One
 * residual degeneracy, stated rather than smoothed: for `2026-07` specifically
 * "rendered == requested" is weak, since 2026-07 is also the fallback target —
 * but both readings collapse to "2026-07 is the latest accessible version",
 * which the published schedule and `/latest/` corroborate.
 *
 * That is what makes a genuine version DIFF possible, and one was taken on the
 * highest-risk resource: `product-variant` at `2025-10` and at `2026-07` carry
 * IDENTICAL field lists — all eleven the schemas below require — and both state
 * "Each product can have a maximum of three options and a maximum of 100
 * variants". The nested shapes the schemas actually parse were walked
 * explicitly rather than taken from a field-name list: a money set is
 * `{shop_money:{amount,currency_code}, presentment_money:{…}}`, an order line
 * carries id/product_id/variant_id/title/name/variant_title/sku/quantity/price/
 * price_set, and a product image carries `src` plus `variant_ids`.
 *
 * INFERRED rather than read version-scoped: the rate-limit and pagination pages
 * carry NO version segment (`/docs/api/admin-rest/usage/*`), so "unchanged in
 * 2026-07" is an inference from an unversioned page, not an observation of one.
 *
 * NOT ESTABLISHED, and none of it is a formality:
 *
 *  - **No real store has answered.** #69 acceptance 7 is still unmet — no
 *    Partner app, no dev store, no observed response. All of the above is
 *    Shopify's documentation of its own API, and documentation is a statement of
 *    intent rather than a measurement of the wire.
 *  - **Only `product-variant` was DIFFED across the two versions**; the other
 *    nine resources were read at `2026-07` alone.
 *  - **The per-version release notes are unreachable** —
 *    `/docs/api/release-notes/{version}` 404s for every version after `2025-01`,
 *    with `2025-01` returning real content as the control (that URL family
 *    validates where the reference family falls back). So a field that changed
 *    MEANING, or became nullable while keeping its name, is invisible here.
 *
 * **The measurement that WOULD settle it is already built and needs a shop.**
 * `http.ts` compares `X-Shopify-API-Version` against the version in the request
 * URL and warns once per shop when they differ; `scripts/e2e/shopify/preflight.ts`
 * probes the configured shop directly and REFUSES a run on a measured mismatch.
 * Both are inert until the first real connect (#69 acceptance 7), so a
 * `2025-10`-vs-`2026-07` diff of REAL responses is owed rather than done. Until
 * then the honest statement about this pin is that it matches the Partner app's
 * webhook version and contradicts nothing Shopify publishes for `2026-07` — not
 * that it has been verified against `2026-07`'s BEHAVIOUR.
 *
 * The REST product/variant endpoints remain deprecated-but-present, "deprecated
 * as of REST API 2024-04", with the ceiling intact: "Each product can have a
 * maximum of three options and a maximum of 100 variants." Shopify has announced
 * NO sunset date for custom apps on REST that stay under it, and this connector
 * has no GraphQL call anywhere, so that ceiling — not the version — is the thing
 * that would force a rewrite. `config.maxVariantsPerProduct` defaults to the
 * same 100 and is what refuses a product above it today.
 */
export const API_VERSION = '2026-07';
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
/**
 * Every topic `registerWebhooks` subscribes, in registration order.
 *
 * Exported because it is half of a fact whose other half lives in
 * `config.ts` — Shopify gates `POST /webhooks.json` on the READ scope of the
 * topic being subscribed, so the default scope set and this list have to agree
 * or the default configuration lands in exactly #218's partial registration.
 * {@link WEBHOOK_TOPIC_SCOPES} is that agreement, and
 * `__tests__/shopify-scopes.test.ts` is what fails when it stops holding.
 */
export const SHOPIFY_WEBHOOK_TOPICS = [
  ...PRODUCT_WEBHOOK_TOPICS,
  ...ORDER_WEBHOOK_TOPICS,
  ...INVENTORY_WEBHOOK_TOPICS,
] as const;

/**
 * The OAuth scope Shopify requires before it will subscribe each topic.
 *
 * A TABLE rather than a prefix rule: `inventory_levels/update` needs
 * `read_inventory` and nothing about the string says so, and a rule derived from
 * the prefix would silently answer for a topic nobody has checked. Exhaustive
 * over {@link SHOPIFY_WEBHOOK_TOPICS} by construction — the `Record` key type is
 * what makes adding a topic without deciding its scope a `tsc` failure rather
 * than a registration that 403s on a real store.
 */
export const WEBHOOK_TOPIC_SCOPES: Readonly<
  Record<(typeof SHOPIFY_WEBHOOK_TOPICS)[number], string>
> = {
  'products/create': 'read_products',
  'products/update': 'read_products',
  'products/delete': 'read_products',
  'orders/create': 'read_orders',
  'orders/updated': 'read_orders',
  'inventory_levels/update': 'read_inventory',
};
/** Shopify's cap on `inventory_item_ids` per `inventory_levels.json` request. */
const INVENTORY_ITEMS_PER_REQUEST = 50;
/**
 * How long a shop's product→collections index is reused across the pages of ONE
 * backfill run. The index is (re)built on the first page (no cursor) and reused by
 * later pages; this TTL is a backstop that bounds memory and forces a rebuild if a
 * single run somehow outlives it.
 */
const COLLECTION_INDEX_TTL_MS = 10 * 60 * 1000;
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

/** `GET /webhooks.json` — every subscription this shop currently holds. */
const webhookListResponseSchema = z.object({
  webhooks: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]),
        topic: z.string(),
        address: z.string().default(''),
      }),
    )
    .default([]),
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

/**
 * One fulfillment-order LINE item (the modern per-line fulfillment unit). `id` is
 * the fulfillment-order line-item id (what a fulfillment references);
 * `fulfillable_quantity` is how many units remain to fulfill (0 once fulfilled →
 * idempotency); `variant_id`/`line_item_id` map it back to a Mercaria order line.
 */
const fulfillmentOrderLineItemSchema = z.object({
  id: z.union([z.number(), z.string()]),
  quantity: z.number().optional(),
  fulfillable_quantity: z.number().optional(),
  line_item_id: z.union([z.number(), z.string()]).nullable().optional(),
  variant_id: z.union([z.number(), z.string()]).nullable().optional(),
});

/** One fulfillment order (the modern Shopify fulfillment unit) — id + status + its lines. */
const fulfillmentOrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string().nullable().optional(),
  line_items: z.array(fulfillmentOrderLineItemSchema).default([]),
});

/** The `orders/{id}/fulfillment_orders.json` response. */
const fulfillmentOrdersResponseSchema = z.object({
  fulfillment_orders: z.array(fulfillmentOrderSchema).default([]),
});

/** One product↔custom-collection join row (`collects.json`). */
const collectSchema = z.object({
  product_id: z.union([z.number(), z.string()]),
  collection_id: z.union([z.number(), z.string()]),
});

/** The `collects.json` response — a flat list of custom-collection membership rows. */
const collectsResponseSchema = z.object({
  collects: z.array(collectSchema).default([]),
});

/** One smart (automated) collection — only its id is consumed. */
const smartCollectionSchema = z.object({
  id: z.union([z.number(), z.string()]),
});

/** The `smart_collections.json` response. */
const smartCollectionsResponseSchema = z.object({
  smart_collections: z.array(smartCollectionSchema).default([]),
});

/** One product entry when listing a collection's products (`collections/{id}/products.json`). */
const collectionProductSchema = z.object({
  id: z.union([z.number(), z.string()]),
});

/** The `collections/{id}/products.json` response. */
const collectionProductsResponseSchema = z.object({
  products: z.array(collectionProductSchema).default([]),
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

/**
 * How much ONE `discount_applications` entry took off ONE line (or shipping
 * line). Shopify states the money a discount removed HERE and nowhere else: a
 * `discount_applications` entry carries `value` + `value_type` (the RULE, e.g.
 * "10" + "percentage") and never the amount, so the amount is the sum of the
 * allocations pointing back at it by index.
 */
const shopifyDiscountAllocationSchema = z.object({
  amount: z.string().nullable().optional(),
  amount_set: shopifyMoneySetSchema.optional(),
  discount_application_index: z.number().nullable().optional(),
});

/** One discount APPLIED to a Shopify order (a code, an automatic rule, a manual one). */
const shopifyDiscountApplicationSchema = z.object({
  /** `discount_code` | `manual` | `script` | `automatic`. */
  type: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  /** Set only on a `discount_code` application — the code the buyer typed. */
  code: z.string().nullable().optional(),
  /** `fixed_amount` | `percentage`. Anything else is left UNSTATED rather than guessed. */
  value_type: z.string().nullable().optional(),
  /** `line_item` | `shipping_line`. */
  target_type: z.string().nullable().optional(),
});

/** One tax rate's contribution to a Shopify order. `rate` is a FRACTION (0.08 = 8%). */
const shopifyOrderTaxLineSchema = z.object({
  title: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  price_set: shopifyMoneySetSchema.optional(),
  rate: z.union([z.number(), z.string()]).nullable().optional(),
});

/** One shipping method on a Shopify order — the source of the human shipping LABEL. */
const shopifyShippingLineSchema = z.object({
  title: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  discount_allocations: z.array(shopifyDiscountAllocationSchema).default([]),
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
  discount_allocations: z.array(shopifyDiscountAllocationSchema).default([]),
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
  discount_applications: z.array(shopifyDiscountApplicationSchema).default([]),
  tax_lines: z.array(shopifyOrderTaxLineSchema).default([]),
  shipping_lines: z.array(shopifyShippingLineSchema).default([]),
  shipping_address: shopifyOrderAddressSchema.nullable().optional(),
});

const ordersResponseSchema = z.object({
  orders: z.array(shopifyOrderSchema).default([]),
});

type ShopifyVariant = z.infer<typeof shopifyVariantSchema>;
type ShopifyProduct = z.infer<typeof shopifyProductSchema>;
type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;
type ShopifyMoneySet = z.infer<typeof shopifyMoneySetSchema>;
type ShopifyFulfillmentOrder = z.infer<typeof fulfillmentOrderSchema>;
type ShopifyFulfillmentOrderLineItem = z.infer<typeof fulfillmentOrderLineItemSchema>;

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

/**
 * How many variants Shopify's REST product resource inlines before it stops.
 *
 * The `products` endpoint embeds `variants` and caps that array at 100; a product
 * with more is read through a separate paged resource this connector does not
 * call. So a product arriving with exactly the cap is one whose variant list may
 * be a PREFIX, and nothing in the payload distinguishes it from a product that
 * genuinely has 100 — which is why the count itself has to be the signal.
 */
const REST_INLINE_VARIANT_LIMIT = 100;

/**
 * What Shopify's inline variant array PROVES (#259).
 *
 * Below the cap the array is the whole set. At or above it the read cannot say
 * so, and asserting completeness there is how `convergeVariants` would unsell
 * every variant past the hundredth on the next sync.
 */
function shopifyVariantSet(variants: NormalizedVariant[]): VariantSet {
  if (variants.length >= REST_INLINE_VARIANT_LIMIT) {
    return { enumeration: 'incomplete', gap: { kind: 'pagination_unprovable', pagesRead: 1 } };
  }
  return { enumeration: 'complete', variants };
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
    variants: shopifyVariantSet(variants),
  };
  // Shopify publishes a full ISO-8601 instant with its own offset, so this needs
  // no suffix — but it still needs the refusal: an unreadable timestamp must
  // OMIT the field rather than assign an invalid `Date` that fails the whole
  // product's import at the listing insert (#221).
  const updatedAt = parseProviderTimestamp(product.updated_at);
  if (updatedAt) {
    normalized.externalUpdatedAt = updatedAt;
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
 *
 * The snapshot names SHOPIFY as its provider, not a Mercaria FX provider: the
 * rate is whatever Shopify actually charged the buyer at, reconstructed from the
 * two amounts Shopify reported. Mercaria's own rates are never substituted here —
 * an imported order keeps the source platform's economics exactly as reported.
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
  return { from: shopCurrency, to: presentmentCurrency, rate, provider: PROVIDER_ID, asOf };
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

/**
 * The SHOP side of a money set as a single-currency `Money`.
 *
 * Asking `dualMoneyFromSet` for shop→shop is what makes it read `shop_money` and
 * nothing else, so the breakdown lines and the totals parse the platform's
 * decimals through ONE function rather than two spellings that could diverge.
 */
function shopMoneyFromSet(
  set: ShopifyMoneySet | undefined,
  fallbackAmount: string | null | undefined,
  shopCurrency: CurrencyCode,
): Money {
  return dualMoneyFromSet(set, fallbackAmount, shopCurrency, shopCurrency).shop;
}

/**
 * Shopify's `value_type`, mapped onto Mercaria's `DiscountValueType`, or ABSENT.
 *
 * Only the two values Shopify documents are mapped. A third one Shopify adds
 * later must arrive as "unstated" rather than as whichever member looked
 * closest — see `OrderDiscountAllocation.valueType`.
 */
function shopifyDiscountValueType(raw: string | null | undefined): DiscountValueType | undefined {
  if (raw === 'percentage' || raw === 'fixed_amount') {
    return raw;
  }
  return undefined;
}

/**
 * The per-discount breakdown of a Shopify order, in SHOP currency.
 *
 * The list is `discount_applications` — which covers automatic and manual
 * discounts as well as codes, where `discount_codes` covers only codes — and
 * each application's MONEY is the sum of every allocation that points back at it
 * by index, across line items AND shipping lines. Summing the platform's own
 * allocations is not re-pricing; there is nowhere else Shopify states the amount.
 *
 * A shipping-targeted discount is INCLUDED even though Shopify leaves it out of
 * `total_discounts`, so a free-shipping code makes the breakdown exceed the
 * carried discount total. That mismatch is the platform's and is recorded, never
 * corrected (`NormalizedOrder.discounts`).
 */
function shopifyDiscountBreakdown(
  order: ShopifyOrder,
  shopCurrency: CurrencyCode,
): NormalizedOrderDiscount[] {
  const allocated = new Map<number, number>();
  const allocations = [
    ...order.line_items.flatMap((item) => item.discount_allocations),
    ...order.shipping_lines.flatMap((line) => line.discount_allocations),
  ];
  for (const allocation of allocations) {
    const index = allocation.discount_application_index;
    if (index === null || index === undefined) {
      continue;
    }
    const money = shopMoneyFromSet(allocation.amount_set, allocation.amount, shopCurrency);
    allocated.set(index, (allocated.get(index) ?? 0) + money.amount);
  }

  return order.discount_applications.map((application, index) => {
    const discount: NormalizedOrderDiscount = {
      externalId: `ext:${PROVIDER_ID}:discount_application:${index}`,
      title: application.title ?? application.code ?? application.description ?? 'Discount',
      amount: { amount: allocated.get(index) ?? 0, currency: shopCurrency },
    };
    if (application.code) {
      discount.code = application.code;
    }
    const valueType = shopifyDiscountValueType(application.value_type);
    if (valueType) {
      discount.valueType = valueType;
    }
    return discount;
  });
}

/**
 * The per-rate tax breakdown of a Shopify order, in SHOP currency.
 *
 * Shopify publishes `rate` as a FRACTION (`0.08`), which is basis points times
 * 10,000. A rate that is missing or unreadable is left ABSENT: a line claiming
 * zero basis points beside a non-zero amount is a worse record than one that
 * says the rate is unknown.
 */
function shopifyTaxBreakdown(
  order: ShopifyOrder,
  shopCurrency: CurrencyCode,
): NormalizedOrderTaxLine[] {
  return order.tax_lines.map((line, index) => {
    const taxLine: NormalizedOrderTaxLine = {
      name: line.title ?? `Tax ${index + 1}`,
      amount: shopMoneyFromSet(line.price_set, line.price, shopCurrency),
    };
    const rate = typeof line.rate === 'string' ? Number(line.rate) : line.rate;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) {
      taxLine.rateBps = Math.round(rate * 10_000);
    }
    return taxLine;
  });
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
  // `asOf` lands in `orders.fx_rate_as_of`, which is `text()` — so a malformed
  // value would be STORED rather than refused, while an `FxRateSnapshot` is
  // supposed to identify a conversion completely (#221). It is VALIDATED and not
  // rewritten: a readable value is kept in the platform's own spelling, because
  // an imported order keeps the source's economics verbatim, and only a value
  // nothing can read falls through to the current time.
  const asOf =
    [order.updated_at, order.created_at].find(
      (candidate) => parseProviderTimestamp(candidate) !== undefined,
    ) ?? new Date().toISOString();

  const normalized: NormalizedOrder = {
    externalId: String(order.id),
    status,
    paymentStatus,
    shopCurrency,
    presentmentCurrency,
    lines,
    totals,
    discounts: shopifyDiscountBreakdown(order, shopCurrency),
    taxLines: shopifyTaxBreakdown(order, shopCurrency),
  };
  if (order.name) normalized.externalNumber = order.name;
  // The buyer-facing name of the method they chose. Shopify's `code` is the
  // carrier's own identifier and `title` is what the buyer saw; the first
  // shipping line is the one the order shipped under.
  const shippingLabel = order.shipping_lines[0]?.title ?? order.shipping_lines[0]?.code;
  if (shippingLabel) normalized.shippingLabel = shippingLabel;
  // Unreadable timestamps are OMITTED rather than assigned invalid — see the
  // product normalizer above and `connectors/timestamps.ts`.
  const orderUpdatedAt = parseProviderTimestamp(order.updated_at);
  if (orderUpdatedAt) normalized.externalUpdatedAt = orderUpdatedAt;
  const orderCreatedAt = parseProviderTimestamp(order.created_at);
  if (orderCreatedAt) normalized.createdAt = orderCreatedAt;
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

/**
 * Parse a JSON body, or `undefined` when it is not JSON.
 *
 * The webhook-registration path classifies an unreadable body as
 * `unexpected_response` rather than raising, so it needs the failure as a VALUE.
 * Every other caller wants the throw and uses {@link parseJson}.
 */
function safeParseJson(response: ShopifyHttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
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
 * (`closed`, `cancelled`, `incomplete`, `on_hold`) has nothing to mark shipped
 * right now, so pushing a fulfillment against it is skipped — this (together with
 * per-line `fulfillable_quantity`) is what makes a re-push idempotent, and it means
 * a fulfillment HOLD is respected (a held fulfillment order is simply not shipped).
 */
const OPEN_FULFILLMENT_STATUSES: readonly string[] = ['open', 'in_progress', 'scheduled'];

/** A fulfillment-order line item chosen to fulfill, with the exact quantity to ship. */
interface FulfillmentLineSelection {
  id: number | string;
  quantity: number;
}

/** Remaining fulfillable units for a fulfillment-order line item (0 → nothing left to ship). */
function fulfillableUnits(line: ShopifyFulfillmentOrderLineItem): number {
  return Math.max(0, line.fulfillable_quantity ?? line.quantity ?? 0);
}

/**
 * Choose which of a fulfillment order's line items to fulfill, and how many units.
 * With no `requestedByVariant` (whole-order push), every still-fulfillable line is
 * taken at its full remaining quantity. With `requestedByVariant` (partial push),
 * only lines whose Shopify `variant_id` was requested are taken — each capped at the
 * lesser of what's still requested and what's still fulfillable — and the map is
 * DECREMENTED so a variant spanning several fulfillment orders is not over-fulfilled.
 */
function selectFulfillmentLines(
  fo: ShopifyFulfillmentOrder,
  requestedByVariant: Map<string, number> | undefined,
): FulfillmentLineSelection[] {
  const selections: FulfillmentLineSelection[] = [];
  for (const line of fo.line_items) {
    const available = fulfillableUnits(line);
    if (available <= 0) {
      continue;
    }
    if (!requestedByVariant) {
      selections.push({ id: line.id, quantity: available });
      continue;
    }
    const variantId = line.variant_id != null ? String(line.variant_id) : undefined;
    if (variantId === undefined) {
      continue;
    }
    const stillRequested = requestedByVariant.get(variantId) ?? 0;
    if (stillRequested <= 0) {
      continue;
    }
    const quantity = Math.min(stillRequested, available);
    selections.push({ id: line.id, quantity });
    requestedByVariant.set(variantId, stillRequested - quantity);
  }
  return selections;
}

/** Sum the requested fulfilled quantities per external variant id (skips product-only lines). */
function requestedQuantitiesByVariant(lines: PushFulfillmentLine[]): Map<string, number> {
  const requested = new Map<string, number>();
  for (const line of lines) {
    if (line.externalVariantId && line.quantity > 0) {
      requested.set(line.externalVariantId, (requested.get(line.externalVariantId) ?? 0) + line.quantity);
    }
  }
  return requested;
}

/** Build Shopify's `tracking_info` from whatever tracking fields Mercaria captured, or undefined. */
function buildTrackingInfo(fulfillment: PushFulfillment): Record<string, string> | undefined {
  const info: Record<string, string> = {};
  if (fulfillment.trackingNumber) {
    info.number = fulfillment.trackingNumber;
  }
  if (fulfillment.trackingUrl) {
    info.url = fulfillment.trackingUrl;
  }
  if (fulfillment.trackingCompany) {
    info.company = fulfillment.trackingCompany;
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Construct a Shopify provider over `transport`. The default transport is the
 * real SSRF-safe one; tests inject a fake to exercise the mapping/paging logic.
 */
export function createShopifyProvider(transport: ShopifyTransport = shopifyTransport): ConnectorProvider {
  /**
   * Per-shop product→collection-ids index, cached across the pages of one backfill
   * run (see {@link COLLECTION_INDEX_TTL_MS}). Scoped to THIS provider instance so
   * it never leaks between the singleton and injected test providers.
   */
  const collectionIndexCache = new Map<string, { index: Map<string, string[]>; builtAt: number }>();

  /**
   * `GET /webhooks.json`, as a PROBE rather than a throw, following every page.
   *
   * The registration path needs the refusal as a value — it turns it into one
   * failure per desired topic — while `listWebhooks` on the provider interface
   * is an ordinary read that raises. One request builder, two callers, so the
   * two cannot answer differently about what the platform said.
   *
   * It PAGES for the same reason `products.json` and `orders.json` do, and the
   * consequence of not doing so is worse here than a short catalogue: a
   * truncated list is read as "these are all the subscriptions that exist", so
   * every subscription past the page boundary is invisible — adopted by nobody,
   * deleted by nobody, duplicated on the next create. That happens on exactly
   * the shops this reconcile exists to rescue, since they are the ones carrying
   * accumulated orphans. It cannot reuse {@link paginate}, which raises on a
   * non-2xx: the whole point here is to answer with the refusal instead.
   */
  async function listShopifyWebhooks(
    auth: ConnectorAuth,
  ): Promise<WebhookProbe<PlatformWebhookSubscription[]>> {
    const all: PlatformWebhookSubscription[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) {
        params.set('page_info', cursor);
      }
      let response: ShopifyHttpResponse;
      try {
        response = await transport.get(
          `${apiBase(auth.shopDomain)}/webhooks.json?${params.toString()}`,
          { 'X-Shopify-Access-Token': auth.accessToken, Accept: 'application/json' },
        );
      } catch {
        return { outcome: 'refused', reason: 'transport_error' };
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          outcome: 'refused',
          reason: classifyWebhookHttpStatus(response.status),
          httpStatus: response.status,
        };
      }
      const parsed = webhookListResponseSchema.safeParse(safeParseJson(response));
      if (!parsed.success) {
        return { outcome: 'refused', reason: 'unexpected_response', httpStatus: response.status };
      }
      all.push(
        ...parsed.data.webhooks.map((webhook) => ({
          id: String(webhook.id),
          topic: webhook.topic,
          deliveryUrl: webhook.address,
        })),
      );
      cursor = nextCursorFromLink(response.headers.link);
    } while (cursor);
    return { outcome: 'ok', value: all };
  }

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

  /** Follow a `Link: rel="next"` cursor across every page of a collection endpoint, invoking `onPage`. */
  async function paginate(
    firstUrl: (params: URLSearchParams) => string,
    headers: Record<string, string>,
    context: string,
    onPage: (body: unknown) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) {
        params.set('page_info', cursor);
      }
      const response = await transport.get(firstUrl(params), headers);
      assertOk(response, context);
      onPage(parseJson(response, context));
      cursor = nextCursorFromLink(response.headers.link);
    } while (cursor);
  }

  /** Record that `productId` belongs to `collectionId` in the accumulating index. */
  function addMembership(index: Map<string, Set<string>>, productId: string, collectionId: string): void {
    const set = index.get(productId);
    if (set) {
      set.add(collectionId);
    } else {
      index.set(productId, new Set([collectionId]));
    }
  }

  /**
   * Build the shop's product→collection-ids index for a run. REST `products.json`
   * omits collection membership, so it is assembled here from two sources, each
   * fetched ONCE per run (no per-product N+1):
   *   - CUSTOM (manual) collections: `collects.json` — the flat product↔collection
   *     join, paginated and indexed by product id.
   *   - SMART (automated) collections: their membership is rule-based (not in
   *     `collects`), so each smart collection's own product list
   *     (`collections/{id}/products.json`) is read and inverted onto its products.
   */
  async function buildCollectionIndex(creds: ConnectorCredentials): Promise<Map<string, string[]>> {
    const headers = { 'X-Shopify-Access-Token': creds.accessToken, Accept: 'application/json' };
    const membership = new Map<string, Set<string>>();

    // 1) Custom-collection joins (one paginated pass over collects.json).
    await paginate(
      (params) => `${apiBase(creds.shopDomain)}/collects.json?${params.toString()}`,
      headers,
      'collects list',
      (body) => {
        const parsed = collectsResponseSchema.safeParse(body);
        if (!parsed.success) {
          throw validationError(`Unexpected Shopify collects payload: ${parsed.error.message}`);
        }
        for (const collect of parsed.data.collects) {
          addMembership(membership, String(collect.product_id), String(collect.collection_id));
        }
      },
    );

    // 2) Smart-collection ids, then each one's product list.
    const smartCollectionIds: string[] = [];
    await paginate(
      (params) => `${apiBase(creds.shopDomain)}/smart_collections.json?${params.toString()}`,
      headers,
      'smart collections list',
      (body) => {
        const parsed = smartCollectionsResponseSchema.safeParse(body);
        if (!parsed.success) {
          throw validationError(`Unexpected Shopify smart-collections payload: ${parsed.error.message}`);
        }
        for (const collection of parsed.data.smart_collections) {
          smartCollectionIds.push(String(collection.id));
        }
      },
    );
    for (const collectionId of smartCollectionIds) {
      await paginate(
        (params) =>
          `${apiBase(creds.shopDomain)}/collections/${encodeURIComponent(collectionId)}/products.json?${params.toString()}`,
        headers,
        'collection products',
        (body) => {
          const parsed = collectionProductsResponseSchema.safeParse(body);
          if (!parsed.success) {
            throw validationError(`Unexpected Shopify collection-products payload: ${parsed.error.message}`);
          }
          for (const product of parsed.data.products) {
            addMembership(membership, String(product.id), collectionId);
          }
        },
      );
    }

    const index = new Map<string, string[]>();
    for (const [productId, collectionIds] of membership) {
      index.set(productId, [...collectionIds]);
    }
    return index;
  }

  /**
   * The product→collection index for the current backfill page. Built fresh on the
   * FIRST page (no cursor) and reused by the run's later pages (cursor present),
   * which is what fetches the collection lists exactly once per run.
   */
  async function getCollectionIndex(
    creds: ConnectorCredentials,
    cursor: string | undefined,
  ): Promise<Map<string, string[]>> {
    const cached = collectionIndexCache.get(creds.shopDomain);
    if (cursor !== undefined && cached && Date.now() - cached.builtAt < COLLECTION_INDEX_TTL_MS) {
      return cached.index;
    }
    const index = await buildCollectionIndex(creds);
    collectionIndexCache.set(creds.shopDomain, { index, builtAt: Date.now() });
    return index;
  }

  return {
    id: PROVIDER_ID,
    credentialStrategy: 'oauth',
    // Shopify signs every webhook with the app's client secret — one app-wide secret,
    // so no per-connection secret is minted (see `shopify/webhook.ts`).
    webhookSecretStrategy: 'app_secret',
    // Read by the #69 contract suite AND by #87's channel catalog. Shopify
    // implements both pushes, `shopify/http.ts` carries the 429 retry with its
    // leaky-bucket self-throttle, and `inventory_levels/update` is a real topic.
    capabilities: {
      pushesProducts: true,
      pushesFulfillment: true,
      retriesRateLimit: true,
      inventoryWebhook: true,
    },

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

      // REST products.json omits collection membership — enrich each product with its
      // external collection ids from the per-run index (built once on the first page).
      const collectionIndex = await getCollectionIndex(creds, cursor);
      for (const product of products) {
        const refs = collectionIndex.get(product.externalId);
        if (refs && refs.length > 0) {
          product.collectionRefs = refs;
        }
      }

      const nextCursor = nextCursorFromLink(response.headers.link);
      return nextCursor ? { products, nextCursor } : { products };
    },

    /**
     * A NO-OP for Shopify (#220).
     *
     * A `products/*` delivery carries the product's full `variants` array, so
     * the webhook payload and a `products.json` entry are the same shape and
     * `normalizeProduct` reads both identically. The seam exists because
     * WooCommerce's delivery does NOT (it sends variation ids), and a provider
     * that needs no completion says so by returning the payload rather than by
     * the interface having an optional method somebody has to remember to check.
     */
    expandWebhookProduct: (_auth: ConnectorAuth, raw: unknown) => Promise.resolve(raw),

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

    /**
     * Page the shop's orders.
     *
     * ## This reaches back 60 DAYS and no further, and a truncated import is
     * indistinguishable from a complete one
     *
     * "Only the last 60 days' worth of orders from a store are accessible from
     * the Order resource by default" — Shopify's Order reference. Reaching
     * further needs `read_all_orders` BESIDE `read_orders`, and this connector
     * does not request it (`config.ts` `DEFAULT_SCOPES`).
     *
     * So the run reaches `completed`, the tallies are internally consistent, and
     * every imported order is correct. The only thing wrong is what is absent,
     * and nothing in the evidence says so — which for a merchant onboarding an
     * established shop is silently missing history at exactly the moment they
     * are deciding whether to trust the integration. `created=0` here also means
     * "no orders in 60 days", never "no orders".
     *
     * ## `read_all_orders` must NOT be added to the default scope set
     *
     * It is granted only on Shopify's written approval (Partner dashboard → app
     * → API access → request, with a justification, reviewed by Shopify). If it
     * is requested WITHOUT that approval, Shopify refuses the WHOLE grant rather
     * than narrowing it — so adding it to `DEFAULT_SCOPES` would break every
     * connect, for every deployment, until an approval landed. It is an operator
     * decision recorded per app, never a code default.
     *
     * ## Why the bound is not a field on the connection
     *
     * A surface that wants to say "orders before <date> were not imported" can
     * DERIVE it: `Connection.scopes` already carries what Shopify granted, so
     * the absence of `read_all_orders` is the whole of the fact and a stored
     * copy could only disagree with it. Rendering that is a dashboard change and
     * is not made here; what is fixed here is that the bound is written down
     * where the call is made instead of being inferable only from a scope list.
     */
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
      // Modern fulfillment-orders flow: read the order's fulfillment orders (each with
      // its line items + remaining `fulfillable_quantity`), then create ONE fulfillment
      // per open fulfillment order, listing the exact line items + quantities to ship.
      // This is line-level and idempotent: a fulfilled line's `fulfillable_quantity` is
      // 0, so a re-push (retry, or shipping the rest later) never re-fulfills a line, and
      // splitting an order across locations yields multiple fulfillment orders → multiple
      // fulfillments. `fulfillment.lines`, when present, restricts the push to those
      // Mercaria lines (matched to Shopify line items by variant id).
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

      const requestedByVariant = fulfillment.lines
        ? requestedQuantitiesByVariant(fulfillment.lines)
        : undefined;
      const trackingInfo = buildTrackingInfo(fulfillment);

      const openOrders = parsed.data.fulfillment_orders.filter(
        (fo) => fo.status != null && OPEN_FULFILLMENT_STATUSES.includes(fo.status),
      );
      for (const fo of openOrders) {
        const selections = selectFulfillmentLines(fo, requestedByVariant);
        if (selections.length === 0) {
          continue; // Nothing still fulfillable (or requested) here — skip, stay idempotent.
        }
        const body: Record<string, unknown> = {
          line_items_by_fulfillment_order: [
            { fulfillment_order_id: fo.id, fulfillment_order_line_items: selections },
          ],
          notify_customer: true,
        };
        if (trackingInfo) {
          body.tracking_info = trackingInfo;
        }
        const response = await transport.post(
          `${apiBase(auth.shopDomain)}/fulfillments.json`,
          headers,
          JSON.stringify({ fulfillment: body }),
        );
        assertOk(response, 'fulfillment create');
      }
    },

    listWebhooks(auth: ConnectorAuth): Promise<PlatformWebhookSubscription[]> {
      return listShopifyWebhooks(auth).then((probe) => {
        if (probe.outcome === 'refused') {
          throw validationError(
            `Shopify webhook list failed (${probe.reason}${
              probe.httpStatus === undefined ? '' : `, HTTP ${probe.httpStatus}`
            })`,
          );
        }
        return probe.value;
      });
    },

    /**
     * Shopify delivers every shop's events to ONE app-wide address, because the
     * app secret verifies them and the `X-Shopify-Shop-Domain` header resolves
     * the shop — there is no per-connection endpoint to build.
     *
     * The consequence, stated so a reader does not have to rediscover it: when
     * two Mercaria stores connect the SAME Shopify shop, their subscriptions ARE
     * each other's. Both reconciles adopt the same rows, both store the same
     * ids, and a disconnect of either deletes the subscriptions the other is
     * relying on until its next reconcile recreates them. That is already true
     * of the ids Mercaria stores today — `adoptExisting: true` plus one shared
     * address makes it unavoidable — so disconnect reading the platform's list
     * widens nothing. Separating them needs a per-connection address, which
     * Shopify's app-secret verification does not require and the ingress route
     * does not mount.
     */
    webhookDeliveryUrl(params: { address: string }) {
      return params.address;
    },

    /**
     * Register every topic, tolerating each refusal separately (#218).
     *
     * Shopify's secret is the APP secret, so a subscription an earlier
     * registration created still verifies — hence `adoptExisting: true`, which
     * also means a reconnect costs one `GET` rather than twelve calls.
     *
     * Adoption still means "at the address we serve, right now", and a
     * subscription this app created at a base URL the deployment has since left
     * is not that (#295) — it delivers to a hostname that answers nothing, and
     * Shopify removes it after enough consecutive failures without ever telling
     * Mercaria. `ownedSubscriptionIds` is how the reconcile recognises those and
     * takes them out; the app-wide secret is why replacing one costs nothing.
     */
    registerWebhooks(
      auth: ConnectorAuth,
      params: { address: string; ownedSubscriptionIds: readonly string[] },
    ) {
      const headers = {
        'X-Shopify-Access-Token': auth.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      return reconcileWebhookSubscriptions({
        topics: SHOPIFY_WEBHOOK_TOPICS,
        deliveryUrl: params.address,
        adoptExisting: true,
        ownedSubscriptionIds: params.ownedSubscriptionIds,
        list: () => listShopifyWebhooks(auth),
        create: async (topic) => {
          let response: ShopifyHttpResponse;
          try {
            response = await transport.post(
              `${apiBase(auth.shopDomain)}/webhooks.json`,
              headers,
              JSON.stringify({ webhook: { topic, address: params.address, format: 'json' } }),
            );
          } catch {
            return { outcome: 'refused', reason: 'transport_error' };
          }
          if (response.status < 200 || response.status >= 300) {
            return {
              outcome: 'refused',
              reason: classifyWebhookHttpStatus(response.status),
              httpStatus: response.status,
            };
          }
          const parsed = webhookResponseSchema.safeParse(safeParseJson(response));
          if (!parsed.success) {
            return {
              outcome: 'refused',
              reason: 'unexpected_response',
              httpStatus: response.status,
            };
          }
          return { outcome: 'ok', value: String(parsed.data.webhook.id) };
        },
        remove: async (id) => {
          let response: ShopifyHttpResponse;
          try {
            response = await transport.del(
              `${apiBase(auth.shopDomain)}/webhooks/${encodeURIComponent(id)}.json`,
              { 'X-Shopify-Access-Token': auth.accessToken, Accept: 'application/json' },
            );
          } catch {
            return { outcome: 'refused', reason: 'transport_error' };
          }
          // 404 = already gone, which is the outcome asked for (idempotent).
          if (response.status === 404 || (response.status >= 200 && response.status < 300)) {
            return { outcome: 'ok', value: undefined };
          }
          return {
            outcome: 'refused',
            reason: classifyWebhookHttpStatus(response.status),
            httpStatus: response.status,
          };
        },
      });
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
