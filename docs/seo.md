# Public routing and SEO (#75)

What a public Mercaria URL IS, which URL is canonical for a thing, whether that
thing may be indexed, and exactly which facts a crawler is told about it.

Code: `services/seo/` (11 modules), `db/seo/seoRepository.ts`,
`controllers/seo.controller.ts` + `controllers/internal-seo.controller.ts`,
`routes/seo.ts` + `routes/internal-seo.ts`, `middleware/seo-schemas.ts`,
`@mercaria/shared-types` `seo.ts`, and the storefront's
`public/_worker.js`, `public/robots.txt` and `wrangler.jsonc`.

Binding dependencies: #56's canonical identity, #71's composed product page,
#90's condition taxonomy, #62's source rights, #92's seller-visibility rule,
#37/#67's (unbuilt) outbound redirect.

**NO new tables and NO migration.** #61 measured the canonical graph at a
million offers and adopted no projection; a sitemap is a keyset scan over rows
that already exist, and every metadata fact is composed at request time from the
same read the page renders.

---

## The five rules the types hold

1. **A slug is presentation; identity is an id.** Every entity route resolves an
   id first and states the canonical spelling afterwards. `SeoRouteIdentity` has
   no `slug` member — a route addressable only by its current spelling is a
   route that breaks when the spelling changes.
2. **A page that is not indexable carries NO structured data.** Structured data
   is an indexing signal; attaching one to a page the policy withdrew asks for
   the outcome the policy exists to prevent. `SeoDocument.structuredData` is
   empty whenever `indexable` is false, over every route.
3. **An external offer has no Mercaria URL to be purchased at.**
   `SeoOfferCheckout` is a two-branch union and only `mercaria` carries a `url`.
   There is nothing an emitter could put in `offers.url` for an offer whose
   checkout happens elsewhere.
4. **Unknown is never zero and never a soft yes.** `SeoOfferPrice` and
   `SeoOfferAvailability` have no value on their unknown branch, so an unpriced
   offer cannot enter an `AggregateOffer` and an offer whose stock nobody
   published cannot be emitted as `InStock`.
5. **A tracking parameter can never reach a canonical URL.**
   `SEO_CANONICAL_QUERY_KINDS` and `SEO_NON_CANONICAL_QUERY_KINDS` are DISJOINT
   tuples and the canonical builder accepts only the first.

## The route registry

`services/seo/routes.ts` is the ONE place a public path is spelled. Ten
patterns, each with its identity scheme, its availability, the expo-router
screen that renders it and its sitemap collection.

