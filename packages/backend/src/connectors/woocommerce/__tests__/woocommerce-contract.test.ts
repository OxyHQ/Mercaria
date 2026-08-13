/**
 * The connector contract suite, driven against the REAL WooCommerce provider
 * over a fake `wc/v3` REST API.
 *
 * Same shape as the Shopify runner next door, and the same claim: everything
 * between `connector-sync.service` and the socket is production code, and the
 * database underneath it is a real Postgres server. What it cannot testify about
 * is a real WordPress site — see
 * `docs/runbooks/connector-real-store-verification.md`.
 *
 * The transport is injected at the RAW layer (`createWooCommerceTransport(fake,
 * …)`) rather than replacing `wooCommerceTransport` wholesale, so the 429 retry
 * under test is the shipped one. Its clock and sleep are stubbed, so a
 * `Retry-After` of ten seconds costs nothing.
 *
 * ## The DECLARED difference from Shopify, measured rather than skipped
 *
 * `pushesProducts` / `pushesFulfillment: false`. The provider rejects both by
 * design: the Woo → Mercaria direction is the WordPress plugin's push-in path,
 * not an outbound push from this pull connector. `retriesRateLimit` was the
 * other one until #219; it is `true` now, and the SAME shared case that asserted
 * the failed run asserts the retry — with the 429s visible in the fake's call
 * log, so "completed" cannot mean the fault never matched anything.
 *
 * ## The webhook payload here is the REAL shape, deliberately
 *
 * A WooCommerce `product.updated` delivery carries the product as WooCommerce
 * serializes it — with a `variations: [ids]` list and NO variation objects. It
 * does NOT carry `expandedVariations`, which is the connector's own expansion
 * contract filled in by `fetchProducts`. Sending the expanded shape here would
 * make the webhook path look like the backfill path, which is precisely the
 * difference a real store would have surfaced.
 */

import { vi } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { ConnectorProvider } from '../../types.js';
import {
  contractCatalogue,
  createContractWorld,
  pageOf,
  pageSlice,
  totalPages,
  type ContractOrder,
  type ContractProduct,
  type ContractWorld,
} from '../../__tests__/contract-world.js';
import { describeConnectorContract } from '../../__tests__/connector-contract-suite.js';
import { createWooCommerceProvider, wooCommerceProvider } from '../index.js';
import {
  createWooCommerceTransport,
  type WooCommerceHttpResponse,
  type WooCommerceTransport,
} from '../http.js';

/** The provider `getConnectorProvider` currently answers with. */
let installed: ConnectorProvider | undefined;

/**
 * Product ids whose variations endpoint UNDER-REPORTS, per world (#259).
 *
 * It lives in the runner rather than in `ContractWorld` because it is
 * WooCommerce vocabulary: what makes a variations response incomplete here is a
 * page of `/products/{id}/variations` that ends without the parent's whole
 * `variations` id list, and the world is deliberately provider-neutral. A
 * `WeakMap` because the suite hands the knob a WORLD and the fake that has to
 * honour it was built from that same world.
 */
const truncatedVariations = new WeakMap<ContractWorld, Set<string>>();

/**
 * Worlds whose `/products` responses carry NO `X-WP-TotalPages` (#259).
 *
 * A WordPress site behind a caching or security plugin that strips response
 * headers answers exactly like this: a correct body, a 200, and nothing saying
 * how many pages there are. It is a WooCommerce fault rather than a
 * provider-neutral one, so the knob lives in the runner.
 */
const suppressedPageHeaders = new WeakSet<ContractWorld>();

vi.mock('../../registry.js', () => ({
  getConnectorProvider: () => {
    if (!installed) {
      throw new Error('The contract suite must install a provider before the service runs');
    }
    return installed;
  },
  isImplementedProvider: () => true,
}));

/** The site the fake serves. The provider normalizes this to an https origin. */
const SITE = 'contract-suite.example.test';
/** The WooCommerce REST prefix the provider builds every URL from. */
const API_PREFIX = '/wp-json/wc/v3';

/** A 200 with a JSON body and optional headers. */
function ok(body: unknown, headers: Record<string, string> = {}): WooCommerceHttpResponse {
  return { status: 200, headers, body: JSON.stringify(body) };
}

