/**
 * The connector contract suite, driven against the REAL Shopify provider over a
 * fake Shopify REST Admin API.
 *
 * Everything between `connector-sync.service` and the socket is production code:
 * `createShopifyProvider` builds its own URLs, follows its own `Link` header,
 * parses its own zod schemas, converts its own decimal prices and runs its own
 * 429/leaky-bucket wrapper. What this file supplies is a server that answers
 * those URLs from a {@link ContractWorld} — and a fault schedule, which is the
 * only way to reach the paths a healthy store never takes.
 *
 * The transport is injected at the RAW layer (`createShopifyTransport(fake, …)`)
 * rather than replacing `shopifyTransport` wholesale, so the retry/throttle
 * wrapper under test is the shipped one. Its clock and sleep are stubbed, so a
 * `Retry-After` of ten seconds costs nothing.
 *
 * `getConnectorProvider` is the ONE thing mocked, because the registry is a
 * module-level constant with no registration function — and it deliberately has
 * none, since connectors are static (unlike ingestion adapters, which a flag
 * registers at boot). Adding a mutable registry so a test could write to it
 * would put a production seam in place for a test's convenience.
 */

import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import type { ConnectorProvider } from '../../types.js';
import {
  contractCatalogue,
  createContractWorld,
  pageSlice,
  type ContractOrder,
  type ContractProduct,
  type ContractWorld,
} from '../../__tests__/contract-world.js';
import { describeConnectorContract } from '../../__tests__/connector-contract-suite.js';
import { createShopifyProvider, shopifyProvider } from '../index.js';
import { createShopifyTransport, type ShopifyHttpResponse, type ShopifyTransport } from '../http.js';

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

/** The shop the fake serves. `*.myshopify.com` — the transport's host allowlist is real. */
const SHOP_DOMAIN = 'contract-suite.myshopify.com';
/**
 * The pinned Admin API version, mirrored from the provider so a bump breaks
 * loudly here.
 *
 * Deliberately a LITERAL rather than an import of `API_VERSION`. The world this
 * suite serves is a fake wire whose JSON shapes were written against one
 * version; importing the constant would let a version bump slide through green
 * while the fixtures still describe the version before it, which is the reverse
 * of what this file is for. Updating it is the prompt to ask whether the shapes
 * below were re-checked.
 *
 * For `2024-10` → `2025-10` they were not, and could not be. For `2025-10` →
 * `2026-07` they were checked against Shopify's CURRENT REST reference — every
 * field these fixtures emit is documented as present, and nothing here was
 * reshaped to make the bump pass.
 *
 * The bound on that claim is recorded on `API_VERSION` itself: only
 * `product-variant` was DIFFED between `2025-10` and `2026-07` (identical), the
 * other resources were read at `2026-07` alone, and no store exists to observe
 * (#69 acceptance 7, #286) — so nothing here has met the wire. A field that
 * changed MEANING while keeping its name is exactly what neither the reference
 * nor these fixtures can catch.
 */
const API_PREFIX = '/admin/api/2026-07';

/** A 200 with a JSON body and optional headers. */
function ok(body: unknown, headers: Record<string, string> = {}): ShopifyHttpResponse {
  return { status: 200, headers, body: JSON.stringify(body) };
}

/** Shopify's single-variant placeholder option, for a product that declares none. */
function shopifyOptions(product: ContractProduct): { name: string; values: string[] }[] {
  if (product.optionNames.length === 0) {
    return [{ name: 'Title', values: ['Default Title'] }];
  }
  return product.optionNames.map((name) => ({
    name,
    values: product.variants.flatMap((variant) =>
      variant.optionValues.filter((option) => option.name === name).map((option) => option.value),
    ),
  }));
}

