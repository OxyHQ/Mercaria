# Operator-write audit census — specification and handoff

**Status: specified, not built.** The population, the binding, the vocabulary and
the gates below are settled and reproducible. The 139 per-route reads that fill
the map are **not done**, and there is no automated pre-pass that can do them —
see "The two demonstrated negatives", which is the most valuable part of this
document.

Everything here is marked **Measured** (a command was run, the number is its
output) or **Unmeasured** (a judgement, a plan, or a prediction). Nothing is
stated flatly without one of those two labels.

Base: **`7bcce335`**. Every number below was re-measured at that SHA after the
scripts were parameterised for the repo root; a number without a SHA beside it
is a number about nothing.

---

## 1. The line

Epic **#367**, Workstream 15 (Security and abuse):

> - [ ] **Audit privileged catalog mutations.**

Anchor on that TEXT, not on the ordinal — the epic's line numbers move.

**Unmeasured (reading):** the line asks whether every privileged catalogue
mutation leaves an audit record attributable to the operator who made it. It is
a question about a POPULATION — "every" — so the answer is a map over that
population, not an example. That is why this is a census rather than a test of
three routes.

---

## 2. Population

**Measured at `7bcce335`** (`scripts/derive.mjs`, `scripts/reconcile.mjs`):

```
all .ts under packages/backend/src/routes/   174
  matching the catalog-operator gate          43
    of which __tests__                        13
    routers                                   30
      with >= 1 write route                   23   -> 139 write routes
      with 0 write routes                      7
```

`43 = 30 + 13` and `20 = 13 + 7` both reconcile exactly.

**Measured:** the team lead derived 139 write routes independently and reached
the same figure.

The gate is `requireCatalogOperator|CATALOG_OPERATOR_OXY_USER_IDS`; a write
route is `router.(post|patch|put|delete)`.

**The exclusion must be ASSERTED, not performed.** Thirteen files under
`routes/__tests__/` match the gate and are not routers. A census that silently
drops them cannot tell "these are tests" from "these routers were never found" —
finding fewer looks identical to there BEING fewer. The census asserts that every
excluded path contains `__tests__`, **and states a reason per excluded path**,
per the lead's ruling that population exclusion carries a per-route reason and
never a blanket.

**Unmeasured (trap, flagged for whoever builds it):** if the census test file
itself is placed under `routes/__tests__/`, it becomes the fourteenth gated test
file and moves the excluded count. Assert the exclusion as a PROPERTY plus a
floor rather than as the exact literal 13, or site the test outside `routes/`.

---

## 3. Binding — the question that decided a census was writable at all

**Measured at `7bcce335`** (`scripts/resolve.mjs`):

```
routes                   139
handler module resolved  139
handler body resolved    139
```

**139 / 139.** No dispatch table, no handler factory, no re-export chain the
resolver could not follow. So the census needs **no hand-maintained exception
list** — which matters, because a gate that skips what a hand-maintained map
omits is not a gate.

**Measured:** of those 139 handler bodies, exactly **1** contains a trail writer
directly. Handlers delegate; that is the normal shape here, and it is why a
handler-body check is not a disposition.

**Measured (trap):** the router filename never predicts the controller filename.
`internal-commerce-graph.ts` handlers live across several controllers. The
resolver follows imports, so this costs nothing — but a human reading the list
must not assume the pairing. The census docblock is required to say so.

---

## 4. The disposition vocabulary — five values, evaluated IN ORDER

The order is not cosmetic. Each step below is only asked if every step above it
answered no.

1. **`trail_write`** — the route's own call chain reaches a trail writer:
   `recordAuditEvent`, `recordRevision`, `recordCompensation`, `insertReviewEvent`.
2. **`actor_column`** — the row this route writes carries the operator's identity
   in a real column (a resolved drizzle column, not a name that looks like one).
   **Measured example:** `runIntentBenchmark` writes `ran_by_oxy_user_id`, NOT
   NULL with a CHECK. It has **0** non-route callers, so under step 4 it would
   read as a gap; it is not one. This is exactly why `actor_column` precedes
   `drives_existing_path`.
3. **Population exclusion** — the route is not a privileged catalogue mutation at
   all. **Ruled by the lead:** this sits ABOVE both step 4 and step 5, and
   **carries a reason per route**, never a blanket. A route that is `POST` and
   mutates nothing is a population error, not a gap.
4. **`drives_existing_path`** — the route drives an already-audited path rather
   than performing its own mutation. **Two conditions, both required:** the
   symbol RESOLVES, **and** this route's own handler body reaches it, **and** it
   has at least one non-route caller **excluding its defining module**
   (`scripts/callers2.mjs`). Naming a real symbol this route never reaches must
   fail.
5. **`unaudited_gap`** — fail-closed. Anything that reaches this value is a
   finding.