/**
 * A `*_gmt` timestamp in WooCommerce's own shape — ISO-8601 with NO zone suffix.
 *
 * This is load-bearing rather than cosmetic. The provider appends `Z`, which is
 * right for what WooCommerce publishes; a value already carrying a zone would
 * produce `…+02:00Z`, which is not a date at all. Since #221 that is OMITTED
 * rather than assigned as an invalid `Date` (which used to reach drizzle and
 * throw inside the per-product import) — so a fixture sending `…10:00:00Z` would
 * now silently lose `externalUpdatedAt` on every product instead of failing, and
 * would be testing a shape WooCommerce never sends either way. The refusal
 * itself is measured in `woocommerce-normalize.test.ts`, where it can be seen.
 */
function gmt(iso: string): string {
  return iso.replace(/Z$/, '');
}

/**
 * True when a product needs WooCommerce's `variable` type — it has an option
 * axis, whatever number of variations currently sit on it.
 *
 * The variant COUNT is deliberately not part of this, and #259 is what made that
 * matter. Deleting a variation on a real WooCommerce site leaves the product
 * `variable` with one variation; a fake that flipped it to `simple` at one
 * variant republished the surviving variant under the PRODUCT's id instead of
 * its own variation id, so the removal case measured an identity change no
 * WooCommerce site produces — and passed only because the connector was matching
 * on SKU.
 */
function isVariable(product: ContractProduct): boolean {
  return product.optionNames.length > 0;
}

/**
 * The parent price WooCommerce publishes for a product. A `variable` parent
 * carries the LOWEST variation price and an empty `regular_price`, which is what
 * WooCommerce itself does — and what makes a variable product's webhook payload
 * incomplete.
 */
function parentPrice(product: ContractProduct): string {
  if (!isVariable(product)) {
    return product.variants[0].price;
  }
  return product.variants
    .map((variant) => variant.price)
    .reduce((lowest, price) => (Number(price) < Number(lowest) ? price : lowest));
}

/** Render one product as WooCommerce's REST `products` entry. */
function wooProductJson(product: ContractProduct): Record<string, unknown> {
  const variable = isVariable(product);
  return {
    id: product.externalId,
    name: product.title,
    slug: product.handle ?? null,
    description: product.description,
    type: variable ? 'variable' : 'simple',
    date_modified_gmt: product.updatedAt ? gmt(product.updatedAt) : null,
    sku: variable ? null : (product.variants[0].sku ?? null),
    price: parentPrice(product),
    regular_price: variable ? '' : (product.variants[0].compareAtPrice ?? ''),
    sale_price: variable ? '' : product.variants[0].compareAtPrice ? product.variants[0].price : '',
    // A simple product tracks its own stock; a variable parent leaves it to the
    // variations, which is the `manage_stock: 'parent'` branch the provider has.
    manage_stock: !variable,
    stock_quantity: variable ? null : product.variants[0].available,
    attributes: product.optionNames.map((name) => ({
      name,
      variation: true,
      options: product.variants.flatMap((variant) =>
        variant.optionValues.filter((option) => option.name === name).map((option) => option.value),
      ),
    })),
    images: product.imageUrls.map((src) => ({ src })),
    categories: [],
    // The id list a real delivery carries — enough to know variations EXIST and
    // not enough to price any of them.
    variations: variable ? product.variants.map((variant) => variant.externalVariantId) : [],
  };
}

/** Render one variant as WooCommerce's `products/{id}/variations` entry. */
function wooVariationJson(
  product: ContractProduct,
  variant: ContractProduct['variants'][number],
): Record<string, unknown> {
  return {
    id: variant.externalVariantId,
    price: variant.price,
    regular_price: variant.compareAtPrice ?? variant.price,
    sale_price: variant.compareAtPrice ? variant.price : '',
    sku: variant.sku ?? null,
    manage_stock: true,
    stock_quantity: variant.available,
    attributes: variant.optionValues.map((option) => ({ name: option.name, option: option.value })),
  };
}

