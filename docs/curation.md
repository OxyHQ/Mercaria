# Catalogue curation — review, merge, split and correction

The operator's half of the canonical commerce graph (issue #59, bound by
ADR 0002 D12/D16). #58 decides what a matcher may do **without** a person;
this domain is everything the matcher refused, plus the corrections no automatic
rule may make at all.

Code: `services/curation/` + `db/curation/` + `db/schema/curation.ts` (8 tables)
+ the curation half of `routes/internal-commerce-graph.ts`. Schema decisions:
`db/schema/CONVENTIONS.md` §"Catalogue curation".

---

## The failure mode that shapes the whole domain

A merge is the only operation in this graph that **ends an identity**, and the
damage it does is invisible. Every page still renders, every offer still
resolves, and the two things quietly made one are found months later — by a
seller whose sales landed on somebody else's product page, or by a shopper
comparing two prices for one thing that turn out to be two different things.

A **half-finished** merge is worse than either state: some children moved, some
did not, and no row says which. That is why the merge is a durable job with
resumable phases rather than one long transaction, and why every collision it
could hit is detected **before** a single row moves.

---

## The review queue

`catalog_review_items` — one row per problem, converging on the OPEN states.

| Kind | Detector | What it means |
|---|---|---|
| `ambiguous_match` | `match_pipeline` | #58 refused to match automatically |
| `identifier_conflict` | `identifier_collision_gate` | Two entities assert one valid identifier (ADR 0002 D14) |
| `entity_collision` | `duplicate_scan` | Two brands share a normalized name, or two merchants share a domain |
| `relationship_candidate` | `relationship_intake` | An unverified #55 claim awaits evidence review |
| `source_fact_disagreement` | `attribute_conflict_scan` | #94 `conflicting`: two sources disagree, neither selected |
| `suspected_duplicate` | `duplicate_scan` | Two canonical products share a normalized name |
| `orphaned_record` | `orphan_scan` | An ACTIVE offer whose canonical variant is a tombstone |
| `policy_regression` | `policy_regression_scan` | A subject that used to match automatically and no longer does |

**The detectors read; they never decide.** Each turns a state that already
exists somewhere in the graph into a row an operator can claim. None writes to
the domain it reads — the moment one could, it would be a second matcher with
none of #58's gates.

**Convergence is scoped to the OPEN states on purpose.** A problem that comes
back after somebody fixed it opens a NEW item, because burying a recurrence
under an old resolution hides that the fix did not hold. The trigger
`catalog_review_items_closure` refuses re-opening a closed item, so that
property survives whoever writes the next update.

**A pair-shaped kind cannot be stored with one side**
(`catalog_review_items_pair_shape_check`), and the two duplicate kinds store
their pair in **id order** (`..._pair_order_check`), so (A,B) and (B,A) are one
item rather than two views of one problem. `identifier_conflict` is excluded
from the ordering rule because there the direction MEANS something: the subject
is the disputed newcomer and the counterpart is the incumbent active owner.

**Merchant collisions are detected on a shared DOMAIN, not a name.** `merchants`
carries no `normalized_name` column and the absence is a decision: ADR 0002 D3
makes a merchant a seller of record, and #53 keeps name matching out of identity
entirely. `merchant_domains` is where the evidence already lives.

---

## The merge job

`catalog_merge_jobs` + `catalog_merge_conflicts` + `catalog_merge_job_phases`.

### The phases, and why the order is load-bearing

```
plan → awaiting_resolution → children → identifiers → aliases → source_links
     → offers → relationships → reviews → redirects → rollups → verify → done
```

1. `plan` measures the impact and **detects every conflict before a single row
   moves**, so an operator sees the size of what they are about to do.
2. `awaiting_resolution` is where merge invariant 4 lives: the job cannot
   advance while any conflict lacks an explicit decision.
