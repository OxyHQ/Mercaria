/**
 * SHOPIFY STOREFRONTS — the shops on Shop (shop.app), read from the documents
 * Clarity crawls.
 *
 * Every product on shop.app belongs to a Shopify store, and every Shopify store
 * publishes its catalogue at `/products.json`: titles, descriptions, options,
 * every variant with its SKU, price, compare-at price and availability, and the
 * images.
 *
 * ## Clarity fetches; Mercaria reads
 *
 * Mercaria no longer requests a store. Clarity — Oxy's one crawler of stores —
 * polls each one as a `shopify_storefront` product feed under the store's
 * robots.txt for ClarityBot, at a shopper's pace, and keeps its `/meta.json`
 * and every `/products.json` product object exactly as served
 * (`services/clarity/product-feeds.ts`). This provider registers the store's
 * feed, pages through those objects and maps them with {@link toItems} — the
 * same mapping it always had, so every source object keeps its identity.
 *
 * ## One source per store
 *
 * The account ref is the store's domain, and the source is bound to that
 * store's merchant. The store's currency, country and name come from its own
 * `/meta.json`, read from the feed once per pass and carried in the cursor.
 * Until Clarity has read the store once, a pass finds nothing and says so.
 *
 * ## Identity
 *
 * There is no GTIN in `/products.json`. Each VARIANT is one record (its own
 * price and stock), and the Shopify product id is the `productGroupKey`, so the
 * variants of one product are seeded as one canonical product (ADR 0016).
 */

import type { NormalizedSourceRecord, OfferAvailability } from '@mercaria/shared-types';
import {
  OpenDataConfigurationError,
  OpenDataSchemaError,
  type OpenDataItem,
  type OpenDataPage,
  type OpenDataPageContext,
  type OpenDataProvider,
} from '../provider.js';
import {
  asArray,
  asNumber,
  asObject,
  asText,
  asTextList,
  decimalMoney,
  FactCollector,
} from '../read.js';
import { ensureProductFeed, productFeedRecords } from '../../clarity/product-feeds.js';

export const SHOPIFY_STOREFRONT_PROVIDER = 'shopify_storefront';

/** The most product documents one page asks Clarity for. */
const PAGE_CAP = 500;
const DESCRIPTION_CAP = 4_000;

export const shopifyStorefrontProvider: OpenDataProvider = {
  slug: SHOPIFY_STOREFRONT_PROVIDER,
  name: 'Tiendas Shopify (Shop)',
  homepage: 'https://shop.app',
  role: 'catalogue_and_prices',
  kind: 'feed',
  licence: 'provider_terms',
  attribution: 'Catálogo y precios publicados por la propia tienda',
  accountRefMeaning: 'the store domain (e.g. "pompeiibrand.com")',
  accountRefRequired: true,
  refreshModes: ['incremental'],
  // Clarity's API, not the store: the store's pace is Clarity's to keep.
  minRequestIntervalMs: 0,
  fetchPage: fetchStorefrontPage,
};

/** `example.com`, from whatever an operator typed: no scheme, no path, lower case. */
export function storeDomain(accountRef: string | null): string {
  const raw = (accountRef ?? '').trim().toLowerCase();
  const domain = raw.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(domain)) {
    throw new OpenDataConfigurationError(`"${accountRef ?? ''}" is not a store domain.`);
  }
  return domain;
}

interface StoreFacts {
  readonly name: string;
  readonly currency: string;
  readonly country: string | undefined;
}

/** The store's facts from its `/meta.json`, as Clarity holds it. */
export function storeFacts(meta: unknown, origin: string): StoreFacts {
  const body = asObject(meta);
  const currency = asText(body?.currency);
  if (body === undefined || currency === undefined || !/^[A-Z]{3}$/u.test(currency)) {
    throw new OpenDataSchemaError(
      `${origin}/meta.json names no currency; is this a Shopify store?`,
    );
  }
  return { name: asText(body.name) ?? origin, currency, country: asText(body.country) };
}

async function fetchStorefrontPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const domain = storeDomain(context.accountRef);
  const origin = `https://${domain}`;
  const feedId =
    typeof context.cursor?.f === 'string'
      ? context.cursor.f
      : (await ensureProductFeed('shopify_storefront', domain)).id;
  const page = await productFeedRecords(feedId, {
    ...(typeof context.cursor?.r === 'string' ? { cursor: context.cursor.r } : {}),
    limit: Math.min(Math.max(context.pageSize, 1), PAGE_CAP),
  });
  // Clarity has not read this store yet: nothing to map, and nothing proven gone.
  if (page.feed.meta === null) return { items: [], next: null, complete: false };

  const store: StoreFacts =
    typeof context.cursor?.c === 'string' && typeof context.cursor.n === 'string'
      ? {
          name: context.cursor.n,
          currency: context.cursor.c,
          country: typeof context.cursor.k === 'string' ? context.cursor.k : undefined,
        }
      : storeFacts(page.feed.meta, origin);

  const items: OpenDataItem[] = [];
  for (const record of page.records) {
    const product = asObject(record.payload);
    if (product === undefined) continue;
    items.push(
      ...toItems(product, { origin, store, territory: context.territories[0]?.toUpperCase() }),
    );
  }
  const next =
    page.nextCursor === null
      ? null
      : {
          f: feedId,
          r: page.nextCursor,
          c: store.currency,
          n: store.name,
          ...(store.country === undefined ? {} : { k: store.country }),
        };
  return { items, next, complete: false };
}

