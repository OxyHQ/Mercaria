# Referral reward rules (#144)

Versioned, immutable rules that turn a verified referral conversion into an
amount Mercaria owes a partner — computed from **realized eligible Mercaria
funding** and from nothing else.

- **Binding decisions:** ADR 0005 (`docs/adr/0005-referral-program.md`), D9–D19,
  the funding boundary, the reward-base contract and R1–R8.
- **Code:** `packages/backend/src/services/referrals/rewards/` (6 modules),
  `packages/backend/src/db/referrals/{rewardRuleRepository,rewardRepository,campaignBudgetRepository,commissionBaseRepository}.ts`,
  `packages/backend/src/db/schema/referralRewards.ts` (4 tables),
  `packages/shared-types/src/referral-reward.ts`.
- **Schema decisions:** `packages/backend/src/db/schema/CONVENTIONS.md`
  §"Referral reward rules (#144)".
- **Migration:** `drizzle/0060_colorful_speed_demon.sql`, phase `pre`.

What #142 built is *who referred whom* and *what milestone happened*. This is
*what it is worth*, and the great majority of the work is making sure the answer
can never be a number Mercaria did not first earn.

---

## The funding boundary

A reward may be funded from exactly four sources.
`REFERRAL_FUNDING_SOURCE_IDS` is the closed tuple; both
`referral_reward_rules.funding_source_id` and
`referral_rewards.funding_source_id` carry a CHECK rendered from it.

| Source | Realized base | Status |
|---|---|---|
| `connected_marketplace` | The `commission_revenue` ledger postings for the payment, net of commission returned on its refunds. Never gross buyer spend. | **Live** |
| `fixed_budget` | The headroom left on an explicit `referral_campaign_budgets` row, claimed atomically per accrual. | **Live** |
| `affiliate` | RECONCILED #67 commission, through `registerAffiliateCommissionReader`. | **Live** — #67 registers `readReconciledAffiliateCommission` at boot (`services/outbound/funding.ts`), ungated |
| `subscription` | RECOGNIZED #89 revenue, through `registerSubscriptionRevenueReader`. | Defined; the port refuses until #89 registers a reader |

### The names, and the two divergences from ADR 0005

**Naming.** Issue #144 lists its adapters as `marketplace_commission`,
`affiliate_commission`, `subscription_revenue` and `fixed_acquisition_budget`,
prefixed "for example" and qualified "approved by #141". ADR 0005 — which is
what #141 decided — names them `connected_marketplace`, `affiliate`,
`subscription` and `fixed_budget`, and the #142 code already cites those
spellings in three places. The ADR's win. `connected_marketplace` is
additionally the `CommercialMode` an order already carries, so a reward's source
and the order's mode are one word rather than two that must be kept in step.

**Fact 8.** ADR 0005 fact 8 says a source id is added only together with the
code that can realize its base, "never in advance", and deferred `affiliate`
and `subscription` until #67/#89 shipped. #144 requires all four adapters and
names tests for all four, so all four ids exist here. What fact 8 actually
guards against — "a source id the database accepts but no code can produce is
a row nothing can ever reconcile" — is prevented instead by the PORT: neither
reader has a default, so a deployment that has not registered one answers
`reader_not_registered` and no reward of that source can be accrued anywhere.
`registerAffiliateCommissionReader` / `registerSubscriptionRevenueReader` were
the two one-line changes #67 and #89 owed; #67's landed
(`registerAffiliateCommissionFundingReader`, called ungated at boot) and #89's
has not, so `subscription` still answers `reader_not_registered` everywhere.

### The twelve prohibitions

`REFERRAL_FORBIDDEN_FUNDING_KINDS` names ADR 0005's eight prohibitions plus
#144's four pricing-isolation rules as VALUES, DISJOINT from the allowed set by
a test:

`mercaria_retail_margin` · `mercaria_retail_cost_variance` ·
`supplier_acquisition_cost` · `supplier_shipping_handling` ·
`customer_tax_duty` · `direct_payment_fx_cost` · `customer_refund_credit` ·
`dropship_markup` · `buyer_service_charge` · `merchant_fee_increase` ·
`item_price_increase` · `paid_ranking`

They are unrepresentable four ways, and the fourth is the only one anybody
notices:

1. **The vocabulary** — the allowed union has four members and none of them is
   one of these. Disjointness is a test with a mutation self-test.
