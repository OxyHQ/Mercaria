# Referral integrity: conduct, signals, enforcement, appeals and disclosure

**Issue:** [#148](https://github.com/OxyHQ/Mercaria/issues/148), part of epic
[#140](https://github.com/OxyHQ/Mercaria/issues/140).
**Binding decisions:** ADR 0005 D7, D17, D18 and R6–R8.
**Code:** `services/referrals/integrity/` (8 modules) + `db/referralIntegrity/`
(3 repositories) + `db/schema/referralIntegrity.ts` (5 tables) +
`controllers/referral-integrity.controller.ts`, plus the integrity half of
`/internal/referrals/*` and four routes on the partner surface.

#142 built the records, #143 the edge, #144 the rules, #145 the money and #146
the partner. What none of them owns is the question this domain answers: **on
what evidence may Mercaria take something away, and what exactly may it take.**

---

## The one law, and the four things that hold it

ADR 0005 D17: *"Signals freeze; only first-party identity evidence voids."* A
statistical anomaly is a reason to look, never a reason to keep somebody's
money. Four independent mechanisms hold it, none of them a branch somebody can
forget to write:

1. **`REFERRAL_ENFORCEMENT_FINANCIAL_EFFECTS`** is an exhaustive `Record` over
   the twelve actions, so an action added without an effect fails `tsc`.
   `REFERRAL_FORFEITING_ENFORCEMENT_ACTIONS` is DERIVED from it rather than
   written down a second time.
2. **`REFERRAL_BASES_PERMITTING_FORFEITURE`** is derived by SUBTRACTION of the
   one basis — `risk_signal` — that may not. A basis added later is permitted
   only because somebody said so.
3. **`referral_enforcement_actions_forfeiture_basis_check`** renders BOTH
   derived sets, so a forfeiting action on a signal basis has no row shape at
   all — not a service bug, not an operator mistake, not `psql`.
4. **`referral-integrity-isolation.test.ts`** scans the whole domain directory,
   with a vacuity floor and a mutation self-test per detector.

The realdb suite mutation-tests (3): with the CHECK dropped inside a
rolled-back transaction, the identical insert is ADMITTED.

## Fraud detection reads about BEHAVIOUR, never about a person

`REFERRAL_RISK_SIGNAL_KINDS` (14) and `REFERRAL_FORBIDDEN_RISK_SIGNALS` (18) are
DISJOINT — the `RETAIL_FORBIDDEN_COMPONENT_KINDS` device applied to evidence.
Everything on the second list is an IDENTIFIER; everything on the first is a
BEHAVIOUR Mercaria observed in its own commerce records.

**#148 does not fork #143's prohibition, it EXTENDS it.**
`REFERRAL_FORBIDDEN_RISK_SIGNALS` is the UNION of #143's fourteen
`REFERRAL_FORBIDDEN_IDENTITY_SIGNALS` with four #148 adds, and a test asserts
the superset relation. Two lists describing one prohibition disagree eventually,
and the direction they disagree in is always the permissive one.

`ReferralRiskSignalFacts` then has a field for every permitted signal and none
for any forbidden one — the `SourcingCandidateFacts` device: a detector that
cannot see a device fingerprint cannot be tuned into one. `referral_risk_signals`
has no email column, no hash column, no phone column, no address column, no card
column, no provider-customer column, no IP column, no user-agent column and no
device column, and the isolation gate walks the domain for the spellings.

A fraud domain is exactly where that pressure arrives: catching a cheat is the
most sympathetic reason anybody will ever have for joining two strangers by
their IP address.

## Self-referral: THREE answers, and the middle one is what the issue asked for

The issue and the ADR pull in different directions and both are honoured. ADR
0005 D7 admits exactly two facts as grounds for refusal — the same Oxy actor,
and store membership — and says everything else *"freezes and routes to manual
review"*. The issue lists four more as "strong evidence where available", and
then forbids four specific weak ones outright.

`REFERRAL_SELF_REFERRAL_EVIDENCE_STRENGTH` is the reconciliation: the ADR's two
are `deterministic` and REFUSE; the issue's four are `reviewable` and REVIEW;
the weak four are not in the type at all, so a household IP, a shared card, a
common surname and a matching email domain cannot even be RECORDED — which is
stronger than not acting on them.

`verified_beneficiary_overlap` is the one worth reading. It is strong evidence
and it is still `reviewable`, because two partners legitimately share a
beneficiary (an agency, a household business) and D7 is explicit that refusal on
identity is *"deterministic and final"* while suspicion is *"reviewable"*. A
rule that quietly refused on an overlap would be final on evidence the ADR did
not make final.

`review` is not a soft yes: two of the three verdicts refuse to attribute, and
the difference between them is whether a PERSON gets to look first.
`selfReferralPermitsAttribution` exists so no caller writes
`verdict !== 'refused'`, which reads correct at a glance and attributes
everything a reviewer was supposed to see.

**`undefined` means NOT ESTABLISHED and is never read as `false`.** "We could
not check whether the partner administers this merchant" and "we checked and
they do not" lead a reviewer to opposite conclusions.

**Two facts are honestly unestablished today**, and both say so rather than
answering `false`: a `store` partner referring a merchant (linking a Mercaria
store to a merchant is #84's `native_store_links`, which does not exist), and a
beneficiary overlap against a BUYER (a buyer has no payout beneficiary — the
question is answerable only between two PARTNERS, which is the
`shared_payout_beneficiary` RISK SIGNAL rather than an attribution-time fact).

## Scoped enforcement: #148 acceptance 2

Before #148 a partner's fraud posture was ONE coarse column,
`referral_partners.state`, whose `suspended` value stops new links AND new
attribution AND payout AND earning simultaneously. An operator wanting to stop
crediting NEW referrals during an investigation therefore had to stop paying the
partner's already-vested honest earnings too — which acceptance 2 forbids in as
many words.

`ReferralEnforcementEffects` separates them into five independent answers, and
`deriveEnforcementEffects` is the ONE authority the three gates read:

| Effect | Read by | Was collapsed into |
|---|---|---|
| `newLinksSuspended` | `instrument.service.ts`'s `requireIssuable` | `state = 'suspended'` |
| `newAttributionSuspended` | `attribution.service.ts`'s `attributeTouch` | `state = 'suspended'` |
| `payoutHeld` | `earnings/payability.ts`'s `deriveRewardPayability` | `state = 'suspended'` |
| `terminated` | all three | `state = 'terminated'` |
| `permanentlyRestricted` | enrollment | nothing |

**The partner's own state is folded INTO that derivation rather than read beside
it.** Leaving it out would give the three gates two things to consult and two
chances to disagree; duplicating it into an enforcement row would give
`referral_partners.state` a rival. So a `suspended` partner gets today's
behaviour exactly, and what is NEW is that an operator no longer has to reach
for that column to stop one of the three.

The verdict is DERIVED and never stored — the `deriveNativeCheckoutEligibility`
divergence, taken for the reason that rule itself gives: the inputs are a SET of
rows carrying expiries and lifts, so a stored boolean would be right until the
first action lapsed and would then be wrong with nothing to notice it. Expiry is
applied against the CALLER's clock, in the derivation, so the SQL (which narrows
on the indexed `lifted_at is null`) and the verdict cannot disagree about "now".

`enforcement_payout_hold` is a SEPARATE payout-block reason from
`partner_suspended` for the same reason: reporting a scoped hold as a suspension
sends an operator looking for a state that is not there, and would make
acceptance 2 unobservable from the very surface that implements it.

## Two actions are REPRESENTABLE and NOT IMPOSABLE

`partner_termination` and `commission_held` are in the vocabulary, in the effect
table and in every projection — an operator reading a partner's record must be
able to SEE them — and `imposeEnforcementAction` refuses both BY NAME, pointing
at the route that performs them:

- `partner_termination` → `POST /internal/referrals/partners/:id/terminate`
  (#146 owns the enrollment transition and its confirmed-fraud decision)
- `commission_held` → `POST /internal/referrals/partners/:id/freeze`
  (#145 owns the reward state machine)

The `role_email` device (#83), for the reason that one exists: a second way to
terminate would be a second writer of `referral_partners.state`, and a second
way to freeze would be a second writer of the reward state machine. The refusal
NAMES the alternative rather than saying "unrecognized action", which is the
difference between a reader learning the model and a reader concluding the
feature is broken.

## Lifting is a compensating record, never an edit

`mercaria_referral_enforcement_actions_freeze` freezes every decision column;
only `lifted_at`, `lifted_by_oxy_user_id`, `lift_reason` and `appeal_state` may
move, and a lift happens ONCE. So acceptance 3's *"reversible through
compensating records"* is the only available shape rather than the one somebody
chose — and an operator who could edit `basis` from `risk_signal` to
`identity_evidence` after the fact would walk straight around the forfeiture
CHECK, since a CHECK is evaluated per statement and the forfeiting action would
already be recorded.

DELETE is refused outright. An enforcement record somebody can remove is not an
audit trail.

## The appeal path is independent, by CHECK

`referral_enforcement_appeals_independence_check` refuses a decider who imposed
the action and a decider who submitted the appeal. `imposed_by_oxy_user_id` is
SNAPSHOTTED onto the appeal at submission, because a CHECK may not contain a
subquery; the snapshot is safe precisely because the action's decision columns
are frozen.

Both comparisons are `IS DISTINCT FROM` rather than `<>`: `<>` against a NULL
decider yields NULL, a CHECK reads NULL as SATISFIED, and both halves would then
be VACUOUS on every open appeal — exactly the rows they exist to constrain
later. Mutation-tested.

An ACCEPTED appeal LIFTS the action; it does not delete it. The original
decision — its reason, its basis, its evidence — stays exactly as recorded.

**There is deliberately no operator route that OPENS an appeal.** An operator
who could open one could open one they then decide, and the independence CHECK
would be satisfied by two accounts one person holds. There is also no
"withdraw"; a partner who stops pursuing an appeal simply stops.

## The conduct policy is versioned and frozen

`referral_conduct_policies` is the `fee_schedules` / `referral_reward_rules`
device: editable while `draft`, frozen by trigger afterwards, one `active`
version per key by partial unique. A partner accepted the version that was live
when they accepted and their `referral_terms_acceptances` row names it; editing
it retroactively makes that pointer name something that no longer exists.

`prohibited_conduct` is a `text[]` with a containment CHECK rendered from
`REFERRAL_PROHIBITED_CONDUCT_KINDS` (16, exactly the issue's list) plus
`cardinality(...) >= 1` — **never `array_length(...) >= 1`**, which is NULL on an
empty array and which a CHECK reads as SATISFIED, admitting exactly the row it
exists to refuse. Mutation-tested with the wrong spelling substituted in a
rolled-back transaction; the empty set is admitted.

There is **no built-in policy**: absence is reported as absence rather than
defaulted, because a rule people are held to must have been published by
somebody. That is #82's posture rather than #74's, and the asymmetry is the
consequence — a ranking must produce SOME order, while a prohibition need not be
asserted at all.

The rules are **visible before participation**: `GET /referral-partner/conduct`
requires no partner record at all, because gating it behind enrollment would
make #148's requirement unmeetable by construction.

## Disclosures: versioned copy, no jurisdiction table

`referral_disclosure_requirements` is one row per (key, surface, market,
language) VERSION, on the same immutability device. Resolution is MOST SPECIFIC
WINS and is written out as four ordered lookups rather than a scoring function,
because a score over two independent dimensions has ties and a tie here means
two partners in one market are shown two different sentences with nothing saying
why.

`REFERRAL_DISCLOSURE_FORBIDDEN_CLAIMS` is scanned against the copy at
PUBLICATION time and the refusal NAMES the phrase: #148 rules 6–8 say a partner
is not an employee, not an official store, not a brand representative and not
verified. Those are #55's relationships, and a marketing program able to grant
one by publishing a sentence would be a second answer to a question the
relationship layer already answers.

The scan is a crude substring match, deliberately: it catches the phrase
somebody writes, it does not attempt every paraphrase, and pretending otherwise
would be the "aggressive normalizer" mistake `duplicate-signals.ts` names one
domain over. What makes it enough is that the copy is short, published by an
operator, and versioned with an author on the trail.

**There is no jurisdiction table.** Which markets REQUIRE a disclosure is a legal
question ADR 0005's open item 1 assigns to the legal entity, and a table of
jurisdictions would be Mercaria asserting an answer nobody gave it. What is
representable is what Mercaria DECIDED to require, per market, with a version and
an author behind it.

## Risk signals are observations, and they expire

`referral_risk_signals` refuses UPDATE by trigger and PERMITS DELETE — the
`analytics_events` posture, inverting the ledger's. Append-only is what stops a
signal being retuned after the fact to justify an action taken on it; the delete
exception is because erasure on a schedule IS the retention policy, and a trigger
refusing it would make the shared expiry sweep fail SILENTLY on every row it was
contractually obliged to remove.

`manual_evidence` is the operator's kind and only the operator's, by CHECK: a
system-recorded "manual evidence" would let an automated sweep produce the one
signal kind a reviewer trusts most.

The detector (`risk-thresholds.ts`) is PURE and implements ADR 0005 D17's four
named pilot thresholds — 500 touches per code per day, 20 conversions, a >30%
referred-cohort refund rate, a >2% dispute rate — plus the sample floor the ADR
does not state and a rate needs. An UNMEASURED fact produces no signal, never a
zero, and a rate over fewer than twenty conversions is not reported as a rate at
all. At most ONE concentration signal per window, because two rows of one kind
double-count a single cohort in every operator count that reads them.

Nothing here needs to be right to be safe: everything it produces carries
`basis: 'risk_signal'`, and the forfeiture CHECK then makes a money-destroying
action on it unrepresentable.

## The payment facts arrive through a PORT (#344)

Two of the fourteen facts are answerable only from the payment domain, which
WALL 2 of `referral-integrity-isolation.test.ts` forbids this domain from
importing. They come through `integrity/payment-facts.port.ts`, implemented by
`services/referral-payouts/risk-payment-facts.ts` and registered at boot by
`services/referral-payouts/register.ts` — #146's shape exactly, reusing #146's
join module rather than creating a second one, because two places bridging
referrals and payments are two places to get the direction wrong.

- **The default is SILENCE, and it INVERTS the readiness port next door.** An
  absent readiness verdict BLOCKS, because it gates money leaving. An absent
  risk reader answers `{}`, because the opposite default would have to invent a
  number — a zero dispute rate, a zero decline count — written onto a partner's
  record as though somebody had measured it. Failing open is bounded here in a
  way it is not there: a signal can only open a review, and the forfeiture CHECK
  makes it unable to destroy money.
- **The DENOMINATOR crosses the port; it is never recounted.**
  `deriveRiskSignals` guards both rates behind `conversionsInWindow >=
  minimumRateSample`, so a reader dividing by its own count would leave the
  sample floor guarding one denominator while the rate measured another. The
  count, the reversal count and the order cohort all come out of ONE statement
  in `collectRiskSignalFacts`.
- **An over-large cohort answers UNMEASURED, never a truncated rate.** A rate
  over a sliced population under-reports, which is the reassuring direction, on
  a fraud measurement.
- **Declines are counted `distinct` per ATTEMPT.** One payment covers every
  order in a checkout group, so a plain `count(*)` over the `orders.payment_id`
  join multiplies each decline by the number of referred orders on that payment
  — measured at 60 for three declines before the fix, which would have
  manufactured an `elevated` signal out of an ordinary basket.
- **A dispute is never scored twice.** `provider_risk_outcome` counts declines
  only; disputes reach `refund_dispute_concentration` and nothing else.
- **The transitive hole is closed.** WALL 2 scans text, so it cannot see the
  integrity domain importing the JOIN — which imports the payment domain. A
  seventh wall forbids `services/referral-payouts/` by path, and the isolation
  suite additionally asserts that the join's own imports DO trip WALL 2, so the
  port is load-bearing rather than ceremony.

## Retention: the twelve classes and the invariant

`REFERRAL_RETENTION_POLICY` is exhaustive over `REFERRAL_RETENTION_CLASSES`
(12, exactly the issue's inventory). `sweptAfterDays` is a NUMBER when a sweep
deletes the rows and `null` when the class is retained with the financial
record — an honest answer rather than a missing one, and why the field is
nullable rather than carrying a very large number that would look like a policy
somebody chose.

| Class | Swept after | Why |
|---|---|---|
| `raw_touch` | 30 days | Evidence explaining a live attribution, outliving it just long enough to answer a dispute about one. |
| `risk_signal` | 400 days | A year plus a review cycle; not a financial record and nothing downstream reads it after a case closes. |
| `review_evidence`, `appeal`, `partner_support_message` | 730 days | Two years so a contested decision can be reconstructed. The enforcement ACTION survives them. |
| `provider_event` | 90 days | The payment domain's own retention. |
| the other five | never | Financial, tax and aggregate records. |

**Acceptance 5** — *"raw touch and financial data have separate implemented
retention policies"* — is asserted over that table rather than left as a
sentence: `raw_touch` expires earlier than every other swept class, and the
financial classes are not swept at all. `db/expiryTargets.ts` is the MECHANISM
and this table is the POLICY, and the two agree.

The evidence a decision cites may therefore expire while the decision stands.
That is the division drawn deliberately: `evidence_signal_ids` may dangle after
400 days, and the action's own REASON is what survives — a decision outlives its
working papers rather than becoming unreadable with them.

## What a partner sees, and what they cannot

`ReferralEnforcementPartnerView` is a different TYPE from the operator's, not a
filtered one — #106's `MerchantOrder` device — so a serializer reaching for the
imposing operator, the evidence ids, the subject id or the basis fails `tsc`.
`REFERRAL_ENFORCEMENT_PARTNER_FORBIDDEN_FIELDS` names them as VALUES, scanned
statically AND walked at runtime over a real emitted view (#92's two-gate rule).

Naming the operator invites the retaliation an allow-listed review surface exists
to prevent; naming the evidence rows would disclose the other partner a
duplicate-beneficiary signal matched.

`appealable` is DERIVED rather than stored: an action already lifted, already
appealed or recorded as a clearance is not one to appeal.

## The operator surface

`/internal/referrals/*` on the SAME `REFERRAL_OPERATOR_OXY_USER_IDS` allow-list
#143/#145/#146 use — **not an eighth**. #143 already said why: pausing
attribution stops partners earning, and #148 is that power at a finer grain plus
the one #145 stopped short of.

The route set is CLOSED. There is no "clear this signal", no "edit this action",
no "delete this appeal", no "set this partner's risk state" and no "open an
appeal for this partner". A trace opens from a PARTNER id and nothing else —
there is deliberately no "which partners match this signal" and no search by
name, email or URL, because a fraud surface that could be asked "who looks
suspicious" is one that has to answer.

Mounted while every lever is down: the evidence has to be readable during the
incident that turned the surface off.

## Environment

**#148 adds no environment variable at all**, and that is deliberate. The
thresholds are a CODE CONSTANT (`REFERRAL_RISK_THRESHOLD_DEFAULTS`) rather than
configuration, for #82's reason: a value that decides whether somebody's earnings
get reviewed should have an author and a date rather than being whatever the last
deployment set. The policy KEY and the disclosure KEY are code constants too. And
nothing here gates a durable record — an enforcement action, an appeal and a
signal are all decisions or observations, and a flag able to stop one being
written would make an incident invisible rather than paused.

---

## What #148 asks for that is NOT here

Stated rather than stubbed. Each is a named seam that fails closed.

1. **A sweep that evaluates every partner on a schedule.** `evaluatePartnerRisk`
   is complete, bounded and idempotent, and the ONLY caller is the operator
   route. There is no loop, no lease and no lever, because a sweep needs a
   cadence somebody chose and a bound on how much of the partner table one pass
   may read — decisions #149's pilot is better placed to make with traffic in
   front of it. What exists today is a real detector an operator drives.
2. **Six of the fourteen risk-signal kinds have no producer, and none is now
   half-produced.** The authority is the single `ReferralRiskSignalFacts`
   construction in `collectRiskSignalFacts` — read that object literal, never a
   grep for the field names, because the docblock above it NAMES every
   unsupplied field in prose and a comment-inclusive census reports all
   fourteen as produced.

   **Produced (8):** `instrument_distribution_anomaly`,
   `repeated_conversion_pattern`, `prior_confirmed_enforcement`,
   `click_to_conversion_pattern`, `repeated_cap_attempt`, `manual_evidence`
   — that one through `recordManualRiskSignal` rather than through the facts —
   and, since **#344**, `refund_dispute_concentration` in BOTH halves plus
   `provider_risk_outcome`.

   **The half-produced one is closed.** `refund_dispute_concentration` fired on
   `refundRateBps` alone while reading as though it covered disputes too;
   `disputeRateBps` now computes through the payment-facts port, so the kind's
   two branches are both live and `risk-thresholds.ts`'s rule that only one of
   them reports per window means what it says.

   **One of the eight is produced by a STOPGAP.** `repeated_cap_attempt` counts
   accrual refusals by matching a `<code>: <detail>` prefix on the free-text
   `referral_events.reason`, because the reason code is not a column. A change to
   the reason SENTENCE makes the counter read zero — and zero is a measurement
   here, so it would report a clean partner rather than an unmeasured one. The
   honest fix is a `refusal_reason` column in the reward domain: **#431**.

   **No producer (6)**, and NOT because nobody has got to them — each is
   blocked on something specific, which is why this list names the blocker
   rather than inviting somebody to write the aggregate:

   - `declared_related_party` and `merchant_membership_overlap` — **already
     derived**, in `collectSelfReferralFacts` in this same directory, as
     `relatedPartyDeclared` and `partnerHoldsReferredStoreMembership`. A second
     derivation here would be two spellings of one rule, disagreeing the first
     time either read changed, inside a live attribution gate. Closing them
     means EXTRACTING the shared reads so both callers use one, not writing a
     producer.
   - `shared_payout_beneficiary` — **UNMEASURABLE TODAY, and the port is not
     what it is waiting for.** It reads the payment domain too, so #344 was
     written expecting to supply it; a producer was written and REVERTED,
     because the resolution partner → owner → account row is INJECTIVE at every
     hop and the count can only ever be zero.
     `services/__tests__/referral-risk-payment-facts.realdb.test.ts` proves all
     three hops against a real server (`referral_partners_owner_key`,
     `referralPayoutAccountOwner` being the identity translation, and
     `provider_accounts_provider_account_id_key`) so the finding goes red the
     day one of them changes. What would reopen it is **#146 increment 3's
     deferred beneficiary change** — letting a partner nominate a destination
     that is not their own owner breaks the middle hop by design, and nothing
     else in the roadmap does. Shipping the producer anyway would have been a
     signal that can never fire, reporting a clean bill on somebody nobody
     examined.
   - `referred_account_maturity` — needs the referred Oxy account's creation
     date. #164 deleted Mercaria's service principal and WALL 6 forbids an
     outbound call from this domain, so it needs a port plus a credential that
     does not exist.
   - `market_mismatch` — **not representable as specified.**
     `ReferralRiskSignalFacts` calls it "the conversion's market"; neither a
     touch nor a conversion carries one, and #149 refuses a market-scoped stop
     at publish for exactly that reason. Only the INSTRUMENT has a market
     (`referral_codes.market`, `referral_links.market`), and deriving from it
     answers a different question under the same name. Changing the spec is a
     decision about #149 as well — **#432** carries the three options.
   - `source_event_inconsistency` — no relationship exists between a referral
     partner and a #62/#65 source event to aggregate over.

   The sentence this replaced claimed every missing fact was "a bounded
   aggregate over rows this domain already has access to". Four of the seven
   are not, and that sentence is what would send somebody to write a producer
   for a fact that needs a port, a credential or a spec change.
3. **Monitoring and alerts** (#148's twelve measures). The rows exist and are
   countable; the DASHBOARD is #147's, and scraping and alerting wiring belongs
   to `oxy-infra`, which is where every other Mercaria metric's does.
4. **The recovery treatment for paid invalid commissions.** ADR 0005 R7 and
   #145's `bookPartnerRecovery` already carry it: a clawback debits the
   partner's payable, future accruals offset it, and recovery beyond offset is an
   explicit operator action. #148 adds no second path, because a second path to
   take money back is exactly what the enforcement record exists to prevent.
5. **Rate limits for link creation, code validation, applications, conversions,
   appeals and payout changes** (control 1). The referral surfaces carry their
   own buckets from #143 and #146; #148 adds no seventh, and a durable per-axis
   counter in the #83 mould is the shape one would take.
6. **A complaint-intake surface for undisclosed or misleading promotion**
   (disclosure rule 5). `POST /reports` already takes an abuse report and
   `ABUSE_REPORTED_TYPES` has no partner member; adding one is a CrowdSource
   subject-provider decision rather than an enforcement one.
7. **DAC7 and the platform tax-reporting regime.** ADR 0005 open item 1,
   legal-entity-owned, and #145 already records that it would change what the
   QUESTIONNAIRE collects rather than what the ledger holds.
