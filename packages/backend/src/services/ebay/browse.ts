/**
 * The two Browse API operations this integration uses — issue #65 §"Which
 * ingestion modes eBay actually permits".
 *
 * `search` is discovery and `getItems` is verification. There is no third
 * operation, and in particular there is no Feed API call: the Feed API is a
 * Limited Release outside #64's decision, and reaching for it would be
 * simulating a capability the account does not have.
 *
 * ## Every call is BUDGETED before it is made
 *
 * The reservation happens in the adapter, before either function is entered, so
 * this module never has to remember. Both functions are otherwise pure
 * request/response: they compose a URL, add the marketplace and (optionally) the
 * attribution header, and translate a non-2xx into a classified framework
 * failure.
 *
 * ## `getItems` reports gone items per ID, and that distinction is load-bearing
 *
 * A whole-request 404 means the path is wrong. An item eBay no longer answers
 * for comes back as a per-id WARNING inside a 200 (or simply absent from
 * `items`), and that is the only signal the deletion obligation has. Reading a
 * transport failure as "the item is gone" would retire a catalogue during an
 * outage; reading a gone item as an outage would keep serving pages eBay
 * required Mercaria to delete. So this module reports the two separately and
 * never derives one from the other.
 */

import type { EbayMarketplaceId } from '@mercaria/shared-types';
import { EBAY_GET_ITEMS_MAX_IDS, EBAY_SEARCH_MAX_LIMIT } from '@mercaria/shared-types';
import {
  EBAY_API_HOST,
  EBAY_BROWSE_GET_ITEMS_PATH,
  EBAY_BROWSE_SEARCH_PATH,
  EBAY_ENDUSERCTX_HEADER,
  EBAY_MARKETPLACE_HEADER,
  EBAY_SEARCH_FIELDGROUPS,
} from './constants.js';
import { classifyEbayResponse, ebayParseFailure } from './errors.js';
import type { EbayTransport } from './http.js';
import type { EbayItem } from './normalize.js';

/** What every Browse call needs beyond its own arguments. */
export interface EbayBrowseContext {
  readonly transport: EbayTransport;
  readonly environment: 'sandbox' | 'production';
  readonly accessToken: string;
  readonly marketplaceId: EbayMarketplaceId;
  /** The `X-EBAY-C-ENDUSERCTX` value, or nothing when running unattributed. */
  readonly endUserContext: string | undefined;
  readonly now: Date;
}

/** One page of search results. */
export interface EbaySearchPage {
  readonly items: readonly EbayItem[];
  /** eBay's own total, when it published one. Used for evidence, never for control flow. */
  readonly total: number | undefined;
}

/** The result of one `getItems` batch: what is still live, and what is gone. */
export interface EbayGetItemsResult {
  readonly items: readonly EbayItem[];
  /**
   * Ids eBay POSITIVELY declared gone, by answering with a not-found warning.
   *
   * This is the only set that may become a #68 `AdapterRemoval`, because
   * `applyExplicitRemovals` retires from ANY run — a targeted batch included —
   * without waiting for a complete enumeration. Feeding it anything weaker
   * than a statement is the mass-expiry failure this whole domain is shaped
   * around, one phase later.
   */
  readonly removedIds: readonly string[];
  /**
   * Ids eBay neither described nor declared gone.
   *
   * Absence is not a statement: a truncated response, an item eBay declined to
   * serve to this marketplace and one it simply failed to describe all land
   * here, and none of them is evidence the listing ended. It feeds the
   * reconciliation sample, which repairs nothing.
   */
  readonly unansweredIds: readonly string[];
}

/**
 * eBay `errorId`s inside a 200 that mean THIS ITEM is gone.
 *
 * `11006` is the Browse API's per-item "item not found". It arrives in the
 * `warnings` array of an otherwise successful response, because a batch where
 * nineteen of twenty ids resolve is a success with a note about the twentieth.
 */
const EBAY_ITEM_NOT_FOUND_WARNING_IDS: readonly number[] = [11006];

/**
 * Read the ids eBay named in a not-found warning, defensively.
 *
 * Only ids that were actually REQUESTED are returned. eBay puts the offending
 * value in a `parameters` entry, and a provider that changes which parameter
 * carries it — or wraps it, or localises the surrounding message — degrades to
 * "no positive statement", which retires nothing. The failure direction is the
 * whole reason it is written this way: an id read wrongly out of a warning is
 * an item retired on a misparse.
 */
function readNotFoundIds(parsed: Record<string, unknown>, requested: readonly string[]): string[] {
  const warnings = parsed.warnings;
  if (!Array.isArray(warnings)) return [];
  const requestedSet = new Set(requested);
  const found: string[] = [];
  for (const warning of warnings) {
    if (warning === null || typeof warning !== 'object') continue;
    const { errorId, parameters } = warning as { errorId?: unknown; parameters?: unknown };
    if (typeof errorId !== 'number' || !EBAY_ITEM_NOT_FOUND_WARNING_IDS.includes(errorId)) continue;
    if (!Array.isArray(parameters)) continue;
    for (const parameter of parameters) {
      if (parameter === null || typeof parameter !== 'object') continue;
      const value = (parameter as { value?: unknown }).value;
      if (typeof value === 'string' && requestedSet.has(value)) found.push(value);
    }
  }
  return found;
}

