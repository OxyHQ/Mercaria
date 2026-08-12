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
 * ## Two DECLARED differences from Shopify, both measured rather than skipped
 *
 * 1. `retriesRateLimit: false`. The WooCommerce transport has no 429 wrapper at
 *    all, where the Shopify one carries a `Retry-After`-honouring retry plus a
 *    leaky-bucket self-throttle. A WordPress host behind Cloudflare, Wordfence or
 *    a plan-level rate limit answers 429 routinely, so this is not theoretical.
 *    The suite asserts the CURRENT behaviour — the run fails and archives
 *    nothing — which is safe but is not what the issue's "pagination and retry"
 *    scenario asks for. Filed as its own issue; see the runbook.
 * 2. `pushesProducts` / `pushesFulfillment: false`. The provider rejects both by
 *    design: the Woo → Mercaria direction is the WordPress plugin's push-in path,
 *    not an outbound push from this pull connector.
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
import type { WooCommerceHttpResponse, WooCommerceTransport } from '../http.js';

/** The provider `getConnectorProvider` currently answers with. */
let installed: ConnectorProvider | undefined;

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
 * This is load-bearing rather than cosmetic. The provider reads these fields as
 * `new Date(\`${value}Z\`)`, which is right for what WooCommerce publishes and
 * yields an INVALID DATE for anything already carrying a zone. An invalid date
 * then reaches drizzle and throws inside the per-product import. A fixture that
 * sent `…10:00:00Z` would be testing a shape WooCommerce never sends, and
 * failing for a reason no real store would produce.
 */
function gmt(iso: string): string {
  return iso.replace(/Z$/, '');
}

/** True when a product needs WooCommerce's `variable` type (more than one variant). */
function isVariable(product: ContractProduct): boolean {
  return product.optionNames.length > 0 && product.variants.length > 1;
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
      return ok(pageSlice(world.products, page, world.pageSize).map(wooProductJson), {
        'x-wp-totalpages': String(totalPages(world.products, world.pageSize)),
      });
    }
    const variationsMatch = path.match(/^\/wp-json\/wc\/v3\/products\/([^/]+)\/variations$/);
    if (variationsMatch) {
      const product = world.products.find((row) => row.externalId === variationsMatch[1]);
      if (!product) {
        return ok([], { 'x-wp-totalpages': '1' });
      }
      return ok(
        product.variants.map((variant) => wooVariationJson(product, variant)),
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
  createProvider: (world) => createWooCommerceProvider(createWooCommerceFake(world)),
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
