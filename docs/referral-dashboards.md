# The referral partner dashboard and operator program management (#147)

> Binding decisions: ADR 0005 (`docs/adr/0005-referral-program.md`), especially
> **A5** (partner-visible data), **D14/D15** (payout) and **D19** (rule versions
> pinned at attribution). Prior increments: #142 (model), #143 (attribution
> edge), #144 (versioned rules), #145 (earnings ledger), #146 (enrollment and
> the payout rail).

**NO new tables and NO migration.** Everything here is a projection over rows
#142–#146 already own, plus two things a projection needs and none of the parts
could supply: a disclosure floor, and a statement of what every figure means.

---

## What #146 left behind, and what #147 is

Six partner-safe projections had existed since #142 with **zero consumers**:
`ReferralProgramPartnerView`, `ReferralCodePartnerView`,
`ReferralLinkPartnerView`, `ReferralAttributionPartnerView`,
`ReferralRewardPartnerView` and `ReferralPayoutBatchPartnerView`. Four services
that create, retire and revoke instruments were mounted on **no HTTP route at
all**, and so were all seven program-lifecycle services. A partner could enrol,
accept terms and complete a tax questionnaire, and then had no way to see a
link, a number or a payout.

This is the composition that consumes them.

---

## The owner is a PARAMETER, and that is the whole access model

Everything partner-facing hangs off #146's `makeReferralPartnerRouter`, which
takes its owner resolver from the MOUNT. There are exactly two mounts and
neither is new:

| Mount | Who the owner is | Who answered "may you act for them" |
|---|---|---|
| `/referral-partner/*` | `getRequiredOxyUserId(req)` | Nobody needs to — the owner IS the caller |
| `/admin/stores/:storeId/referral-partner/*` | `req.store.id` | `loadStore` + `requireStorePermission('store:manage')`, before a referral module runs |

#147 adds **nine routes to that router and no third mount**. The consequences
worth stating:

- **No request in the domain carries a partner id.** Not a route parameter, not
  a query string, not a body field. `referral-dashboard-isolation.test.ts`
  WALL 6 scans the controller for `req.params.partnerId`, `req.query.partnerId`,
  `req.body.partnerId` and the owner spellings, with a vacuity floor asserting
  the file really is the one that mounts the routes.
- **The two routes that name an INSTRUMENT compare it against the resolved
  owner** (`assertOwnsCode` / `assertOwnsLink`) and answer ONE
  indistinguishable 404 for "not yours" and "does not exist". A distinguishable
  answer enumerates other partners' instruments — the `/sellers/:oxyUserId`
  oracle, one domain over.
- **There is deliberately no `GET /partners/:id`, no `?partnerId=`, no export of
  another partner's figures and no "compare me to other partners".** Each would
  be a third way of deciding whose earnings these are.

---

## The disclosure floor

**`REFERRAL_PARTNER_DISCLOSURE_FLOOR = 10`**, and it is #77's number rather than
a new one: the merchant analytics surface suppresses below ten for the identical
risk, and a second figure here would be a second answer to one question decided
by whichever surface a reader opened.

### It applies to two dimensions, not six

`REFERRAL_SUBJECT_REVEALING_DIMENSIONS` is `market` and `client_surface`. The
line is **whose fact is the dimension**: a program, a campaign, a code, a date,
a conversion type and a payout period are facts about the partner's own
promotion or Mercaria's own accounting; a market and a device are facts about
the person who arrived.

Applying it to the other four would be INCONSISTENT rather than private. ADR
0005 A5 already publishes per-reward `{date, state, net amount, source,
campaign}`, so a partner can count a single conversion on a single day off their
own earnings list — and a floor withholding the same number one tab over is a
gate whose cheapest green is to delete it (#82's
`PRICE_SIGNAL_MIN_DISTINCT_SELLERS_FLOOR` reasoning).

### Suppression DROPS the row, key and all

The obvious shape — publish every key and replace a small count with a
`withheld` marker — leaks the thing the floor exists to protect. `{market: 'AD',
count: withheld}` tells a partner they referred somebody in Andorra, which is
exactly what a count of one would have told them.

A `ReferralCountDisclosure` union was written first, with a `withheld` branch
carrying no number so a client could not render it as zero. Right device, wrong
problem: it would have shipped a mechanism that reads as protection while
publishing the key. **There is no such union.** Every published count is a plain
number and the invariant is that a published row cleared the floor.

### And the residual is a leak too, so suppression is COMPLEMENTARY

`totals` is published beside the rows, so subtracting the survivors recovers the
suppressed mass exactly. With ONE row suppressed that mass IS the row, restored
in full. So:

1. drop every row under the floor;
2. if exactly ONE fell, drop the smallest survivor as well;
3. if nothing publishable is left, withhold the whole breakdown
   (`insufficient_population`) — the totals still go out, because with no rows
   published there is nothing to subtract them from.

