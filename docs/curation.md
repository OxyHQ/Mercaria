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

### What a merge does with the queue (#893, epic line 340)

Two different things, and the difference is the whole answer.

**The item the job was requested FROM is CLOSED, as `merged` (or `split`).**
`requestMerge` and `requestSplit` have always accepted a `reviewItemId`, stored
it on the job and stamped it on the revision — and nothing closed it. Measured
end to end against a real server before the fix: an operator raises
`suspected_duplicate` between two products, requests the merge from that item,
the merge completes, and **the item is still `open`, still naming the loser,
which is now a tombstone.** The queue went on asking a question the act that
named it had already answered.

`CURATION_RESOLUTIONS` has had the word for that outcome since the vocabulary was
written — `merged`, with `split` beside it — and before this **nothing wrote
either**: `closeReviewItem` had exactly one caller, `resolveItem`, which is an
operator typing into the HTTP surface. So the two resolutions naming what a job
did were reachable only by somebody doing the job's bookkeeping by hand.

`services/curation/job-review-item.ts` is the ONE implementation both jobs call,
and it runs in the SAME transaction as `completeMergeJob`/`completeSplitJob`.
Together, because the alternative has a window: a job marked `done` with its
question still open in the inbox is exactly the state that was measured, and a
crash between two statements would make it permanent. Completion is attempted
FIRST and the closure is gated on its result — that completion is a CAS on the
OWNED LEASE, so a worker whose lease was reclaimed mid-run must close nothing.
Idempotency is `closeReviewItem`'s own CAS (`WHERE state IN ('open','in_review')`,
empty result IS the "already closed" answer), so a re-run, an operator who closed
it by hand first, and two workers racing all converge on one closure.

**Every OTHER open item about the loser stays open, and is ANNOTATED.** A merge
answers one question; dismissing the rest would be a machine taking an
operator's decision, and it is a worse version of the repointing
`POLYMORPHIC_ENTITY_REFERENCES` already refuses for this table — "a review item
is the QUESTION somebody was asked about two specific rows; rehoming either side
would silently change the question after the fact". That disposition stands.
What was missing is that **an operator could not tell a live subject from a
tombstone**: the queue served `subject_id` and nothing else.

`services/curation/subject-redirect.ts` adds `subjectRedirect` and
`counterpartRedirect` to every item `listQueue` and `getItemWithContext` return —
`null` for a live subject (distinct from the field being absent, which would mean
nobody looked) and `{type, id, mergedIntoId}` for one that was merged away. It
ANNOTATES and never moves, so "follow the tombstone, re-raise against the winner,
or act on it as it stands" stays a decision a person takes. One statement per
distinct mergeable type per page, never a lookup per row; only a MERGEABLE
subject is queried at all, because six of the thirteen subject types are not
entities and have no tombstone to read. One hop and no chain, because
`requestMerge` refuses a tombstone as the WINNER.

**What did NOT change, and is now pinned by a test.** Closing an item records the
revision against the item's own SUBJECT — the tombstone, when the subject has
been merged away. That is not a defect: a merge records every one of its OWN
revisions against the loser too (`requestMerge`, `approveMerge`), so following
the tombstone in the queue's half would put it somewhere the merge's half is not,
and `catalog_revisions` is `untouched` by a merge precisely because one entity's
history must not move onto another's. A later "fix" that follows it now fails the
build.

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
     → offers → relationships → reviews → saves → redirects → rollups → verify → done
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

### `blocked` is not `dead_letter`, and neither is claimable by mistake

A job waiting on an operator's conflict decision is not an error and must not be
retried, or the dispatcher spins against a judgement only a person can make. A
job that threw IS an error and must be retried. Collapsing them would either
spin the loop or bury a real fault among things "waiting for review".

### Every status is written by something (#704)

