# Runbook — catalog integrity findings (#367 W17)

The periodic sweep found something a CHECK constraint cannot express. Reference:
[../catalog-observability.md](../catalog-observability.md) §"The periodic
integrity checks".

**Nothing in this domain repairs, and that is deliberate.** Every one of the six
findings can be something an operator did on purpose, mid-migration — a category
suppressed while its subtree is rebuilt, a redirect staged ahead of a cutover, a
product type pulled back to `review` because its fields were wrong, a lease held
by a task somebody is about to restart. A sweep that "corrected" any of them would
undo a decision, silently, at whatever hour it happened to run. So every remedy
below is a deliberate act through the domain that owns the write.

**Read `complete` before you read any finding count.** A partial sweep reporting
zero findings across five checks is not a clean catalogue, and `complete` is the
only thing standing between those two readings — `CatalogIntegrityResult` has no
failed state and must not grow one, so a check that threw is OMITTED rather than
reported as clean.

**Owner:** the on-call engineer for the Mercaria API. `ancestry_path_drift` and
`category_cycle` escalate to whoever owns the taxonomy.

---

## The alert

`GET /internal/catalog-metrics/integrity`, behind
`CATALOG_OPERATOR_OXY_USER_IDS`. There is no sweep loop in this repository: this
is the route a scheduled probe calls, and the cadence is `oxy-infra`'s
configuration.

| Condition | Severity |
|---|---|
| `complete: false` | **highest.** A check did not run; the report is not evidence of anything |
| `ancestry_path_drift.findings > 0` | **critical.** Silently wrong reads (below) |
| `category_cycle.findings > 0` | **critical.** Cannot arrive through this application at all |
| `schema_version_unavailable.findings > 0` | **critical.** A published record's schema can no longer be re-derived |
| `invalid_redirect.findings > 0` | warning |
| `orphaned_reference.findings > 0` | warning |
| `stalled_queue_lease.findings > 0` | info — see below, this one is often nothing |
| any `population == 0` where you expect rows | warning. The check examined nothing |
| any `population == 5000` | info. The scan hit `INTEGRITY_SCAN_LIMIT` and saw one page |

## `ancestry_path_drift` is the one that matters most

`categories.ancestor_ids` is ADR 0007 D2's materialized path — root-first,
excluding the row itself — and **it has no CHECK, no trigger and no gate.** A
CHECK may not read another row, and a trigger that recomputed the array would be
a second writer for a fact the move statement owns. `moveCategory` in
`db/taxonomy/taxonomyRepository.ts` is the only thing that maintains it.

So a raw `update categories set parent_id = …` at a `psql` prompt is **accepted in
full, errors nowhere, and every descendants read is wrong from that moment on.**
What that looks like from the outside:

- a subtree that quietly stops appearing under the parent it was moved to;
- a category that keeps appearing under the parent it left;
- a facet scope that covers products nobody filed there — the facet-scope sweep
  reads descendants, so a drifted node changes what
  `facet_scope_empty_rate` measures.

Each of those looks like a catalogue somebody mis-filed rather than like a bug,
and the whole class is invisible until it is measured against the `parent_id`
edges themselves. That is what this check does: it recomputes the true path from
`parent_id` alone, bounded at `CATEGORY_WALK_DEPTH_CAP` (64) in the recursive
term so a cycle cannot hang it, and reports every row where `ancestor_ids is
distinct from` the recomputed path.

**A category in a CYCLE also reports here, deliberately** — its stored ancestry
cannot be right — so read `category_cycle` first, because that check names the
cause.

## What a finding does NOT mean

- **`stalled_queue_lease` is not a fault by itself.** A task restarting mid-page
  leaves exactly this, and the reclaim path takes the lease back on the next tick:
  `claimBackfillRun` claims a `running` row whose `lease_until` has passed, and
  `listResumableBackfillRuns` includes them. What the check measures is work that
  has stopped MOVING.
- **`invalid_redirect` does not mean a chain exists.** Chains are the DOCUMENTED
  correction pattern (a redirect pointing at the wrong category is corrected by
  adding a redirect FROM that wrong target onward) and the resolver follows them.
  A finding means the resolver can no longer WALK it — `resolveCategoryRedirect`
  answered `chain_exhausted` past its own `MAX_REDIRECT_HOPS`, or `unresolved`.
- **`orphaned_reference` does not include a MERGED target.** A proposal's resolved
  id that has since been merged is not an orphan: the tombstone row survives and
  carries `merged_into_id`. The check finds only a target with no row at all.
