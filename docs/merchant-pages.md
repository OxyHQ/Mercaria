# Merchant and storefront pages (#73)

A merchant page answers *what does this shop sell, and through which channels*
without collapsing four things a reader is forever tempted to treat as one: the
**merchant** (the commercial actor that sells), a **storefront** (one named
channel it reaches buyers through), a **native Mercaria store** (an operational
`stores` row with its own members, inventory, orders, handle and follow
identity), and a **brand** (what is being sold). ADR 0002 D3, D4, D8 and D10
keep those four apart in the graph; this page is where a person meets them, and
every decision below exists so the page cannot put two of them in one box.

**There is no merchant-page table and no migration.** The whole domain is a
projection over `merchants`, `merchant_aliases`, `merchant_domains`,
`storefronts`, `native_store_links`, `commerce_relationships`, `offers`,
`canonical_products`, `canonical_images`, `brands`, `organizations`,
`stores` and `review_aggregates`. That is the #92 shape and it is taken for the
#57 reason: every verdict on this page is a conjunction over tables the domain
does not own, so a stored copy would be a second answer that a revoked claim, a
lapsed relationship or a moderation restriction could leave standing.

Code: `services/merchant-pages/` (7 modules) + `db/merchantPages/` (1
repository) + `controllers/merchant-pages.controller.ts` +
`middleware/merchant-page-schemas.ts` + three routes on `routes/merchants.ts`,
plus the storefront's `app/(app)/merchants/[idOrSlug].tsx` and
`components/merchant/`. Contract: `@mercaria/shared-types` `merchant-page.ts`.

## The surface

| Route | Answers |
|---|---|
| `GET /merchants/:idOrSlug/page` | identity, aliases, standing, operating organization, both channel lists, the linked native store, verified domains, the merchant review aggregate, brand standings, the offer mix, contact |
| `GET /merchants/:idOrSlug/catalog` | one card per canonical product, keyset-paginated |
| `GET /merchants/:idOrSlug/offers` | one row per offer, keyset-paginated |