3. `children` moves child ENTITIES first (a family's products, a product's
   variants, a merchant's storefronts), because everything after repoints rows
   that hang off them.
4. `identifiers` precedes `aliases`/`source_links`, because an identifier
   resolution can RETIRE a row and the retirement must land before the collision
   gate sees two active owners.
5. `redirects` stamps the tombstone **last of the mutating phases**. Until it
   runs, the loser is a live entity and a crash leaves a resumable job; stamping
   first would leave a dead identity with live children and nothing saying which
   phase was owed.
6. `rollups` rebuilds counters FROM the rehomed rows (invariant 6), which is why
   it cannot precede them.
7. `verify` is the final consistency check — and it is literally a **re-run of
   every plan target**, asserting nothing moves. That is simultaneously the
   verification and the idempotency proof, with no second description of the
   plan to drift from the first.

### Resumability is the phase RECORDS, not the phase column

Each phase claims its `catalog_merge_job_phases` row (`ON CONFLICT DO NOTHING`
on `(job_id, phase)`) before doing anything and stamps it complete after. A
phase already stamped is **skipped**; one claimed but never stamped is
**re-run**, because a crash between the two left work half done. Every rehoming
statement is idempotent — its `WHERE` matches only rows still pointing at the
loser — so the re-run is safe and reports zero.

Each phase runs in its **own transaction**. One transaction over the whole merge
would hold row locks on offers, reviews and relationships for the duration, and
a failure at `rollups` would roll back eleven phases of correct work.

### `blocked` is not `failed`, and neither is claimable by mistake

A job waiting on an operator's conflict decision is not an error and must not be
retried, or the dispatcher spins against a judgement only a person can make. A
job that threw IS an error and must be retried. Collapsing them would either
spin the loop or bury a real fault among things "waiting for review".

### Conflicts: six kinds, each naming a real constraint

| Kind | The constraint it probes |
|---|---|
| `identifier` | `product_identifiers_canonical_active_key` and `..._variant_active_key` |
| `variant_signature` | `canonical_variants_product_signature_key` |
| `default_variant` | `canonical_variants_product_default_key` |
| `relationship_endpoint` | `commerce_relationships_open_claim_key`, `..._verified_brand_owner_key` |
| `active_offer` | `offers_active_commercial_key` |
| `verified_claim` | `merchant_claims`' `(merchant_id) WHERE state='verified'` |

A "conflict" with no constraint behind it is a warning, and warnings do not
block — that is the membership test for this list.

**A SLUG collision is deliberately absent.** Slugs are unique forever and a
tombstone keeps its own (ADR 0002 D12), so a merge never contends for one:
invariant 5's "slug collisions produce deterministic redirects" is satisfied by
the identity model rather than by a decision.

**`merge_pair` is the only resolution for a variant-signature collision**, and
is refused for every other kind by CHECK. Keeping one of two variants that carry
the same option assignments would strand the other's offers on a row nothing
links to; `merge_pair` opens a CHILD merge job that the parent waits on.

**Applying a resolution only ever retires, revokes or unsets** — never deletes,
and never writes the surviving row. That asymmetry is what makes applying one
twice a no-op and applying the wrong one undoable.

### Four eyes

`CATALOG_FOUR_EYES_REQUIRED` (default on) plus
`CURATION_LARGE_MERGE_IMPACT_THRESHOLD` (100 moving rows). Two independent
mechanisms:

- `approved_by <> requested_by` — a CHECK, so one person with two sessions
  cannot satisfy it;
- `phase in ('plan','awaiting_resolution') or approved_by is not null` when
  `requires_second_approval` — a CHECK, so an unapproved large merge cannot
  advance past planning.

`requires_second_approval` is **snapshotted at planning time** beside the impact
that produced it. A threshold change must not retroactively unapprove a job
somebody already ran, nor let an unapproved one through.

---

## The split job

`catalog_split_jobs` + `catalog_split_assignments`.

```
plan → mint → assignments → redirects → rollups → verify → done
```

### `revive_tombstone` is what makes acceptance 2 work

"A mistaken merge can be split without losing source mappings or price history."
Every source mapping that pointed at the losing entity, and every price
observation recorded against its offers, is keyed on **that entity's id**.
Minting a fresh row satisfies the word "split" and destroys exactly what the
criterion protects. So a split may name an existing tombstone and bring it back:
`merged_into_id` is cleared, the status returns to active, and the identity that
was ended exists again **as itself**.

`new_entity` is the other case, and it is restricted to a canonical PRODUCT by
CHECK: a variant's identity is its option assignments (`signature`), so minting
one would mean inventing them.

### The assignment list IS the split

`catalog_split_assignments` is one row per item with
`UNIQUE(job_id, item_type, item_ref)`; **anything not named stays where it is.**
Silence is never a move. The `catalog_split_assignments_frozen` trigger refuses
a new assignment once the job has left `plan` — so the set an operator approved
with an impact estimate beside it is the set that executes — and makes an
applied assignment terminal, so a resumed phase can trust `applied_at` as its
skip list.

`item_ref` carries no foreign key, and it is the one place in the domain where
that was the better answer: the target table is a two-key dispatch,
`(job.entity_type, item_type)`, over twelve tables. What it gives up is stated
rather than waved away — a missing row is recorded with a `skipped_reason` and
the `verify` phase reconciles assigned against applied.

### Invariant 4, satisfied by minting no redirect

The ORIGINAL entity keeps its slug and its URL, and it is still correct for
everything that stayed. A new entity gets a new slug nothing has ever linked to.
There is no old address whose answer changes.

### Invariant 3, honestly

Mercaria has no product-save, alert or watchlist table today: `favorites` are
saves of a native LISTING, and a canonical split never touches `listings`. The
migration is deterministic because there is nothing ambiguous to migrate — and
the day a canonical-product save table lands, the census (below) forces whoever
adds it to decide what a merge and a split do with it.

---

## THE CENSUS — how "everything is rehomed" is checkable

`services/curation/merge-plan.ts` declares, for each of the seven mergeable
entities, every column that references it and what a merge does with it:

| Disposition | Meaning |
|---|---|
| `repoint` | The plain move; no unique spans the column |
| `repoint_if_absent` | A unique spans it; colliding rows STAY on the tombstone |
| `repoint_or_supersede` | A partial unique scoped to `active`; the colliding row moves AND is superseded |
| `conflict_gated` | A unique a merge cannot resolve alone; the planning phase raises a conflict |
| `flatten` | The self-reference — tombstones pointing at the loser are retargeted |
| `retained_by_tombstone` | The row stays with the loser on purpose, because it describes what the loser WAS |
| `untouched` | The merge must not write this table at all |

`__tests__/merge-plan-census.test.ts` walks the **drizzle schema** for every
foreign key targeting a mergeable entity and asserts the plan covers exactly
that set — no more, no fewer. A new table referencing `canonical_products` fails
the build until somebody decides what a merge does with it.

That is the point. "Finding fewer referencing tables" looks identical to "there
being fewer" (`~/Oxy/AGENTS.md`, the git-pathspec and Mongo-reader findings), so
completeness has to be checked against the schema rather than read out of an
implementation. The gate carries the prescribed defences: a vacuity floor on the
schema size and the census size, a positive control that it finds references
declared in OTHER schema modules, and a mutation self-test proving a dropped or
invented plan entry is caught.

**`untouched` with a reason is a decision the census accepts; silence is not.**

### What the census caught on its first rebase

It fired immediately, on the first branches to land after it existed: #60's
backfill and #121's retail eligibility added **eight** references to mergeable
entities between them, and the build refused until each had a disposition.

- `retail_suppressions.{brand,canonical_product,canonical_variant}_id` —
  `repoint_if_absent`, and the most safety-critical entry in the plan. A recall
  left on a tombstone stops covering the product people can actually buy. The
  row stores the id **twice** (the typed foreign key plus the polymorphic
  `scope_ref` the eligibility derivation matches on), with
  `retail_suppressions_reference_agreement_check` forcing them equal — so the
  plan moves both together through `alsoSetColumns`, and moving one alone fails
  the CHECK loudly rather than half-working. The guard is narrowed by
  `guardWhereNullColumn` to exactly `retail_suppressions_live_key`'s own
  predicate (`WHERE lifted_at IS NULL`): a guard wider than its index would let
  a **lifted** suppression on the winner block a **live** one from following,
  silently un-suppressing a recalled product.
- `retail_compliance_evidence.canonical_{product,variant}_id` — `repoint`. The
  alternative is a compliant product becoming *blocked* by a merge, since the
  derivation demands a document covering the destination and evidence stranded
  on a tombstone covers nothing.
- `retail_eligibility_exceptions.canonical_variant_id` — `repoint`. After a
  merge that is the same variant, and a waiver stranded on a tombstone stops
  applying silently. What may be waived cannot widen: `waived_reasons` is
  CHECK-restricted to the waivable tuple.
- `catalog_backfill_records.canonical_{product,variant}_id` —
  `retained_by_tombstone`. It is a migration REPORT whose only purpose is
  comparing a dry run against the apply run that followed it, and repointing
  would rewrite what a run reported. A reader still resolves through
  `merged_into_id`, which is one hop by construction.

---

## The audit timeline

`catalog_revisions` — one row per action, with a mandatory actor kind, a
mandatory reason and a before/after snapshot. Append-only by TRIGGER: UPDATE and
DELETE are both refused, unlike `analytics_events` (which permits DELETE because
erasure on schedule is its policy). A revision that could be deleted would let
the record of a merge disappear along with the reason somebody performed it.

`before`/`after` are the graph's one legitimate `jsonb` pair, named by ADR 0002
D16: a revision must capture whatever the entity looked like INCLUDING columns a
later schema removed, and projecting them into typed columns would make the
trail lossy exactly when somebody needs to read an old revision.

**`compensates_revision_id` runs backwards in time.** The compensating
correction NAMES the revision it undoes, so the pointer always resolves — the
direction `product_identifiers.supersedes_identifier_id` and the referral domain
both learned the hard way. It records the undo and does **not perform** it: the
graph change that reverses an act is an ordinary operator act with its own
validation, and a generic "apply the inverse of `before`/`after`" would replay a
snapshot whose schema may have moved.

---

## Operator surface

All under `/internal/commerce-graph/*`, behind the SAME
`CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54, #55, #56, #57 and #83 use —
deciding that two things are one thing is the same power over the same graph as
linking a merchant to a store. Empty list = the router is not mounted (404).

| Method | Path | Purpose |
|---|---|---|
| GET | `/review-items` | The inbox, with per-kind depth and the oldest open item |
| POST | `/review-items` | Raise one by hand |
| POST | `/review-items/scan` | Run every detector once, bounded |
| GET/POST | `/review-items/:id{,/claim,/release,/resolve}` | Read, claim, release, close |
| GET | `/merge-impact?entityType=&entityId=` | What a merge WOULD move — a READ |
| GET/POST | `/merge-jobs` | List / open |
| GET | `/merge-jobs/:id` | The job, its conflicts, its phases, its revisions |
| POST | `/merge-jobs/:id/approve` | The second operator's approval |
| POST | `/merge-jobs/:id/conflicts/:conflictId/resolve` | Decide one conflict |
| GET/POST | `/split-jobs`, `/split-jobs/:id{,/approve}` | The split half |
| POST | `/curation-jobs/drain` | Run one batch now — the dispatcher's own path |
| POST | `/identifiers/:id/reassign` | Move an identifier, collision read first |
| POST | `/attribute-values/:id/select` | Choose a source value AND pin the field |
| POST | `/suppressions`, `/suppressions/lift` | Hide / restore |
| GET | `/revisions?entityType=&entityId=` | The immutable timeline |
| POST | `/revisions/:id/compensate` | Record a compensating correction |

**What the surface deliberately cannot do**: force a job past a phase, mark a
conflict applied, supply an impact figure, or delete anything. Every one is a
way to reach a half-merged entity from an HTTP request, and
`curation-isolation.test.ts` fails the build if a schema gains one of the field
names.

---

## Environment

```
CATALOG_OPERATOR_OXY_USER_IDS=      # the gate; empty = not mounted (404)
CATALOG_FOUR_EYES_REQUIRED=true     # ONE flag, read by #55 and #59 alike
CURATION_JOBS_ENABLED=true          # gates the LOOP, never the request
CURATION_JOB_BATCH_SIZE=5
CURATION_JOB_POLL_INTERVAL_MS=10000
```

`CURATION_JOBS_ENABLED` gates the dispatcher and nothing else. An operator may
still request a merge with it off; the job sits `pending` and runs when it comes
back. Gating the REQUEST would silently lose work somebody thought they had
scheduled — the inversion the payment and moderation outboxes already record.

---

## Seams left to their owners, and the one known gap

**Deferred, with the contract already published:**

- **#61 — search reindexing.** Acceptance 5 asks that search and public pages
  converge "through documented reindex jobs". The generated `search_vector`
  columns are recomputed by Postgres on every write, so a merged entity's own
  document is correct the moment its row is touched; the consumer that drains
  `attribute_reindex_requests` is #61's, as #94 already left it.
- **#78 — the price-history table.** ADR 0002 D18 assigns it to #78. Today the
  observed price history is the append-only `source_records` chain an offer
  points at, and a merge repoints the offer without touching one record of it.
- **#60 — the canonical minting a `create_new` recommends.** This domain's
  `created_entity` resolution records that an operator did it; the minting goes
  through #56's own create service.
- **The operator UI.** This is the API and the invariants; the console is
  #59's front-end counterpart.

**Known gap, stated rather than hidden:** the pre-#59 direct merge endpoints on
`/internal/canonical-catalog` (`mergeCanonicalProducts`, `mergeVariants`,
`mergeBrands`, `mergeOrganizations`, `mergeProductFamilies`, shipped by #53/#56)
still perform a single-transaction merge that does **not** go through this
domain's conflict gate, its census-complete rehoming plan, its impact estimate
or its audit timeline. They remain reachable by an operator on the same
allow-list. Routing them through a curation job changes their response shape
from a synchronous result to a job id, which is a breaking change to their
callers and their tests; it belongs in the same change as the operator console
that consumes the job shape. Until then, the merge an operator should use is
`POST /internal/commerce-graph/merge-jobs`.
