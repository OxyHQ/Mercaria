# Guest-commerce governance (#111)

The full reference for retention, privacy requests, abuse controls, security
monitoring and the staged rollout — the rules that are load-bearing, the
mechanics, the inventory's provenance, the
thresholds' reasoning and what is deliberately absent.

#103 through #110 built guest commerce. This is the part that makes it
operationally safe to turn on: what is kept and for how long, what a guest can
ask to have back or removed, what stops somebody abusing it, what an operator
watches, and the gate that says a rollout phase may advance.

---

## What #111 deliberately did NOT add

Nine flags and five block lists already existed across #103–#110 and ADR 0006,
and the single most likely mistake here was a tenth answer to a question one of
them already answers. So:

- **No new feature flag for a capability an existing lever gates.**
  `GUEST_FEATURE_GATE_REGISTER` names each of the thirteen capabilities the
  issue enumerates and the lever that answers it — including four that answer
  `null` because the absence is structural.
- **No `GUEST_ROLLOUT_STAGE` variable.** The current stage is DERIVED from the
  latest permitted advance. A variable naming one would be a second
  representation of a fact the append-only advance history already holds, and
  the one that would be wrong is the one an operator reads at 3am.
- **No lever on the data-request surface.** An export or erasure request is a
  legal obligation rather than a feature, and a deployment able to switch it off
  is one that can silently stop honouring one — #108's reasoning for refusing to
  gate a portal READ.
- **No second retention mechanism.** `db/expiryTargets.ts` stays the sweep. What
  #111 adds is the class the sweep structurally cannot serve — minimization,
  where the row survives and its identifying columns do not.

Two new levers exist and neither gates a durable record:
`GUEST_ABUSE_CONTROLS_ENABLED` gates whether friction is APPLIED (the counters
are written either way, so a deployment that switched the controls off during an
incident can still see what was happening while they were off), and
`GUEST_RETENTION_JOB_ENABLED` gates the sweep LOOP (rows keep their deadlines
and the lag counter keeps rising, which is exactly what must stay true, because
a paused retention job is the one failure in this domain invisible from
everywhere else).

---

## The data inventory

`GUEST_DATA_INVENTORY` in `@mercaria/shared-types` — sixteen classes, in the
issue's own order, each naming its owner, purpose, lawful basis, sensitivity,
encryption, access roles, retention class, disposition, export behaviour,
downstream processors and tables.

It is a TUPLE and not a document, for `ANALYTICS_METRICS`'s reason with more
force: an inventory written in Markdown drifts the first time somebody adds a
table, and nothing goes red. `db/__tests__/guest-data-inventory-census.test.ts`
is the `merge-plan-census.test.ts` device applied to privacy — a guest table
added without a class fails the build, because the decision "who may read this,
and when does it go" is otherwise made by not being made.

The census is checked from **two independent registries** rather than only from
its own list, which is the positive control the census rule asks for: every
guest table in `EXPIRY_TARGETS` and every guest table in `PROTECTED_COLUMNS`
must appear in the inventory. Finding fewer guest tables looks identical to
there BEING fewer, so a list checked only against itself proves nothing.

**The sixteenth class stores nothing, and that is why it exists.** ADR 0006
G4/G5 configure no Stripe Customer and no CustomerSession, so there is no
provider reference to retain. A class DROPPED for that reason would read, to the
next person, as one nobody thought about.

**Four classes carry an empty `tables` list** and each is a deliberate answer:
the paid checkout and the destination snapshot live on tables another class
already claims, the payment records are the payment domain's, and the provider
reference is not stored.

---

## The retention schedule

`GUEST_RETENTION_SCHEDULE` — thirteen classes, each naming its clock, its
figure, its mechanism, whether a legal hold pauses it, and why.

The figures are **not new policy**. They are what #103 through #110 already
stamp, gathered so they can be read as a schedule and checked against the sweep.
What #111 adds is the POLICY layer above the mechanism:
`guest_retention_policy_versions` is one immutable row per (version, class),
frozen by trigger once published, with one ACTIVE version per class held by a
partial unique — the `fee_schedules` device, because "how long was this kept,
and under what rule" is asked months later about data that has already gone.

### The three mechanisms, and the CHECK that got corrected

`expiry_sweep` is `db/expiryTargets.ts`. `minimization_job` overwrites columns
in place and is the only thing that can serve a class whose row must survive its
contents. `none` is a class with no deletion at all — a real answer for the
transaction records, and one that has to be STATED, because a class silently
absent from every sweep and one deliberately exempt look identical from outside.