**Why the condition is the COUNT and not the suppressed mass.** The first
version additionally required the suppressed mass to reach the floor, and it was
wrong in a way worth writing down. Given `{ES: 400, FR: 300, AD: 2, GI: 3}` it
dropped AD and GI (mass 5), found 5 under the floor, and took FR as well —
costing a legitimate market with three hundred clicks to hide a residual of five
spread across two cells whose names were never published. It bought nothing:
because the key goes with the row, a subtraction yields "five clicks happened in
markets you cannot see", which names nobody at any mass. What turns that
aggregate back into a CELL is there being exactly one of them.

### The bound this domain claims, stated so nobody has to infer it

> Every published cell clears the floor, and a subtraction over the totals
> yields a sum spread across at least two cells whose keys were never disclosed.

It does **not** claim that sum is large. Two further properties:

- **A row is judged on its LARGER count**, never the sum: nine clicks and nine
  conversions is not eighteen, because each figure on its own identifies
  somebody.
- **Zero is disclosed and a single row above the floor is published.** An empty
  cell identifies nobody, and a partner whose whole audience is in one market
  learns their whole audience is in one market — nine hundred people rather than
  a person. The floor stops an individual being identified; it is not a rule
  against a partner seeing an aggregate they produced.
- **No cross-tabs.** `referralPerformanceQuerySchema` has one `dimension` field
  and no array, so a market × date cell at count one is unrepresentable rather
  than refused.

---

## Six dimensions, not #147's nine

`conversion_type`, `commission_state` and `payout_period` are not breakdown
dimensions here, because **a click carries none of them**. A breakdown offering
them would answer `0` for every click cell, and a zero standing in for "this
dimension does not apply to this measurement" is the quiet zero this domain
refuses everywhere else.

All three are ANSWERED, by the earnings section — which is broken down by state,
whose per-reward rows carry a day-granularity date and a funding source, and
whose payout history is one row per settled batch.
`REFERRAL_PERFORMANCE_DIMENSION_ELSEWHERE` names each and where it went, and a
census test fails the build on a fourth that is neither published nor named.

---

## Every figure names its own definition, and there is no conversion RATE

`REFERRAL_METRIC_DEFINITIONS` is a `Record` over the key union — #77's rule, so
a key added without a definition fails `tsc`. Each carries a numerator, a
window, a SOURCE TABLE and an **attribution limit**, which is the field that
earns its place: it is where a figure says what it cannot see, and it is the
half somebody reconciling their own earnings actually needs.

**There is no conversion rate and none may be added.** #37 acceptance 3 forbids
dividing clicks by conversions and #67 gives the reason in the affiliate domain:
a conversion is revisable for weeks (here, a 60-day hold plus every refund that
shrinks its base) while a click is not, so the ratio moves without either input
being wrong. It is additionally not a rate over one population — ADR 0005 D4
admits a code typed at checkout as a touch, so a conversion can exist with no
click behind it. The two counts are published side by side; anybody who wants
the ratio takes it knowingly.

---

## The earnings figures reconcile, and say so when they do not

Per-state amounts come from `referral_rewards` (a state is a property of a
reward); the outstanding and settled positions come from `ledger_entries`
(#145 acceptance 1 makes the ledger the authority and there is no balance
table). Two stores that must agree without something comparing them is a
discrepancy nobody notices — which is why #145 ships a sweep at all.

`ledgerAgrees` runs that comparison at the moment a partner looks and **repairs
nothing** (the `payment_discrepancies` posture). A read surface that quietly
corrected a mismatch would be rewriting financial history to make a screen look
tidy.