All three are public, unauthenticated and metered on the `'listings'` bucket —
they serve catalogue identity and there is no viewer-specific hydration to
attach. `GET /:idOrSlug` (#54's identity read) is deliberately NOT widened into
the page: several surfaces poll it, and turning it into a page read would make
every one of them pay for eleven joins they do not use.

Both browses take `storefrontId`, `sellers`, `market`, `conditionGroups`,
`availability`, `limit` and `cursor`; `/catalog` additionally takes `brandId`
and `categoryId`. The schema is `.strict()`, and what it therefore **cannot** be
asked for is a `sort`, a `boost`, an `order` or a `pin` — ranking is #74's and a
merchant page must not become a second place an ordering is decided.

`/offers` REFUSES `brandId` and `categoryId` rather than accepting and ignoring
them. Both are facts about the canonical PRODUCT, and applying them would join
two more tables into the statement `offers_merchant_browse_idx` serves — while
accepting a parameter that changes nothing is the quiet failure a shopper reads
as "this merchant has no Apple products on this channel".

## The rules that are load-bearing

### Two channel lists, because marketplace-ness is a comparison

ADR 0002 D8 makes an offer a marketplace offer by comparing its seller of record
against the operator of the channel it sits on. A page with ONE channel list has
to pick which side of that comparison it means, and either choice is wrong for
half the merchants: a first-party retailer's country sites are channels it
**operates**, and a marketplace seller's channels are ones somebody else
operates.

So `operatedChannels` comes from `storefronts.merchant_id` and `sellingChannels`
from the channels this merchant's own offers actually sit on, each entry naming
its `operatorMerchantId` and carrying `operatedByThisMerchant` — the comparison
already made, so no client makes it and none can make it differently. For a
first-party retailer the two coincide; for a marketplace seller they do not, and
collapsing them would either hide the platform or attribute its catalogue to one
of its sellers.

### Three catalogue scopes, and the third is what makes Amazon work

- `merchant` — everything this merchant sells, across every channel.
- `merchant_on_channel` — the same, narrowed to one channel it sells through.
- `channel_all_sellers` — everything offered **on** a channel, by anybody.

The third is acceptance criterion 2: a marketplace operator's page shows its
third-party sellers' offers, and every one keeps its own `merchantId` and reads
`sellerRole: 'marketplace'` while the operator's own reads `direct` on the same
channel. It is permitted **only** for a channel this merchant operates —
somebody else's channel is somebody else's page, and serving its whole catalogue
here would make one merchant's route a viewer for another's inventory. A seller
on that channel still gets `merchant_on_channel`, narrowed to its own offers.

### The native store is a LINK, and that is a value rather than a paragraph

`MERCHANT_NATIVE_STORE_PRESENTATIONS` has one member, `link`, and
`MERCHANT_REJECTED_NATIVE_STORE_PRESENTATIONS` names the two considered and
refused as a DISJOINT tuple beside it — so changing the decision is a change to
a value a reviewer sees.

A **redirect** would make the merchant route unreachable, and with it every
external channel, the offer mix, the brand standings and the claim action: the
merchant would BE the store, which is the collapse the issue's title forbids. An
**embed** would be a second rendering of an experience the store APIs own
(members, collections, policies, theme, inventory, orders), and two renderings
of one thing disagree the moment either changes.

The link keeps ONE follow identity by construction rather than by rule: the
follow control lives on the store route, this page renders none, and
`merchant-page-isolation.test.ts` fails the build if any module in the domain —
in EITHER package — names `ensureFollowTarget`, `registerFollowKind`, a follow
hook, a follow button or the `mercaria.store` / `oxy.user` kinds. That covers
native-store rule 3 (never a second identity) and rule 6 (an unclaimed external
merchant is never registered as a follow target) with the same absence.

The reference carries five fields — store id, handle, name, presentation, linked
at — and no policy, member, collection, inventory or order figure, because those
belong to the store APIs (rule 4).

### The page writes nothing, so rule 5 needs no merge policy

Native-store rule 5 asks that external merchant data not overwrite
merchant-managed native-store fields without a reviewed merge policy. There is
no merge policy here because there is no write: the domain issues no INSERT,
UPDATE or DELETE and calls no write service, and the isolation gate asserts it.
The handle, the name and the link's verification instant are read and
republished verbatim.

A linked store's identity is read through `findLinkedStoreIdentity`, which
selects three columns, rather than through `findStoreById`, which attaches the
store's MEMBERS. Reading them and dropping them would leave the guarantee
resting on a serializer; selecting three columns leaves nothing to drop.

### Three brand states, not a badge and its absence

`official_store`, `authorized_reseller`, `no_verified_relationship` — three
labels, three sentences, three badges (the third being no badge). An ordinary
retailer selling a brand holds no relationship row at all (D10), so silence is
the NORMAL case, and a page that rendered silence would leave a reader unable to
tell "we checked and there is none" from "we have not looked".

The list is the union of two sets that answer different questions: the brands
#55 has verified something about, and the brands this merchant's current offers
actually cover. Neither alone is enough — a verified badge for a brand the
merchant has stopped stocking still belongs on the page, and the third state
exists only for brands with no relationship row, which by construction cannot be
enumerated from the relationship table.

A claimed merchant cannot edit any of it: there is no write route, and the
isolation gate fails the build if the domain reaches a relationship writer.

### The operating organization, only when verified AND useful

Merchant requirement 3. A verified, currently-valid
`organization_operates_merchant` relationship is read through #55's repository —
a different question from a badge, and #55's public resolver restricts itself to
badge kinds. What is published is the ORGANIZATION's own public identity plus
the instant the claim was verified; the relationship row, its evidence, its
reviewer and its confidence are published in no form.

"Useful" is a stated policy rather than a shrug: an organization whose name is
the merchant's own name repeats the headline, so it is withheld and
`organizationUsefulness` says `same_name_as_merchant`. "There is no verified
operator" and "there is one and we judged it redundant" are different facts and
only the first is a gap.

### Safe public language, from a closed vocabulary

`MERCHANT_PUBLIC_STANDINGS` has four members — `unclaimed`,
`claim_in_progress`, `claimed`, `selling_on_mercaria` — derived from two facts
that are already public: `merchants.claim_state` and #54's derived
native-checkout verdict. There is deliberately no member meaning "a claim was
rejected", "an operator is reviewing evidence" or "N people are claiming this":
each is a statement about a person's dealings with Mercaria, and this page is
one anybody can load. #83 publishes `claimInProgress` as a BOOLEAN for exactly
that reason, and the derivation consumes the boolean rather than a count.

The branch order is the severity order. A verified claim outranks a squatter's
live one — reading it the other way round would describe a CLAIMED merchant as
"claim in progress" and put a claim button beside a shop that already has an
operator.

`Claim this merchant` appears exactly when #83 says `claimable`, and NOT merely
because somebody else has a claim open: a first mover must not be able to lock
the real operator out by squatting, which is #83's own rule.

### One rating, under its own scope label — and none on a card

A merchant page can reach four rating aggregates: the merchant's, a linked
store's, each product's and each P2P seller's. It publishes ONE, the `merchant`
scope, labelled. That is #73 trust rule 5 and #76 UI rule 6.

The catalogue card is `MerchantCatalogEntry`, which has **no rating field at
all**, and `MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS` names `rating`,
`ratingCount`, `reviewCount`, `merchantRating` and `sellerRating` as values a
gate scans for. The storefront renders `MerchantProductCard` rather than
`@mercaria/ui`'s `ProductCard` for the same reason: `ProductCard` takes a
`ProductSummary` whose `rating` and `reviewCount` are REQUIRED, so reusing it
would force this page to supply a star figure for every card, and a second star
rating beside the merchant's is read as the same measurement.

### The catalogue order is a FACT, and the deduplication is a `group by`

`max(last_seen_at) desc, canonical_product_id desc` — most recently confirmed
first, which is the order `offers_merchant_browse_idx` was built to serve and
what #61's X01 measured. No relevance, verification, rating, fee, plan or
commission is consulted, and the isolation gate fails the build if this domain
learns to reach one. #74 owns ranking.

The deduplication is a `group by canonical_variants.product_id` rather than a
post-hoc pass, so a page of twenty cards is twenty products and never twenty
offers of four products (acceptance 5). One product offered on four country
sites is one card carrying `eligibleChannelCount: 4`.

The tiebreak is the product id and it is not optional: `last_seen_at` ties are
the NORM rather than an edge case, because one ingestion page stamps one clock
across every offer it writes.

### The keyset timestamp is exact microseconds, not a `Date`

postgres.js decodes `timestamptz` into a JS `Date`, which has millisecond
precision — so a cursor built from one is TRUNCATED, and in a DESCENDING keyset
a truncated boundary excludes every row whose true value lies between the
truncated value and the real one. Nothing in this repository writes a
sub-millisecond `last_seen_at` today (every writer stamps a `Date`), which is
exactly what would make the bug arrive later, silently, as "some of this
merchant's products are missing from page two".

The cursor therefore carries `(extract(epoch from …) * 1000000)::bigint` —
`extract` returns `numeric` on PostgreSQL 14 and later, so the multiply and the
cast are exact, and the reverse is an integer multiplied by an interval, which
is exact too. Digits only, so it survives a query string without escaping.

### The stored deadline narrows; the live derivation decides

The SQL filters on `stale_at`, the indexed stored deadline. What a page SHOWS is
then filtered by the live per-source freshness verdict #68 derives inside
`projectOffer` — so a contractual cache cap that shortened a lifetime this
morning bites here with no sweep having run, and a page may return fewer rows
than its limit. The cursor is unaffected, because it is a keyset over the SQL
order.

The one place this is visible in a number rather than in a list is the **offer
mix**, which counts over the stored deadline because projecting a merchant's
entire offer set through the live derivation to count it is not something a page
read can afford. That makes `currentOfferCount` an upper bound on what a list
would show, never a lower one, and the DTO says so rather than hiding it.
`staleOfferCount` is the difference between active and current — one number
about Mercaria's information rather than about the shop's shelves.

### Honest empty states

`MERCHANT_CATALOG_EMPTY_REASONS` has three members because they lead a reader to
three different conclusions:

- `no_offers` — Mercaria has nothing for this merchant.
- `stale_sources` — it HAS offers and has not heard from their sources recently
  enough to show them. A statement about Mercaria, not about the shop.
- `filtered_out` — the filters excluded everything.

The reason is computed only when a page comes back empty, which is the only time
the answer is needed. SQL having found products that the live derivation then
refused is `stale_sources` and not `filtered_out`, because the filters
demonstrably admitted them. A card whose every offer failed the live derivation
is DROPPED rather than rendered priceless — a card a shopper can tap and find
nothing behind is the dishonest empty state rule 6 is about.

The count that decides between them ALWAYS joins the canonical product, even
with no brand or category filter. The browse only ever shows `active` and
`discontinued` products, so a merchant whose offers all point at `draft` mints
(#60's backfill) or at merged tombstones has nothing browsable — and a count
without the join would see those offers and report `filtered_out` when nothing
was filtered. An offer's `canonical_variant_id` is NOT NULL, so the join drops a
row for exactly one reason. Pinned by a realdb case whose fixture is the only
shape that tells the two versions apart, and mutation-tested: removing the join
turns exactly that case red.

### The outbound action is a named seam that fails closed

Storefront rule 4 asks that an external storefront action link to the real
destination "through #67". #67 is not built: every source domain in this
repository (#57, #62, #65, #66, #68) already stores its destination URL verbatim
and refuses to compose a tracked one. `MerchantChannelOutbound`'s `unavailable`
branch has no `url` property at all, so a client cannot read a destination out
of a refusal and a future caller cannot "just return the public URL here"
without changing the type in a diff somebody reviews. The untracked
`storefront.publicUrl` stays a separate, plainly-named field: it is the
retailer's own site, it carries no tracking parameters, and linking to it
asserts no commercial arrangement.

The discriminant is a STRING (`outcome`) rather than an `available: boolean`
literal — the #68/#110 rule, because the backend compiles with `strict: false`
and without `strictNullChecks` TypeScript does not narrow a union on the
truthiness of a boolean-literal discriminant.

### Contact, and the two places it may NOT come from

`MerchantPageContact.source` is `native_store`, `verified_channel` or `none`.
A linked store means its operator manages policies and support inside Mercaria,
so the page hands over the handle. Otherwise the most Mercaria holds is a public
URL on a VERIFIED channel — the retailer's own site, which they published. With
neither, the page says nothing.

There is deliberately no `payment_onboarding` member and no `inventory_location`
member. A Stripe onboarding address is a legal-entity record a seller gave a
payment processor (trust rule 2) and an `inventory_locations` row is a warehouse
rather than a shop somebody chose to publish (trust rule 3). Neither has a
member here, and the isolation gate fails the build if any module in the domain
imports the payment domain or names a location or precise geography.

## Performance

`listMerchantOfferIds` is the first shipped reader of `offers_merchant_browse_idx`
and `offers_storefront_browse_idx` — two indexes #61 recorded as existing with
no reader. `graph-plan-regression.realdb.test.ts` runs on every push and:

- asserts Q25's plan names `offers_merchant_browse_idx` with no `Seq Scan`;
- MUTATION-TESTS that by dropping the index inside a rolled-back transaction and
  confirming the gate goes red naming the shape, then confirming the rollback
  restored it;
- asserts Q26's plan names `offers_storefront_browse_idx` and NOT the merchant
  one, so the second index is proven rather than assumed.

The ascending index served backwards is the property under test. #57's schema
comment records why the obvious `.desc()` spelling is wrong (`DESC NULLS LAST`
against a plain `ORDER BY … DESC`, which means `DESC NULLS FIRST`) and what it
cost when measured: 103.7 ms against 0.071 ms on a seeded million rows.

Q27 measures the deduplicated browse and declares no required index and no
forbidden node type, on purpose: it is a `group by` over a seller's whole active
offer set ordered by an AGGREGATE, so a Sort survives by construction. It is the
merchant page's most expensive read and the one a "cheapest offer per product"
projection would fix if one is ever justified — #61 adopted none and this issue
adopts none.

## What #73 deliberately did NOT do

**`MerchantSummary` is still un-rehomed.** ADR 0002's entity glossary notes that
`ProductSummary` and `MerchantSummary` in `shared-types/src/product.ts` are
home-feed card projections of native listings and stores, that nothing may
import them as canonical types, and that "#70–#73 will re-home them". #70 did
not, and #73 did not either: the rename touches twenty files across three
packages (feed service, order hydration, the `Listing` DTO, the stores
controller, the store screen, the mock catalogue), it landed in a batch of
fourteen parallel branches where a cross-package rename is a merge hazard for
every one of them, and no numbered requirement of #73 asks for it.

What #73 does instead is hold the half that matters. The confusion the rename
would remove is a merchant page rendering a native store's card as "the
merchant", and `merchant-page-isolation.test.ts` fails the build if any
merchant-page surface, in either package, so much as imports `MerchantSummary`.
The rename remains owed.

## Seams left to their owners

- **#67 / #37** — the outbound redirect. `resolveChannelOutbound` publishes the
  contract and refuses unconditionally; closing it is one function body.
- **#74** — ranking. Nothing here orders by anything but a fact, and a scanned
  gate keeps it that way.
- **#84** — native-store linkage itself. This page READS `native_store_links`
  and creates none.
- **#71** — the canonical product page a catalogue card links to.
- **#59** — corrections to a merchant's aliases, domains and merges, which
  arrive through the operator surface and are simply read here.
