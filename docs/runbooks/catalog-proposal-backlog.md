# Runbook — catalog proposal backlog (#367 W17)

Merchants and operators are asking for taxonomy concepts — a category, a product
type, an attribute, a value — faster than anybody is deciding them. Reference:
[../catalog-observability.md](../catalog-observability.md) and
[../catalog-proposals.md](../catalog-proposals.md).

**The number to alert on is the AGE, not the depth.** A deep queue being worked
through is healthier than a shallow one that has stopped, and only an age can
tell them apart.

**There is NO review-time SLA target, and this runbook does not invent one.**
Nothing in the repository defines how long a proposal may wait;
`proposal_sla_breach_count` is DEFINED and reports `unmeasured` with reason
`policy_target_undefined` for exactly that reason, and
`GET /internal/catalog-metrics/proposal-queue` says so in `sla.statement`. So the
threshold in the table below is one whoever wires the alert has to CHOOSE, and
the honest thing to do is write it down where it can be argued with — see
[../catalog-observability.md](../catalog-observability.md) §"What is not
measured, and why" item 8 for what would close the gap properly.

**Owner:** whoever owns the catalogue review desk. This is a staffing alert far
more often than an engineering one.

---

## The alert

| Signal | Where | Condition |
|---|---|---|
| `proposal_awaiting_operator_oldest_age` | `GET /internal/catalog-metrics` → `.data.readings[] \| select(.key=="proposal_awaiting_operator_oldest_age")` | **the one to alert on.** The oldest `submitted` row — Mercaria's own worst response time, with the two waits that are not Mercaria's excluded. `numerator` is how many are in that state; a `numerator` of 0 means no age is reported at all, which is a healthy empty queue and not an age of zero |
| `proposal_backlog_oldest_age` | same report | the oldest of ALL open states. Useful, and dominated forever by one proposal parked on a merchant who never replied — which is why it is not the primary signal |
| `proposal_backlog_awaiting_operator_count` | same report | the share of the backlog that is Mercaria's to answer |
| `proposal_backlog_awaiting_submitter_count` | same report | `needs_information` — open, and NOT Mercaria's |
| `proposal_backlog_deferred_count` | same report | every deferral, whether its date has passed or not |
| `proposal_backlog_count` | same report | the three above SUM to it exactly; read as depth only TOGETHER with an age |
| `proposal_creation_count` | same report | `rolling_7d` arrival rate. A rise is context, not a fault |
| `proposal_decision_count` | same report | `rolling_7d` SERVICE rate. Read against the arrival rate: a backlog is a stock and neither number alone says whether it is growing. OPERATOR decisions only — a withdrawal stamps no `decided_at` |
| `proposal_sla_breach_count` | same report | **always `unmeasured`.** Render it as "no target defined", never as "0 breaches" |

All of them are `count`/`age_seconds` kinds with source `catalog_proposals` and a
declared freshness of 300 seconds.

The shape behind them — depth and oldest age per state, the waiting-age
distribution and the percentiles — is one call:

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics/proposal-queue | jq '.data'
```

Two fields on it MUST be `true` and `0`; if either is not, stop and read
[../catalog-observability.md](../catalog-observability.md) §"The proposal review
queue" before trusting any number here. `countsAgree: false` means a proposal
carries a state this build does not know about, so the backlog is quietly short.
`unbandedOpenCount` above zero means an open proposal has a `created_at` in the
FUTURE, or the age bands have developed a gap — either way the distribution is
missing rows.

## What it means

`catalog_proposals` rows are sitting in an OPEN state.
`CATALOG_PROPOSAL_OPEN_STATES` is `submitted`, `needs_information` and
**`deferred`** — an operator saying "not now" has not decided, and a draft
carrying a deferred proposal is still carrying an unanswered question. The metric
reads that one tuple, which is the same tuple the convergence index and the
publication gate read, so "is this proposal still open" has one answer.

Downstream, a merchant may be blocked: a product-type version whose
`pending_proposal_policy` is `block_publication` will not let a draft publish
while a proposal it depends on is open.

## What it does NOT mean

- **Not that the taxonomy is missing concepts.** `proposal_creation_count`'s own
  attribution limit says it: a rise can mean the taxonomy is missing concepts OR
  that more merchants are authoring, and the metric does not separate them. The
  completeness metrics (`taxonomy_completeness`, `product_type_completeness`) are
  the other half of that question.
- **Not that anybody is late, when the age is driven by a deferral.** A
  `deferred` proposal with a future `deferred_until` is counted in the backlog,
  and the metric's attribution limit says so explicitly. A planned deferral reads
  as backlog, by design — the alternative is a queue that can be emptied by
  postponing everything.
- **Not a duplicate-submission problem.** Every backlog row is a distinct
  proposal; the domain's own convergence index is what stops one merchant's
  repeated request from becoming several rows.
- **Not resolvable by rejecting in bulk.** `rejected` is TERMINAL and another
  attempt is a NEW proposal, so a bulk rejection does not reduce future volume, it
  multiplies it.

## The first three things to check

**1. Read the age and the depth together.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics \
| jq '.data.readings[]
      | select(.key|startswith("proposal_"))
      | {key, state, numerator, ageSeconds}'
```

`numerator` on the age metric IS the open count, so the two should agree with
`proposal_backlog_count`. An `ageSeconds` absent with a `numerator` above zero
would mean the age read failed; an `ageSeconds` absent with `numerator: 0` is an
empty queue.