Nothing on the surface is forgeable by a client (#147 acceptance 2): every
figure is read from a table no client can write, and there is no amount, count,
state or currency field on any request schema in the domain.

---

## Percentage copy always names its base (#147 acceptance 7)

`ReferralRewardBasisCopy`'s percentage branch has a **non-optional**
`percentageOf`, so a client rendering `20%` with nothing after it has no shape
to read the number out of without also holding the sentence. The sentences live
in `REFERRAL_FUNDING_BASE_COPY`, keyed on the funding SOURCE, because the source
IS the base (ADR 0005 "The reward-base contract").

`not_published` is a real third branch: a program can be live for attribution
while its rule is a draft, and rendering `0%` there would tell a partner they
earn nothing rather than that nothing has been published.

Nothing implies a guaranteed earning (#147 programme rule 7): the projection
carries a rate and a cap and has no field a projection, forecast or "typical
partner earns" figure could go in.

---

## Operator program management

`/internal/referrals/programs*` and `/internal/referrals/program-versions/*`, on
the **SAME `REFERRAL_OPERATOR_OXY_USER_IDS` allow-list** #143 and #145 use, not
an eighth. Empty means the router is not mounted — 404, never 401.

- **"No operator can edit an active rule version in place" (#147 acceptance 4)
  is enforced by #142's repository, not by a controller check**:
  `updateProgramDraft` carries `status = 'draft'` in its WHERE, so a published
  version matches nothing. The schema helps by having no `status`, `version`,
  `publishedAt` or `approvedByOxyUserId` field to carry.
- **The approver comes off the credential** and there is no field for one.
- **`programId` is MINTED by the service**, never supplied: it is what every
  version of a program shares, and a caller-supplied one is a caller-supplied
  collision with somebody else's version chain.
- **`endProgram` is new and was a real gap.** `program_ended` has been in
  `REFERRAL_EVENT_ACTIONS` and `ended` in `REFERRAL_PROGRAM_STATUSES` since
  #142, `transitionProgramStatus` already stamped `ended_at`, and nothing
  performed the transition. It is DISTINCT from `retireProgram`: `ended` is
  "this program has stopped running", `retired` is the archival decision that
  follows.
- **Pausing strands nothing (#147 acceptance 5)**, and it is a property of the
  IMPORT GRAPH rather than a promise: `program.service.ts` imports nothing from
  the earnings domain, so no lifecycle transition can reach a reward, a batch or
  a ledger entry. ADR 0005 D18 makes all four prospective.
- **The route set is CLOSED**: no "edit this active version", no "set this
  program's status", no "delete this version", no "backdate this effective
  start", no "move this partner to that program".
- **Utilization is DERIVED** and there is no utilization table — #144's own cap
  enforcement declines a running-total row for the same reason. It is
  operator-only by PLACEMENT: no partner-facing module imports it, and a scanned
  gate fails the build if one starts to. A campaign's remaining headroom is
  Mercaria's marketing position; a partner's own ceiling is published to them as
  a LIMIT.

---

## The six walls

`services/referrals/__tests__/referral-dashboard-isolation.test.ts`, each with a
vacuity floor and a mutation self-test:

1. no partner-facing module imports the operator-only utilization read — **and
   the operator controller does**, so the wall is not vacuous;
2. no partner-facing module names a buyer-shaped field;
3. the RUNTIME projection walk finds a forbidden field at any depth,
   case-insensitively;
4. the performance dimensions are disjoint from the fourteen forbidden ones, and
   the three that left are accounted for;
5. every metric key has a definition stating all five parts, and no key names a
   rate;
6. no partner route can name a partner.

Plus the second gate #92's rule requires: `referral-dashboard.realdb.test.ts`
walks a **genuinely composed** dashboard against a real server, with a POSITIVE
CONTROL — the same emitted response with one field added, which the walker must
find — because "I found no forbidden field" and "I walked nothing" produce the
same empty array.

---

## What #147 does NOT build

Named as VALUES the client switches on (`ReferralSupportUnavailableReason`)
rather than left to this document, because the alternative a UI reaches for is a
support entry point that leads nowhere:

- **`dispute_thread_not_built`** — #147's "Referral support and disputes"
  section. A dispute thread needs its own tables (a thread, its messages, its
  evidence, its decision and its appeal, each append-only with an actor and a
  reason) plus an operator queue to work it. That is #110's shape one domain
  over and is not a projection, which is what made it separable from everything
  above. A partner CAN still appeal a suspension or termination — that is
  #146's `POST /appeal`, and `support.appealAvailable` says when it is open.
- **`evidence_attachment_not_built`** — needs the digest channel #110 and the
  moderation domain both record as missing.
- **`outbound_notification_transport_not_configured`** — #108's registry is
  still empty and Mercaria still has no outbound mail. #147's "notify the
  partner of state changes" is that seam, unchanged.

Also deliberately absent:

- **Review QUEUES** (#147's twelve). Five of them — suspicious attribution,
  self-referral candidates, commission exceptions, fraud intervention, velocity
  breaches — are **#148's**, which is landing in parallel, and building a queue
  over a vocabulary that issue owns would be two answers to one question. The
  rest are already reachable: applications through
  `/internal/referrals/partners`, discrepancies through
  `/internal/referrals/earnings/discrepancies`, batches through the payout
  routes.
- **Compliance and finance EXPORTS** (#147 operator item 12). #82's CSV export
  is the precedent to copy, including its leading-`=`/`+`/`-`/`@` guard.
- **#77 analytics emission.** #147's "Analytics" section defines ten measures
  and this increment emits none; the seam is `services/analytics/seams.ts`,
  unchanged. Every measure it names is derivable from rows that already exist.
- **The dashboard-app (merchant) SCREENS.** The store mount already serves the
  whole surface at `/admin/stores/:storeId/referral-partner/*`; what is missing
  is a screen in `packages/dashboard`, not an endpoint.
- **Instrument CREATION from the storefront screen.** The endpoints exist
  (`POST /codes`, `POST /links`) and the client functions and mutation hooks are
  written and typed; the screen renders the list, the status and the disclosure
  and has no create form yet.
