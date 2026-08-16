# The bounded referral pilots (#149)

`services/referral-pilot/` (4 modules) + `db/referralPilot/` (2 repositories) +
`db/schema/referralPilot.ts` (4 tables) + the pilot half of
`/internal/referrals/*`. Schema decisions:
`packages/backend/src/db/schema/CONVENTIONS.md` §"The bounded referral pilots".
Binding architecture: [ADR 0005](./adr/0005-referral-program.md) —
"Rollout and rollback" phase 2, D16, D17, D18, D19.

#142 built the records, #143 the attribution edge, #144 the versioned reward
rules, #145 the earnings ledger, #146 the partner and the payout rail, #147 the
dashboards and #148 the integrity controls. Every one of them answers "can
Mercaria do this correctly". **None of them answers the question this domain
exists for: how much of it is Mercaria willing to do at all, today, and what
would make it stop.**

The failure mode it is shaped around is not a bug. It is a pilot that worked
technically and expanded by default — #149 says it outright, *"technical
completion alone does not authorize a public referral program"* — so every bound
here is a stored, versioned, immutable-once-active fact with a person's name on
it, and there is deliberately no code path that widens one.

---

## Why a versioned cohort and not environment variables

#125's three reasons, restated because they are the same three:

1. **A bound has to be attributable.** "Why was the per-partner entry cap fifty"
   is a question with an answer — a person, a date, a written rationale — and an
   environment variable has none of those. `published_by_oxy_user_id` is NOT NULL
   on a published row, by CHECK.
2. **A bound has to survive a deploy.** A variable changes when somebody edits a
   task definition, which is not an event anybody reviews. A cohort version is
   frozen once active by trigger, and a change is a NEW version — so the bounds
   a pilot RAN UNDER stay readable after it is widened, and the partners
   recruited under them can still find the terms they signed up to.
3. **A partner allow-list is a table.** Twenty partner ids in a comma-separated
   variable is a list nobody can review, nobody can attribute a line of, and
   which silently admits everything on a typo.