The CHECK is an IMPLICATION — `mechanism <> 'none' OR retention_seconds IS
NULL` — and the first spelling was a biconditional, which is worth recording
because the biconditional is the tempting one:

- The dangerous direction is a class saying "never deleted" that carries a TTL
  anyway. That is what the implication refuses.
- The other direction is legitimate and common. Three of the thirteen classes
  have a sweep with NO fixed offset, because the deadline is already stamped on
  the row (`expiryTargets.ts`'s `retentionSeconds: 0` — the column IS the
  deadline) or the row leaves by `ON DELETE CASCADE` with its parent. A
  biconditional made all three unrepresentable, and the schedule's own first
  test run is what exposed it.

A fixture pins exactly those three, because without one the implication is
satisfied vacuously by a schedule in which every sweep happens to carry a figure
— the tidy-fixture failure that let the biconditional be written at all.

### What a legal hold does, and does not

`guest_legal_holds` is scoped to a class AND a checkout group, which is the
whole point of retention rule 7: a dispute over one order must not freeze every
abandoned cart on the deployment. A hold with no class would be exactly that, so
the column is NOT NULL and there is no way to express one.

One live hold per (group, class) by partial unique, so two operators raising the
same hold converge rather than stacking two. A lifted row does not occupy the
index, so a reopened dispute is expressible. A lift is attributable, dated and
explained — all three or none, by CHECK.

### The retention job

`services/guest-governance/retention.service.ts`, bounded and resumable, with a
keyset cursor and not an offset (an offset over a set the pass is DELETING from
skips rows, which is the specific way a retention job silently leaves data
behind).

`guest_retention_runs_counters_total_check` forces
`examined = minimized + deleted + skipped_held + failed`, an EQUALITY and never
`<=` — #60's device. A pass that swallowed a row cannot write a row at all. A
retention job that silently did nothing and one that correctly found nothing
produce identical output otherwise, and the first is the failure this whole
domain exists to make visible.

**`GUEST_RETENTION_DRY_RUN` defaults TRUE**, which is the one default here on the
cautious side of every other rollout lever, because the two errors are not
symmetric: a dry run that should have erased leaves data for another day, and an
apply that should not have erased leaves nothing at all.

**It refuses to run under no published policy.** `GUEST_RETENTION_SCHEDULE` is
what somebody publishes; a job that read it directly would make the published
version decorative and would delete under a rule nobody approved.

---

## Export, deletion and minimization

`services/guest-governance/data-request.service.ts`.