/** Render one product as Shopify's REST `products.json` entry. */
export function shopifyProductJson(product: ContractProduct): Record<string, unknown> {
  return {
    id: product.externalId,
    title: product.title,
    body_html: product.description,
    vendor: product.vendor ?? null,
    product_type: product.productType ?? null,
    handle: product.handle ?? null,
    updated_at: product.updatedAt ?? null,
    options: shopifyOptions(product),
    images: product.imageUrls.map((src) => ({ src })),
    variants: product.variants.map((variant) => ({
      id: variant.externalVariantId,
      price: variant.price,
      compare_at_price: variant.compareAtPrice ?? null,
      sku: variant.sku ?? null,
      barcode: variant.barcode ?? null,
      inventory_item_id: variant.externalInventoryItemId,
      inventory_quantity: variant.available,
      inventory_management: 'shopify',
      // Shopify reports a single-variant product's placeholder value here, which
      // the provider recognises and drops — so a fixture that always sent a real
      // option name could not exercise that branch.
      option1: variant.optionValues[0]?.value ?? 'Default Title',
      option2: variant.optionValues[1]?.value ?? null,
      option3: variant.optionValues[2]?.value ?? null,
    })),
  };
}

/** A Shopify money set: the same amount on both sides, which is what a single-currency shop reports. */
function moneySet(amount: string, currency: string): Record<string, unknown> {
  return {
    shop_money: { amount, currency_code: currency },
    presentment_money: { amount, currency_code: currency },
  };
}

/** Render one order as Shopify's REST `orders.json` entry. */
export function shopifyOrderJson(order: ContractOrder, currency: string): Record<string, unknown> {
  return {
    id: order.externalId,
    name: order.number,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    currency,
    presentment_currency: currency,
    financial_status: order.financialStatus,
    fulfillment_status: order.fulfillmentStatus,
    subtotal_price_set: moneySet(order.subtotal, currency),
    total_tax_set: moneySet(order.tax, currency),
    total_discounts_set: moneySet(order.discountTotal, currency),
    total_shipping_price_set: moneySet(order.shipping, currency),
    total_price_set: moneySet(order.grandTotal, currency),
    customer: order.customer
      ? {
          id: order.customer.externalId,
          email: order.customer.email,
          first_name: order.customer.firstName,
          last_name: order.customer.lastName,
        }
      : null,
    line_items: order.lines.map((line, index) => ({
      id: `${order.externalId}-${index}`,
      product_id: line.externalProductId,
      variant_id: line.externalVariantId,
      title: line.title,
      variant_title: line.variantTitle,
      sku: line.sku ?? null,
      quantity: line.quantity,
      price_set: moneySet(line.unitPrice, currency),
    })),
    shipping_address: order.shippingAddress
      ? {
          name: order.shippingAddress.name,
          address1: order.shippingAddress.line1,
          city: order.shippingAddress.city,
          zip: order.shippingAddress.postalCode,
          country_code: order.shippingAddress.countryCode,
        }
      : null,
  };
}

/**
 * A `Link` header pointing at the next page, or nothing on the last one. The
 * provider parses this with a real regex + `URL`, so the header has to carry the
 * full shape Shopify sends rather than a bare cursor.
 */
function linkHeader(path: string, nextPage: number | undefined): Record<string, string> {
  if (nextPage === undefined) {
    return {};
  }
  return {
    link: `<https://${SHOP_DOMAIN}${API_PREFIX}/${path}?limit=250&page_info=${nextPage}>; rel="next"`,
  };
}

/** Serve `items` as Shopify would page them, keyed on the `page_info` cursor. */
function pagedResponse<T>(
  url: string,
  path: string,
  items: readonly T[],
  pageSize: number,
  render: (item: T) => unknown,
  key: string,
): ShopifyHttpResponse {
  const cursor = new URL(url).searchParams.get('page_info');
  const page = cursor ? Number(cursor) : 1;
  const slice = pageSlice(items, page, pageSize);
  const nextPage = page * pageSize < items.length ? page + 1 : undefined;
  return ok({ [key]: slice.map(render) }, linkHeader(path, nextPage));
}

/**
 * Build the fake Shopify REST server for `world`.
 *
 * Fulfillment state lives here rather than on the world because a "fulfillment
 * order" is a Shopify concept — WooCommerce has none — and the world is
 * deliberately provider-neutral. It is per-provider-instance, which is per world.
 */
