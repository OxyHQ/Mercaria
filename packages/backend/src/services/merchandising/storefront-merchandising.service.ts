/**
 * What the paid merchandising rules change on the store's OWN storefront page,
 * evaluated when the page is read.
 *
 * ## The one surface, and the wall around it
 *
 * The answers here are read by exactly one client: the store page
 * (`/stores/:handle` in the storefront), through
 * `GET /stores/:handle/merchandising*`. They are NOT read by marketplace search,
 * the home feed, ranking, comparison or any other store's page — a plan never
 * buys reach (`MERCHANT_PLAN_FORBIDDEN_BENEFITS`). That is structural rather than
 * a promise: this module and the controller that serves it import no ordering
 * engine (`listingRepository`, `catalog-hydration`, `services/ranking|search`), so
 * they are outside the derived ranking surface (`__tests__/ranking-surface.ts`),
 * and no module of that surface imports them (`merchant-plan-isolation.test.ts`,
 * `merchandising-rules-isolation.test.ts`). The page hydrates the ids answered
 * here through the free `GET /stores/:handle/listings?ids=`, which reads no rule.
 *
 * ## When the plan ends
 *
 * Every read asks `holdsCapability` first. A store without the tool gets the
 * empty answer — no sorted target, no spotlight — and its page renders exactly
 * what every store's does. No rule is deleted or changed; they apply again the
 * moment the plan includes the tool again.
 */

import {
  MAX_MERCHANDISED_PAGE_SIZE,
  type StorefrontMerchandisedPage,
  type StorefrontMerchandising,
  type StorefrontSpotlight,
} from '@mercaria/shared-types';
import {
  findCollectionProductsSlice,
  findCollectionsByStore,
  type CollectionRecord,
} from '../../db/merchandising/collectionRepository.js';
import {
  findMerchandisingRulesByStore,
  orderStoreListings,
  type MerchandisingRuleRow,
} from '../../db/merchandising/merchandisingRuleRepository.js';
import { holdsCapability } from '../entitlements/enforce.js';
import { MERCHANDISING_CAPABILITY, type Clock } from './merchandising-rule.service.js';
import { applyingRules } from './rule-evaluation.js';

const NOTHING_APPLIES: StorefrontMerchandising = {
  storeSorted: false,
  sortedCollectionIds: [],
  spotlights: [],
};

/** The rules that apply now, restricted to what the public page can show. */
async function applying(
  storeId: string,
  at: Date,
): Promise<{
  sorts: MerchandisingRuleRow[];
  spotlights: MerchandisingRuleRow[];
  published: Map<string, CollectionRecord>;
} | null> {
  if (!(await holdsCapability({ storeId, capability: MERCHANDISING_CAPABILITY, at }))) {
    return null;
  }
  const rules = await findMerchandisingRulesByStore(storeId);
  if (rules.length === 0) return { sorts: [], spotlights: [], published: new Map() };
  const published = new Map(
    (await findCollectionsByStore(storeId, { publishedOnly: true })).map((c) => [c.id, c]),
  );
  // A collection the page does not show (unpublished) is never merchandised on
  // it: the grid must never become a way to list an unpublished collection.
  const shown = (rule: MerchandisingRuleRow) =>
    rule.target === 'store' || (rule.collectionId !== null && published.has(rule.collectionId));
  const { sorts, spotlights } = applyingRules(rules, at);
  return { sorts: sorts.filter(shown), spotlights: spotlights.filter(shown), published };
}

/** Listing ids in a `sort` rule's order. */
async function orderedIds(
  rule: MerchandisingRuleRow,
  at: Date,
  offset: number,
  limit: number,
): Promise<{ ids: string[]; total: number }> {
  const { rows, total } = await orderStoreListings({
    storeId: rule.storeId,
    collectionId: rule.target === 'collection' ? rule.collectionId : null,
    strategy: rule.sortStrategy ?? 'newest',
    bestSellingWindowDays: rule.bestSellingWindowDays,
    inStockFirst: rule.inStockFirst,
    pinnedListingIds: rule.pinnedListingIds,
    at,
    offset,
    limit,
  });
  return { ids: rows.map((row) => row.listingId), total };
}

/** `GET /stores/:handle/merchandising` — what the page applies right now. */
export async function readStorefrontMerchandising(
  storeId: string,
  clock: Clock = {},
): Promise<StorefrontMerchandising> {
  const at = clock.at ?? new Date();
  const live = await applying(storeId, at);
  if (live === null) return NOTHING_APPLIES;

  const sortFor = new Map(
    live.sorts
      .filter((rule) => rule.target === 'collection' && rule.collectionId !== null)
      .map((rule) => [rule.collectionId as string, rule]),
  );

  const spotlights: StorefrontSpotlight[] = [];
  for (const rule of live.spotlights) {
    const collection = live.published.get(rule.collectionId ?? '');
    if (!collection) continue;
    const limit = rule.spotlightItemLimit ?? 1;
    // The shelf shows the collection in the order the page itself would: its
    // own `sort` rule when one applies, the collection's free order otherwise.
    const sort = sortFor.get(collection.id);
    const listingIds = sort
      ? (await orderedIds(sort, at, 0, limit)).ids
      : (
          await findCollectionProductsSlice(
            collection.id,
            collection.sortOrder,
            collection.type === 'manual',
            0,
            limit,
          )
        ).rows.map((row) => row.id);
    if (listingIds.length === 0) continue;
    spotlights.push({
      ruleId: rule.id,
      title: rule.title,
      collectionId: collection.id,
      listingIds,
    });
  }

  return {
    storeSorted: live.sorts.some((rule) => rule.target === 'store'),
    sortedCollectionIds: [...sortFor.keys()],
    spotlights,
  };
}

/**
 * `GET /stores/:handle/merchandising/listings` — one page of the grid in the
 * applying `sort` rule's order, or `applied: false` when none applies.
 */
export async function readMerchandisedPage(
  storeId: string,
  request: { collectionId: string | null; page: number; limit: number },
  clock: Clock = {},
): Promise<StorefrontMerchandisedPage> {
  const at = clock.at ?? new Date();
  const limit = Math.max(1, Math.min(request.limit, MAX_MERCHANDISED_PAGE_SIZE));
  const page = Math.max(1, request.page);
  const notApplied: StorefrontMerchandisedPage = {
    applied: false,
    listingIds: [],
    page,
    limit,
    total: 0,
    hasNextPage: false,
  };
  const live = await applying(storeId, at);
  if (live === null) return notApplied;
  const rule = live.sorts.find((candidate) =>
    request.collectionId === null
      ? candidate.target === 'store'
      : candidate.target === 'collection' && candidate.collectionId === request.collectionId,
  );
  if (!rule) return notApplied;
  const { ids, total } = await orderedIds(rule, at, (page - 1) * limit, limit);
  return {
    applied: true,
    listingIds: ids,
    page,
    limit,
    total,
    hasNextPage: page * limit < total,
  };
}
