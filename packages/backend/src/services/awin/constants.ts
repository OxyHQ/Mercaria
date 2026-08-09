/**
 * How Mercaria reads an Awin feed: the column→role map, the parse options and
 * the network's own paths (#66).
 *
 * Everything here is a CODE constant, and the two that could plausibly have
 * been columns are the two worth arguing about:
 *
 * - **The column→role map.** A per-advertiser mapping table would be #63's
 *   configuration surface, which belongs to a STORE's own inventory arriving by
 *   file. An Awin advertiser has no store and no members, so there is nobody to
 *   own such a row — and Awin's column names are the NETWORK's, identical
 *   across every advertiser. What varies per advertiser is which of them are
 *   PRESENT, and that is measured from the feed's own header row rather than
 *   configured.
 * - **The paths.** `productdata.awin.com/datafeed/...` is Awin's published
 *   interface. The BASE URL is configurable (a staging host, a future
 *   migration); the path shape is not, because a configurable path is a
 *   configurable request and the key is in it.
 */

import type { FeedParseOptions } from '../feed-import/parse/types.js';
import type { AwinFeedColumn } from '@mercaria/shared-types';
import type { FeedFieldRole } from '@mercaria/shared-types';

/**
 * Awin's column names, mapped onto #63's roles.
 *
 * Read left to right, the entries that repay attention:
 *
 * - **`search_price` is the PRICE and `store_price` is not.** Awin's
 *   `search_price` is what a buyer pays including any promotion; `store_price`
 *   is the advertiser's own shelf price and `rrp_price` is the manufacturer's.
 *   #63's mapping engine already knows what to do with a sale price beside a
 *   list price — it puts the payable one on `price` and the other on
 *   `compareAtPrice` — so `store_price` maps to `price` and `search_price` to
 *   `sale_price`, and the engine's own rule produces the right pair. Getting
 *   this the other way round shows every discounted product at its
 *   undiscounted price on a comparison surface, which is the failure a shopper
 *   notices and Mercaria does not.
 * - **`merchant_deep_link` is the DESTINATION and `aw_deep_link` is the
 *   TRACKED one.** They are two different facts for the whole of their lives:
 *   #57 keeps `destination_url` as the ORIGINAL so disclosure and
 *   reconciliation have a stable answer no tracking layer can rewrite.
 * - **`aw_image_url` is deliberately NOT mapped to `image`.** It is Awin's own
 *   cached copy; `merchant_image_url` is the advertiser's, which is what
 *   `may_display_media` licenses and what stays correct when Awin's cache
 *   lapses.
 * - **`is_for_sale` is not mapped at all.** It is a second availability signal
 *   beside `in_stock`, and mapping both would give one row two answers to one
 *   question. The contradiction between them is MEASURED
 *   (`contradictoryAvailability`) rather than resolved, because picking a
 *   winner publishes a number Mercaria invented on a page that says the
 *   retailer said it.
 */
export const AWIN_COLUMN_ROLES: Readonly<Partial<Record<AwinFeedColumn, FeedFieldRole>>> = {
  product_name: 'title',
  description: 'description',
  brand_name: 'brand',
  model_number: 'model',
  category_name: 'category',
  ean: 'ean',
  upc: 'upc',
  isbn: 'isbn',
  mpn: 'mpn',
  merchant_product_id: 'sku',
  store_price: 'price',
  search_price: 'sale_price',
  currency: 'price_currency',
  in_stock: 'availability',
  stock_quantity: 'available_quantity',
  condition: 'condition',
  merchant_image_url: 'image',
  alternate_image: 'additional_images',
  merchant_deep_link: 'destination_url',
  aw_deep_link: 'affiliate_url',
  merchant_name: 'merchant',
  delivery_cost: 'delivery_cost',
  language: 'language',
  last_updated: 'source_updated_at',
  colour: 'option_value_1',
  size: 'option_value_2',
  material: 'option_value_3',
};

/**
 * The option AXIS names, supplied as constants because Awin's columns carry
 * only the values.
 *
 * #63's mapping engine reads an option as a `(name, value)` pair and drops the
 * pair when either half is missing, so `colour: 'Black'` with no name would be
 * silently discarded. The names are English because they name a Mercaria AXIS
 * and not a display label; #94's registry owns the human-facing vocabulary.
 */
