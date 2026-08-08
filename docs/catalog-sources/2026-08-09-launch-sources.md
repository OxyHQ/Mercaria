# Catalog sources: the first two external catalog and affiliate sources

- **Status:** Accepted
- **Date:** 2026-08-09
- **Issue:** [#64](https://github.com/OxyHQ/Mercaria/issues/64), part of epic [#37](https://github.com/OxyHQ/Mercaria/issues/37); consumed by [#62](https://github.com/OxyHQ/Mercaria/issues/62) (ingestion framework), [#65](https://github.com/OxyHQ/Mercaria/issues/65) / [#66](https://github.com/OxyHQ/Mercaria/issues/66) (the two production adapters) and [#67](https://github.com/OxyHQ/Mercaria/issues/67) (outbound redirects and reconciliation)
- **Provider docs current as of:** 2026-08-09. Facts below carry their source URL; anything that could not be verified without an approved account is marked **requires account approval** rather than guessed.

## 1. Decision

| Slot | Selected | Fallback |
|---|---|---|
| Broad marketplace / product coverage | **eBay Browse API**, with eBay Partner Network (EPN) attribution | **CJ Affiliate** GraphQL product APIs (`shoppingProductFeeds` / `products`) |
| Retailer-network / affiliate-feed coverage | **Awin product feeds**, with the Awin Publisher API for commission reconciliation | **Merchant-provided Google-Merchant-style feeds through [#63](https://github.com/OxyHQ/Mercaria/issues/63)** (no external approval possible to reject); Impact.com as the network alternate |

The two are complementary by construction: eBay contributes marketplace inventory —
including the secondhand listings that match Mercaria's Wallapop-style positioning —
with per-item seller identity; Awin contributes new-goods catalogues from retail
advertisers (30,000+ brands, EEA-strongest network) as bulk feeds. Neither
duplicates the other's inventory: eBay items are individual offers from marketplace
sellers, Awin rows are retailer SKUs.

**Amazon is not selected**, and honestly cannot be today — see §4.

## 2. Launch markets and categories

Mercaria is EEA/Spain-first (repo context; `STRIPE_SELLER_COUNTRIES` and the
EEA-scoped transfer geometry of ADR 0001).

- **Markets:** Spain first (`EBAY_ES`; Awin advertisers with Primary Region ES),
  expanding to DE, FR, IT and GB — all supported eBay marketplaces
  ([Buy API marketplace support](https://developer.ebay.com/api-docs/buy/static/ref-marketplace-supported.html))
  and all Awin core regions ([Awin](https://www.awin.com/gb/about-us) operates
  on the ground in 17 countries, origin Berlin/London).
- **Categories:** start where Mercaria's native catalogue already sells —
  electronics, fashion and collectibles from eBay (secondhand plus new), and
  fashion / home / electronics retail verticals from Awin advertisers. Category
  breadth is a per-advertiser property on Awin (the feed list names each feed's
  `Vertical`), so the launch set is chosen at advertiser-join time, not
  hard-coded.

## 3. Evaluation matrix

Six candidates against the fifteen criteria of #64. Cells are terse; the
per-candidate notes and citations follow.

| # | Criterion | Amazon Creators API | eBay Browse API + EPN | Awin feeds | Impact.com | CJ Affiliate | #63 merchant feeds |
|---|---|---|---|---|---|---|---|
| 1 | Account / approval / traffic requirements | Associates approval **+ 3 qualifying sales in 180 days**, then **10 qualifying sales / 30 days per marketplace** for API access — hard fail today | Free EPN signup + **Buy API production application: business-model review + eBay contracts** | Publisher signup, **£5/$1 refundable card deposit**, manual review; then per-advertiser approval | Free partner signup; per-brand approval; catalog API is a gated "advanced feature" | Free publisher signup; feed *listing* needs no join; product *search* needs joined advertisers | None external — merchants apply to Mercaria |
| 2 | Countries / merchant coverage | 20+ marketplaces incl. ES | ES, DE, FR, IT, GB (+ US etc.) | 30k+ advertisers, 17 countries, EEA-strongest; ShareASale merged in | Global, US-weighted | 15k+ advertisers with shopping feeds, US-weighted | Whatever merchants Mercaria signs |
| 3 | Product / variant / seller / storefront identity | ASIN + GetVariations; no third-party-seller identity in scope verified | itemId + itemGroup variants; **seller username & feedback per item** | Advertiser-scoped SKU (`merchant_product_id`); merchant = advertiser | Catalog rows per brand | Feed rows per advertiser (CJ hard cap 1000 items/request on search) | Merchant-scoped `id`, merchant known by contract |
| 4 | GTIN / MPN / brand / category | Present in API (per docs); coverage unmeasured | `gtin`, `epid`, category; coverage **requires account approval** to measure | GTIN/EAN/UPC/ISBN + brand columns; only *mapped* columns ship per feed | Standard catalog fields | GTIN fields in shopping feeds | Google spec: `gtin`/`mpn`/`brand` conditionally required |
| 5 | Price, sale price, availability, condition, shipping | Yes (must be API-fresh) | Yes incl. condition (used/new) and shipping | `search_price`, `store_price`, RRP, `in_stock`, `stock_quantity`, `delivery_cost` | Price/availability | Price/availability | `price`, `sale_price`, `availability`, `condition` |
| 6 | Image / description display rights | Images may NOT be cached; text ≤24h | Display permitted for the marketed item; **exact image-caching terms in Buy API contract** | Feed content licensed for promoting the advertiser; per-programme terms | Per-brand terms | Per-advertiser terms | Granted by the merchant in Mercaria's own feed ToS |
| 7 | Caching / retention / deletion | **24h cache max on non-image content; refresh immediately** | **Delete when content no longer publicly available; no AI training** | No published global TTL; refresh on `Last Imported`; per-programme terms govern | Per-brand | Per-advertiser | Mercaria's ToS defines TTL |
| 8 | Refresh mechanism / latency | Live API calls | Live API calls; item-level re-read | Feed regeneration per advertiser; list exposes `Last Imported` for conditional download | FTP/API/platform download; gzip | GraphQL queries / feed downloads | Merchant re-submits or scheduled re-fetch |
| 9 | Pagination / quotas / rate limits | Not published pre-approval — **requires account approval** | **5,000 calls/day default** per app; growth check to raise | **20 API calls/min** (Publisher API); feed downloads not call-metered | Not published pre-approval | 1000 records/request cap; PAT-scoped | Bounded by Mercaria itself |
| 10 | Affiliate deep-link + conversion reporting | Associates links; reporting in Associates Central | **`itemAffiliateWebUrl`** minted per item via `X-EBAY-C-ENDUSERCTX`; EPN reporting | `aw_deep_link` per row; **Publisher API `GET /publishers/{id}/transactions`** (31-day windows) | Impact reporting APIs | Commission Detail API (GraphQL) | None — native checkout or plain links |
| 11 | Commission model / thresholds | Category rates; thresholds unverified today | **1–4% of GMB**, per-category caps (reported $100–$550); monthly payout; exact threshold **requires account approval** | Per-advertiser CPA; network minimum payout **$20** | Per-brand contracts | Per-advertiser CPA | Merchant contract with Mercaria (no network cut) |
| 12 | API stability / sandbox / samples | Brand-new API (PA-API v5 retired 2026-05-15); migration churn | Mature REST; **full sandbox before any approval** | Feed CSVs stable for years; no sandbox, but feed list shows pre-join feeds | Stable; samples gated | Stable GraphQL; `shoppingProductFeeds` listable pre-join | Google spec is public and fixed |
| 13 | Implementation + operational cost | Blocked, so moot | Medium: OAuth client-credentials, JSON API, per-item refresh budget | Low-medium: authenticated CSV/gzip download + column mapping | Medium | Medium | Lowest external; #63 builds it once |
| 14 | Third-party-seller identification on marketplace offers | Not verified; Amazon does not expose per-offer seller identity in the documented operations reviewed | **Yes — native strength**: seller username, feedback %, per item | N/A (advertiser IS the merchant) | N/A | N/A | N/A (merchant self-identified) |
| 15 | Contract / policy risk for a comparison marketplace | High: strict Operating Agreement, revocation on 30-day sales lapse | Medium: business-model approval could refuse a comparison site; contract terms not public | Low: comparison/content publishers are a core Awin publisher type | Low-medium | Low-medium | None external |

### Per-candidate notes and citations

**Amazon Creators API.**
The [Creators API docs](https://affiliate-program.amazon.com/creatorsapi/docs/)
require enrollment in Amazon Associates and "at least 10 qualifying sales within
the past 30 days" to access the API; operations are `SearchItems`, `GetItems`,
`GetVariations`, `GetBrowseNodes` across 20+ marketplaces including Spain.
PA-API 5.0 is deprecated 2026-04-30 and retired 2026-05-15
([PA-API registration](https://webservices.amazon.com/paapi5/documentation/register-for-pa-api.html),
[migration coverage](https://blog.freshstore.com/amazon-creators-api-pa-api-retirement/)),
so there is no alternative Amazon API path. Associates itself gives provisional
approval, then **withdraws the application after 180 days without 3 qualifying
sales** ([Associates requirements guide](https://getaawp.com/blog/amazon-affiliate-program-requirements/);
the 2026-04-14 Operating Agreement update tightened this —
[Affiliyo summary](https://affiliyo.com/blog/amazon-associates-april-2026-policy-changes)).
Sales requirements are **per marketplace** ([keywordrush](https://www.keywordrush.com/blog/amazon-creator-api-what-changed-and-how-to-switch/)),
and API access is revoked again after any 30 consecutive days below 10 qualifying
sales. [Program Policies](https://affiliate-program.amazon.com/help/operating/policies)
permit caching non-image Product Advertising Content for at most 24 hours with an
immediate refresh obligation, and prices must come from the API, never entered
manually.

**eBay Browse API + EPN.**
The Browse API returns item summaries and full items with `gtin`, `epid`,
`condition`, price, image, shipping and **seller identity** (`seller.username`,
feedback) — [ItemSummary type](https://developer.ebay.com/api-docs/buy/browse/types/gct:ItemSummary),
[Browse API overview](https://developer.ebay.com/api-docs/buy/browse/overview.html).
Passing the EPN campaign id in `X-EBAY-C-ENDUSERCTX`
(`affiliateCampaignId=<10-digit EPN id>,affiliateReferenceId=<free-form ≤256 chars>`)
makes every response carry `itemAffiliateWebUrl`, a View Item URL with affiliate
tracking baked in ([Browse API](https://developer.ebay.com/api-docs/buy/static/api-browse.html)).
Production access is the real gate: *"use of the APIs in production is
restricted"* — an EPN account, then the **Buy API Application** (business model,
mocks and data flows), an EPN decision within 10 business days, then eBay
Developer Support and **Buy-API-specific contracts**, possibly MNDAs
([Buy APIs Requirements](https://developer.ebay.com/api-docs/buy/static/buy-requirements.html),
[Buy APIs Overview](https://developer.ebay.com/api-docs/buy/static/buy-overview.html)).
Meeting eligibility *"is not a guarantee that production access will be
granted."* Default quota is **5,000 calls/day per application**, raised via the
free [application growth check](https://developer.ebay.com/api-docs/static/gs_use-the-application-growth.html).
The June 2025 [API License Agreement](https://developer.ebay.com/join/api-license-agreement)
adds: content must be **deleted when no longer publicly available** on eBay, and
eBay data may not be used to train AI
([EcommerceBytes summary](https://www.ecommercebytes.com/2025/07/18/ebay-restricts-developers-from-using-its-data-to-train-ai/)).
The Feed API and Order API are Limited Release and are **not** part of this
decision; only Browse is needed. EPN itself is free to join; the current
[Network Agreement](https://partnernetwork.ebay.com/page/network-agreement) is
dated 2026-01-22; commission is 1–4% of gross merchandise bought with
per-category caps and monthly payouts
([rate card](https://partnernetwork.ebay.com/our-program/rate-card),
[Geniuslink summary](https://geniuslink.com/blog/ebay-affiliate-program/)) —
exact current rates and the payout threshold are visible only inside an account:
**requires account approval**.

**Awin product feeds.**
Publishers download a CSV list of visible feeds — advertisers they are joined
to *plus* advertisers who allow pre-join visibility — from
`https://productdata.awin.com/datafeed/list/apikey/[KEY]`, with per-feed
download URLs parameterised for CSV/delimiter/gzip and columns spanning
`search_price`, `store_price`, RRP, `in_stock`, `stock_quantity`, GTIN/EAN/UPC/ISBN,
images and deep links; the list carries `Last Imported` so a scripted sync
downloads only refreshed feeds
([product feed list download](https://help.awin.com/developers/docs/product-feed-list-download)).
Only *mapped* columns are present per feed, so identifier coverage is
per-advertiser and must be measured, not assumed. Joining requires a completed
application and a small **card deposit (£5 UK / $1 US, refunded)** used for
identity verification, with each application manually reviewed
([Awin application process](https://www.awin.com/gb/compliance-and-regulations/application-process-and-joining-fee),
[joining requirements](https://success.awin.com/s/article/What-are-the-requirements-for-joining-the-Awin-network?language=en_US)).
Awin absorbed ShareASale — the platform closed 2025-10-06 with ~9,500
advertisers and ~250,000 publishers migrated in
([Awin announcement](https://www.awin.com/us/news-and-events/awin-news/shareasale-to-awin-upgrade)).
The [Publisher API](https://help.awin.com/apidocs) is OAuth2 (some endpoints
API-key), limited to **20 calls/min per user**, and
[`GET /publishers/{publisherId}/transactions`](https://help.awin.com/apidocs/returns-a-list-of-transactions-for-a-given-publisher)
returns individual transactions with status and commission over windows of at
most 31 days — the reconciliation feed for #67. Network minimum payout is
**$20/€20/£20-equivalent**, configurable upward
([payment thresholds](https://success.awin.com/s/article/What-are-the-payment-thresholds?language=en_US)).

**Impact.com.**
Partners can download brand product catalogs via platform, **FTP or API** in
XML/CSV/TAB with optional gzip
([Download Product Catalogs as a Partner](https://help.impact.com/en/support/solutions/articles/48001236914-download-product-catalogs-as-a-partner));
API access is *"an advanced feature that requires enabling API access"*
([publisher API reference](https://integrations.impact.com/impact-publisher/reference/overview)).
Credible and technically fine, but its brand mix is US-weighted and each brand
approves partners individually; nothing it offers beats Awin for the EEA slot.
Held as the network alternate.

**CJ Affiliate.**
GraphQL endpoint `https://ads.api.cj.com/query` with personal-access-token auth;
`shoppingProductFeeds` lists feeds from **15k+ advertisers without requiring a
join**, while `products` keyword search requires joined advertisers; responses
cap at 1000 records per request
([CJ Developer Portal](https://developers.cj.com/),
[product feeds docs](https://developers.cj.com/docs/data-imports/product-feeds),
[Product Search API announcement](https://junction.cj.com/article/product-discovery-improved-cjs-new-product-search-api)).
Free publisher signup, no deposit. Selected as the **fallback for the
marketplace slot**: it cannot replicate eBay's secondhand inventory or per-item
seller identity, but it is the fastest route to broad multi-merchant product
coverage if the Buy API application is rejected — publisher signup and feed
listing carry no business-model contract.

**Merchant-provided Google-Merchant-style feeds (#63).**
The [Merchant Center product data specification](https://support.google.com/merchants/answer/7052112)
defines the shape #63 implements: required `id`, `title`, `description`, `link`,
`image_link`, `price` (ISO 4217), `availability`
(`in_stock`/`out_of_stock`/`preorder`/`backorder`); conditionally required
`brand`, `gtin` (GS1-valid, checksum-checked), `mpn` (when no GTIN),
`condition` (when not new); XML/TSV formats
([data source overview](https://support.google.com/merchants/answer/15624855)).
Every merchant already selling online has one of these feeds. No external party
can reject or delay it — which is what makes it the guaranteed fallback
demanded by acceptance criterion 5.

## 4. Rejected candidates, and why now

- **Amazon Creators API — rejected on eligibility, not on quality.** The
  criterion chain is circular for a new marketplace: full Associates approval
  needs 3 qualifying sales within 180 days, API access needs 10 qualifying
  sales in the trailing 30 days *per marketplace*, and access lapses again
  after any 30-day quiet period. Mercaria has no outbound affiliate traffic
  today, so it cannot meet, and could not retain, Creators API access. Amazon
  is a **revisit-later**, not a launch source: once #67 is live and Mercaria
  routes real outbound sales, open an Associates account for `amazon.es`,
  meet the sales bar organically, and only then plan an adapter. Selecting it
  now would fail #64's acceptance criterion 2 in the way that criterion exists
  to prevent.
- **Impact.com — deferred.** Capable network, real catalog API, but
  US-weighted brand coverage and account-gated API access make it strictly
  weaker than Awin for the EEA slot. Kept as the network alternate behind CJ.
- **CJ Affiliate — demoted to fallback.** Excellent product-data APIs (the
  best structured of the networks), but advertiser density in Spain/EEA is
  below Awin's, and `products` search needs joined advertisers anyway. It
  launches fast if needed, which is exactly the profile a fallback wants.
- **Controlled extraction / scraping — not a candidate.** #62 defines it as a
  last-resort source type requiring explicit policy review; nothing here needs
  it, and both selected sources contractually forbid substituting it.

## 5. Required accounts, secrets, contracts — human setup required

Everything in this section needs the operator (account creation, a payment
card, business identity, legal review). None of it can be done by an agent.

**Accounts and applications**
- [ ] eBay developer account (developer.ebay.com) for the production keyset.
- [ ] eBay Partner Network account (partnernetwork.ebay.com) — free; yields the
      10-digit `affiliateCampaignId`.
- [ ] **Buy API production application** via EPN: business-model description,
      UX mocks and data flows for Mercaria's product pages; answer the
      confirmation email; expect a decision within ~10 business days; then the
      Developer Support ticket "Buy API Production Access (eBay user ID)".
- [ ] Awin publisher application (ui.awin.com/publisher-signup) — needs
      `mercaria.co` as the promotional property, a description of the
      comparison/marketplace model, and the **£5/$1 card deposit**.
- [ ] Awin: apply to an initial set of ES/EEA advertisers (per-merchant
      approval); generate the **data-feed API key** in Create-a-Feed and an
      OAuth2 token for the Publisher API.
- [ ] (Fallback, do now, it is free) CJ publisher account + personal access
      token, so the fallback is warm.
- [ ] (Deferred) Amazon Associates `amazon.es` — only once outbound traffic
      exists; do not open early, the 180-day clock starts at approval.

**Contracts / legal review**
- [ ] eBay API License Agreement (2025-06-24 revision) + Buy-API-specific
      contracts + EPN Network Agreement (2026-01-22) — review the deletion,
      display and no-AI-training clauses against #62's rights model.
- [ ] Awin publisher terms + per-programme advertiser terms at join time.
- [ ] Mercaria's own merchant-feed ToS for #63 (grants Mercaria the display,
      caching and linking rights the external networks make us negotiate for).

**Secrets** (GitHub Actions repo secrets → SSM `/oxy/mercaria/*`, per the
existing pipeline; never placeholders)
- [ ] `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` (production keyset)
- [ ] `EPN_CAMPAIGN_ID` (not secret in the cryptographic sense, but config)
- [ ] `AWIN_API_TOKEN` (Publisher API OAuth2), `AWIN_FEED_API_KEY` (product
      data download), `AWIN_PUBLISHER_ID`
- [ ] (fallback) `CJ_PERSONAL_ACCESS_TOKEN`, `CJ_PUBLISHER_ID`

## 6. Source-specific data-use rules for #62

These become the rights fields on each source configuration (#62 "Rights and
controlled extraction": store / cache TTL / display price / display media /
outbound links / affiliate params / index / automated refresh).

**eBay (`ebay_browse`)**
1. Store observations; **delete content once the listing is no longer publicly
   available on eBay** — expiry handling in #62 must treat "item gone" as a
   deletion obligation, not just staleness.
2. Display price and availability as returned by the API; refresh within the
   call budget rather than serving stale prices on live product pages.
3. Outbound links are **only** `itemAffiliateWebUrl` (or the plain item URL
   when unattributed); never hand-construct or mutate EPN tracking parameters.
4. No use of eBay content for AI training or model ingestion, ever.
5. Third-party sellers are identified per item (seller username/feedback) and
   must be shown as the merchant on offer surfaces — this is also what #62's
   merchant-identity normalization consumes.
6. Exact image-caching duration: **requires account approval** (Buy API
   contract); until signed, hotlink eBay-hosted images rather than re-hosting.

**Awin (`awin_feed`)**
1. Feed data is licensed for promoting the advertiser; a feed's advertiser
   relationship ending (declined, suspended, left network) revokes display —
   #62's `revoked` source status, without deleting audit history.
2. Only mapped columns exist per feed; the adapter must record per-feed column
   presence and never fabricate absent identifiers.
3. Outbound links use the feed's `aw_deep_link` unmodified; commission
   attribution belongs to the link, so #67 redirects must not strip or rewrite
   its parameters.
4. Cache TTL: keyed to the feed-list `Last Imported` timestamp — an offer is
   stale once its feed has been re-imported and the row is gone or changed; no
   published global TTL, per-programme terms override.
5. Publisher API budget: 20 calls/min, transaction queries ≤31-day windows —
   reconciliation jobs must chunk accordingly.

**#63 merchant feeds (`merchant_feed`)**
1. Rights are whatever Mercaria's merchant-feed ToS grants — write that ToS so
   the rights fields of #62 are simply true: storage, display, indexing and
   linking granted by submission; deletion on merchant request.
2. GTIN validation per the Google spec (GS1 checksum) at ingestion.

## 7. Estimated sync frequency and infrastructure load

All numbers here are **estimates**, bounded by documented quotas.

- **eBay:** 5,000 calls/day default. Assumed split: ~1,000/day interactive
  search (user-facing category/search backfill), ~4,000/day offer refresh.
  `getItems` batches up to 20 items/call, so the refresh budget covers roughly
  **80k item-refreshes/day** — enough for an initial corpus of ~40k tracked
  offers at twice-daily price/availability refresh. Beyond that, the
  application growth check. Load: pure JSON API traffic, no bulk files;
  negligible storage beyond #62's observation rows.
- **Awin:** one feed-list poll per hour (a single CSV), plus per-advertiser
  gzip CSV downloads **only when `Last Imported` moved** — typically daily per
  advertiser. Assume 10–50 advertisers at launch, feeds in the single-digit-MB
  gzip range: tens of MB/day transfer, one streaming-parse worker
  (#63's importer), bulk-upsert into observations. Publisher API
  reconciliation: a few calls/day, far under 20/min.
- Both adapters run inside #62's outbox/lease worker pattern on the existing
  ECS tasks; no new infrastructure is required for launch volumes. Postgres
  growth is dominated by observation rows — bounded by #62's retention rule,
  not by provider volume.

## 8. Revenue assumptions — assumptions, not forecasts

- ASSUMPTION: eBay outbound conversions commission at 1–4% of GMB with
  per-category caps; EU category rates for ES/DE/FR/IT/GB are visible only in
  an approved EPN account.
- ASSUMPTION: Awin advertiser CPA in fashion/home/electronics typically ranges
  low-single-digit to ~10% per sale; actual rates are per-programme and known
  only after joining.
- ASSUMPTION: affiliate revenue at launch is validation signal, not income:
  it proves the attribution loop (#67) end to end. No revenue figure in this
  document is a forecast, and nothing downstream may treat one as such.

## 9. Go/no-go gates before public ingestion

A source ships to public product pages only when every gate for it is green:

1. **Contract gate:** the relevant application is approved and contracts are
   signed (eBay: Buy API production + EPN; Awin: publisher approval + ≥1
   advertiser joined). A sandbox key never feeds public pages.
2. **Rights gate:** the source row in #62 carries the §6 rules encoded in its
   rights fields, reviewed against the signed terms — display without an
   encoded rights verdict is a bug, not a default.
3. **Sample gate:** a real sample (≥1,000 records per source) mapped into the
   #62 candidate DTO with measured GTIN coverage, duplicate rate and
   field-quality numbers recorded in this directory as a dated follow-up.
   (Blocked today — §10.)
4. **Attribution gate:** one real tracked click → conversion → commission row
   observed through EPN reporting / the Awin transactions endpoint before any
   revenue claim.
5. **Budget gate:** measured refresh volume fits the documented quota with
   ≥50% headroom; eBay beyond that files the growth check *before* launch, not
   after throttling.
6. **Kill-switch gate:** pausing/revoking the source in #62 demonstrably stops
   display and refresh without deleting observations.

## 10. Validation status — what was and was not verified

Per #64's acceptance criterion 1, this decision is built on current official
documentation, cited inline above. The issue's validation steps that require an
approved account were **not performable** in this environment (account
creation needs the operator, a payment card and business identity — §5):

- No publisher/developer account was created; no API credential exists yet.
- No representative sample was obtained; identifier completeness, duplicate
  rate and freshness are therefore **unmeasured**, and §3 marks every such
  cell "requires account approval" rather than inventing a number.
- Affiliate-link generation before approval: eBay — no (the affiliate URL is
  minted by the API under an EPN campaign id); Awin — no (deep links exist
  per feed row, but feeds beyond the pre-join preview set require joining).
- The sample gate (§9.3) is the explicit follow-up that closes this: run it
  first thing after the §5 accounts exist, and commit the measurements as a
  dated addendum in `docs/catalog-sources/`.

## Acceptance criteria of #64, answered

1. *Current official documentation, not memory* — every load-bearing fact in
   §3 carries a source URL fetched 2026-08-09; unverifiable facts are marked
   "requires account approval", and §10 states exactly what remains unmeasured.
2. *Amazon only if requirements are actually met* — Amazon is **not selected**;
   §4 shows Mercaria fails the 3-sales/180-day and 10-sales/30-day
   requirements today and would also fail retention.
3. *Complementary, not duplicative* — §1: marketplace inventory with per-item
   sellers (eBay, incl. secondhand) vs retailer-network SKU feeds (Awin).
4. *Display and caching rights explicit enough to enforce* — §6 encodes
   per-source rules in #62's rights vocabulary, including eBay's
   delete-on-unavailability and Awin's revoke-on-relationship-end.
5. *A fallback that can launch if rejected or delayed* — CJ (free signup, no
   business-model contract) for the marketplace slot; #63 merchant feeds for
   the network slot, which no external party can reject at all.
6. *Follow-up adapter issues updated* — see the note below; the retitle is a
   separate action on the issues, deliberately not performed by this commit.

## Follow-up: retitle #65 / #66

- **#65** ("Implement the first broad marketplace catalog source selected in
  #64") should become: **"Implement the eBay Browse API catalog source (EPN
  attribution)"** — scope: OAuth client-credentials, `search`/`getItems`
  ingestion behind the #62 adapter contract, `X-EBAY-C-ENDUSERCTX` attribution,
  delete-on-unavailability lifecycle, 5,000-call/day budget management.
- **#66** ("Implement the first retailer-network or affiliate-feed source
  selected in #64") should become: **"Implement the Awin product-feed source
  (per-advertiser feeds + Publisher API reconciliation)"** — scope: feed-list
  polling on `Last Imported`, gzip CSV streaming through #63's importer,
  per-feed column-presence tracking, `aw_deep_link` outbound integration with
  #67, transactions reconciliation in ≤31-day windows.
- #67 consumes both: `itemAffiliateWebUrl` and `aw_deep_link` are the two
  redirect targets its attribution model must carry at launch.