function headersFor(context: EbayBrowseContext): Record<string, string> {
  return {
    Authorization: `Bearer ${context.accessToken}`,
    Accept: 'application/json',
    [EBAY_MARKETPLACE_HEADER]: context.marketplaceId,
    ...(context.endUserContext === undefined
      ? {}
      : { [EBAY_ENDUSERCTX_HEADER]: context.endUserContext }),
  };
}

function parseJsonObject(body: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw ebayParseFailure(context, 'response was not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ebayParseFailure(context, 'response was not an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * One page of a discovery query.
 *
 * `limit` is clamped to eBay's own maximum rather than passed through: #62 hands
 * the adapter `catalog_source_configs.page_size`, which is Mercaria's bound on a
 * page and knows nothing about eBay, and a request over the cap is answered with
 * an error rather than with fewer results.
 */
export async function ebaySearch(
  context: EbayBrowseContext,
  query: { kind: 'category' | 'keyword'; value: string; offset: number; limit: number },
): Promise<EbaySearchPage> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(query.limit, 1), EBAY_SEARCH_MAX_LIMIT)),
    offset: String(query.offset),
    fieldgroups: EBAY_SEARCH_FIELDGROUPS,
  });
  if (query.kind === 'category') params.set('category_ids', query.value);
  else params.set('q', query.value);

  const url = `https://${EBAY_API_HOST[context.environment]}${EBAY_BROWSE_SEARCH_PATH}?${params.toString()}`;
  const response = await context.transport.get(url, headersFor(context));
  if (response.status < 200 || response.status >= 300) {
    throw classifyEbayResponse({
      status: response.status,
      body: response.body,
      ...(response.headers['retry-after'] === undefined
        ? {}
        : { retryAfter: response.headers['retry-after'] }),
      now: context.now,
      context: 'eBay item_summary/search',
    });
  }

  const parsed = parseJsonObject(response.body, 'eBay item_summary/search');
  const summaries = parsed.itemSummaries;
  // An EMPTY result set is a legitimate answer (a category with nothing in it,
  // an offset past the end) and eBay omits the array entirely for it. Refusing
  // that would make the last page of every query a parse failure.
  const items = Array.isArray(summaries) ? (summaries as readonly EbayItem[]) : [];
  const total = parsed.total;
  return {
    items,
    total: typeof total === 'number' && Number.isSafeInteger(total) ? total : undefined,
  };
}

/**
 * Re-read up to twenty tracked items by id.
 *
 * The ids come from Mercaria's own record of what this source published, so this
 * is the operation that answers "is it still publicly available on eBay" — the
 * question the API License Agreement's deletion obligation turns on.
 *
 * The two ways an id can come back unanswered are kept APART, because #68 acts
 * on one of them and must never act on the other. A not-found WARNING is eBay
 * saying the listing is gone, which is the deletion trigger and becomes an
 * `AdapterRemoval`. Mere ABSENCE from `items` is not a statement about
 * anything, and is computed by difference precisely because it is the weaker
 * fact: "I asked for twenty and eBay described eighteen" cannot drift, and
 * cannot retire anything either.
 */
export async function ebayGetItems(
  context: EbayBrowseContext,
  itemIds: readonly string[],
): Promise<EbayGetItemsResult> {
  if (itemIds.length === 0) return { items: [], removedIds: [], unansweredIds: [] };
  if (itemIds.length > EBAY_GET_ITEMS_MAX_IDS) {
    // A caller batching wrong is a code defect, and eBay answers it with a 400
    // that reads as schema drift. Refusing here names the real cause.
    throw ebayParseFailure(
      'eBay item batch',
      `a getItems batch may carry at most ${EBAY_GET_ITEMS_MAX_IDS} ids`,
    );
  }

  const params = new URLSearchParams({ item_ids: itemIds.join(',') });
  const url = `https://${EBAY_API_HOST[context.environment]}${EBAY_BROWSE_GET_ITEMS_PATH}?${params.toString()}`;
  const response = await context.transport.get(url, headersFor(context));

  if (response.status < 200 || response.status >= 300) {
    throw classifyEbayResponse({
      status: response.status,
      body: response.body,
      ...(response.headers['retry-after'] === undefined
        ? {}
        : { retryAfter: response.headers['retry-after'] }),
      now: context.now,
      context: 'eBay item batch',
    });
  }

  const parsed = parseJsonObject(response.body, 'eBay item batch');
  const rawItems = parsed.items;
  const items = Array.isArray(rawItems) ? (rawItems as readonly EbayItem[]) : [];

  const returned = new Set<string>();
  for (const item of items) {
    if (typeof item?.itemId === 'string') returned.add(item.itemId);
    if (typeof item?.legacyItemId === 'string') returned.add(item.legacyItemId);
  }
  const notFound = new Set(readNotFoundIds(parsed, itemIds));
  return {
    items,
    removedIds: itemIds.filter((id) => notFound.has(id)),
    unansweredIds: itemIds.filter((id) => !returned.has(id) && !notFound.has(id)),
  };
}
