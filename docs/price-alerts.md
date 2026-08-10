# Product and variant price alerts (#79)

One buyer says "tell me when this goes under 500", and receives exactly ONE
useful notification when a current, eligible offer satisfies it.

Schema decisions: `db/schema/CONVENTIONS.md` §"Price alerts (#79)". Upstream:
#44 (money and FX), #57 (the offer), #68 (freshness and the priority refresh),
#74 (eligibility, the converted cost and the quote behind it), #78 (the
immutable observation a trigger cites), #90 (the condition SEGMENT an alert is
scoped to), #59 (merge and split), #80 (the seam this closes).

---

## The failure mode that shapes everything here

**Telling somebody the same good news twice, or telling them about a price
nobody can still pay.** Four shapes of it, and every decision below exists to
make one of them unrepresentable:

1. A feed republishes the same number every night and the buyer is notified
   every night, because the trigger's identity had a clock in it.
2. A "total including delivery" that treats an unpublished delivery cost as
   free, which notifies about the offer that told you least.
3. A notification that arrives after the price has gone, linking to a
   destination that has moved, sold out or changed — and no record anywhere that
   Mercaria knew.
4. A converted figure with no rate behind it, so nobody can say afterwards
   whether the alert was right.

---

## The identity of a qualifying observation

`priceAlertTriggerKey` names FOUR facts and no fifth — the alert, the offer, the
OBSERVED-PRICE VERSION and the alert policy version — and
`price_alert_triggers_identity_key` is rendered from exactly those four columns.

- **The observed-price version is `offer_price_snapshots.id`** — #78's immutable
  record of what the source said. It is what makes "the same price, re-read"
  recognisable. A key without it fires once and never again; a key using a
  TIMESTAMP instead fires on every sweep, which is the same bug pointed the other
  way.
- **There is no clock and no evaluation-run id in it.** A duplicate source event,
  a scheduled FX re-check and two concurrent workers are all one question.
- **A qualifying price with no observation behind it BLOCKS**
  (`no_observed_price_version`) rather than triggering with a NULL. Postgres
  treats NULLs in a unique index as distinct, so a NULL there would mean every
  evaluation inserted another row.
- **The convergence is the DATABASE's.** `insertPriceAlertTrigger` is
  `ON CONFLICT DO NOTHING … RETURNING`, and the empty result IS the "already
  notified" answer. A read-then-write would let two workers both see "no".

---

## Evaluation

### It is driven by durable offer-change events, and the enqueue is free

The two places an offer's terms are observed — `recordExternalOffer` and
`convergeNativeOffersForListing` — enqueue a row into `price_alert_evaluations`
in the SAME transaction. So a rolled-back write leaves no job for a change that
never happened, and no change that happened can be missed.

The enqueue's first statement is a GATE: one indexed `exists` against
`price_alerts` for the offer's product, which resolves the product id at the same
time. A catalogue nobody watches costs exactly that predicate and writes no row —
which is what lets this sit on the hottest write path in the system.

### One row per SUBJECT, and it converges

`offer_outboxes`' shape, not the moderation outbox's: an evaluation delivers a
FIXED POINT ("whatever the offers look like when you run, decide against that"),
so forty writes on one popular product in a second owe ONE run. That is issue
abuse rule 2's batch fan-out expressed as an enqueue rather than as a batching
layer. `DO NOTHING` would silently drop the thirty-nine that arrived while one
was pending, including the one that crossed somebody's target.