export const AWIN_OPTION_AXIS_NAMES: Readonly<Record<'colour' | 'size' | 'material', string>> = {
  colour: 'Colour',
  size: 'Size',
  material: 'Material',
};

/**
 * The value translations Awin's `in_stock` needs.
 *
 * Awin publishes `1`/`0`, which #63's own synonym table does not contain — it
 * knows `in_stock`, `available`, `out of stock` and the rest, because those are
 * what a Google-Merchant-style feed writes. Supplying the two here rather than
 * widening #63's table keeps a network's spelling out of the universal
 * importer, which is the same reason the column map lives here.
 *
 * Keyed `${role}:${lower-cased source value}`, which is the shape
 * `ResolvedFeedMapping.valueMappings` reads.
 */
export const AWIN_VALUE_MAPPINGS: Readonly<Record<string, string>> = {
  'availability:1': 'in_stock',
  'availability:0': 'out_of_stock',
  'availability:yes': 'in_stock',
  'availability:no': 'out_of_stock',
  'availability:true': 'in_stock',
  'availability:false': 'out_of_stock',
};

/**
 * How an Awin feed is read.
 *
 * `maxRecordBytes` and `maxRecords` are supplied by the caller from
 * `config.feedImport`, so this deployment has ONE set of refusal thresholds for
 * every feed it reads rather than a second set that could disagree with #63's.
 */
export function awinParseOptions(limits: {
  maxRecordBytes: number;
  maxRecords: number;
}): FeedParseOptions {
  return {
    format: 'csv',
    delimiter: ',',
    quoteChar: '"',
    hasHeaderRow: true,
    recordPath: null,
    listSeparator: '|',
    maxRecordBytes: limits.maxRecordBytes,
    maxRecords: limits.maxRecords,
  };
}

/**
 * How Awin's FEED LIST is read.
 *
 * The same CSV shape at much smaller bounds: the list is one row per feed for
 * one publisher, so a hundred thousand of them is not a large network, it is a
 * malformed response. Refusing it early keeps a discovery pass from becoming a
 * memory incident.
 */
export const AWIN_FEED_LIST_PARSE_OPTIONS: FeedParseOptions = {
  format: 'csv',
  delimiter: ',',
  quoteChar: '"',
  hasHeaderRow: true,
  recordPath: null,
  listSeparator: '|',
  maxRecordBytes: 16 * 1024,
  maxRecords: 100_000,
};

/** How many bytes of feed list Mercaria will read before refusing. */
export const AWIN_FEED_LIST_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The list path, with the product-data key in it.
 *
 * A function rather than a template constant, so there is exactly one place the
 * key is placed into a URL — and that place returns a value the caller must
 * treat as a credential. It is never stored, never projected and never logged;
 * `redactFeedUrl` is what reaches any of those.
 */
export function awinFeedListUrl(baseUrl: string, feedApiKey: string): string {
  return `${trimTrailingSlash(baseUrl)}/datafeed/list/apikey/${encodeURIComponent(feedApiKey)}`;
}

/**
 * One feed's download URL.
 *
 * The column set is EXPLICIT rather than "all": Awin returns what is asked for,
 * so asking for a fixed list means a network that adds a column tomorrow
 * changes neither the bytes Mercaria reads nor the digest they hash to. That is
 * the same reasoning as #62's payload allow-list, applied to a request.
 */
export function awinFeedDownloadUrl(input: {
  baseUrl: string;
  feedApiKey: string;
  feedId: string;
  columns: readonly AwinFeedColumn[];
}): string {
  const query = new URLSearchParams({
    language: 'any',
    fid: input.feedId,
    columns: input.columns.join(','),
    format: 'csv',
    delimiter: ',',
    compression: 'gzip',
    adultcontent: '0',
  });
  return `${trimTrailingSlash(input.baseUrl)}/datafeed/download/apikey/${encodeURIComponent(
    input.feedApiKey,
  )}/?${query.toString()}`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
