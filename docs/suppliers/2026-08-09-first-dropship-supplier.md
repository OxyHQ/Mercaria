# First B2B dropship supplier for the bounded Mercaria retail pilot

- **Status:** Decided — **Printful** selected for the bounded pilot; pilot **entry remains gated** on the human-operated checklist below (acceptance criteria 2, 3 and 9 of [#119](https://github.com/OxyHQ/Mercaria/issues/119) are not satisfied by this document)
- **Date:** 2026-08-09
- **Issue:** [#119](https://github.com/OxyHQ/Mercaria/issues/119), part of epic [#116](https://github.com/OxyHQ/Mercaria/issues/116); feeds the first supplier adapter and pilot ([#125](https://github.com/OxyHQ/Mercaria/issues/125))
- **Binding architecture:** [ADR 0004](../adr/0004-mercaria-retail-dropship.md) — zero-markup cost recovery (D3), immediate capture + compensating refund (D4), prefunded supplier balance (D6), variance → customer adjustment (D8), EU-customs-territory-only suppliers (D2.9)
- **Evidence current as of:** 2026-08-09

## Method and evidence register

Every claim below carries its source. Facts that could not be verified against a
current official page or that require a signed-in account, a contract or a
support answer are marked **requires account/contract** — per #119, *unknown is
not passing*, so an unverified fact scores as absent, never as assumed.

Observed constraints of this evaluation, recorded because they shaped the
evidence:

- `bigbuy.eu` refuses automated retrieval (HTTP 403 on every page tried,
  including the official API guide PDF). BigBuy facts below come from
  search-indexed official BigBuy pages (`bigbuy.eu` documents surfaced verbatim
  through search) and from one dated secondary source for subscription prices,
  each marked.
- The vidaXL dropship program's official sites were **down during the entire
  evaluation window** (2026-08-09): `dropshippingxl.com` serves "The site is
  currently unavailable" (including its API documentation page) and
  `dropxl.com` answers 403. That is itself a data point about operational
  maturity; all vidaXL facts are secondary and its confidence is scored low.
- Printful's marketing site, pricing page and developer documentation were all
  directly retrievable; its help-center articles were retrieved through
  search-indexed content.
- No candidate account was created and no contract was signed: **no evidence
  below is contractual**. Every "rights" row is public-documentation evidence
  plus a named account-gated confirmation step.

## 1. Candidate set

Per #119, six candidates, none silently assumed approved:

| # | Candidate | Model | One-line verdict |
|---|---|---|---|
| 1 | **BigBuy** ([bigbuy.eu](https://www.bigbuy.eu/en/dropshipping.html)) | Broad-catalog EU wholesaler, stocked, subscription-gated dropship API | Runner-up. Broadest fit, but a mandatory subscription Mercaria must absorb, and a returns model that strands withdrawal goods on a company with no warehouse |
| 2 | **Printful** ([printful.com](https://www.printful.com/pricing)) | Print-on-demand + white-label fulfilment, EU production, pay-per-order | **Selected.** Quote-complete before order, no mandatory fixed cost, no stock risk, EU fulfilment |
| 3 | **vidaXL dropshipping / dropXL** ([dropshippingxl.com](https://www.dropshippingxl.com/)) | Stocked home & garden B2B dropship, feed + API | Not now. Official program sites unreachable during evaluation; conflicting secondary evidence on cost; re-evaluate when its own front door answers |
| 4 | **Avasam** ([avasam.com](https://www.avasam.com/)) | Vetted UK supplier marketplace | **Hard-gate fail.** Suppliers ship from the UK — outside the EU customs territory — which ADR 0004 D2.9 makes ineligible at launch regardless of score |
| 5 | **Direct manufacturer/distributor** | Bilateral supply agreement | **None is available to Mercaria today.** Every such agreement requires human outreach, negotiation and signature that have not happened; there is no candidate to score |
| 6 | **No-go** | Launch nothing | Live threshold in the matrix: any winner must clear 3.00/5.00 weighted AND every hard gate, else no-go wins |

## 2. Commercial and contractual evidence (issue §Commercial, 15 items)

Legend: ✅ verified against a public official source (cited) · ◐ partial public
evidence · ❔ **requires account/contract** · ✖ evidence against.

| # | Item | BigBuy | Printful | vidaXL/dropXL | Avasam |
|---|---|---|---|---|---|
| 1 | Legal contracting entity | ❔ Spanish wholesaler (Valencia-area logistics per its own site, which blocks retrieval); exact entity name/CIF from the contract | ◐ Printful, Inc. (US) with EU operations; EU fulfilment subsidiaries in Latvia and Spain ([fulfilment centers](https://help.printful.com/hc/en-us/articles/360014067239-Where-are-the-Printful-fulfillment-centers-located), [Wikipedia](https://en.wikipedia.org/wiki/Printful,_Inc)); contracting entity for an ES account ❔ | ❔ vidaXL group (NL); site down | ❔ Avasam Ltd (UK) per its site; unconfirmed |
| 2 | Account approval status | ✖ **No account exists** | ✖ **No account exists** | ✖ No account; registration currently impossible (site down) | ✖ No account |
| 3 | Wholesale / resale / dropship rights | ◐ Dropshipping is the product itself ([dropshipping](https://www.bigbuy.eu/en/dropshipping.html)); the written scope ❔ | ◐ The product is fulfilment of goods sold under the customer's own brand ([white-label](https://www.printful.com/white-label-products)); written scope ❔ | ◐ Official B2B dropship program exists ([ecommercenews](https://ecommercenews.eu/vidaxl-now-offers-dropshipping/)); terms unreachable ❔ | ◐ Dropship marketplace by design; supplier-level rights vary ❔ |
| 4 | Permission to sell through Mercaria's own checkout and marketplace surfaces | ◐ "Ecommerce" channel (own webshop) is the base pack; whether a first-party shop **on Mercaria's own marketplace domain** counts as ecommerce or needs the marketplace pack ❔ — ask before signing | ◐ API/custom-platform integration is a first-class channel ([developer docs](https://developers.printful.com/docs/)); no channel restriction found in public docs; written confirmation ❔ | ❔ | ❔ |
| 5 | Allowed countries, destinations, channels | ◐ EU-wide delivery from EU stock; per-carrier country lists in the API ([carriers endpoint, API guide](https://www.bigbuy.eu/public/doc/Guia_API_BigBuy_EN.pdf)) | ◐ Ships worldwide; EU orders servable from Riga (LV) and Barcelona (ES) ([fulfilment centers](https://help.printful.com/hc/en-us/articles/360014067239-Where-are-the-Printful-fulfillment-centers-located)); **routing is Printful's choice** — see technical row 20 | ◐ 30+ countries claimed ([woosa guide](https://www.woosa.com/blog/vidaxl-dropshipping/)) | ✖ UK suppliers; "Europe Only" flags on some products ([avasam.com](https://www.avasam.com/)); **UK origin fails D2.9** |
| 6 | Brand / category / SKU restrictions | ◐ Real and marketplace-dependent: restricted-brand blacklist, violation alerts, appeal needs an authorization document plus a 20-unit purchase invoice ([marketplace FAQ](https://www.bigbuy.eu/academy/en/selling-marketplaces-faqs/)) | ✅ None applicable — Printful fulfils only its own catalogue printed with Mercaria-supplied designs; the restriction burden flips to **Mercaria's own IP diligence on designs** | ❔ | ❔ |
| 7 | Catalog / image / description / price-data rights | ◐ 24-language catalogue licensed to subscribers ([pricing, secondary](https://dodropshipping.com/bigbuy-pricing-plans/)); exact licence ❔ | ◐ Catalogue API public (unauthenticated, rate-limited) ([docs](https://developers.printful.com/docs/)); product-image use rights per ToS ❔ | ❔ | ❔ |
| 8 | White-label / packing slip / invoice / supplier-brand behaviour | ◐ White-label and custom-packaging services advertised ([solutions](https://www.bigbuy.eu/en/solutions-dropshipping-wholesale-purchasing.html)); "no invoice in parcel" default ❔ — must be contractually pinned (ADR 0004 D2.3 blind-dropship clause) | ✅ Packing slips are white-label with the store's own details; "your shipments won't include any Printful branding on or inside the package" ([packaging](https://help.printful.com/hc/en-us/articles/360014006620-Does-the-packaging-include-any-Printful-branding), [packing slip](https://help.printful.com/hc/en-us/articles/360014065499-What-does-the-packing-slip-look-like)) — still verified physically at the test-order gate | ◐ Ships "under your business name" ([woosa](https://www.woosa.com/blog/vidaxl-dropshipping/)) | ❔ |
| 9 | Minimum commitments / subscriptions / deposits / prefunding / credit | ✖ **Mandatory subscription**: Pack Ecommerce €89/mo (€74.17/mo annual) + €89 registration; Pack Marketplace €119/mo; B2B pack capped at 3 purchases/mo ([current prices, secondary, updated 2026-08-05](https://dodropshipping.com/bigbuy-pricing-plans/)); wallet loads by bank transfer **min €300** ([wallet](https://www.bigbuy.eu/academy/en/what-is-it-and-how-to-use-the-wallet-in-my-bigbuy-account/)) | ✅ **No mandatory fee**: Free plan $0, pay per order; optional Growth $24.99/mo (free past $12K/yr sales) for up to 33% product discount ([pricing](https://www.printful.com/pricing)); Wallet min top-up USD 10 ([wallet](https://help.printful.com/hc/en-us/articles/360014009500-What-is-the-Printful-Wallet-and-how-does-it-work)) | ◐ Conflicting: "registration free, no monthly cost" ([woosa](https://www.woosa.com/blog/vidaxl-dropshipping/)) vs "€30/month subscription" ([appscenic](https://appscenic.com/blog/dropshipping-with-vidaxl-review/)); official page down ❔ | ◐ Free £0 (browse) → Starter £24.99 → Advanced £49.99 → Business £99.99 → Guru £199.99/mo ([avasam.com/pricing](https://www.avasam.com/pricing/)) |
| 10 | Wholesale pricing and discount tiers | ◐ Wholesale prices in catalogue/API; tier detail ❔ | ✅ Published flat catalogue prices; Growth tier −up to 33% ([pricing](https://www.printful.com/pricing)) | ◐ Wholesale price + shipping per feed ([woosa](https://www.woosa.com/blog/vidaxl-dropshipping/)) | ❔ per supplier |
| 11 | Returns / withdrawal / warranty / defective / lost parcel / recall responsibilities | ✖ **BigBuy does not take back change-of-mind returns** — the reseller handles withdrawal returns itself; defective/incident window is **48 h from delivery** for dropship parcels; BigBuy pays return carriage on defects, free pickup only ≥ €90 value ([after-sales conditions](https://www.bigbuy.eu/en/after-sales-conditions.html), [guarantee](https://www.bigbuy.eu/en/guarantee.html)). Mercaria has no warehouse: every EU 14-day-withdrawal return would strand goods | ◐ No buyer's-remorse returns (made-to-order); damaged/misprinted → free reshipment or refund **without returning the item**, claim window 30 days from delivery; undeliverable parcels held 30 days ([returns policy](https://www.printful.com/policies/returns), [help](https://help.printful.com/hc/en-us/articles/360014006840-How-are-returns-handled-for-quality-issues-vs-customer-change-of-mind)). No goods-stranding problem, but see the withdrawal-right legal risk in §8 | ❔ "flexible return policy" claimed, no specifics ([woosa](https://www.woosa.com/blog/vidaxl-dropshipping/)) | ❔ per supplier |
| 12 | Service-level commitments and remedies | ❔ | ❔ (production/delivery estimates published, not contractual SLAs) | ❔ | ❔ |
| 13 | Customer-data processing terms | ❔ DPA at contract | ❔ DPA at contract | ❔ | ❔ |
| 14 | Termination / deauthorization / data deletion | ❔ | ❔ | ❔ | ❔ |
| 15 | Lock-in and concentration risk | ◐ Subscription + connector coupling; catalogue is multi-brand so SKUs are re-sourceable | ◐ Designs and listings are Mercaria's; the *products* are Printful-proprietary blanks — a supplier exit ends those SKUs (acceptable for a pilot whose SKUs are bounded) | ◐ Low (free feed model, own-brand goods) | ◐ Marketplace intermediation doubles the counterparty count |

**An affiliate or publisher agreement is not resale evidence** (#119): none of
the four is evaluated on affiliate terms, and ADR 0004 D2.10 already bars
launching `mercaria_retail` from an affiliate feed or consumer retail account —
restated here as acceptance criterion 9's gate.

## 3. Technical evaluation (issue §Technical, 20 items)

Same legend. "Sandbox-verified" was impossible without accounts; rows say what
documentation states and what the gate must exercise.

| # | Capability | BigBuy | Printful | vidaXL/dropXL | Avasam |
|---|---|---|---|---|---|
| 1 | Product catalog access | ✅ REST JSON catalogue ([API](https://www.bigbuy.eu/en/api_bigbuy.html), [guide PDF](https://www.bigbuy.eu/public/doc/Guia_API_BigBuy_EN.pdf)) | ✅ Catalog API, public read, 30 req/60 s unauthenticated ([docs](https://developers.printful.com/docs/)) | ◐ Feed (CSV/XML) + product API ([docs page — down](https://www.dropshippingxl.com/sk/api-documentation.html)) | ◐ Platform UI + CSV; API gated to higher tiers ([webretailer](https://www.webretailer.com/reviews/avasam/)) |
| 2 | Stable supplier SKU / variant identity | ◐ Product references used in order payloads (guide) | ✅ Catalog variant ids; sync-variant ids for stored products ([docs](https://developers.printful.com/docs/)) | ❔ | ❔ |
| 3 | GTIN/EAN/UPC/MPN, brand coverage | ◐ Branded catalogue implies EANs; field-level confirmation ❔ | ◐ POD goods have no retail GTIN; blanks carry model/composition data — GTIN-dependent surfaces must not assume one | ❔ | ❔ |
| 4 | Current wholesale cost and currency | ◐ Wholesale price in EUR via catalogue/API ❔ field-level | ✅ Catalogue prices via API; account billing currency selectable, EUR supported ([currencies](https://support.printful.com/hc/en-us/articles/41396636624401-What-currencies-does-Printful-support)) — but see row 20/§4 on the Wallet-vs-EUR constraint | ◐ EUR feed prices (secondary) | ◐ GBP |
| 5 | Stock freshness | ◐ Stock endpoints + sync tooling; update cadence ❔ | ✅ Structurally strongest: made-to-order, no stock-out concept for standard items; v2 pushes stock updates refreshed every 5 min for blank availability ([v2 docs](https://developers.printful.com/docs/v2-beta/)) | ◐ 30-min plugin sync claimed ([woosa](https://www.woosa.com/blog/vidaxl-dropshipping/)) | ◐ 30-min sync claimed ([avasam.com](https://www.avasam.com/)) |
| 6 | Destination-aware shipping quote | ✅ Carriers/services with costs and per-country coverage; order **check** returns the order total without creating it ([guide PDF](https://www.bigbuy.eu/public/doc/Guia_API_BigBuy_EN.pdf)) | ✅ Shipping-rates endpoint with methods, costs, delivery estimates, customs indicators ([docs](https://developers.printful.com/docs/), [v2](https://developers.printful.com/docs/v2-beta/)) | ◐ Shipping cost data in program docs ❔ | ❔ |
| 7 | Delivery estimates and carriers | ✅ Carrier list with delay per service (guide) | ✅ Delivery estimates incl. estimated delivery dates in v2 ([v2 docs](https://developers.printful.com/docs/v2-beta/)) | ◐ Tracking codes provided | ❔ |
| 8 | Tax / customs / duty / incoterm data | ◐ Intra-EU B2B; Spanish supplier → Spanish VAT on invoice to a Spanish entity (input-deductible); no customs (EU stock). API-level tax fields ❔ | ✅ Tax-rate calculation endpoint; EU VAT behaviour documented: with a non-LV EU VAT ID, 0 % reverse charge where applicable ([EU VAT](https://help.printful.com/hc/en-us/articles/4402032573586-How-is-VAT-applied-to-my-EU-bound-orders), [VAT ID](https://help.printful.com/hc/en-us/articles/360014008640-How-do-I-submit-my-VAT-ID-to-Printful)); Barcelona-fulfilled domestic-ES supplies expected to carry ES VAT (input-deductible) — accountant confirmation ❔ | ❔ | ❔ |
| 9 | Order draft / submit / accept / cancel | ✅ `order/check` (validate + total, creates nothing) then `order/create`; multishipping check exists ([guide PDF](https://www.bigbuy.eu/public/doc/Guia_API_BigBuy_EN.pdf)) | ✅ Draft order → add/update items → **estimate costs** → explicit **confirm**; cancellation supported ([docs](https://developers.printful.com/docs/), [v2](https://developers.printful.com/docs/v2-beta/)) — draft/confirm split maps 1:1 onto ADR 0004's PO `draft → submitted` | ◐ Order API exists; states ❔ | ❔ |
| 10 | Client reference / idempotency support | ❔ Not documented in retrievable material — the #124 adapter must build convergence on its own PO-id dedupe and post-submit reads | ◐ `external_id` on orders serves as the client reference; a documented idempotency-key header is **not** in the retrieved docs ❔ — same #124 mitigation | ❔ | ❔ |
| 11 | Tracking and shipment updates | ✅ Tracking endpoints (guide) | ✅ Shipment webhooks + v2 tracking events, departure country included ([v2 docs](https://developers.printful.com/docs/v2-beta/)) | ◐ Tracking via API/plugin | ◐ |
| 12 | Partial shipment / backorder behaviour | ❔ | ◐ Multi-item orders can ship in parts; per-shipment data exists; backorders structurally absent (made-to-order) | ❔ | ❔ |
| 13 | Returns / RMA path | ◐ After-sales flow exists; **48 h incident window** is tight and must be automated against | ✅ Claim-based (no physical return for defects), 30-day window ([returns](https://www.printful.com/policies/returns)) | ❔ | ❔ |
| 14 | Supplier invoice / credit-note availability | ❔ Dashboard invoices assumed, format ❔ — #128 needs line-level PO traceability | ❔ Same; Wallet statement + order receipts exist, export format ❔ | ❔ | ❔ |
| 15 | Webhooks / polling / state definitions | ◐ Polling-first; webhook support ❔ | ✅ Webhooks with HTTPS enforcement, expiry, request signing; price-change and stock events ([v2 docs](https://developers.printful.com/docs/v2-beta/)) — fits the D10 callback-verification row | ❔ | ❔ |
| 16 | Rate limits / pagination / bulk feeds | ◐ Documented in guide (unretrievable); bulk CSV feeds exist | ✅ 120 req/60 s leaky bucket with standard `X-Ratelimit-*` headers ([v2 docs](https://developers.printful.com/docs/v2-beta/)) | ◐ Feed-based bulk | ❔ |
| 17 | Test environment / test orders | ✅ **Dedicated sandbox**: `api.sandbox.bigbuy.eu` ([guide PDF](https://www.bigbuy.eu/public/doc/Guia_API_BigBuy_EN.pdf)) | ◐ **No separate sandbox found in public docs.** Draft orders + estimate endpoints exercise everything except fulfilment without billing; the paid test order at the gate covers the rest | ❔ | ❔ |
| 18 | Credential rotation / security requirements | ◐ API key auth; rotation policy ❔ | ◐ Private tokens (scoped, expiring) or OAuth apps ([docs](https://developers.printful.com/docs/)); rotation is self-serve in the developer portal | ◐ Per-account API token | ❔ |
| 19 | Support escalation / incident response | ❔ | ❔ (24/7 support advertised on [pricing](https://www.printful.com/pricing); escalation path ❔) | ❔ — and the observed multi-hour public-site outage is the available datum | ❔ |
| 20 | Data retention / deletion requirements | ❔ | ❔ | ❔ | ❔ |

**The capability Mercaria must NOT design around** (#119's closing rule for
this section): Printful publishes no per-order guarantee that an EU-destination
order is fulfilled from an EU facility — routing is Printful's optimisation.
ADR 0004 D2.9 requires EU-customs-territory dispatch. The pilot therefore pins
**only SKUs whose EU availability the catalogue confirms**, the test order
verifies the dispatch origin physically, and a non-EU dispatch is a pilot stop
condition (§10). This is a bound the #125 adapter enforces, not an assumption.

## 4. Cost-only economics (issue §Cost-only economics, 12 components)

Per ADR 0004 D3 the customer amount is the sum of the enumerated, evidenced
direct components with planned profit, markup and margin all zero, and an
unknown direct cost fails closed. Assessment per component, for the selected
model (Printful) with the BigBuy contrast where it decides:

| # | Component | Printful (selected) | BigBuy (contrast) |
|---|---|---|---|
| 1 | Supplier product acquisition cost | Catalogue price via API, fixed and published; known **pre-checkout** | Wholesale price via API, known pre-checkout |
| 2 | Mandatory subscription / per-order platform cost "directly attributable under the approved policy" | **None exists.** The Free plan is complete for API ordering ([pricing](https://www.printful.com/pricing)) — the cleanest possible answer for zero-markup retail | **€89/mo + €89 registration is mandatory** and shared across all orders. Attributing it per order requires dividing by a forecast order volume — a profit-shaped allocation with no per-order evidence line, which D3's prohibition on general-overhead allocation excludes from the customer amount. **Decision: under the approved policy a fixed mandatory subscription is Mercaria-absorbed, never priced** — which makes BigBuy structurally loss-making at pilot volume (≈ €1,157/yr absorbed before the first order) |
| 3 | Pick, pack and handling | Included in the product price (fulfilment is the product) | Stated per order where charged; quote line ❔ |
| 4 | Destination-specific shipping | Shipping-rates API pre-checkout ([docs](https://developers.printful.com/docs/)) | Order-check total / carriers API pre-checkout |
| 5 | VAT / sales tax / customs / duty | Customer-side: Mercaria's own output VAT via the existing `TaxRate` engine (OSS/domestic), per D2.9. Supplier-side B2B VAT is **input-deductible and never a customer cost**; reverse charge applies per Printful's EU VAT rules with a submitted ES VAT ID ([EU VAT](https://help.printful.com/hc/en-us/articles/4402032573586-How-is-VAT-applied-to-my-EU-bound-orders)). Customs structurally zero (EU dispatch, D2.9) | Same structure; ES↔ES B2B carries ES VAT, deductible |
| 6 | Actual attributable FX cost | **Real, small, and must be snapshotted**: Printful's Wallet is USD-denominated — choosing EUR billing *disables the Wallet* and bills a stored card per order ([currency change](https://support.printful.com/hc/en-us/articles/41396636706193-How-do-I-change-the-currency-on-Printful)), and a per-order stored card is rejected by ADR 0004 D6.2. The D6-compliant path is the **USD Wallet**, so each order carries a measurable EUR→USD conversion cost captured as an `FxRateSnapshot` from the funding top-up (D3.4) | None: EUR-native wallet loaded by SEPA transfer ([wallet](https://www.bigbuy.eu/academy/en/what-is-it-and-how-to-use-the-wallet-in-my-bigbuy-account/)) — BigBuy's one clean win |
| 7 | Stripe processing cost | Estimated at charge from published pricing — Spain: **1.5 % + €0.25** standard EEA cards, 2.5 % + €0.25 UK, 3.15 % + €0.25 international ([stripe.com/en-es/pricing](https://stripe.com/en-es/pricing)) — trued to the real balance-transaction fee at reconciliation (ADR 0004 D8.7); pass-through only where lawful, never padded | Same (rail-side, supplier-independent) |
| 8 | Other unavoidable direct order-specific charges | Optional branding extras only if a policy version approves them; none mandatory | Carrier surcharges where quoted |
| 9 | **Amount that cannot be known before checkout** | Structurally none: product + shipping + tax are all quotable pre-confirmation via the estimate endpoints; residual unknowns are the fee true-up delta and the FX true-up — both *provisional* class per D8.1, both small, both reconciled | Stock-move risk between quote and order; otherwise similar |
| 10 | Cost variance quote → final invoice | Low: published flat prices; variance sources are FX and fee true-up | Moderate: wholesale price changes, stock substitutions refused (D9.5), carrier re-quotes |
| 11 | Cash-flow timing | Buyer charged at capture → Wallet drawn at PO acceptance (D6.4) → refunds per D8.5. Wallet prefund is the float; min top-up USD 10 keeps it small | Same shape; wallet min load **€300** raises the idle float |
| 12 | Minimum practical order value / category floor from fixed costs | Shipping dominates small orders (a single mug's carriage can exceed its cost) — the pilot's per-order minimum (below) exists for honesty of the total, not for margin | Same, plus the absorbed subscription pressures toward volume Mercaria must not price for |

**Prohibitions check** (#119's six): no percentage markup, no target margin, no
fixed profit, no overhead allocation (the BigBuy subscription decision above is
this rule applied), no support/return/fraud/chargeback reserve in price (ADR
0004 D12.5 funds those outside the customer amount), no referral or acquisition
cost. The pricing-policy version for the pilot (#120) must encode all six.

**Preference conclusion** (#119: prefer suppliers whose APIs make direct cost
complete and stable): Printful is the only candidate whose API returns the
**entire** direct cost — product, fulfilment, shipping and tax — as one
estimate before any order exists. BigBuy quotes product + carriage well but
carries an unpriceable fixed cost; vidaXL's quote surface could not be
inspected; Avasam's cost story is per-supplier and gated. A supplier revealing
material costs only after payment would fail this section; none of the four
does that structurally, but only Printful makes the quote complete in one call.

## 5. Cost-variance stress test (issue §Stress test, 8 scenarios)

Run against each candidate *model*: **POD/made-to-order** (Printful),
**stocked wholesaler + subscription** (BigBuy), **stocked free-feed** (vidaXL).
Consequences are stated in ADR 0004's vocabulary: absorbed variance is a
ledger-visible loss (D7 proof 2), positive variance goes to
`customer_adjustment` under #128, and *absorbed variance is never called a
planned margin loss — planned margin is zero by design*.

| # | Scenario | POD (Printful) | Stocked + subscription (BigBuy) | Stocked free-feed (vidaXL) |
|---|---|---|---|---|
| 1 | Supplier cost rises after quote | Rare: published prices move on notice; v2 emits **price-change webhooks**, so quotes can be invalidated proactively. Post-charge rise → absorb ≤ cap, else cancel+refund (D3) | More likely (wholesale repricing); same D3 branches | Same as BigBuy, with 30-min feed lag as the detection bound |
| 2 | Shipping rises after quote | Low: rates re-fetched at estimate seconds before charge | Moderate: carrier re-quote at order time; `order/check` immediately pre-charge narrows it | Moderate |
| 3 | FX moves | **Present by construction** (USD Wallet): the EUR/USD move between top-up and draw is real variance, bounded by keeping the float small; snapshot at top-up per D3.4 | Absent (EUR SEPA wallet) | Absent (EUR) |
| 4 | Provider (Stripe) fee differs from estimate | Identical for all: trued at reconciliation; over-estimate → positive variance → customer adjustment (D8.7a) | idem | idem |
| 5 | Supplier grants a later credit | Books `supplier_prepaid`/`procurement_expense` (D7); never netted against the customer (D8.5) | idem | idem |
| 6 | Partial cancellation changes shipping allocation | Per-line partial refund; remaining lines' shipping re-derived from the snapshot's per-line evidence; any orphaned shipping delta is absorbed variance | idem, larger amounts (bulkier goods) | idem |
| 7 | Return generates partial/full supplier credit | Defect claims credit **without physical return** — no reverse-logistics cost. Withdrawal returns: no supplier credit exists (made-to-order) → the full withdrawal refund is absorbed; bounded by the pilot's order-value cap and the §8 legal analysis | Withdrawal: **no supplier take-back at all** → refund absorbed AND goods stranded (no Mercaria warehouse) — the worst cell in this table | Return path unverifiable today |
| 8 | Duplicate supplier charge | Wallet draw keyed on PO id; #128 statement reconciliation one-to-one (D6.6) catches what supplier dedupe misses | idem | idem |
| — | **Expected absorbed variance / adjustment frequency** | Absorbed: FX drift (est. < 1 % of supplier cost at a small float) + fee true-up deltas + rare withdrawal refunds. Customer adjustments: expected mainly from fee over-estimates, low single-digit % of orders | Above **plus ≈ €11/order at 8 orders/mo (€89 ÷ volume)** of absorbed subscription (not variance, but the same "recovery < cost" inequality) plus stock-discrepancy refund absorption | Unquantifiable today — itself disqualifying under "unknown is not passing" |

## 6. Product and fulfilment quality (issue §Quality, 12 items)

No candidate account exists, so **real-order sampling could not be executed**;
this section records what public evidence answers now and binds the rest to the
test-order gate (§11) — honestly gated, not assumed.

| # | Dimension | Evidence now | Gate measurement |
|---|---|---|---|
| 1 | Identifier completeness / catalog accuracy | Printful catalogue API exposes variants, size guides, composition ([docs](https://developers.printful.com/docs/)) | Field audit of the pilot SKU set |
| 2 | Duplicate / variant quality | POD variants are systematic (size × colour) | Spot-check 25 SKUs |
| 3 | Stock discrepancy rate | Structurally ~0 for made-to-order; blank-level stock exposed at 5-min refresh ([v2](https://developers.printful.com/docs/v2-beta/)) | Track discontinued-blank events during pilot |
| 4 | Price-change frequency | Price-change webhooks exist (same) | Log events for 30 days |
| 5 | Packaging quality / external branding | White-label claim ([packaging](https://help.printful.com/hc/en-us/articles/360014006620-Does-the-packaging-include-any-Printful-branding)) | **Physical inspection of the test parcel** — no supplier branding, no supplier invoice, no price |
| 6 | Tracking latency | v2 tracking events documented | Measure ship-event → webhook delta on the test order |
| 7 | Delivery-time accuracy | 3–5 business days intra-EU claimed ([fulfilment centers](https://help.printful.com/hc/en-us/articles/360014067239-Where-are-the-Printful-fulfillment-centers-located)) | Compare promise vs actual on the test order |
| 8 | Cancellation acceptance | Draft orders cancel freely; confirmed-order cancellation window ❔ | Cancel one draft AND attempt one post-confirm cancel |
| 9 | Return / RMA experience | Claim-based, 30-day window ([returns](https://www.printful.com/policies/returns)) | File one deliberate defect claim if the test article shows any flaw |
| 10 | Product condition / defect handling | Reprint-or-refund without return (same) | Inspect test article print quality |
| 11 | Customer-facing parcel documentation | White-label slip with store contact details ([packing slip](https://help.printful.com/hc/en-us/articles/360014065499-What-does-the-packing-slip-look-like)) | Verify slip carries Mercaria contact data, no supplier pricing |
| 12 | Restricted-product exclusion capability | Not applicable to Printful's own catalogue; Mercaria's design-IP screening is the control | #121 eligibility gate refuses unscreened designs |

## 7. Compliance review (issue §Compliance, 10 items) — launch markets and categories

Scope: Spain (single launch market, §10), apparel/drinkware/prints categories.

| # | Item | Finding |
|---|---|---|
| 1 | Product safety and traceability | Printful manufactures the pilot goods **in the EU** (Riga/Barcelona), simplifying GPSR (EU) 2023/988 traceability: the manufacturer is the supplier itself, identifiable. Per-product manufacturer data on listings per ADR 0004 D2.8/#121 — ❔ confirm data availability at onboarding |
| 2 | Manufacturer / responsible-economic-operator details | Same; EU-established manufacturer means no separate authorised-representative gap for EU-made items — ❔ verify per SKU, since some blanks are imported |
| 3 | CE / category certificates | Pilot categories (textiles, ceramics, paper prints) carry no CE-marking regime; textile fibre-composition labelling (Reg. (EU) 1007/2011) data comes from the catalogue — ❔ verify present per pilot SKU |
| 4 | Recall / safety-notice process | ❔ requires account/contract — named as a supply-agreement clause before any category widens |
| 5 | Consumer withdrawal, warranty, return capability | **The pilot's one real legal question.** Directive 2011/83/EU art. 16(c) exempts goods "made to the consumer's specifications or clearly personalised" from the 14-day withdrawal right ([EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083)). A Mercaria retail POD item printed with a **fixed catalogue design the buyer merely selected** is arguably *not* personalised by the consumer, in which case Mercaria owes withdrawal on goods no supplier takes back — an absorbed cost per event, bounded by the order-value cap. Legal review before pilot entry decides whether pilot terms may rely on 16(c); until it answers, the pilot **budgets every withdrawal as a full absorbed refund** (fail-closed costing). Spain's 3-year conformity guarantee (RDL 7/2021) is Mercaria's regardless (ADR 0004 D2.6); Printful's 30-day defect claim window covers only part of that tail — the uncovered tail is a D12.5 loss-budget item, never a price component |
| 6 | Tax and invoicing information | B2B invoices from Printful with reverse-charge treatment per submitted ES VAT ID ([VAT ID](https://help.printful.com/hc/en-us/articles/360014008640-How-do-I-submit-my-VAT-ID-to-Printful)); customer invoice is Mercaria's own (ADR 0004 D2.3) |
| 7 | Cross-border OSS/IOSS relevance | Launch market Spain-only ⇒ domestic output VAT, **no OSS dependency at entry**; widening to other EU states activates the existing OSS treatment (ADR 0004 D2.9); IOSS structurally irrelevant (no non-EU dispatch) |
| 8 | Restricted-category controls | Pilot SKU set is a closed allow-list (§10); unevaluated categories ineligible by default (ADR 0004 D12.3 fail-closed) |
| 9 | Data-sharing / privacy responsibilities | Fulfilment-only projection per ADR 0004 D2.7/D10 — name, address, carrier phone, lines, service; relay email where demanded; DPA ❔ at contract |
| 10 | Insurance / indemnity | Product-liability cover for first-party resale + loss budget must exist before launch (ADR 0004 D12.5) and are **prohibited from the customer price** — an operator gate, unresolved by this document |

## 8. Decision matrix (issue §Decision matrix, published weights)

Scores 0–5 (0 = absent/failing, 5 = verified strong). Weights published below
and summing to 100. **Positive Mercaria margin is not a criterion** — nothing
below rewards it, per #119 and ADR 0004 D3. Confidence: H = official-source
verified, M = mixed, L = mostly secondary/unverifiable.

| # | Criterion | Weight | BigBuy | Printful | vidaXL | Avasam |
|---|---|---|---|---|---|---|
| 1 | Contractual resale certainty | 15 | 3 (M) | 4 (M) | 3 (L) | 2 (L) |
| 2 | API completeness | 12 | 4 (M) | 5 (H) | 3 (L) | 2 (L) |
| 3 | Cost-quote completeness and stability | 15 | 3 (M) | 5 (H) | 3 (L) | 2 (L) |
| 4 | Market/category fit | 8 | 5 (H) | 2 (H) | 4 (M) | 1 (M) |
| 5 | Stock and fulfilment reliability | 10 | 3 (M) | 4 (H) | 3 (L) | 2 (L) |
| 6 | Returns/warranty operability | 10 | 2 (H) | 3 (M) | 3 (L) | 2 (L) |
| 7 | Compliance evidence | 10 | 3 (M) | 4 (M) | 2 (L) | 2 (L) |
| 8 | Expected unrecovered cost variance and cash-flow risk | 8 | 2 (H) | 3 (H) | 3 (L) | 2 (L) |
| 9 | Integration effort | 7 | 3 (M) | 4 (H) | 3 (L) | 1 (L) |
| 10 | Supplier concentration / lock-in risk | 5 | 3 (M) | 3 (H) | 4 (M) | 2 (L) |
| | **Weighted total (÷100, 0–5 scale)** | 100 | **3.10** | **3.88** | **3.03** | **1.85** |

Hard gates (independent of score): Avasam **fails ADR 0004 D2.9** (UK dispatch
origin is outside the EU customs territory). Direct manufacturer/distributor:
**no candidate exists** to score — human outreach required first. vidaXL could
not be evaluated from official sources during the window.

**No-go threshold:** a winner must score ≥ 3.00 weighted with no hard-gate
failure, else the no-go option wins. Printful clears it at **3.88**; the
decision is **Printful**, with BigBuy (3.10) as the recorded runner-up to
re-evaluate if the pilot's category narrowness proves fatal to demand, and
vidaXL to re-score if/when its program sites are reachable.

Missing-evidence register (what would move scores): BigBuy — written channel
classification for a first-party shop on a marketplace domain, blind-dropship
default, invoice line format. Printful — ToS channel confirmation, EU-routing
guarantee or per-SKU EU availability confirmation, EUR Wallet existence,
confirmed cancellation window, DPA. vidaXL — everything official. All are named
in §11's checklist where they gate entry.

### Why Printful despite the narrow catalogue

Zero-markup retail (#117/ADR 0004) optimises for **provable cost**, not
assortment. Printful is the only candidate where (a) the complete direct cost
is one API estimate before charge — the exact shape D4 step 1's
`CostQuoteSnapshot` wants; (b) **no mandatory fixed cost exists to allocate**,
so the D3 formula holds with no absorbed structural subsidy; (c) procurement
failure from stock-outs is structurally near-zero, minimising the
compensating-refund path's traffic; (d) white-label blind dropship is the
documented default rather than a negotiated add-on; and (e) fulfilment is
EU-based with a Spanish facility. Its weaknesses — category narrowness, the
withdrawal-right question, USD Wallet FX — are all *bounded* by pilot limits,
while BigBuy's weaknesses (absorbed subscription, stranded withdrawal goods)
are *structural* to its model under a zero-markup policy with no warehouse.

## 9. Selected provider — exact account, agreement and environment (deliverable 4)

- **Provider:** Printful (printful.com), **Free plan** — no subscription, no
  registration fee ([pricing](https://www.printful.com/pricing)).
- **Account:** a NEW business account owned by the Mercaria platform legal
  entity (ADR 0001 D8 — Spain, confirmation shared with that ADR's open item),
  with the ES VAT ID submitted for reverse-charge B2B invoicing. No personal or
  consumer account. **Does not exist yet — human gate.**
- **Agreement:** Printful Terms of Service + DPA, plus a support-confirmed
  written answer on (a) selling through Mercaria's own checkout on a
  marketplace domain and (b) GPSR manufacturer data availability. An affiliate
  or consumer account is explicitly insufficient (acceptance criterion 9;
  ADR 0004 D2.10).
- **Environment:** live API, v1 stable + v2 beta read paths, exercised through
  **draft (never-confirmed) orders and estimate endpoints** — Printful exposes
  no separate sandbox in public docs; the only billed action before launch is
  the deliberate test order of §11.
- **Credentials:** a least-privilege private token from the Printful developer
  portal, stored as a GitHub Actions repo secret and synced to SSM
  `/oxy/mercaria/suppliers/printful/*` (ADR 0004 D6.5/D10) — never a
  placeholder value, per the standing secrets rule.
- **Subscription decision:** stay on **Free** for the pilot. Growth
  ($24.99/mo, free past $12K/yr sales) would *lower customer prices* by up to
  33 % while its fee is Mercaria-absorbed under §4's policy decision — a
  customer-benefit trade to revisit in a #120 pricing-policy version once pilot
  volume data exists, not at entry.

## 10. Pilot bounds (deliverable 5) and stop thresholds (deliverable 11)

- **Initial market:** Spain only. Domestic output VAT, no OSS dependency, the
  supplier has a Spanish facility, and Spain is the platform's own launch
  market (ADR 0001 D8). Widening to further EU states is a #121-gated change.
- **Categories:** apparel (t-shirts, hoodies), drinkware (mugs), wall art
  (posters) — no CE-regime goods, no age-gated goods, no food contact beyond
  standard ceramic drinkware.
- **SKU bound:** ≤ 25 SKUs, each individually eligible-listed (#121) with
  confirmed EU fulfilment availability and design-IP screening.
- **Order-value limits:** per-order retail total ≤ €150; per-line quantity
  ≤ 5; per-order minimum €15 (so carriage does not dwarf the goods — an
  honesty bound, not a margin device).
- **Volume cap:** cumulative supplier spend ≤ €2,000/month during the pilot;
  `MERCARIA_RETAIL_ENABLED` off beyond it until the operator reviews.
- **Prefund bound:** Wallet float ≤ €500 equivalent at any time (bounds FX
  exposure and idle cash).

**Stop thresholds** — any of these halts entry (`MERCARIA_RETAIL_ENABLED=false`;
drain per ADR 0004 D13) and pages the owner:

| Trigger | Threshold |
|---|---|
| Procurement failure (reject/timeout/unfulfillable) | > 2 % of retail orders, trailing 7 days |
| Absorbed negative variance | > €50/week, or any single order beyond the D3 cap (10 % / €25) |
| Positive customer adjustments required | > 5 % of orders (a quoting defect per ADR 0004 diagram 14 — fix the quote, never the buyer) |
| Non-EU dispatch origin observed | **One occurrence** (D2.9 violation) |
| Delivery promise missed | > 10 % of shipments, trailing 14 days |
| Any product-safety or IP flag on a pilot SKU | One occurrence — delist immediately |
| Wallet balance | < 2× trailing average daily draw → treasury top-up alert (alert, not halt) |

**Owner:** the payment operator(s) listed in `PAYMENT_OPERATOR_OXY_USER_IDS`;
contact **oxy@oxy.so**. Treasury approvals (prefund, top-ups) follow ADR 0004
D6.5 dual control.

## 11. Pilot entry gate — the human-operated checklist (deliverables 6, 9; acceptance criteria 2, 3, 9)

**Nothing in this section is satisfied by this document.** Each item is a
dated, open gate; the first public `mercaria_retail` offer is forbidden until
all are recorded done. As of **2026-08-09 every item is OPEN.**

1. ☐ Create the Printful business account under the platform legal entity;
   accept ToS; obtain the DPA. *(operator)*
2. ☐ Submit the ES VAT ID to Printful billing for reverse-charge treatment.
   *(operator + accountant)*
3. ☐ Obtain written support confirmation: marketplace-domain first-party
   checkout permitted; GPSR manufacturer data per SKU; confirmed-order
   cancellation window; EU-fulfilment availability flags per pilot SKU; EUR
   Wallet existence or confirmation the Wallet is USD-only. *(operator)*
4. ☐ Approve and execute the initial Wallet prefund (≤ €500 equivalent) under
   D6.5 dual control; record the funding FX snapshot. Note the deviation to
   resolve: Printful Wallet top-ups run on card/PayPal rails, not SEPA — the
   treasury decision (accept card-funded *top-ups* as the operator-initiated
   treasury operation, or negotiate bank transfer) is taken here; per-order
   stored-card billing stays rejected (D6.2). *(treasury)*
5. ☐ Mint a least-privilege API token; store as GitHub secret → SSM
   `/oxy/mercaria/suppliers/printful/*`. *(operator + infra)*
6. ☐ Legal review of §7 item 5 (withdrawal right vs art. 16(c)) and the pilot
   customer terms. *(legal)*
7. ☐ ADR 0004 D12 gates recorded: Stripe business-profile disclosure of
   first-party retail, insurance/loss budget in place. *(operations)*
8. ☐ **End-to-end test order** (acceptance criterion 3), BEFORE any public
   offer: one real, small, operator-addressed order through the #125 adapter
   path — draft → estimate → confirm → ship → deliver — verifying: quote
   equals invoice per component; white-label parcel and slip (no supplier
   branding, invoice or pricing); dispatch origin inside the EU customs
   territory; tracking webhook latency; plus one draft-order cancellation and
   one post-confirmation cancellation attempt. The measured results are
   appended to this document as the **test-order report** (deliverable 9 —
   necessarily empty until this gate runs). *(operator)*

## 12. Open commercial, tax, legal and operational risks (deliverable 10)

| Risk | Class | Bound / mitigation |
|---|---|---|
| Printful ToS turns out to restrict marketplace-domain first-party checkout | Commercial | Gate 3 answers it before any offer; BigBuy is the scored fallback |
| Withdrawal right applies to catalogue-design POD (art. 16(c) not available) | Legal | Every withdrawal budgeted as full absorbed refund; order-value cap bounds each event; D12.5 loss budget funds it |
| USD-only Wallet ⇒ permanent FX component + card-rail top-ups | Treasury | Float cap €500; FX snapshotted per D3.4; gate 4 treasury decision; revisit if Printful confirms a EUR Wallet |
| Non-EU fulfilment routing for an EU order | Compliance (D2.9) | SKU-level EU availability pinning + one-occurrence stop threshold |
| 3-year Spanish conformity guarantee tail beyond Printful's 30-day claim window | Operational | D12.5 loss budget; pilot categories are low-defect-tail goods |
| No documented idempotency key on order creation | Technical | #124 adapter converges on its own PO id + post-submit read-back; test order exercises the retry path |
| Printful v2 API is open beta | Technical | Pin integration to v1 stable endpoints where equivalent; v2 only for read paths that have no v1 equivalent, wrapped behind the adapter seam |
| Supplier concentration: one supplier = the whole retail mode | Commercial | The pilot is deliberately small; BigBuy and a recovered vidaXL remain scored alternatives; no exclusivity is signed |
| Sub-threshold price/fee drift eroding quote accuracy | Financial | #128 reconciliation per component vs `CostQuoteSnapshot`; the §10 adjustment-frequency stop threshold makes chronic drift a halt, not a habit |

## Acceptance criteria of #119, answered

1. *Explicit B2B resale and direct-to-customer fulfilment rights for the
   launch channel and markets* — **Partially evidenced, contract-gated.**
   Public documentation establishes the model (white-label fulfilment of goods
   sold under the customer's brand, custom-platform API channel, §2 rows 3–4);
   the explicit written grant is gate 1 + 3 of §11. Not claimed as satisfied.
2. *Real credentials or approved sandbox exercising catalog/order
   capabilities* — **Open; the pilot's entry gate** (§11 items 1, 5). No
   account exists today; documentation review (§3) is not exercise, and this
   document does not pretend otherwise.
3. *At least one end-to-end test order validating packaging, tracking and
   cancellation* — **Open; §11 item 8**, with its measurement protocol
   defined here and its report slot reserved.
4. *Returns, warranty and supplier-credit paths operationally understood* —
   **Yes on the documented layer** (§2 row 11, §5 rows 5/7, §6 rows 8–10:
   claim-based defect path, no-return credits, no remorse take-back), with the
   RMA contract detail marked account-gated.
5. *Complete customer amount from documented direct costs, zero markup, no
   hidden profit* — **Yes structurally** (§4): every D3 component is quotable
   pre-charge from a named evidence source, the one shared fixed cost in the
   candidate set (BigBuy's subscription) is decided **Mercaria-absorbed and
   never priced**, and the residual unknowns (fee/FX true-up) are provisional-
   class, reconciled under D8.
6. *Stress scenarios quantify absorbed variance and customer-adjustment
   exposure* — **Yes** (§5): eight scenarios across three supplier models,
   with expected absorbed classes named and the adjustment-frequency
   expectation bounded; exact rates are a pilot output, and the §10 thresholds
   turn them into stops rather than surprises.
7. *Product-safety and restricted-category controls pass the bounded review* —
   **Yes for the bounded pilot scope** (§7): EU-manufactured, no-CE-regime
   categories, closed SKU allow-list, fail-closed on anything unevaluated;
   two named ❔ items (per-SKU manufacturer data, recall clause) sit in §11.
8. *A no-go decision is accepted if direct costs cannot be quoted reliably* —
   **The threshold was live** (§8): no-go beats any candidate under 3.00 or
   failing a hard gate, and it DID eliminate Avasam (hard gate), direct supply
   (no candidate) and vidaXL (unverifiable). Printful cleared it on evidence.
9. *No public `mercaria_retail` offer from an affiliate feed or
   consumer-retail account* — **Enforced as this document's structure**: the
   selected path is a business account with contractual confirmation (§9), the
   entry checklist blocks any offer until it exists (§11), and ADR 0004 D2.10
   makes the rule architectural, not aspirational.