/** The visible text of a Shopify `body_html`: tags out, the common entities decoded, whitespace folded. */
export function htmlText(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .trim();
  return text === '' ? undefined : text.slice(0, DESCRIPTION_CAP);
}

/** A product with one option named "Title" holding "Default Title" has no real axes. */
function realOptionNames(product: Readonly<Record<string, unknown>>): string[] {
  const names = asArray(product.options)
    .map((option) => asText(asObject(option)?.name))
    .filter((name): name is string => name !== undefined);
  return names.length === 1 && names[0] === 'Title' ? [] : names;
}

export function toItems(
  product: Readonly<Record<string, unknown>>,
  context: {
    readonly origin: string;
    readonly store: StoreFacts;
    readonly territory: string | undefined;
  },
): OpenDataItem[] {
  const productId =
    asText(product.id) ?? (asNumber(product.id) === undefined ? undefined : String(product.id));
  const title = asText(product.title);
  const handle = asText(product.handle);
  if (productId === undefined || title === undefined || handle === undefined) return [];

  const optionNames = realOptionNames(product);
  const description = htmlText(asText(product.body_html));
  const vendor = asText(product.vendor);
  const productType = asText(product.product_type);
  const tags = Array.isArray(product.tags)
    ? asTextList(product.tags)
    : (asText(product.tags) ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '');
  const images = asArray(product.images)
    .map((image) => asObject(image))
    .filter((image): image is Readonly<Record<string, unknown>> => image !== undefined);

  const items: OpenDataItem[] = [];
  for (const entry of asArray(product.variants)) {
    const variant = asObject(entry);
    if (variant === undefined) continue;
    const variantId =
      asText(variant.id) ?? (asNumber(variant.id) === undefined ? undefined : String(variant.id));
    const price = decimalMoney(variant.price, context.store.currency);
    if (variantId === undefined || price === undefined) continue;
    const compareAt = decimalMoney(variant.compare_at_price, context.store.currency);

    const options = optionNames
      .map((name, index) => ({ name, value: asText(variant[`option${String(index + 1)}`]) }))
      .filter((option): option is { name: string; value: string } => option.value !== undefined);
    const variantImage = asText(asObject(variant.featured_image)?.src);
    const media = [variantImage, ...images.map((image) => asText(image.src))]
      .filter((src): src is string => src !== undefined)
      .filter((src, index, all) => all.indexOf(src) === index)
      .slice(0, 12);
    const available = variant.available;
    const availability: OfferAvailability =
      available === true ? 'in_stock' : available === false ? 'out_of_stock' : 'unknown';

    const facts = new FactCollector('shopify')
      .add('store', context.store.name)
      .add('store_domain', context.origin.replace(/^https:\/\//u, ''))
      .text('store_country', context.store.country)
      .add('product_id', productId)
      .add('variant_id', variantId)
      .add('handle', handle)
      .text('product_type', productType)
      .text('vendor', vendor)
      .add('tags', tags)
      .add('option_names', optionNames)
      .text('variant_title', variant.title)
      .number('weight', variant.grams, 'g')
      .flag('requires_shipping', variant.requires_shipping)
      .flag('taxable', variant.taxable)
      .text('published_at', product.published_at)
      .text('created_at', product.created_at)
      .text('updated_at', variant.updated_at ?? product.updated_at)
      .toArray();

    const sku = asText(variant.sku);
    const updatedAt = asText(variant.updated_at) ?? asText(product.updated_at);
    const normalized: NormalizedSourceRecord = {
      title,
      identifiers: [],
      options,
      productGroupKey: productId,
      media,
      merchantHint: context.store.name,
      ...(vendor === undefined ? {} : { brandHint: vendor }),
      ...(description === undefined ? {} : { description }),
      ...(sku === undefined ? {} : { merchantSku: sku }),
      price,
      ...(compareAt === undefined || compareAt.amount <= price.amount
        ? {}
        : { compareAtPrice: compareAt }),
      conditionLabel: 'new',
      availability,
      ...(context.territory === undefined ? {} : { country: context.territory }),
      ...(productType === undefined ? {} : { categoryKey: `shopify:${productType}` }),
      sourceUrl: `${context.origin}/products/${handle}?variant=${variantId}`,
      ...(updatedAt === undefined ? {} : { sourceUpdatedAt: updatedAt }),
      facts,
    };
    items.push({
      externalType: 'offer',
      externalId: variantId,
      normalized,
      ...(updatedAt === undefined || Number.isNaN(Date.parse(updatedAt))
        ? {}
        : { sourceUpdatedAt: new Date(updatedAt) }),
      raw: {
        productId,
        variantId,
        price: asText(variant.price) ?? null,
        available: available ?? null,
      },
    });
  }
  return items;
}