| Route | Pattern | Identity | Today | Sitemap |
|---|---|---|---|---|
| `home` | `/` | — | live | — |
| `canonical_product` | `/p/:handle` | id or slug | live | `products` |
| `legacy_listing` | `/products/:id` | id | live | — |
| `native_store` | `/stores/:handle` | handle | live | — |
| `native_store_legacy` | `/m/:handle` | handle | redirect only | — |
| `seller` | `/sellers/:oxyUserId` | id | live | — |
| `brand` | `/brands/:handle` | id or slug | planned (#72) | `brands` |
| `product_family` | `/families/:handle` | id or slug | planned (#72) | — |
| `merchant` | `/merchants/:handle` | id or slug | live | `merchants` |
| `category_browse` | `/categories/:handle` | id or slug | planned | `categories` |

**`availability` is the honesty column.** A `planned` pattern is recorded and
reserved and is never indexable, never in a sitemap and never served metadata:
emitting a title and a canonical tag for an address that renders "This screen
does not exist" is worse than emitting nothing.

`seo-routes.test.ts` is the gate and it **fails in three directions**: a `live`
route with no screen file; a screen file that no row mentions and no explicit
not-applicable list excuses; and a `planned` route whose screen HAS shipped.
The third fires on somebody else's pull request, and that is intended — #72 and
#73 flip two fields, and `product-page-isolation.test.ts` already sets the
precedent by asserting those routes do not resolve today.

Product FAMILIES are deliberately not a fifth sitemap collection: the issue
names four, a family page is reached from its brand's, and a collection nobody
asked for is a crawl budget nobody costed.

### The merchant page

`/merchants/:handle` went live when #73 landed, and the registry gate is what
forced the flip rather than leaving the page unindexable in silence.

It resolves through `getMerchantPublic` — the same read the screen's own API
call makes — which already answers both identity questions: it refuses a
suppressed merchant outright, and it reports `redirectedFrom` when the handle
was a merge tombstone, so the 301 is composed from the read rather than from a
second walk of the merge chain.

A merchant page is judged by its CATALOGUE (`assessCatalogueContent` over #57's
offer rollup), not by `assessVisibleContent`: it has no description worth
indexing on its own and no image at all — a `Merchant` row carries no logo, and
#55's verified relationships are what put a mark on a page. It emits an
`Organization` node and no offers: a shopper buys on the PRODUCT page, and
attaching a price here would put it on the wrong subject.

## Redirects, and why the graph cannot loop

Two kinds. A **route** redirect is a pure path rewrite (`/m/:handle` →
`/stores/:handle`) carrying the same segment to the same entity. An **identity**
redirect is a fact about a row: a merged canonical product answers with its
winner (`merged`), and an address that named a product by its id answers with
its slug (`canonical_spelling`).

**The loop proof is structural, not a counter.** Every route rule's TARGET is
asserted at MODULE LOAD to be a route with no rule of its own, so the rule graph
has depth one and no traversal can revisit a node. `assertRedirectTerminates` is
the second half: an identity redirect whose destination would itself redirect is
refused rather than served, so a crawler is never handed a chain to walk.

There is deliberately **no `query_normalized` redirect**. Stripping
`?utm_source=` with a 301 destroys the attribution the landing page is about to
read, which is the other half of #75 legacy rule 6. The canonical TAG
consolidates the address; the parameter reaches the page.

### Legacy listings do NOT redirect — the decision #75 asked for

The issue asks whether a listing with a confident canonical mapping should
redirect to the canonical product or render a compatibility page. **It renders,
and points `rel=canonical` at the product.**

Legacy rule 5 forbids sending a historical order link to a different live
product or seller, and a canonical product page shows every seller of that
model — so redirecting sends somebody looking at what they bought to a page
dominated by other people's offers. The mapping comes from
`findCanonicalProductIdForListing`, which resolves only when EVERY barcoded
variant resolves to the SAME canonical product; it is the same gate
`Listing.canonicalProductId` uses, so the page and its canonical tag answer one
question. An unmatched or unique P2P listing keeps a self-canonical.

## The indexability policy

`decideIndexability` is one deterministic function over NINE stated inputs, none
optional — a caller that has not decided whether the locale is complete cannot
omit the answer and get a soft yes. Every input is a STRING discriminant, because
this backend compiles with `strictNullChecks` off and TypeScript does not narrow
a union on a boolean-literal discriminant.

The order is load-bearing and matches `SEO_NON_INDEXABLE_REASONS`: mechanical
refusals, then identity, then rights, then content. An operator reading
`thin_content` therefore knows the page is live, canonical, clear of moderation
and permitted by its sources.

**The reason is operator-facing and only operator-facing.** A crawler is told
`noindex` and nothing else — a refusal spanning several conditions gets one
answer, or a client can vary one input at a time and read the switchboard out of
the catalogue. It is served from `/internal/seo` (below), which is what stops
the reason being a value nobody reads.

Two inputs have no live producer today and are exercised directly in the tests:
`locale` (Mercaria publishes one locale and has no localized route) and
`filterUniqueness` (no filtered browse page exists). They are asked rather than
assumed, so the day either ships there is one place to answer it.

**What the policy does NOT decide** is whether a page's canonical URL is its
own. A legacy listing that maps to a canonical product is indexable AND points
`rel=canonical` at the product: that is how consolidation works, and `noindex`
beside a cross-page canonical is a contradiction search engines resolve by
ignoring one of them.

## Rendered metadata, and why the backend renders the markup

The Cloudflare Worker assembles the HTML, but it is plain JavaScript with no
type-checker and no test runner in this repository. So every decision that can
be got wrong — which tags, which order, what is escaped, whether a `noindex`
page carries structured data — is made in `services/seo/head.ts`, and the worker
performs ONE string splice it is scanned for.

That is also what makes the no-JavaScript render check real:
`seo-no-js-render.test.ts` imports the worker's own `injectSeoHead`, drives it
over the API's own `<head>` fragment, against a shell built from the
storefront's own `app/+html.tsx`, and reads the metadata out of the result as
TEXT with nothing executed.

`GET /seo/resolve?path=…` always answers **200**, whatever the outcome, because
the outcome is data the edge acts on:

| Outcome | The worker does |
|---|---|
| `document` | Splices the head into the shell, 200 |
| `redirect` | 301 (or 308) to the location, without fetching the page |
| `not_found` | Serves the shell with status **404** |
| `no_document` | Serves the shell UNCHANGED |

`no_document` rather than `not_found` for an unregistered path is what keeps the
rollout safe: `/cart`, `/checkout` and `/settings/general` are real screens this
domain publishes no metadata for, and answering `not_found` for them would serve
every one with a 404.

A **seller profile** answers `no_document` permanently. #92 derives its
visibility per request from Oxy's own privacy and trust state; a title composed
here would either duplicate that decision or outlive it, and a search result for
an account that later goes private is not something a later read can withdraw.

**Locale alternates are always empty.** Mercaria publishes one locale and has no
localized route, so there is no second URL an `hreflang` could point at.
Rendered-metadata rule 3 asks for alternates "when real localized content
exists", and a self-referential alternate for a locale nobody translated is the
failure that rule is written against.

## Structured data

Built from `SeoVisibleFacts` and from nothing else. `document.ts` and
`structured-data.ts` cannot reach a repository — a scanned wall — so "emit only
facts visible on the page" is a property of the call graph rather than a review
comment. `structured-data.test.ts` walks every emitted LEAF back to the visible
fact it came from and carries a mutation self-test.

- A NATIVE offer carries `url`, the Mercaria address with its configuration
  selected. An EXTERNAL offer carries `availableAtOrFrom` naming its host and
  **no `url`** — which is #75 acceptance 4 as a shape.
- `AggregateOffer` bounds come from the offers with a KNOWN price, and
  `offerCount` counts those same offers. No priced offer means no bounds at all.
- An offer Mercaria cannot place a checkout location on — a native offer whose
  verdict currently refuses, an external offer with no destination — is OMITTED
  from the facts. The facts may hold LESS than the page shows, never more.
- `aggregateRating` needs a non-zero count. #90's nine condition keys map onto
  schema.org's four through a total `Record`, so a tenth key is a compile error.

## Sitemaps

Four collections (`products`, `brands`, `merchants`, `categories`), an index
over them, and **membership decided by the same `decideIndexability` call the
`<head>` decides `robots` with**. Two implementations would eventually disagree,
and a sitemap advertising `noindex` pages is invisible without a crawler.

**Resumable means stateless, not checkpointed.** There is no generation job:
`/sitemaps/products/7.xml` is an ordinary read ordered by primary key with an
offset, and a crawler that failed to fetch it fetches it again. A page holds the
same rows across a regeneration unless the catalogue changed. The cost is the
offset — the last page of a million-row collection skips 975,000 index entries,
which is an index-only scan of a btree Mercaria already maintains, once per
collection per crawl, cacheable for an hour. A keyset cursor would be cheaper
and could not be addressed by page number, which is what an index has to name.

### `lastmod` is a meaningful public change

`canonical_products.updated_at` is the obvious column and it is a trap:
`applyProductSourceObservation` always writes `last_seen_at`, so a sitemap built
on it tells a crawler that every product changed whenever the feed ran.

`lastmod` is `greatest` of four timestamps that move only when a VISITOR would
notice: the product's `created_at`, its `last_reviewed_at` (an operator
correction), the newest `canonical_field_provenance.selected_at` (a source field
that actually CHANGED — provenance is written once per APPLIED field) and the
newest ACTIVE `canonical_images.updated_at` (`insertCanonicalImage` is
`onConflictDoNothing`, so a repeat observation moves nothing).

`canonical_variants` is deliberately absent: its `updated_at` does move on an
observation. A new configuration therefore does not itself move `lastmod` — the
provenance and image rows arriving with it usually do — and a `lastmod` that is
occasionally early is a smaller error than one that is always wrong.
`seo.realdb.test.ts` drives both halves, and the NEGATIVE one is load-bearing.

## Source display rights

A product is indexable only when every catalogue source behind it grants the
`index` right (#62's ninth right), read from the ACTIVE policy version.

**A source with no ingestion CONFIG is not governed by a rights policy.** The
join onto `catalog_source_configs` is INNER for that reason: the operator
surface and #60's backfill mint registry rows that are Mercaria's own, and
applying "no active policy means no rights" to those would answer `noindex` for
the entire backfilled catalogue. A CONFIGURED source gets #62's rule verbatim.
The conjunction is conservative the other way: ONE feed that forbids indexing
withdraws the page.

## The operator surface

`/internal/seo/*`, on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
#54/#56/#57/#58/#60/#62/#68/#78 use — not a seventh: who may decide what the
catalogue says and who may read what a crawler is told about it are the same
power over the same graph. Empty list = the router is not mounted (404, never a
401 that would advertise it), and it stays mounted while `SEO_ROUTES_ENABLED` is
off, because "why is this page not indexed" is exactly the question somebody
asks after pulling the lever.

| Route | Answers |
|---|---|
| `GET /diagnose?path=…` | the resolution PLUS the indexability reason |
| `GET /routes` | the registry as the process holds it, and the levers |
| `GET /sitemaps/:collection/:page` | how much of that page the policy kept, and what refused the rest |

**THREE reads and no write.** There is no "index this anyway", no "set this
page's robots directive", no "add this URL to a sitemap", no cache purge and no
way to edit the registry. Each would be a second authority over what
`decideIndexability` already decides, and the first would publish a page some
source's agreement forbids. What an operator changes is an INPUT — a
description, a rights policy, a category, a lever — and this surface says WHICH
input. `internal-seo-routes.test.ts` enumerates the registered routes EXACTLY,
so a fourth route or a non-GET method fails the build.

Both reads go through the SAME functions the public paths project the verdict
away from — `diagnoseSeoUrl` and `classifySitemapRows` — so an operator's answer
and a crawler's `noindex` come from one computation rather than two that agree
today. Coverage is bounded to ONE PAGE on purpose: "how many pages of the
catalogue are indexable" is a full scan of every collection, which is the one
thing the paginated design exists to avoid. The collection's total row count is
exact; the verdict tally is the page's.

Auditing is structured log lines, not a table: the allow-list middleware logs
every refusal and each handler logs the granted attempt with the caller and what
was asked. This domain owns no table and adds none.

## robots.txt — two artefacts, one list

The API renders it from `SEO_ROBOTS_DISALLOWED_PATHS`; the storefront ships a
static copy for the flag-off state, because that is what a crawler gets when the
worker's proxy cannot answer. `seo-robots.test.ts` parses the static asset and
fails the build when its `Disallow` set differs from the rendered one.

`/out/` is disallowed: a crawler following #37's affiliate redirect spends
Mercaria's crawl budget on somebody else's site and books a click nobody made.
The `rel="sponsored nofollow"` half of #75 sitemap rule 5 is #37's to add when
the route exists — no page links outward today.

Two combinatorial screens are disallowed for the same reason policy rule 8
exists. `/search` is infinite, thin and a duplicate of the browse pages by
construction. `/compare` (#96) is one page per shopper-assembled TUPLE of
products, and its `?watchlist=` parameter names a PRIVATE list (#81) — a
crawlable one would spend budget on arbitrary tuples and fetch somebody's list
id along the way.

## The rollout levers

| Variable | Default | What it gates |
|---|---|---|
| `SEO_ROUTES_ENABLED` | `false` | Whether `/seo/*` is MOUNTED at all |
| `SEO_INDEXING_MODE` | `off` | `off \| canary \| on` — whether anything may be indexed |
| `SEO_CANARY_CATEGORY_IDS` | empty | Which categories `canary` indexes |
| `SEO_SITEMAP_PAGE_SIZE` | 25,000 | URLs per sitemap page |
| `SEO_DOCUMENT_CACHE_SECONDS` | 300 | `Cache-Control` on a document |
| `SEO_SITEMAP_CACHE_SECONDS` | 3,600 | `Cache-Control` on a sitemap or robots.txt |

Two levers because they bound different blast radii. With the routes off the
worker's lookup 404s and it serves the storefront exactly as it did before #75.
With indexing off the metadata still renders — a correct title and a correct
sharing card are worth having before anybody is invited to index the catalogue —
and every page says `noindex` and every sitemap is empty.

**`canary` with an empty list indexes NOTHING.** Half-configured is off, and
this is deliberately the OPPOSITE of `CHECKOUT_DESTINATION_COUNTRIES` and
`CANONICAL_READ_COHORTS`, where empty means everything: there the empty default
preserves today's behaviour and here it would publish a catalogue. A brand, a
merchant or a category page has no category of its own, so under `canary` none
of them is indexable — a canary indexes a slice of the catalogue.

The canary is a CATEGORY rather than a hash bucket because a bucket would have
to be computed identically in TypeScript (for a document) and in SQL (for a
sitemap), and two implementations of one bucket function is a drift waiting to
happen.

## The edge

`packages/frontend/public/_worker.js` proxies `/robots.txt`, `/sitemap.xml` and
`/sitemaps/*` to the API, asks `/seo/resolve` about every document request, and
splices the rendered head into the shell.

**It fails open, everywhere.** No `SEO_API_ORIGIN`, a slow API, a non-200,
unparseable JSON, a shell with no `</head>` — every one serves the storefront as
it would without the file. A redirect and a 404 are produced only from an
explicit, successfully-parsed answer; the one thing that must never happen is
either of them invented because a lookup failed.

`SEO_API_ORIGIN` is a plain `var` in `wrangler.jsonc` and not a secret: it is a
public API origin the browser already talks to, and nothing behind it needs a
credential.

## Deliberately not built

- **A category / filtered browse page.** The route pattern and its sitemap
  collection are RESERVED and emit nothing. No storefront screen renders one, in
  this repository or in either page issue in flight, and a browse surface is a
  product decision rather than a routing one.
- **`rel="sponsored nofollow"` on affiliate links** — #37 owns the outbound
  redirect and no page links outward today. `robots.txt` already refuses `/out/`.
- **Crawl-error monitoring** (#75 sitemap rule 6). Crawl errors and Google's own
  index coverage are Search Console's and live outside this repository. The half
  Mercaria can answer — how many of its own pages the policy is keeping, and
  what refused the rest — is `/internal/seo/sitemaps/:collection/:page`;
  structured-data validity is asserted by `structured-data.test.ts` and by the
  no-JavaScript render.
- **A production canary run.** The mechanism ships (`SEO_INDEXING_MODE=canary`
  plus a category list); pointing it at real categories and watching crawl
  behaviour is an operational act, not a code change.
