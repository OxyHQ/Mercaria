# Catalog administration and governance (#367 Workstream 12)

The operator surface over ADR 0007's nine catalog domains: taxonomy, product
types, attributes and controlled values, localization, external mappings,
navigation, compatibility, proposals — and the change machinery that puts an
impact measurement, a second pair of eyes and one audit trail in front of all of
them.

**This domain writes nothing in the catalogue.** Every apply calls the owning
domain's own writer. What it adds is everything BETWEEN those writers, which is
exactly what was missing when they landed.

- Code: `services/catalog-governance/` (11 modules), `db/catalogGovernance/`
  (3 repositories), `db/schema/catalogGovernance.ts` (5 tables),
  `routes/internal-catalog-governance.ts`,
  `controllers/catalog-governance.controller.ts`,
  `middleware/catalog-governance-schemas.ts`,
  `@mercaria/shared-types` `catalog-governance.ts`.
- Surface: `/internal/catalog-governance/*`, on the **existing**
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list. Empty list ⇒ not mounted (404,
  never 401).
- Environment: **none.** This domain adds no variable of its own. It reads
  `CATALOG_FOUR_EYES_REQUIRED`, which #55 and #59 already read.

---

## The one mutation vehicle

Every act with a blast radius is a **change request** — planned, optionally
approved by a second operator, then applied by driving the owning domain's own
idempotent writer.

```
plan  →  [approve]  →  apply
 │           │           └─ taxonomyRepository.moveCategory / mergeCategory / …
 │           │              publishProductTypeVersion
 │           │              publishAttributeDefinition / deprecate / retire
 │           │              publishNavigationTree / archiveNavigationTree
 │           └─ refused when the approver is the requester (code AND a CHECK)
 └─ measures the impact and writes one row per counted relation
```

That single shape makes four separate requirements structural rather than
remembered:

1. **Impact counts are shown before any move, merge or deprecation**, because
   `applyChangeRequest` takes a request id and nothing else. There is no
   parameter it could be handed that would let it act on an unplanned change.
2. **Two-person review** is a gate in FRONT of the existing writer, so it adds
   no second way to mutate anything.
3. **Audit is not a thing somebody remembers to write** — the request row is the
   record, and the append-only trail is written on the same path.
4. **A correction is a NEW request.** Nothing rewrites history; the freeze
   trigger refuses it.

Acts WITHOUT a blast radius — reviewing one translation, deciding one external
mapping, settling one compatibility claim — go straight through
(`review.service.ts`). Wrapping a single-row decision in a two-phase plan would
buy an impact count that is always exactly one.

## The impact plan, and the vacuity floor that is a ROW COUNT

`services/catalog-governance/impact-plan.ts` declares **33 inbound foreign
keys** — 22 into `categories.id`, 8 into `product_type_definitions.id`, 13 into
`attribute_definitions.id`, 2 into `navigation_trees.id` — each with a
disposition and a stated reason.

`impact-plan-census.test.ts` walks the drizzle barrel for the same four targets
and asserts the plan covers **EXACTLY** that set. **A new table referencing a
governed definition fails the build until somebody decides what a governance
change does with it.** It fired on its first run and caught two references a
hand survey had missed (`native_listing_attribute_claims` and
`native_variant_attribute_claims`).

Four dispositions:

| Disposition | Meaning |
|---|---|
| `blocks` | An `ON DELETE restrict` reference. Nothing deletes a definition, so these rows keep pointing at a category that has been merged or deprecated — which is what the redirect chain resolves. |
| `cascades` | The definition's own children. They go with it silently, which is why they are counted. |
| `rewired_by_domain` | A real existing idempotent path fixes these rows. **Named per entry in a machine-readable `entryPoint`**, so the claim is checked by a census rather than by reading it. |
| `rewire_path_missing` | A MEASURED hole. See below. |