**This domain therefore adds NO environment variable at all.** What it reads is
`REFERRAL_OPERATOR_OXY_USER_IDS` (whether the operator surface mounts) and,
indirectly, `REFERRALS_ENABLED` plus `referral_program_controls`' three row
levers (#143/#145), all of which are checked before this gate is reached.

`referral_programs.cohort_keys` is deliberately NOT reused. It is a rollout
scoping array on a programme version — no author, no dates, no caps, no
thresholds — and widening it is an edit to the programme rather than a new
decision with a name on it.

---

## The rules that are load-bearing

- **No active cohort ⇒ every new attribution is refused** (`no_active_cohort`).
  An empty pilot IS the off position, which is why this domain has no kill
  switch of its own, and there is no `admitted` path that does not name a cohort
  version. A deployment that turns referrals on and publishes no bounds
  attributes nothing.
- **The cohort is keyed on the PROGRAMME, not on a configured pilot key.**
  `referral_pilot_cohorts_active_program_key` is a partial unique on
  `program_id`, so the admission gate looks bounds up by a fact the touch
  already carries and no configured string could point it somewhere else. It is
  also why this table is not a shared slot between parallel realdb files — the
  `match_policy_versions_active_key` hazard, avoided rather than queued for.
- **A stop pauses ENTRY and nothing else**, and it is a property of the CALL
  GRAPH rather than a rule in a handler. `evaluateReferralPilotAdmission` is
  called from `attributeTouch` and from nowhere else, so a live stop refuses new
  attribution while every standing attribution keeps converting, every reward
  keeps accruing and vesting, every vested balance keeps being paid and every
  appeal keeps being heard. That is #149 acceptance 5, and
  `referral-pilot-isolation.test.ts` fails the build in BOTH directions — if a
  reward, payout, vesting, enforcement or ranking module starts calling the
  gate, and if `attributeTouch` stops.
- **The gate sits BELOW every #142/#148 check and ABOVE the winner comparison.**
  That position is what makes a pilot bound refuse a NEW attribution and touch
  nothing that already exists: a live stop never supersedes a standing winner.
  It is also the cheapest position — the subject is already derived, so the
  entry count is the only read it adds, and that read is skipped entirely when
  no cohort is active.
- **The partner's refusal names none of the nine bounds.** ONE
  `ReferralConflictReason` (`pilot_not_admitted`) reaches the caller; the
  vocabulary reaches the `referral_events` row an operator traces from.
  Distinguishing them would let somebody vary one input at a time and read out
  the pilot's allow-list, its dates and its remaining entry budget — #123's
  `retail_line_ineligible` and #112's `p2p_seller_excluded` decision.
  `pilot_not_admitted` is deliberately distinct from `enforcement_suspended`
  (#148, a decision about THIS partner) and `program_retired` (#142, a decision
  about the programme): collapsing the three would make an operator guess which
  of three surfaces to look at.
- **The entry caps are NOT atomic, and that is stated rather than hidden.** The
  count is taken in the attribution's own transaction, so under READ COMMITTED
  two concurrent attributions can both observe `n < cap` and both insert — the
  cap is exceeded by at most the concurrency. A bound that took a row lock on the
  cohort would make the pilot's own gate the throughput limit of every
  attribution in the programme, and the caps that bound MONEY are #144's
  (`maxRewardPerConversionMinor`, the per-partner period cap, the campaign
  budget), which ARE claimed atomically at accrual.
- **The caps compare with `>=`.** A cap of fifty admits the fiftieth entry and
  refuses the fifty-first; a breach threshold, by contrast, is strictly `>`.
- **"Not yet" and "over" are two refusals.** They send an operator to opposite
  places: one waits, one publishes a new version.
- **A threshold nobody measured is `unmeasured`, never `within`** — and
  `no_producer` is kept apart from `no_measurement`. The first says nothing in
  this repository can compute the number today and names the issue that would;
  the second says nobody supplied one this time. Collapsing them makes a
  permanent gap look like a transient one, and a permanent gap in a stop
  condition is a pilot whose review has a hole in it. A RATE is additionally
  refused off a sample below twenty; a count, an amount and a duration have no
  such floor — one privacy incident is one incident.
- **The UNIT is stored beside the value.** "> 2% of conversions", "> €500 net
  negative", "one privacy incident" and "> 48 hours of backlog" are four
  different kinds of number, and a measurement whose unit does not match its
  threshold is reported `unmeasured` rather than compared.
- **A breach is `observed > threshold`, strictly**, so a one-occurrence stop is
  written with a threshold of ZERO and fires on the first.
- **Raising is idempotent and lifting is a CAS.** One live stop per (cohort,
  metric, scope, subject) by partial unique, so two evaluations of one breach
  page once — the empty `RETURNING` set IS the "already stopped" answer. A lift
  is attributable, dated and explained, all three or the CHECK refuses, and the
  lifted row leaves the live key free so the same condition can be raised again.
- **Detection and repair are separate.** The evaluator raises and never lifts: a
  threshold falling back under its bound is not evidence that whatever caused it
  was fixed. The `payment_discrepancies` posture.
- **A market-scoped threshold is REFUSED at publish.** A touch carries no market
  — deliberately, since a market is a property of an ORDER and not of a click —
  so a market stop could never bite, and a bound that reads as live and is not is
  worse than an absent one. `ReferralPilotEntry.market` exists so the day a
  caller does know one, the scope becomes real without a schema change.
- **The expansion review is a COLUMN GROUP and a publish refusal.** A version
  carries its own review (a decision, a date, an author and a rationale, all four
  or none by `num_nonnulls`), a version above 1 must NAME the version it
  supersedes (a CHECK), and publishing a successor REFUSES while the predecessor
  carries no review. #149 acceptance 7 — "expansion requires a dated review
  rather than automatic rollout" — is therefore a state the surface cannot
  produce rather than a step somebody remembers.
- **A review is written ONCE.** The repository write is a CAS on "no review
  yet", and the trigger refuses a hand-written edit of the same four columns. An
  operator who could rewrite the dated decision that authorised an expansion
  could rewrite the only record of why it happened.

---

## The twelve stop metrics, and which have a producer

`REFERRAL_PILOT_STOP_METRICS` is #149's twelve, verbatim and in its order.
`REFERRAL_PILOT_STOP_METRIC_MEASURES` maps each to the measure it is read from,
totally — a stop metric with no measure fails `tsc`.

**Four of the twelve resolve to a measure a producer exists for today.** The
other eight resolve to a measure whose producer is `operator_entry` (a figure a
person records, because the fact lives outside every table Mercaria owns) or
`unavailable` (nothing could derive it here, and the definition names the issue
that owes it). The report and the evaluator both say so rather than reporting
zero — a sweep computing only what it can reach and calling the rest "no
breaches" is the vacuous monitor `unmeasured` exists to expose.

`REFERRAL_PILOT_RECOMMENDED_THRESHOLDS` carries the FIVE numbers ADR 0005
actually quantified (D17's refund rate, dispute rate and account-farm posture;
D16's programme ceiling; and the one-occurrence privacy stop). The other seven
are deliberately ABSENT rather than given a number invented in code — a
threshold set written by a migration is a policy nobody signed — and publishing
refuses a cohort that has not decided them.

---

## Measured economics

#149 asks for the exact numerator, denominator, window and source of eighteen
pilot metrics and twelve unit-economics lines. `REFERRAL_PILOT_MEASURES` states
all thirty, with a mandatory `attributionLimit` on every one, plus three
`REFERRAL_PILOT_STOP_ONLY_MEASURES` that exist because a stop threshold needs a
defined number and #149's two published lists do not contain one.

`ReferralPilotMeasureDefinition` has no optional field except `seam`, so a
measure with an unstated denominator does not compile; `seam` is present
EXACTLY when the producer is `unavailable`, asserted.

**The source vocabulary is where "do not count a client-side success event as
revenue or a bot click as acquisition" is held.**
`REFERRAL_PILOT_MEASURE_SOURCES` has no telemetry member at all, and
`REFERRAL_PILOT_FORBIDDEN_MEASURE_SOURCES` names the seven prohibitions as
values, disjoint by a test — including `gross_merchandise_value`, because #149
says outright not to use GMV as a base and a report quoting it beside a
commission share is how an attractive-GMV, negative-contribution pilot gets
expanded.

### Which figures this issue actually produces

Eight, from two bounded aggregates over the referral tables
(`readReferralPilotAggregates`):

| Measure | From |
|---|---|
| `eligible_referred_subjects` | distinct `subject_ref` on the cohort's attributions |
| `qualified_conversion_rate` | verified conversions ÷ attributions |
| `native_revenue_generated` | `referral_rewards.funding_amount_minor` |
| `eligible_mercaria_revenue` | the same realized base |
| `commission_pending` | net of `held`/`frozen` rewards |
| `commission_approved` | net of `vested` rewards |
| `referral_commission_expense` | net of every accrued reward |
| `budget_utilization` | expense ÷ the cohort's published budget |

The realized base is read off the REWARD ROW rather than re-derived from
`ledger_entries`, and that is a decision: #144's accrual read the commission
from the ledger through the one adapter allowed to compute it and RECORDED what
it read, so the reward row is the figure a partner was actually paid on. A
second derivation could disagree with it. The cost is stated in the measure's
own attribution limit — a conversion whose accrual was refused (`zero_base`,
`budget_exhausted`, `cap_reached`) has no reward row and contributes no revenue
here, even where the order genuinely produced commission.

**`net_contribution` is not published as a measurement while any of its five
components is unmeasured**, and `ReferralPilotReport.netContributionMeasurable`
says so in one field. #149's "a program with attractive GMV but negative
contribution must not expand automatically" only bites if contribution is a
number somebody actually has; three of its five components have no producer, so
today it is not.

### The twenty-two measures with no producer, and what would close each

- **`payout_and_fx_fees`** — #146 stores no rail fee column, so nothing here can
  read one. The FX half is structurally zero (one payout currency per cohort,
  every launch reward EUR); the FEE half is real and unmeasured, and reporting
  zero would understate the pilot's cost.
- **`incremental_versus_organic`, `post_reward_repeat_revenue`,
  `payback_period`, `sensitivity_to_refunds_and_retention`,
  `comparison_with_other_channels`** — #111. Incrementality needs a HOLDOUT,
  which is an experiment over PEOPLE and therefore #77/#111's under their
  allocation rules, not this domain's. Repeat revenue is unattributable for a
  guest subject without exactly the durable profile ADR 0005 A4 forbids.
- **`merchant_quality_measure`** — #85 derives activation live but nothing links
  a merchant activation back to the referral that produced it in a form this
  domain may read.
- **`support_volume_and_resolution`, `privacy_and_disclosure_complaints`,
  `support_and_operational_cost`, `security_finding_measure`** —
  `operator_entry`. Mercaria operates no partner support desk, no complaint
  intake and no security-finding record in this repository, so these are figures
  a person records with their name beside them.
- **The remaining eleven** (`human_referral_clicks`, `commission_reversed`,
  `commission_paid`, `customer_acquisition_cost`, `merchant_acquisition_cost`,
  `referred_cohort_refund_rate`, `fraud_intervention_rate`,
  `appeal_overturn_rate`, `partner_payout_readiness_rate`,
  `payout_failure_rate`, `cost_by_partner`,
  `outstanding_and_contingent_liabilities`, `reconciliation_completeness`,
  `average_commission_per_subject`, `attribution_conflict_rate_measure`) are
  DERIVABLE from tables that exist — their producers are simply not written
  here. Closing one is adding its key to `PRODUCED_MEASURE_KEYS` in `report.ts`
  and the aggregate beside it; the DEFINITION does not move, because that is
  what a reviewer was shown.

---

## The operator surface

`/internal/referrals/pilot/*`, behind the SAME `REFERRAL_OPERATOR_OXY_USER_IDS`
allow-list #143, #145, #146, #147 and #148 use, and deliberately not an eighth:
publishing the bounds a partner was recruited under, pausing entry and writing
the dated review that authorises expansion are the same power as pausing
attribution and approving a payout. Empty list = not mounted (404, not 401).

Draft a version · allow-list a partner on it · publish a threshold on it ·
publish the draft · record its expansion review · read the report · evaluate
thresholds against measurements · raise a stop · lift a stop. That is the whole
surface, and every route names a cohort ROW or the programme it bounds.

Five things it deliberately cannot do:

- **Widen the active cohort** — a widening is a new version.
- **Clear a stop** — a lift is attributable, dated and explained; a clear would
  be none of those.
- **Override an admission** — the gate is a conjunction of published bounds, and
  a per-request escape would make every one of them advisory.
- **Store a measurement** — a figure kept beside a threshold is a number whose
  definition nobody could check later, which is what the definition registry
  exists to prevent. The evaluation route takes measurements and keeps only the
  stops a breach raised.
- **Rewrite a review** — a CAS plus a trigger; a correction is a new version.

---

## Migration

`drizzle/0086_clever_wasp.sql`, phase `pre`: four additive tables, three trigger
pairs, and ONE widening of `referral_attributions_conflict_reason_check` by the
single member `pilot_not_admitted` (nine values become ten; nothing removed,
verified element by element). The widening is why it stays `pre` — the serving
image never writes the new value, so the drop-and-re-add pair breaks no write it
performs.

---

## Test fixtures, and why the gate made existing files change

`attributeTouch` refuses a new attribution for a programme with no active pilot
cohort, so the three referral realdb files that attribute now publish bounds
first — exactly as a deployment does.
`services/referral-pilot/__tests__/pilot-fixture.ts` is the shared helper, and
two of its properties are worth knowing:

- It **accumulates**: a published cohort is frozen and its allow-list may not
  grow, so admitting a second partner is a NEW version carrying the first. Every
  file that uses it therefore exercises the supersede path.
- It **serialises**: publishing reads the incumbent and inserts the next version
  number, so two concurrent calls collide on
  `referral_pilot_cohorts_key_version_key`. That collision is the unique index
  doing its job; the fixture queues rather than retrying, because a retry would
  hide it.

The fixture is imported by nothing outside a test — a scanned gate.

---

## Seams left to their owners

- **The measurement producers** for twenty-two of the thirty measures, listed
  above with what would close each. `evaluateReferralPilotStopThresholds` takes
  measurements from its caller and NO sweep computes them, deliberately: a sweep
  that computed the four it can reach would report "no breaches" for the other
  eight.
- **#111** owns the rollout review, the holdout that incrementality needs, and
  the storefront analytics client.
- **#146** owns the payout fee figure.
- **#85** owns the merchant-quality projection.
- **A market on a touch.** Until one exists a market-scoped stop cannot bite and
  the publish path refuses to create one.

## Production-readiness checklist

1. Populate `REFERRAL_OPERATOR_OXY_USER_IDS`: with it empty `/internal/referrals`
   is not mounted at all, so nobody can publish bounds — and with no bounds
   published, nothing attributes.
2. Publish a cohort version per programme before turning `REFERRALS_ENABLED` on.
   All twelve thresholds and at least one allow-listed partner, or the publish
   is refused.
3. Decide the seven thresholds ADR 0005 did not quantify. The publish refusal is
   the reminder, not a substitute for the decision.
4. Accept that eight of the twelve stop conditions are `unmeasured` until their
   producers land. That is the honest state; the report names it and
   `unmeasuredCount` is rendered beside the figures.
5. Record the dated expansion review before publishing any successor version.
   The publish refuses without it.
