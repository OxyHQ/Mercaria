---
title: Retail eligibility — resale authorization, product compliance and market gates
---

# Retail eligibility (#121)

Mercaria is the **seller** on a `mercaria_retail` order (ADR 0004 D2.1). Before
one can exist, Mercaria has to be able to show — with evidence, not with a
checkbox — that it may resell that exact product, through that exact supplier,
into that exact market, and that it can meet the product-safety, consumer, tax
and operational obligations that come with being the seller.

This domain is that gate. It is a hard, server-side derivation that publication
(#57/#129), search, cart and checkout (#123) all read, and that no client can
override.

> Binding decisions: **ADR 0004** D2.8–D2.10, D12.3–D12.4.
> Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`
> §"The retail eligibility domain".
> Sibling domains: **#118** (suppliers, agreements, procurement offers) supplies
> the supply chain; **#120** (zero-margin retail pricing) consumes the verdict as
> its `marketSupported` input.

---

## The service contract

```ts
getRetailEligibility(
  {
    procurementOfferId,
    canonicalVariantId?,   // cross-checked against the offer's own mapping
    channel,
    destinationCountry,
    currency,
    quantity,
    orderValue?,
    fulfilmentMethod,
    customerType,
    at?,
  },
  { surface: 'publication' | 'checkout' | 'sweep' | 'operator', record?, db? },
): Promise<RetailEligibilityResult>
```

The result carries the verdict, bounded reason codes, the evidence the answer
rested on, the tax determination, the policy version it was derived under, the
next required action and a content hash.

**There is no override on the wire and none in the signature.** No `force`, no
`bypass`, no `assumeEligible`, no `defaultVerdict`. The only thing that can
change a verdict is DATA — an evidence row, a policy version, a recorded and
dual-approved exception over a *waivable* reason — every piece of which is
audited with a mandatory actor and reason. A test scans the whole domain for a
bypass-shaped field, and the HTTP surface's `.strict()` schemas refuse one.

### The verdict is three-valued

| Verdict | Meaning | May publish? | May check out? |
|---|---|---|---|
| `eligible` | every dimension answered affirmatively | yes | yes |
| `ineligible` | a dimension answered NO — a settled refusal | **no** | **no** |
| `unknown` | a dimension could not be answered | **no** | **no** |

Both non-eligible values block. They are kept apart because they call for
different work: an `unknown` belongs in the evidence queue, an `ineligible` in a
report of what Mercaria has decided not to sell. Collapsing them would either
hide a settled refusal in a backlog or make an unanswered question look like a
decision somebody made.

**`ineligible` beats `unknown` beats `eligible`.** A settled refusal is a harder
fact than a missing one, so it is what gets reported when a combination fails
several ways at once — `deriveRetailCompleteness`'s severity-ordering rule
(#120), applied to a three-valued verdict.

---

## Why the verdict is DERIVED and never stored

The inputs sit on eleven tables across three domains: supplier, agreement and
offer (#118); canonical product, variant and identifier (#56); and this domain's
policy, category rule, market capability, evidence and suppression rows. A
stored verdict beside them would be two representations of one fact, and the
place they must not disagree is a checkout gate.

This is the deliberate divergence from the `onboarding_state` one-verdict rule
(#46), and the same one `deriveNativeCheckoutEligibility` (#57) records: payment
readiness is one stored verdict because its inputs sit on the row being
verdicted, and this one's do not.

Two acceptance criteria are true because of it, with **no sweep having run**:

- **(2) an expiry removes eligibility automatically** — `expires_at` is read
  against the clock in `evidence-state.ts`, and `expired` is not a storable
  state at all;
- **(5) a recall suppresses immediately** — a committed `retail_suppressions`
  row is seen by the very next derivation, which is why the emergency path is
  testable INDEPENDENTLY of ordinary source refresh: the refresh path is not
  involved.

`retail_eligibility_decisions` is a RECORDING, not an authority. Nothing reads a
row there to decide anything; the rows exist for the operator trace, the
re-evaluation sweep, the eligible-catalogue measurement and the alert on a
checkout an eligibility change blocked. A test fails the build if
`eligibility.ts` ever imports the decision repository.

---

## An affiliate feed can never authorize a resale

ADR 0004 D2.10 is the reasoning: an affiliate agreement grants *linking and
commission* rights; a public retail API's terms typically prohibit commercial
resale and automated purchasing for others; a consumer account transacts under
consumer terms — quantity caps, personal-use clauses, no B2B invoice, no
accepted product-safety traceability obligations, terminable without notice.

`RetailResaleEvidenceKind` (12 members, every one of them something a
counterparty SIGNED, GRANTED or CONFIRMED in writing) and
`RetailForbiddenEvidenceKind` (14 members) are **disjoint unions**. There is no
column, no DTO field and no request body that accepts a forbidden kind:
`retail_resale_evidence.kind` CHECKs against the allowed tuple, and a policy
version's `required_resale_evidence_kinds` is containment-CHECKed against the
same one. So acceptance 1 is not a validator that says no — there is no row
shape in which an affiliate feed is resale evidence.

`services/retail-eligibility/forbidden-evidence.ts` adds the **answer**: it maps
what a caller offered onto the exact prohibition and explains why it proves
nothing, over free text as well as over the enum ("issuer: our affiliate
dashboard" is the shape this rule actually has to catch). It is mounted BEFORE
the `.strict()` schema on the policy route, so an operator is told what they
attempted rather than "invalid enum value" — and a test pins the message, so a
remount after the schema fails rather than regressing quietly.

---

## What is evaluated, dimension by dimension

| # | Dimension | Where it is answered |
|---|---|---|
| 1–2 | Supplier and agreement | #118's `deriveProcurementEligibility`, carried verbatim as `supplyReasons` |
| 3 | Procurement offer and supplier SKU | the offer row; `supplier_sku` against the agreement's exclusions |
| 4 | Canonical product and variant | the offer's mapping, plus `minimum_match_confidence` |
| 5 | Brand and category | `canonical_products.brand_id`, the category path, `retail_category_rules` |
| 6 | Fulfilment origin | the offer's declared origins ∩ the policy's permitted set |
| 7 | Customer destination | the policy's permitted destinations, the agreement's, and the evidence scope |
| 8 | Sales channel | the policy's permitted channels |
| 9 | Currency | the policy's permitted currencies |
| 10 | Quantity and order value | `max_quantity_per_order`, `max_order_value_*` |
| 11 | Shipping method | `permitted_fulfilment_methods` |
| 12 | Customer type | `permitted_customer_types`, and the route determination is per type |
| — | Effective time and policy version | the active version at `at`, cited by composite foreign key |

### Reasons and actions are TABLES, not switches

`RETAIL_ELIGIBILITY_REASON_VERDICT` maps each of the 59 bounded reasons to
`ineligible` or `unknown`; `RETAIL_ELIGIBILITY_REASON_ACTION` maps it to one of
15 bounded next actions; `RETAIL_ELIGIBILITY_ACTION_PRIORITY` decides which
action is reported when several apply. The `claim-methods.ts` device (#83):
policy in a `switch` drifts from policy in a document.

The distinction the verdict map encodes is exactly one question: **did Mercaria
establish a NO, or did it fail to establish a YES?** Everything expired,
revoked, rejected, excluded, prohibited, recalled, suppressed, ambiguous or over
a limit is the first. Everything missing, unverified, unevaluated, unresolved or
unavailable is the second.

`not_available` is the honest terminal action: nothing an operator can do makes
this combination sellable under the current policy. Reporting "collect more
evidence" for a prohibited category would send somebody after a document that
would change nothing.

---

## The nine tables

| Table | What it holds |
|---|---|
| `retail_eligibility_policies` | one immutable VERSION of the policy: what is permitted, what is required, and whether exceptions exist at all |
| `retail_category_rules` | one policy version's verdict on one category: admissible, prohibited or approval-gated, plus the compliance documents it demands |
| `retail_market_capabilities` | one route (destination × origin × customer type): can Mercaria honour cancellation, withdrawal, guarantee, returns, defects, refunds, invoices, recalls — and what is the tax treatment |
| `retail_resale_evidence` | one signed grant supporting a right to resell, with its scope, its reviewer and its deadline |
| `retail_compliance_evidence` | one product-safety or regulatory document, with the markets it covers |
| `retail_suppressions` | recalls, safety notices, kill switches and policy exclusions |
| `retail_eligibility_exceptions` | a dual-approved, expiring waiver of a NAMED, WAIVABLE reason |
| `retail_eligibility_decisions` | the append-only record of what was answered, and to whom |
| `retail_eligibility_audits` | every approval, rejection and override — one row per ATTEMPT, refusals included |

### Empty arrays mean opposite things on a POLICY and on EVIDENCE

A **policy** (like a `supplier_agreements` grant) permits what it names and
nothing else: `permitted_destination_countries = '{}'` permits no destination.
A freshly drafted version therefore permits nothing at all.

A piece of **evidence** (like `commerce_relationships.territories`) is a
positive fact being scoped DOWN: an unscoped brand authorization covers whatever
its agreement covers, which is already bounded. One that names two brands covers
those two.

The two semantics are documented against each other in `CONVENTIONS.md`, and
this domain is the first place both appear in one file.

### A decision cites its policy version, or it is unrepresentable

`retail_eligibility_decisions.(policy_id, policy_key, policy_version)` is a NOT
NULL **composite** foreign key onto
`retail_eligibility_policies.(id, policy_key, version)` — the
`match_category_gates` device (#58), applied to reproducibility. A decision that
cannot name the version it was made under cannot exist, and one whose snapshot
names a different version than its policy row is refused by Postgres rather than
by a comparison somebody has to remember.

There is one honest exception: a derivation made when NO version is active
answers `unknown` / `policy_missing`, and it is deliberately **not recorded** —
a record that cannot be reproduced is evidence of nothing.

### Three hand-written triggers

1. `retail_eligibility_policies` freezes every scope column once the version
   leaves `draft` (the `fee_schedules` / `retail_pricing_policies` mechanism).
   Acceptance 7 is false the moment an active version can be edited underneath a
   decision that cited it. STATUS transitions stay legal, or a version could
   never be superseded.
2. `retail_eligibility_decisions` refuses UPDATE and DELETE.
3. `retail_eligibility_audits` refuses UPDATE and DELETE.

---

## Evidence: states, expiry and review

Stored: `unknown | pending | verified | revoked | rejected` — what a REVIEWER
decided. Derived: those five plus `expired`, which is a function of `expires_at`
and the clock.

- Evidence arrives `unknown`, and `unknown` authorizes nothing. Filing a
  document never widens what Mercaria may sell until a named reviewer accepts
  it at a recorded time.
- Only a VERIFICATION can lapse, so only `verified` becomes `expired`. A
  rejected document past its date is still `rejected` — telling an operator to
  "renew" something somebody refused sends them to do the wrong work.
- When several documents of one kind exist and none is effective, the
  **strongest fact present** is reported: `expired` > `revoked` > `rejected` >
  `pending` > `unknown`. An `expired` one is the closest thing to authority the
  subject has, and renewing it is the shortest path.
- "Present and not effective" and "nobody collected one" are different facts and
  produce different reasons (`*_unverified`/`*_expired`/… versus `*_missing`).

The CHECKs refuse a verification with no reviewer, a rejection with no reason, a
revocation with no actor, a document that points at nothing, and an expiry
before its issue date.

---

## Recalls and the emergency path

Raising a suppression is **one INSERT**. Because eligibility is derived, a
committed `stop_sale` row stops new publication and new checkout in the very
next derivation: no queue, no sweep, no cache to invalidate, and the
catalogue-refresh path is never involved. That is what makes acceptance 5
testable on its own (`emergency-path.realdb.test.ts` walks eligible → recall →
ineligible → lift → eligible against a real database).

- **A recall can never be `advisory`** — a CHECK refuses exactly the combination
  that would turn "recorded a recall" into "changed nothing". An `advisory`
  safety notice records without blocking, because a notice that is not a
  stop-sale must not silently delist a catalogue.
- **One live suppression per (scope, subject, kind)**, held by a partial unique.
  Two operators reacting to one authority notice produce ONE row, not two an
  operator would have to lift one at a time.
- **A lift is attributable, dated and explained**, by CHECK — the act that puts a
  product back on sale is the one that must leave a name behind. The row is
  never deleted: what was suppressed, by whom, why and for how long is the
  record an incident review reads (#121 item 6).

### What this domain does NOT do, and who owns it

`scanRetailSuppressionImpact` returns the SUBJECTS currently stopped, and which
of them need recovery rather than only a stop. It deliberately does not join
across active offers, pending checkouts, customer orders and purchase orders —
four domains — because that would make this domain depend on all four.

| Deferred | Owner |
|---|---|
| Notifying affected customers | **#126** (transactional messaging) |
| Supplier cancellation, return, disposal; the RMA | **#127** |
| Cancelling in-flight purchase orders at the adapter | **#124** |
| Live stock, shipping, quote and reservation preflight | **#122** |
| Calling this gate from checkout, and the `orders` widening | **#123** |
| Ambiguous-match review and correction | **#59** |
| Country of origin, manufacturer identity, responsible operator, batch capability | **#122**, through `traceability.port.ts` |

A stub that pretended to do any of them would be worse than the named seam: a
recall whose customer notification silently did nothing is the failure this
section exists to prevent.

---

## Manual exceptions (#121 operations 4)

An exception is DATA the derivation reads, never a parameter a caller passes.
Three independent walls:

1. **The database** refuses to store an unwaivable reason at all —
   `waived_reasons` is containment-CHECKed against `RETAIL_WAIVABLE_REASONS`. No
   recall, suppression, prohibited category, ambiguous match, missing or expired
   evidence, unresolved tax treatment or unavailable refund rail can be waived
   by anybody, however many operators approve it. Those are precisely the
   refusals a person under pressure would most want to wave through.
2. **The policy version** decides whether exceptions exist at all
   (`manual_exceptions_permitted`, default FALSE) and whether two approvers are
   required (`exception_dual_approval_required`, default TRUE). The derivation
   reads both, so a waiver under a version that forbids them waives nothing.
3. **The HTTP enum** on `waivedReasons` is the waivable set, so a caller cannot
   even name a recall in that field.

Four eyes is the row's shape: the two approvers must differ from each other AND
from the requester, by CHECK, and a second approval cannot precede a first.

A waiver is never invisible — it is on the decision row (`exception_id`), in the
audit trail, and in a warning log line, because "why did this become sellable"
is asked long after the exception row has scrolled out of anybody's view.

---

## The operator surface

`/internal/retail-eligibility/*`, behind `RETAIL_OPERATOR_OXY_USER_IDS` — a
**FIFTH** allow-list beside payments, catalog, guest and analytics.

Approving a resale authorization, verifying a product-safety certificate and
**lifting a recall** is a compliance power. It is not a payments one, not a
catalogue-curation one, not a cart-diagnostic one and not an analytics one, and
it is the only one of the five whose misuse puts an unsafe product back on sale.
Sharing a list would grant whichever power the operator was not vetted for.

**Empty = the router is not mounted at all** (404, never 401 — a 401 would tell
an unauthenticated caller that a compliance surface exists on this deployment).
That is a working configuration, and it means nobody can record a policy
version, verify a document or raise a recall — so it must be populated before
`mercaria_retail` carries a live order.

| Method | Path | What it does |
|---|---|---|
| GET | `/metrics` | eligible-catalogue coverage, checkouts eligibility blocked, evidence-queue counters |
| GET/POST | `/policies` | list, draft |
| POST | `/policies/:id/activate` · `/retire` | publish, withdraw |
| GET | `/policies/:id/rules` | one version's category rules and route determinations |
| POST | `/category-rules` · `/market-capabilities` | record (or correct) one |
| GET | `/evidence` | the expiring-document dashboard and the review queue |
| POST | `/resale-evidence`, `…/:id/{verify,reject,revoke}` | file and review a grant |
| POST | `/compliance-evidence`, `…/:id/{verify,reject,revoke}` | file and review a document |
| GET/POST | `/suppressions`, `…/:id/lift` | the emergency stop, and putting a subject back on sale |
| GET/POST | `/exceptions`, `…/:id/{approve,reject,revoke}` | the waiver queue |
| POST | `/trace` | the what-if — the exact question a checkout asks, unrecorded |
| GET | `/audits` · `/subjects/:registry/:id` | the append-only trail |

---

## Environment

```
RETAIL_OPERATOR_OXY_USER_IDS=          # empty = the surface is not mounted (404)
RETAIL_EVIDENCE_EXPIRY_HORIZON_DAYS=30 # how far ahead the expiry dashboard looks
```

There is no `RETAIL_ELIGIBILITY_POLICY_KEY` variable, and none may be added: the
key is the code constant `RETAIL_ELIGIBILITY_POLICY_KEY`
(`mercaria-retail-eligibility`), because a variable holding it could only ever
disagree with the rows it names — the `CROWDSOURCE_APP_ID` reasoning. Publishing
a NEW VERSION under that key is how the policy changes.

There is also no flag that turns the GATE off. `MERCARIA_RETAIL_ENABLED` (ADR
0004 D13) gates offer visibility and checkout ENTRY for the retail channel; a
lever that made this gate answer `eligible` would be the bypass the whole domain
exists to make unrepresentable.

---

## Production-readiness checklist

Before `mercaria_retail` carries a live order:

1. `RETAIL_OPERATOR_OXY_USER_IDS` populated with vetted compliance operators —
   distinct from the payments and catalog lists.
2. A policy version published under `mercaria-retail-eligibility`, with
   `permitted_fulfilment_origin_countries` limited to the EU customs territory
   (ADR 0004 D2.9) and the launch destinations, channels, currencies, methods
   and customer types named explicitly.
3. A `retail_category_rules` row for every category the pilot sells into. An
   unevaluated category is `unknown` and blocks (ADR 0004 D12.3) — that is
   correct, and it means the pilot's category list is a deliberate act.
4. A `retail_market_capabilities` row for every (destination, origin, customer
   type) route, with the consumer capabilities Mercaria can actually honour and
   a determined VAT treatment plus a recorded registration reference.
5. A verified `signed_supply_agreement` per supplier, in scope for the launch
   destinations, plus whichever additional kinds the policy requires.
6. Verified compliance documents for every category rule that demands them, in
   the launch markets.
7. #122's traceability provider registered, OR
   `require_country_of_origin` / `require_responsible_operator` deliberately
   turned off on a policy version whose `summary` says so.
8. The D12 gates of ADR 0004 recorded — Stripe account disclosure,
   launch-market review, recorded exclusions, supplier contract verification,
   insurance and loss funding.

---

## What is enforced by a test

| Property | Test |
|---|---|
| Acceptance 8's whole list — territory, brand exclusion, document expiry, recall, tax unknown, restricted category — plus the affiliate-only case, the three-valued combination and the waiver rules | `services/retail-eligibility/__tests__/eligibility.test.ts` |
| Every forbidden evidence kind is detected by the shape somebody types, and every ALLOWED kind survives | `services/retail-eligibility/__tests__/forbidden-evidence.test.ts` |
| The fee domain, ranking, a stored verdict, FX and an override-shaped field are all unreachable from the domain — with a vacuity floor and a mutation self-test on each detector | `services/retail-eligibility/__tests__/retail-eligibility-isolation.test.ts` |
| The emergency path end to end against a real database, both directions, with the decisions recorded | `services/retail-eligibility/__tests__/emergency-path.realdb.test.ts` |
| Policy immutability, one-active-per-key, the composite citation, append-only decisions and audits, the recall/advisory CHECK, suppression convergence, the evidence CHECKs, unwaivable reasons and four eyes | `db/retailEligibility/__tests__/retail-eligibility.realdb.test.ts` |
| The operator gate, the empty-list 404, the payments and catalog cross-list refusals, and every client-bypass attempt | `routes/__tests__/internal-retail-eligibility.test.ts` |
