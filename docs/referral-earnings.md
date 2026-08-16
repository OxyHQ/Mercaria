# The referral earnings ledger (#145)

Holds, vesting, reversals, payout batches and the reconciliation sweep — the
money side of the referral program, booked in Mercaria's own ledger.

- **Binding decisions:** ADR 0005 (`docs/adr/0005-referral-program.md`) —
  "Ledger representability", D12–D15, D18 and R1–R8.
- **Code:** `packages/backend/src/services/referrals/earnings/` (10 modules),
  `packages/backend/src/db/referralEarnings/` (4 repositories),
  `packages/backend/src/db/schema/referralEarnings.ts` (5 tables),
  `packages/shared-types/src/referral-earnings.ts`.
- **Schema decisions:** `packages/backend/src/db/schema/CONVENTIONS.md`
  §"The referral earnings ledger (#145)".
- **Migration:** `drizzle/0081_faithful_misty_knight.sql`, phase `pre`.

#144 decided what a conversion is WORTH. This is what that worth costs
Mercaria, where it sits until it can be paid, how it is paid, and what happens
when the money it was drawn from goes away.

---

## One ledger, two accounts, four transaction kinds

Referral money books in the **same** `ledger_transactions`/`ledger_entries`
through the **same** single writer (`insertLedgerTransaction`), under the same
three-layer balance enforcement and the same sign convention: positive is a
debit, negative a credit, zero per currency.

| Account | Normal balance | What it holds |
|---|---|---|
| `referral_expense` | debit | the cost of the program — commission shared and bounties granted |
| `referral_payable` | credit | what Mercaria owes a partner, per partner; **may go negative** after R7 |

| Event | Debit | Credit | Kind |
|---|---|---|---|
| Reward accrued (W) | `referral_expense` (W) | `referral_payable` (W) | `referral_reward_accrued` |
| Reversal — partial (d), void (W′) or clawback (C) | `referral_payable` | `referral_expense` | `referral_reward_reversed` |
| Payout batch settled (P) | `referral_payable` (P) | `provider_clearing` (P) | `referral_payout` |
| Recovery received (V) | `provider_clearing` (V) | `referral_payable` (V) | `referral_recovery` |

ADR 0005's table has six rows and three of them are the identical posting. They
are ONE kind, because the two facts that distinguish them —
`referral_reward_adjustments.delta_amount_minor` and `.recovery_state` — are
already recorded once, and a second kind would be a second representation of
them that could disagree.

`referral_payout` and `referral_recovery` name a PARTNER and no payment, order,
refund or dispute, so every correlation column on the transaction is NULL and
the `referral_ledger_postings` row is what points back — the
`subscription_invoice_paid` shape.

### `referral_partner` is a FOURTH ledger owner type

A `referral_partners` row is already identified by a `(owner_type, owner_id)`
pair that is `store` or `user`, so reusing it would file a partner's referral
earnings under the SAME key a seller's sales payable uses and make one owner key
mean two unrelated economic relationships. That is exactly the argument #128
used to add `supplier`. The id carried is the `referral_partners.id`, which is
what a payout pays and what a balance is derived over.

---

## The funding invariant, restated over ACCOUNTS

#144 states it over SOURCES — what a rule may compute a base from. #145 restates
it where money would actually be taken from the wrong place.

`REFERRAL_LEDGER_ACCOUNTS` (3) and `REFERRAL_FORBIDDEN_LEDGER_ACCOUNTS` (12) are
DISJOINT and **their union is exactly `LEDGER_ACCOUNTS`**. Both are asserted, so
a sixteenth account added to Mercaria's chart fails the build until somebody
decides which side of the referral boundary it is on — the
`merge-plan-census.test.ts` device applied to money, and the reason it is an
exact partition rather than a containment is that finding fewer accounts looks
identical to there BEING fewer.

Four independent mechanisms, and the fourth is the only one anybody notices:

1. **The vocabulary** — the partition above.
2. **The signature** — no posting builder in `ledger-postings.ts` takes an
   account. A retail cost account is unrepresentable at the call site rather
   than refused.
3. **The scan** — `referral-earnings-isolation.test.ts` fails the build if any
   module in the domain names a forbidden account, imports the retail,
   procurement, fee, pricing or ranking domain, reaches FX, or imports a payment
   rail client. Every wall has an anti-vacuity floor and a mutation self-test.
4. **The answer** — `assertReferralPosting` walks a REAL entry set at the one
   place it is written and names the exact prohibition, so a refusal is a
   sentence about a zero-profit channel rather than "unrecognized account".

