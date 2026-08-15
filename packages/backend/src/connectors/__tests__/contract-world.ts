/**
 * THE FAKE PLATFORM — a provider-neutral description of what a connected shop
 * currently holds, plus the faults it is currently returning.
 *
 * Issue #69 asks for real Shopify and WooCommerce development stores. Nothing in
 * this file is one, and it must not be read as one: a `ContractWorld` is a
 * catalogue, an order book and a fault schedule that each provider's harness
 * renders into ITS OWN REST dialect, so the connector contract suite can drive
 * the real provider, the real sync service and a real Postgres database with only
 * the SOCKET faked.
 *
 * ## What that buys, stated precisely so nobody over-claims it
 *
 * The nine mocked service suites next door mock the provider itself, so they
 * cannot see a URL that was never built, a `Link` header that was never followed,
 * a 429 that was never retried, a zod schema that rejects the platform's real
 * shape, or a CHECK the database would have refused. Everything between
 * `connector-sync.service` and the wire is REAL here, and so is the database
 * underneath it.
 *
 * What it CANNOT show is anything about the platforms themselves: that Shopify
 * really emits this `Link` header, that WooCommerce really reports `manage_stock`
 * this way, that a 5,000-product catalogue really completes inside the run's
 * lifetime, or that a real app's granted scopes cover the endpoints the connector
 * calls. Those are the manual scenarios in
 * `docs/runbooks/connector-real-store-verification.md`, and they stay manual.
 *
 * ## Faults are SCHEDULED, not toggled
 *
 * A fault says "answer the next N requests whose path contains this fragment with
 * this status". A boolean toggle cannot express the case the rate-limit wrapper
 * exists for — two 429s and then success — and a test that flips a boolean off
 * between calls is describing the test's own timing rather than the platform's.
 */

import type { CurrencyCode } from '@mercaria/shared-types';

/** One variant of a product on the fake platform, priced as the platform publishes it. */
export interface ContractVariant {
  /** The platform's own variant id. */
  readonly externalVariantId: string;
  /** The platform's inventory-item id (Shopify) or the variant id again (WooCommerce). */
  readonly externalInventoryItemId: string;
  /** Option assignments; empty for a single-variant product. */
  readonly optionValues: readonly { readonly name: string; readonly value: string }[];
  /** The effective selling price, in MAJOR units, exactly as a platform publishes it. */
  readonly price: string;
  /** The "was" price, in major units, when the item is on sale. */
  readonly compareAtPrice?: string;
  readonly sku?: string;
  readonly barcode?: string;
  /** Units available across every platform location. */
  readonly available: number;
}

/** A product on the fake platform. */
export interface ContractProduct {
  readonly externalId: string;
  readonly title: string;
  readonly description: string;
  readonly vendor?: string;
  readonly productType?: string;
  readonly handle?: string;
  /** The platform's `updated_at`, ISO-8601. */
  readonly updatedAt?: string;
  /** Absolute CDN image URLs, in gallery order. */
  readonly imageUrls: readonly string[];
  /** Option names; empty means the platform's single-variant placeholder. */
  readonly optionNames: readonly string[];
  readonly variants: readonly ContractVariant[];
}

/** One line of an order on the fake platform. */
export interface ContractOrderLine {
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly title: string;
  readonly variantTitle: string;
  readonly sku?: string;
  readonly quantity: number;
  /** Unit price in MAJOR units. */
  readonly unitPrice: string;
}

/** An order on the fake platform, with every money in MAJOR units. */
export interface ContractOrder {
  readonly externalId: string;
  readonly number: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The platform's own financial state. */
  readonly financialStatus: 'paid' | 'pending' | 'refunded';
  /** The platform's own fulfillment state; `null` means unfulfilled. */
  readonly fulfillmentStatus: 'fulfilled' | 'partial' | null;
  readonly lines: readonly ContractOrderLine[];
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly tax: string;
  readonly shipping: string;
  readonly grandTotal: string;
  readonly customer?: {
    readonly externalId: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
  };
  readonly shippingAddress?: {
    readonly name: string;
    readonly line1: string;
    readonly city: string;
    readonly postalCode: string;
    readonly countryCode: string;
  };
}

/** A scheduled fault: the next `times` requests matching `pathFragment` answer `status`. */
interface ScheduledFault {
  readonly pathFragment: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  /** When set, only this METHOD is faulted — see {@link ContractWorld.fail}. */
  readonly method?: ContractCall['method'];
  remaining: number;
}

/** One request the fake platform answered — the log a case reads to prove a retry happened. */
export interface ContractCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly status: number;
}

/** A webhook subscription the connector created on the fake platform. */
export interface ContractWebhook {
  readonly id: string;
  readonly topic: string;
  readonly deliveryUrl: string;
  readonly secret?: string;
}