2. **The schema** — the CHECK on both `funding_source_id` columns is rendered
   from the allowed tuple, so a forbidden value fails the WRITE, from a service,
   from a migration or from `psql`. Pinned by `referral-rewards.realdb.test.ts`
   case 13, against a real server.
3. **The registry** — `REFERRAL_FUNDING_ADAPTERS` has four entries and
   `resolveFundingAdapter` throws for anything else, so even a rule that somehow
   existed could compute no amount.
4. **The answer** — `services/referrals/rewards/forbidden-funding.ts` maps an
   attempt onto the exact prohibition and explains it, so
   `{ retailMarginShareBps: 500 }` is refused with a sentence about a
   zero-profit channel rather than with "unrecognized key". It matches SHAPES,
   ordered most-specific first, and it deliberately does NOT contain a bare
   `tax`, `duty` or `vat` pattern: normalized keys make `vat` a substring of
   `activatedAt`, and a gate that cried wolf would be disabled by whoever hit it
   next.

---

## The reward rule version

`referral_reward_rules` — one row per immutable VERSION, carrying all fourteen
fields #144 lists. `rule_id` is the stable identity (the `program_id` shape:
a grouping token, no parent entity); `UNIQUE(rule_id, version)` plus a partial
unique on `(rule_id) WHERE status = 'active'`.

| # | #144 field | Column(s) |
|---|---|---|
| 1 | Stable rule id / version | `rule_id`, `version` |
| 2 | Campaign / program scope | `program_id`, `campaign_ref` |
| 3 | Eligible conversion kind | `conversion_type` |
| 4 | Eligible funding adapter | `funding_source_id` |
| 5 | Percentage or fixed formula | `formula`, `rate_bps`, `fixed_amount_minor` |
| 6 | Currency behaviour | `currency_mode`, `reward_currency` |
| 7 | Effective start / end | `effective_start_at`, `effective_end_at` |
| 8 | Hold / vesting policy | `hold_policy_ref`, `hold_days` |
| 9 | Per-conversion / min / max caps | `min_accrual_minor`, `max_reward_per_conversion_minor` |
| 10 | Partner / campaign caps | `max_reward_per_partner_period_minor`, `partner_cap_period`, `max_reward_per_campaign_minor` |
| 11 | Refund / dispute reversal policy | `reversal_policy` |
| 12 | Terms version | `terms_version` |
| 13 | Creator / approver / audit times | `created_by_oxy_user_id`, `approved_by_oxy_user_id`, `created_at`, `activated_at`, `superseded_at`, `retired_at`, `updated_at` |
| 14 | Status | `status` (`draft` \| `active` \| `superseded` \| `retired`) |

### Immutability has three layers

- **The service.** `editRewardRuleDraft` is the only edit path and its
  statement carries `status = 'draft'` in the predicate, so an activation that
  landed while a caller was composing a patch matches nothing.
- **The database.** `referral_reward_rules_immutable_once_active` refuses every
  column change on a non-draft row and refuses DELETE outright — the
  `fee_schedules` device. That is what holds against a migration, a repair
  script and `psql`, none of which go through the service.
- **The pin.** An attribution records `<ruleId>@v<version>` when it is created
  (ADR 0005 D19), so even a rule whose ACTIVE version changes cannot move an
  existing reward: the accrual resolves the version it was promised, which by
  then is `superseded` and still readable. `superseded` accrues normally — only
  RETIREMENT stops new accruals, and it is prospective.

Activation additionally requires four eyes (`approved_by <> created_by`, in the
service): a rule version decides what Mercaria pays, and one person able to both
write and activate it is one person able to set the rate.

### The currency rules, which are two CHECKs

`reward_currency` is present exactly when `currency_mode = 'fixed_currency'`.
And ANY amount-valued term — a fixed amount, a minimum, any cap — requires one,
because an amount with no currency cannot be compared against a base whose
currency varies.

**This domain performs no conversion at all.** A `fixed_currency` rule REFUSES
funding realized in another currency (`funding_currency_mismatch`) rather than
converting it: an FX rate moving between accrual and vesting would change an
amount ADR 0005 D19 fixes at attribution. A scanned gate fails the build if any
module here imports `fx.service`.

---

## Calculation

The pipeline, and the order matters:

1. **Idempotency first.** An existing reward for the conversion is RETURNED
   before anything else — before the base is re-read, before a budget is
   touched. A retry that re-realized the base would answer differently the
   moment a refund had landed in between, which is the opposite of "an
   idempotent conversion retry produces the same reward". Case 11 moves the
   world between two calls and asserts the answer does not.