/** Render one order as WooCommerce's REST `orders` entry. */
function wooOrderJson(order: ContractOrder, currency: string): Record<string, unknown> {
  return {
    id: order.externalId,
    number: order.number,
    status: order.financialStatus === 'paid' ? 'processing' : 'pending',
    currency,
    date_created_gmt: gmt(order.createdAt),
    date_modified_gmt: gmt(order.updatedAt),
    total: order.grandTotal,
    total_tax: order.tax,
    shipping_total: order.shipping,
    discount_total: order.discountTotal,
    customer_id: order.customer?.externalId ?? null,
    billing: order.customer
      ? {
          first_name: order.customer.firstName,
          last_name: order.customer.lastName,
          email: order.customer.email,
        }
      : null,
    shipping: order.shippingAddress
      ? {
          first_name: order.shippingAddress.name.split(' ')[0],
          last_name: order.shippingAddress.name.split(' ').slice(1).join(' '),
          address_1: order.shippingAddress.line1,
          city: order.shippingAddress.city,
          postcode: order.shippingAddress.postalCode,
          country: order.shippingAddress.countryCode,
        }
      : null,
    line_items: order.lines.map((line, index) => ({
      id: `${order.externalId}-${index}`,
      name: line.title,
      product_id: line.externalProductId,
      variation_id: line.externalVariantId,
      quantity: line.quantity,
      subtotal: (Number(line.unitPrice) * line.quantity).toFixed(2),
      total: (Number(line.unitPrice) * line.quantity).toFixed(2),
      sku: line.sku ?? null,
      meta_data: [],
    })),
    refunds: [],
  };
}

/** Build the fake WooCommerce REST server for `world`. */
function createWooCommerceFake(world: ContractWorld): WooCommerceTransport {
  /** Never reused, even after a delete — see the create branch below. */
  let nextWebhookId = 0;

  function answer(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: string,
  ): WooCommerceHttpResponse {
    const fault = world.takeFault(url, method);
    if (fault) {
      world.record({ method, url, status: fault.status });
      return { status: fault.status, headers: fault.headers, body: '{}' };
    }
    const response = route(method, url, body);
    world.record({ method, url, status: response.status });
    return response;
  }

  function route(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: string,
  ): WooCommerceHttpResponse {
    const path = new URL(url).pathname;

    if (path === `${API_PREFIX}/data/currencies/current`) {
      return ok({ code: world.shopCurrency });
    }
    if (path === `${API_PREFIX}/products`) {
      const page = pageOf(url, 'page');
      return ok(
        pageSlice(world.products, page, world.pageSize).map(wooProductJson),
        suppressedPageHeaders.has(world)
          ? {}
          : { 'x-wp-totalpages': String(totalPages(world.products, world.pageSize)) },
      );
    }
    const variationsMatch = path.match(/^\/wp-json\/wc\/v3\/products\/([^/]+)\/variations$/);
    if (variationsMatch) {
      const product = world.products.find((row) => row.externalId === variationsMatch[1]);
      if (!product) {
        return ok([], { 'x-wp-totalpages': '1' });
      }
      // A truncated read is a perfectly ordinary 200 that stops short — a
      // variations page a plugin dropped a row from, a cache serving a stale
      // first page. The PARENT still declares every id, which is what the
      // connector compares it against.
      const served = truncatedVariations.get(world)?.has(product.externalId)
        ? product.variants.slice(0, 1)
        : product.variants;
      return ok(
        served.map((variant) => wooVariationJson(product, variant)),
        { 'x-wp-totalpages': '1' },
      );
    }
    if (path === `${API_PREFIX}/orders`) {
      const page = pageOf(url, 'page');
      return ok(
        pageSlice(world.orders, page, world.pageSize).map((order) =>
          wooOrderJson(order, world.shopCurrency),
        ),
        { 'x-wp-totalpages': String(totalPages(world.orders, world.pageSize)) },
      );
    }
    if (path === `${API_PREFIX}/webhooks`) {
      if (method === 'POST') {
        const parsed = body
          ? (JSON.parse(body) as { topic: string; delivery_url: string; secret: string })
          : null;
        // A monotonic counter rather than `length + 1`: reconciliation DELETES
        // before it recreates, so a length-derived id would be reissued and two
        // different subscriptions would share one — which is exactly the state a
        // duplicate-suppression case must be able to tell apart from a correct one.
        const id = `wh-${(nextWebhookId += 1)}`;
        world.webhooks.push({
          id,
          topic: parsed?.topic ?? 'unknown',
          deliveryUrl: parsed?.delivery_url ?? '',
          ...(parsed?.secret ? { secret: parsed.secret } : {}),
        });
        return ok({ id });
      }
      // `GET /webhooks` — what the site actually holds, which is what #218's
      // reconciliation reads before it creates anything. WooCommerce paginates
      // it like every other collection, so the page header is real.
      return ok(
        world.webhooks.map((webhook) => ({
          id: webhook.id,
          topic: webhook.topic,
          delivery_url: webhook.deliveryUrl,
        })),
        { 'x-wp-totalpages': '1' },
      );
    }
    const webhookDeleteMatch = path.match(/^\/wp-json\/wc\/v3\/webhooks\/([^/]+)$/);
    if (method === 'DELETE' && webhookDeleteMatch) {
      const id = webhookDeleteMatch[1];
      world.deletedWebhookIds.push(id);
      // The fake's list has to MOVE, or a reconcile that deleted and recreated
      // would read the stale set on the next pass and every duplicate assertion
      // would be measuring the fixture rather than the connector.
      const index = world.webhooks.findIndex((webhook) => webhook.id === id);
      if (index >= 0) {
        world.webhooks.splice(index, 1);
      }
      return ok({ id });
    }

    return { status: 404, headers: {}, body: JSON.stringify({ message: `no route for ${path}` }) };
  }

  return {
    get: (url) => Promise.resolve(answer('GET', url)),
    post: (url, _headers, body) => Promise.resolve(answer('POST', url, body)),
    del: (url) => Promise.resolve(answer('DELETE', url)),
  };
}

