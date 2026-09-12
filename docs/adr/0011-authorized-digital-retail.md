# ADR 0011: Authorized digital retail — Mercaria is the seller, the supplier is private infrastructure

- **Status:** Accepted
- **Date:** 2026-09-12
- **Issue:** epic [#1016](https://github.com/OxyHQ/Mercaria/issues/1016)
- **Amends:** [ADR 0010](0010-digital-commerce.md) **D16**, and only one half of it.
  D16 said *"gift cards, keys and third-party codes are still out"*, giving two
  separate reasons: a redemption code is not a creator file download, and stored
  value has materially different regulatory requirements. The first reason is
  answered here — a third-party activation code becomes a **fulfilment artifact of
  a digital good**, in a domain of its own, and is never modelled as an
  `asset_package`. The second is **untouched**: `stored_value` stays in
  `EXCLUDED_COMMERCE_TYPES`, this ADR mints no vocabulary for a gift card, and the
  `stored_value` detector in `commerce-type-exclusion.test.ts` still runs.
- **Inherits unchanged:** [ADR 0004](0004-mercaria-retail-dropship.md) — the
  `mercaria_retail` commercial role, "a supplier is not a merchant", credential
  REFERENCES rather than credentials, and the decoupling of the procurement domain
  from the payment domain. [ADR 0010](0010-digital-commerce.md) D8/D9/D10 — a
  digital order carries no address, completes by delivery rather than by movement,
  and establishes its place of supply per line on the consumer's country.
  [ADR 0009](0009-peable-payment-rail.md) and [ADR 0001](0001-stripe-connect-architecture.md)
  D3 — the buyer is funded by the same rail and Mercaria's commission is a ledger
  residual. [ADR 0003](0003-commerce-actor-guest-identity.md) — a guest may buy one.

## Context

Mercaria can already sell a 3D model that a creator uploaded (#1015). #1016 asks
for the other digital shape: a **game, a software licence or another authorized
third-party digital product**, which Mercaria does not own, cannot manufacture,
and must obtain from an approved distributor at the moment somebody buys it.

The customer-facing requirement is one sentence and the whole epic turns on it:

> A Mercaria customer buys a game, software licence or other authorized digital
> product from Mercaria, receives and manages it in Mercaria, and never needs to
> know which private distributor Mercaria used to fulfil the order.

Three things make this harder than it looks, and each one is a decision below
rather than an implementation detail:

1. **The thing bought is bought again, upstream, after the customer pays.** A
   creator's file exists before the sale. A key does not: Mercaria buys it from a
   supplier during fulfilment, with real money, irreversibly. Everything about
   retries, timeouts and fallback is a consequence of that.
2. **The artifact is a bearer secret.** A revealed key is worth its face value to
   whoever reads it, which makes ordinary product metadata handling — logs,
   analytics, whole-row selects, support screens, push payloads — a disclosure
   path rather than a convenience.
3. **A supplier is not a seller.** The epic refuses `external_referral` (the buyer
   would leave) and refuses making the distributor a connected marketplace seller
   (it would gain public storefront semantics). What is left is the role ADR 0004
   already defined, applied to a fulfilment shape it never considered.

**What is NOT new here.** Mercaria already has a private supply domain: `suppliers`,
`supplier_accounts`, `supplier_agreements`, `procurement_offers`, `purchase_orders`
and an adapter framework, built by #118/#124 for physical dropship under ADR 0004.
The epic's Workstream 1 vocabulary — supplier, account, agreement, procurement
offer, purchase order, fulfilment — is that domain's vocabulary, and the epic says
plainly: *build on, do not duplicate*. So the question this ADR has to answer is
not "what shape should a private supplier domain have" but **"which half of the
existing one is about buying, and which half is about parcels"**.

## Decisions

### D1. `mercaria_digital_retail` is a FULFILMENT CAPABILITY of `mercaria_retail`, not a fourth commercial mode

ADR 0004 D1 defined `mercaria_retail` as a **commercial role**: Mercaria is the
seller of record, the buyer's payment relationship is with Mercaria, the buyer's
support relationship is with Mercaria, and the supplier is a private procurement
counterparty with no public storefront semantics. Read the epic's
"non-negotiable commercial boundary" block beside it and every line is already
that role:

```text
mercaria_digital_retail
  public seller: Mercaria            -> ADR 0004 D1/D2.2
  checkout: Mercaria                 -> ADR 0004 D1
  payment relationship: buyer <-> Mercaria   -> ADR 0004 D2.1
  support relationship: buyer <-> Mercaria   -> ADR 0004 D2.5
  upstream supply: private provider(s)       -> ADR 0004 D2.2
  fulfilment: digital                        -> NEW
```

One line is new. So `mercaria_digital_retail` is **the value of a fulfilment
capability**, not a second commercial role: the role decides who sells and who
pays, and the capability decides what is handed over. Minting a fourth commercial
mode would fork the checkout, the ledger posting, the refund path and the
merchant-of-record answer for a difference that is not commercial, and the fork
would then have to be kept in step by hand — the shape ADR 0004 D1 refused when it
declined to make `mercaria_retail` a payment provider.

Two non-decisions, stated because the epic asks for them explicitly:

- **Not `external_referral`.** `services/outbound/` exists and is a different
  product: it sends a buyer to somebody else's checkout and records a commission.
  A digital-retail buyer never leaves.
- **Not a connected marketplace seller.** ADR 0001's Connect accounts carry public
  storefront semantics — a merchant page, a payout relationship, a seller identity
  on an order. A distributor gets none of the three, and the absence is structural:
  nothing in this ADR's domain can produce a `stores` row.

### D2. The supplier SPINE is reused; the digital half rides as an agreement RIDER and a per-account capability

`suppliers`, `supplier_accounts` and `supplier_agreements` stay the ONE record of
a counterparty. The digital domain adds two tables beside them rather than a
parallel stack:

| New table | What it holds | Why not a column on the existing table |
|---|---|---|
| `digital_supply_terms` | the digital rider on ONE agreement version: provenance class, permitted product classes, permitted fulfilment capabilities, territories, brand carve-outs, replacement and credit policy, catalog-data rights | the physical agreement already carries 30 columns about parcels (incoterm, shipment SLA, blind dropship, Moovo label dispatch). A rider is one row that exists only for the agreements that grant digital rights, and its absence is a legible "this agreement authorizes no digital supply" |
| `digital_supplier_capabilities` | one row per account × adapter capability, with its OWN pause state and health | the epic requires catalog sync and procurement to pause INDEPENDENTLY (W2 requirement 9). `supplier_accounts.api_capabilities` is a `text[]` — an array cannot carry a per-element pause, a per-element health check or a per-element reason |

**Why not a second supplier table.** Because a kill switch that exists twice is a
kill switch that gets thrown once. `supplier_accounts.state = 'killed'` is the
emergency stop an operator already knows, it carries a mandatory reason, and the
whole physical-side tooling reads it. A `digital_suppliers` table would mean an
incident response that disables a compromised counterparty on one side and leaves
it procuring on the other — and the compromise the epic threat-models (W14 threat
8, supplier credential compromise) is a compromise of the credential this account
already references.

**Consequences, accepted deliberately.** `SUPPLIER_TYPES` gains
`digital_distributor`, and `SUPPLIER_API_CAPABILITIES` is NOT widened — the digital
capability vocabulary is its own closed set on the new table, because
`shipping_quote` and `redeem_activation` do not belong to one list. Provenance
(the epic's Workstream 21 classification) lives on the RIDER, not on the supplier:
one counterparty can be publisher-direct for its own titles and an authorized
distributor for everything else, and that is a property of what was agreed, not of
who they are.

### D3. Provenance has four members and no `unknown`, which is what makes it fail closed

```text
publisher_direct | authorized_distributor | authorized_wholesaler | approved_marketplace_supply
```

The epic requires that *"unknown/unverified sourcing cannot become eligible"*. The
obvious spelling is a fifth member, `unverified`, and it is the wrong one: a
nullable-or-`unverified` column is a value the database accepts, which means a row
can sit in it, which means the eligibility rule is a service-level `if` somebody
can relax. Here the rider's provenance column is **NOT NULL with a four-member
CHECK**, so an unclassified supply relationship has no rider at all — and no rider
is already "authorizes nothing" by D2. The unverified state is unrepresentable
rather than refused.

`approved_marketplace_supply` is a member and it is the weakest one. It exists
because the epic names commercial marketplace APIs as candidates *where the exact
account and terms permit it*, and refusing to represent them would push that supply
into being recorded as something stronger. Procurement policy may PREFER stronger
provenance (D9); no public surface claims "official" from it (D13).

### D4. A digital procurement offer is its own table, and an ambiguous one can never fulfil

`procurement_offers` is a table about parcels: its facts are lead time, packaging,
Incoterm, origin and destination countries, and its upsert key is
`(supplier_account_id, supplier_sku)`. A digital offer's facts are different in
kind — platform, activation ecosystem, edition, territory of ACTIVATION rather than
of delivery, and which fulfilment capability the supplier will use.

The load-bearing addition is **mapping status**, and it is the epic's Workstream 4
closing sentence made structural:

> A supplier offer with ambiguous platform, edition, region or activation ecosystem
> must not be used to fulfil a customer order.

So `digital_procurement_offers.mapping_status` is a three-member closed set —
`exact`, `ambiguous`, `unmapped` — and only `exact` can be procured, derived in
`deriveDigitalProcurementEligibility` alongside every other reason. An ambiguous
offer is STORED, with the supplier's native title kept verbatim for audit, and it
is dark. It is never silently dropped and never quietly promoted: that is the same
refusal `matchIncomingVariant` already makes for GTIN collisions, which answers
`ambiguous` and never `skipped`.

**Eligibility is derived, never stored**, exactly as `procurement-eligibility.ts`
derives it for the physical side, and for the same reason: a stored verdict beside
the facts it derives from is two representations of one fact, and the place they
must not disagree is a checkout gate.

### D5. The digital purchase order is a separate record with its own state machine

```text
pending -> preflighted -> submitting -> accepted -> fulfilled
                             |  \-> ambiguous -> (recovered) accepted | rejected | failed
                             |
                             \-> rejected | failed
any non-terminal -> cancelled
accepted | fulfilled -> credited        (supplier credit, a financial event)
```

Terminal: `fulfilled`, `rejected`, `cancelled`, `credited`, `failed`.

**Why not `purchase_orders`.** That machine ends at `delivered`, through
`purchase_order_shipments`, carrying a ship-to address. A digital order has all
nine address columns NULL by ADR 0010 D8, so a digital PO on that table would need
a shipment that never arrives and an address that must not exist. Two machines,
two tables, and nothing shared but the supplier spine.

**`ambiguous` is a state, not an error.** It is the epic's invariant 12 and its
Workstream 8 requirement 2, and it is the single most expensive thing to get wrong
here: a timeout that advances a PO to `failed` invites a fallback that buys a
SECOND key for a customer who is only paying for one. So the transition table
admits no edge from `submitting` to `failed` on a timeout at all — the only edge is
to `ambiguous`, and the only edges OUT of `ambiguous` are ones that carry provider
truth from `recoverPurchase()` or `getOrderStatus()`.

### D6. Exactly-once procurement is THREE mechanisms, and none of them is a service-level check

| Mechanism | What it makes impossible |
|---|---|
| `UNIQUE(idempotency_key)` on the PO, the key DERIVED from the order line and the attempt ordinal | two POs for one attempt — and because the same key is what the adapter is handed, a provider that honours idempotency dedupes on its side too |
| `UNIQUE(order_item_id) WHERE status NOT IN (terminal…)` — a partial unique index | **two LIVE procurement attempts for one order line.** This is the epic's fallback rule 1 (*"recover ambiguous A first — never immediately buy another key after a timeout"*) expressed as a database property rather than as an ordering somebody has to preserve |
| a compare-and-swap claim: `UPDATE … SET status='submitting' WHERE id=$1 AND status='preflighted' RETURNING` | a second worker submitting a PO that is already in flight. A caller that cannot name where it started cannot write — the `IntentStateChange.from` rule, which Peable learned by having an event race an expiry sweeper and write `settled` over `expired` |

The third one is why every transition in this domain takes a `from` and answers
three ways — `updated`, `stale`, `missing` — rather than returning the row.

**A duplicate client retry is not a case this domain handles specially**, because
it cannot reach the second mechanism: the retry resolves to the same order line,
the live PO is already there, and the orchestrator returns it.

### D7. Preflight is authoritative, and the PO stores the MAXIMUM COST it may ever pay

Preflight re-asks the supplier the questions a cached offer can only answer
approximately — is this exact SKU still mapped, in stock, at what cost, for this
market, with which fulfilment capability — and its result is written onto the PO as
`quoted_cost` **and** `max_accepted_cost`.

`max_accepted_cost` is what makes fallback safe. Every later attempt for the same
order line inherits the same bound, so:

- a supplier whose cost has risen above it is not eligible (`cost_above_bound`);
- a fallback cannot become more expensive than the decision the customer's price
  was set against;
- and the epic's rule 6 — *"never charge the customer more without explicit
  consent"* — needs no code, because there is no path that could.

When no eligible supplier remains within the bound, the order converges to
cancellation and refund (D11). That is a worse outcome than a slightly thinner
margin and it is deliberately the only one available: the alternative is a
re-priced order the buyer never agreed to.

### D8. Capture before procurement, with a compensating refund — ADR 0004 D4, unchanged

The epic asks the ADR to choose between `preflight → authorize → procure → capture`
and `preflight → capture → procure`. **Capture first**, matching ADR 0004 D4, for
its three reasons plus one that is specific to digital:

1. An authorization is a hold with an expiry and an SCA story; ADR 0004 measured
   what happens when a customer completes authentication after a quote expires.
2. The rail (ADR 0009) is the same rail, and a second capture posture would mean
   two ledger sequences for one commercial role.
3. Refund is the compensating action, it is idempotent, and it is already built.
4. **The digital-specific one:** a supplier key purchase is immediate and
   irreversible. If procurement succeeded while the customer's authorization had
   expired, Mercaria would hold a bought, non-returnable key and no funded order —
   the exact asymmetry that makes "authorize, then buy the irreversible thing" the
   wrong order of operations here.

What capture-first costs is honest and small: a refund is issued for every
procurement that cannot be completed, and the buyer sees money leave and return.
The alternative costs a key.

### D9. Selection is a documented policy, and "cheapest wins" is not it

The selector is deterministic, server-side, and ordered:

```text
1. exact mapping (D4) and rights match  — a hard gate, never a score
2. authorized territory                 — a hard gate
3. supplier, account and capability healthy and unpaused
4. availability
5. cost within the order's max_accepted_cost (D7)
6. the fulfilment capability the line requires
7. then rank: provenance strength, historical reliability, expected latency, cost
```

Steps 1–6 are gates that produce closed-set REASONS when they fail, so an operator
can see why a supplier was not chosen. Step 7 is the only place cost appears, and
it appears last. The ranking is total and deterministic — ties break on the offer
id — because a non-deterministic selector makes an incident unreproducible.

**None of this is visible to anybody outside the private domain**, which is the
other half of the epic's rule that supplier economics may never buy organic
ranking: the catalogue's ranking inputs and this selector share no module, no
table and no type.

### D10. A fulfilment artifact is SEALED, and the plaintext has no column

`digital_fulfilment_artifacts` stores `ciphertext`, the `key_reference` that names
the key it was sealed with (a PATH into the approved secret store, shaped by CHECK
exactly like `supplier_accounts.credential_reference`), the algorithm, and a
`sha256` digest of the plaintext. There is no plaintext column, no `*_url` column,
and the three sensitive columns are registered in `db/protectedColumns.ts` so a
whole-row read cannot ship them — the compile-time half of that registry means a
serializer that reaches for one fails `tsc`.

**A four-character `masked_hint` is stored in clear, and it is a deliberate
trade.** Support's most common question is *"is the key I am holding the key you
sold me"*, and answering it without a hint means revealing the whole secret to an
operator on every enquiry. Four characters cannot reconstruct a key and can settle
that question, so the hint exists, is bounded by CHECK, and is what support
screens render by default (the epic's W18 requirement 11).

**A reveal is not a redemption.** `first_revealed_at` is written by Mercaria when
the buyer asks; `redemption_state` may only be written from provider truth, and its
default is `unknown` because for most ecosystems it IS unknown. Collapsing them
would make "the customer looked at their key" indistinguishable from "the key was
used", which is precisely the distinction a refund decision turns on (D11).

**Every reveal is an append-only event** with no device, IP or browser fingerprint
— `~/AGENTS.md`'s no-IP invariant holds here with no exception, as it does for
`asset_download_events`.

### D11. Refund eligibility is DERIVED from facts, and its outcomes are a closed set

```text
cancel_before_procurement | cancel_procurement | refund_customer | replace_artifact
| supplier_credit_pending | manual_review | not_eligible
```

Derived by a pure function from: the PO state, whether an artifact exists, whether
it was revealed, the redemption state, the fulfilment capability, and whether the
buyer waived withdrawal (ADR 0010 D11's three-member vocabulary, unchanged). No
boolean column anywhere says "refundable".

Three rules the function encodes and nothing may relax:

- **Nothing is deleted.** A replaced artifact is marked `replaced` and kept; the
  replacement is a NEW artifact carrying `replaces_artifact_id` and the incident it
  came from. `digital_fulfilment_artifacts` refuses DELETE by trigger.
- **Exactly one artifact is active per fulfilment** — a partial unique index — so
  "both the original and the replacement work" is unrepresentable rather than a
  race somebody has to think about.
- **Supplier credit and customer refund are separate events**, settling on
  different days through different rails, and the ledger says so. Mercaria refunds
  the buyer when policy says to, whether or not the supplier has credited it.

### D12. An operator can never fabricate a fulfilment, and a machine can never file an incident

An artifact carries a `source` from a closed set, and `operator_manual` is a member
because the real world contains suppliers who email a key after an outage. What
makes it safe is the CHECK beside it: an `operator_manual` artifact REQUIRES both a
named operator and an incident id, with no default. The same rule runs the other
way for incidents — a `digital_fulfilment_incidents` row requires an operator when
its kind is an operator action — which is the rule #1015's provenance escalation
already uses: *a machine can never file*.

The epic's W18 closing line (*"operators must not be able to fabricate a successful
key/activation without an auditable exceptional process"*) is therefore two CHECKs,
not a policy.

### D13. What is public is structurally unable to leak, and the private table never reaches a DTO

The public projection is `DigitalRetailOfferView`, and its safety is its SHAPE: it
has no supplier id, no account, no agreement, no cost, no supplier SKU, no provider
order id and no procurement reasoning. A serializer that tried to ship one of those
fails `tsc`, because the type has no property to hold it — the same device
`PurchaseOrderFulfilmentView` and `RetailOfferSourcingSeam` already use.

The private tables are private WHOLE. `digital_procurement_offers` and
`digital_purchase_orders` have no route, no controller and no DTO, and the seam
that crosses toward a public surface is a projection built field-by-field, never a
spread — so a column added later cannot arrive at a public API by inheritance.

**"Sold by Mercaria" is the only sourcing claim made.** No public surface says
`publisher_direct`, because that is a claim about authorization that belongs in the
canonical commerce graph behind evidence (ADR 0002), not in a procurement rider.

### D14. Five levers, independent, and the incident lever defaults ON

Mirroring ADR 0010 D13 exactly, and for its reason:

| Variable | Default | Stops |
|---|---|---|
| `DIGITAL_RETAIL_CATALOG_SYNC_ENABLED` | off | pulling supplier catalogues |
| `DIGITAL_RETAIL_PUBLICATION_ENABLED` | off | an offer becoming publishable |
| `DIGITAL_RETAIL_CHECKOUT_ENABLED` | off | buying |
| `DIGITAL_RETAIL_PROCUREMENT_ENABLED` | off | submitting anything to a supplier |
| `DIGITAL_RETAIL_REVEAL_ENABLED` | **on** | revealing an artifact a buyer already owns |

`revealEnabled` is the only lever that reaches something a buyer already holds,
which is exactly why it defaults on: the thing you reach for mid-incident must not
be the thing that destroys what buyers hold. Turning it off refuses new reveals and
leaves every fulfilment intact.

These are deployment levers. They do NOT replace the per-row kill switches — the
account's `state = 'killed'`, the capability's own pause — because an incident is
usually about ONE supplier and a deployment lever cannot be that precise. The epic
requires eleven independent kill switches; five are environment, the rest are rows.

### D15. Disabling new sales never strands an existing purchase

Every lever above gates an ACQUISITION path. None of them gates the library, the
reveal of an artifact already sold (except the incident lever, deliberately), the
support view or the refund path. This is ADR 0010 D13's rule restated for a domain
where the consequence is worse: a buyer whose key is dark has paid for something
they cannot use, and a supplier pause is not their fault.

### D16. Stored value stays out, and it stays out by having no vocabulary

`DIGITAL_RETAIL_PRODUCT_CLASSES` is `digital_game`, `game_expansion`,
`software_licence` and `subscription_activation_code`. There is no member for a
gift card, a top-up or any other cash-equivalent instrument, and the CHECK on the
column is rendered from that tuple — so a gift card is not "disabled by a flag",
it is **unrepresentable**, which is the same device ADR 0007 D15 uses for the
commerce types it excludes.

Admitting one is the procedure, not an edit: a new ADR that answers the epic's
Workstream 13 list (payment-provider permission, money-transmission boundary,
chargeback exposure, velocity limits, age requirements), plus the tuple, plus a
migration in the same PR. This ADR deliberately does not pre-judge it.

**`subscription_activation_code` is not a `consumer_subscription`.** Mercaria sells
a code once, for a fixed price, and never bills the customer again; the recurring
relationship, if any, is between the customer and the platform they redeem it on.
The exclusion ADR 0007 D15 holds is about Mercaria operating a recurring consumer
charge, and nothing here does.

### D17. The buyer's library is a PROJECTION, and there is no library table

A buyer's Mercaria Library is the union of two durable records they already own:
`asset_rights` (#1015, a creator file) and `digital_fulfilments` (#1016, an
authorized retail artifact). Both are keyed by the same `buyer_key` spelling —
`oxy:<id>` or `guest:<sessionId>` — so one query per source answers "what does this
person own", and a guest reaches theirs through #101's scoped authorization exactly
as they reach a download.

A `library_entries` table is refused for the epic's own reason (*"do not duplicate
order truth in a disconnected library database"*): it would be a third copy of a
fact two tables already hold, and the day it disagreed with them would be the day a
buyer's purchase disappeared from their library while still existing in their
order.

### D18. Tax treatment is carried per product class, and no jurisdictional conclusion is hard-coded

ADR 0010 D10 established that a digital line's place of supply is the consumer's
COUNTRY, per line, with a closed evidence vocabulary that excludes every
IP-derived and fingerprint-derived source. That is unchanged and it is enough for
delivery; what a key sale adds is that **different digital product classes are not
automatically the same tax object**, and the schema has to be able to carry the
distinction before a policy can be written against it.

So `digital_retail_tax_classes` is a closed set on the offer and on the order
snapshot, and this ADR asserts no rate, no threshold and no jurisdictional
conclusion. A market whose treatment is unresolved does not launch — the checkout
lever is per deployment and the sign-offs are recorded in `HANDOFF.md`, as ADR 0010
D15 already requires for paid digital checkout.

## What Phase A ships, and what it deliberately does not

The epic is explicit that it is a multi-issue epic with a recommended order. This
ADR is binding for all of it; the code that lands with it is items 1–8 of that
order plus the library projection:

**Shipped:** the responsibility model (this file); the private digital supply
domain (rider, capabilities, offers, purchase orders, attempts, fulfilments, sealed
artifacts, reveals, incidents, pricing policies); the provider-neutral adapter port
with a conformance suite and a sandbox adapter; derived eligibility; the
deterministic selector; the retail pricing function with margin bounds; the
exactly-once orchestrator with ambiguity recovery and bounded fallback; sealing and
reveal; refund-outcome derivation; and the library projection.

**Not shipped, and each for a reason rather than for lack of time:**

- **Public offer publication and checkout wiring.** Mercaria's unified public offer
  domain is #57 and it does not exist — which is why #118 exposed a SOURCING SEAM
  for physical retail instead of extending a table that is not there. This domain
  does the same: `projectDigitalRetailSourcingSeam` is what #57 composes over when
  it lands. Building a parallel public-offer path now would be the second commerce
  stack #1015 acceptance criterion 20 refuses.
- **A named provider adapter.** The epic forbids coding against guessed
  capabilities: *"do not code against guessed capabilities before this review
  exists"*. The sandbox adapter is a conformance fixture, not a pilot.
- **Gift cards and any stored-value instrument.** D16.
- **Direct account activation (OAuth account linking).** The capability is in the
  vocabulary and refuses to fulfil rather than pretending; the reviewed
  account-linking flow is its own issue.

`HANDOFF.md` carries each of these with what it still needs.

## Consequences

- ADR 0010 D16's first half is now historical and the file says so. Its second half
  — stored value — is live, and the detector that holds it is untouched.
- The procurement domain now has two purchase-order machines. They share a supplier
  spine and nothing else, and the census tests name both.
- A third party's secret material is stored in Mercaria's database for the first
  time. `db/protectedColumns.ts` gains three entries, the sealing seam is one
  module, and reading a ciphertext is an explicit, greppable act.
- Every operator action that could manufacture value carries a named operator and
  an incident by CHECK, so the audit trail cannot be skipped by a convenient
  default.

## Acceptance criteria of #1016, answered

| # | Criterion | Where |
|---|---|---|
| 2 | canonical identity independent of supplier SKU | D4; `digital_procurement_offers` maps to a canonical variant and several offers may map to one |
| 5 | preflight and procure through an adapter | D7, the adapter port and its conformance suite |
| 6 | customer order and supplier PO are separate durable records | D5 |
| 7 | retries and ambiguous timeouts cannot duplicate fulfilment | D6, three mechanisms |
| 8 | artifact stored securely, reachable only through authorized access | D10 |
| 9, 10 | the purchase appears in the library, guest included | D17 |
| 11, 12 | audited support workflow; refund, credit and replacement are separate events | D11, D12 |
| 13 | costs and supplier identity do not leak | D13 |
| 14 | agreements constrain publication and procurement | D2, D3 |
| 15, 16 | eligibility is derived and a pause strands nothing | D4, D15 |
| 17, 18 | two suppliers, one public offer, no substitution | D9, and the selector's hard gates |
| 21 | stored value stays disabled | D16, by being unrepresentable |
| 22 | ranking cannot use supplier economics | D9, D13 |
| 23 | kill switches preserve post-purchase access | D14, D15 |
| 24 | nothing depends on a provider's schema outside its adapter | the adapter port; the conformance suite is the proof |
| 25 | documentation explains how to add a supplier | `docs/digital-retail.md` |

Criteria 1, 3, 4 and 19–20 depend on the public offer and checkout surfaces that
#57 owns, and on a named provider; they are the reason Phase A is a phase.
