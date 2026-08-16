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
 *    `X-WP-TotalPages` header when the site publishes a usable one, else by reading
 *    on until an EMPTY page — see `enumerationFinished`), fetching each variable
 *    product's variations from `/wc/v3/products/{id}/variations` and mapping them
 *    into variants.
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
  type ExternalCollection,
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
  PlatformWebhookSubscription,
  ShopIdentity,
  VariantSet,
} from '../types.js';
import {
  classifyWebhookHttpStatus,
  reconcileWebhookSubscriptions,
  type WebhookProbe,
} from '../webhook-registration.js';
import { toExternalCollection } from '../collections.js';
import { parseZonelessUtcTimestamp } from '../timestamps.js';
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
 * One row of `GET /products/categories` — the taxonomy PICKER's payload.
 *
 * Distinct from {@link wooCategorySchema}, which is a category as it appears
 * EMBEDDED on a product and where only the id is consumed. This one carries the
 * merchant-facing name, the hierarchy and the count, none of which a product's
 * embedded reference is required to include.
 *
 * `parent` is `0` at the root — WordPress's spelling of "no parent", not a term
 * with id zero — so it is resolved away rather than emitted as a parent id that
 * resolves to nothing.
 */
const wooCategoryListEntrySchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  parent: z.union([z.number(), z.string()]).optional(),
  count: z.number().optional(),
});

/** The `products/categories` response — a bare array. */
const wooCategoriesResponseSchema = z.array(wooCategoryListEntrySchema);

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
 * What ONE read of a product's variations endpoint gathered, and what it could
 * PROVE about it.
 *
 * `complete` is not a property of the variations — it is a property of the READ,
 * which is why it travels beside them rather than being re-derived downstream:
 * only the loop that issued the requests knows whether it saw an end. #259's
 * `pagination_unprovable` gap is this flag reaching `normalizeProduct`.
 */
const wooVariationEnumerationSchema = z.object({
  variations: z.array(wooVariationSchema),
  /** Whether the paged read PROVED it reached the end (see {@link enumerationFinished}). */
  complete: z.boolean(),
  /** How many pages it read getting there — the evidence in the refusal. */
  pagesRead: z.number().int().min(0),
});

/**
 * A WooCommerce product. `expandedVariations` is NOT a WooCommerce field — it is
 * the connector's expansion contract: `fetchProducts` fetches a `variable`
 * product's variations from the variations endpoint and passes them alongside the
 * product, and the pure `normalizeProduct` reads them when present.
 *
 * It carries the READ rather than a bare array (#259). A truncated variations
 * response and a complete one are the same list of objects; the difference is
 * whether the loop that produced it ever saw an end, and that fact only exists
 * where the requests were made.
 */
const wooProductSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  slug: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  type: z.string().default('simple'),
  /**
   * WooCommerce's publish state — `publish`, `draft`, `pending`, `private` or
   * `trash` (#377).
   *
   * Optional and NOT defaulted, because the two ways it can be missing want
   * opposite answers and only one of them is safe. A real WooCommerce product
   * always carries it; a payload that does not is a shape nobody has seen, and
   * reading that silence as a non-publish value would archive the listing. So an
   * absent status leaves {@link NormalizedProduct.publishState} absent, and the
   * sync service archives nothing.
   */
  status: z.string().nullable().optional(),
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
  /**
   * WooCommerce's own field: the IDS of this product's variations, and nothing
   * more. It is what a `product.*` webhook carries in place of the variation
   * objects, so it is exactly the evidence that a payload is INCOMPLETE rather
   * than describing a product with no variations (#220).
   */
  variations: z.array(z.union([z.number(), z.string()])).default([]),
  expandedVariations: wooVariationEnumerationSchema.optional(),
});

const productsResponseSchema = z.array(wooProductSchema);
const variationsResponseSchema = z.array(wooVariationSchema);

type WooProduct = z.infer<typeof wooProductSchema>;
type WooVariation = z.infer<typeof wooVariationSchema>;
type WooVariationEnumeration = z.infer<typeof wooVariationEnumerationSchema>;
type WooManageStock = z.infer<typeof wooManageStockSchema>;