function createShopifyFake(world: ContractWorld): ShopifyTransport {
  /** Units still fulfillable per external order id; absent means "not yet asked". */
  const fulfillable = new Map<string, number>();
  /** Never reused, even after a delete — see the create branch below. */
  let nextWebhookId = 0;

  function remainingFor(externalOrderId: string): number {
    const existing = fulfillable.get(externalOrderId);
    if (existing !== undefined) {
      return existing;
    }
    const order = world.orders.find((row) => row.externalId === externalOrderId);
    const units = order ? order.lines.reduce((total, line) => total + line.quantity, 0) : 0;
    fulfillable.set(externalOrderId, units);
    return units;
  }

  function answer(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: string,
  ): ShopifyHttpResponse {
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
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: string,
  ): ShopifyHttpResponse {
    const path = new URL(url).pathname;

    if (method === 'POST' && path === '/admin/oauth/access_token') {
      return ok({ access_token: 'shpat_contract_suite', scope: 'read_products,read_orders' });
    }
    if (path === `${API_PREFIX}/shop.json`) {
      return ok({
        shop: {
          id: world.externalShopId,
          myshopify_domain: SHOP_DOMAIN,
          currency: world.shopCurrency,
        },
      });
    }
    if (path === `${API_PREFIX}/products.json`) {
      if (method === 'POST') {
        world.pushedProducts.push(body ? JSON.parse(body) : null);
        return ok({ product: { id: `pushed-${world.pushedProducts.length}` } });
      }
      return pagedResponse(url, 'products.json', world.products, world.pageSize, shopifyProductJson, 'products');
    }
    if (method === 'PUT' && /^\/admin\/api\/[^/]+\/products\/[^/]+\.json$/.test(path)) {
      world.pushedProducts.push(body ? JSON.parse(body) : null);
      return ok({ product: { id: path.split('/').pop()?.replace('.json', '') ?? 'unknown' } });
    }
    // Custom-collection MEMBERSHIP (the flat product↔collection join).
    if (path === `${API_PREFIX}/collects.json`) {
      return ok({
        collects: world.collections
          .filter((c) => c.kind === 'custom')
          .flatMap((c) =>
            (c.productExternalIds ?? []).map((productId) => ({
              product_id: productId,
              collection_id: c.id,
            })),
          ),
      });
    }
    // SMART-collection membership, which `collects.json` never carries because it
    // is rule-derived. One request per smart collection, exactly as the real
    // provider issues.
    const smartProducts = /^\/admin\/api\/[^/]+\/collections\/([^/]+)\/products\.json$/.exec(path);
    if (smartProducts) {
      const collection = world.collections.find((c) => String(c.id) === smartProducts[1]);
      return ok({
        products: (collection?.productExternalIds ?? []).map((productId) => ({ id: productId })),
      });
    }
    // #376: the two collection LISTS. `buildCollectionIndex` reads
    // `smart_collections.json` for its ids and `collects.json` for membership;
    // `fetchCollections` reads both lists for their NAMES. Serving titles here is
    // what lets one world exercise both.
    if (path === `${API_PREFIX}/custom_collections.json`) {
      return ok({
        custom_collections: world.collections
          .filter((c) => c.kind === 'custom')
          .map((c) => ({ id: c.id, title: c.title })),
      });
    }
    if (path === `${API_PREFIX}/smart_collections.json`) {
      return ok({
        smart_collections: world.collections
          .filter((c) => c.kind === 'smart')
          .map((c) => ({ id: c.id, title: c.title })),
      });
    }
    if (path === `${API_PREFIX}/orders.json`) {
      return pagedResponse(
        url,
        'orders.json',
        world.orders,
        world.pageSize,
        (order) => shopifyOrderJson(order, world.shopCurrency),
        'orders',
      );
    }
    if (path === `${API_PREFIX}/inventory_levels.json`) {
      const requested = new Set(
        (new URL(url).searchParams.get('inventory_item_ids') ?? '').split(',').filter(Boolean),
      );
      const levels = world.products.flatMap((product) =>
        product.variants
          .filter((variant) => requested.has(variant.externalInventoryItemId))
          // Two locations, so the provider's SUM across locations is exercised
          // rather than a single row being passed through unchanged.
          .flatMap((variant) => [
            { inventory_item_id: variant.externalInventoryItemId, available: variant.available },
            { inventory_item_id: variant.externalInventoryItemId, available: 0 },
          ]),
      );
      return ok({ inventory_levels: levels });
    }
    const fulfillmentOrdersMatch = path.match(
      /^\/admin\/api\/[^/]+\/orders\/([^/]+)\/fulfillment_orders\.json$/,
    );
    if (fulfillmentOrdersMatch) {
      const externalOrderId = fulfillmentOrdersMatch[1];
      const order = world.orders.find((row) => row.externalId === externalOrderId);
      const remaining = remainingFor(externalOrderId);
      return ok({
        fulfillment_orders: [
          {
            id: `fo-${externalOrderId}`,
            status: 'open',
            line_items: (order?.lines ?? []).map((line, index) => ({
              id: `fol-${externalOrderId}-${index}`,
              variant_id: line.externalVariantId,
              quantity: line.quantity,
              // Once shipped, Shopify reports zero fulfillable units — which is
              // what makes a re-push a no-op rather than a second shipment.
              fulfillable_quantity: remaining > 0 ? line.quantity : 0,
            })),
          },
        ],
      });
    }
    if (method === 'POST' && path === `${API_PREFIX}/fulfillments.json`) {
      const parsed: unknown = body ? JSON.parse(body) : null;
      world.pushedFulfillments.push(parsed);
      for (const externalOrderId of fulfillable.keys()) {
        fulfillable.set(externalOrderId, 0);
      }
      return { status: 201, headers: {}, body: JSON.stringify({ fulfillment: { id: 'f-1' } }) };
    }
    if (path === `${API_PREFIX}/webhooks.json`) {
      if (method === 'POST') {
        const parsed = body
          ? (JSON.parse(body) as { webhook: { topic: string; address: string } })
          : null;
        // A monotonic counter rather than `length + 1`: reconciliation DELETES,
        // so a length-derived id would be reissued and two different
        // subscriptions would share one — which is exactly the state a
        // duplicate-suppression case must be able to tell apart from a correct
        // one.
        const id = `wh-${(nextWebhookId += 1)}`;
        world.webhooks.push({
          id,
          topic: parsed?.webhook.topic ?? 'unknown',
          deliveryUrl: parsed?.webhook.address ?? '',
          // Tracked in the world so a case can drive failed deliveries against
          // Shopify too, and DELIBERATELY not serialized below: Shopify's REST
          // webhook object publishes neither a status nor a failure count, so
          // Mercaria cannot learn from Shopify that a subscription died. That
          // asymmetry is measured rather than skipped — see the harness's
          // `publishesSubscriptionHealth`.
          status: 'active',
          failureCount: 0,
        });
        return ok({ webhook: { id } });
      }
      // `GET /webhooks.json` — what the shop actually holds, which is what
      // #218's reconciliation reads before it creates anything. PAGED with the
      // same `Link: rel="next"` header every other Shopify collection carries:
      // a fake that answered everything on one page could not tell a connector
      // that follows the cursor from one that reads the first page and concludes
      // those are all the subscriptions that exist.
      return pagedResponse(
        url,
        'webhooks.json',
        world.webhooks,
        world.pageSize,
        (webhook) => ({ id: webhook.id, topic: webhook.topic, address: webhook.deliveryUrl }),
        'webhooks',
      );
    }
    const webhookDeleteMatch = path.match(/^\/admin\/api\/[^/]+\/webhooks\/([^/]+)\.json$/);
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
      return ok({});
    }

    return { status: 404, headers: {}, body: JSON.stringify({ errors: `no route for ${path}` }) };
  }

  return {
    get: (url) => Promise.resolve(answer('GET', url)),
    post: (url, _headers, body) => Promise.resolve(answer('POST', url, body)),
    put: (url, _headers, body) => Promise.resolve(answer('PUT', url, body)),
    del: (url) => Promise.resolve(answer('DELETE', url)),
  };
}