`commission_revenue` is on the forbidden side and that one is worth reading: a
`connected_marketplace` reward is FUNDED from realized commission and does not
REDUCE it. The commission stays recognized where ADR 0001 D3 put it and the
referral cost is a separate expense against it — booking the reward as a
commission reduction would make the one figure that exists nowhere else stop
meaning what it means.

### Zero-profit retail protection

`retail_cost_recovery`, `procurement_expense`, `customer_adjustment` and
`supplier_prepaid` are all on the forbidden side, so a `mercaria_retail` order's
supplier cost, basket value, cost variance and customer adjustment are
unreachable. A fixed acquisition bounty is funded from `fixed_budget` and books
against `referral_expense` — a Mercaria marketing expense, discharged out of
`provider_clearing` when it is paid, touching no retail account and no buyer
amount in any code path.

There is **no surcharge path anywhere in this domain and none may be built**: a
failed or over-budget marketing allocation refuses the ACCRUAL (#144's
`budget_exhausted`) and books nothing at all. `referral-earnings.realdb.test.ts`
case 10 pins the other half against a REAL `mercaria_retail` order — the order
row and its fee snapshot are asserted byte-identical INCLUDING `xmin`, so a
write that happened to land on the same values would still fail.

---

## The lifecycle, and the three states #145 names that are not states