The `requested_revision` / `claimed_revision` pair is what stops a write that
lands mid-run being swallowed by the completion that follows it, and the enqueue
must NOT write a flat `'pending'` over a `processing` row — that releases a live
lease from outside the worker (measured in #57).

### The comparison is a RE-RUN of #74, immediately before triggering

`listOffers` → `buildRankingFactContext` → `selectEligibleOffers` are #57's and
#74's own functions, called exactly as `/offer-comparison` calls them. So a
listing a jury restricted a second ago, an offer whose source contract has
lapsed, a suppressed merchant and an offer whose currency cannot be quoted are
all refused by the domains that own those facts, at the moment of triggering.

There is no second copy of any of those rules in this domain, and
`price-alert-isolation.test.ts` fails the build if one appears. In particular:
**this domain defines no TTL, no staleness rule and no freshness lifetime** —
#68's per-source policy is the single authority, and "an old price cannot fire a
new alert" is already true of anything obtained through `mayAppearInComparison`.

Alerts are GROUPED by the only two things that change the comparison — the
currency and the market. The condition segments and the seller scope narrow
WITHIN one comparison and are applied per alert, so a popular product with forty
alerts in one currency reads its offers once.

### Unknown never satisfies anything

Three places, each of which would otherwise read silence as a yes:

- A `known_total` alert is answered from #74's `OfferComparisonTotal`, whose
  unknown branch has NO amount. An offer whose postage nobody published cannot be
  compared at all — issue evaluation 5 and acceptance 2, held by the type.
- `availabilityRequirement: 'in_stock'` needs a POSITIVE statement. Most feeds
  publish none and #57 records that as `unknown`.
- `minimumAvailableQuantity` needs a published quantity. An absent one is not
  "enough".

An offer whose condition wording did not map has no segment at all (#90), and a
segment-scoped alert therefore does not match it.

### Repeat policies

Issue §"Trigger identity" admits three repeat conditions, and the union is those
three plus the default of not repeating:

| policy | fires again when |
|---|---|
| `once` | never. The alert moves to `triggered`. |
| `reset_threshold` | an evaluation OBSERVED the best in-scope amount above the threshold since the last notification |
| `cooldown_better_low` | the cooldown has elapsed AND the new amount is materially below the one that fired (1%, floored at one minor unit) |
| `always` | the buyer chose repeated notifications |

Whether a `reset_threshold` alert is armed is `rearmed_at > last_triggered_at` —
two timestamps that each record a real event. There is no `armed` boolean beside
them, because two representations of one fact can disagree.

The re-arm runs on EVERY evaluation, qualifying or not, and that is the point: an
alert re-arms because the market climbed back, which is a fact about a price that
did NOT qualify. Re-arming only from a qualification would make repeat rule 1
unreachable.

A reset threshold at or below the target is refused by a CHECK: a price under the
target could never cross back above it, so such an alert is `once` under another
name.

---

## FX, and what "reproducible" means

`price_alert_trigger_quotes` is one row per component actually converted,
`UNIQUE(trigger_id, component)`. `insertPriceAlertTrigger` is the SINGLE writer
and refuses a mismatch before issuing SQL — "a quote exists exactly when a
conversion happened" is CROSS-ROW and no CHECK can see it, so this is the
`insertRetailCostQuote` device.

- A `known_total` legitimately converts TWO components from two source
  currencies, which is why the quotes are a child table and not ten columns.
- A same-currency conversion records NO quote, and a CHECK refuses one: a row
  saying nothing happened is not evidence.
- The trigger stores the offer's own NATIVE amounts beside the compared amount,
  so `native × rate == amount` is checkable after the fact. A realdb case asserts
  exactly that.

---

## Delivery

### Separate durable jobs, and the direction that matters

`price_alert_notifications` is the delivery job (issue evaluation 10). The
consequence people usually state is that a failed send does not lose the
qualifying event; the one that matters more is the reverse: a delivery retried a
hundred times re-reads THIS row and never the price, so acceptance 6's "delivery
retry never reruns price evaluation or creates duplicate triggers" is a property
of the IMPORT GRAPH — the delivery modules import no comparison, no qualification
and no trigger writer, and a scanned gate fails the build if that changes.

The id is `sha256(triggerId + ':' + channel)` — deterministic, so a repeat
converges on the same row rather than queueing a second message about one piece
of news.

### The destination is re-checked, and a withholding leaves a ROW

Before sending, the offer is re-read and put back through #74's OWN
`evaluateOfferEligibility` — the same derivation the comparison used, not a
second copy. It answers one question and produces no trigger.

A failure there is `suppressed` with `destination_no_longer_eligible`, terminal,
with a row. "How many notifications did we withhold because the price had already
gone" is issue operations 3's stale-link measurement and a table of messages that
were SENT can never answer it.

### Quiet hours DEFER and never drop

A notification inside the buyer's quiet window goes back to the queue with
`available_at` at the end of it, keeping its attempt count and its identity. A
dropped alert is indistinguishable from one that never qualified, which is the
whole reason the job is durable. The window is evaluated in the buyer's own IANA
zone with `Intl` and never with an offset — an offset is not a zone and is wrong
twice a year. A zone the runtime does not recognise answers "not quiet" rather
than withholding indefinitely.

### The channels

`oxy_notification` is the ecosystem channel: `lib/notification-service.ts`, which
already carries a `price_alert` type and fans out to the in-app feed, Expo push
and Web Push. The row is committed BEFORE any channel is attempted, so a buyer
with no push registration still finds the alert in their feed — and the
per-channel outcomes it records are what stop this domain claiming a push
succeeded when none was registered (acceptance 7).

**`email` is representable and UNSENDABLE.** Mercaria has no outbound mail
transport and stores no email address for an Oxy buyer at all — copying one out
of an Oxy profile would create exactly the profile mirror ADR 0003 D15 says does
not exist. `services/price-alerts/transport.ts` carries an EMPTY registry and
every attempt fails `transport_unconfigured` VISIBLY, with the row intact. #108
made the same call for the guest portal:

> A `console.log` transport looks like a working feature in every test and sends
> nothing in production; an SES client against unprovisioned credentials looks
> like one in production and fails like an outage.

Closing it is one module plus one `registerPriceAlertEmailTransport` call — and a
decision about where the address comes from, which is why it is not merely a
missing dependency.

### What the buyer is told

`priceAlertNotificationPayload` is the ONE composition and its field list IS the
allow-list, walked at runtime against `PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS`
by a real emitted payload.

It names the canonical product, the qualifying VARIANT, the offer, the amount,
the target, the basis, the condition segment and whether the buyer can complete
the purchase on Mercaria (issue notification 4 and 5). It carries **no URL of any
kind**: an outbound address stored in a notification is precisely the
"now-unvalidated destination" notification 3 forbids, and #37's redirect exists
so the destination is composed when somebody clicks and not before.

The product's NAME is deliberately absent too — the composition is pure and a
name is a database read, and a stale copy of one in a push payload is the field
that would go wrong silently.

Locale is ECHOED and never used to translate: Mercaria has no server-side i18n
runtime, every notification in this codebase composes English and carries
structured `data`, and pretending otherwise would mean shipping a translation
table nobody reviews.

---

## Merge and split

- **A MERGE rehomes an alert.** `merge-plan.ts` declares every column in an
  `alerts` phase, so the census forces a decision when a new one appears. The
  subject, the split target, the variant, the merchant and the storefront scopes
  all `repoint` unconditionally (nothing is unique on them, and a scope left on a
  tombstone matches no offer and the alert silently stops firing). Triggers are
  `retained_by_tombstone`: a trigger is the immutable record of what was
  observed, and repointing it would rewrite it.
- The PROVENANCE stamp runs BEFORE the generic rehomer and is scoped to the
  LOSER, because `applyRehomeTarget` sets a column to the WINNER and a stamp
  applied afterwards could not tell the alerts that just moved from the ones that
  were always there.
- The phase enqueues an evaluation for the WINNER afterwards: the rehomed alerts
  have never been judged against its offers.
- **A SPLIT marks and PAUSES.** #80's saved-product decision plus one thing more:
  a save on the wrong side of a split shows somebody the wrong page next time
  they look, and an alert on the wrong side would go and tell them about a
  product they may never have been watching. Deterministic migration was refused
  for #80's reason — "keep it where it is" is silently wrong for exactly the
  buyers whose interest moved.
- The marking is idempotent by predicate and an alert already ambiguous from an
  EARLIER split keeps naming that job: retargeting an unanswered question at a
  newer one destroys the pair of candidates the buyer was being asked about.
- The buyer answers with `keep_source`, `move_to_target` or `keep_both`. A
  variant preference does NOT survive: the configuration it named may have moved
  to the other side.

---

## Privacy, abuse and operations

- **Nobody can ask who is watching a product.** There is no route, no operator
  handle and no repository function that takes a product, a merchant or an
  account. The one read by product exists because the evaluator must have it and
  returns rows to a worker inside the process. Issue abuse rule 6 is held by the
  question being unrepresentable.
- **No contact of any kind is stored** — not an address, not a hash, not a push
  token. A scanned gate covers the whole domain.
- **Two abuse axes, both durable in Postgres**: how many alerts an account may
  hold (200 by default) and how fast it may create them (60 an hour). "Across
  every ECS task" is not a question a per-IP bucket can answer — #83's device.
  The network axis is the ordinary `'listings'` rate-limit scope, because every
  route here is keyed on a catalogue id or the caller's own alert id.
- **Deleting an alert is a STATE**, so a queued delivery naming it can say
  `alert_deleted` rather than fail on a missing row, and a repeat DELETE
  converges. ERASURE is one scoped hard delete, and `oxy_user_id` is the whole of
  what this domain stores about a person.
- **Operator surface** `/internal/price-alerts/*` on the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/#62/#68/#78/#80
  use — an alert points at a canonical product and is decided from the
  catalogue's own offers. TWO reads and ONE write, and the write DRIVES the
  existing idempotent evaluation. There is deliberately no "trigger this alert",
  no "send this again" and no "delete this trigger".
- The metrics are issue operations 3's four — evaluation lag, trigger count,
  delivery rate and stale-link suppression — plus `neverEvaluated` and the queue
  counters, which are the VACUITY floors: a subject with forty alerts reporting
  zero evaluated is a broken read, and a table of triggers can only ever show the
  runs that produced one. Ages are ABSENT rather than zero when nothing is
  outstanding.

---

## Environment

```
PRICE_ALERTS_ENABLED=false                  # the buyer MOUNT
PRICE_ALERT_EVALUATION_ENABLED=false        # the evaluation LOOP
PRICE_ALERT_NOTIFICATIONS_ENABLED=true      # the GLOBAL notification kill switch
PRICE_ALERT_MAX_ACTIVE_PER_USER=200
PRICE_ALERT_CREATE_RATE_LIMIT=60
PRICE_ALERT_CREATE_RATE_WINDOW_MS=3600000
PRICE_ALERT_EVALUATION_BATCH_SIZE=20
PRICE_ALERT_EVALUATION_POLL_INTERVAL_MS=15000
PRICE_ALERT_EVALUATION_LEASE_MS=120000
PRICE_ALERT_EVALUATION_MAX_BACKOFF_MS=3600000
PRICE_ALERT_EVALUATION_OFFER_LIMIT=50
PRICE_ALERT_NOTIFICATION_BATCH_SIZE=50
PRICE_ALERT_NOTIFICATION_POLL_INTERVAL_MS=10000
PRICE_ALERT_NOTIFICATION_LEASE_MS=60000
PRICE_ALERT_NOTIFICATION_MAX_BACKOFF_MS=21600000
PRICE_ALERT_NOTIFICATION_MAX_ATTEMPTS=8
PRICE_ALERT_TRACE_LIMIT=100
```

**`PRICE_ALERT_NOTIFICATIONS_ENABLED` is issue operations 5's global kill switch,
independent of alert storage**, which is why it is a third lever rather than a
branch of the first: with it off, alerts keep being evaluated, triggers keep
being written and delivery rows keep being queued — nothing is lost and nothing
is sent, and flipping it back drains the backlog in queue order. It defaults ON,
unlike the two rollout levers beside it, because an incident lever that ships in
the off position is a feature nobody notices is missing.

**NOT ONE of the three gates a durable record**, and a scanned gate fails the
build if a repository or the evaluator learns to read one.

With every default in place a deployment stores no alerts (the surface is not
mounted), evaluates nothing and delivers nothing.

---

## Tests

- **`services/price-alerts/__tests__/price-alert-rules.test.ts`** — the pure
  rules. The fixtures are chosen to exercise the distinctions: a `known_total`
  against an unpublished delivery cost AND against a published ZERO, a
  `reset_threshold` re-armed before and after its last trigger, a cooldown that
  has elapsed with an improvement of one minor unit, a quiet window that WRAPS
  midnight, and an eight-decimal currency in the improvement floor.
- **`services/price-alerts/__tests__/price-alert-isolation.test.ts`** — the six
  scanned walls plus the disjointness and the runtime payload walk, each with a
  vacuity floor and a mutation self-test.
- **`services/__tests__/price-alerts.realdb.test.ts`** — the eight acceptance
  criteria and the CHECKs, against a real server. The one to read is
  `price_alerts_last_triggered_shape_check`: its first spelling was
  `(a is null) >= (b is not null)`, which reads like an implication and evaluates
  to the opposite one — it rejected every trigger the domain wrote, and `tsc`
  and every mocked insert accepted it.

---

## What is deferred, and to whom

Each is a NAMED contract, never a stub that lies.

- **An outbound mail transport.** The `email` channel, the opt-in column, the
  queue row, the retry, the failure code and the operator metric all exist and
  all work; nothing sends. See §"The channels".
- **#93 — proximity.** `PriceAlertProximityScope` carries `nearby_pickup`, the
  column and the CHECK exist for it, the evaluator blocks with
  `proximity_scope_unsupported`, and the write schema refuses the value BY NAME
  so nobody can create an alert that could never fire. #74's
  `resolvePickupProximity` is what has to start answering.
- **#68's priority refresh.** `requestPriorityRefresh(reason: 'alerted')` is
  published and this domain does not call it: the evaluation queue is fed by
  offer WRITES, so an alert never needs to ask for a re-read to be correct. What
  it would buy is LATENCY on a source with a slow cadence, which is a measurement
  nobody has taken. Wiring it is one call from the enqueue path.
- **#77 — measurement.** No analytics event is emitted. The metric this domain
  can already answer (how many alerts, how many triggers, what fraction was
  delivered) is on the operator surface; an event stream would need a definition
  in `ANALYTICS_METRIC_DEFINITIONS` and a decision about what a per-alert event
  says about a person.
- **#71 — the canonical product page**, which is the natural place a "watch this
  price" control belongs. The storefront ships the account list, the create form
  and the saved-list entry point; the product page's own affordance arrives with
  the page.
- **A watchlist** (#81) is a different thing and this domain has no field for
  one.