/** The mutable state of one fake shop, plus everything a case needs to assert against. */
export interface ContractWorld {
  /** The currency the shop reports — NEVER FAIR, so a converted price is visible. */
  shopCurrency: CurrencyCode;
  /** The platform's own shop id. */
  readonly externalShopId: string;
  /** The catalogue. Mutate it between runs to model a merchant editing their shop. */
  products: ContractProduct[];
  /** The order book. */
  orders: ContractOrder[];
  /** How many products/orders one page carries — lower it to force pagination. */
  pageSize: number;
  /** Every request the fake answered, oldest first. */
  readonly calls: ContractCall[];
  /** Webhook subscriptions currently live on the platform. */
  readonly webhooks: ContractWebhook[];
  /** Webhook ids the connector asked the platform to delete. */
  readonly deletedWebhookIds: string[];
  /** Product bodies the connector PUSHED out, in order. */
  readonly pushedProducts: unknown[];
  /** Fulfillment bodies the connector PUSHED out, in order. */
  readonly pushedFulfillments: unknown[];
  /**
   * Schedule a fault. The next `times` requests whose URL contains `pathFragment`
   * are answered with `status` (and `headers`) instead of the real answer.
   *
   * `method` narrows it to one verb, and the webhook cases need that rather than
   * want it: both platforms serve the subscription LIST and the subscription
   * CREATE from the same path, so a fault keyed on the URL alone cannot express
   * "the platform refuses to create this topic" — it refuses the list too, and
   * the connector then correctly declines to create anything, which measures a
   * different property entirely.
   */
  fail(
    pathFragment: string,
    status: number,
    times: number,
    headers?: Record<string, string>,
    method?: ContractCall['method'],
  ): void;
  /** Consume a scheduled fault for `url`, or `undefined` when none applies. */
  takeFault(
    url: string,
    method?: ContractCall['method'],
  ): { status: number; headers: Record<string, string> } | undefined;
  /** Record an answered request. */
  record(call: ContractCall): void;
  /** How many requests the fake answered whose URL contains `pathFragment`. */
  callsMatching(pathFragment: string): ContractCall[];
}

/** Build a fake shop holding `products`, reporting `shopCurrency`. */
export function createContractWorld(init: {
  shopCurrency: CurrencyCode;
  externalShopId: string;
  products?: readonly ContractProduct[];
  orders?: readonly ContractOrder[];
  pageSize?: number;
}): ContractWorld {
  const faults: ScheduledFault[] = [];
  const calls: ContractCall[] = [];
  const webhooks: ContractWebhook[] = [];
  const deletedWebhookIds: string[] = [];
  const pushedProducts: unknown[] = [];
  const pushedFulfillments: unknown[] = [];

  return {
    shopCurrency: init.shopCurrency,
    externalShopId: init.externalShopId,
    products: [...(init.products ?? [])],
    orders: [...(init.orders ?? [])],
    pageSize: init.pageSize ?? 250,
    calls,
    webhooks,
    deletedWebhookIds,
    pushedProducts,
    pushedFulfillments,
    fail(pathFragment, status, times, headers = {}, method) {
      faults.push({
        pathFragment,
        status,
        headers,
        remaining: times,
        ...(method === undefined ? {} : { method }),
      });
    },
    takeFault(url, method) {
      const fault = faults.find(
        (f) =>
          f.remaining > 0 &&
          url.includes(f.pathFragment) &&
          (f.method === undefined || f.method === method),
      );
      if (!fault) {
        return undefined;
      }
      fault.remaining -= 1;
      return { status: fault.status, headers: fault.headers };
    },
    record(call) {
      calls.push(call);
    },
    callsMatching(pathFragment) {
      return calls.filter((call) => call.url.includes(pathFragment));
    },
  };
}

/**
 * The catalogue template BOTH harnesses serve, so the two platforms are measured
 * against the same shop rather than each against one that happens to suit it.
 *
 * It spans the distinctions the cases exist to make: a multi-variant product AND
 * a single-variant one (the platforms' single-variant placeholders differ), a
 * variant on sale (a compare-at price) and one that is not, tracked stock at two
 * different levels, and more than one image.
 *
 * NOTHING reads this directly — {@link contractCatalogue} namespaces its
 * platform-side identifiers first, so no assertion a case makes can resolve
 * against a neighbour's fixture in the shared database.
 */
const PRODUCT_TEMPLATES: readonly ContractProduct[] = [
  {
    externalId: '1001',
    title: 'Contract tee',
    description: '<p>A shirt that exists only in a test.</p>',
    vendor: 'Contract Goods',
    productType: 'Apparel',
    handle: 'contract-tee',
    updatedAt: '2026-08-01T10:00:00Z',
    imageUrls: [
      'https://cdn.example.test/contract-tee-front.jpg',
      'https://cdn.example.test/contract-tee-back.jpg',
    ],
    optionNames: ['Size'],
    variants: [
      {
        externalVariantId: '2001',
        externalInventoryItemId: '3001',
        optionValues: [{ name: 'Size', value: 'S' }],
        price: '19.99',
        compareAtPrice: '29.99',
        sku: 'TEE-S',
        barcode: '5012345678900',
        available: 5,
      },
      {
        externalVariantId: '2002',
        externalInventoryItemId: '3002',
        optionValues: [{ name: 'Size', value: 'M' }],
        price: '24.50',
        sku: 'TEE-M',
        available: 3,
      },
    ],
  },
  {
    externalId: '1002',
    title: 'Contract mug',
    description: '<p>Holds exactly one assertion.</p>',
    vendor: 'Contract Goods',
    handle: 'contract-mug',
    updatedAt: '2026-08-02T10:00:00Z',
    imageUrls: ['https://cdn.example.test/contract-mug.jpg'],
    optionNames: [],
    variants: [
      {
        externalVariantId: '2003',
        externalInventoryItemId: '3003',
        optionValues: [],
        price: '9.00',
        sku: 'MUG',
        available: 12,
      },
    ],
  },
];

