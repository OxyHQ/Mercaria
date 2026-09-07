# Discovery feed — explore, category and deals

Design for three storefront screens that are one machine: `/categories`
(explore), `/categories/:handle` (a category landing) and `/deals`.

The reference is Shopify Shop's own explore, category and offers pages, captured
as rendered HTML. Every measurement in this document was read out of that markup
rather than estimated, and the component inventory below names, for each card in
the reference, the `@mercaria/ui` component that already renders it or the one
this work adds.

## The decision that shrinks the work

The three reference pages are the SAME feed with a different scope. Shop ships
one `data-testid="feed"`, one section machine and one card set across all three;
what differs is which sections the server put in the response. Mercaria takes
the same shape:

```
GET /discovery/feed?scope=root                → /categories
GET /discovery/feed?scope=category:<id|slug>  → /categories/:handle
GET /discovery/feed?scope=deals               → /deals
```

One contract, one renderer, three screens that choose a scope. A fourth screen
later is a new `scope`, not a new feed.

## The domain is `discovery`, not `feed`

`feed` already names two unrelated things in this repo: the home feed
(`services/feed.service.ts`) and the supplier product-feed importer
(`services/feed-import/`, `db/feedImport/`). A third would be the failure
`AGENTS.md` already records for "report" — sales analytics and abuse reports
sharing a word until somebody merged them. So: `services/discovery/`,
`db/discovery/`, `db/schema/discovery.ts`, `docs/discovery.md`.

`GET /feed` (the home feed) is untouched. The home keeps its job; see
§"What the home becomes".

## Curations are signals, and they have URLs

Shop's category page renders bordered cards titled "Top rated", "What's new" and
"Bestsellers", each linking to `/categories/5/beauty/curation/<uuid>`. Those are
not editorial: they are one derived ordering per scope, wearing an id. Only two
cards in the whole capture ("Luxe bath & body care", "The pocket perfumery")
read as hand-authored.

Mercaria has no editorial-curation model and this design adds none — there is no
admin panel behind these pages, by decision. A curation here is **a signal
applied to a scope**, and it is addressable:

```
/categories/[handle]/s/[signal]
```

`DISCOVERY_SIGNALS` is a closed tuple in `@mercaria/shared-types` and renders the
CHECK on `discovery_signals.signal`, per `db/schema/CONVENTIONS.md`:

| signal | ordering | source |
| --- | --- | --- |
| `top-rated` | `listings.rating` desc, above a review-count floor | `listings` |
| `new` | `listings.published_at` desc | `listings` |
| `on-sale` | discounted variants | `findOnSaleListings` |
| `best-selling` | `discovery_signals.units_sold` desc | `discovery_signals` |
| `most-viewed` | `discovery_signals.view_count` desc | `discovery_signals` |

Each shelf orders by ONE column and its title names that column. There is
deliberately no composite score: when "Más vendido" and "Mejor valorado" disagree
a reader can see why, and a weight nobody can see is a weight nobody can review.
This is also how the reference behaves — Best Sellers and Top Rated are separate
lists, not two views of one ranking.

### Three of the five need no new storage

`listings.rating` and `listings.reviewCount` already exist and are projections of
`review_aggregates`, which `db/schema/reviews.ts` names as "the ONE authority for
a scoped rating". They are NOT copied into the new table: a third copy is a third
place to disagree.

`listings.categoryId` exists, and
`listings_status_category_id_published_at_id_idx` is already the exact index
`new` wants. `findOnSaleListings` already exists and is already one statement.

## `discovery_signals`

Only sales and views need aggregation.

```
discovery_signals
  subject_type   'listing' | 'store'      -- DISCOVERY_SUBJECT_TYPES
  subject_id     text                     -- no FK: a store id or a listing id
  category_id    text                     -- an ANCESTOR of the subject's category, or '' for the root scope
  window         '30d'                    -- DISCOVERY_WINDOWS
  units_sold     integer  not null default 0
  order_count    integer  not null default 0
  view_count     integer  not null default 0
  computed_at    timestamptz not null
  unique (subject_type, subject_id, category_id, window)
  index (category_id, window, units_sold desc)
  index (category_id, window, view_count desc)
```

