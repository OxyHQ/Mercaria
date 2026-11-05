/**
 * Advanced merchandising rules — the paid `advanced_merchandising_rules` tool
 * (#89), and nothing a free store already has.
 *
 * Every store keeps, for free and exactly as before: manual and automated
 * collections, a collection's own `sortOrder`, featured collection shelves and
 * discounts. A merchandising rule is ADDITIONAL and applies to ONE surface only —
 * the store's own storefront page:
 *
 * - `sort` — the default order of the store page's grid (the whole store, or one
 *   collection): a strategy the free sort orders cannot express (best-selling by
 *   real units sold over a window, in-stock first) plus up to
 *   {@link MAX_MERCHANDISING_PINS} hand-pinned listings on top. It never writes
 *   `listing_collections`, so an automated collection's NULL positions and a
 *   manual collection's hand-picked order are untouched.
 * - `spotlight` — a shelf at the top of the store page showing a collection's
 *   first listings, optionally inside a time window (a drop that goes live at a
 *   set moment and comes down at another).
 *
 * Either kind may carry a schedule (`startsAt`/`endsAt`), evaluated when the
 * page is read — there is no worker.
 *
 * ## What a rule can never do
 *
 * Feed marketplace search, ranking, comparison, recommendations or any
 * cross-store surface (`MERCHANT_PLAN_FORBIDDEN_BENEFITS`). The vocabulary has no
 * field for a boost, a weight or a placement anywhere but the store's own page,
 * and the code that applies it is outside the ranking surface by construction.
 */

/** What a rule does. */
export const MERCHANDISING_RULE_KINDS = ['sort', 'spotlight'] as const;
export type MerchandisingRuleKind = (typeof MERCHANDISING_RULE_KINDS)[number];

/**
 * What a rule applies to: the store page's whole grid, or one collection.
 *
 * A `spotlight` always targets a collection. A `collection` rule whose
 * collection was deleted keeps its row (the allowance it holds is the merchant's
 * to give back by deleting it) and applies to nothing — `detached`.
 */
export const MERCHANDISING_RULE_TARGETS = ['store', 'collection'] as const;
export type MerchandisingRuleTarget = (typeof MERCHANDISING_RULE_TARGETS)[number];

/**
 * A `sort` rule's base order, after its pins (and in-stock first, when set).
 *
 * `best_selling` is units sold in PAID orders of this store over the rule's
 * window — the figure the free collection `best_selling` sort order cannot
 * compute (it falls back to newest-first).
 */
export const MERCHANDISING_SORT_STRATEGIES = [
  'best_selling',
  'newest',
  'price_asc',
  'price_desc',
] as const;
export type MerchandisingSortStrategy = (typeof MERCHANDISING_SORT_STRATEGIES)[number];

/** The best-selling windows the dashboard offers. The server accepts 1..365. */
export const MERCHANDISING_BEST_SELLING_WINDOW_PRESETS = [7, 30, 90] as const;
export const MIN_MERCHANDISING_BEST_SELLING_WINDOW_DAYS = 1;
export const MAX_MERCHANDISING_BEST_SELLING_WINDOW_DAYS = 365;

/** Pinned listings one `sort` rule may carry. */
export const MAX_MERCHANDISING_PINS = 24;

/** How many listings a spotlight shelf may show. */
export const MIN_MERCHANDISING_SPOTLIGHT_ITEMS = 1;
export const MAX_MERCHANDISING_SPOTLIGHT_ITEMS = 24;

/** How many spotlights the store page shows at once (most recently started first). */
export const MAX_LIVE_MERCHANDISING_SPOTLIGHTS = 3;

/** The largest page of merchandised listing ids the storefront reads at once. */
export const MAX_MERCHANDISED_PAGE_SIZE = 48;

/** The longest rule title. */
export const MAX_MERCHANDISING_RULE_TITLE_LENGTH = 120;

/**
 * Where a rule stands at one instant — DERIVED when read, never stored.
 *
 * - `live` — enabled, inside its window, and it is the one that applies;
 * - `superseded` — live, but another `sort` rule for the same target started
 *   later and wins (a scheduled override beats an always-on default);
 * - `scheduled` — its window has not started;
 * - `ended` — its window is over;
 * - `paused` — the merchant switched it off;
 * - `detached` — its collection was deleted.
 *
 * `applying` on the DTO is separate: a `live` rule of a store whose plan no
 * longer includes the tool is still `live` and is not applying.
 */