**Ratchet:** built now, against **zero**. The census asserts the gap count does
not exceed a recorded ceiling, and the ceiling starts at 0 so the first genuine
gap has to be looked at rather than absorbed. **Deferred by the lead:** openness
(whether the ceiling may ever rise, and who may raise it).

---

## 5. Gates the census owes on itself

- **Vacuity floors whose failure messages QUOTE what they searched.** A floor
  that says "expected >= 1" tells the next reader nothing; one that prints the
  pattern and the directory tells them whether the search was the problem.
- **Four mutation self-tests**, including the one the lead named:
  *naming a REAL symbol this route never reaches must fail* — the check that
  distinguishes `drives_existing_path` from "a plausible symbol was typed".
- **A docblock recording** that the router filename never predicts the controller
  filename, and that the handler is the last bare identifier in the
  `router.<verb>(...)` argument list.

---

## 6. The two demonstrated negatives — read this before writing any walker

These are the findings most likely to be rebuilt by the next reader, at a cost
of hours, ending where they ended here.

### 6.1 A call-graph walker cannot produce the dispositions

**Measured at `7bcce335`** (`scripts/twohop.mjs`, `scripts/deep.mjs`):

```
                     2-hop      depth-5
trail                   23           24     (2-hop: 1 in handler + 22 at hop 2)
actor column            35           39
neither                 81           76
```

Deepening the walk from 2 hops to 5 moved **five** routes. Seventy-six remain in
`neither`, and `neither` is indistinguishable from a real gap by construction.

### 6.2 `POST /roles` is in `neither` and is AUDITED

**Measured:** `catalog-governance POST /roles` and `POST /roles/revoke` both sit
in the depth-5 `neither` bucket. The chain, verified by hand and confirmed
independently by the lead:

- controller calls `grantRole` at `catalog-governance.controller.ts:361`
- `grantRole` is `services/catalog-governance/role.service.ts:129`
- `recordAuditEvent` is inside it, at `:159` (and again at `:216`)

Two hops. The walker was built to find exactly that and did not. The bug was not
chased, because the conclusion does not depend on it: **a walker that misses a
two-hop chain it was designed for will miss others, in whichever direction its
silent `null` pushes them, and it will report them as a tidy bucket.** A
half-built map filled by this generator would have looked finished and passed its
own census.

**Unmeasured (judgement):** the 81 → 76 near-miss is the pattern to distrust. A
pass of 139 has 139 such rows, and the failure mode of a hint generator is that
its wrong rows are the ones nobody re-reads.

---

## 7. What is left, and how to do it

**The 139 per-route hand-reads.** Start from `routes.txt` (this script's output
at `7bcce335`) and read each handler individually, following its call chain to a
trail writer or an actor column and recording the disposition and the evidence.

**Ruled by the lead:** there is no level between the route and the read at which
the work is bounded, and the 139 are **not to be fanned out** — the map's value
depends on consistent judgement across all of it, and inconsistency between
batches is invisible in the finished map. One reader, one pass.

The scripts are worth running first anyway: `derive` + `reconcile` to confirm the
population still reconciles at your SHA, `resolve` to confirm the binding still
holds at 139/139. If either has moved, the numbers above are stale and this
document says so about itself.

---

## 8. Running the scripts

```
node docs/handoffs/743-operator-write-census/scripts/derive.mjs      # population per router
node docs/handoffs/743-operator-write-census/scripts/reconcile.mjs   # the __tests__ exclusion
node docs/handoffs/743-operator-write-census/scripts/extract.mjs     # the route list (regenerates routes.txt)
node docs/handoffs/743-operator-write-census/scripts/resolve.mjs     # the binding
node docs/handoffs/743-operator-write-census/scripts/twohop.mjs      # DISPROVED hint generator
node docs/handoffs/743-operator-write-census/scripts/deep.mjs        # DISPROVED hint generator
node docs/handoffs/743-operator-write-census/scripts/callers2.mjs SYMBOL [SYMBOL...]
node docs/handoffs/743-operator-write-census/scripts/callers.mjs  SYMBOL [SYMBOL...]   # VACUOUS, kept as a negative
```

They take no arguments beyond that, resolve the repo root from their own
location, read only, and finish in seconds.

**Measured:** all seven were re-run at `7bcce335` after the path change and
reproduce every figure in this document.

---

## 9. Provenance

Branch `test/743-operator-write-census`, no PR — a pushed branch is a durable
artefact and nothing merges by accident. Written by the `survey-missing` lane on
2026-08-23 at the point where it declined to start the 139 reads, on the measured
grounds that its own error rate had surfaced twice that session (a
docblock-as-evidence reversal, and a fabricated mechanism in a product-page
claim) and that a 139-item judgement pass is the worst possible place to spend a
degraded judgement — because the artefact would then carry the authority of
having been computed.
