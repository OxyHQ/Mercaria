# Discovery: explore, category and deals as one feed

The design record is `docs/superpowers/specs/2026-09-07-discovery-feed-design.md`
— read it for the reasoning behind each decision below. This doc is for
someone who has to CHANGE the backend half of it: `services/discovery/`,
`db/discovery/`, `db/schema/discovery.ts`, `routes/discovery.ts` and
`routes/internal-discovery.ts`.

## One contract, three scopes

`GET /discovery/feed?scope=` serves all three storefront pages:

```
scope=root                → /categories        (explore)
scope=category:<handle>   → /categories/:handle (a category landing)
scope=deals                → /deals
```

`routes/discovery.ts`'s Zod schema parses the query string into a
`DiscoveryScope` discriminated union
(`{ kind: 'root' } | { kind: 'category'; handle } | { kind: 'deals' }`);
`services/discovery/feed.service.ts`'s `getDiscoveryFeed(scope, viewerId?)`
turns that into an ordered `DiscoveryFeed` (`{ sections: DiscoverySection[] }`).
A fourth screen later is a new `scope`, not a new feed — the section machine
and the card set (`ProductSummary`, `StoreSummary`, `CategoryTile`) are shared
with the rest of the catalogue and reused unchanged.

`viewerId` is optional (`optionalAuth`, matching `routes/feed.ts`) and drives
only `saved`; the route is otherwise public.

## Why `discovery`, not `feed`

`feed` already names two unrelated things in this repo — the home feed
(`services/feed.service.ts`) and the supplier product-feed importer
(`services/feed-import/`, `db/feedImport/`) — and `AGENTS.md` already carries
the scar from the last time one word covered two domains ("report" is sales
analytics AND abuse reports; the fix was never to merge them). A third
`feed` would be the same mistake a third time, so this domain, its schema and
its docs are all named `discovery` instead. `GET /feed` (the home feed) is
untouched by any of this.

## A curation is a signal applied to a scope, not an editorial row