export const MERCHANDISING_RULE_STATUSES = [
  'live',
  'superseded',
  'scheduled',
  'ended',
  'paused',
  'detached',
] as const;
export type MerchandisingRuleStatus = (typeof MERCHANDISING_RULE_STATUSES)[number];

/** One merchandising rule, as the dashboard reads it. */
export interface MerchandisingRule {
  id: string;
  storeId: string;
  kind: MerchandisingRuleKind;
  title: string;
  target: MerchandisingRuleTarget;
  /** Set for a `collection` target; `null` for `store`, and for a detached rule. */
  collectionId: string | null;
  enabled: boolean;
  /** ISO-8601; `null` means "from now on". */
  startsAt: string | null;
  /** ISO-8601, exclusive; `null` means "until switched off". */
  endsAt: string | null;
  /** `sort` only. */
  sortStrategy: MerchandisingSortStrategy | null;
  /** `sort` with `best_selling` only. */
  bestSellingWindowDays: number | null;
  /** `sort` only; `false` on a spotlight. */
  inStockFirst: boolean;
  /** `sort` only: listing ids pinned on top, in order. Empty on a spotlight. */
  pinnedListingIds: string[];
  /** `spotlight` only. */
  spotlightItemLimit: number | null;
  status: MerchandisingRuleStatus;
  /** Whether the store page uses this rule right now (status `live` AND the plan includes the tool). */
  applying: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `POST /admin/stores/:storeId/merchandising/rules`. */
export interface CreateMerchandisingRuleInput {
  kind: MerchandisingRuleKind;
  title: string;
  target: MerchandisingRuleTarget;
  collectionId?: string;
  enabled?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  sortStrategy?: MerchandisingSortStrategy;
  bestSellingWindowDays?: number;
  inStockFirst?: boolean;
  pinnedListingIds?: string[];
  spotlightItemLimit?: number;
}

/**
 * `PATCH /admin/stores/:storeId/merchandising/rules/:id`.
 *
 * `kind`, `target` and `collectionId` are fixed once a rule exists: a different
 * one is a different rule.
 */
export interface UpdateMerchandisingRuleInput {
  title?: string;
  enabled?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  sortStrategy?: MerchandisingSortStrategy;
  bestSellingWindowDays?: number | null;
  inStockFirst?: boolean;
  pinnedListingIds?: string[];
  spotlightItemLimit?: number;
}

/** `POST /admin/stores/:storeId/merchandising/preview` — a draft `sort` rule, unsaved. */
export interface MerchandisingPreviewInput {
  target: MerchandisingRuleTarget;
  collectionId?: string;
  sortStrategy: MerchandisingSortStrategy;
  bestSellingWindowDays?: number;
  inStockFirst?: boolean;
  pinnedListingIds?: string[];
  limit?: number;
}

/** One listing in a preview, with the facts that put it where it is. */
export interface MerchandisingPreviewItem {
  listingId: string;
  title: string;
  imageFileId: string | null;
  pinned: boolean;
  inStock: boolean;
  /** Units sold over the window; `null` unless the strategy is `best_selling`. */
  unitsSold: number | null;
  /** Native minor units; `null` when the listing has no priced variant. */
  priceMinAmount: number | null;
  priceCurrency: string | null;
}

export interface MerchandisingPreview {
  items: MerchandisingPreviewItem[];
  total: number;
}

/** A live spotlight, as the store page renders it. */
export interface StorefrontSpotlight {
  ruleId: string;
  title: string;
  collectionId: string;
  /** In display order; hydrate with `GET /stores/:handle/listings?ids=`. */
  listingIds: string[];
}

/**
 * `GET /stores/:handle/merchandising` — what the store page applies right now.
 *
 * Empty when the store has no live rule or its plan no longer includes the
 * tool: the page then renders exactly what it renders for every store.
 */
export interface StorefrontMerchandising {
  /** Whether the whole-store grid has a live `sort` rule. */
  storeSorted: boolean;
  /** Published collections with a live `sort` rule. */
  sortedCollectionIds: string[];
  spotlights: StorefrontSpotlight[];
}

/**
 * `GET /stores/:handle/merchandising/listings` — one page of the merchandised order.
 *
 * `applied: false` (with no ids) when no rule applies to that target now — the
 * rule ended, was paused, or the plan no longer includes the tool — and the page
 * falls back to the order every store gets.
 */
export interface StorefrontMerchandisedPage {
  applied: boolean;
  listingIds: string[];
  page: number;
  limit: number;
  total: number;
  hasNextPage: boolean;
}
