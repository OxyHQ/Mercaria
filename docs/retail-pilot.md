# The bounded retail pilot (#125)

`services/retail-pilot/` + `db/retailPilot/` + `db/schema/retailPilot.ts`
(5 tables) + `/internal/retail-pilot/*`. Schema decisions:
`packages/backend/src/db/schema/CONVENTIONS.md` §"The bounded retail pilot".
Binding architecture: [ADR 0004](./adr/0004-mercaria-retail-dropship.md); the
provider is [Printful](./suppliers/printful.md), selected by #119.

#121 answers whether Mercaria may lawfully sell an item, #120 what it costs,
#122 what the supplier says right now, #123 how the buyer pays and #124 how the
supplier order is placed. **None of them asks how much of this Mercaria is
willing to do at all, today** — and a deployment where all five answer "yes" is
exactly the state this domain exists to bound.

The failure mode it is shaped around is not a bug. It is a pilot that succeeded
technically and expanded by default. #125 says it outright — *"no automatic
expansion follows from technical success"* — so every bound here is a stored,
versioned, immutable-once-active fact with a person's name on it, and there is
deliberately no code path that widens one.

## Why a versioned cohort and not environment variables

Every bound could have been a `RETAIL_PILOT_*` variable. Three reasons it is
not, in the order they bite:

1. **A bound has to be attributable.** "Why was the order ceiling €150" is a
   question with an answer — a person, a date, a written rationale — and an
   environment variable has none of those. `published_by_oxy_user_id` is NOT
   NULL on an active row, by CHECK.
2. **A bound has to survive a deploy.** A variable changes when somebody edits
   a task definition, which is not an event anybody reviews. A cohort version
   is frozen once active by trigger, and a change is a NEW version — so the
   bounds a pilot RAN UNDER stay readable after it is widened. That is
   acceptance 8's measured review made structural instead of aspirational.
3. **A SKU allow-list is a table.** Twenty-five SKUs in a comma-separated
   variable is a list nobody can review, nobody can attribute a line of, and
   which silently admits everything on a typo.