`CATALOG_JOB_STATUSES` has six members and `db/curation/jobRepository.ts` writes
all six, from twelve sites: `processing` (claim), `completed` (complete),
`blocked` (block), `dead_letter` or `pending` (release), `pending` (unblock) and
`cancelled` (cancel, #680).

There was a seventh. `failed` was CHECK-permitted on both job tables and
accepted by the repository's status filter, and **nothing wrote it** — so it
read as a state the system could reach. That was not inert:
`mergeJobBlockingState` renders a child job's CURRENT status into an
operator-facing refusal ("Child merge job `<id>` is `<status>` and must be
completed before this merge may commit"), which meant the sentence could name a
state no write produces, and read as a real diagnosis to whoever met it.

It was cut rather than made reachable because there is no failure mode here that
is not either a retryable release (`pending`) or an exhausted one
(`dead_letter`) — a third would have needed a meaning somebody wanted. Migration
`0149` narrows both CHECKs (`post`; a narrow breaks a write the previous image
could perform, on the category, not on a measurement that such a write exists).

So adding a member to that tuple means adding a WRITER in the same change.

The same migration first rewrites any row holding `failed` to `dead_letter`, and
that backfill is a **belt rather than a repair**: no writer of `failed` has ever
existed here (`git log -S"'failed'"` over `db/curation/` and
`services/curation/` returns no commit, `dead_letter` as a positive control
returns three), so it is expected to affect zero rows. What it buys is that the
deploy stops depending on that expectation — without it the narrowing is correct
only if a production count says zero, and that count is taken before the deploy
while the answer is needed during it.

It is `dead_letter` and not `blocked` because such a row's PHASE is unknown, so
it may have moved something. `mergeJobCancellationState` returns `allowed` for
`blocked`, so that choice would let an operator cancel a possibly half-applied
merge — the thing it refuses a `pending` job past `plan` for. `dead_letter`
refuses cancellation, is not claimable and is not in `OPEN_STATUSES`, so it holds
no open job and its refusal tells the operator they may request a fresh merge
now. The cost, stated rather than hidden: `dead_letter` implies "exhausted its
attempts", which is not knowable for such a row. A false implication behind a
safe-failing refusal beats a true-sounding status that admits a dangerous
action. `last_error` is marked `[#704]` with any prior value preserved after it,
so the rewrite is observable afterwards and "did this belt ever fire?" stays
answerable by query.

The backfill sits in the `post` file above the narrowing, not in a `pre` one:
`Migrate (pre)` runs while the image that could still write the value is
serving, so a `pre` backfill races it, and `Migrate (post)` runs after the new
image is live.

### A blocked job resumes when its condition clears, and only then (#663)

Not claiming a blocked job is right. Leaving one blocked after the thing it was
waiting for has happened is how that became a **dead end**: `unblockMergeJob`
had exactly one caller, `resolveMergeConflict`, which fires on a resolution — so
a job that reached `blocked` with every conflict ALREADY resolved could never be
lifted by anything. Two conditions reach that state:

- **`merge_pair`.** Resolving the conflict opens a child job and unblocks the
  parent; the parent re-blocks waiting on that child, and the child completing
  lifted nothing.
- **The second approval.** `catalog_merge_jobs_second_approval_check` permits
  `awaiting_resolution` unapproved, so a four-eyes job advances there within
  seconds of being requested and blocks; `approveMergeJob` writes the approval
  columns and did not unblock. **Every merge over the impact threshold was
  stranded**, and nothing covered it.

The repair is **not a hook on each clearing act** — that is a hand-maintained
map of "things that unblock a job", and its next omission strands again with
nothing red. `mergeJobBlockingState` is the ONE spelling of the
`awaiting_resolution` gate: a pure-read predicate over stored state whose
`clear` branch carries no reason to read. Three consumers ask it and therefore
cannot disagree — `runResolutionPhase` blocks on its verdict,
`resolveMergeConflict` evaluates it eagerly so an operator's decision restarts
the job immediately, and `resumeBlockedMergeJobs` sweeps from
`drainCurationJobs` before it claims.

**It cannot resume a job whose precondition is unmet**, because the thing that
decides to resume is the function that decided to block; there is no second
opinion available to be wrong, which is what an operator "retry" button would
have been. And resuming is not RUNNING: the sweep flips a status and claims,
leases and runs nothing, so `blocked` stays non-claimable and the paragraph
above still holds.

**There is deliberately no operator resume route.** With the predicate in place
such a control is either redundant (the condition cleared and the sweep already
scheduled it) or a no-op that re-blocks — a button that teaches an operator they
fixed something they did not. What an operator actually lacks is *why*, so
`GET /merge-jobs/:id` carries a derived `blocking` field: the same verdict the
sweep will act on, which is what distinguishes "this resumes by itself" from
"this is waiting on me". A parent whose child DEAD-LETTERED is the case that
needs it, and the reason names the child's current status rather than "must
complete first" — a running child and a dead one lead to opposite actions.

**It fails closed for a phase added later, twice.** The predicate refuses to
vouch for any phase but `awaiting_resolution`, and `PhaseOutcome` no longer
carries `blockedReason` — only `runResolutionPhase` returns a type that does, so
a new blocking phase is a `tsc` error until somebody has taught the predicate
how its condition clears.

### Conflicts: what belongs here, and the test that decides

| Kind | The constraint it probes |
|---|---|
| `identifier` | `product_identifiers_canonical_active_key` and `..._variant_active_key` |
| `variant_signature` | `canonical_variants_product_signature_key` |
| `default_variant` | `canonical_variants_product_default_key` |
| `relationship_endpoint` | `commerce_relationships_open_claim_key`, `..._verified_brand_owner_key` |
| `active_offer` | `offers_active_commercial_key` |
| `verified_claim` | `merchant_claims`' `(merchant_id) WHERE state='verified'` |
| `entity_suppressed` | **none** — see the amended test below (#694) |

**The membership test used to be "does it name a real constraint", and #694
amended it.** That test was written to exclude WARNINGS — a thing that merely
looks worrying must not park a job — and naming a constraint was the available
proxy for "the database would refuse this anyway, so somebody must decide".

`entity_suppressed` is the case where the proxy and the property come apart. It
names **no constraint**: nothing in this schema refuses a merge of a suppressed
entity, and that absence *is* the bug it exists for. But it is not a warning
either — proceeding **destroys a decision a person made**, silently, which is
precisely what the test was protecting against.

**So the amended test is: does proceeding destroy something somebody decided?**
Not: does a CHECK already refuse it.

The alternative was considered and rejected. A trigger refusing the tombstone
stamp *would* have given the kind a constraint to name — and it is worse: it
raises MID-MERGE, aborting the phase transaction, so the job **fails and
retries on the backoff ladder** instead of parking with a reason. A blocked job
an operator can read beats a raised constraint the dispatcher has to interpret.

`entity_suppressed` is also the first kind that is **type-independent**. The
other nine probe a constraint belonging to one entity kind; a suppression can
stand over any of the seven, so its detector is stated ONCE in
`detectMergeConflicts` rather than repeated through the per-entity switch —
seven identical lines would be seven chances to omit one, and an omission is
silent, because a merge with no conflict recorded looks exactly like a merge
with nothing to conflict about.

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
plan → mint → assignments → saves → redirects → rollups → verify → done
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

### Invariant 3, answered by the `saves` phase

#80 landed the canonical-product save table the census was waiting for, and the
answer is the SECOND half of the invariant's own sentence — "an explicit
user-visible ambiguity state". The `saves` phase marks every save of the divided
product `ambiguous_after_split`, naming the job so both candidates stay
recoverable, and the buyer resolves it (`docs/product-saves.md`).

Deterministic migration was considered and refused. "Keep the save where it is"
would be deterministic and would silently be wrong for exactly the buyers whose
interest moved to the new entity, with no signal anywhere that a decision had
been made on their behalf — which is the "selecting a child silently" #80
migration rule 8 forbids, and moving them all is the same mistake pointed the
other way.

Listing FAVORITES are still untouched: a canonical split never writes
`listings`, so an exact listing save means what it meant before whatever
happened upstream. Alerts and watchlists remain #78's, and the census below is
what will force the same decision when they land.

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

### A merge refuses a suppressed entity (#694)

`suppressEntity` writes a `catalog_entity_suppressions` row **and stamps the
entity itself** — `status = 'suppressed'` — and every catalogue read filters
`status = 'active'`. **The suppression is enforced one indirection away from the
table that records it.** That is why it is easy to miss, and why nothing
guarded against merging one: searching for a read path that filters the
suppression TABLE finds nothing and looks like an answer.

A merge destroyed that enforcement in both directions, because the tombstone
write has no status guard:

| side | what happened |
|---|---|
| suppressed **loser** | stamped `merged`; its offers, identifiers, source links, aliases, images and attribute values rehomed onto an `active` winner. Everything the suppression covered is served again, and the row sits open (`lifted_at IS NULL`) against a tombstone, claiming to cover it. **The merge LIFTED a suppression and nothing recorded that it had.** |
| suppressed **winner** | the loser's content is rehomed onto a row no catalogue read returns. **The merge EXTENDED a suppression to content nobody examined.** |

`requestMerge` now refuses both, with the remedy in the message — *lift the
suppression, or suppress the other side deliberately* — which is the treatment
it already gives a tombstone winner. **Repointing the suppression row was
considered and rejected:** `entity_id` on the winner gives an open suppression
against an `active` row, which is the record correct, the enforcement still
missing, and now *looking* covered. Worse than the bug.

**Known gap, pinned by a test rather than promised:** this is a REQUEST-time
guard, so a suppression landing between a job being requested and the job
running is not seen. `curation-writes.realdb.test.ts` reproduces exactly that
and asserts the damage, so the follow-up that closes it — a `plan`-phase
conflict kind, which needs a migration for the two CHECKs rendered from
`CATALOG_MERGE_CONFLICT_KINDS` — has something to turn red. Suppressions
already stranded by merges that have run are a separate data question.

### The polymorphic half, which has no foreign key to walk (#654)

That census derives from FOREIGN KEYS, so a **polymorphic** reference — an id
column whose target table is decided by a sibling discriminator — is invisible
to it. There is nothing for a foreign key to point at, so the gate that makes
the census self-maintaining **cannot fire** for one: a future decision to rehome
such a column arms the endpoint-collapse hazard with the build staying green.

`POLYMORPHIC_ENTITY_REFERENCES` in `merge-plan.ts` and
`__tests__/polymorphic-entity-census.test.ts` close it, in the FK census's own
shape one level up: **derive the population, declare only the disposition.**

**#654 named three tables, and that list was wrong in both directions** — which
is the argument for deriving rather than listing, measured rather than asserted:

| rule | finds | verdict |
|---|---|---|
| the enum is a SUBSET of `MERGEABLE_ENTITY_TYPES` | 6 tables | **misses `catalog_review_items`**, whose `subject_type` is the wider `CURATION_SUBJECT_TYPES` — and with it every mixed vocabulary, which is where the whole review family lives |
| the enum SHARES a value | 38 tables | about a dozen hold a real bare reference; the rest share a word |

The derivation is the **wide** one, deliberately. A narrow rule fails by
omitting silently, which is the failure under repair. So
`orders.source_channel` and `product_type_fields.flow` are in the population on
a coincidence of vocabulary, and that is the point rather than a defect: each is
ticked off once as `not_an_entity_reference`, so the next one cannot arrive
unnoticed. The discriminator is found through drizzle's own `enumValues` — the
tuple that renders each `checkOneOf` CHECK — so the population comes from the
SHAPE and never from a name.

#### A synonym defeated that rule entirely (#720)

Wide over the vocabulary is still **keyed on** the vocabulary, and #720 measured
what that costs. `attribute_value_reviews.entity_kind` and
`attribute_reindex_requests.entity_kind` are polymorphic over a canonical
product or variant and spell it `['product', 'variant']`. Zero set intersection
with `MERGEABLE_ENTITY_TYPES`, tables absent from the population, gate cannot
fire. Two teams naming one entity differently is the normal case rather than an
edge case, so the miss was a **default outcome**.

**It is worse than a bare column, and for the reason that makes it hard to
find:** a bare column at least *looks* like a gap, while these tables carry a
real discriminator with a real CHECK — so a reviewer asking "is this covered?"
sees one sitting right there and stops. The visible enum reads as coverage. It
also refutes the natural remedy: "give the column a discriminator so the census
can see it" does not work, because these columns have one.

So the population is now the **union of two derivations**, and the second reads
no vocabulary at all:

| derivation | rule | finds |
|---|---|---|
| vocabulary | an enum sharing a value with `MERGEABLE_ENTITY_TYPES` | 39 tables |
| **shape** | a closed value set **and** a bare reference the id ledger classifies outside `FOREIGN_KEY_SPACE_ID_REASONS` | 110 tables |
| union | — | **130 tables** |

The shape half is anchored on a gate that already runs: `findIdColumnViolations`
refuses any unclassified `_id` column, so a new bare id owes a ledger entry, and
a ledger entry outside the five foreign key spaces on a table with any
discriminator owes an entry here. The five are subtracted **structurally** — an
Oxy account, an Oxy file, a connected platform's object, a payment provider's
object and a supplier's are in another system's key space and no merge here can
act on one. Everything else stays in, **including the 138 entries written under
a bespoke reason, which is where both known #720 instances live**.

Narrowing the shape half to the six shared `MERCARIA_ROW_ID_REASONS` constants
was measured first and **rejected**: it yields a tidier 26-table population that
misses both instances — it fails the census's own positive control while looking
like a tighter instrument. A mutation pins that, so the tempting simplification
turns the build red.

Five dispositions, and the first two are deliberately not one:

| disposition | meaning |
|---|---|
| `not_an_entity_reference` | the enum shares a word; no column here holds a mergeable entity id |
| `discriminates_foreign_keys` | it does hold one, the columns are FK'd, and the FK census above already forces the decision |
| `covered_by_bare_entity_census` | the bare reference is declared in `BARE_ENTITY_REFERENCES` (#695/#711), which records what a merge does with it |
| `untouched` | a real bare reference a merge deliberately leaves, with its id columns named |
| `rehomed` | a real bare reference a merge moves (none today) |

Collapsing the first two would lose the fact that somebody checked.
`untouched`, `rehomed` and `covered_by_bare_entity_census` must name their id
columns and the other two must not — an entry claiming a merge leaves a
reference alone has to say *which* reference, or it is a sentence rather than a
decision.

`covered_by_bare_entity_census` is `covered_by_polymorphic_census` pointing the
other way, so the pairing is visible from either gate — and it is **verified
rather than trusted**: every column it names must really be declared in that
register for that table, or a deferral to a decision nobody made would be the
cheapest possible way to make a table look decided. The two-way hand-off also
makes one new failure possible, so it is gated too: if both registers ever defer
the same table to each other, the column is declared twice and decided zero
times, and **each register reads as complete from its own side** — the exact
shape of the gap #720 was filed about.

**Reconciled in both directions.** An undeclared derived table fails the build
naming itself and the four dispositions; a declared table the derivation no
longer finds fails too, because a stale declaration is the exemption that can
never fire — a shape this domain has already paid for once.

The entry to read is `catalog_entity_suppressions`: a real bare reference that
is currently `untouched`, and the one a later reader should challenge rather
than copy, because `retail_suppressions` one row over stores the same fact twice
and the plan DOES move a recall with its entity.

#### The declared `idColumns` are checked against the schema too (#893)

The reconciliation above is at the TABLE grain. Nothing checked that an entry's
`idColumns` were COMPLETE — and measured: deleting `counterpart_id` from the
`catalog_review_items` entry left all three census files green. The entry would
then read as a finished decision while covering half the reference, which is this
register's own defect one level in.

So for `untouched` and `rehomed` — the two dispositions asserting that a real
reference exists and that this register decided it — every BARE `<x>_id` sitting
beside a closed-value-set `<x>_type` or `<x>_kind` must be named. Derived from
the pairing, so it needs no list; `_kind` as well as `_type`, because #720's
synonym tables spell it that way.

**And the population is asserted to contain a NULLABLE column.**
`subject_type`/`subject_id` are `NOT NULL` and the counterpart pair is not, so
the plausible narrowing of a polymorphic derivation is "keep the real references,
skip the optional metadata" — which reads as tidying rather than as a mistake,
and is exactly why it would survive review. *A control made only of `NOT NULL`
columns cannot detect a `NOT NULL` filter*, so the floor asserts the walk covered
at least two nullable ones (`catalog_review_items.counterpart_id` and
`catalog_authoring_draft_values.canonical_ref_id`). Narrowing the derivation to
`NOT NULL` now turns the build red on that floor and on the entry count.

`covered_by_bare_entity_census` is excluded deliberately: its citation is
governed by the two tests that verify the OTHER census can still re-check the
column, which is a different and stricter property, and requiring completeness
here as well would put the two rules in conflict for a column that register
legitimately does not re-check.

#### #893 re-checked it, and the gap was somewhere else

The issue reported the FK census as blind to `catalog_review_items.subject_id`,
with "neither the census nor a read-time resolution to catch it". Measured
against the SHA it cites, the register above was already there and already
carried all three of its named tables with reasoned dispositions —
`catalog_review_items` and `catalog_revisions` and
`catalog_entity_suppressions`, the last of them settled by #694's outright
refusal to merge a suppressed entity. The blind spot was closed; what remained
was what a merge DOES with an item it cannot move, which is
[What a merge does with the queue](#what-a-merge-does-with-the-queue-893-epic-line-340)
above.

The issue's second claim did not survive measurement either: `resolveItem`
recording its revision against `item.subjectId` is not a defect, because the
merge records its own revisions against the loser too — following the tombstone
there would put the queue's half of the trail somewhere the merge's half is not.
A test now pins it.

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

## Seams left to their owners, and what the retirement left behind

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

## The pre-#59 direct merges are GONE (#36 completion criterion 4)

This section used to record a known gap: five pre-#59 merges shipped by #53/#56
that ran in one transaction outside this domain's conflict gate, its
census-complete rehoming plan, its impact estimate and its audit timeline. They
were retired as a clean cut. Nothing is aliased, nothing is `@deprecated`, and
there is no compatibility route.

**What was removed**, and what a reader should know it was:

| Retired | Reachable how |
|---|---|
| `POST /internal/canonical-catalog/product-families/:winnerId/merge` → `mergeProductFamilies` | operator route |
| `POST /internal/canonical-catalog/products/:winnerId/merge` → `mergeCanonicalProducts` | operator route |
| `POST /internal/canonical-catalog/variants/:winnerId/merge` → `mergeVariants` | operator route |
| `mergeBrands` | service only — **never routed**, callable from any backend module |
| `mergeOrganizations` | service only — **never routed**, callable from any backend module |

The last two are the reason a deletion was the right answer rather than a
mount-level guard: three of the five were reachable over HTTP and two were one
`router.post` from being. `canonicalMergeSchema` went with them, and so did
`rehomeReviewsForProductMerge` plus the `rehomeProductReviews` /
`findRehomeCollisions` repository pair, whose only caller was
`mergeCanonicalProducts`.

**The argument for deletion is not tidiness — those merges were INCOMPLETE.**
`merge-plan.ts` declares every column referencing each mergeable entity and
`merge-plan-census.test.ts` walks the schema to prove the list is exhaustive.
The direct merges moved a strict SUBSET of it: aliases, source links,
identifiers, redirects and (for products) reviews. They did not move the loser's
`canonical_variants`, `canonical_images`, `canonical_attribute_values`,
`canonical_field_provenance`, `product_saves`, `price_alerts`,
`watchlist_items`, `match_decisions` or `match_blocked_pairs`. A merge run
through one left those rows on a tombstone with every page still rendering,
which is exactly the invisible damage this domain exists to prevent.

The merge an operator uses is `POST /internal/commerce-graph/merge-jobs`, on the
SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, covering all seven mergeable
entity types.

### The behaviour the retirement did not carry over, and how it came back (#333)

`mergeCanonicalProducts` handled ONE case this domain did not.
`reviews_author_scope_target_key` is `(author_oxy_user_id, scope, target_key)`
where `target_key` is a GENERATED column over the six target columns, so a buyer
who reviewed BOTH merged entities has two rows that collide the moment the
loser's is repointed. The direct merge read the collisions first, left them on
the tombstone and reported them for an explicit operator assignment (#76
migration rule 5). `merge-plan.ts` gave `reviews.canonical_product_id` the
disposition `repoint`, which `applyRehomeTarget` executes as an unguarded
`update … set … where … = <loser>` — so that pair raised `23505` and the
`reviews` phase failed. It was loud, resumable and left nothing half-done, and
it was never a regression the retirement introduced: the job path always behaved
that way.

**Both `reviews` columns are now `repoint_if_absent`, guarded on
`[author_oxy_user_id, scope]`.** The colliding review STAYS on the tombstone —
which is `product_saves`' answer one domain over, and #76 migration rule 5's own.

- **Both**, not just the product one. `reviews.merchant_id` is the same
  collision one scope apart and a merchant merge is equally reachable today;
  fixing only the column the issue named would have re-landed it the first time
  somebody merged two merchant records.
- **The guard is EXACT at these two scopes** rather than approximate, and that
  is a property of `reviews_target_exclusivity_check` rather than an assumption:
  a `product`-scoped row has `canonical_product_id` set and every other target
  column NULL, so its `target_key` is that id and five empty strings. Guarding
  on the author and the scope therefore names precisely the winner rows the
  index would collide with — and no wider, which is what
  `retail_suppressions` records as the dangerous direction: a guard wider than
  the index it guards refuses to move a row that could have moved, and that
  refusal looks exactly like the guard working.
- **REFUSAL was considered and rejected.** A seventh `conflict_gated` kind is
  the shape this domain uses when "which side survives is a judgement", and it
  does not fit: `applyConflictResolution`'s branches all retire, revoke or unset,
  and a review's only such verb is `status = 'hidden'`, which is what CrowdSource
  enforcement writes. Reusing it would make a curation decision indistinguishable
  from a jury's takedown in `moderation_enforcements`' trail and in the restore
  path, and it would ask an operator to choose which of a stranger's two genuine
  reviews to suppress — a judgement they have no basis for. Nothing about either
  review's SURVIVAL is in question here; only which one the winner's aggregate
  counts, and the rule that decides it (the incumbent on the surviving identity
  stays) is the same one every other guarded entry in the plan applies.
- **The disposition is RECORDED, so retention is not silence.** A review left on
  a tombstone is invisible from then on and indistinguishable from one nothing
  ever considered, so `runReviewsPhase` appends a `review_target_migrations` row
  under `rehome_merge` — the action #76 published for exactly this and which
  nothing wrote until now — with `from` and `to` both the LOSER, because that is
  the decision: the merge considered this review and left its target where it
  was. `actor_kind` is `migration` and not `operator` even though a person
  requested the merge: nobody CHOSE this row's disposition, the guard did, and
  #76 migration rule 5's later explicit assignment must stay distinguishable
  from it.
- **Moves are deliberately NOT recorded.** A moved review's provenance is
  already answered — it points at the winner, and `merged_into_id` plus
  `canonical_product_redirects` plus the merge's own `catalog_revisions` entry
  say when the loser became that winner. A log whose dominant content is routine
  bookkeeping buries the rows an operator has to find.
- **The recording runs AFTER the move**, the opposite of the `alerts` stamp,
  which must run first because it names where a row CAME from. After the guarded
  update, what is still pointing at the loser IS the collided set, so the record
  is an observation of what happened rather than a prediction of what will.
- **The aggregates stay derivable on both sides.** `review_aggregates` is a
  PROJECTION and `rollups` re-derives the tombstone as well as the winner, so
  the retained rating still counts for the identity it was written about instead
  of vanishing from the graph.

Driven by `curation-writes.realdb.test.ts` §"#333", which seeds one buyer with a
review on each side and asserts the merge completes, all three reviews still
exist, the collision stayed and both aggregates were re-derived.
`merge-plan-census.test.ts` carries the rule rather than the two entries: no
`reviews` column in any entity's plan may be `repoint`, and every guard must
name the author and the scope — so a third one nobody has written yet fails the
build rather than raising `23505` in front of an operator.

### The statement layer beneath it is now uncalled, and is listed rather than left invisible

The retirement stopped at the SERVICE boundary. `db/canonical/*Repository.ts`
still exports the per-entity merge STATEMENTS the deleted services composed, and
they now have zero callers — #59 writes the same rows from `merge.service.ts`'s
`redirects` phase and `applyRehomeTarget`'s generic UPDATE instead:

`markBrandMerged`, `repointBrandAliases`, `repointBrandSourceLinks`,
`retargetBrandTombstones`, `markOrganizationMerged`, `repointOrganizationAliases`,
`repointOrganizationSourceLinks`, `retargetOrganizationTombstones`,
`markCanonicalProductMerged`, `repointCanonicalProductAliases`,
`repointCanonicalProductSourceLinks`, `retargetProductTombstones`,
`findProductTombstonesPointingAt`, `insertCanonicalProductRedirect`,
`markCanonicalVariantMerged`, `repointCanonicalVariantAliases`,
`repointCanonicalVariantSourceLinks`, `retargetVariantTombstones`,
`markFamilyMerged`, `repointProductFamilyAliases`,
`repointProductFamilySourceLinks`, `retargetFamilyTombstones`,
`findFamilyTombstonesPointingAt`, `insertProductFamilyRedirect`,
`repointProductIdentifiers`, `repointVariantIdentifiers`.

They are named here because a dead export nobody can find is how the next
reader re-composes the merge this issue removed. Collapsing them into #59's
inline spelling is a curation refactor with its own reviewer, not part of making
the unsafe path unreachable — which it already is, since nothing routes to them
and no service composes them.