2. **The pinned rule version**, parsed off `referral_attributions.rule_version_ref`.
   A ref that names no exact version (a pre-#144 attribution carrying the
   program's bare `commission_rule_ref`) is refused with
   `no_pinned_rule_version` — resolving "whichever version is active now" is
   what D19 forbids.
3. **The funding adapter**, which is the ONLY base computation in the domain.
   `RealizeFundingInput` carries a record ref and a handle, and has no order,
   cart, basket or fee-snapshot member — "a rule must never compute a percentage
   of gross basket value" is a property of the call graph. It carries no "as of"
   instant, deliberately: a charge's `commission_revenue` postings are written
   by the payment OUTBOX, strictly after the payment-success instant an accrual
   would pass, so bounding the ledger read there would make every accrual read
   zero — and the budget adapter has nothing temporal to bound at all. Every
   adapter reads the record's state NOW, which is what all three callers want.
   #67/#89 add a temporal parameter WITH the code that honours one.
4. **The formula.** `percentageOfRealizedBase` is the only rounding in the
   domain: **half to even**, computed in `bigint`, `assertSafeMoneyAmount` on the
   way out. Half-even rather than half-up because a reward is a small percentage
   of many bases and half-up transfers every exact tie the same way; it is also
   what `pricing.service` and the retail FX conversion already use.
5. **The ceilings**, every one of which can only LOWER: the realized funding
   itself, the per-conversion cap, the per-partner period headroom, the campaign
   headroom. A FIXED amount is refused rather than clamped — half a bounty is a
   different promise, not a smaller one.
6. **The de-minimis threshold.** A rule's minimum is a THRESHOLD below which
   nothing accrues, never a top-up: ADR 0005 D10 refuses a "percentage with a
   floor", because a floor above the realized base is money from nowhere. There
   is no function in `amount.ts` that raises an amount.
7. **The budget claim**, one conditional `UPDATE` whose empty `RETURNING` set IS
   the refusal.
8. **The row**, `ON CONFLICT DO NOTHING` on `UNIQUE(conversion_id)`.

### All three bounds hold under concurrency, by two different mechanisms

"Never pay more than the eligible funding/budget or configured cap" (#144
acceptance 7) is three separate bounds, and each needed its own answer. This
backend runs at Postgres's default READ COMMITTED — there is no isolation-level
override anywhere in it or in `@oxyhq/db` — so none of them is safe by
inheritance.

| Bound | Mechanism | Why not the other one |
|---|---|---|
| Campaign **budget** | An atomic compare-and-swap: `set claimed_minor = claimed_minor + $n where budget_minor - claimed_minor >= $n and status = 'open'`, empty `RETURNING` ⇒ refused. | A budget IS a row, so a row-level CAS says the whole thing. |
| Per-partner **period cap** | `pg_advisory_xact_lock` on `(partner, currency)`, taken before the sum and held to commit. | A cap is a property of a SET. A `FOR UPDATE` on the summed rows locks the wrong thing — the row that would need locking is the one that does not exist yet, and Postgres takes no predicate locks below SERIALIZABLE. A running-total row per (partner, period) would be a second representation of a fact the rewards already carry, could not express a `lifetime` cap, and would orphan its buckets when a rule changed its period. |
| Per-campaign **cap** | The same, on `(campaign, currency)`. | It spans PARTNERS, so the partner key cannot serialize it. |

Both locks are taken in ONE place (`lockAccrualCapWindows`) in a fixed
partner-then-campaign order, so two accruals that each need both cannot
deadlock; the budget CAS runs strictly after them, fixing the order across all
three. An uncapped rule takes neither lock, so an ordinary accrual serializes
against nothing. Both refuse the root connection through `requireTransaction` —
a transaction-scoped lock taken outside a transaction is released the instant
the implicit transaction commits, which serializes nothing and looks exactly
like a lock that worked.

The realdb suite runs both races six times per run against a real server, with a
fresh partner and a fresh campaign per iteration, and asserts BOTH that the
total never exceeds the cap and that the loser recorded `cap_reached` — a cap
that "held" by paying two half-size rewards would satisfy the sum and still be
wrong. The lock is mutation-tested: disabling `lockAccrualCapWindows` pays 2 000
against a cap of 1 000 on the first iteration of both races.

Every refusal appends a `reward_accrual_refused` audit row naming one of
fourteen reasons and returns; it does NOT reject the conversion. A conversion is
a verified milestone that genuinely happened, and refusing to pay for it does
not unmake it (ADR 0005 D16: an effect that did not happen must be
distinguishable from one that silently vanished).

### Why the commission grain is the PAYMENT

`commission_revenue` is the RESIDUAL of a whole charge — gross minus the sum of
the sellers' nets — booked once per `charge_succeeded` with no `order_id` on the
entry. Splitting it per order would be a SECOND derivation of commission, which
is exactly what "the ledger is the only home" exists to prevent. So a
`connected_marketplace` base is the commission Mercaria realized on the
CHECKOUT, which is also the honest reading of ADR 0005 D11's "the referred
buyer's first qualifying order": their first purchase is the checkout, not one
seller's slice of it. A payment carrying commission in two currencies is
REFUSED, never summed.

The funding "version" is the id of the last contributing ledger transaction,
ordered by `(created_at, id)` and never by the key alone —
`@oxyhq/db`'s uuid v7 is not monotonic within a millisecond.

---

## Reversals

`referral_reward_adjustments`, append-only against UPDATE and DELETE both, keyed
on the deterministic `refrewrev:<rewardId>:<cause>:<sourceRef>`. A refund
handler retried, a dispute webhook redelivered and a reconciliation sweep
re-deriving the same fact all converge on the row they already made, and a
replay writes NOTHING — not even the same net back, because that would move
`updated_at` and make a genuine no-op indistinguishable from a second reversal.

| Cause | Outcome under `proportional_to_realized_base` | under `void_on_funding_reversal` | under `fraud_only` |
|---|---|---|---|
| `order_partially_refunded` | recompute from the base as it now stands | void | **skipped** |
| `order_fully_refunded` | void | void | **skipped** |
| `dispute_lost` | void (ADR 0005 R3) | void | **skipped** |
| `affiliate_commission_reversed` | recompute (R4) | void | **skipped** |
| `subscription_revenue_reversed` | recompute (R5) | void | **skipped** |
| `fraud_invalidation` | void (R6/R8) | void | void |
| `invalid_budget_allocation` | void | void | void |

"Skipped" writes nothing at all, deliberately: a budgeted bounty was never
funded by the order that was refunded, so an adjustment row against it would
record a relationship that does not exist (ADR 0005 R6). It is also structurally
unreachable, because a bounty's funding record is the BUDGET and a refund names
a payment — both, so that removing either leaves the other.

The recomputed net is monotone downward three ways: never above the recomputed
figure, never above the base it draws on, never above what the reward already
stood at. Each net is `f(base)` computed afresh rather than an accumulated
subtraction, which is what makes `Σ deltas + gross == net` an identity.

### The #145 seam — CLOSED

`docs/referral-earnings.md` is the earnings ledger, and what it consumed from
here was the four bullets below, unchanged. What DID change in #144's own code
is two lines: `accrueRewardForConversion` and `reverseRewardIn` now call
`services/referrals/earnings/posting.service.ts` inside their existing
transaction, so the reward row and the money it represents commit together and
cannot disagree by construction. The three unwritten states below have writers
now; `frozen` is #145's freeze, `vested` its sweep, `paid` its payout batch.

- A reward already **paid** is never un-paid (ADR 0005 R7). Its state stays
  `paid` and its `paid_at` is untouched; the shortfall is recorded as
  `recovery_state = 'partner_liability'` with `liability_amount_minor`, and #145
  carries it as a NEGATIVE `referral_payable` balance that future accruals offset
  first. #144 still holds no balance and moves no money itself.
- An unpaid reward's reversal is `offset_against_balance`; a zero-delta one is
  `not_applicable` and is still WRITTEN, because "we looked and nothing had
  moved" is a different fact from "nobody looked".
- A voided `fixed_budget` reward RELEASES its claim back to the campaign
  (ADR 0005 R6), after the adjustment, so a replay — which writes nothing —
  cannot release twice.
- `referral_rewards.state` carries ADR 0005's whole machine
  (`held | vested | frozen | paid | voided`). #144 writes two of them; `vested`,
  `frozen` and `paid` are #145's and #148's, declared here so those land as
  writers of an existing column rather than as a breaking widen.

---

## Pricing, fee and ranking isolation

#144's seven isolation rules are one sentence from different sides: referral
attribution changes no buyer price, no merchant fee, no retail cost, no #128
adjustment and no organic ranking. They are enforced as an IMPORT GRAPH, in
`services/referrals/rewards/__tests__/reward-funding-isolation.test.ts` — every
wall scanned over a real file set, with an anti-vacuity floor and a mutation
self-test per wall.

| Rule | Wall |
|---|---|
| Do not increase the #88 fee (I3) | No module in the referral domain imports `services/fees`, `db/fees` or `schema/fees` |
| Do not change an item price (I2) | No import of `pricing.service` |
| Do not add a buyer service charge (I2) | Same, plus the forbidden-funding vocabulary |
| Do not add retail markup (I4) | No import of `services/retail-pricing` or `db/retailPricing` |
| Do not consume a #128 variance (I5) | No import of `retail-checkout`, `supplier-*` or their schemas |
| Do not alter organic ranking (I1) | No import of `services/ranking`, `services/search` or a feed — and the reverse wall already exists in `offer-ranking-isolation.test.ts` |
| No discount, cart or checkout write | No import of `discount.service`, `services/checkout` or `catalog-write` |

Two more walls beside them: no `fx.service`, and no OxyPay/FairCoin spelling
anywhere (raw source, comments included).

**The payment exceptions are named, and — since #145's earnings ledger — there
are THREE, not one.** `db/referrals/commissionBaseRepository.ts` reads the
ledger read-only (two columns; ADR 0001 D3 puts Mercaria's commission nowhere
else); `db/referralEarnings/partnerBalanceRepository.ts` derives a partner's
balance from `ledger_entries` and nothing else; `services/referrals/earnings/posting.service.ts`
is the domain's ONE ledger WRITER, everything else reaching the ledger through
it. The gate asserts the payment-wall importer list is EXACTLY those three
files, scanning VALUE imports only — a `import type` naming a ledger shape
(e.g. `LedgerEntryInput`) is erased at compile time and cannot move money, so
excluding it is real narrowing rather than a hole (mutation-tested: a VALUE
import of the same module still fires). Widening the exemption is a visible
edit to the gate.

`referral-rewards.realdb.test.ts` cases 14 and 15 close the same rules from the
other end, against a real server: a retail bounty is accrued against a real
`mercaria_retail` order and the order row AND its fee snapshot are asserted
byte-identical **including `xmin`**, so a write that happened to land on the same
values would still fail. The fee snapshot is additionally append-only by
trigger, which the same test drives.

---

## What #144 does NOT build

Each is a named contract that fails closed, not a stub that lies.

- **#145 (earnings ledger, payout balances) — LANDED.** See
  `docs/referral-earnings.md`. It added the two ledger accounts, the posting
  table, the vesting sweep, payout batches and the reconciliation sweep ADR 0005
  requires, and it made the two functions above BOOK. The isolation gate's ledger
  exemption grew from one file to three in the same change, as an exact set.
- **#146 (payout).** `hold_policy_ref` is a reference this domain never
  resolves.
- **#147 (dashboards).** There is no HTTP surface for reward rules at all. The
  `.strict()` schema lives beside its only consumer
  (`services/referrals/rewards/rule-schema.ts`) and runs on every draft, so the
  write chokepoint is validated whether the caller is a route, a seed script or
  a test. `ReferralRewardPartnerView` is the ADR 0005 A5 allow-list a partner
  surface will serve.
- **#148 (fraud controls).** `fraud_invalidation` is a reversal cause this
  domain applies when it is TOLD; nothing here decides that a conversion was
  fraudulent, and no velocity, signal or score exists in the domain.
- **#128 (retail cost variance).** Referenced only as a prohibition. The retail
  prohibition is expressed in terms of this domain's own funding union, so it
  needs no #128 symbol and cannot be weakened by one.
- **#89.** Its adapter exists and its port refuses; #67's own port is
  registered (see the funding-boundary table above).

## Production-readiness checklist

1. Publish at least one `active` reward rule version per program before any
   attribution is created — an attribution made while a rule has no active
   version pins the bare ref and every accrual under it is refused with
   `no_pinned_rule_version`. The refusal is recorded, so the gap is visible, but
   it is a lost reward rather than a deferred one.
2. Create the `referral_campaign_budgets` row before activating a
   `fixed_budget` rule; the accrual refuses `funding_source_unavailable`
   otherwise.
3. #145 shipped the reconciliation sweep ADR 0005 requires; turn
   `REFERRAL_RECONCILIATION_ENABLED` on before the rail carries live money. The
   reward's net and the ledger's `referral_payable` cannot disagree by
   construction, and a sweep nobody runs is the discrepancy nobody notices.
4. Nothing in #144 runs on a loop, so there is no flag to set and no dispatcher
   to enable. `REFERRALS_ENABLED` continues to gate #142's surfaces.