- **`schema_version_unavailable` does not mean a row VANISHED.** The foreign key is
  `restrict` on both sides it checks, so the version cannot be deleted. What it
  can do is go back to an EDITABLE lifecycle (`draft` or `review`), which no key
  expresses — and then the schema a merchant's answers were recorded under is no
  longer obtainable.
- **A `population` of zero is not health.** It says the table is empty. On a
  freshly migrated database all six legitimately report zero over zero.
- **A finding count is not a row count above the limit.** Every scan is bounded at
  5,000, ordered `id desc` (uuid v7, so newest first). A `population` equal to the
  limit means the check saw the newest page and no more.

## The first three things to check

**1. `complete`, then every `population` beside its `findings`.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics/integrity \
| jq '{complete: .data.complete, checkedAt: .data.checkedAt,
       results: [.data.results[] | {kind, population, findings}]}'
```

If `complete` is false, find the logged failure — the omitted check logs
`catalog integrity check failed` with its `kind` at `error` level — and fix that
before reading anything else.

**2. Open the samples. They are `<table>:<id>` handles and nothing else.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics/integrity \
| jq -r '.data.results[] | select(.findings > 0)
         | "\(.kind) (\(.findings)/\(.population)): \(.sample | join(", "))"'
```

The sample is bounded at `INTEGRITY_SAMPLE_LIMIT` (20), so `findings` above 20
means there are more than the sample shows. It carries no name, no slug and no
free text, deliberately: an operator id and a merchant handle both live one join
away and neither belongs in a health report.

**3. For an ancestry finding, get the shape of the damage before touching
anything.**

```sql
-- Read only. The drifted rows, with the path the tree actually describes.
with recursive walk (subject_id, node_id, depth, path) as (
  select c.id, c.parent_id, 1, array[c.parent_id]
    from categories c where c.parent_id is not null
  union all
  select w.subject_id, p.parent_id, w.depth + 1, array[p.parent_id] || w.path
    from walk w join categories p on p.id = w.node_id
   where p.parent_id is not null and w.depth < 64
), truth as (
  select distinct on (w.subject_id) w.subject_id, w.path
    from walk w order by w.subject_id, w.depth desc
)
select c.id,
       cardinality(c.ancestor_ids) as stored_depth,
       c.ancestor_ids              as stored_path,
       coalesce(t.path, '{}')      as true_path
  from categories c
  left join truth t on t.subject_id = c.id
 where c.ancestor_ids is distinct from coalesce(t.path, '{}'::text[])
 order by cardinality(coalesce(t.path, '{}')) asc;   -- SHALLOWEST FIRST
```

The ordering is the point — see the remedy.

## Likely causes, most likely first

1. **A hand-written `UPDATE` on `categories.parent_id`.** The only way ancestry
   drift arrives through ordinary access, because nothing in the application
   writes `parent_id` except `moveCategory`, `insertCategory` and
   `mergeCategory`. Look for a maintenance session or a script.
2. **A restore, a bulk load or a replication stream.** `SET
   session_replication_role = replica` suppresses user triggers by definition, so
   a cycle and a drifted path can both arrive that way with every constraint
   silently bypassed. This is why `category_cycle` exists at all —
   `mercaria_category_hierarchy_guard` refuses a cycle on INSERT and on any UPDATE
   that moves `parent_id`, so a cycle cannot come from this application.
3. **An operator mid-migration.** A suppressed category, a product type pulled
   back to `review`, a staged redirect. All three produce findings and all three
   may be correct.
4. **A task that died mid-page.** `stalled_queue_lease`, and the reclaim handles
   it.
5. **An open change request or proposal whose subject was removed.**
   `orphaned_reference` over
   `catalog_governance_change_requests.(subject_kind, subject_id)` and
   `catalog_proposals.(type, resolved_entity_id)` — both polymorphic, so no
   foreign key is possible.
6. **A dispatcher that is off** while claims sit unexpired-then-expired.
   `CANONICAL_GRAPH_ENABLED` gates #60's backfill loop.

## Remedy

### `ancestry_path_drift` — RE-DERIVE, never delete

The fix is to make `ancestor_ids` agree with `parent_id` again by running the
**real writer**, which computes the array from the parent's own arrays and
rewrites the whole subtree in one statement. The audited path is a governance
change request:

```bash
# 1. plan a taxonomy_move naming the parent the category ALREADY has.
#    The body is `.strict()` and takes exactly these four keys.
curl -s -X POST -H "Authorization: Bearer $OXY_TOKEN" -H 'content-type: application/json' \
  -d '{"action":"taxonomy_move","subjectId":"<categoryId>",
       "parameters":{"parentId":"<its current parent id, or null for a root>"},
       "reason":"re-derive ancestor_ids after an integrity drift finding"}' \
  https://<api>/internal/catalog-governance/changes
# 2. if the planned impact requires a second pair of eyes, a DIFFERENT operator
#    approves: POST .../changes/<changeId>/approve with {"reason":"…"}
# 3. apply. No body.
curl -s -X POST -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-governance/changes/<changeId>/apply
```

`parentId` must be present even when it is `null` — the driver reads the key's
PRESENCE, because a null parent is a legitimate destination that makes the
category a root.

`applyChange`'s `taxonomy_move` branch calls `moveCategory(subjectId, parentId)`,
which reads the parent, writes `ancestor_ids` and `ancestor_slugs` on the row, and
then rewrites every descendant in one statement.

**Work SHALLOWEST FIRST, and re-run the check between passes.** The descendant
rewrite is `where d.ancestor_ids @> array[<categoryId>]` and it splices at
`array_position(d.ancestor_ids, <categoryId>) + 1` — so a descendant whose own
array does not already CONTAIN the moved node is not matched by it, and a deep
repair done first can leave the nodes above it still wrong. That is why the SQL in
step 3 orders by the true depth ascending.

If a move cannot reach a row at all (the node is in a cycle, so its true path does
not exist), fix `category_cycle` first: a cycle has no head, both nodes report,
and no ancestry is derivable until one edge is broken.

Writing `ancestor_ids` by hand is the last resort, and it has two rules the check
enforces: **root-first**, and **excluding the row itself**. An array carrying the
right ids the wrong way round passes every membership query and renders every
breadcrumb backwards — the realdb suite pins exactly that case. Re-run the check
afterwards; do not assume.

**Never DELETE a drifted category.** A wrong array is a repairable fact; a deleted
category takes its redirects, its localizations, its navigation nodes and every
product filed under it with it, and several of those foreign keys are `restrict`
precisely so that cannot happen quietly.

### The other five

| Kind | Remedy |
|---|---|
| `category_cycle` | Break one edge with a `taxonomy_move` through the governance path. The hierarchy guard will then refuse to let it back. Fix this BEFORE any ancestry repair. |
| `schema_version_unavailable` | Re-publish that product-type version — plan and apply a `product_type_publish` change. Do not edit the draft or the variant axes to point elsewhere: the pin is the audit record of what was published. |
| `invalid_redirect` | If the target is missing, add a redirect from it onward to a live category. If the chain is too long, add ONE redirect from the head straight to the final destination — `category_redirects` is append-only and nothing ever ends a redirect, because a URL that resolved last year should resolve today. |
| `orphaned_reference` | A change request naming a subject that is gone can never be applied: `POST /internal/catalog-governance/changes/<id>/withdraw` (or reject it), with the reason. A proposal whose resolved entity is gone is an operator decision on `/internal/catalog-proposals/<id>/*`. |
| `stalled_queue_lease` | Usually nothing. Confirm the owning dispatcher is running and that the run is progressing (`GET /internal/backfill/runs`, `GET /internal/backfill/metrics`). Only if the owning task is genuinely gone does the lease matter, and it expires on its own. |

## What NOT to do

- **Do not clear a lease.** Clearing one under a task that is merely slow is how
  two workers end up on one page. The expiry is the mechanism.
- **Do not delete a redirect** to make `invalid_redirect` go quiet. The table is
  append-only by design and a deleted redirect is a URL that stops resolving for
  everybody who ever had it.
- **Do not delete a change request or a proposal row.** Withdraw or decide it, so
  the audit trail says who did and why.
- **Do not add a trigger that recomputes `ancestor_ids`.** It would be a second
  writer for the fact `moveCategory` owns, and the two would disagree exactly
  where a subtree move is interrupted. The check exists BECAUSE the invariant is
  maintained in one place.
- **Do not `catch` a `23503` anywhere near this.** A foreign-key violation while
  repairing is information — usually that you are deleting a parent whose children
  are still there.
- **Do not read `findings: 0` as clean without `population`.** Six populations of
  zero and six broken population queries produce the same six zeroes, which is
  what `population` exists to separate.
- **Do not treat `complete: true` with findings as worse than `complete: false`
  with none.** The second is the one that tells you nothing at all.