describeConnectorContract({
  name: 'the Shopify connector',
  providerId: 'shopify',
  shopDomain: SHOP_DOMAIN,
  // A real fiat currency, never FAIR: a variant that came back priced in the
  // store's own default would be indistinguishable from a correct import if the
  // two were the same.
  shopCurrency: 'EUR',
  createProvider: (world) =>
    createShopifyProvider(
      // The SHIPPED rate-limit wrapper over the fake socket, with its clock and
      // sleep stubbed — so a `Retry-After` is honoured without a real timer.
      createShopifyTransport(createShopifyFake(world), {
        sleep: () => Promise.resolve(),
        now: () => 0,
      }),
    ),
  installProvider: (provider) => {
    installed = provider;
  },
  topics: {
    productUpsert: 'products/update',
    productDelete: 'products/delete',
    orderUpsert: 'orders/updated',
    inventoryUpdate: 'inventory_levels/update',
  },
  // The SHIPPED declarations, not copies of them — see the harness fields' notes.
  capabilities: shopifyProvider.capabilities,
  externalTaxonomyNoun: shopifyProvider.externalTaxonomyNoun,
  taxonomyNests: false,
  webhookSecretStrategy: shopifyProvider.webhookSecretStrategy,
  webhookPathFragment: '/webhooks.json',
  webhookDeletePathFragment: '/webhooks/',
  // Shopify's REST webhook object carries neither a status nor a failure count,
  // so a subscription Shopify stopped delivering is invisible to Mercaria until
  // Shopify removes it (#295). Declared rather than skipped, so the case runs
  // its own branch and would fail if this platform grew one and nobody read it.
  publishesSubscriptionHealth: false,
  // Shopify products DO carry `status` (`active`/`draft`/`archived`) — this
  // connector does not read it. `shopifyProductSchema` parses no such field and
  // `fetchProducts` sends no status filter, so NEITHER path here distinguishes a
  // published product from a draft one, and Mercaria is told nothing when a
  // merchant unpublishes.
  //
  // So this is `false` as a statement about the connector rather than about
  // Shopify, and #377 deliberately did not change it: unlike WooCommerce, whose
  // two paths enforced DIFFERENT rules, Shopify's two paths agree — and teaching
  // it to read `status` would change which products a live connection imports,
  // which is a separate decision with its own issue rather than a correction
  // that rides along. Declared rather than skipped so the branch is measured,
  // and so the day somebody adds the field this case is what says the sync
  // service was never taught to act on it.
  reportsPublishState: false,
  // Shopify publishes `barcode` on every variant and the provider maps it (#381).
  reportsVariantBarcode: true,
  createWorld: () => {
    const catalogue = contractCatalogue(uuidv7());
    return createContractWorld({
      shopCurrency: 'EUR',
      externalShopId: '77001',
      products: catalogue.products,
      orders: catalogue.orders,
      collections: catalogue.collections,
    });
  },
  webhookProductPayload: (world, externalId) => {
    const product = world.products.find((row) => row.externalId === externalId);
    if (!product) {
      throw new Error(`no product ${externalId} in the world`);
    }
    return shopifyProductJson(product);
  },
  webhookOrderPayload: (world, externalId) => {
    const order = world.orders.find((row) => row.externalId === externalId);
    if (!order) {
      throw new Error(`no order ${externalId} in the world`);
    }
    return shopifyOrderJson(order, world.shopCurrency);
  },
});