**One row per ANCESTOR, not one per leaf.** `listings.category_id` is the leaf,
but the reference's shelves are top-level ("Bestsellers in Beauty"). If the row
were only the leaf, every shelf would be a recursive tree walk joined to a
count. Instead the sweep writes the subject once per category on its ancestor
chain, so a shelf at any depth is one indexed read. The chain is bounded by tree
depth, and the count for a parent is the count for the subtree by construction
rather than by a second query agreeing with the first.

**`''` is the root scope**, not NULL. `analytics_rollups` already states the
reason for the same convention: a NULLable dimension breaks the unique index,
because Postgres treats NULLs as distinct, and it would let a row be written that
belongs to no scope at all.

**`window` has ONE member today.** `DISCOVERY_WINDOWS = ['30d']`. There is no
`7d` because nothing on any of the three screens asks for one, and a value set
with a member nobody reads is a value set nobody can trust. The column exists
anyway so the row says which window it is; adding `7d` later is a shared-types
change plus an additive migration, which is the documented cost of widening any
closed set here.

**What `subject_type = 'store'` orders.** The explore page's per-category store
grids and the category page's `stores` shelf. A store's counts are its listings'
counts within that category — the same sweep pass, grouped one level up. It is
NOT what `/deals` reads; that page comes from `discounts` and does not consult
this table at all.

**The `top-rated` floor.** `listings.rating` alone would put a single five-star
review above a product with four thousand. A minimum review count from config
gates entry, which is the same idea `RankingUnknownReason`'s
`below_confidence_floor` already names in the offer domain — borrowed as a
concept, not as code, since the two domains stay isolated.

- **Sales** come from `order_items` joined to `orders`, counting only
  `status in ('paid','processing','shipped','delivered','partially_refunded')`.
  `pending_payment` is a reservation, not a sale; `cancelled` and `refunded` are
  not sales either. Stated as a tuple in shared-types so the set is reviewable.
- **Views** come from `analytics_events` where `event_type = 'product_page_view'`.
  That row already carries `listing_id`, `category_id` and `store_id` — no
  envelope change, no new event type.

### Why a table and not a live query

`analytics_events` is swept by retention (`expires_at`, NOT NULL on every row).
Counted at request time, the view count of a product would SHRINK on its own as
rows expire, with nothing on the page to explain it. Writing the count down
freezes it.

This is not a new argument in this repo: `services/analytics/rollup.ts` states it
for its own numbers — "the numbers are written before the rows they came from
expire (data-lifecycle rule 2)". The discovery sweep is the same mechanism
applied to a second set of numbers.

### The sweep

`services/discovery/sweep.ts`, shaped after `services/analytics/rollup.ts`:

- Started from `index.ts` alongside the analytics rollup, leased per RUN so N
  tasks share it. A lost lease costs a duplicate computation and nothing else —
  the sweep moves no money and no state.
- `discovery_sweep_cursors`: one row per job, carrying `lease_owner` /
  `lease_expires_at` with the `num_nonnulls(...) in (0, 2)` CHECK that
  `analytics_rollup_cursors` uses, because an owner with no deadline can never be
  reclaimed and a deadline with no owner names nobody.
- Unlike the analytics rollup there is no day cursor to advance: the window is
  ROLLING, so a run recomputes the whole of it rather than adding a day. One
  window per tick, in one transaction: delete the window's rows, insert the
  freshly counted top N per category. Postgres MVCC makes that atomic for
  readers, so no reader ever sees a half-written window.
- Bounded by construction: top N per `(category_id, window)` from config, so the
  table cannot grow with the catalogue.

`POST /internal/discovery/sweep` forces a run, exactly as
`/internal/analytics`'s `runRollupNowHandler` does.

### It joins an existing allow-list

`ANALYTICS_OPERATOR_OXY_USER_IDS` already gates `/internal/analytics/*` **and**
the merchant-demand acquisition pipeline — the precedent for a second surface
joining one list. Forcing a recomputation of counts derived from analytics events
is the power that list already holds, so `/internal/discovery/*` joins it rather
than creating a sixth. Empty means NOT MOUNTED — 404, never 401.
`docs/house-invariants.md`'s table gains the surface on that row.

## The barrier against offer ranking

