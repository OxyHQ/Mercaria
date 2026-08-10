# Brand and product-family pages (#72)

The two navigation surfaces a shopper reaches from a product: the BRAND behind
it and the FAMILY it belongs to. Both are **compositions** over catalogue
identity (#53/#56), verified relationships (#55), current eligible offers
(#57/#68), source rights (#62) and #94's attribute registry. This domain owns
**no table**, publishes **no fact** none of those already holds, and has **no
write path to the catalogue at all**.

Code: `services/catalog-pages/` (10 modules), `db/catalogPages/`,
`controllers/catalog-pages.controller.ts`, `routes/catalog-pages.ts`,
`middleware/catalog-page-schemas.ts`, `@mercaria/shared-types`
`catalog-page.ts`, plus the storefront's `app/(app)/brands/[handle].tsx`,
`app/(app)/families/[handle].tsx` and `components/brand/`.

The failure mode that shapes all of it: **a badge that looks exactly like a real
one.** A brand page's whole value is that "Official store" means something, and
every plausible shortcut to producing one — a matching name, a shared domain, a
big catalogue, a merchant who proved they operate a storefront — produces a
badge indistinguishable from an authorized one, on a page nobody will re-read.

---

## An official channel comes from a verified relationship and from nothing else

`CATALOG_PAGE_OFFICIAL_EVIDENCE` has **one** member. Both channel lists come
from #55's own public resolver, `listBrandChannels`, verbatim — which filters on
`status = 'verified'` **and** evaluates the validity window in the statement.
Calling it rather than re-deriving is what keeps that guarantee one piece of
code, and it is why a claim that lapsed an hour ago produces no badge whether or
not any sweep has run.

`CATALOG_PAGE_FORBIDDEN_OFFICIAL_SIGNALS` names the twelve resemblances that may
never produce one, DISJOINT from the evidence tuple by a test. Two of them are
worth reading:

- **`merchant_claim`.** #83 lets a merchant PROVE it operates a merchant record,
  and that proof is real — it answers a different question. Being Amazon does not
  make Amazon Apple's official store.
- **`domain_match`.** #55's `SUFFICIENT_EVIDENCE_KINDS` already refuses
  `domain_control` for the badge-producing kinds; this states it from the page's
  side.

`catalog-page-isolation.test.ts` scans the whole `services/catalog-pages/`
DIRECTORY (so the wall holds for modules nobody has written yet) for the DATA a
resemblance would be inferred from: name-similarity search, domain matching and
`observed_domains`. It deliberately has **no pattern for catalogue volume or a
merchant claim**, and the reason is stated in the test: a product count is used
legitimately three lines away (thinness), so a count detector would fire on
correct code and get loosened by whoever hit it next. What makes those two
unrepresentable instead is structural — `BrandChannelEntry.evidence` has one
member and both lists come from a resolver that reads neither.

### The one thing #55 does not publish

`organization_owns_brand` carries `publicBadge: null`, so #55's resolver — which
exists to answer badge questions — does not project it. #72 brand rule 2 needs
it. So `official-channels.ts` reads the SAME repository function every public
relationship read goes through (`findCurrentRelationships`, where the verified
filter and the window both live) and adds only a projection with no evidence, no
reviewer, no actor and no confidence field for one to ride along in. The
temporal rule is consumed, not restated.

### Market scope is reported, never widened

Every entry carries its own `territories` and the page states the market it was
resolved FOR. An EMPTY array is `commerce_relationships`' own "unrestricted" —
a different fact from "no markets" — and the badge component renders the two
differently. A claim scoped to `{ES}` never becomes a global badge.

---

## A brand page is not a merchant storefront

`BrandPage` has no channel, no listing, no inventory and no seller of record. A
merchant appears only as the subject of a verified relationship, and a retailer
selling the brand without one appears in **neither list** — which is the normal
state (ADR 0002 D10), so both lists render their own sentence rather than
disappearing. A section that vanished would leave a reader unable to tell "we
know of none" from "this part did not load".

#73 owns merchant and storefront pages. The two domains meet at exactly one
edge: the channel list links to `/merchants/{slug}`. **That route is #73's and
is a named cross-issue seam** — `typedRoutes` is ON but INERT in this repo, so
`tsc` will not catch a mismatch and it surfaces only as "This screen does not
exist". Dropping the link instead would fail #72 official-channel rule 3
outright.

---

## Unknown is a STATE, never a zero and never an omission

`CATALOG_OFFER_CONTEXT_STATES` is `included | withdrawn`. #60 keeps
`CANONICAL_READS` and `CANONICAL_OFFER_COMPARISON` separate so that "withdrawing
price comparison during an incident should not take the brand and product
identity pages down with it" — its own words, naming this page. So the MOUNT is
behind the first lever and the offer half is read inside the handler from the
second.

Without the page-level state, a page whose offer half was withdrawn would be
indistinguishable from a brand nobody currently sells, and a client would print
"no offers" during an incident. With it, a card's absent `offers` means "no
current offer" exactly when the page says `included`.

Three empty states, and the grid says which: no products at all, offers
withdrawn, and filters that excluded everything. A shopper's next action differs
for each.

---

## The ordering never implies a chronology it cannot support

`CATALOG_BROWSE_ORDERINGS` is `catalog_name | release_desc`, and `release_desc`
is offered **only when every live product in the scope carries a release date**.
A mixed set ordered by release puts the undated products somewhere, and wherever
that is reads as a claim about when they came out.

`catalog_name` is `(name, id)` — never the primary key. A uuid v7's leading bits
are a timestamp, so ordering a catalogue by id is ordering it by INGESTION TIME,
which #74 policy rule 7 forbids by name for offers and which would be a worse
claim here. `id` is the TIEBREAK that makes the order total, and only between
products whose names are byte-identical.

#61 already measured and indexed this exact read:
`canonical_products_brand_page_idx` on `(brand_id, name, id) WHERE status <>
'merged'`, **5.011 ms → 0.097 ms**, rows scanned **17,945 → 20**. These readers
keep that index's exact shape rather than inventing an ordering it cannot serve.

---

## The cursor is bound to what produced it

A keyset over `(name, id)` or `(released_at, name, id)`, carrying a digest of
the scope, the ordering and the filters. A cursor that does not match is
**UNREADABLE** (`null` ⇒ serve the first page) rather than misapplied: the two
orderings sort by different columns in different directions, so resuming one
from the other's boundary would skip or repeat an arbitrary run of rows and
report neither. Refusing costs one duplicated first page and cannot lose a row.

The cursor carries the last candidate **CONSIDERED**, not the last one SERVED.
Availability, condition and attribute filters are applied after the keyset page
is read, so a page can return fewer rows than it asked for; a cursor on the last
served row would re-consider and re-drop everything between the two on every
later page, forever. (#70's rule, and the reason a page reports
`consideredCount` beside its products.)

The payload joins on the ASCII **unit separator**, not a printable character,
and carries the name LAST — a product called `Model | Pro` would otherwise split
a `|`-joined payload into the wrong number of fields and make deep paging
impossible for exactly that product.

---

## A product appears once, and that is the schema's doing

The statement selects `canonical_products` and never joins offers; the offer
half arrives as a per-product CONTEXT keyed by product id. Twenty retailers
selling one phone is one row because one row is the only shape this read has
(#72 acceptance 5).

The offer half is **#70's `buildSearchOfferContexts`, called rather than
copied**. That is not thrift: it makes a product's `currentOfferCount` and
`lowestPrice` the SAME number on a brand page, a family page and a search page.
A second derivation would be a second spelling of "current", and the
disagreement would surface as "the brand page says three offers and the product
page shows two".

---

## Every price states what it is about

`CATALOG_PRICE_CONDITION_SCOPES` is `new | used | mixed | unknown`, printed
beside every figure. `unknown` is its own answer and is **not** `mixed`: an
offer whose source said nothing about condition contributes no segment at all
(#90 never asserts one), and reading an empty set as "new" is the most
misleading thing a catalogue grid does.

`open_box` and `refurbished` count as NOT new, deliberately: both are legitimate
and neither is a sealed retail unit.

The family price range converts once per page through `fx.service`, names its
currency, and **excludes and NAMES** any offer whose currency has no rate — the
#70 `SearchFxContext` posture. `fx.convert` throws rather than fabricating a
rate, and that refusal IS the answer. A family whose offers all expired reports
NO range rather than a range of zero.

---

## A public fact is shown only under recorded rights

`CatalogPageAsset` and `CatalogPageText` are three-state unions:

| state | meaning |
|---|---|
| `absent` | Mercaria holds nothing |
| `withheld` | Mercaria holds it and may not show it |
| `displayable` | shown, with its `rightsBasis` and provenance |

Collapsing the first two would make a brand with a contractually unshowable logo
look identical to one nobody has ever photographed.

An asset whose source record or registry row cannot be READ answers
`unresolved_provenance` and is withheld. "We could not check" and "we checked
and it is fine" must not produce the same page.

Rights come from #62: `catalog_sources.may_display` as the umbrella, narrowed
(never widened) by the active policy version's `display_media` and `index`.
A source with no ingestion config — #60's backfill source, the operator source —
keeps its coarse registry row, which is what stops this from withholding every
asset those created.

**`attribution` is present exactly when the source demands it**, and the string
is the source's REGISTRY NAME, because that is the only display identity a
source has. The operational consequence is stated rather than hidden: a source
configured with `attribution_required` must be NAMED for a reader.

Two exceptions come first for an entity-level TEXT field: a field an operator
PINNED is Mercaria's own text by construction (pinning is what stops a source
re-applying over it), and an entity with no active observation has no external
licence behind it either.

---

## SEO: a verdict, not a boolean

`CATALOG_PAGE_INDEXABILITY` is `indexable | thin | no_index_right | merged`, and
the ORDER of the derivation is load-bearing — a tombstone beats a rights refusal
beats thinness. Telling a crawler "we may not show this" about a page that
should have pointed somewhere else is the less useful of two true statements.

A family needs **two** live products to be publishable and a brand needs **one**,
and the asymmetry is the point: a family with one member says exactly what that
product's page says, while a brand with one product still publishes its verified
channels, which nothing else in Mercaria does.

Structured data is derived from the **PROJECTION**, not from the row, which is
what makes "only when visible facts support it" mechanical: a withheld logo is
not in the `displayable` branch, so it cannot reach the JSON-LD. A page that may
not be indexed emits **nothing** — structured data is an assertion addressed to
a crawler, and on a `no_index_right` page it would publish exactly the facts a
source refused.

`sameAs` carries the brand's OWN website and nothing else. An observed domain is
a fact about where the brand's products were seen, not a claim the brand owns it
(#53 records them as facts, explicitly not as ownership proof), and `sameAs` is
exactly such a claim.

**The client escapes the JSON-LD.** A brand's name and description come from a
crawled catalogue, so they are attacker-influenced text, and `JSON.stringify`
does not escape `<` or `>`: a brand named `</script><script>…` would close the
tag. `<`, `>` and `&` become their `\uXXXX` forms — byte-identical JSON to a
parser, inert text to an HTML tokenizer.

A brand is a **root** of navigation, not a child of a category: a brand sells
across categories, and picking the biggest one as its parent would tell a
crawler its laptops are a subsection of "Phones". A family's trail is two hops,
because a family genuinely belongs to its brand (`canonical_product_families.brand_id`).

**#75 owns the sitemap and this domain builds none.** What it publishes is the
verdict a sitemap builder needs.

---

## A correction is a dispute, and it confers nothing

`POST /catalog-pages/corrections` names a FIELD from a closed set
(`CATALOG_CORRECTION_FIELDS`) and carries **no free text**. An unmoderated
free-text channel into an operator's inbox is a content-moderation problem this
domain has no way to solve; a reviewer who knows the logo is disputed can look
at the logo.

The only write in the whole domain is one row in **#59's review queue**
(`catalog_review_items`, `detector: 'public_correction'`, reason code
`public_correction_submitted`). #72 identity rule 1 — "the brand page is not
editable by a merchant merely because the merchant claims a storefront" — is
therefore not a permission check: there is no write path to a brand, a family or
a canonical product at all, and a merchant with a proven claim and an anonymous
reader reach exactly the same code.

**The queue records the DISPUTE, not the disputer.** `catalog_review_items` has
no column for who raised an item and this domain adds none: a submitter recorded
beside their dispute is a submitter who can accrue standing.

**The limitation, stated rather than hidden:** #59's `upsertReviewItem`
converges on `dedupe_key`, which is grained per SUBJECT and REPLACES
`reason_codes` on conflict. Two readers disputing two different fields of one
brand therefore produce ONE item with a count of two, and the field recorded is
the first one's (the conflict branch leaves `note` alone). Per-field reason
codes would be worse than none — they would drop whichever field was reported
first while looking precise. Per-field fidelity needs a column #59's table does
not have, and adding one is #59's decision.

The route is authenticated, and the account is used for nothing beyond being
required: what authentication buys is a bound on unattributable volume that a
rate limiter alone cannot give.

---

## Reviews and ratings

The only rating any field here carries is a canonical PRODUCT's, on the
product's own card, and it is ABSENT rather than zero when nothing has been
rated — an empty star row reads as a bad product rather than as an unrated one.

A BRAND rating is unrepresentable: #76 makes it so, `CATALOG_PAGE_FORBIDDEN_FIELDS`
names `brandRating`/`familyRating` as VALUES, a scanned gate refuses any module
that reaches one, and a RUNTIME walk of a real emitted page (in the realdb
suite, with a length floor so an empty response cannot pass) confirms none is
serialized.

---

## Surface

| Route | What it answers |
|---|---|
| `GET /catalog-pages/brands/:handle` | the brand page; id, slug or ALIAS; tombstones redirect |
| `GET /catalog-pages/brands/:handle/products` | one keyset page of its canonical products |
| `GET /catalog-pages/families/:handle` | the family page |
| `GET /catalog-pages/families/:handle/products` | one keyset page of its generations |
| `POST /catalog-pages/corrections` | dispute a published fact (authenticated, 202) |

A separate router from `/canonical-products` and `/product-families`, which are
#56's and serve catalogue identity only — "no price, no stock, no seller". A
PAGE is a composition, and putting one on #56's routers would make its identity
surface start carrying prices, which is the line that file draws in its own
header.

The **redirect is reported in the 200**, not as a 301: the client is an app that
owns its address bar, so it rewrites the URL and renders the page it already
has, where a redirect status would cost a second round trip on every stale link.
`from` is what was asked for, so a client can tell "you followed an old link"
from "you typed the slug".

**What the query schemas do NOT accept**, and why each absence is the
enforcement:

- **No `sort`/`order`/`boost`/`pin`/`promote`.** The ordering is the scope's own
  and is reported in the RESPONSE, which is the direction that makes it
  explicable. A request able to name one would let a caller pick the ordering
  that flatters a product.
- **No `officialChannelOnly`.** #70's search has one; a brand page must not,
  because a filter spelling of it on the product grid would quietly become
  "these are the products the brand endorses".
- **No `merchantIds`.** A brand page is not a merchant storefront, and a
  merchant filter on it is the first step to becoming one.
- **No `priceMin`/`priceMax`.** A price bound needs a currency, an FX context
  and an unconvertible-currency report to be honest; `GET /search` carries all
  three. A half version here would be a second price filter with different
  behaviour.

There is **no operator surface and no seventh allow-list**. Everything an
operator would do to a brand, a family or a relationship already exists on
`/internal/canonical-catalog` and `/internal/commerce-graph`, behind
`CATALOG_OPERATOR_OXY_USER_IDS`; a correction lands in a queue those surfaces
already read.

---

## Environment

**None.** This domain adds no flag of its own, deliberately: its two rollout
levers already exist (#60's `CANONICAL_PUBLIC_ROUTES_ENABLED` for the mount,
`CANONICAL_READS` for the reads, `CANONICAL_OFFER_COMPARISON` for the offer
half), and a third would be a second answer to a question those already answer.

---

## Seams left to their owners

Each is named in code and docs rather than stubbed:

- **#73** — merchant and storefront pages. The channel list links to
  `/merchants/{slug}`; nothing else crosses.
- **#75** — the sitemap. This domain publishes `indexability` and builds none.
- **#74** — ranking. The grid's ordering is a stable catalogue order, and the
  offer context already invokes #74's `selectSearchOffer` seam through #70's
  builder; no module here reads a weight, a policy or a score.
- **#71** — the canonical product page a card links to.
- **#59** — the correction WORKFLOW. This domain files the queue item and
  resolves none, and per-field fidelity is #59's column to add.
- **#94** — attribute FACETS. The browse accepts attribute constraints in the
  same wire spelling `GET /search` does; a facet LIST (which values exist, with
  counts) is a different read and belongs with the registry.
