# Zero-margin retail pricing (`mercaria_retail`)

How Mercaria prices the goods it sells **itself**. Binding decisions: ADR 0004
(`docs/adr/0004-mercaria-retail-dropship.md`), especially D3 (the cost-only
formula), D8 (cost variance) and D7 (the ledger's zero-profit proof). Issue
#120.

`mercaria_retail` is a **cost-recovery channel, not a margin engine**. The buyer
pays the real documented cost of acquiring and fulfilling the order:

```text
customer amount
  = supplier acquisition cost
  + mandatory supplier handling / pick-pack cost
  + destination-specific fulfilment and shipping cost
  + legally applicable taxes / duties in the customer total
  + other approved, unavoidable, directly attributable order costs

Mercaria markup            = 0
Mercaria item profit target = 0
```

Code: `services/retail-pricing/` (the pure formula, the completeness gate, the
content hash, the variance classifier, the forbidden-component detector, and
the one impure composer), `db/retailPricing/` (repositories),
`db/schema/retailPricing.ts` (four tables). Schema decisions:
`db/schema/CONVENTIONS.md` §"The retail pricing domain". Operator surface:
`/internal/payments/retail-pricing-policies*`, behind the same payment-operator
allow-list the fee schedules use.

This is **not** the marketplace fee (#88). A `mercaria_retail` order pays no
marketplace fee at all — its fee snapshot is `not_applicable` with a NULL fee,
never a zero — and the retail pricing engine cannot import the fee domain, which
a test asserts.

---

## Zero markup is structural, in four independent places

"Markup = 0" is not a default somebody can change. Four walls hold it, and each
is tested on its own because any one alone would be a rule to route around:

1. **The vocabulary.** `RetailCostComponentKind` has eight members and every one
   of them is a direct cost. `RetailForbiddenComponentKind` is a *separate*
   union of the fourteen prohibited things, and the two are disjoint — so a
   markup is not a value the formula can be handed.
2. **The schema.** No column in any of the four tables is named for a markup,
   margin, profit, padding, overhead, reserve, commission, affiliate,
   subscription or ranking input. `retail_pricing_policies.absorption_cap_bps`
   is the domain's only basis-point column and it bounds what Mercaria
   **absorbs** before cancelling and refunding — it can only cost Mercaria
   money. A component row's `kind` CHECK reads the eight-member tuple, so a
   component called `markup` fails the WRITE.
3. **The API.** `retailPricingPolicyCreateSchema` is `.strict()` and enumerates
   the complete set of levers a policy version has. Before it runs,
   `assertRetailPolicyBodyIsCostOnly` inspects the RAW body and refuses a
   forbidden field BY NAME — an operator who sends `markupBps` is told it is a
   `percentage_markup`, not that they made a typo.
4. **The formula.** `composeRetailCostOnlyTotal` has no parameter through which
   anything could be added, and returns `markupMinor` re-derived from the
   components. A property test asserts it is zero over 500 randomized component
   sets.

### The eight allowed direct-cost components

Modelled **separately**, never folded into one inflated unit price, so each stays
independently attributable and reconcilable against its own evidence.

| Kind | What it is | Typical source |
|---|---|---|
| `supplier_item` | the wholesale unit cost, quantity applied | supplier quote line |
| `supplier_variant_surcharge` | a variant uplift the SUPPLIER charges | supplier quote line |
| `supplier_handling` | mandatory handling / pick-pack / per-order fee | supplier quote line |
| `destination_shipping` | what the supplier or carrier charges to THIS destination | carrier tariff |
| `tax_duty` | legally applicable customer taxes, VAT, customs, duties | tax determination |
| `fx_cost` | the measurable conversion cost on this order — never a padded buffer | provider statement |
| `payment_processing` | the provider's own cost, only where lawful, approved and disclosed | provider pricing |
| `other_direct_fulfilment` | another mandatory, evidenced direct cost an ACTIVE policy version names | policy + evidence |

Every component carries its **source, currency, observation time and
confidence** (`quoted` | `guaranteed` | `estimated` | `final` — ADR 0004 D8.1's
four amount classes). An amount with no attributable source is unrepresentable:
`source_ref` is `NOT NULL` with a non-empty CHECK.

### The fourteen forbidden components

`percentage_markup`, `percentage_margin_target`, `fixed_profit`,
`minimum_gross_profit_floor`, `overhead_allocation`, `expected_support_cost`,
`fraud_chargeback_reserve`, `return_defect_reserve`, `referral_commission`,
`affiliate_economics`, `merchant_subscription_economics`,
`paid_ranking_economics`, `psychological_rounding`, `operator_padding`.

Fraud, chargeback, support and return costs are **real** and are funded outside
the customer amount (ADR 0004 D12.5). Identifying that need without padding the
price is the point.

---

## The policy version

`retail_pricing_policies` is a versioned, immutable-once-active commercial
policy — the `fee_schedules` shape, and for the same reason: a policy change is
a NEW version, never an edit, and a database trigger enforces it rather than a
review. A partial unique index holds at most one `active` version per key.

What a version can say, in full:

- `allowed_component_kinds` — the approved subset of the eight. Always contains
  `supplier_item` (CHECK), because a policy that cannot include the item cost
  prices nothing. **`other_direct_fulfilment` must be named here before any cost
  can be booked under it** (ADR 0004 D3.7).
- `payment_cost_passthrough_enabled` + `payment_cost_passthrough_basis` — a
  biconditional CHECK: pass-through is a decision WITH its lawful basis and
  disclosure, or it is off.
- `absorption_cap_bps` + `absorption_cap_floor` — ADR 0004 D3's cap on what
  Mercaria absorbs before cancelling and refunding (default: the greater of 10%
  and 25 EUR).
- `rounding_tolerance_minor` — the tiny minor-unit tolerance, CHECK-bounded to
  `RETAIL_MAX_ROUNDING_TOLERANCE_MINOR` (5). That bound is the structural half
  of "no material variance may be hidden as rounding": widening it is a schema
  change under review, not a configuration.
- `quote_ttl_seconds` — how long a quote composed under it may be trusted.

There is nothing else, and nothing else may be added.

---

## The cost quote

`retail_cost_quotes` + `retail_cost_quote_components`: one immutable,
hash-pinned composition, **append-only from birth** (trigger). The charged
amount is a pure function of it (ADR 0004 D4 step 1), so a mutable quote would
be a mutable price.

It carries the sixteen facts #120 requires: supplier and supplier-offer
identity, canonical variant, quantity, destination/market scope, the item /
shipping / handling / tax-duty amounts as separate components, the FX source
and snapshot per conversion, the payment-cost treatment, the customer total,
the source observation and supplier-quote refs, quoted-at / expires-at, the
completeness verdict, the policy version, and the evidence references.

### Reproducibility

`content_hash` is a sha-256 over a canonical serialization
(`retail-quote-hash.ts`): components sorted, every number stringified, rates
printed at `toPrecision(17)`, the clock never read, an absent optional
serialized as the empty string. Nothing may vary between two hashings of one
quote — the moderation-envelope determinism rule applied to money, because a
hash that drifts turns a legitimate revalidation into a permanent mismatch
days later. `revalidateRetailCostQuote` recomputes it from the stored
components, so a row edited out of band fails rather than being charged.

### The customer total IS the sum

`insertRetailCostQuote` is the ONLY writer of both tables, writes them in one
transaction, and refuses a parent total that is not the exact sum of the
component rows. That is the cross-row invariant a CHECK cannot see; a realdb
test proves it by trying to smuggle an inflated total past it.

---

## Currency and FX

- **Supplier costs stay in their SOURCE currency.** Each component stores the
  source `Money` and the presentment `Money` as two separate pairs. Nothing
  converts a source price on write; `procurement_offers.unit_cost` keeps the
  supplier's own currency, unchanged.
- **The conversion is captured, exactly.** Five `fx_rate_*` columns per
  component — the `FxRateSnapshot` shape — present EXACTLY when the two
  currencies differ (a CHECK, both directions) and naming the pair they
  converted. A converted amount can never exist without the rate that produced
  it, and an identical pair can never carry a spurious one.
- **Quoted FX is distinguished from provider FX.** `fx_basis` is `quoted`
  (Mercaria's rate at quote time) or `provider_final` (the rate the payment
  provider actually applied, from its balance transaction). The two can differ;
  the difference is COST VARIANCE, enters #128, and **never becomes planned
  profit**.
- **The FX base is the SOURCE currency, never a pivot.** `getRates(source,
  [presentment])`. Which currency the configured providers publish against is
  `fx.service`'s private business. No module in `services/retail-pricing/` names
  FairCoin or OxyPay, and a test asserts it — there is no conversion bridge, and
  neither is implemented (ADR 0004 D11).
- **Rates are fetched once per distinct source currency**, so several components
  from one supplier convert at ONE rate rather than at rates taken microseconds
  apart.

### Rounding

The house rules, unchanged — no third scheme was invented:

- **Half-even, once per component**, through `fx.service.convert` →
  `utils/money.roundMinorUnits` (the pricing engine's own reconciliation rule).
- **Quantity is applied in the SOURCE currency, before the conversion**, as
  exact integer arithmetic. Converting per unit and multiplying afterwards
  multiplies the rounding error by the quantity — measured at two minor units on
  a seven-unit order in the test suite.
- **No second rounding at the total.** The customer total is the exact integer
  sum of already-rounded component amounts, so nothing is split and
  `settlement-shares.apportion` (the largest-remainder rule) is not needed here.
  It remains the house rule for splitting a total; retail pricing splits none.

---

## The completeness gate: an unknown cost is never zero

`deriveRetailCompleteness` answers three separate questions, and collapsing them
is the bug the gate exists to prevent:

| Completeness | Presentation | Publishable | Chargeable |
|---|---|---|---|
| `complete` | `exact_cost_only` | yes | yes, until `expires_at` |
| `awaiting_destination` | `starting_item_cost` | yes | **no** |
| `blocked_undocumented_cost` | `not_purchasable` | no | no |
| `blocked_tax_undetermined` | `not_purchasable` | no | no |
| `blocked_unquotable_cost` | `not_purchasable` | no | no |

The mapping is one-to-one and is ALSO a CHECK on `retail_cost_quotes`, so a
blocked quote cannot be stored claiming an exact price, and a complete one
cannot be stored with an unexplained block reason.

**Expiry is not a completeness value.** A complete quote that ran out is still
complete — its costs were known. What it is not is chargeable, so expiry is a
conjunct of `checkoutEligible`, derived from the row's own deadline against the
clock. A stored "expired" state beside `expires_at` would be two representations
of one fact, and the place they must not disagree is a checkout gate.

The four worked examples from #120:

1. **Shipping is destination-dependent and not yet quotable** → an informational
   offer with a clearly qualified STARTING item cost. No final total is claimed.
2. **The supplier has an undocumented handling fee** → ineligible. Mercaria knows
   a cost exists and cannot state it, which is a different fact from "the
   supplier charges none" — so the caller states it (`undocumentedKinds`) and the
   gate refuses to guess.
3. **Tax or customs cannot be determined for a market** → that MARKET is blocked.
   Zero is never invented. The same offer into a determined market is fine.
4. **The quote expired during 3DS** → revalidate before capture. The charge
   completes at the frozen amount (the intent is never mutated after
   confirmation starts) and procurement runs against the frozen snapshot; if the
   supplier no longer honours it, that is the compensating-refund path, never a
   price change (ADR 0004 D4 concern 2).

A quote that is BLOCKED is still **recorded**, with its block reasons: an
operator asking "why is this offer dark" needs the evidence, and refusing to
write it would leave only an absence to interpret.

---

## The checkout lock

`retail_cost_quote_acceptances` — one buyer accepting one exact quote for one
checkout group.

- **`UNIQUE(checkout_group_id, quote_id)`** is the idempotency: a retry of the
  same quote returns the SAME locked total rather than re-pricing. Verified
  under CONCURRENT duplicate acceptance, not just sequential calls.
- **`lockRetailCostQuote` revalidates first**, inside the function, so a caller
  cannot lock an expired or incomplete quote by holding a stale object.
- **A revised total is a NEW quote and a NEW acceptance** naming the one it
  supersedes. That is the only representable way the charged amount changes, and
  it requires the buyer to accept again, before charge or capture. Nothing can
  mutate an acceptance: the trigger refuses UPDATE and DELETE.
- **One narrow exception**, and it is one-way: `order_id` moving from NULL to a
  value, exactly once, with every other column unchanged. The lock is taken
  BEFORE the retail order row exists (ADR 0004 D4 step 1), so freezing the
  accepted quote onto the order needs that single write and nothing else. Both
  the repository CAS (`WHERE order_id IS NULL`) and the trigger enforce it.
- **The actor is an Oxy account or a #103 guest session, never both and never
  neither** — the `referral_attributions` shape, CHECK-enforced. Neither carries
  a foreign key: Oxy owns identity, and a guest session is purged on its own
  retention clock while this record is retained.

---

## Post-checkout variance

The expected margin is always zero, so a difference between what the buyer was
charged and what the order actually cost is **cost variance**, never margin
performance.

| Actuals versus locked | Disposition | What happens |
|---|---|---|
| within the policy's tolerance | `within_rounding_tolerance` | recorded; no automatic adjustment |
| **lower** | `customer_adjustment_owed` | the surplus is the customer's — #128's adjustment/refund path. Never revenue. |
| **higher** | `mercaria_absorbed` | Mercaria absorbs it. No surcharge path exists, and none may be built. |

`deltaMinor` is recorded whatever the disposition says: the tolerance bounds
AUTOMATION, it never reclassifies a variance out of existence. Supplier rebates
known **before** checkout reduce the customer cost (they are simply a smaller
component); credits arriving **after** the sale reconcile under #128 against the
procurement side and never become hidden profit, and they never gate the
customer's own refund (ADR 0004 D8.5).

### The eight accounting outputs

`projectRetailAccountingOutputs` exposes, for #123 and #128:

`customer_receivable`, `supplier_payable`, `shipping_fulfilment_cost`,
`tax_duty_liability`, `provider_fx_cost`, `promotion_subsidy`,
`customer_adjustment_payable`, `absorbed_variance`.

That list is **complete**. There is **no `retail_margin_revenue`** and no
equivalent item-profit member, so a positive variance has nowhere to be
recognized as revenue — it can only land on `customer_adjustment_payable`. That
absence is ADR 0004 D7's zero-profit proof at the type level. A zero-valued
entry is omitted rather than emitted: a zero row in an accounting projection
reads as a fact that was measured rather than one that did not occur.

---

## Promotions

A promotion may reduce the customer amount only when the subsidy source is
explicit:

```text
cost-only amount       100 EUR
Mercaria promotion      -5 EUR
buyer pays               95 EUR
Mercaria subsidy          5 EUR
supplier/direct costs   100 EUR
```

`RetailSubsidySource` has ONE member — `mercaria_marketing_budget` — so a
supplier-funded subsidy is unrepresentable, and a `budget_ref` naming the
concrete budget is mandatory. Three CHECKs make the rest structural:

- `buyer_payable = customer_total − coalesce(subsidy, 0)` — the subsidy is the
  only thing that can separate what the order costs from what the buyer pays;
- `0 ≤ subsidy ≤ customer_total` — a NEGATIVE subsidy would be a promotion that
  raises the item price to fund itself later, which #120 forbids outright;
- every component amount is non-negative — a "negative supplier cost", the shape
  a supplier underpayment would take, has no representation.

---

## The referral and ranking boundaries

- **Referral.** A referral or ambassador reward is a prohibited price component
  and is refused by name. It is Mercaria's own acquisition expense, invisible to
  the cost formula. Structurally: `services/retail-pricing/` cannot import
  `services/referrals/` and vice versa, asserted by a static gate. Retail orders
  also emit no commission event, so referral accounting — which keys on
  commission events — is blind to them from the other side too (ADR 0004 D9.11).
- **Ranking.** Neither lower direct cost nor absorbed Mercaria variance may buy
  ranking. No feed, search or catalogue-read module may reference the retail
  pricing domain — `retail-ranking-isolation.test.ts` fails the build if one
  does, mirroring `fee-ranking-isolation.test.ts`. A ranking function that cannot
  REACH cost data cannot rank by it. In the other direction, a policy version has
  no field for sales volume, plan tier or placement, so "cost less, rank higher"
  has nowhere to live.

---

## Where the seams are

This issue builds the pricing engine and its durable records. It deliberately
stops at these lines:

| Concern | Owner | The seam #120 leaves |
|---|---|---|
| Resale authorization, compliance, market eligibility | #121 | `marketSupported` is an INPUT to the completeness gate, not a verdict this domain computes |
| Live supplier stock / shipping / quote preflight | #122 | `RetailSourceCost[]` — the caller states each cost as its source stated it |
| Native checkout and Stripe payment for retail | #123 | `lockRetailCostQuote` + `linkRetailAcceptanceToOrder`; the order's `commercial_role` / `seller_type = 'platform'` columns land with the code that writes them |
| Supplier adapters, PurchaseOrder orchestration | #124/#125 | `purchase_orders.quote_ref` already exists (#118) and names the quote |
| Procurement ledger, invoice reconciliation, variance booking | #128 | `classifyRetailCostVariance` + `projectRetailAccountingOutputs` — this domain classifies and projects, it books nothing |
| Transparent offer / checkout / order UX | #129 | `presentation` + `blockReasons` on every quote |

Nothing here creates an order, moves money, or writes a ledger entry.

---

## Testing

`services/retail-pricing/__tests__/` — the pure engine (formula, completeness,
variance, forbidden components) plus the three structural gates (fee boundary,
ranking/referral isolation, no FairCoin/OxyPay mention).
`db/retailPricing/__tests__/retailPricing.realdb.test.ts` and
`services/retail-pricing/__tests__/retail-cost-quote.service.realdb.test.ts` run
against a REAL Postgres server, because the triggers, the CHECKs, the unique
index and the concurrent claim are the properties under test and none of them
exists without one. **Do not convert those to mocks.**

FX is the one dependency mocked in the service realdb test, and only
`getRates`: the live provider makes an HTTP call, and a rate that moved between
runs would make every expected total a moving target.