describeConnectorContract({
  name: 'the WooCommerce connector',
  providerId: 'woocommerce',
  shopDomain: SITE,
  shopCurrency: 'GBP',
  createProvider: (world) =>
    createWooCommerceProvider(
      // The SHIPPED 429 retry over the fake socket, with its clock and sleep
      // stubbed — so a `Retry-After` is honoured without a real timer.
      createWooCommerceTransport(createWooCommerceFake(world), {
        sleep: () => Promise.resolve(),
        now: () => 0,
      }),
    ),
  installProvider: (provider) => {
    installed = provider;
  },
  topics: {
    productUpsert: 'product.updated',
    productDelete: 'product.deleted',
    orderUpsert: 'order.updated',
    // WooCommerce has no inventory webhook — a stock change fires
    // `product.updated`, so there is no topic to name here.
  },
  // The SHIPPED declarations, not copies of them — see the harness fields' notes.
  capabilities: wooCommerceProvider.capabilities,
  webhookSecretStrategy: wooCommerceProvider.webhookSecretStrategy,
  webhookPathFragment: '/webhooks',
  // A `product.*` delivery carries `variations` as IDS, so completing it means
  // fetching `/products/{id}/variations` (#220).
  webhookExpansionPathFragment: '/variations',
  suppressEnumerationProof: (world) => {
    suppressedPageHeaders.add(world);
  },
  truncateVariantEnumeration: (world, externalId) => {
    const ids = truncatedVariations.get(world) ?? new Set<string>();
    ids.add(externalId);
    truncatedVariations.set(world, ids);
  },
  createWorld: () => {
    const catalogue = contractCatalogue(uuidv7());
    return createContractWorld({
      shopCurrency: 'GBP',
      externalShopId: `https://${SITE}`,
      products: catalogue.products,
      orders: catalogue.orders,
    });
  },
  webhookProductPayload: (world, externalId) => {
    const product = world.products.find((row) => row.externalId === externalId);
    if (!product) {
      throw new Error(`no product ${externalId} in the world`);
    }
    return wooProductJson(product);
  },
  webhookOrderPayload: (world, externalId) => {
    const order = world.orders.find((row) => row.externalId === externalId);
    if (!order) {
      throw new Error(`no order ${externalId} in the world`);
    }
    return wooOrderJson(order, world.shopCurrency);
  },
});