/** The order-book template. Two orders, so a per-order case can NAME one. */
const ORDER_TEMPLATES: readonly ContractOrder[] = [
  {
    externalId: '5001',
    number: '#1001',
    createdAt: '2026-08-03T09:00:00Z',
    updatedAt: '2026-08-03T09:00:00Z',
    financialStatus: 'paid',
    fulfillmentStatus: null,
    lines: [
      {
        externalProductId: '1001',
        externalVariantId: '2001',
        title: 'Contract tee',
        variantTitle: 'S',
        sku: 'TEE-S',
        quantity: 2,
        unitPrice: '19.99',
      },
    ],
    subtotal: '39.98',
    discountTotal: '0.00',
    tax: '4.00',
    shipping: '5.00',
    grandTotal: '48.98',
    customer: {
      externalId: '9001',
      email: 'buyer@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
    shippingAddress: {
      name: 'Ada Lovelace',
      line1: '1 Analytical Way',
      city: 'London',
      postalCode: 'W1A 1AA',
      countryCode: 'GB',
    },
  },
  {
    externalId: '5002',
    number: '#1002',
    createdAt: '2026-08-04T09:00:00Z',
    updatedAt: '2026-08-04T09:00:00Z',
    financialStatus: 'pending',
    fulfillmentStatus: null,
    lines: [
      {
        externalProductId: '1002',
        externalVariantId: '2003',
        title: 'Contract mug',
        variantTitle: '',
        sku: 'MUG',
        quantity: 1,
        unitPrice: '9.00',
      },
    ],
    subtotal: '9.00',
    discountTotal: '0.00',
    tax: '0.90',
    shipping: '3.00',
    grandTotal: '12.90',
  },
];

/**
 * The templates above with every PLATFORM-SIDE identifier namespaced.
 *
 * One throwaway database serves the whole suite and vitest runs its files in
 * parallel workers, so a case's world has to be distinguishable from every
 * neighbour's. Product, variant, inventory-item and order ids are exactly what a
 * row is looked up BY — `findListingBySourceExternalId`,
 * `product_variants_source_external_variant_key`, the order provenance key — so
 * two worlds sharing one would let an assertion resolve against somebody else's
 * fixture.
 *
 * SKUs are deliberately NOT namespaced, and that is #296 rather than an
 * oversight. The only reason they ever were is that `product_variants_sku_key`
 * was a unique index over the WHOLE table, so two cases importing the same
 * fixture SKU collided and the second failed inside `createStoreProduct`, where
 * it read as a connector bug. That index is gone: a SKU is unique at no grain
 * now, and the one thing that reads a variant by SKU
 * (`findVariantsByListingAndSku`) is scoped to a single listing.
 *
 * The evidence that the namespacing tracked the INDEX and not any cross-case
 * read is `barcode` in the templates above. It was never namespaced at all,
 * under a unique that was equally table-wide — and nobody noticed, because
 * WooCommerce publishes no barcode, so only one runner ever wrote one and its
 * `afterEach` cleared it between cases.
 */
export function contractCatalogue(namespace: string): {
  products: ContractProduct[];
  orders: ContractOrder[];
} {
  const id = (value: string): string => `${value}-${namespace}`;
  return {
    products: PRODUCT_TEMPLATES.map((product) => ({
      ...product,
      externalId: id(product.externalId),
      variants: product.variants.map((variant) => ({
        ...variant,
        externalVariantId: id(variant.externalVariantId),
        externalInventoryItemId: id(variant.externalInventoryItemId),
      })),
    })),
    orders: ORDER_TEMPLATES.map((order) => ({
      ...order,
      externalId: id(order.externalId),
      lines: order.lines.map((line) => ({
        ...line,
        externalProductId: id(line.externalProductId),
        externalVariantId: id(line.externalVariantId),
      })),
    })),
  };
}

/** Read the page number a `page`/`page_info` style cursor addresses (1-based). */
export function pageOf(url: string, param: string): number {
  const value = new URL(url).searchParams.get(param);
  const page = value ? Number(value) : 1;
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

/** The slice of `items` belonging to 1-based `page`, at `pageSize` per page. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}

/** How many pages `items` spans at `pageSize` (never below 1). */
export function totalPages(items: readonly unknown[], pageSize: number): number {
  return Math.max(1, Math.ceil(items.length / pageSize));
}
