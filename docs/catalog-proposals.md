# Catalog proposals and operator review (#367 step 6)

ADR 0007 **D9**. A merchant is filling in a product form and the colour they need
is not in the registry. They ask for it. This domain is that request, the review
that answers it, and — much more of the work — everything that makes sure asking
is not the same as being answered.

> Binding: `docs/adr/0007-universal-catalog-taxonomy-and-authoring.md` D1 (a
> label is never identity), D5 (a product type version is immutable), D7 (a
> claim and a canonical fact are different rows), D9 (this), D10 (the authoring
> service), D12 (flags gate a mount, never a row), D14 (bounded JSONB — this
> domain declares none).
> Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`
> §"Catalog proposals and operator review (#367 step 6)".

**The failure this is shaped around:** a proposal that becomes catalogue fact by
sitting in a queue long enough. It has no error, no alert and no symptom — a
merchant's guess at a brand name, a category, a machine key, quietly cited by
every seed, export and external mapping afterwards, and discovered when somebody
asks why the catalogue thinks two things are one.

## What is stored

| Table | What it holds |
|---|---|
| `catalog_proposals` | One request. Its label in three forms, its context pins, its scan counters, its disposition. |
| `catalog_proposal_duplicate_candidates` | What the pre-submission scan SAW. Append-only against UPDATE. |
| `catalog_proposal_references` | Who is WAITING on it — a draft answer or a published listing's retained claim. |
| `catalog_review_events` | The append-only timeline. UPDATE **and** DELETE refused. |

Eight proposal types, ADR 0007 D9's own list: category, product type, brand,
product family, canonical product, canonical variant, attribute, controlled
value.

## The four places "never trusted by being submitted" is a SHAPE

1. **There is no `key` column and no `slug` column, anywhere in the domain.**
   ADR 0007 D1 makes the machine key identity, frozen after insert, cited by
   every seed, fixture, external mapping and export. A submitter who could
   propose one would be proposing identity. `CatalogProposalSubmission` has no
   field that could carry one, so it is unrepresentable rather than refused — and
   `refuseForbiddenSubmitterFields` answers a body that tries anyway by NAME
   ("a proposal cannot carry `key`"), not with "unrecognized key", which reads as
   a typo and sends an integrator looking for the right spelling.
2. **`resolved_entity_id` is present EXACTLY in a resolved state**, a
   biconditional CHECK rendered from `CATALOG_PROPOSAL_RESOLVED_STATES`. A
   `submitted` row naming a catalogue entity has no row shape, so nothing that
   joins through that column can pick up an undecided request whatever a service
   does.
3. **A resolution names a decider, and the decider is not the submitter.**
   `catalog_proposals_decision_audit_check` demands the operator, the instant and
   a non-empty reason; `catalog_proposals_decider_distinct_check` refuses a
   self-approval. The second exists for the merchant who is also on the operator
   allow-list, and it costs a real operator nothing — creating catalogue data
   directly is what the owning surface is for.
4. **Exactly ONE module may write a catalogue table**, and it is
   `review.service.ts`. `catalog-proposal-isolation.test.ts` scans the whole
   domain and fails the build on a second, so the rule is a property of the
   import graph rather than of anybody's discipline. The gate also asserts the
   permitted writer genuinely DOES write — a wall around an empty room is green
   and inert.

## Approval MINTS one type and LINKS the other seven

`CATALOG_PROPOSAL_MINTABLE_TYPES` has one member — `controlled_value` — and
`CATALOG_PROPOSAL_LINK_ONLY_TYPES` has the other seven, each naming the surface
that owns creating one. The two are disjoint and their union is
`CATALOG_PROPOSAL_TYPES` exactly, which a census test runs rather than a comment
claims.

**This is the design, not a deferral.** A controlled value is a row under an
attribute definition an operator has already drafted, reviewed and published:
adding one moves no identity, is a single idempotent insert, and the authoring
cache already has a subject for it (`attribute_values`) precisely because the
controlled-value set is the one thing that can still move under a live schema.

A category carries a key and an ancestry behind a write chokepoint; a product
type is a versioned schema with a publication ritual; a brand, family, product
and variant are the canonical graph, with identity, alias and merge machinery
around every mint; an attribute definition is #94's registry with its own version
freeze. A second writer for any of them is what those chokepoints exist to
refuse, and "the proposal surface may create one" is how a second writer arrives
wearing a reasonable name. So an operator creates the entity where it is owned
and then **merges** the proposal into it — one of D9's own six actions, leaving
the record saying exactly what happened.

## Duplicate detection, and the number that makes it mean something

ADR 0007 D9 asks for duplicate detection BEFORE submission. The failure the
implementation is shaped around is not a missed duplicate: it is a scan that
returned nothing because it examined nothing, which is the same empty list a
clean result produces and reads as diligence in every report.

So every probe returns a **population** beside its candidates — the size of the
set it actually read, counted from the database and returned BY the detector
rather than supplied to it. `duplicate_scan_population` is stored on the row,
`duplicate_scan_candidates <= duplicate_scan_population` is a CHECK, and the
`duplicate_scan_recorded` review event carries both numbers so "it found nothing"
is checkable against what it looked at.

Three detectors, and only two may refuse anything:

| Detector | What it means | May refuse? |
|---|---|---|
| `exact_normalized` | The concept already exists under that name. | Yes |
| `recorded_alias` | Somebody already recorded that spelling as meaning something else. | Yes |
| `trigram_similarity` | It looks like something. | **No** — evidence a reviewer reads |

A score refusing a submission would mean a merchant with a legitimately similar
product name being told, with no remedy, that their concept already exists.

An exact hit on an **existing entity** and one on an **open proposal** are
different outcomes: the first is a refusal naming what to use instead, the second
is CONVERGENCE — the submitter now waits with somebody else on a request that
already exists, and their draft answer is attached to it as a reference.

The near probe is `ORDER BY x <-> $1 LIMIT n` and never a `similarity(...)`
filter. #61 measured exactly this shape at 16.6 ms scanning 25 rows against
81.6 ms scanning 31,094, because only the distance operator can be served by a
GiST trigram index. The threshold is applied to the LIMITED result in the
service.

## Convergence

`convergence_key` is `type : attribute : category : product type : normalized
label`, STORED and GENERATED, with a partial unique over
`CATALOG_PROPOSAL_OPEN_STATES`. Two merchants asking for the same colour on the
same attribute converge on ONE proposal, which is the difference between an
operator reading one request with two people waiting and a queue of forty
identical rows.

The join is **injective without escaping** because only the last component is
free text: the other four are a closed-tuple member and three uuids, none of
which can contain the `:` separator. #63's identity key had to escape its
components precisely because they were all free text; the difference is stated
in the schema so nobody "simplifies" this into the ambiguous shape.

A decided proposal leaves the index, so the same concept may be proposed again
after a rejection. Stopping a re-proposal loop is `match_blocked_pairs`' job, not
this index's.

## The six operator actions

| Action | Lands on | Notes |
|---|---|---|
| approve | `approved` | Mints the controlled value. The **key is the operator's** and is required. |
| merge into existing | `merged` | Links an entity created where it is owned. |
| reject | `rejected` | Terminal, with a coded reason. Another attempt is a NEW proposal. |
| request information | `needs_information` | The question is the event's reason, not a column. |
| defer | `deferred` | Still an **open** state — a draft waiting on it is still waiting. |
| redirect | `redirected` | Mints an OPERATOR-origin successor carrying the same label, with no store. |

A submitter may additionally **withdraw** their own request. It is the one state
move that is not an operator's, and it is excluded from the decision-audit CHECK
for that reason.

Each action is one transaction, locks the row `FOR UPDATE`, moves the state by a
compare-and-swap, and appends a `catalog_review_events` row. Two operators
working the same queue item is the ordinary case: without the lock both read
`submitted`, both pass, and the second silently overwrites the first's decision
on a row that may already have minted a value.

## The backfill, and why it is idempotent

ADR 0007 D9: *"On approval the canonical entity is created or linked and affected
drafts and listings are backfilled idempotently."* Two mechanisms make that word
real:

1. **The affected set is ENUMERATED, not re-derived.**
   `catalog_proposal_references` names every draft answer and every retained
   listing claim that was waiting when the request was made. Re-deriving it at
   approval time from a label gives a different answer on the retry than on the
   first attempt — a merchant edited a draft in between — which is exactly the
   shape an idempotent job cannot have.
2. **Each reference is CLAIMED by a compare-and-swap** on `backfilled_at IS
   NULL`, whose empty result set IS the "already applied" answer, backed by a
   trigger refusing a second move. A read-then-write lets two operators pressing
   the same repair both see NULL and both apply.

What it applies:

- an `authoring_draft_value` reference → the draft's `text` local claim becomes
  the `controlled_value` (or the `canonical_reference`) it was asking for, in ONE
  `UPDATE` because the `num_nonnulls(...) = 1` CHECK refuses the intermediate
  row, plus a bump of the draft's optimistic-concurrency token;
- a `listing_attribute_claim` reference → the retained claim's attribute AND
  value halves are settled together, because
  `native_listing_attribute_claims_value_depends_on_attribute_check` refuses a
  typed value beside an unresolved attribute.

Every write is conditional on the target still being in the state it is
correcting, so a merchant who answered differently in the meantime keeps their
answer.

The backfill runs AFTER the decision commits and never inside it — the #59
merge-runner ruling — and it is BEST-EFFORT, because a failed backfill must not
un-approve a decision an operator made. `POST /internal/catalog-proposals/:id/backfill`
picks up the remainder and is the one write on that surface that decides nothing.

**The vacuity floor:** a pass over a proposal nobody was waiting on and a pass
whose work is finished produce the same numbers. `nothing_to_apply` names the
first, from a total counted over the population rather than over what the pass
did.

## Publication while a proposal is pending

ADR 0007 D9's last paragraph, and this domain DECIDES NONE of it:
`product_type_definitions.pending_proposal_policy` is a property of the VERSION —
frozen by `product_type_definitions_immutable_once_published` — so it is
versioned and reviewable rather than a per-request decision.

`decidePendingProposalPublication` reads it and answers `clear` /
`permitted_as_local_claim` / `blocked`. There is no parameter, flag or override
that could produce the other answer.

`block_publication` contributes ONE `proposal_pending_blocks_publication` error
at the draft level — the author's remedy is the same whichever pending value is
named, and a list of eleven identical errors on a form is a list nobody reads.
`allow_local_claim` contributes NOTHING, not even a warning: a warning would be a
sentence saying something is wrong about a publication the versioned policy
permits.

This closes the seam `services/catalog-authoring/validation.ts` names at its
foot. Both codes were already in the closed set and produced by nothing, because
until `catalog_proposals` existed a value that is "still a proposal" had no
representation — and a check for one would be a check that can never fire, which
reads as coverage.

## Surfaces

**Merchant**, behind `products:write` on the store named in the body (or the
query), resolved through the SAME `loadStore` → `requireStorePermission` chain
every store-scoped route uses:

```
POST /catalog-proposals/duplicates          the pre-submission scan; stores nothing
POST /catalog-proposals                     submit, or converge
GET  /catalog-proposals?storeId=            this store's own feed
GET  /catalog-proposals/:id?storeId=        one of them (another store's -> 404)
POST /catalog-proposals/:id/withdraw
POST /catalog-proposals/:id/information     answer a reviewer
```

**Operator**, on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
#54/#55/#56/#57/#58/#59/#60/#62/#68/#70/#78/#79/#80/#83/#90/#94 use, and not a
seventh list — a proposal asks for a category, a product type, a brand or a
controlled value, and who may reshape that catalogue and who may decide a request
to reshape it are the same power over the same graph:

```
GET  /internal/catalog-proposals             the queue
GET  /internal/catalog-proposals/:id         the trace: scan evidence, references, timeline
POST /internal/catalog-proposals/:id/{approve,merge,reject,request-information,defer,redirect}
POST /internal/catalog-proposals/:id/backfill
```

The route set is CLOSED. There is no "set this proposal approved", no "attach
this entity id", no "clear this decision", no "edit this label" and no delete —
each would be a way to make the record say something other than what happened,
and `catalog_review_events` is append-only precisely so the record cannot be
quietly corrected afterwards. Every write is keyed on a PROPOSAL id and the trace
opens from one; the queue's `storeId` is a FILTER over a list an operator can
already page, not a handle.

## Rate limits

The network axis is the route's own `admin` bucket — a proposal is submitted from
the authoring form, behind a store permission, on the same rails a draft PATCH
runs on. What actually bounds proposal farming is DURABLE and counted in
Postgres: per submitting account per hour, and per store per day. "How many has
this store asked for today, across every ECS task" is not a question a per-IP
bucket can answer, and it is the axis an abusive integration cannot escape by
changing address (#83's device, with the two axes this domain needs).

ONE message for both axes: a refusal that named the axis would tell this caller
about their colleagues' activity, and a per-store axis is exactly where that
matters.

## Flags

`CATALOG_PROPOSALS_ENABLED` (default false, ADR 0007 D12) gates the merchant
MOUNT and never a stored row: a proposal already submitted stays submitted with
it off, and an operator can still decide it — a rollback that stranded a
merchant's request with nobody able to answer it is one nobody would pull. The
operator surface is deliberately NOT gated on it, the `/internal/product-saves`
arrangement: the evidence has to be readable during the incident that turned the
merchant surface off.

The five bounds beside it (`CATALOG_PROPOSAL_MAX_PER_SUBMITTER_PER_HOUR`,
`_MAX_PER_STORE_PER_DAY`, `_DUPLICATE_NEAR_LIMIT`, `_DUPLICATE_NEAR_THRESHOLD`,
`_BACKFILL_PAGE_SIZE`, `_PAGE_SIZE`) are bounds rather than levers. The threshold
decides which trigram scores are RECORDED as evidence; it cannot refuse a
submission, so raising it loses a reviewer some context and can never turn a
legitimate request away.

## Seams, each failing closed

- **The authoring client's `canProposeValues`** is still `false` in
  `catalog-authoring.controller.ts`. The endpoint now exists behind it; flipping
  it is one line in a file this branch does not own, and it should flip WITH the
  dashboard control (#367 step 10) rather than announce a control nothing renders.
- **`docs/index.mdx`** carries no row for this domain (nor for
  `catalog-authoring.md`); adding one is a single line in a table several #367
  branches are appending to at once.
- **The listing-claim ATTACHMENT.** `listUnresolvedClaimsForRawValue` exists and
  nothing calls it: attaching a published listing's retained claims to an open
  proposal is a bulk operator action over #367 step 4's review queue, and it
  belongs beside that queue rather than here. The backfill already settles such a
  reference correctly once one exists.
- **Category, product type, brand, family, product, variant and attribute
  creation** — `CATALOG_PROPOSAL_LINK_ONLY_TYPES`, above. Each names its surface
  and the approval refuses by name.