There is no admin panel behind these pages and this domain adds none. What
looks editorial in the reference (bordered cards titled "Top rated", "What's
new", "Bestsellers") is one derived ordering per scope, wearing an id — so
here a "curation" is **a `DiscoverySignal` applied to a scope**, addressable
at `/categories/[handle]/s/[signal]`, and `DISCOVERY_SIGNALS`
(`@mercaria/shared-types`) is the closed tuple that renders the CHECK on every
column that stores one.

Each shelf orders by exactly ONE column and its title names that column —
deliberately no composite score. When two shelves disagree, a reader can see
why; a weight nobody can see is a weight nobody can review.

## The five signals split three ways

| signal | orders by | reads |
| --- | --- | --- |
| `top-rated` | `listings.rating` desc, above `config.discovery.topRatedMinReviews` | `listings` |
| `new` | `listings.published_at` desc | `listings` |
| `on-sale` | a discounted variant | `listings`, via `findOnSaleListings` |
| `best-selling` | `discovery_signals.units_sold` desc | `discovery_signals` |
| `most-viewed` | `discovery_signals.view_count` desc | `discovery_signals` |

`DISCOVERY_SIGNALS_FROM_LISTINGS` (`top-rated`, `new`, `on-sale`) read
`listings` directly and page the FULL result set —
`db/discovery/discoveryReadRepository.ts`'s `findListingsBySignal` delegates
each to a durable, already-indexed column. `DISCOVERY_SIGNALS_FROM_COUNTS`
(`best-selling`, `most-viewed`) join `discovery_signals` instead and page only
as deep as the sweep counted (`config.discovery.topNPerCategory`, 60 by
default) — an empty scope in that table is an empty shelf, never a fallback to
every listing in the category. `DiscoverySectionPageDepth` (`'complete'` vs
`'capped'`) reports this on the wire rather than leaving a client to discover
it by hitting the end of a page early.

`rating` and `review_count` are not columns on `discovery_signals` — a
minimum-review floor gates `top-rated` entry (a single five-star review must
not outrank four thousand), but the rating itself stays a live read off
`listings.rating`, which is already `review_aggregates`' projection. A third
copy of a rating is a third place for it to disagree, and the isolation gate
below asserts this structurally, not just by convention.

## `discovery_signals`: one row per ANCESTOR, and `''` for root

Only `best-selling` and `most-viewed` need a table at all — the other three
are durable columns on `listings`. `discovery_signals` (`db/schema/discovery.ts`)
carries `subject_type` (`'listing' | 'store'`), a polymorphic `subject_id`
(no FK — a store id or a listing id), `category_id`, `window` (one member
today, `'30d'`), `units_sold`, `order_count`, `view_count` and `computed_at`,
unique on `(subject_type, subject_id, category_id, window)`.

`listings.category_id` is the leaf, but a shelf can render at any depth
("Bestsellers in Beauty" is the CATEGORY's shelf, not the leaf sub-category
under it). Rather than a recursive tree walk joined to a count on every
request, `services/discovery/sweep.ts` writes each counted subject once per
category on its OWN ancestor chain — read off `categories.ancestor_ids`, the
taxonomy's existing authority for that walk, never re-derived here — so a
shelf at any depth is one indexed read, and a parent's figure IS its
subtree's total by construction rather than by a second query agreeing with
the first.

`category_id = ''` is the root scope, and it is a real string, not `NULL`.
Postgres treats `NULL` as distinct in a unique index, so a nullable dimension
would both break the uniqueness the sweep depends on and let a row exist that
belongs to no scope at all — `analytics_rollups` already states the same
reason for the same convention one domain over.

Every write is deduplicated before it reaches `replaceWindow`
(`db/discovery/discoverySignalRepository.ts`): a listing counted by both the
sales pass and the views pass keeps ONE candidate per `(scope, listingId)`,
and several listings of the same store landing in the same scope are SUMMED
into one store row rather than becoming one row each — both via `Map`s keyed
on the unique index's own columns, so a duplicate can only overwrite a key,
never append a second row for it. `replaceWindow` itself deletes and
re-inserts a run's touched scopes in ONE transaction, so no reader ever sees
a half-written window.

The sweep is leased per run on `discovery_sweep_cursors`
(`analytics_rollup_cursors`' shape: an upsert whose conflict branch takes the
lease only when it is free or expired). Unlike the analytics rollup there is
no day cursor — the window is rolling, so a run recomputes the whole of it,
and a failed or lost lease costs only a duplicate computation next tick.
`POST /internal/discovery/sweep` (`routes/internal-discovery.ts`) forces a run
now rather than waiting for the timer; it answers 200 either way and says
which happened (`{ ran: true, rowsWritten }` or `{ ran: false }`), because
another task already holding the lease is a normal outcome, not a failure.
That surface joins `ANALYTICS_OPERATOR_OXY_USER_IDS` rather than creating an
eighth allow-list: forcing this recomputation is the power that list already
holds over the merchant-demand acquisition pipeline, and an empty allow-list
means the surface is NOT MOUNTED (404, never a 401 that would advertise it
exists) — `docs/house-invariants.md`'s table names it.

## The isolation gate

`services/__tests__/discovery-isolation.test.ts` asserts, structurally rather
than by comment, that this domain and the offer/ranking domain
(`OFFER_FORBIDDEN_RANKING_SIGNALS` names `merchant_popularity` and
`brand_popularity` as signals organic offer rank may never use) cannot reach
each other in either direction, and that `discovery_signals` carries no
`score`, `weight`, `rank`, `rating` or `review_count` column. Merchandising
("what should we show on a shelf") is a legitimate different question from
ranking ("which seller wins this product"), and what the gate defends is the
first quietly becoming an input to the second — a shelf one join from a
weighted ordering would be a sponsored-placement surface nobody decided to
build. It also carries `#460`'s discipline: a whole-tree sweep for anything
named `discovery` must land either inside the domain's own two directories
plus its HTTP surface in the shared route/controller/middleware/schema
directories, or in an explicit, reasoned, counted exclusion (five today —
eBay's advertiser cohort, Awin's feed pass, and P2P's proximity search all use
the same word for something this domain never touches) — so a discovery-named
module added anywhere in `src/` cannot silently sit outside every wall in the
file.

## `/deals`, not `/offers`

`offers` already means comparison shopping in this repo — WHICH seller sells
a product, at what price, how fresh the observation is
(`db/schema/offers.ts`, `controllers/offers.controller.ts`,
`docs/offer-ranking.md`). The reference page this design implements is store
DISCOUNTS, a different thing wearing a tempting name, and the nav item was
already called `deals` (`nav-items.ts`, `labelKey: 'nav.deals'`) before this
work started — so `/deals` is both the domain-collision-avoiding choice and
the name the code had already picked.

`scope=deals` reads `db/schema/merchandising.ts`'s `discounts` directly and
never touches `discovery_signals` — `findStoresWithLiveDiscounts` selects one
`store-offer` section per store with a live, `method = 'automatic'` discount
(a `method = 'code'` discount is excluded: a shelf advertising a saving the
shopper cannot get without a code they do not have is a false price).

A card shows the products its discount can actually REDUCE, not the store's
newest. `applies_to_scope` is `notNull` and two of its three members target a
subset, so `buildDealsFeed` partitions the shelf's stores by scope and gives
each partition's read the union of its targets —
`applies_to_product_ids` as listing ids, `applies_to_collection_ids` resolved
through `listing_collections` — then `coveredByDiscount` filters each store's
bucket back to its own discount's targets, because the reads are batched
across stores. A card whose covered set is empty is dropped, like every other
empty section.

## KNOWN LIMITATION (2026-09-07)

`buildStoresSection` (`services/discovery/feed.service.ts`) reuses
`findActiveListingsForStores` (`db/catalog/listingRepository.ts`), which is
not category-scoped, so a category page's large merchant card shows a store's
WHOLE-CATALOG thumbnails rather than that category's products. Two
independent reviews judged this wrong on a category page specifically — every
sibling section there is category-scoped and the card's premise is "top
performer in this category", so an off-category thumbnail contradicts why the
card is shown. The deals page has no category context to contradict, which is
why the same behaviour is fine there.

**Fix:** give `findActiveListingsForStores` an optional category scope, the
same shape `findOnSaleListings` already takes (`categoryIds?: readonly
string[]`).
