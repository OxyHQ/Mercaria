# Printful — provider implementation document

- **Status:** Adapter IMPLEMENTED and conformance-tested against a fake wire.
  **No account exists, nothing is contractual, and `live` is refused in code.**
  Pilot entry remains gated on the human-operated checklist in
  [`2026-08-09-first-dropship-supplier.md`](./2026-08-09-first-dropship-supplier.md) §11,
  every item of which is still OPEN.
- **Date:** 2026-08-10
- **Issue:** [#125](https://github.com/OxyHQ/Mercaria/issues/125), part of epic
  [#116](https://github.com/OxyHQ/Mercaria/issues/116); provider selected by
  [#119](https://github.com/OxyHQ/Mercaria/issues/119)
- **Binding architecture:** [ADR 0004](../adr/0004-mercaria-retail-dropship.md) —
  zero-markup cost recovery (D3), immediate capture plus compensating refund
  (D4), prefunded supplier balance (D6), variance → customer adjustment (D8),
  EU-customs-territory-only dispatch (D2.9)
- **Code:** `services/supplier-orders/adapters/printful.ts` (the supplier
  adapter), `services/ingestion/adapters/printful-catalog.ts` (the catalogue
  source), `services/printful/` (transport, registration)

## Method and evidence register

Every claim below carries its source. A fact that could not be verified against
a current official page — or that requires a signed-in account, a contract or a
support answer — is marked **requires account/contract** and scores as ABSENT,
never as assumed. That is #119's rule and this document inherits it unchanged.

Three observations shaped the evidence and are recorded because they changed
what the code does:

1. **Printful's developer documentation was directly retrievable** for both API
   versions, so the endpoint paths, the rate limit, the order lifecycle and the
   webhook mechanism below are quoted from it rather than inferred.
2. **Order-level `external_id` addressing is NOT documented.** The `@`-prefix
   external-id convention is documented for **Sync Products and Sync Variants**
   and is *not stated for the Orders API*. This is the single most consequential
   gap in this document and §11 explains what the adapter does about it.
3. **No account was created and no contract signed.** Every "rights" row is
   public-documentation evidence plus a named account-gated confirmation step.

## 1. Contracting entity and approved account

| Item | Finding |
|---|---|
| Provider | Printful (printful.com), **Free plan** — no subscription, no registration fee ([pricing](https://www.printful.com/pricing)) |
| Legal entity | Printful, Inc. (US) with EU operations; EU fulfilment subsidiaries in Latvia and Spain ([fulfilment centers](https://help.printful.com/hc/en-us/articles/360014067239-Where-are-the-Printful-fulfillment-centers-located)). The contracting entity for an ES account is **requires account/contract** |
| Mercaria account | A NEW business account owned by the Mercaria platform legal entity, with the ES VAT ID submitted for reverse-charge B2B invoicing. No personal or consumer account (ADR 0004 D2.10) |
| Status | ✖ **Does not exist.** §11 gate 1 |

## 2. Test and production environments

Printful publishes **no separate sandbox** in its public documentation. What
exists instead is a DRAFT order: `POST /v2/orders` creates an order in `draft`
state that fulfils nothing, and `POST /v2/orders/{id}/confirm` is what commits
it ([v2 docs](https://developers.printful.com/docs/v2-beta/)). Everything except
fulfilment is therefore exercisable without billing.

Mercaria's own separation does not depend on Printful having a sandbox:
`supplier_accounts.environment` is `test` or `live`, frozen by trigger (#124),
and it is what the adapter gates on. There is deliberately **no
`PRINTFUL_ENVIRONMENT` variable** — a deployment-wide setting able to disagree
with the account row is the one shape that could point a live account at a
rehearsal.

**`live` is refused in code today.** `assertPrintfulEnvironmentIsReachable`
throws for every `live` account, and lifting it is a deliberate code change
that records §11's gates as done rather than a setting somebody flips.

## 3. Authentication and secret rotation

| Item | Finding |
|---|---|
| Scheme | `Authorization: Bearer {private_token}`; OAuth tokens also accepted ([docs](https://developers.printful.com/docs/)) |
| Store scoping | `X-PF-Store-Id: {store_id}` for an account-level token; a store-level token carries the store implicitly ([docs](https://developers.printful.com/docs/)) |
| Rotation | Private tokens are scoped and expiring, self-serve in the developer portal ([docs](https://developers.printful.com/docs/)). The rotation POLICY is **requires account/contract** |
| Where Mercaria keeps it | A PATH only. `supplier_accounts.credential_reference` holds an SSM path (`/oxy/mercaria/suppliers/printful/*`); the value is resolved per call through #124's credential port and is never stored, cached or logged. There is deliberately no environment-variable fallback — a token in the process environment is a token in every core dump |

## 4. Supported markets, fulfilment origins and currencies

| Item | Finding |
|---|---|
| Destinations | Ships worldwide ([fulfilment centers](https://help.printful.com/hc/en-us/articles/360014067239-Where-are-the-Printful-fulfillment-centers-located)) |
| EU fulfilment origins | Riga (LV) and Barcelona (ES) (same) |
| **Routing** | **Printful's own optimisation. No per-order guarantee of an EU origin is published** — see §19 |
| Currencies | Account billing currency selectable, EUR supported ([currencies](https://support.printful.com/hc/en-us/articles/41396636624401-What-currencies-does-Printful-support)) |
| **Wallet currency** | The Printful Wallet is **USD-denominated**; choosing EUR billing DISABLES the Wallet and bills a stored card per order ([currency change](https://support.printful.com/hc/en-us/articles/41396636706193-How-do-I-change-the-currency-on-Printful)). Per-order stored-card billing is rejected by ADR 0004 D6.2, so the compliant path is the USD Wallet and a measurable EUR→USD conversion cost per top-up |
| Pilot market | Spain only, EUR only (§10 of the #119 decision) |

**What the adapter does about the routing gap.** It ENFORCES the bound rather
than assuming it: `resolveAvailability` reads
`GET /v2/catalog-variants/{id}/availability` and answers `orderable` only when
the variant is available in a selling region that can dispatch from inside the
EU customs territory. A variant stocked only outside it answers `restricted`,
which BLOCKS. `PRINTFUL_EU_FULFILMENT_COUNTRIES` is a code constant, not
configuration: which countries are inside the customs union is a fact about the
union, and a configurable list is one typo from admitting a dispatch D2.9
forbids.

## 5. Approved channels, brands, categories and exclusions

| Item | Finding |
|---|---|
| Channel | API / custom-platform integration is a first-class channel ([docs](https://developers.printful.com/docs/)); no channel restriction found in public documentation |
| **Marketplace-domain first-party checkout** | ❔ **requires account/contract** — §11 gate 3. This is the commercial risk #119 recorded, with BigBuy as the scored fallback |
| Brand/category restrictions | ✅ None applicable. Printful fulfils only its own catalogue printed with Mercaria-supplied designs, so the restriction burden flips to **Mercaria's own design-IP diligence** |
| Pilot categories | Apparel (t-shirts, hoodies), drinkware (mugs), wall art (posters) — no CE-regime goods, no age-gated goods |
| Pilot SKU bound | ≤ 25 SKUs, each individually allow-listed in a published cohort version with a written note recording its screening |

## 6. Catalog and data-use rights

| Item | Finding |
|---|---|
| Catalogue access | Public read; 30 req/60 s unauthenticated ([docs](https://developers.printful.com/docs/)) |
| Image and description use rights | ❔ **requires account/contract** (per ToS) |
| What Mercaria stores | Source records under a `catalog_sources` row bound to NO MERCHANT. #62's framework produces no public offer for a merchant-less source, so a wholesale cost has nowhere public to land — see §"Catalogue ingestion" below |

## 7. Provider API versions and endpoints

Pinned to **v1 where equivalent, v2 for the paths that have no v1 equivalent**,
per #119 §12's open-beta risk. Every path below was read from the published
documentation.

| Operation | Endpoint | Version |
|---|---|---|
| Create order (draft) | `POST /v2/orders`, accepts `external_id` | v2 |
| Confirm order | `POST /v2/orders/{id}/confirm` | v2 |
| Read order | `GET /v2/orders/{id}` | v2 |
| List orders (paginated) | `GET /v2/orders?limit=&offset=` | v2 |
| Delete/cancel draft | `DELETE /v2/orders/{id}` | v2 |
| Shipping rates | `POST /v2/shipping-rates` | v2 |
| Catalogue products | `GET /v2/catalog-products?limit=&offset=` | v2 |
| Product variants | `GET /v2/catalog-products/{id}/catalog-variants` | v2 |
| Variant | `GET /v2/catalog-variants/{id}` | v2 |
| Variant prices | `GET /v2/catalog-variants/{id}/prices` | v2 |
| Availability | `GET /v2/catalog-variants/{id}/availability` | v2 |
| Tax rates | `POST /tax/rates` | v1 |
| Webhook configuration | `POST /v2/webhooks`, `POST /v2/webhook-events` | v2 |

Error format is RFC 9457 Problem Details (`type`, `status`, `title`, `detail`,
`instance`) on v2; v1 answers `{ code, result }`. The adapter unwraps both in
one place so the rest of the file reads one shape.

## 8. Rate limits and quotas

- **120 requests per 60 seconds**, leaky bucket, reported through
  `X-Ratelimit-Limit` / `-Remaining` / `-Reset` / `-Policy`; a 429 carries
  `retry-after` ([v2 docs](https://developers.printful.com/docs/v2-beta/)).
- Mercaria states it as `PRINTFUL_RATE_LIMIT` in the adapter, so the fleet-wide
  budget #122's `supplier_call_leases` enforces is Printful's published number
  rather than a Mercaria guess. Concurrency (4) is **not** published and is
  Mercaria's own politeness bound.
- A preflight spends up to **three** calls (variant, availability, shipping
  rates); a submission spends **two** (create, confirm).

## 9. Stock and price freshness semantics

| Item | Finding |
|---|---|
| Stock | Structurally strongest of the candidates: made-to-order, so no stock-out concept for standard items. Blank availability refreshed every 5 minutes ([v2 docs](https://developers.printful.com/docs/v2-beta/)) |
| Price | Published flat catalogue prices ([pricing](https://www.printful.com/pricing)); **no published statement of how long a price is held** |
| Change notification | `catalog_stock_updated` and `catalog_price_changed` webhook events exist (same) |

**Consequence in code:** neither `price_guarantee` nor `quote_expiry` is
declared. A `guaranteed` price would be `inferred_price_guarantee`, and a
provider expiry Printful never stated would be an invention — so quotes expire
on Mercaria's own policy TTL instead.

## 10. Quote and reservation capabilities

Printful is **print-on-demand: nothing is picked off a shelf, so there is
nothing to reserve.** `inventory_reservation` is NOT declared, which makes a
reservation unrepresentable rather than merely unused — #122 enforces it in four
independent places, including a NOT NULL provider reservation id the adapter
could not supply.

The complete declaration, and every absence:

| Capability | Declared | Evidence / reason |
|---|---|---|
| `live_product_lookup` | ✅ | `GET /v2/catalog-variants/{id}` |
| `live_stock_lookup` | ✅ | `/availability`, 5-minute refresh |
| `destination_shipping_quote` | ✅ | `POST /v2/shipping-rates` |
| `delivery_estimate` | ✅ | Shipping rates return delivery estimates |
| `order_draft_validation` | ✅ | A draft validates without fulfilling |
| `cancellation_before_submission` | ✅ | `DELETE /v2/orders/{id}` removes a draft |
| `update_notifications` | ✅ | Webhooks |
| `order_draft_submission` | ✅ | create + confirm |
| `order_state_read` | ✅ | `GET /v2/orders/{id}` |
| `order_reference_lookup` | ✅ | list-and-filter — **see §11** |
| `order_cancellation` | ✅ | `DELETE /v2/orders/{id}` |
| `shipment_read` | ✅ | Order carries shipments |
| `order_webhooks` | ✅ | See §15 |
| `order_polling` | ✅ | `GET /v2/orders` |
| `inventory_reservation` | ✖ | Print-on-demand holds nothing |
| `price_guarantee` | ✖ | No published hold on a price |
| `quote_expiry` | ✖ | No published expiry |
| `address_validation` | ✖ | No published address-check endpoint |
| `tax_duty_estimate` | ✖ | `POST /tax/rates` answers about the DESTINATION's sales tax; what a preflight needs is the tax on Printful's supply TO MERCARIA, which depends on the VAT ID at §11 gate 2 (OPEN). #119 §4 component 5: supplier-side VAT is input-deductible and never a customer cost |
| `order_partial_acceptance` | ✖ | No published per-line acceptance outcome |
| `tracking_events` | ✖ | Printful supplies a tracking NUMBER, not a carrier scan trail |
| `invoice_retrieval` | ✖ | ❔ requires account — §14 |
| `credit_note_retrieval` | ✖ | ❔ requires account — §14 |
| `return_authorization` | ✖ | Returns are a CLAIM process, not an API RMA — §13 |

Every undeclared capability is stripped at #122's and #124's boundary and lands
on the value that BLOCKS, never on one that refuses or on zero.

## 11. Order idempotency and client-reference behaviour

**This is the gap that mattered most, and the one the adapter is shaped around.**

- Printful documents **no idempotency-key header** for `POST /orders`.
- Orders accept an `external_id` field ([v2 docs](https://developers.printful.com/docs/v2-beta/)).
- The `@{external_id}` addressing convention is documented for **Sync Products
  and Sync Variants** and **is not documented for the Orders API**. Whether an
  order object echoes `external_id` on a list read is ❔ **requires account** —
  §11 gate 3 of the decision document.

#124's ambiguity converger treats `findOrderByClientReference` answering `null`
as PROOF the provider holds no order under Mercaria's reference, and it is the
one path on which a SECOND submission is reachable. A lookup that could not
distinguish "absent" from "this account does not echo the field" would therefore
turn a lost HTTP response into a duplicate supplier order — real money,
invisible until a statement is reconciled weeks later.

So the adapter's lookup returns `null` only when absence is **provable**, and
THROWS otherwise (which leaves the ambiguity standing, retries later and submits
nothing meanwhile). Two conditions must hold:

1. The scan reached the end of the account's orders without hitting its
   five-page bound. A bound reached is not an enumeration finished.
2. **At least one order carried an `external_id` property, or there were no
   orders at all.** If orders exist and none exposes the field, every comparison
   fails for a reason that has nothing to do with our order — a check that
   cannot tell success from failure, whose failure direction is a duplicate.

Confirming the echo at §11 gate 3 makes condition 2 trivially true in practice;
until then the adapter is correct without it, at the cost of some ambiguities
reaching an operator instead of converging automatically.

## 12. Shipping, tracking and carrier behaviour

- Shipping rates return methods, costs, delivery estimates and customs
  indicators for a recipient address ([v2 docs](https://developers.printful.com/docs/v2-beta/)).
- Shipment webhooks and v2 tracking events exist, departure country included
  (same).
- **Basis is `basket`.** Printful prices a whole recipient/items request, so
  there is no per-item number to sum. #122's `SupplierShippingQuote` makes
  summing one unrepresentable, which is why the basis is stated rather than
  flattened.
- **A shipment with no tracking number is not reported.** It cannot be followed
  and cannot be told from another parcel of the same order; an absent parcel
  blocks, an unidentifiable one would pretend to inform.
- **No status maps to `delivered`.** Printful's lifecycle ends at `fulfilled` —
  goods handed to a carrier. Delivery is a carrier fact this provider never
  asserts, and inventing one would start the return window from a date nobody
  observed.

## 13. Cancellation, return, RMA, warranty and credit behaviour

| Item | Finding |
|---|---|
| Cancellation | Draft orders cancel freely (`DELETE`). The confirmed-order cancellation WINDOW is ❔ **requires account/contract** — §11 gate 3 |
| Change-of-mind returns | ✖ None — goods are made to order ([returns policy](https://www.printful.com/policies/returns)) |
| Defective/misprinted | Free reshipment or refund **without returning the item**, claim window 30 days from delivery ([returns policy](https://www.printful.com/policies/returns), [help](https://help.printful.com/hc/en-us/articles/360014006840-How-are-returns-handled-for-quality-issues-vs-customer-change-of-mind)) |
| Undeliverable parcels | Held 30 days (same) |
| Warranty | Spain's 3-year conformity guarantee (RDL 7/2021) is **Mercaria's** regardless (ADR 0004 D2.6); Printful's 30-day claim window covers only part of that tail. The uncovered tail is a D12.5 loss-budget item and is **prohibited from the customer price** |
| API RMA | ✖ No RMA endpoint. `return_authorization` is NOT declared; #127 owns the recovery path |

**Consequence for a refused cancellation:** the purchase order returns to
`accepted` and the recovery is #127's return path. Calling it a cancellation
would tell a buyer their money is coming back while a parcel is on its way to
them.

## 14. Invoice and tax behaviour

| Item | Finding |
|---|---|
| B2B invoicing | Reverse charge at 0% with a submitted non-LV EU VAT ID where applicable ([EU VAT](https://help.printful.com/hc/en-us/articles/4402032573586-How-is-VAT-applied-to-my-EU-bound-orders), [VAT ID](https://help.printful.com/hc/en-us/articles/360014008640-How-do-I-submit-my-VAT-ID-to-Printful)). Barcelona-fulfilled domestic-ES supplies are expected to carry ES VAT (input-deductible) — accountant confirmation ❔ |
| Customer invoice | Mercaria's own (ADR 0004 D2.3), from its existing `TaxRate` engine |
| Invoice EXPORT format | ❔ **requires account** — a Wallet statement and order receipts exist; a line-level export #128 can reconcile against is unverified |
| Credit notes | ❔ **requires account** |
| **Wallet balance endpoint** | ❔ **None found.** This is why `supplier_funding_observations.source` includes `operator_entry`: an operator reading the dashboard and recording what it said is the only honest source available today, and naming it as its own source is what stops that figure being mistaken for one the provider asserted |

## 15. Webhook or polling strategy

- Printful enforces HTTPS on callback URLs and states that payloads include
  expiry dates and **request signatures** ([v2 docs](https://developers.printful.com/docs/v2-beta/)).
- **The exact signing scheme is ❔ requires account.** What the adapter verifies
  today is a SHARED SECRET carried in the delivery, which is the mechanism a
  deployment can actually establish; `SupplierWebhookVerification`'s refusal
  branch carries no parsed content at all, so an unverified delivery is
  unstorable rather than stored-and-applied-later.
- **Printful publishes no per-delivery event id**, so the adapter derives a
  DETERMINISTIC one from the type, the order and the instant. A redelivery
  therefore converges on one stored row rather than doubling a shipment — which
  #124's conformance case 4 exercises.
- Polling is the fallback: `GET /v2/orders`, bounded, on the same call budget.

**Closing the signature gap is one function.** `verifyWebhook` is synchronous
and self-contained; replacing the shared-secret comparison with Printful's
documented signature is the whole change, and nothing else in #124 moves.

## 16. Provider error taxonomy

Two mappings, deliberately not one, because they answer different questions and
their vocabularies genuinely differ:

- `printfulReasonCode(status, detail)` → `SupplierProviderReasonCode`, which
  classifies a CALL that failed (`credential_invalid`, `rate_limited`).
- `printfulOrderReasonCode(detail)` → `PurchaseOrderReasonCode`, which
  classifies an ORDER that will not be fulfilled (`out_of_stock`,
  `address_invalid`).

Collapsing them would put `rate_limited` on a purchase order, which reads to an
operator as a commercial refusal when it was a transport one. **The provider's
own message never lands in a column** — only the closed code it maps to.

| HTTP | Class | Retried? |
|---|---|---|
| 401 / 403 | `auth` | No — a rejected credential fails identically every time |
| 429 | `quota` | Yes, honouring `retry-after` |
| ≥ 500 | `retryable` | Yes |
| 404 | `terminal` | No |
| 400 / 422 | `validation` | No |
| unparseable 2xx | `unknown`, **`afterWrite: true`** | The call succeeded and nobody can read what it did — ambiguous |
| socket failure | `retryable`, `afterWrite` **observed** | The transport sets it from whether the request was flushed |

## 17. Packaging, packing-slip and supplier-brand disclosure

- ✅ White-label is the documented default: "your shipments won't include any
  Printful branding on or inside the package"
  ([packaging](https://help.printful.com/hc/en-us/articles/360014006620-Does-the-packaging-include-any-Printful-branding)).
- ✅ Packing slips carry the store's own details
  ([packing slip](https://help.printful.com/hc/en-us/articles/360014065499-What-does-the-packing-slip-look-like)).
- ✖ **NOT VERIFIED PHYSICALLY.** §11 gate 8's test order is the only thing that
  can confirm it, and it has not run. This is one of the two acceptance criteria
  (#125 6) that no amount of code can satisfy.

## 18. Support and escalation contacts

- 24/7 support advertised ([pricing](https://www.printful.com/pricing)); the
  escalation PATH is ❔ **requires account/contract**.
- Mercaria's side: the payment/procurement operators in
  `PROCUREMENT_OPERATOR_OXY_USER_IDS`, contact **oxy@oxy.so**. Treasury
  approvals follow ADR 0004 D6.5 dual control.

## 19. Known limitations and launch kill switches

**Limitations, each with what the code does about it:**

| Limitation | What the code does |
|---|---|
| No EU-routing guarantee per order | Availability must state an EU-dispatchable region or the answer is not `orderable`; an observed non-EU origin is a one-occurrence pilot stop |
| No documented order-level `external_id` echo | The lookup proves absence or throws (§11) |
| No idempotency header | Convergence rests on #124's four mechanisms, none of which is the provider's |
| No published price hold or expiry | Neither capability declared |
| No API RMA, no invoice export | Neither capability declared; #127 and #128 own the recovery |
| USD-only Wallet | A real, small FX component per top-up, snapshotted per ADR 0004 D3.4 |
| POD goods carry no retail GTIN | The catalogue adapter emits NO identifiers — #64 §6's "never fabricate an absent identifier". Putting the variant id in an `mpn` slot would make #58 match it against somebody else's catalogue |
| v2 is open beta | Pinned to v1 where equivalent, wrapped behind the adapter seam |

**Kill switches, five, and they are independent by construction:**

| Switch | What it stops | Default |
|---|---|---|
| `PRINTFUL_ENABLED` | Registers the adapters at all. Off ⇒ every preflight answers `provider_unconfigured` (which blocks) and every purchase order refuses with `adapter_missing`. Never gates a durable record | `false` |
| `MERCARIA_RETAIL_ENABLED` (#123) | Retail checkout ENTRY | `false` |
| `PROCUREMENT_ORCHESTRATION_ENABLED` (#124) | Submitting and cancelling supplier orders | `false` |
| `PROCUREMENT_PROVIDER_FETCH_ENABLED` (#124) | Outbound reads and polling; webhooks are still received and stored | `true` |
| A published pilot cohort | Everything. **No active cohort ⇒ every retail line is refused** (`no_active_cohort`), which is why the pilot needs no kill switch of its own: an empty pilot IS the off position | none published |

Plus the per-supplier one, which is a different mechanism:
`supplier_accounts.state = 'killed'` (#124) stops new submissions while status,
cancellation, return and reconciliation carry on.

**Catalogue FETCH and public-offer PUBLICATION are independent**, as #125
requires: `CATALOG_INGESTION_ENABLED` gates the ingestion LOOP, while whether an
observation becomes anything public is decided by the source's own #62 rights
policy — and a Printful source is bound to no merchant, so it produces no public
offer at all whatever either switch says.

## 20. Evidence references from #119

`docs/suppliers/2026-08-09-first-dropship-supplier.md`, which is binding:
§2 (commercial evidence, 15 items), §3 (technical evidence, 20 items, including
the EU-routing capability Mercaria must NOT design around), §4 (cost-only
economics — Printful is the only candidate whose API returns the ENTIRE direct
cost before any order exists), §5 (cost-variance stress test), §7 (compliance,
including the withdrawal-right question), §8 (decision matrix, Printful 3.88),
§9 (selected account and environment), §10 (pilot bounds and stop thresholds),
§11 (the entry checklist), §12 (open risks).

---

## Catalogue ingestion: how a supplier catalogue cannot publish a wholesale cost

#125's rule 7 is "never publish wholesale cost", and the code satisfies it with
a mechanism #62 already has rather than a check somebody has to remember.

A Printful `catalog_sources` row is bound to **NO MERCHANT**, and #62's rule is
that a source with no merchant binding produces **no offers at all**. The
pipeline stores observations and matches them through #58; a wholesale cost
therefore has nowhere public to land, whatever a rights policy says and whoever
writes the next projection. That is also #125 rule 2's separation: a supplier's
raw records live under a source whose kind, rights policy, freshness policy and
kill switch are its own, and can never be read as an affiliate network's —
those are bound to a merchant and do produce public offers.

The adapter declares `full_snapshot` and `targeted` and NOT `incremental`:
Printful publishes no changed-since filter that could be verified, and an
adapter claiming one would silently return everything and call it a delta.
`complete` is set only when the last page was reached AND nothing was
truncated — reporting a complete enumeration of half a catalogue retires the
other half.

## What is NOT built, and what each gap is waiting on

Stated plainly, because #125's acceptance criteria are not all satisfiable
without an account:

| #125 acceptance | Status |
|---|---|
| 1. Adapter passes #124's conformance suite | ✅ `services/printful/__tests__/printful-conformance.realdb.test.ts`, all fourteen cases against a real Postgres server through the real orchestration |
| 2. Catalog data creates private ProcurementOffers and only approved public retail offers | ◐ **PARTIAL.** The catalogue adapter is implemented and the "no public offer" guarantee is structural (above). The projection that turns an observation into a `procurement_offers` row is **NOT built** — see the seam below |
| 3. Live preflight and supplier order creation against the approved environment | ✖ **BLOCKED — no account exists.** §11 gates 1, 5 and 8 |
| 4. Retry and timeout tests create no duplicate order or charge | ✅ Conformance cases 2, 3a, 3b and 13 |
| 5. Successful/rejected/cancelled/shipped/credited states reconcile | ◐ The first four are conformance cases 1, 6, 8a/8b, 5 and 7. **Credited is not**: `credit_note_retrieval` is undeclared because the capability is unverified |
| 6. Packaging, tracking and customer documents match the commercial model | ✖ **BLOCKED — physical verification.** §11 gate 8 |
| 7. Pilot restricted by market, SKU, value and cohort with tested kill switches | ✅ `services/retail-pilot/`, gated at checkout, with realdb and pure tests |
| 8. Expansion requires a measured review | ✅ Structural: a cohort version is immutable once published and a widening is a NEW version with its own author, date and rationale |

**The one named seam this issue leaves open**, failing closed:
`procurement_offers` are not yet written from Printful source records. The
consequence is honest rather than hidden — with no procurement offer there is no
`retail_offer_bindings` row an operator can create, so no Printful item can be
sold at all, and the pilot's SKU allow-list accepts a `procurement_offer_id`
that is nullable precisely so an operator can allow-list a SKU before that
projection exists. Nothing pretends a catalogue sweep produces a sellable item.

## Go-live checklist (the code half)

§11 of the decision document is the human half and remains authoritative. This
is what a deployment must additionally do, in order:

1. ☐ Complete every item of §11. Nothing below is meaningful before that.
2. ☐ Delete the `LIVE_REFUSED_UNTIL_GATED` branch in
   `services/supplier-orders/adapters/printful.ts`, in a change that records
   §11's gates as done.
3. ☐ Create the `suppliers` + `supplier_accounts` rows with
   `provider = 'printful'`, `environment = 'live'`, and the store id Printful
   issued; approve a `supplier_agreements` version carrying the resale,
   dropship and blind-dropship grants.
4. ☐ Point `credential_reference` at the SSM path and register a credential
   reader. **Verify the absence case first**: with no secret, a call must be
   refused, not attempted.
5. ☐ Set `PRINTFUL_ENABLED=true` and confirm both adapters register.
6. ☐ Record the first `supplier_funding_observations` row after the treasury
   prefund. Until one exists, every retail line is refused
   (`supplier_funding_unavailable`) — verify that, rather than assuming it.
7. ☐ Draft a pilot cohort version with all thirteen stop thresholds, the ≤ 25
   allow-listed SKUs and the §10 bounds; publish it. The operator surface
   refuses a draft missing any threshold.
8. ☐ Set `MERCARIA_RETAIL_ENABLED=true` and
   `PROCUREMENT_ORCHESTRATION_ENABLED=true`, in that order.

## Rollback procedure

In increasing order of blast radius. **None of them touches a placed order**:
every switch below stops ENTRY, and purchase orders already placed keep being
submitted, polled, cancelled, refunded and reconciled, because none of those
paths reads any of them.

1. **One SKU is wrong** — raise a `sku`-scoped stop
   (`POST /internal/retail-pilot/stops`). Everything else keeps selling.
2. **One supplier or market is wrong** — raise a `supplier`- or
   `market`-scoped stop.
3. **The whole pilot is wrong** — raise a `pilot`-scoped stop. Retail entry
   stops; the catalogue, the marketplace and every placed order are untouched.
4. **Stop procuring** — `PROCUREMENT_ORCHESTRATION_ENABLED=false`. Paid orders'
   jobs park and deliver when it is back on; nothing is lost.
5. **Stop retail entirely** — `MERCARIA_RETAIL_ENABLED=false`.
6. **Disconnect Printful** — `PRINTFUL_ENABLED=false`. Every preflight answers
   `provider_unconfigured`, which blocks; stored rows are untouched and turning
   it back on drains the backlog.

**Do not use `STRIPE_ENABLED=false` as a rollback.** It unmounts the webhook
endpoints and strands verified events — ADR 0006's rule, and it applies here
unchanged.