`ReferralRewardState` stays ADR 0005's machine: `held | vested | frozen | paid |
voided`. #145's issue lists `pending | held | vested | payable | paid |
reversed | voided` ("such as"); the three extras are NOT added, and
`REFERRAL_REWARD_STATE_ELSEWHERE` names each one and where its fact lives — data
rather than an omission a later reader has to reconstruct, gated as disjoint
from the machine.

| Named | Where it actually lives |
|---|---|
| `pending` | a reward that has not accrued has no ROW. `referral_conversions.state` already carries `pending`. |
| `payable` | DERIVED by `deriveRewardPayability` from the partner's live readiness triple, their state, the program's payout lever and the reward's own state — none of which the reward row owns. A stored verdict goes stale the instant a rail restricts an account (the `deriveNativeCheckoutEligibility` divergence). |
| `reversed` | the append-only `referral_reward_adjustments` trail. A partial reversal leaves the state alone; a full one is `voided`; and a reward already PAID stays `paid` forever (R7), so a `reversed` state would contradict R7 on exactly the rows that matter most. |

Every state change is a compare-and-swap plus an append-only
`referral_reward_transitions` row, in one transaction. The transition's key is
`refrewst:<rewardId>:<cause>:<sourceRef>`, so a sweep that runs twice in a minute
writes ONE row — and if the CAS lost, nothing is appended at all, which keeps the
trail a record of what happened rather than of what was attempted.

**A freeze stops the hold clock** (D12), which is a column move: lifting one
pushes `hold_until_at` forward by exactly the frozen duration. #144's reward
trigger pinned that column outright and #145 WIDENED it by `CREATE OR REPLACE`
(#106's device) to permit a FORWARD move only — the backwards direction is what
would vest a reward early, which is what the pin was protecting.

---

## Payout batches

`referral_payout_batches` carries every field #145's "Payout batches" section
names; `referral_payout_batch_items` is which rewards it settles.

- **One OPEN batch per partner per currency**, a partial unique. Without it the
  builder would read what is claimed and then insert, which under READ COMMITTED
  is the read-then-write both racers win.
- **One LIVE claim per reward, ever** — `(reward_id) WHERE released_at IS NULL`.
  A duplicate payout is unrepresentable rather than unlikely.
- **`failed` keeps its claims**; `cancelled` is the terminal operator decision
  and is the ONLY status that releases them. Releasing on failure would let the
  retry and the next batch both carry one reward. The retry rides the batch's
  own `refpay:<batchId>` key, byte-identical across attempts (ADR 0001 D11's
  rule) — and the LOOP retries only the reasons a retry could fix
  (`REFERRAL_RETRYABLE_PAYOUT_FAILURES`: `rail_not_configured`,
  `rail_unavailable`). The rest are terminal by NATURE rather than by attempt
  count — `amount_no_longer_payable` and `withholding_not_supported` describe
  the batch itself, `beneficiary_not_payable` and `rail_rejected` describe a
  partner's rail standing Mercaria does not change — so retrying them would spin
  a loop against a condition no attempt can move (#262's `permission_denied`
  split, one domain over). They stay visible, keep their claims, and wait for a
  person.
- **A batch that no longer describes what is owed FAILS rather than shrinking**
  (`amount_no_longer_payable`). #59's ruling — "the set an operator approved is
  the set that executes" — so paying €95 against an approval for €120 is an
  amount nobody signed. The remedy is one operator call: cancel, then rebuild.
- **Four eyes**, expressed so it cannot be trivially satisfied: the loop opens a
  batch as the literal `system`, a person opening one names themselves, and
  `approved_by <> created_by` is therefore automatic for the first and real for
  the second.
- **The rail is called OUTSIDE any transaction**, between a CAS that claims the
  batch (`approved → processing`) and a CAS that records the outcome. Holding a
  row lock across a provider call makes the lock's duration a function of
  somebody else's availability (#109's ruling).

### The D15 gates

`deriveRewardPayability` is pure and reads only `PayoutGateFacts`, which has no
order, payment, buyer, retail cost or funding member — the
`SourcingCandidateFacts` device. Every gate WITHHOLDS and none destroys
anything: D15's "a partner failing a gate is skipped, not voided".

An **UNKNOWN readiness blocks**, which inverts the
`SELLER_TRUST_RESTRICTED_TIERS` rule on purpose: an absent trust signal
withholds nothing because restricting on absence turns an outage into a
delisting, but an absent KYC verdict is Mercaria not knowing whether it is
allowed to send somebody money.

The **minimum is a code constant** (`REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY`,
EUR 25.00 per D14), not an environment variable, for the #126 terms reason: it
is a published policy partners were recruited under. It is PARTIAL, and a
currency with no published minimum is blocked with
`payout_minimum_not_published` rather than defaulted to zero — a defaulted
minimum is a policy nobody signed. D14's own exception (a final payout ignores
the minimum) is a PARAMETER rather than a branch somewhere, because whether a
payout is final is a decision only a person makes.

### Withholding is MODELLED and UNSETTLEABLE

#145 field 6 is a real column and an operator may set one. Settlement then
refuses `withholding_not_supported`, because there is no ledger account for
withheld money to sit in and inventing a `tax_withheld` account would put a
remittance obligation in a book nobody reconciles against a tax authority.
#141/#146 own the compliance decision; this is the honest shape of waiting for
it.

---

## The reconciliation sweep

ADR 0005 makes it a gate on this issue: the reward's net and the ledger's
`referral_payable` are two stores that must agree.

They cannot disagree by construction — every posting commits in the same
transaction as the fact it books — and the sweep exists anyway, for the reason
`findGlobalLedgerImbalances` gives about an equally impossible global imbalance:
"structurally impossible" and "nobody has ever checked" are indistinguishable
from outside the code.

Six probes, seven discrepancy kinds, and it **DETECTS and never repairs**. The
two that look mechanical are the ones where an automatic repair would be worst:
booking a missing posting would move money nobody authorised, and un-paying a
`paid` batch would rewrite a payout R7 says is never rewritten.

`referral_earning_discrepancies` dedupes on `refdisc:<kind>:<subject>:<currency>`
and the upsert carries `setWhere: status <> 'resolved'` — without that predicate
a sweep re-observing a finding an operator has already answered REOPENS it,
which is exactly the failure `payment_discrepancies` hit in this repository's own
shared test database.

---

## The operator surface

`/internal/referrals/*`, on the SAME `REFERRAL_OPERATOR_OXY_USER_IDS` allow-list
#143 uses — not an eighth. Approving a payout and pausing attribution are the
same economy, and splitting them would put one half of a partner's fate behind a
list the other half's operator is not on.

The route set is CLOSED. There is no "mark this reward paid", no "void this
reward", no "book this entry", no "edit this posting", no "set this batch's
total" and no delete. Every write DRIVES an existing idempotent path a machine
already takes:

| Route | What it drives |
|---|---|
| `GET /partners/:id/earnings?programId=` | the whole trace: partner → attribution → conversion → rule → funding → reward entries → hold/vesting → reversal → payout batch → provider payout |
| `GET /partners/:id/balances?programId=` | the DERIVED balances, per currency |
| `POST /partners/:id/payout-batches` | build a batch by hand |
| `POST /payout-batches/:id/{approve,settle,cancel}` | the three steps of one capability; `settle` is the loop's own function |
| `POST /partners/:id/{freeze,unfreeze}` | D18/R8's freeze, which withholds and never destroys |
| `POST /partners/:id/recoveries` | R7's recovery — money that ARRIVED, recorded rather than decided |
| `GET /earnings/discrepancies` + `POST .../resolve` | a note about a finding, never a change to what it measured |
| `POST /earnings/{reconcile,vest}` | one page of each sweep |

**Voiding stays #144's `reverseReward` with a fraud cause and has no route**,
because deciding that a conversion was fraudulent is #148's and a route here
would be a way around that.

The trace opens from a PARTNER id and carries no buyer-shaped field at any
depth. The realdb suite walks a genuinely emitted trace and asserts the absence
of an email, phone, address, card, guest session, buyer id or token — the #92
two-gate rule, a scanned gate plus a runtime walk.

---

## Environment

Three loop levers, and **not one gates a durable record**:

```
REFERRAL_VESTING_ENABLED=false            # the hold -> vested sweep
REFERRAL_VESTING_BATCH_SIZE=200
REFERRAL_VESTING_POLL_INTERVAL_MS=300000
REFERRAL_PAYOUT_BATCHES_ENABLED=false     # the build-and-settle loop
REFERRAL_PAYOUT_BATCH_SIZE=25
REFERRAL_PAYOUT_POLL_INTERVAL_MS=900000
REFERRAL_PAYOUT_RETRY_BACKOFF_MS=900000
REFERRAL_RECONCILIATION_ENABLED=false     # the sweep ADR 0005 gates #145 on
REFERRAL_RECONCILIATION_BATCH_SIZE=25
REFERRAL_RECONCILIATION_POLL_INTERVAL_MS=3600000
```

Each defaults FALSE because the referral program itself is not live: a vesting
sweep on a deployment with no partners is a timer doing nothing, and an incident
lever that ships ON is one nobody notices is armed. The accrual books its ledger
posting inside #144's own transaction with no flag in the path, holds keep
elapsing whatever these say, and turning any of them back on drains whatever
accumulated.

The fourth lever is a ROW rather than a variable:
`referral_program_controls.payout_enabled`, joined to #143's redirect and
attribution pair so an incident sets the whole switchboard in one attributable
act. It is ADR 0005 D18's "program suspension stops new vesting/payout where
policy says so but preserves history" — and deliberately NOT what program
TERMINATION uses, since D18 says a terminated program's existing rewards run
their ordinary lifecycle to payout.

---

## Seams, each a named contract that fails closed

- **#146 — the payout RAIL — is CLOSED.** `services/referral-payouts/` registers
  a Stripe Connect transfer into `payout-rail.port.ts` at boot, plus the
  readiness reader that answers ADR 0005 D15 gate 1 from #46's
  `provider_accounts`. The join sits OUTSIDE both walled domains, because
  `reward-funding-isolation.test.ts` forbids this domain from reaching
  `services/payments/` and satisfying the join by importing across that wall
  would widen it to admit the reverse edge. A batch that failed
  `rail_not_configured` while the registry was empty settles on its next pass,
  on its own idempotency key, with no replay.
- **Withholding is SETTLED, and the answer is that Mercaria withholds nothing.**
  ADR 0005 D15: Mercaria issues an annual earnings statement per partner and
  partners are responsible for their own income tax. No withholding means no
  remittance obligation, so no `tax_withheld` account exists or may be added;
  `withholding_not_supported` is a permanent refusal rather than a wait. DAC7 is
  ADR 0005 open item 1 and would change what the TAX QUESTIONNAIRE (#146)
  collects, never what the ledger holds.
- **#148 — fraud.** Nothing here decides that a conversion was fraudulent. The
  freeze paths exist and are operator-driven; #148 automates the DETECTION that
  should drive them, and the VOID stays #144's.
- **#147 — the partner dashboards.** `ReferralPayoutBatchPartnerView` is ADR
  0005 A5's allow-list extended to the batch (a day-granularity date, a status,
  two amounts, a currency and a count) and nothing consumes it yet.
- **`vested_reward_past_payout_horizon`** is a declared discrepancy kind with no
  producer: the horizon is a policy #146 sets with the rail, and a sweep that
  invented one would report a breach against a number nobody published.

## Production-readiness checklist

1. Populate `REFERRAL_OPERATOR_OXY_USER_IDS` before any partner earns: with it
   empty `/internal/referrals` is not mounted at all, which also means nobody
   can approve, settle, cancel, freeze or trace anything.
2. Set `STRIPE_ENABLED` and onboard each partner to a payment-ready connected
   account. The rail is registered (#146), but with Stripe off every partner's
   identity and payout readiness derives as `unknown`, which BLOCKS — and a
   partner with no `provider_accounts` row has no beneficiary to pay.
3. Publish a payout minimum for every currency partners can earn in.
   `REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY` carries EUR only, and a currency
   without one blocks every batch.
4. Turn `REFERRAL_RECONCILIATION_ENABLED` on before the rail carries live money.
   ADR 0005 requires the sweep, and a sweep nobody runs is the discrepancy
   nobody notices.
5. Have each partner complete the tax questionnaire (#146, D15 gate 2). Until
   they do, tax readiness is `pending` and the batch blocks. Withholding needs no
   decision — Mercaria withholds nothing and a batch carrying one is refused.