`waitAge` on the queue read answers `{ state: "unmeasured", reason:
"population_below_floor" }` whenever fewer than twenty proposals are open. That
is not a fault: below twenty a nearest-rank p95 IS the maximum, so it would
restate `proposal_backlog_oldest_age` under a more authoritative name. The
`agingBands` are exact at any population and are what to read instead.

**2. Read the queue itself, oldest first, and see what is actually in it.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  "https://<api>/internal/catalog-proposals?state=submitted" | jq '.data'
```

The queue endpoint takes state, type and store filters. Ask it for `submitted`,
then `needs_information`, then `deferred` separately — the three need completely
different work, and a single number over all of them hides which.

**3. Read the governance desk, which shows this backlog beside every other one.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-governance/queues \
| jq '.data[] | {kind, coverage, total, unmeasuredReason}'
```

`pending_proposal` there and `proposal_backlog_count` here should agree. If the
desk answers `coverage: "unmeasured"` for a kind, the metrics report carries that
verdict through rather than substituting a zero — read it as "the desk cannot
measure this", not as "nothing to do".

## Likely causes, most likely first

1. **Nobody is reviewing.** The commonest cause by a wide margin, and the metric
   is doing its job. Check the audit trail for the last decision:
   `GET /internal/catalog-governance/audit`.
2. **A wave of deferrals.** `deferred` is open, so deferring twenty proposals
   raises the backlog and the age keeps climbing. Legitimate, and worth knowing
   about — the age is measuring exactly what it says.
3. **Proposals waiting on the submitter.** `needs_information` rows are blocked on
   somebody outside the review team, and Mercaria has **no outbound email
   transport**, so nothing has notified them. Count these separately before
   concluding the desk is behind.
4. **A rollout that widened authoring.** `proposal_creation_count` rising in step
   with the backlog means the desk's throughput has not changed and the inflow
   has. **Read it against `CATALOG_ROLLOUT_COHORTS` first** — the lever ADR 0007
   D12 named `CATALOG_AUTHORING_COHORTS`, built under the wider name. A stage
   that added `store:` or `product_type:` entries, or that emptied the list
   (which means *every* cohort, not none), is the likeliest cause and it is one
   environment variable to check. Then correlate with the audit trail and with
   which stores are submitting.
5. **A merchant blocked by `block_publication`.** Not a cause of the backlog, but
   the reason it is urgent: an open proposal on a version with that policy stops a
   publication.
6. **One store submitting everything.** The queue endpoint's store filter answers
   this in one call, and the remedy is a conversation rather than a decision.

## Remedy

Decide the proposals. Every action is an audited operator POST on
`/internal/catalog-proposals/:proposalId/*`, behind the same
`CATALOG_OPERATOR_OXY_USER_IDS` allow-list:

| Action | Endpoint | Lands the row in |
|---|---|---|
| Approve, minting the concept with the operator's own `key` | `POST .../approve` | `approved` |
| Point it at something that already exists | `POST .../merge` | `merged` |
| Refuse it | `POST .../reject` | `rejected` (terminal) |
| Ask the submitter for more | `POST .../request-information` | `needs_information` (still open) |
| Put it down until a date | `POST .../defer` | `deferred` (still open) |
| It is really a different TYPE | `POST .../redirect` | `redirected` |
| Re-run one page of the backfill an approval owes | `POST .../backfill` | unchanged |

`approved` and `merged` are separate states and not one `resolved`, because they
answer different questions about the catalogue — collapsing them makes "how much
of our catalogue arrived through proposals" unanswerable. Choose the one that is
true.

If the inflow is the problem rather than the outflow, the only lever that exists
is `CATALOG_AUTHORING_ENABLED`, which turns the whole authoring mount off for
everybody — a decision far larger than a backlog, and one that leaves every
already-submitted proposal in place and still decidable, because the operator
surface is deliberately not gated on it.

## What NOT to do

- **Do not reject to clear the queue.** Rejection is terminal, another attempt is
  a NEW proposal, and the merchant who needed the concept still needs it. The
  backlog comes back larger.
- **Do not defer to clear the queue.** `deferred` is an OPEN state and is counted
  here; deferring changes nothing about this metric except making the age keep
  climbing under a different word.
- **Do not `UPDATE catalog_proposals` directly.** A biconditional CHECK ties
  `resolved_entity_id` to the two resolved states, so a hand-written state
  transition either fails at the database or produces a row that claims a
  catalogue entity nobody minted — and the audit trail will not say who did it.
- **Do not alert on `proposal_backlog_count` alone.** Depth without age cannot
  tell a working desk from a stopped one, which is the failure both metrics exist
  to separate.
- **Do not read `proposal_sla_breach_count` as zero breaches.** It is
  `unmeasured` because no target exists, and a green tile there is a claim nobody
  has earned. If a target is agreed, it lands as a second member on
  `CatalogProposalSlaVisibility` plus a producer, in the same commit as the
  decision — not as a number in a dashboard query.
- **Do not read `waitAge` when it says `unmeasured`.** There is no number on that
  branch to read; that is the enforcement, not an oversight.
- **Do not read `proposal_creation_count` as a quality signal.** It cannot
  separate "the taxonomy is missing concepts" from "more merchants are
  authoring", and its attribution limit says so.