`OFFER_FORBIDDEN_RANKING_SIGNALS` (#74) names `merchant_popularity` and
`brand_popularity` among the eleven things that may never influence organic
rank, and `db/schema/ranking.ts` makes the prohibition structural: no column
exists to hold one.

Merchandising is a different question — "what should we show on a shelf" is not
"which seller wins this product" — and popularity is a legitimate input to the
first. What must not happen is the second quietly acquiring it. So:

**An isolation gate** (the `docs/isolation-gates.md` pattern, with
`scripts/isolation-gate-census.ts` already in the repo) fails the build if
anything under `services/offer*`, `services/ranking*` or `db/offers/` imports
`db/discovery/` or `services/discovery/`. The gate is the statement; a comment
would not be.

## `/offers` is already taken — the route is `/deals`

`offers` in Mercaria is comparison shopping: `db/schema/offers.ts`,
`shared-types/offer-ranking.ts`, `controllers/offers.controller.ts`,
`docs/offer-ranking.md`, `docs/offer-freshness.md` — WHICH SELLER sells this
product, at what price, how fresh the observation is.

The reference page is store discounts. Two unrelated things, one word, and
`AGENTS.md` already carries the scar from the last time ("Report is two unrelated
things here… Never merge them"). The nav item is ALREADY called `deals`
(`nav-items.ts`, `labelKey: 'nav.deals'`), so `/deals` is also the name the code
already chose.

### The discount model already fits

`db/schema/merchandising.ts`'s `discounts` maps onto the reference with nothing
invented:

| Reference | Column |
| --- | --- |
| "20% off" | `value_type = 'percentage'`, `value` in basis points |
| "Save $60 on orders over $120" | `value_type = 'fixed_amount'` + `minimum_requirement_type = 'subtotal'` |
| the shelf is live | `is_active` and `starts_at <= now <= ends_at` — index `discounts_store_id_method_window_idx` is exactly this scan |
| the incentive halo, "Exclusive offer available" | `customer_eligibility_type <> 'all'` |
| which products the shelf shows | `applies_to_scope` / `applies_to_product_ids` / `applies_to_collection_ids` |

`method = 'code'` discounts are NOT listed: a shelf that advertises a saving the
shopper cannot get without a code they do not have is a false price. Only
`automatic`.

## The section vocabulary

`DiscoverySectionKind`, a closed tuple in shared-types, one member per card
family in the capture:

| kind | In the reference | Payload |
| --- | --- | --- |
| `hero` | explore §1; category §2, §9 | `HeroCard[]` — 2.35:1 image, title, subtitle, destination |
| `category-tiles` | explore §2 "Browse categories" | `CategoryTile[]` + background colour + 2 sample images |
| `category-images` | category §4, §7 | image tile with a centred label |
| `pills` | category §1 | round image + label |
| `products` | explore §3–§7; category §6, §8 | `ProductSummary[]` |
| `stores` | explore §8–§15; category §5 | `StoreSummary[]`, `variant: 'large' \| 'compact'` |
| `store-offer` | deals, all 11 sections | store + resolved discount + its products |
| `card-group` | category §3 | two per row, each wrapping a nested `products` section |

Every section carries `id`, `title?`, `href?` (its header's destination) and
`layout: 'carousel' | 'grid'` — which is what the reference's `shelf-section` vs
`ListSection` distinction is.

New DTOs: `HeroCard`, `DiscountSummary`, `DiscoverySection`, `DiscoveryFeed`,
`DiscoverySignal`. `ProductSummary`, `StoreSummary`, `Category` and
`CategoryTile` are reused unchanged — they already have the right shape.

### Tile colour is derived, not stored

The reference's browse-category tiles carry a per-category background colour.
Mercaria's `categories` has no colour column and this design does not add one:
there is no operator surface to set it, so a column would be a field nobody can
fill. The colour is derived deterministically from the category id against a
fixed palette in `@mercaria/ui`, which is stable across renders and across
deployments.

## Components

### Already exact

`MerchantCard` IS the reference's `large-product-focused-merchant-card`. Height
397px, radius 28, a 20% dark tint, a brand gradient with stops at 0.2/0.8, a
wordmark capped at 74×195, name and rating bottom-start, a row of product
thumbnails. Somebody already built it from this same reference; it needs nothing.

Also reused as-is: `ProductCard`, `ProductCarousel`, `ProductShelf`, `Carousel`,
`ReviewStars`, `RatingLine`, `IncentiveHalo` (same multi-stop box-shadow),
`CategoryCard` and `CategoryCarousel` (which stay with the home).

### New in `@mercaria/ui`

| Component | Reference `data-testid` |
| --- | --- |
| `ActionHeroCard` | `feed-action-card-hero` |
| `CategorySampleTile` | `feed-action-card-tile-with-samples` |
| `CategoryImageTile` | `tile-image` |
| `CategoryPill` | `feed-action-card-pill` |
| `SectionCard` | `container-section-card` |
| `StoreProductCard` | `product-focused-merchant-card` — square product carousel, pagination dots, halo, badge |
| `StoreOfferHeader` | the deals section header: logo, name, discount line |
| `DiscountBadge` | `shop-cash-badge` |
| `FeedGrid` | `ListSection` — the flex-wrap grid; everything in `@mercaria/ui` today is a carousel |

`SectionHeader` changes: the reference's trailing chevron sits in a FILLED
`bg-bg-fill-secondary` circle with no border; the current one is
`h-8 w-8 rounded-full border border-border`.

### The classes are the reference's classes

`packages/ui/src/theme/tailwind.preset.js` already carries Shop's token
vocabulary mapped onto Bloom's runtime variables — `bg-bg-fill`,
`text-text-tertiary`, `rounded-radius-20`, `p-space-16`, `text-captionBold`. The
class names are the reference's; only the colours resolve to Bloom. Four gaps the
capture uses and the preset lacks:

```js
borderRadius:  "radius-24"
fontSize + fontWeight: "posterXS"
colors: "bg-fill-tertiary",
        "overlay-fixed-dark-04", "overlay-fixed-dark-10",
        "overlay-fixed-light-20", "overlay-fixed-light-40", "overlay-fixed-light-75"
boxShadow: "s", "m", "l"      // components currently reach for web:shadow-md/lg
```

Every added colour points at a Bloom variable or is a fixed constant by design,
which is what `fixed`/`overlay` already mean in that file.

### What cannot be copied literally

React Native has no equivalent for some of the reference's web classes. Each has
one established substitute, and on web the rendered result is the same:

| Reference | Here |
| --- | --- |
| `line-clamp-1`, `truncate` | `numberOfLines` |
| `object-cover` | expo-image `contentFit` |
| `hover:`, `group-hover:`, `backdrop-blur-*` | the `web:` prefix |
| `snap-x snap-mandatory` | `ScrollView` `snapToInterval` |
| `srcset` / `sizes` | one sized URL |
| `aspect-ratio: 2.35/1` | the `style` prop |

### The one deliberate divergence: RTL

`scripts/validate-rtl-logical-classes.mjs` fails the build on `pl-`/`pr-`,
`ml-`/`mr-`, `left-`/`right-`, `border-l`/`border-r`, `text-left`/`text-right`
and `rounded-l`/`rounded-r`/corner variants. The capture uses `pl-space-4`,
`pr-space-8`, `left-space-12`, `right-space-12`, `-left-space-16`.

Those become `ps-`, `pe-`, `start-`, `end-`. Identical in LTR, correct in Arabic.
`border-s-*` and `text-start` do NOT survive react-native-css/RN 0.85 and stay
physical with a `KNOWN_EXCEPTIONS` entry, exactly as `AGENTS.md` records.

## The screens

### `/categories` — explore

Becomes the feed at `scope=root`. It keeps `Head`, the canonical URL, the
`hreflang` alternates, the JSON-LD and its `category_index` route id.

The SEO position is unchanged and this is worth stating plainly: the page's value
to a crawler is that it is a page of links to category pages, and after the
redesign it is STILL a page of links to category pages — the tiles and section
headers ARE those links. The markup changes; the link graph does not.

### `/categories/:handle` — a category landing

Gains the reference's `text-feed-header` (an `h1` plus breadcrumbs — both
`CatalogBreadcrumbs` and `useCatalogSeo` already exist and already do this) above
a feed at `scope=category:<id>`.

The current `CategoryListingCard` grid becomes one `products` section — the
category's own listings, under a signal — rather than the whole page.

The facet rail stays absent. `lib/catalog/facet-consumption.ts` gates it on the
grid's own query type being able to act on a selection (#637), and nothing in
this design changes that.

### `/categories/:handle/s/:signal` — one signal, paginated

New route, and the destination of every hero card and `SectionCard`.

A cap that must be stated rather than discovered: `best-selling` and
`most-viewed` can only page within the top N the sweep stored, because that is
all that was counted. `top-rated`, `new` and `on-sale` read `listings` directly
and page fully. The route reports which it is rather than pretending the two are
the same depth.

### `/deals` — new

`scope=deals`: one `store-offer` section per store with a live automatic
discount. The nav item moves from `available: false` to
`href: '/deals', available: true`, which is precisely the shape `NavItem` asks
for — the union has no `href` on the unavailable branch, so the compiler
requests it.

### What the home becomes

`/` stays a feed but a personal one — cart, saved, the shopper's own categories,
what is new since they last came. Discovery is the explore page's job now. The
home's existing sections that duplicate explore (`shop-by-category`,
`worth-the-hype`) move out.

## i18n

New keys in all 13 locale bundles under
`packages/frontend/lib/i18n/locales/`; `validate:i18n-strings` gates parity,
hardcoded strings and unreferenced keys.

Shelf titles are keys with a parameter — `discovery.shelf.topRated` →
`"Lo mejor valorado en {{category}}"` — resolved on the CLIENT. The server sends
a signal and a scope, never a composed sentence: a sentence assembled in the
backend is a sentence that cannot be translated, and `AGENTS.md` already requires
module-scope data to hold keys rather than text.

`@mercaria/ui`'s own strings (carousel arrow labels, "save", the offer line) go
in ITS bundles under the reserved `ui` namespace, for the locales each app
ships — never the union.

## Typed routes

Every dynamic destination is spelled in the OBJECT form:

```ts
{ pathname: '/categories/[handle]/s/[signal]', params: { handle, signal } }
```

`typedRoutes` checks the object form completely; a template literal with a
dynamic segment above the mistyped one exits 0 (#456). `validate:route-targets`
resolves each against the real route tree.

## Testing

- **Real-DB suites, not mocks**, for the sweep and every read
  (`*.realdb.test.ts`). A mocked insert accepts statements the server rejects,
  and the CHECKs on the signal and window tuples have no mocked counterpart.
- **The shared test database**: the sweep's per-window delete/insert takes
  sibling files' rows with it, and there is no way to scope around that — the
  window replace is GLOBAL by design (§"The sweep": a run replaces the whole
  window, so a category that goes quiet is cleared rather than serving
  month-old counts forever). This bullet used to say each sweep case "scopes to
  a category id the file owns"; that was written before the consequence was
  understood, and the implementation briefly matched it — narrowing the delete
  to the scopes a run touched, which is the bug the final review caught.

  The real remedy is coarser and is a property of the SUITE rather than of a
  case: every file whose test can write `discovery_signals` holds one shared
  advisory-lock slot, registered in `slot-teardown-census`, so the sweep and any
  sibling writer are serialised instead of racing. Six files hold it today. The
  cost is real — roughly ten seconds of wall clock and genuine coupling between
  files that share nothing else — and it is the price of a sweep whose delete is
  honest.
- **The isolation gate** gets its own positive control: a fixture import from
  `services/offers` to `db/discovery` must make the gate fail. A gate that has
  never failed has not been measured.
- **A vacuity floor on the signal shelves**: a shelf test that passes against an
  empty `discovery_signals` is measuring nothing, so each asserts a non-zero
  population first.
- **Order-status arithmetic**: a fixture with one order per status, asserting
  that exactly the five counted statuses move `units_sold`. Excluding a status
  and counting it look identical without this.

## Delivery

Seven changes, in dependency order. Each is independently mergeable and green.

1. `@mercaria/ui` preset gaps (radius-24, posterXS, the overlay/fill colours,
   shadow s/m/l).
2. `@mercaria/shared-types`: `DISCOVERY_SIGNALS`, `DiscoverySectionKind`,
   `HeroCard`, `DiscountSummary`, `DiscoverySection`, `DiscoveryFeed`, and the
   counted order-status tuple. Then `bun run build:shared-types`.
3. `discovery_signals` + `discovery_sweep_cursors` + the sweep + the
   `/internal/discovery` surface + the isolation gate. Migration marked
   `-- oxy:deploy-phase=pre` (additive), generated with `db:generate` after the
   shared-types build, and READ afterwards for statements nobody intended.
4. `services/discovery/` + `GET /discovery/feed` for all three scopes.
5. The nine new `@mercaria/ui` components + the `SectionHeader` change.
6. `/categories` and `/categories/:handle` + `/categories/:handle/s/:signal`.
7. `/deals` + the nav item + the home's section trim.

`docs/discovery.md` lands with change 3 and is registered in `docs/index.mdx`;
`docs/house-invariants.md` gains the `/internal/discovery` row in the same
change.