/**
 * The expansion a product that was never asked about carries: nothing read, and
 * nothing proven. A `simple` product reaches `normalizeProduct` with this and is
 * mapped from its own price/stock fields; a product with a variation axis
 * reaches it with this only when the payload was never expanded, which is the
 * `declares_variants_and_carries_none` gap #220 found.
 */
const NO_VARIATION_EXPANSION: WooVariationEnumeration = {
  variations: [],
  complete: false,
  pagesRead: 0,
};

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

/**
 * Whether this product has a VARIATION AXIS at all — the discriminant every
 * completeness decision below turns on.
 *
 * Two independent statements, either of which is enough: WooCommerce's own
 * `type`, and its `variations` id list. Reading only the type misses a payload
 * whose type field a plugin rewrote; reading only the id list misses #259 case 1
 * (a `variable` product whose `variations` came back empty), which is exactly
 * the shape that used to fall through to `simpleVariant` and import a shirt with
 * four sizes as one option-less variant at the cheapest size's price.
 */
function carriesVariationAxis(product: WooProduct): boolean {
  return product.type === 'variable' || product.variations.length > 0;
}

/** Map a variable product's fetched variations into variants, priced in `shopCurrency`. */
function toVariants(
  product: WooProduct,
  shopCurrency: CurrencyCode,
  variations: readonly WooVariation[],
): NormalizedVariant[] {
  const parent: ParentStock = {
    tracked: product.manage_stock === true,
    quantity: product.stock_quantity ?? null,
  };
  return variations.map((v) => variationToVariant(v, shopCurrency, parent));
}

/** The ids appearing more than once in `ids`, each reported once, in order. */
function duplicatesOf(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicated.add(id);
    }
    seen.add(id);
  }
  return [...duplicated];
}

/**
 * Decide what a product's variations read PROVED — the whole of #259's
 * completeness rule for WooCommerce.
 *
 * A product with no variation axis is complete by construction: the parent IS
 * the variant, and WooCommerce publishes its price and stock on the product
 * itself. Everything else has to clear a comparison:
 *
 *  1. A variation id carried TWICE means the enumeration is not a set, so no
 *    conclusion drawn from it is safe — checked first, because a duplicate
 *    corrupts both of the comparisons below.
 *  2. A variation axis with NO usable variation is the #220 collapse: whether
 *    the payload named the ids (a webhook delivery nobody expanded) or named
 *    none at all (a `variable` product whose list came back empty), the honest
 *    answer is that this product's variants are unknown — never one synthetic
 *    variant at the parent's lowest-variation price.
 *  3. When the payload DECLARED ids, the declared and fetched sets must agree
 *    exactly. That comparison is DECISIVE and needs no pagination proof: a set
 *    that matches the platform's own manifest was fully read however many pages
 *    it took.
 *  4. With nothing declared, the read is the only evidence there is, so it has
 *    to have proven it reached the end itself.
 */
function resolveVariantSet(
  product: WooProduct,
  shopCurrency: CurrencyCode,
  expansion: WooVariationEnumeration,
): VariantSet {
  if (!carriesVariationAxis(product)) {
    return { enumeration: 'complete', variants: [simpleVariant(product, shopCurrency)] };
  }

  const declaredIds = product.variations.map((id) => String(id));
  const fetchedIds = expansion.variations.map((variation) => String(variation.id));

  const duplicates = duplicatesOf(fetchedIds);
  if (duplicates.length > 0) {
    return { enumeration: 'incomplete', gap: { kind: 'duplicate_fetched', duplicateIds: duplicates } };
  }
  if (fetchedIds.length === 0) {
    return {
      enumeration: 'incomplete',
      gap: { kind: 'declares_variants_and_carries_none', declared: declaredIds.length },
    };
  }

  if (declaredIds.length > 0) {
    const fetched = new Set(fetchedIds);
    const missingIds = declaredIds.filter((id) => !fetched.has(id));
    if (missingIds.length > 0) {
      return { enumeration: 'incomplete', gap: { kind: 'declared_not_fetched', missingIds } };
    }
    const declared = new Set(declaredIds);
    const unexpectedIds = fetchedIds.filter((id) => !declared.has(id));
    if (unexpectedIds.length > 0) {
      return { enumeration: 'incomplete', gap: { kind: 'fetched_not_declared', unexpectedIds } };
    }
    return {
      enumeration: 'complete',
      variants: toVariants(product, shopCurrency, expansion.variations),
    };
  }

  if (!expansion.complete) {
    return {
      enumeration: 'incomplete',
      gap: { kind: 'pagination_unprovable', pagesRead: expansion.pagesRead },
    };
  }
  return {
    enumeration: 'complete',
    variants: toVariants(product, shopCurrency, expansion.variations),
  };
}