/**
 * The suite's own fault machinery, mutation-tested.
 *
 * Every "archives nothing" case rests on a scheduled fault actually reaching the
 * provider. A fault that silently matched no URL would make each of those cases
 * pass by measuring a healthy run — the exact shape of a check that cannot tell
 * success from failure. This asserts the fault fires, is CONSUMED, and stops.
 */
describe('the contract fault schedule', () => {
  it('answers exactly N requests and then serves normally again', async () => {
    const world = createContractWorld({
      shopCurrency: 'EUR',
      externalShopId: '77001',
      products: contractCatalogue(uuidv7()).products,
    });
    const transport = createShopifyFake(world);
    world.fail('/products', 429, 2, { 'retry-after': '0' });

    const url = `https://${SHOP_DOMAIN}${API_PREFIX}/products.json?limit=250`;
    const first = await transport.get(url, {});
    const second = await transport.get(url, {});
    const third = await transport.get(url, {});

    expect([first.status, second.status, third.status]).toEqual([429, 429, 200]);
    expect(world.callsMatching('/products').map((call) => call.status)).toEqual([429, 429, 200]);
  });

  it('leaves an unmatched fault alone rather than answering the wrong request', async () => {
    const world = createContractWorld({ shopCurrency: 'EUR', externalShopId: '77001' });
    const transport = createShopifyFake(world);
    world.fail('/orders', 500, 1);

    const response = await transport.get(`https://${SHOP_DOMAIN}${API_PREFIX}/shop.json`, {});

    expect(response.status).toBe(200);
  });
});