**The proof is the SIGNATURE.** `GuestDataRequestSubject` has exactly two
members — a verified portal grant (#108, inbox proven) or an Oxy account that
completed a claim (#109, two-sided proof). There is no `email` parameter
anywhere in the module, so export requirement 1 ("email alone cannot authorize
an export or deletion") is held by the parameter list rather than by a check
somebody could invert.

**The response never claims full deletion.** Every class is answered
individually and a retained one names its reason from a bounded set. "We deleted
everything" is not a sentence this module can produce, because the receipt is
assembled from the INVENTORY — and a class added to `GUEST_DATA_INVENTORY` with
`retained_under_obligation` appears in the retained half of every future receipt
automatically. A class added with no thought at all still appears, because the
loop is over the inventory and not over a list in the service.

**Nothing exported is stored.** A stored export is a second copy of everything
the request concerned, sitting in a table whose retention is longer than the
data it duplicates. `guest_data_requests` records the request, the proof and the
per-class outcome, and holds no value from any class.

**Three distinct kinds**, because they have different answers: deletion of a
paid checkout is impossible (the order is a financial record) while minimization
of its contact snapshot is exactly what ADR 0003 D15 designed for. Collapsing
them would force the response to say "we cannot delete this" where the honest
answer is "we removed everything we could".

---

## Abuse controls

`GUEST_ABUSE_SCOPES` (ten), `GUEST_ABUSE_AXES` (six),
`GUEST_ABUSE_POLICIES` (six patterns), `GUEST_FRICTION_MEASURES` (three).

**"Without device fingerprinting" is a property of what the domain can be
GIVEN.** `subject.ts` takes a session id, a checkout id, an email hash or a
COARSE network range, and nothing else; `GUEST_FORBIDDEN_ABUSE_SIGNALS` names
twelve signals — device fingerprint, canvas signature, user agent, screen
metrics, guest status, card fingerprint, Stripe Customer grouping, Link
identity, wallet identity, affiliate commission, FAIR acceptance, merchant plan
— disjoint from the permitted axes by a test, and
`guest-governance-isolation.test.ts` scans the whole domain for the reads.

**The SCOPE is in the subject digest's preimage**, which is the subtle half. A
bare `HMAC(key, emailHash)` would produce the same value under
`recovery_request` and under `claim_attempt`, so anybody holding the key could
join a person's recovery attempts to their claim attempts — a per-person
activity profile assembled out of two rate limiters. With the scope in the
preimage the two digests are different values, so the counters bound each action
independently and compose into nothing.

**Friction is explicit, never silent.** Every member of
`GUEST_FRICTION_MEASURES` is something the person is TOLD: a stated cooldown
with an end time the response carries, an email verification, or a manual review
they are told is queued. `GUEST_FORBIDDEN_FRICTION_MEASURES` names silent
failure, shadow ban, ranking demotion, merchant visibility reduction and service
denial without policy — the last two are here rather than in the ranking domain
because THIS is where the temptation lives, and acceptance 6 forbids it.

**The reason codes name the MEASURE and not the threshold.** Three codes
(`abuse_cooldown`, `abuse_verification_required`, `abuse_manual_review`), unlike
`guest_rollout_blocked`'s one code for four levers — and the asymmetry is
deliberate. A rollout lever is an operator's private choice a buyer cannot act
on; friction is something the person must be able to act on, by waiting, by
proving their inbox, or by knowing a human will look.

**The recovery policy is keyed on the NETWORK and never on an inbox**, pinned by
a test. #108 answers every recovery request with the same 202 whether or not an
inbox matched; a counter keyed on `email_hash` would rebuild the enumeration
oracle that uniform answer exists to close, because the COUNT would differ for
an address that exists.

**Every threshold is generous**, and that is a decision rather than timidity. A
control that fires on ordinary behaviour is a control somebody disables, and the
failure it produces — a real buyer told to wait — is worse than the abuse it
prevents at these volumes. The network axis is a /24 or /64, so a shared office
or a carrier NAT is one subject and the thresholds are set against that rather
than against one person.

**Corrections are kept, not deleted.** `false_positive` is a STATE, because "how
often is this control wrong" is a metric the issue asks for and a deleted row
answers it with silence. The measured rate is a LOWER bound and says so: it
counts the false positives somebody complained about and an operator agreed
with, and most people who hit an unjust cooldown wait it out.

---

## Security monitoring

`GUEST_SECURITY_SIGNAL_REGISTER` — sixteen signals, each with a severity, what a
rise MEANS, the correlation handles an alert may carry, and a runbook section.
Runbook: `docs/runbooks/60-guest-commerce-signals.md`, one file with a section
per signal, and a test asserts every anchor RESOLVES — a slug checked only for
its shape is the same failure as no slug, arriving later and looking fine.

**They are COUNTS and not events**, which is a privacy decision before it is an
efficiency one: a row per token-verification failure is both a log of activity
nobody consented to and an amplification primitive whose volume an attacker
chooses. A count answers "is this happening more than usual", which is the only
question an alert asks, and answers "who did it" with nothing.
`guest_security_signal_counters` has no subject column at all, pinned by a
realdb test that reads `information_schema`.

**`recordSecuritySignal` returns `void`** — the analytics sink's device. A
caller has nothing to await, so a monitoring write can never join a request's
critical path. The cost is stated: signal counts are LOSSY under a database
outage, which is acceptable because no number here is financial truth and every
critical signal has a durable record behind it a reconciliation can recount
from.

**`cleanup_lag` is measured by a SWEEP, not by a call site**, because the thing
it measures is an ABSENCE: nothing happens when a retention job stops running,
so there is no code path to instrument. `countSecuritySignal` takes a DELTA
rather than always incrementing by one for exactly that reason.

**The read reports `observed` beside every total.** A signal recorded as zero
and one nothing in the deployment can emit both read `total: 0` and mean
opposite things — the first is a healthy system and the second is a monitor that
would stay silent through the incident it exists for. The register is the outer
loop and the counts are joined onto it, which is what makes an unemitted signal
visible.

---

## Analytics (#77's last guest seam, closed)

**Six of the seven types #107 and #109 reassigned here now emit**, from a
storefront analytics client `packages/frontend/lib/analytics.ts` that #111
built — which is what those two issues said they were waiting for. Each carries
what its contract required: a BOUNDED `GuestPaymentMethodCategory` rather than
the provider's own string, an offer emitted when the claim review screen
RENDERS rather than when the preview endpoint is read, and a decline emitted on
an EXPLICIT dismissal rather than on a preview nobody acted on.

**The seventh will never be emitted.** `guest_payment_verified` moved to
`ANALYTICS_STRUCTURALLY_UNEMITTED_EVENT_TYPES`, which is a stronger statement
than a seam: the seam said "waiting for an issue", the decision says "never, and
here is why". Emitting it would invert `verified-conversion.ts`'s one-way
direction to add a second, weaker source for a number
`guest_verified_payment_conversion` already reads from `payments` — and #111
analytics rule 5 is exactly that: paid state joins from verified payment
records, never from an event.

**That closure re-pointed a gate rather than retiring it.** With the deferred
set empty, a scan over it would have become VACUOUS on the very deploy that
closed the last seam: nothing to look for, no offenders, green forever, and the
one type that must never be emitted guarded by nothing.
`NEVER_EMITTED_EVENT_TYPES` is the union of deferred and
structurally-unemitted, non-empty by construction, and the mutation self-test is
now seeded with `guest_payment_verified` — the right seed precisely because it
will never be implemented, where a merely-deferred seed passes today and starts
failing the day somebody lands it.

**The method category is a real typed COLUMN**, restricted by CHECK to four
event types — the `buyer_origin` device. A method dimension on a discovery event
would let a merchant report be sliced by how somebody paid. It is not a reuse of
`reason_code`, because a method and a refusal are different facts and one column
holding both makes "how many people were shown Apple Pay" unanswerable.

`ANALYTICS_ENVELOPE_VERSION` deliberately does not move: no existing field's
MEANING changed, and the ambiguity a new nullable column normally introduces
cannot arise, because every event type that may carry one was emitted by nothing
before #111.

### The metrics

Ten new definitions, and the naming of two of them is load-bearing rather than
stylistic. `findFinancialSourceViolations` treats any key containing
`conversion`, `checkout`, `payment`, `paid`, `gmv`, `revenue`, `commission` or
`refund` as a claim about money and demands a durable source — and it REFUSED
`guest_cart_to_checkout_conversion` and then `guest_cart_to_checkout_rate`,
correctly. Both halves of that metric are client-observed pre-payment events and
a checkout STARTED is not a purchase, so the keys are
`guest_cart_progression_rate` and `guest_funnel_step_failure_rate`. The money
questions are `guest_checkout_funnel` (from `orders`) and
`guest_verified_payment_conversion` (from `payments`).

**"Platform and market differences" is deliberately NOT a metric.**
`client_surface` and `market` are dimensions every one of these already carries
and every rollup already buckets by, so a separate metric would be the same
numbers under a second name that could disagree with the first.

`guest_express_method_usage` is a WEB measurement and its attribution limit says
so: the native payment sheet does not report which method the buyer pressed, and
inventing one from the offered list would record "card" for every wallet
purchase on iOS.

---

## The rollout gate

`GUEST_ROLLOUT_STAGES` (five), `GUEST_LAUNCH_GATE_REGISTER` (fourteen),
`guest_launch_gate_signoffs` and `guest_rollout_stage_advances` — both
append-only against UPDATE and DELETE by trigger.

**Some gates are CHECKED, not signed.** Four are `automated_check` and are
evaluated against the live configuration rather than trusted from a signature: a
gate a function can decide must not be satisfiable by somebody typing "yes", and
`stripe_architecture_production_ready` is either configured or it is not. The
`AUTOMATED_GATE_CHECKS` record is exhaustive, so adding a fifth automated gate
without deciding how it is evaluated fails `tsc`.

**A withdrawal is a new row saying `no`**, never an edit. The advance gate reads
the LATEST row per (stage, gate), so a withdrawal takes effect immediately and
the history of both decisions survives.

**Refusals are recorded**, because they are the interesting half — a table
holding only successful advances answers "how did we get here" and cannot answer
"what did we try, and what stopped us".

**`metrics_unmeasured` is the vacuity floor**: a deployment where nobody has ever
recorded a sign-off refuses with a different reason from one where the sign-offs
exist and say no. Without it, "no gate is satisfied" and "the sign-off table is
empty" produce the same refusal with opposite next actions.

**Stages advance ONE at a time.** Skipping is refused rather than
permitted-with-a-warning, because every stage's gates exist to be exercised at
that stage — jumping from internal testing to broad rollout satisfies stage 3's
gates without ever having run a canary.

### Two gates are BLOCKED and say so

`transactional_sender_authenticated` — Mercaria has no outbound mail transport
at all. #108's registry is empty and every attempt fails
`transport_unconfigured`, visibly. Until one is registered,
`order_portal_delivery_success` and `guest_recovery_success_rate` read zero, and
the second carries a `seam` field saying why.

`merchant_readiness_includes_guest` — `GuestSellerActivation` has no `activated`
member until #85 lands.

A gate that cannot be satisfied on any deployment today must NAME what blocks
it, or somebody signs it off to make the dashboard green. A test asserts exactly
these two carry a `blockedBy`.

---

## The operator surface

`/internal/guest-commerce/governance/*`, on the SAME
`GUEST_OPERATOR_OXY_USER_IDS` allow-list #104, #108, #109 and #110 use — not a
seventh. Empty means the whole prefix is not mounted (404, never a 401 that
would advertise it).

| Route | Answers |
|---|---|
| `GET /inventory` | the sixteen classes, the schedule, and which classes an ACTIVE policy covers |
| `POST /retention-policy` | publish the reviewed schedule as a version |
| `GET /retention-runs` | what each pass did |
| `POST /retention-runs` | run one pass now |
| `POST /legal-holds` | pause one class for one group |
| `POST /legal-holds/:id/lift` | attributable, dated, explained |
| `GET /signals` | every security signal over a range, plus the measured cleanup lag |
| `GET /interventions` | the abuse queue and the false-positive rate |
| `POST /interventions/:id/review` | lift, or record a false positive |
| `GET /rollout` | the derived stage, its gates and the advance history |
| `POST /rollout/signoffs` | record a sign-off, or withdraw one |
| `POST /rollout/advance` | ask to move to the next stage |
| `GET /data-requests/:checkoutGroupId` | the erasure audit for one group |

### What it cannot do

- **Erase a guest's data on their behalf.** An erasure is driven by the DATA
  SUBJECT through their own credential; an operator-triggered one would be a way
  for staff to destroy a buyer's records without the buyer asking.
- **Read a subject hash.** The column is protected and it is the one cross-row
  join key this domain has — a trace returning it would let a reader ask "what
  else did this subject do", which is the correlation the per-scope preimage
  exists to prevent.
- **Publish a retention FIGURE.** `POST /retention-policy` takes a version
  string and nothing else; the rules come from the reviewed code constant. A
  body able to carry figures would let an operator publish a schedule no
  reviewer had seen, which is what versioning exists to prevent.
- **Clear a counter, set a gate satisfied, or skip a stage.**

---

## Environment

```
GUEST_ABUSE_CONTROLS_ENABLED=false   # may friction be APPLIED; counters are unaffected
GUEST_ABUSE_SUBJECT_HASH_KEY=        # REQUIRED by the flag above (half-configuration rule)
GUEST_RETENTION_JOB_ENABLED=true     # gates the LOOP only
GUEST_RETENTION_BATCH_SIZE=500
GUEST_RETENTION_POLL_INTERVAL_MS=900000
GUEST_RETENTION_DRY_RUN=true         # the cautious default, deliberately
GUEST_SIGNAL_WINDOW_SECONDS=300
```

`GUEST_ABUSE_CONTROLS_ENABLED` defaults OFF, unlike the three guest levers that
default on, and the discriminator is whether the flag demands a SECRET.
`GUEST_COMMERCE_ENABLED` and `SUPPLIER_PREFLIGHT_ENABLED` both do and both
default off: a flag that defaults ON and demands a key it has not been given
makes every unconfigured deployment log an error at boot about a feature nobody
asked for, and an error nobody can act on is one everybody learns to scroll
past.

An unkeyed subject digest is an offline ORACLE over "has this address bought
anything" — the preimages are an email, a checkout id and a /24, three spaces
small enough to enumerate exhaustively — which is why the key is demanded rather
than defaulted.

---

## The production-readiness checklist

1. Populate `GUEST_OPERATOR_OXY_USER_IDS`, or none of the above is reachable.
2. Set `GUEST_ABUSE_SUBJECT_HASH_KEY` and turn `GUEST_ABUSE_CONTROLS_ENABLED`
   on. Until then no counter is written and no friction is applied.
3. `POST /governance/retention-policy` once, to publish the reviewed schedule.
   Until a version is ACTIVE the retention job refuses every pass and says
   `policy_missing`.
4. Leave `GUEST_RETENTION_DRY_RUN=true` for at least one full cycle and read
   `GET /governance/retention-runs`. The counters are what a review reads before
   anything is erased.
5. Record the privacy and retention review (`docs/analytics.md` §"The privacy
   and retention review", plus this document's inventory and schedule) and the
   security review. Both are launch gates and both need a person.
6. Wire scraping and alerting for the `critical` signals in `oxy-infra`. The
   endpoint is JSON and the counters are process-independent; nothing here
   scrapes itself.
7. Record sign-offs and request the stage advance. The gate refuses with the
   exact list of unsatisfied gates, and the refusal is recorded.

**Two gates cannot be satisfied today** — the transactional sender and merchant
readiness — so stage 1 is unreachable until an outbound mail transport exists
and #85 lands. That is stated in the register rather than left to be discovered.