/**
 * Map an already-parsed WooCommerce product (+ what its variations read proved)
 * to a `NormalizedProduct`.
 *
 * The completeness verdict lives HERE rather than at the webhook path, because
 * here it covers every caller: the pull path, the webhook path, and whatever
 * calls `normalizeProduct` next. It is a VALUE rather than a throw since #259 —
 * the sync service turns a gap into one bounded refusal, and the union is what
 * stops a consumer reading an unproven enumeration as a variant list. Before
 * #220 this function fell through to `simpleVariant` and produced one variant at
 * the parent's price (which WooCommerce sets to the LOWEST variation's),
 * carrying no option values and no stock, beside an option axis declaring
 * several values; nothing errored, the listing was created, and no later sync
 * could add the missing variants.
 */
function normalizeParsed(
  product: WooProduct,
  shopCurrency: CurrencyCode,
  expansion: WooVariationEnumeration,
): NormalizedProduct {
  const normalized: NormalizedProduct = {
    externalId: String(product.id),
    title: product.name,
    description: product.description ?? '',
    options: toOptions(product),
    imageUrls: product.images.map((img) => img.src),
    variants: resolveVariantSet(product, shopCurrency, expansion),
  };
  // WooCommerce's `*_gmt` fields carry no zone; a value that carries one anyway
  // is read AS its own offset rather than discarded (#221) — see
  // `connectors/timestamps.ts` for why discarding it erases stored freshness.
  const updatedAt = parseZonelessUtcTimestamp(product.date_modified_gmt ?? product.date_created_gmt);
  if (updatedAt) {
    normalized.externalUpdatedAt = updatedAt;
  }
  if (product.slug && product.slug.trim() !== '') {
    normalized.handle = product.slug;
  }
  // #377: the publish verdict is the exact complement of the filter the PULL
  // sends, derived from the SAME constant rather than restated. `PRODUCT_STATUS`
  // is what `fetchProductsPage` asks for, so "would the backfill have seen this
  // product" and "does this webhook say it is still on sale" cannot drift apart
  // into two rules — which is the whole defect: one path enforced a rule the
  // other did not. Every other WooCommerce status (`draft`, `pending`,
  // `private`, `trash`) is excluded from the pull and is therefore unpublished
  // here, with no list of them to keep in step with WordPress.
  if (product.status != null && product.status.trim() !== '') {
    normalized.publishState = product.status === PRODUCT_STATUS ? 'published' : 'unpublished';
  }
  const collectionRefs = product.categories.map((c) => String(c.id));
  if (collectionRefs.length > 0) {
    normalized.collectionRefs = collectionRefs;
  }
  return normalized;
}

/**
 * PURE: map a raw WooCommerce product into a `NormalizedProduct` in `shopCurrency`.
 * For a product with a variation axis, embed the variations read under
 * `expandedVariations` (as `fetchProducts` does); a product without one is
 * derived from its own price/stock fields.
 */