There is deliberately no `untouched` member: every foreign key into a definition
points at it, so "this reference is unaffected" is a sentence with no true
instance here.

### The vacuity floor is the ROW COUNT and never the sum

Twenty relations counted, all zero, is a legitimate and useful answer — nothing
points at this category and the change is free. **Zero relations counted is a
different fact entirely, and the two produce the same total.** `0 = 0 + 0 + 0`
satisfies a sum check for both.

So the floor is the number of MEASUREMENTS, asserted three times:

- `measureImpact` refuses a partial report — one failed count takes the WHOLE
  report to `unmeasured` with a reason, because eighteen counts out of twenty is
  the shape that reads as a small change;
- `insertChangeRequest` refuses a report with fewer measurements than the plan
  declared, before any SQL is issued;
- `catalog_governance_change_requests_impact_measured_check` asserts
  `relations_counted >= relations_declared` at the row.

And `impact_coverage` discriminates the two at the ROW SHAPE: an `unmeasured`
request carries **no counters at all**, enforced by two SEPARATE implications
rather than one over their conjunction — written as one, a row that is neither
shape satisfies it because both sides evaluate false (the #68 finding).

An `unmeasured` plan may be RECORDED and may never EXECUTE
(`..._unmeasured_not_applied_check`).

### WHICH version a publication measures (#587)

A floor on the number of measurements says nothing about whether they were taken
against the right subject, and for the two PUBLICATION actions they were not.

`planChange` counted inbound references to the request's own `subjectId`. For
`product_type_publish` and `attribute_publish` that subject is the version being
published — a `draft` — and a draft is exactly what nothing may point at:
`RETRIEVABLE_AUTHORING_LIFECYCLES` is `['published', 'deprecated']`, so
`catalog_authoring_drafts.product_type_definition_id` cannot hold one, and the
attribute half is held by `attribute_definitions_one_active_per_key` plus
`publishAttributeDefinition`'s own `draft` precondition. Every count that
mattered was **zero by construction** — an operator publishing v3 read "nothing
is affected" while every draft, listing and axis pinned to v2 was about to be
reinterpreted. Not a stale number: one structurally incapable of being anything
else.

The population a publication disturbs is the **incumbent it deprecates**, which
both publishers deprecate FIRST in the same transaction, because the
one-published-per-key partial unique index refuses the other order.

`services/catalog-governance/impact-subjects.ts` resolves it, and `measureImpact`
counts over the union with `IN` rather than `=`. Three things decide that shape:

- `catalog_governance_impact_counts_relation_key` is UNIQUE on
  `(change_request_id, reference_table, reference_column)`, so a request has
  exactly ONE measurement per relation. The measurement is therefore over the
  whole affected population, not one per version.
- The subject stays IN the union. `product_type_fields`' own plan entry says its
  count "is what a diff is a diff OF, so it is the first number an operator reads
  before publishing"; and a union can only make a publication read as LARGER,
  which errs toward `GOVERNANCE_HIGH_IMPACT_THRESHOLD` and a second operator.
  Measuring the incumbent alone could make one read as smaller than it is, which
  is the direction of the bug.
- The KEY is read from the subject ROW, never from `parameters`.
  `attribute_publish` carries `attributeKey` as operator-supplied input, and
  resolving the measured population from it would let a caller choose which
  population is reported as this change's blast radius.

The superseded ids are recorded on the `change_requested` audit event's `after`
snapshot and **not** on `CatalogGovernanceImpactReport`. `reportFromStoredRows`
rebuilds that report from columns that do not hold them, so a report field would
be right at plan time and wrong on every later read — two representations of one
fact that can disagree.

`GET /internal/catalog-governance/impact` takes an optional `action` for the same
reason: it is documented as "the preview an operator reads BEFORE planning", so
without the action it previews a publication as zero. A `subjectKind` that
disagrees with the action's own is refused rather than corrected.

The gate is `publication-impact.realdb.test.ts`, which measures the positive
control first (the candidate is a draft, nothing points at it, and the incumbent
genuinely has a draft pinned to it) so that "the count is 1" and "the fixture
built nothing" cannot produce the same green.

### The `category_slugs` rewire now EXISTS, and what it still refuses to do

`listings.category_slugs` is denormalized at write time by
`catalog-write.service.resolveCategory`, and until #367's seam pass nothing
re-derived it: a category rename left every listing beneath it carrying the old
ancestor path, and five services filter on that path. This domain recorded the
hole rather than building a second writer of `listings`.

It is now closed, on the service that already owns the derivation and already
calls the ONE sanctioned writer. `rederiveCategoryBrowsePaths(tx, categoryId)`
re-derives the whole SUBTREE's paths through `updateListingColumns`, and
`apply.ts` calls it after the taxonomy write. There is still no second writer
here, which is what `taxonomy-write-chokepoint.test.ts` and the listing
chokepoint census exist to hold.

**Which three actions call it, and why the other five do not.** The path is
`[ancestor slugs…, own slug]`, so it moves only when a SLUG in it changes:
`taxonomy_rename` **when the request carried a `slug`** (a name-only rename
changes a label and no path); `taxonomy_move`, which re-splices the whole
subtree's ancestry; and `taxonomy_merge`, which answers `null` explicitly
because the loser's listings stay filed under the loser, whose own slug and
ancestry are untouched — a conclusion worth finding stated rather than inferring
from an absence. The four lifecycle actions and `taxonomy_redirect` change no
slug and no ancestry.

**It MUST run inside the caller's transaction, and that is why it is BOUNDED.**
The value is derived from the taxonomy the caller just rewrote; read on a second
connection it would see the PRE-change ancestry — the caller has not committed —
and confidently rewrite every path to the value it already had. Being inside
somebody's transaction is what makes an unbounded pass unacceptable: a top-level
rename would hold row locks on an arbitrary subtree and time out, and the remedy
somebody then reaches for is to stop calling the repair. So the bound is 2,000
listings, a subtree larger than it reports `incomplete` in the audit event's
`after` snapshot, and `scripts/backfill-catalog-paths.ts --apply` finishes the
pass. `incomplete` is PROBED rather than inferred from the budget running out:
a subtree of exactly the bound is complete, and reporting it as incomplete sends
an operator to run a pass with nothing to do.

**What it still refuses to do**, and this is why `listings.category_id` keeps
its `blocks` disposition: it re-derives the PATH and never re-points the
CATEGORY. Re-pointing a listing whose category was merged overwrites a value
that then exists nowhere, so it needs a durable record before it can be
reversible — `docs/catalog-backfill.md` §"The repair this domain does not
perform" states what that record would have to be. One declared side effect:
`updateListingColumns` stamps `updated_at`, so a repaired listing gets a fresh
sitemap `lastmod`. The browse path genuinely changed.

Pinned by `services/__tests__/category-path-rewire.realdb.test.ts`, which drives
the rename inside a real transaction — the only place the post-change ancestry
is visible — and mutation-tests both the subtree scope and the `incomplete`
probe.

### Exactly four relations carry `rewire_path_missing`, and the census says so

`seller_listing_drafts.category_id` (#91 exposes no re-pin entry point),
`product_type_aliases.product_type_definition_id` (#367 workstream 2 owes a
copy-forward in `publishProductTypeVersion`),
`native_variant_axis_assignments.attribute_definition_id` (#367 step 4 exposes
no re-normalization entry point for already-written assignments) and
`category_localized_slugs.category_id` (#739 MEASURED that
`issueCategoryLocalizedSlug` — real, correct, tested — has no production caller
at all, so a category rename mints no superseded chain).

This paragraph said TWO while the plan carried three — the plan and the prose
had drifted, in the direction that reads as fewer gaps than there are.
`listings.product_type_definition_id` was that third, and it is now
`rewired_by_domain`: `previewListingProductTypeUpgrade` then
`applyListingProductTypeUpgrade` move a published listing forward, per listing
and never silently, which is the twin of the draft pair the plan already cited
(`docs/catalog-authoring.md` §"Moving forward").

**`impact-plan-census.test.ts` now pins the EXACT set**, which nothing did
before. The two directions it stops are both silent: relabelling a real gap as
`rewired_by_domain` tells an operator that N rows will be fixed by something
that does not exist, which is the reading `unrewiredRowCount` exists to prevent;
and leaving a CLOSED gap labelled `rewire_path_missing` makes an operator
decline a change that is safe. Mutation-tested — flipping any one disposition
turns exactly that case red.

**It fired on its first rebase**, which is the `merge-plan-census.test.ts`
precedent repeating: `product_type_aliases.product_type_definition_id` arrived
from another branch while #587 was in review, and the pinned set is what
reported it rather than it landing as a fourth silent gap. That is the whole
argument for the case existing — a hand-written paragraph in this file had
already lost count once.

A BULK path over every listing pinned to a version is deferred rather than
missing, and the cost is measured: it needs a `CATALOG_GOVERNANCE_ACTIONS`
member, which `checkOneOf` renders into the CHECK on BOTH
`catalog_governance_change_requests.action` and
`catalog_governance_audit_events.action` (the second via
`[...ACTIONS, ...REVIEW_ACTIONS, ...LIFECYCLE_ACTIONS]`), so it is a code change
plus `db:generate` plus an additive `pre` migration in the same PR — the
`CurrencyCode` rule. Whether such a path is store-scoped or operator-only is a
policy nobody has decided.

### The seam: this domain reaches into other domains' tables to count

Stated plainly because it is a real cost, not a detail. **Impact counts are not
computable from what the domains publish.** No domain in this repository exports
a `countReferences`/`countUsage`-style function — measured, not assumed — so
there is nothing to call. `measureImpact` therefore issues `count(*)` over **33
columns across ten owning domains**. Reads only: `impact.service.ts` contains
zero write statements, and the isolation gate fails the build if that changes.

What makes it acceptable rather than a wall somebody climbed blind is that the
reference set is not hand-maintained. `impact-plan.ts` holds each reference as
the DRIZZLE COLUMN and `impact-plan-census.test.ts` reconciles the plan against
the real foreign-key graph in **both** directions. A hand-written list beside
real tables is a list nothing measures; this one fired on its first run and
caught two references a careful manual survey had missed.

**The honest end state is each domain publishing its own inbound-reference
count, and this domain calling nine functions instead of issuing 33 reads.**
That is nine cross-domain edits for a read that is already census-guarded, which
is why it was not done here — and writing it down is the only thing that stops
it never happening.

### What DOES rewire, and it is not new

- `bumpAuthoringSchemaInvalidation` — every open authoring draft and every
  client ETag re-composes against the changed definition on its next read.
  **Nothing bumped this for a taxonomy or product-type change before Workstream
  12; only proposal approval did.**
- `publishAttributeDefinition` already enqueues one `attribute_reindex_requests`
  row per affected entity. That is the search and normalization rewire.
- The category triggers already mark dependent localizations stale, and
  `moveCategory` already re-splices every descendant's ancestry.

## Two-person review

`CATALOG_FOUR_EYES_REQUIRED` — the flag #55 and #59 already read, and
deliberately not a second one. `GOVERNANCE_HIGH_IMPACT_THRESHOLD` (50) is a code
constant for `CURATION_LARGE_MERGE_IMPACT_THRESHOLD`'s reason: a deployment able
to set it to a million would be one able to switch four eyes off without saying
so.

`requires_second_approval` is **SNAPSHOTTED at plan time**, never re-derived —
the `catalog_merge_jobs` decision, for its reason: the threshold and the flag
both move, and a request whose approval requirement changed after somebody
approved it would either strand a legitimate change or let an unapproved one
through.

An **unmeasured** report needs a second approval whatever the total says.
"We could not measure it" is not evidence that it is small.

Three layers hold it: the snapshot, a service refusal that names the fix, and
`..._approver_distinct_check` + `..._second_approval_check` at the row — so a
service bug that skipped the gate is refused by the database.

## A merchant may never publish a global catalog change

Held **structurally**, not by a check.

`CatalogGovernanceActor` (`services/catalog-governance/actor.ts`) carries a
`unique symbol` declared in that module and exported from nowhere. Only
`governanceActor(req)` mints one, and it composes `catalogOperatorId(req)`,
which is meaningful only after `requireCatalogOperator`. Every apply and every
review function takes one.

A merchant-scoped request holds a store membership from
`requireStorePermission`, and **there is no function anywhere in this repository
that turns a store membership into a `CatalogGovernanceActor`** — so "did this
path check that the caller is an operator?" is answered by the path COMPILING.
#110's `BuyerRequestActor` is the precedent. A wall additionally fails the build
if any module here imports store authorization.

## Roles refine the allow-list and can never extend it

`CATALOG_OPERATOR_OXY_USER_IDS` decides who reaches the surface at all;
`requireCatalogOperator` answers 404 to an account absent from it before a grant
is ever read. **Nothing in `catalog_governance_role_grants` can ADMIT anybody**,
which is what keeps this from being a seventh allow-list.

| Role | Gates |
|---|---|
| `view` | every read |
| `propose` | PLANNING a change — an operator who may draft a taxonomy change and not publish it holds exactly this |
| `review` | external mappings, compatibility claims |
| `translate` | localization review |
| `publish` | every taxonomy, product-type, attribute and navigation apply; snapshot restore; vertical package apply; granting and revoking roles |

**An empty grant table means role separation has not been adopted** — every
allow-listed operator holds every role, which is today's behaviour and what a
rollout mechanism has to default to. The moment any live grant exists, grants
are authoritative.

That transition is a cliff and it is guarded rather than hidden: `grantRole`
refuses a FIRST grant that is not `publish` (it would switch enforcement on with
nobody able to publish), and `revokeRole` refuses one that would leave an
enforcing deployment with no live `publish` holder. Both are service invariants
inside the mutating transaction, because "at least one row elsewhere in this
table" is a subquery and a CHECK may not contain one.

A grant is **revoked, never deleted**: "who could publish last March" is a
question an incident asks first.

## The audit trail

`catalog_governance_audit_events` — actor, reason, before/after, source and
timestamp, append-only against UPDATE **and** DELETE.

`source` is the field worth reading: `operator_console`, `change_request`,
`definition_snapshot` and `vertical_package` lead to different next actions when
a row turns out to be wrong.

`before`/`after` are jsonb, and are the one place a definition's prior shape can
be reconstructed — it cannot be done from typed columns because the shape
differs per subject kind. Localization review deliberately records the LOCALE
and the STATUS and not the translated text: a translation body in an append-only
table is a copy of catalogue content that erasure and correction can never
reach.

`domain: 'governance'` and `subject_kind: 'operator_role'` exist so a role grant
and a snapshot export are not filed under `taxonomy` — "who granted themselves
publish" does not belong in the trail an operator reads when a category went
wrong.

## The review desk

`GET /queues` answers **every** backlog kind, measured or not, in one ordering.
Three of the nine have a count function in their own domain
(`countUnreviewedClaims`, `countQueuedClaims`, `countOpenChangeRequests`); the
other six had none, so they are counted here with the predicate rendered from
the OWNING domain's own exported tuple (`CATALOG_PROPOSAL_OPEN_STATES`,
`CATALOG_EXTERNAL_REVIEW_STATES`). A re-typed `state = 'open'` is a second
spelling that goes stale the day the owning domain adds a state — and it goes
stale in the flattering direction, because a backlog that stops being counted
reads as one that was cleared.

`unmeasured` is a first-class answer: a backlog this deployment cannot read
reports no `total`, because a zero would read as "nothing to do" on precisely
the desk that exists to say what is left. A failed count becomes `unmeasured`,
never zero.

`GET /quality/orphans` finds pointers into definitions an operator has taken out
of service — a navigation node on a deprecated category, a published product
type all of whose category scopes are out of service, a live external mapping
onto a deprecated product-type version. None is a broken foreign key; every one
is valid SQL, which is why nothing else reports them. The scan returns its
`population` beside its findings, because zero findings over zero rows and zero
findings over forty thousand are opposite facts.

## Data quality

`GET /quality` returns completeness by locale, category, product type and
source, plus three duplicate scans.

**`0 / 0` is not 100%.** Every cell carries `eligible` and omits `ratio`
entirely when it is zero — a dashboard rendering an empty locale as complete
tells an operator a market is ready when nothing was measured.
`machine_translated` is excluded from the numerator: an unreviewed machine
translation is work outstanding, and counting it as coverage is how a locale
reports 98% complete while a shopper reads a machine's guess at a legal category
name.

The duplicate detectors answer #367's own example — `Color`, `Colour`, `color `,
`Tono`:

- two published categories whose names normalize together;
- two **active** attribute definitions under different keys with one label;
- two controlled values under **one** attribute whose labels normalize together
  (scoped to one attribute deliberately — `black` under `color` and `black` under
  `strap_colour` are two correct facts).

Normalization is case-folding plus whitespace collapse. **It does not catch
`Colour`**, and that is stated rather than papered over: cross-language and
spelling-variant detection is a dictionary problem, and a fuzzy detector that
reported `Color`/`Colour` would also report `Cover`/`Colour` and be switched off
within a week.

## Version diff

`GET /diff/product-types/:key` and `GET /diff/attributes/:key`.

The diff and the impact report answer different questions and are easy to
confuse: the IMPACT says how many rows point at the definition, the DIFF says
what is changing about it. A publication with a large impact and no breaking
change is safe; one with a tiny impact and a removed required field is not.

`breakingCount` is DERIVED from the entries — a separately maintained count goes
wrong in the flattering direction ("0 breaking changes" over a list containing a
removed required field).

`breaking` is **directional**: a change is breaking when data written under the
OLD version can stop being valid under the NEW one. `optional → required` is
breaking and the reverse is not; a narrowed bound is and a widened one is not;
withdrawing a capability is and granting one is not. Getting the direction
backwards reports every relaxation as dangerous and every tightening as safe.

Two traps the table encodes: **`forbidden` is the STRICTEST requirement**, not
the most permissive — `optional → forbidden` empties every draft that filled the
field; and an **appearing** bound is breaking while a removed one is not, which
a naive numeric comparison gets wrong because one side is null.

A field's identity is `(flow, scope, attributeKey)` and never its row id — ids
are minted per version, so diffing on them reports every field as
removed-and-added.

## Export, snapshot and restore

Catalog **definitions** only. No order, payment, buyer or listing row has a
column here it could arrive in, and the isolation gate scans for their queries
because the document is jsonb and a schema cannot constrain what a composer puts
in one.

The digest is over a **canonicalized** document (object keys sorted, every query
explicitly ordered), so a digest comparison answers "did the definitions change"
and never "did the planner reorder".

**A restore is INSERT-ONLY and reports divergence rather than correcting it** —
`seed-verticals`' vocabulary and its ruling: overwriting a divergent row would
silently undo whatever an operator changed since the snapshot was taken, which
is exactly the state somebody reaching for a restore is trying to understand.
"Restore" means "put back what is missing".

`apply` defaults to **false**. The plan still READS the database, so it is a
statement about this deployment rather than about the document.

Restore covers `taxonomy` (and `all`). The other four scopes are **refused with
a stated reason** rather than half-built (`RESTORE_UNSUPPORTED_SCOPES`), and the
isolation gate reconciles supported against unsupported in both directions — a
scope in neither list is one a restore silently treats as a no-op and reports as
a clean run.

An **empty export is refused**: a snapshot of nothing digests cleanly, restores
cleanly and reports "nothing to do", which is the one failure mode a restore
cannot recover from.

## Vertical packages

`scripts/seed-verticals/` already shipped three reference packages, already
wrote every entity through the real domain services, was already insert-only and
already reported `create`/`present`/`divergent`. What it had no caller for was a
real deployment: its only entry point was a CLI.

`vertical-package.service.ts` is that caller and nothing else — no writer, no
second package format, no force mode.

The **census** is the vacuity floor and the reason to run one: it derives the
expected counts FROM the package data and answers
`matched | vacuous | mismatched | unmeasurable`. A package application that
wrote nothing reports a tidy list of `present` steps and no errors, and only a
census that knows what SHOULD be there can tell that from a clean re-run. It
runs on an APPLY and not on a plan — on a plan there is nothing to count yet, so
a census would report `vacuous` for a package about to be written correctly.

Versioning is the **namespace**. `VerticalPackage` carries no version field and
no digest; a version an operator could set but nothing could verify is worse
than none.

## What this surface deliberately does NOT do

The route set is CLOSED (28 routes), enumerated exactly by the isolation gate.

- **No proposal decision route.** All seven live at
  `/internal/catalog-proposals/*` behind this same gate, writing the same
  `catalog_review_events` trail. A second route to one decision is how two
  surfaces come to disagree about what it meant. This surface CONSUMES proposals
  by counting their backlog on the desk.
- **No direct attribute draft or publish.** `/internal/catalog-attributes` owns
  that; this surface plans a publication so the impact is measured first.
- **No DELETE verb anywhere.** `delete_definition`, `rewrite_audit_history` and
  `edit_applied_change_request` are named in
  `CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES`, and the triggers refuse all three
  whatever a route did.
- **No force over a divergent row**, in a restore or a package application.

## Seams and what is NOT satisfied

Stated rather than claimed:

- **`listings.category_slugs` re-derivation — CLOSED.** The entry point landed on
  `catalog-write.service` (`rederiveCategoryBrowsePaths`) and `apply.ts` calls it
  for a slug rename and a move. See §"The `category_slugs` rewire now EXISTS"
  above for the bound, what `incomplete` means, and the re-pointing of
  `category_id` it still refuses.
- **Localization review covers categories and product types.**
  `attribute_value_localizations` has an upsert but no reviewed-status path
  through this surface yet; its backlog IS counted on the desk.
- **`product_type_localizations` has no stale trigger** (the localization domain
  records this as owed), so a product-type rename does not mark its translations
  stale the way a category rename does. The completeness metric reports what is
  there; it cannot report staleness nothing writes.
- **Duplicate detection is exact-after-normalization**, not fuzzy. See above.
- **No effective-dating UI for taxonomy.** `categories.effective_from`/`_to`
  exist and `updateCategoryPresentation` accepts them; no governance action sets
  them, because a windowed publication needs a sweep nobody owns.

## Testing

- `impact-plan-census.test.ts` — the plan against the SCHEMA, exact identity
  both ways, with a walk floor, a per-subject positive control and a mutation
  self-test.
- `catalog-governance-isolation.test.ts` — six scanned walls, each with a
  vacuity floor and a mutation self-test; the vocabulary reconciliations; the
  closed route set; the auth-before-allow-list ordering.
- `diff.test.ts` — the direction rules, as tables, over the PURE differ.
- `definition-diff.realdb.test.ts` — the HYDRATION the two diff routes actually
  call, which had no behavioural test at all until #587: per-flow field
  concatenation (mutation-tested), group comparison by KEY across per-version
  group rows, category scopes, the attribute half through
  `resolveDefinitionVersion`, and the three refusals.
- `publication-impact.realdb.test.ts` — a publication's impact preview counts the
  version it DEPRECATES, with the positive control taken first.
- `catalog-governance.realdb.test.ts` — both impact-coverage CHECKs, the
  four-eyes CHECKs, the freeze and append-only triggers, the role-grant partial
  unique and its immutability, the snapshot count identity.


## A `rewired_by_domain` claim is checked, not read (#739)

The disposition means "a real, existing, idempotent path fixes these rows".
`impact.service.ts` filters only `rewire_path_missing` into the operator's gap
warning, so **a false `rewired_by_domain` is silent by construction**: the
preview reports no gap for rows about to be dropped, and nothing goes red.

A sweep of all 14 path-asserting entries found **two false** — both naming a
real, correct, tested function with ZERO production callers
(`copyForwardProductTypeLocalizations`, closed by #650;
`issueCategoryLocalizedSlug`, still open and now labelled honestly) — and **two
more** whose named path ends in `attribute_reindex_requests`, a queue with three
enqueuers and no consumer (#664).

### The identifier is a field, not a sentence

`GovernedReference` is a discriminated union on the disposition, so
`rewired_by_domain` without an `entryPoint` is a `tsc` error. A property
enforced by the type system needs a gate in the type system: the one shape a
census can never check is the entry point nobody wrote.

`RewireEntryPoint` has three kinds, because two real entries do not fit "a
function repairs the rows" and forcing them to would be a vocabulary that lies:

| Kind | What it means | The entry that needs it |
|---|---|---|
| `function` | An idempotent path a caller drives, which FIXES the rows. | eleven of thirteen |
| `trigger` | The database does it; there is no TypeScript symbol to name. | `category_localizations.category_id` → `mercaria_categories_localization_stale` |
| `derivation` | Nothing repairs anything because nothing is stored wrong — the read consults the governed row LIVE, so the change bites with no sweep having run. | `navigation_nodes.category_id` → `listNavigationCategoryTargets` |

A `derivation` still names a symbol and is checked exactly as a `function` is.
What the kind records is that no repair is owed.

### What `rewire-entry-point-census.test.ts` can actually fail on

Over a WALKED population of production modules — the test tree excluded, because
a test is not a call site, and comments stripped, because this repository
documents what it forbids in the same vocabulary:

- a named symbol no module exports;
- a symbol exported and **called by nothing**, which is the defect itself and
  the one a "does the function exist" check cannot see;
- a trigger no migration creates;
- a queue declared undrained that has **gained** a consumer, so #664 landing one
  turns this red rather than leaving a stale claim standing.

Every walk carries a vacuity floor and every detector a mutation self-test. The
completion-column detector needed three narrowings and its positive control
caught the worst: matching the enclosing `.set({ … })` object fails on a drizzle
`sql` template, whose `${col}` contains a `}`, so a `[^}]*` body stopped before
the column and reported the real writer as clean.

Measured against the pre-fix state rather than by mutating to a red — both false
entries are named, with the remedy in the message.

### `rewiresAwaitingDrain`: a rewire that starts and does not finish

A THIRD list on the impact report beside the total and `rewirePathsMissing`,
holding the two `publishAttributeDefinition` relations.

`rewire_path_missing` would be the wrong disposition for them: the enqueue is
real, committed and idempotent, so calling it missing would say no work happens.
Plain `rewired_by_domain` is the wrong claim, because the rows are still wrong —
nothing writes `attribute_reindex_requests.processed_at`, which
`catalog-observability/queries.ts` and `trace.service.ts` both record, and the
reindex hop reports `unreachable` rather than `pending` for that reason.

It is DERIVED from the plan and re-derived on a stored-row rebuild, so a request
planned before #664 lands reads against what is true now.