The one thing that IS a variable is `MERCARIA_RETAIL_ENABLED` (#123), and it
stays one: a kill switch has to be flippable without a migration.

## The rules that are load-bearing

- **No active cohort ⇒ every retail line is refused** (`no_active_cohort`).
  That is why this domain has no kill switch of its own: an empty pilot IS the
  off position, and a deployment that has published no bounds sells nothing.
  There is no `admitted` path that does not name a cohort version.
- **A stop pauses ENTRY and nothing else**, and it is a property of the CALL
  GRAPH rather than a rule in a handler. `evaluateRetailPilotAdmission` is
  called from `planRetailCheckout` and from nowhere else, so a live stop refuses
  new retail checkouts while every placed purchase order keeps being submitted,
  polled, cancelled, refunded and reconciled — a buyer who has paid is owed
  their goods whatever Mercaria has decided about taking more orders. There is
  no scope value that could pause fulfilment, because fulfilment never asks, and
  `retail-pilot-isolation.test.ts` fails the build if a procurement, refund or
  payment module starts calling it.
- **The gate runs LAST, after the locks, and that costs something.** The value
  ceilings bound the amount a buyer would be charged, and that amount does not
  exist until #120 has composed and locked it. Every earlier position would need
  a second partial copy of the same rule or a third "provisional" verdict, and
  a bound with a soft state is not a bound. The cost is real: a retail line
  outside the pilot has already spent one supplier preflight when it is refused.
  Acceptable, because a retail line exists only where an operator created a
  `retail_offer_bindings` row (#123) — so "a retail line the pilot does not
  admit" is a configuration mismatch rather than ordinary traffic — and because
  nothing has been charged, reserved or ordered at that point.
- **The buyer's refusal names none of the thirteen reasons.** ONE code reaches
  the client (#123's `retail_line_ineligible`); the vocabulary reaches the log
  an operator traces from. Distinguishing them would let somebody vary one input
  at a time and read out the pilot's SKU list, its value ceiling and its
  supplier's cash position.
- **Absent funding refuses.** This inverts the `SELLER_TRUST_RESTRICTED_TIERS`
  rule deliberately, and the difference is worth stating: an absent TRUST signal
  withholds nothing, because restricting on absence turns an outage into a
  marketplace-wide delisting; an absent BALANCE is Mercaria not knowing whether
  it can pay, and charging a customer for goods it may not be able to buy is the
  failure ADR 0004 D6's prefunded model exists to prevent. A balance in another
  currency refuses too — it is not a smaller balance, it is an uncomparable one,
  and this domain does no FX.
- **The floor is compared against the balance MINUS this order's draw.** A
  balance exactly at the floor does not stay there once the order is procured,
  and a check that ignored the draw would admit exactly the order that empties
  the wallet.
- **A funding OBSERVATION, never a balance.** `supplier_funding_observations` is
  append-only against UPDATE and DELETE, and every row names its source and its
  instant. There is deliberately no mutable `supplier_accounts.balance` beside
  it: a single figure is one stale write away from admitting a checkout against
  money that is not there. Staleness is bounded per cohort, because Printful
  publishes no balance endpoint and the freshest figure available is one an
  operator typed in (`operator_entry` is its own source precisely so it cannot
  be mistaken for one the provider asserted).
- **No payment credential is stored, anywhere.** A top-up is a treasury act in
  the provider's own dashboard under D6.5 dual control; what Mercaria records is
  the RESULT. The columns that could hold a card, an IBAN or a mandate do not
  exist — the analytics domain's defence, which is absence rather than
  redaction.
- **A threshold nobody measured is `unmeasured`, never `within`.** The failure
  this guards is a monitor reporting "no breaches" because it read nothing, so
  `evaluateStopThresholds` returns one outcome per THRESHOLD and the caller logs
  how many had no usable measurement. A rate is additionally refused off a
  sample below twenty: a 2% threshold against three orders fires on the first
  failure, which is a signal about three orders rather than about the pilot. A
  COUNT has no such floor — one product-safety incident is one incident.
- **The UNIT is stored beside the value.** "> 2% of orders", "> €50/week" and
  "one occurrence" are three different kinds of number, and a measurement whose
  unit does not match its threshold is reported `unmeasured` rather than
  compared. Comparing them is how a rate gets read as a count and never fires.
- **A breach is `observed > threshold`, strictly.** A one-occurrence stop is
  therefore written with a threshold of ZERO and fires on the first. One
  comparator, one reading, no per-metric exception.
- **Raising is idempotent and lifting is a CAS.** One live stop per (cohort,
  metric, scope, subject) by partial unique, so two evaluations of one breach
  page once — the empty `RETURNING` set IS the "already stopped" answer. A lift
  is attributable, dated and explained, all three or the CHECK refuses, and a
  second lift finds nothing to lift.
- **Detection and repair are separate.** The evaluator raises and never lifts: a
  threshold falling back under its bound is not evidence that whatever caused it
  was fixed. That is the `payment_discrepancies` posture.
- **The scope match is EXACT, never a prefix.** A prefix test would make a stop
  on supplier `acme` also stop `acme-industries`, which is somebody else.
- **Publishing refuses a draft missing any of the thirteen thresholds, or with
  no allow-listed SKU.** A pilot running with an unmonitored stop condition is
  one whose review has a hole in it, and the cheapest moment to find that is
  before it is live. A cohort allow-listing nothing could sell nothing, which
  reads as a broken pilot rather than a deliberately empty one.
- **The audience ladder fails closed.** `retailPilotAudienceFor` produces
  `public` for every buyer today, because no Mercaria surface publishes a staff
  or invite list — so a cohort narrower than `public` admits NOBODY. That is the
  narrow direction, and it makes the ladder's low rungs a real bound rather than
  a decorative one. `percentage` is deliberately never produced here: a
  percentage bucket needs a stable unit key, and deciding it in the gate would
  make the pilot's cohort a place a person is identified (#77's experiment
  rule).

## The thirteen stop metrics

#125 names twelve. The thirteenth, `non_eu_dispatch_origin`, is #119 §10's own:
ADR 0004 D2.9 makes a dispatch from outside the EU customs territory a
one-occurrence stop, and leaving it out would mean the one bound the
architecture treats as absolute is the one nothing could record.

`PRINTFUL_PILOT_RECOMMENDED_THRESHOLDS` carries the six #119 §10 actually
QUANTIFIED. The other seven are deliberately absent rather than given a number
invented in code — a threshold set written by a migration is a policy nobody
signed (#65's ruleset reasoning) — and publishing refuses a cohort that has not
decided them.

## Operator surface

`/internal/retail-pilot/*`, behind the SAME sixth allow-list
(`PROCUREMENT_OPERATOR_OXY_USER_IDS`) that #122 and #124 use, and deliberately
not a seventh: publishing the bounds Mercaria buys under, recording its supplier
balance and pausing entry are the same power as reading what Mercaria pays a
supplier and flipping a supplier kill switch. Empty list = not mounted (404).

Draft a version · allow-list a SKU on it · publish a threshold on it · publish
the draft · read and record funding · raise a stop · lift a stop. That is the
whole surface.

Three things it deliberately cannot do: **widen the active cohort** (a widening
is a new version), **clear a stop** (a lift is attributable, dated and
explained; a clear would be none of those) and **override an admission** (the
gate is a conjunction of published bounds, and a per-request escape would make
every one of them advisory).

## Environment

The pilot adds **no environment variable**. That is the design: its bounds are
rows. What it reads is `PROCUREMENT_OPERATOR_OXY_USER_IDS` (whether the operator
surface mounts at all) and, indirectly, `MERCARIA_RETAIL_ENABLED` (#123's entry
switch, checked before this gate is reached).

## Seams left to their owners

- **#128** owns variance RECOGNITION. This domain's `negative_realized_margin`
  threshold consumes a measurement #128 will produce; nothing here books
  anything, and there is no ledger account, transaction pointer or accounting
  column in any of the five tables.
- **The measurement producers.** `evaluateRetailPilotStopThresholds` takes
  measurements from its caller and NO sweep computes them yet. That is deliberate
  rather than unfinished: eight of the thirteen metrics are derived from data
  #126 (dispatch and tracking), #127 (returns and RMAs) and #128
  (reconciliation) own, and a sweep that computed the five it can reach would
  report "no breaches" for the other eight — which is precisely the vacuous
  monitor this domain's `unmeasured` outcome exists to make visible. Until those
  land, thresholds are evaluated when an operator supplies measurements, and
  every unmeasured metric is counted and logged.
- **#116** owns the `mercaria_retail` offer KIND. `OfferKind` has no such member
  today, so a public retail offer is not representable at all — which is why
  this domain's publication bound is expressed as a checkout gate rather than as
  an offer filter.
- **A rollout bucketer** for the `percentage` audience rung, per the note above.

## The seam that makes a Printful item sellable

The procurement-offer projection is NOT built: Printful source records do not yet
become `procurement_offers`, so no Printful item is sellable at all.
`retail_pilot_skus.procurement_offer_id` is nullable precisely so a SKU can be
allow-listed before the offer it names exists.