export function normalizeWooCommerceProduct(raw: unknown, shopCurrency: CurrencyCode): NormalizedProduct {
  const parsed = wooProductSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(`Malformed WooCommerce product: ${parsed.error.message}`);
  }
  return normalizeParsed(parsed.data, shopCurrency, parsed.data.expandedVariations ?? NO_VARIATION_EXPANSION);
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
  // The `*_gmt` reading rule, on the order path — see `normalizeParsed` above.
  const updatedAt = parseZonelessUtcTimestamp(order.date_modified_gmt ?? order.date_created_gmt);
  if (updatedAt) {
    normalized.externalUpdatedAt = updatedAt;
  }
  const createdAt = parseZonelessUtcTimestamp(order.date_created_gmt);
  if (createdAt) {
    normalized.createdAt = createdAt;
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

/**
 * The EXACT URL one connection's WooCommerce subscriptions deliver to.
 *
 * ONE spelling, read by `webhookDeliveryUrl` (which disconnect calls) and by
 * `registerWebhooks` (which reconciles against it). Two copies of this string
 * would let a reconcile and a disconnect disagree about which subscriptions
 * belong to a connection, and the direction they disagree in is either "delete
 * somebody else's" or "leave your own behind".
 */
function wooDeliveryUrl(params: { address: string; connectionId: string }): string {
  return `${params.address.replace(/\/+$/, '')}/${encodeURIComponent(params.connectionId)}`;
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

/**
 * `X-WP-TotalPages` as a FINITE INTEGER ≥ 1, or `undefined` when the site did
 * not publish a usable one.
 *
 * `undefined` is the whole point (#259). This header decides where every paged
 * read in this file ENDS, and defaulting an absent or malformed one to 1 makes a
 * FULL first page prove a complete enumeration — after which the products loop
 * hands `archiveUnseenSourcedListings` a complete-LOOKING set and soft-archives
 * the merchant's entire catalogue beyond page 1. WordPress caching and security
 * plugins strip response headers as ordinary configuration, so this is not an
 * exotic site.
 */
function declaredTotalPages(response: WooCommerceHttpResponse): number | undefined {
  const raw = response.headers['x-wp-totalpages'];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * Whether reading `page` FINISHED the enumeration — the only two proofs this
 * connector accepts.
 *
 *  - The site declared a total page count and the loop reached it.
 *  - The page came back EMPTY, which a site still holding rows cannot answer.
 *
 * A merely SHORT page is deliberately NOT a proof, and that is the one judgement
 * here worth defending. `per_page` is a REQUEST: a site is free to serve fewer
 * (a `rest_post_per_page` filter, a hardened host, a plugin), and then EVERY
 * page is short — so reading a short page as the end would stop a 5,000-product
 * catalogue after its first ten products and hand delete-reconciliation a set it
 * would archive 4,990 listings against. The empty-page rule costs exactly one
 * extra request per enumeration and only on a site that publishes no page count.
 *
 * `itemsOnPage < PAGE_LIMIT` is therefore the TIDY-UP to refuse. It reads as an
 * obvious optimisation — one request saved, and #259's own design brief proposed
 * it before this reasoning was measured against it — which is exactly why the
 * cost of adopting it is written down here rather than left to be rediscovered:
 * the failure it reintroduces is silent, arrives as a mass archive on somebody
 * else's shop, and no functional test of a healthy site can see it.
 * `woocommerce-provider.test.ts`'s "a SHORT page is NOT taken as the end either"
 * is the case that goes red.
 */
function enumerationFinished(
  response: WooCommerceHttpResponse,
  itemsOnPage: number,
  page: number,
): boolean {
  if (itemsOnPage === 0) {
    return true;
  }
  const declared = declaredTotalPages(response);
  return declared !== undefined && page >= declared;
}

/**
 * How many pages one enumeration reads before it refuses to keep going.
 *
 * The bound exists so a site answering full pages forever — a broken plugin, a
 * cache serving one page under every `page` parameter — cannot spin a sync run
 * indefinitely. At {@link PAGE_LIMIT} per page it admits 100,000 rows, which is
 * past any WooCommerce catalogue this connector is expected to read and short
 * enough that hitting it is evidence rather than patience.
 */
const MAX_ENUMERATION_PAGES = 1000;

/** The bounded refusal a paged read raises when it cannot prove it finished. */
function unprovableEnumeration(context: string, page: number): MercariaError {
  return validationError(
    `WooCommerce ${context} read ${page} pages without proving a complete enumeration ` +
      `(no usable X-WP-TotalPages header and no empty page) — refusing to treat it as complete`,
  );
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
 * `GET /webhooks` — every subscription this site currently holds.
 *
 * `status` and `failure_count` are #295's evidence, and both are read
 * DEFENSIVELY. WooCommerce core publishes `active | paused | disabled` and
 * increments `failure_count` on every failed delivery, disabling the
 * subscription itself past five (`includes/class-wc-webhook.php`,
 * `failed_delivery()`) — but a site running an old core, a fork or a REST
 * filter can answer with something else, and `.catch(undefined)` is what makes
 * an unrecognised value read as "this site did not say".
 *
 * That direction is deliberate and it is the safe-failing one: an unreadable
 * status delays a repair by one reconcile, where reading it as `disabled` would
 * put every subscription on every WooCommerce site through a delete-and-recreate
 * every six hours — and on a `per_connection` platform that rotates the secret
 * with them.
 */
const webhookListResponseSchema = z.array(
  z.object({
    id: z.union([z.number(), z.string()]),
    topic: z.string(),
    delivery_url: z.string().default(''),
    status: z.enum(['active', 'paused', 'disabled']).optional().catch(undefined),
    failure_count: z.coerce.number().int().nonnegative().optional().catch(undefined),
  }),
);

/**
 * Parse a JSON body, or `undefined` when it is not JSON.
 *
 * The webhook-registration path classifies an unreadable body as
 * `unexpected_response` rather than raising, so it needs the failure as a VALUE.
 * Every other caller wants the throw and uses {@link parseJson}.
 */
function safeParseJson(response: WooCommerceHttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

/**
 * Construct a WooCommerce provider over `transport`. The default transport is the
 * real SSRF-safe one; tests inject a fake to exercise the mapping/paging logic.
 */
export function createWooCommerceProvider(
  transport: WooCommerceTransport = wooCommerceTransport,
): ConnectorProvider {
  /**
   * `GET /webhooks`, as a PROBE rather than a throw.
   *
   * The registration path needs the refusal as a value — it turns it into one
   * failure per desired topic — while `listWebhooks` on the provider interface
   * is an ordinary read that raises. One request builder, two callers, so the
   * two cannot answer differently about what the site said.
   */
  async function listWooCommerceWebhooks(
    auth: ConnectorAuth,
  ): Promise<WebhookProbe<PlatformWebhookSubscription[]>> {
    const all: PlatformWebhookSubscription[] = [];
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({ per_page: String(PAGE_LIMIT), page: String(page) });
      let response: WooCommerceHttpResponse;
      try {
        response = await transport.get(
          `${apiBase(auth.shopDomain)}/webhooks?${params.toString()}`,
          authHeaders(auth),
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
        ...parsed.data.map((webhook) => ({
          id: String(webhook.id),
          topic: webhook.topic,
          deliveryUrl: webhook.delivery_url,
          // Both OMITTED rather than defaulted when the site published nothing
          // this schema recognises — `status: 'active'` would be a claim about a
          // subscription nobody asked, and `failureCount: 0` would report a
          // healthy delivery record that was never read.
          ...(webhook.status === undefined ? {} : { status: webhook.status }),
          ...(webhook.failure_count === undefined ? {} : { failureCount: webhook.failure_count }),
        })),
      );
      if (enumerationFinished(response, parsed.data.length, page)) {
        return { outcome: 'ok', value: all };
      }
      if (page >= MAX_ENUMERATION_PAGES) {
        // A subscription list this call could not finish reading must not be
        // reconciled against: #218's reconcile ADOPTS and DELETES from it, so a
        // truncated list is how a live subscription gets duplicated or dropped.
        return { outcome: 'refused', reason: 'unexpected_response', httpStatus: response.status };
      }
      page += 1;
    }
  }

  /**
   * Read every variation of a product, paginating the variations endpoint, and
   * report what the read PROVED (#259).
   *
   * A truncated read is returned rather than thrown: the parent payload's own
   * `variations` id list is usually a decisive check on it, so
   * `resolveVariantSet` — not this loop — is where the two pieces of evidence
   * meet. It is the caller's job to refuse; this one's is to say honestly how
   * far it got.
   */
  async function fetchAllVariations(
    auth: ConnectorAuth,
    productId: string,
  ): Promise<WooVariationEnumeration> {
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
      if (enumerationFinished(response, parsed.data.length, page)) {
        return { variations: all, complete: true, pagesRead: page };
      }
      if (page >= MAX_ENUMERATION_PAGES) {
        return { variations: all, complete: false, pagesRead: page };
      }
      page += 1;
    }
  }

  /**
   * Fetch ONE page of published products (raw + parsed) and say whether reading
   * it FINISHED the catalogue enumeration.
   *
   * Shared by `fetchProducts` (which normalizes each product) and
   * `fetchInventory` (which reads stock only), so both page the same `/products`
   * endpoint identically — including the completeness rule, which is what stops
   * the two disagreeing about where the catalogue ends.
   */
  async function fetchProductsPage(
    auth: ConnectorAuth,
    page: number,
  ): Promise<{ products: WooProduct[]; complete: boolean }> {
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
    return {
      products: parsed.data,
      complete: enumerationFinished(response, parsed.data.length, page),
    };
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
    // Read by the #69 contract suite AND by #87's channel catalog. Every `false`
    // here is measured rather than assumed: the suite asserts the REFUSAL on
    // each of these branches, so a capability that silently appeared or
    // disappeared cannot report the same green.
    //
    // `retriesRateLimit` is TRUE since #219: `createWooCommerceTransport` wraps
    // the raw layer with a `Retry-After`-honouring 429 retry. It is deliberately
    // NOT Shopify's full wrapper — WordPress publishes no leaky-bucket header,
    // so there is no proactive self-throttle to port and inventing one would be
    // Mercaria guessing somebody's hosting plan (see `http.ts`). The contract
    // suite's shared 429 case now asserts the retry rather than the failure, and
    // the retries are visible in the fake platform's call log.
    capabilities: {
      pushesProducts: false,
      pushesFulfillment: false,
      retriesRateLimit: true,
      inventoryWebhook: false,
    },

    // WooCommerce groups products into product CATEGORIES, which nest. Shopify's
    // collections are flat and are called collections. The model is shared —
    // both map onto a Mercaria `Collection` — and only the word differs, so a
    // merchant reads their own platform's vocabulary on the mapping screen.
    externalTaxonomyNoun: 'category',

    /**
     * Every product category the site publishes, with its name, parent and count.
     *
     * The ids are the SAME ones `normalizeWooCommerceProduct` writes into
     * `collectionRefs` from a product's embedded `categories[].id`, which is what
     * makes a picked category a key an import can actually match.
     *
     * Paged under the SAME completeness rule as the catalogue
     * (`enumerationFinished`), and for a sharper version of the same reason: a
     * SHORT page is not proof of the end on a site whose `per_page` is filtered,
     * and a truncated list here silently omits mappable categories from the
     * picker. That failure is invisible — the screen renders perfectly, and the
     * category a merchant is looking for simply is not in it. Unlike the
     * catalogue read, being unable to prove completeness is NOT fatal here:
     * refusing would leave the merchant with no picker at all, where returning
     * what was read leaves them with a usable one, so the bound is a stop rather
     * than a throw.
     */
    async fetchCollections(creds: ConnectorCredentials): Promise<ExternalCollection[]> {
      const collections: ExternalCollection[] = [];
      let page = 1;
      for (;;) {
        const params = new URLSearchParams({
          per_page: String(PAGE_LIMIT),
          page: String(page),
        });
        const response = await transport.get(
          `${apiBase(creds.shopDomain)}/products/categories?${params.toString()}`,
          authHeaders(creds),
        );
        assertOk(response, 'category list');
        const parsed = wooCategoriesResponseSchema.safeParse(
          parseJson(response, 'category list'),
        );
        if (!parsed.success) {
          throw validationError(
            `Unexpected WooCommerce categories payload: ${parsed.error.message}`,
          );
        }
        for (const category of parsed.data) {
          const parent = category.parent === undefined ? undefined : String(category.parent);
          collections.push(
            toExternalCollection(category.id, category.name, {
              // `0` is "root", not a term. Emitting it would hand the screen a
              // parent id that matches no row in its own list.
              ...(parent !== undefined && parent !== '0' ? { parentExternalId: parent } : {}),
              ...(category.count !== undefined ? { productCount: category.count } : {}),
            }),
          );
        }
        if (enumerationFinished(response, parsed.data.length, page) || page >= MAX_ENUMERATION_PAGES) {
          return collections;
        }
        page += 1;
      }
    },

    // WooCommerce authorizes with a static API key/secret (see connect-key), not
    // an OAuth authorize→callback exchange. `buildAuthorizeUrl` is synchronous, so
    // it throws; `exchangeCode` rejects.
    buildAuthorizeUrl: () => notImplemented('buildAuthorizeUrl'),
    exchangeCode: () => Promise.reject(notImplementedError('exchangeCode')),

    verifyConnection,

    async fetchProducts(creds: ConnectorCredentials, cursor?: string) {
      const page = pageFromCursor(cursor);
      const { products: rawProducts, complete } = await fetchProductsPage(creds, page);
      const products: NormalizedProduct[] = [];
      for (const product of rawProducts) {
        const expansion = carriesVariationAxis(product)
          ? await fetchAllVariations(creds, String(product.id))
          : NO_VARIATION_EXPANSION;
        products.push(normalizeParsed(product, creds.shopCurrency, expansion));
      }
      // #259: `nextCursor` is the CATALOGUE's completeness, and `runBackfill`
      // reaches `archiveUnseenSourcedListings` the moment it goes away. Absent
      // proof the loop keeps going; at the page bound it REFUSES, which fails
      // the run and archives nothing, rather than reporting an end it never saw.
      if (complete) {
        return { products };
      }
      if (page >= MAX_ENUMERATION_PAGES) {
        throw unprovableEnumeration('product list', page);
      }
      return { products, nextCursor: String(page + 1) };
    },

    /**
     * Fetch the variations a `product.*` delivery names but does not carry (#220).
     *
     * WooCommerce serializes `variations` as a list of IDS, so a variable
     * product's webhook payload declares an option axis it cannot price. This is
     * the extra call the delivery makes possible — it carries the product id, and
     * the connection already holds credentials — and its result is the SAME
     * `expandedVariations` contract `fetchProducts` fills, so the webhook path
     * and the backfill path normalize identically from here on.
     *
     * A payload that is already complete (a `simple` product, or one somebody
     * expanded upstream) is returned unchanged rather than re-fetched. A payload
     * this cannot parse is returned unchanged too: `normalizeProduct` owns the
     * refusal, and a second one here would be a different error for the same
     * fact. A fetch that FAILS throws, which fails the webhook run — nothing is
     * written and no listing is touched, which is the fail-closed half.
     */
    async expandWebhookProduct(auth: ConnectorAuth, raw: unknown): Promise<unknown> {
      const parsed = wooProductSchema.safeParse(raw);
      if (!parsed.success) {
        return raw;
      }
      const product = parsed.data;
      if (
        !carriesVariationAxis(product) ||
        (product.expandedVariations?.variations.length ?? 0) > 0
      ) {
        return raw;
      }
      const expandedVariations = await fetchAllVariations(auth, String(product.id));
      // Spread the ORIGINAL payload, not the parsed one: the parse drops every
      // field the schema does not name, and this value goes straight back into
      // `normalizeProduct`, which is the only thing entitled to decide what it
      // reads. A `raw` that is not an object cannot reach here — it would have
      // failed the parse above.
      return { ...(raw as Record<string, unknown>), expandedVariations };
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
      if (enumerationFinished(response, parsed.data.length, page)) {
        return { orders };
      }
      if (page >= MAX_ENUMERATION_PAGES) {
        throw unprovableEnumeration('order list', page);
      }
      return { orders, nextCursor: String(page + 1) };
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
        const { products, complete } = await fetchProductsPage(auth, page);
        for (const product of products) {
          if (carriesVariationAxis(product)) {
            const parent: ParentStock = {
              tracked: product.manage_stock === true,
              quantity: product.stock_quantity ?? null,
            };
            // A variations read that could not prove it finished simply reports
            // FEWER levels: an item with no level is omitted (the Shopify
            // semantics), so the variant keeps the stock it had rather than
            // being told a number nobody established.
            const { variations } = await fetchAllVariations(auth, String(product.id));
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
        if (complete) {
          return levels;
        }
        if (page >= MAX_ENUMERATION_PAGES) {
          throw unprovableEnumeration('inventory catalogue read', page);
        }
        page += 1;
      }
    },

    listWebhooks(auth: ConnectorAuth): Promise<PlatformWebhookSubscription[]> {
      return listWooCommerceWebhooks(auth).then((probe) => {
        if (probe.outcome === 'refused') {
          throw validationError(
            `WooCommerce webhook list failed (${probe.reason}${
              probe.httpStatus === undefined ? '' : `, HTTP ${probe.httpStatus}`
            })`,
          );
        }
        return probe.value;
      });
    },

    /**
     * A per-CONNECTION delivery URL so the ingress route
     * (`POST /channels/webhooks/woocommerce/:connectionId`) resolves the exact
     * connection, and thus its stored secret, for HMAC verification.
     *
     * It is also what SCOPES every reconcile and every disconnect: another
     * connection's subscriptions carry another id in this URL and the comparison
     * is EXACT, so they are never adopted and never deleted. Two sites connected
     * to one Mercaria store, or one site connected twice, stay independent.
     */
    webhookDeliveryUrl(params: { address: string; connectionId: string }) {
      return wooDeliveryUrl(params);
    },

    /**
     * Register every topic, tolerating each refusal separately (#218).
     *
     * `adoptExisting: false`, and that is forced rather than chosen: WooCommerce
     * fixes a webhook's `secret` AT CREATION and never discloses it again, so a
     * subscription left over from an earlier registration is signed with a
     * secret this call does not hold — every delivery would 401 forever, which
     * is #218's worst half. Deleting first is what makes the secret persisted
     * beside these ids verify every one of them.
     *
     * ## When a delete is REFUSED, the new secret is still stored, on purpose
     *
     * That leaves a live subscription for the blocked topic signed with the
     * PREVIOUS secret, whose deliveries 401. The alternative — keeping the old
     * secret — 401s every topic this attempt successfully recreated instead, so
     * both choices break something and only one CONVERGES: the merchant is
     * already told the blocked topic failed (it is in `failures`), its id is
     * retained so the next reconcile deletes it before recreating, and every
     * other topic works in the meantime. Keeping the old secret would instead
     * leave a shop whose registration succeeded verifying nothing, with the
     * failure attached to no topic at all.
     *
     * ## A DISPLACED subscription is deleted, never moved (#295)
     *
     * `ownedSubscriptionIds` names the subscriptions this connection created,
     * and after a base-URL change they are all at an address nobody serves —
     * disabled by WooCommerce itself past five failed deliveries, and staying
     * disabled once the address is fixed. `PUT /webhooks/{id}` could point one
     * back at the new URL and re-enable it, which is the tempting repair and is
     * the SAME bet `adoptExisting: false` already refuses: the secret Mercaria
     * holds is only PROVABLY the one a subscription carries when this code
     * created it with that secret, and nothing in a stored envelope says which
     * registration wrote it. Getting that bet wrong produces a subscription that
     * 401s on every delivery, permanently and silently. Deleting and creating
     * afresh costs one extra call and cannot.
     */
    registerWebhooks(
      auth: ConnectorAuth,
      params: {
        address: string;
        connectionId: string;
        secret?: string;
        ownedSubscriptionIds: readonly string[];
      },
    ) {
      if (!params.secret) {
        throw validationError('WooCommerce webhook registration requires a per-connection secret');
      }
      const secret = params.secret;
      const deliveryUrl = wooDeliveryUrl(params);
      const headers = { ...authHeaders(auth), 'Content-Type': 'application/json' };
      return reconcileWebhookSubscriptions({
        topics: REGISTERED_WEBHOOK_TOPICS,
        deliveryUrl,
        adoptExisting: false,
        ownedSubscriptionIds: params.ownedSubscriptionIds,
        list: () => listWooCommerceWebhooks(auth),
        create: async (topic) => {
          let response: WooCommerceHttpResponse;
          try {
            response = await transport.post(
              `${apiBase(auth.shopDomain)}/webhooks`,
              headers,
              JSON.stringify({
                name: `Mercaria ${topic}`,
                topic,
                delivery_url: deliveryUrl,
                secret,
                status: 'active',
              }),
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
          const parsed = webhookCreateResponseSchema.safeParse(safeParseJson(response));
          if (!parsed.success) {
            return {
              outcome: 'refused',
              reason: 'unexpected_response',
              httpStatus: response.status,
            };
          }
          return { outcome: 'ok', value: String(parsed.data.id) };
        },
        remove: async (id) => {
          let response: WooCommerceHttpResponse;
          try {
            response = await transport.del(
              `${apiBase(auth.shopDomain)}/webhooks/${encodeURIComponent(id)}?force=true`,
              authHeaders(auth),
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
