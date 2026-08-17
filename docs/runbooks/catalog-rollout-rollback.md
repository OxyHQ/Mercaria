# Runbook — rolling the #367 catalog rollout back

Something in the staged rollout of the catalog epic is wrong and you want the
previous behaviour back. Reference:
[`../catalog-migration-operations.md`](../catalog-migration-operations.md) and
ADR 0007 D12/D13.

**This document has never been executed. Read §6 before you believe any of it.**
A rollback document that has never been run is a hypothesis, and the incident is
when somebody finds that out. What follows separates, line by line, what is
verified by reading the code and by a reproducible census (most of it), from what
is verified by having done it (none of it).

**Owner:** the on-call engineer for the Mercaria API. Withdrawing a published
taxonomy or navigation tree is the catalogue operator's, and is a data change
rather than a lever — see §4.

---

## 0. Before you turn anything off: the precondition nobody would guess

**`CATALOG_OPERATOR_OXY_USER_IDS` must be non-empty, or the rollback makes the
catalogue evidence unreachable over HTTP.**

D12 promises that "the evidence has to be readable during the incident that
turned the levers off", and the code delivers it: nine `/internal/*` catalog
surfaces are gated on the operator allow-list and on **no rollout lever** —
`/internal/catalog-proposals` (`app.ts:286`), `/internal/canonical-catalog`
(`:519`), `/internal/offers` (`:745`), `/internal/catalog-attributes` (`:755`),
`/internal/catalog-condition` (`:760`), `/internal/matching` (`:782`),
`/internal/navigation` (`:992`), `/internal/catalog-governance` (`:1008`) and
`/internal/catalog-metrics` (`:1014`).

But that gate is **derived**: `config.catalog.graphOperatorSurfaceEnabled` is
`resolveCatalogOperatorIds().length > 0` (`config/index.ts:3716`). An empty list
makes all nine **404, not 401**. So with an empty allow-list and every rollout
lever off, there is no HTTP surface that can read a proposal, a navigation tree,
a mapping or a metric.

**Check it first**, and check it with a real operator token so you can tell the
three answers apart: **200** is fine; **403** means you are authenticated and not
on the list; **404 with an operator's token means the list is empty.**

---

## 1. The levers, and what each one actually withdraws

**ADR 0007 D12 names six levers. Four exist.** Do not quote the other two at
anybody — `CATALOG_LOCALIZATION_ENABLED`, `PRODUCT_TYPES_ENABLED` and
`CATALOG_AUTHORING_COHORTS` appear nowhere in `packages/backend/src`, and
`FACETS_ENABLED` is a real lever D12 does not mention. Full inventory:
[`../catalog-migration-operations.md`](../catalog-migration-operations.md)
§"The lever inventory".

| Set this to `false` | Mounts withdrawn | Blast radius |
|---|---|---|
| `CATALOG_AUTHORING_ENABLED` | `/stores/:storeId/product-drafts`, `/catalog-authoring` (`app.ts:258-260`) | merchants cannot author or publish through the new wizard; **every saved draft stays saved** |
| `CATALOG_PROPOSALS_ENABLED` | `/catalog-proposals` (`:274-275`) | merchants cannot submit; **submitted proposals stay, and an operator can still decide them** through `/internal/catalog-proposals` |
| `FACETS_ENABLED` | `/facets` (`:737-738`) | the storefront filter rail disappears; the domain owns no table and writes no row, so nothing durable is involved |
| `CATALOG_TAXONOMY_V2_ENABLED` | `/navigation` (`:978-979`) | the storefront menu falls back to the v1 category tree (§3); **every tree, node and label stays readable** through `/internal/navigation` |

**Five mounts, every one a surface this epic ADDED.** Nothing a shopper or a buyer
used before the epic is behind any of them: `/listings` (`app.ts:243`),
`/categories` (`:245`), `/cart` (`:316`), `/checkout` (`:318`), `/search`
(`:589`), `/catalog-attributes` (`:729`), `/compatibility` (`:1028`) and
`/product-types` (`:1040`) are all unconditional.

**Order does not matter and there is no ordering constraint between them** — each
guards an independent `app.use` and none reads another. **A restart is required**:
`config/index.ts` reads `process.env` once at import and the config object is
frozen, so an ECS task picks up a changed variable only on a new task.

---

## 2. The rollback itself

1. Confirm §0.
2. Set the levers you need to `false` in SSM (`/oxy/mercaria/…`) and roll the
   service. **Change one lever at a time if you can afford the rolls**, because
   nothing here has been rehearsed and a per-lever roll is the only way to
   attribute a surprise.
3. Verify the withdrawal is the one you wanted, per lever: the five paths in §1
   answer 404, and the eight unconditional paths in §1 still answer.
4. Verify nothing durable moved. All of these read through
   `/internal/*`, which is unaffected:
   - `GET /internal/catalog-metrics` — `proposal_backlog_count` and
     `draft_open_count` are the same numbers as before the roll. They read stored
     ROWS, so they keep working whatever the route flags say. Note that
     `authoring_schema_*` and the facet metrics will now answer
     **`surface_not_mounted`** rather than zero, and that is the correct reading —
     render it as "not switched on here", never as a seam or a zero.
   - `GET /internal/catalog-governance/queues` — the unresolved-claim counts are
     unchanged.
   - `GET /internal/navigation` — every published tree is still there.
5. Verify the storefront degraded rather than broke (§3).
6. Record what you did and what you saw. This runbook's §6 is a list of things
   nobody has observed; anything you observe belongs in it.

**Nothing in a rollback deletes catalog evidence, and that is structural rather
than a promise.** The four levers are read in exactly **six** places in
`packages/backend/src`, and four of those are the mount itself; the other two are
`services/catalog-observability/metrics.service.ts:745-746`, which decide whether
a metric reads `surface_not_mounted`. **No repository, no outbox enqueue, no loop
and no checkout path reads one.** That census is the strongest evidence the
rollback has, and it is reproducible in one grep.

---

## 3. What the storefront does when the levers go off

**Navigation degrades by design, and the mechanism is real.**
`packages/frontend/lib/catalog/use-navigation.ts` is ONE React Query query with
the fallback inside the query function: it asks `GET /navigation` and, on **any**
failure or on an empty tree list, asks the always-mounted `GET /categories`
instead (`:89`). The docblock states the three cases it is catching — the lever
off is a 404, an unconfigured market is a 200 with `{trees: []}`, an unreachable
API is a network error — and `retry: false` (`:83`) keeps a deliberately
unmounted route from producing a retry storm. Which source answered is reported
on the result rather than inferred: `CatalogNavigationSource` is
`'navigation_trees' | 'category_tree_fallback'`
(`lib/api/catalog-navigation.ts:34`).

**The facet rail degrades to absence.** `lib/catalog/use-facets.ts` deliberately
does not condition `enabled` on the flag (`:73`) and carries `retry: false`
(`:75`); its docblock (`:18-22`) states the rule — "a 404 is 'no rail', never an
empty rail" — so consumers read `data === undefined` as "this deployment offers no
filters here" and render nothing rather than an empty filter panel.

**Neither fallback has a test.** Confirmed:
`navigationFromCategoryTree`, `category_tree_fallback` and
`useCatalogNavigation` appear in no test file in the repository, with the positive
control that the same grep shape finds tested frontend catalog functions
(`packages/frontend/lib/catalog/__tests__/composition.test.ts:52`). The frontend
suite does run in CI (`.github/workflows/ci.yml:235`) and the exact precedent
exists one file over — `lib/catalog/__tests__/compatibility.test.ts:146`,
*"a failed read is not an absent fitment"* — so this is a missing test rather than
a missing capability. **Until it exists, the single most load-bearing claim in
this runbook is a convention.**

---

## 4. What a rollback does NOT undo

Four things, and each has a remedy that is not a lever.

**1. `categories.key` is `NOT NULL`.** `drizzle/0088_redundant_korvac.sql:116`
adds it nullable, `:196` backfills, `:201` sets `NOT NULL` — in a `pre` migration,
and no lever affects it. It is safe (the previously serving image writes
`categories` only from `scripts/provision-taxonomy.ts` and `scripts/seed.ts`,
never from a request path) and it is the epic's only `SET NOT NULL` on a
pre-existing table. **Remedy: none needed, and none available without a `post`
migration.** Recorded so nobody spends an incident looking for the lever.

**2. The selectability trigger stays armed on the LEGACY write path.**
`mercaria_category_assignment_selectable` (`drizzle/0088:461-464` on `listings`,
`:465-469` on `canonical_products`, function `:442-459`) refuses a
`category_id` naming a node an operator marked structural, raising
`restrict_violation` — with every rollout lever off.

Its reach is narrow and the narrowness matters: it is `BEFORE INSERT OR UPDATE OF
category_id … WHEN (NEW.category_id IS NOT NULL)`, so an ordinary status, price or
facet write never reaches it, and `selectable` defaults `true NOT NULL`
(`:119`), so **every pre-existing category and every pre-existing assignment is
unaffected.** It can only bite once somebody has marked a node
`selectable = false` through the governance surface — and at that point turning
the levers off does not undo the refusal.

**Remedy: mark the node selectable again** through
`/internal/catalog-governance`. If a listing write is failing with
`restrict_violation` and a message naming a category, this is it.

**3. Localized reads are contained transitively, not levered.** There is no
`CATALOG_LOCALIZATION_ENABLED`. What makes D12's "default ⇒ base locale" true
today is that `services/catalog-localization/read.service.ts` exports exactly two
readers and they have exactly two external consumers —
`services/facets/facet.service.ts:82` (behind `FACETS_ENABLED`) and
`services/catalog-authoring/schema.service.ts:92` (behind
`CATALOG_AUTHORING_ENABLED`) — so turning those two levers off leaves no public
surface serving a localized label. `routes/categories.ts` contains zero
occurrences of `locale`; positive control, `routes/navigation.ts` contains two.

**This containment has no gate.** There is no `catalog-localization` isolation
test, so a third consumer on an unconditionally-mounted route would ship green
and make localized reads un-rollbackable. **Remedy if it happens: a code change,
not a lever.**

**4. `/product-types` cannot be withdrawn, and authoring cannot be narrowed to a
cohort.** `PRODUCT_TYPES_ENABLED` was deliberately not built and the reasoning is
sound and in the code (`app.ts:1040` and the block above it: a published product
type's group headings are catalogue metadata of the kind `/categories` already
serves unconditionally, and a key with no published version answers 404, so a
deployment that has published nothing exposes nothing). **Remedy: unpublish the
product type version** through the governance surface — a data change.
`CATALOG_AUTHORING_COHORTS` was not built either, which means **D12's staged
rollout order is not executable as written**: authoring is all-or-nothing on
`CATALOG_AUTHORING_ENABLED`, so "selected stores" and "selected product types and
categories" have no mechanism. Stage on product-type PUBLICATION instead, which is
the lever that actually exists.

---

## 5. What must NOT be used as a rollback lever

- **`CANONICAL_PUBLIC_ROUTES_ENABLED`** (default **true**, `config/index.ts:3758`,
  `app.ts:485`) is #60's, and it unmounts `/canonical-products`,
  `/product-families`, `/catalog-pages` and `/offer-comparison`. Those shipped
  with #56 and #74; withdrawing them is an outage, not a rollout step
  (ADR 0002 D24). Same for `CANONICAL_READS` and `CANONICAL_OFFER_COMPARISON`,
  which default to today's behaviour.
- **`CANONICAL_GRAPH_ENABLED`** gates the backfill dispatcher LOOP. Turning it off
  stops backfills; it does not roll anything back, and a run holding a lease will
  simply sit until you turn it on again
  ([`catalog-backfill-resumption.md`](catalog-backfill-resumption.md)).
- **`CANONICAL_SEARCH`** is a seventh canonical read lever defaulting `off`; it is
  #70's and unrelated to this epic's surfaces.

---

## 6. What is tested, and what is not — read this before claiming box 6

**Verified, and reproducible:**

- The lever read-site census: four levers, six read sites, four of them the mount,
  none in a repository, a loop, an outbox or checkout. One grep.
- The mount-guard census: exactly five mounts behind the four levers, all of them
  new surfaces; eight pre-existing shopper and buyer paths unconditional. A static
  parse of `app.ts` attributing all 101 single-quoted `app.use(<path>)` calls to
  their enclosing `if`; the completeness control is that the 11 residual
  `app.use(` calls are body parsers, rate limiters, the error handler and four
  multi-line canonical mounts belonging to #60.
- The nine `/internal/*` surfaces are gated on the operator list and no rollout
  lever, and that gate is derived from the list's length.
- The storefront navigation fallback and the facet-rail absence exist as code and
  handle 404, empty and network failure.
- No #367 migration touches a commerce table, and all ten are `pre`.

**NOT verified, and this is the honest core of box 6:**

- **Nothing has been executed.** No lever has been flipped on a running
  deployment, in production or anywhere else, and no route has been observed to
  404 and then to answer again. Everything above is read from code and from
  censuses over source.
- **No automated test flips any of the four levers.** The only test file naming
  one asserts a *string* in a metrics report
  (`services/catalog-observability/__tests__/metrics.realdb.test.ts:467`). The
  house pattern exists and is documented —
  `routes/__tests__/search-rollout.realdb.test.ts:1-18` builds one module graph
  per lever value with `vi.resetModules()` precisely because config reads
  `process.env` once at import, and
  `routes/__tests__/guest-session.disabled.integration.test.ts` and
  `routes/__tests__/cart-guest.disabled.integration.test.ts` are the `*.disabled`
  counterparts. **The catalog epic has no `*-rollout` and no `*.disabled` test.**
- The levers-off case is covered **incidentally**, because the whole realdb suite
  runs at default env and every existing cart and checkout test is therefore a
  levers-off sellability proof. That is a coincidence of the defaults, not a named
  property, and it stops being evidence the moment somebody sets a lever in a
  test's environment.
- **Neither storefront fallback has a test** (§3).
- The one gate that does defend "no lever gates a durable record" covers **four
  repository files of one domain of nine**
  (`services/catalog-authoring/__tests__/catalog-authoring-isolation.test.ts:306-318`,
  predicate at `:312-316`), while its own title and two docblocks
  (`config/index.ts:3459-3460`, and D12 itself) claim it covers read paths too.
  `CATALOG_TAXONOMY_V2_ENABLED`, `CATALOG_PROPOSALS_ENABLED` and `FACETS_ENABLED`
  have **no gate at all**.

### The rehearsal, and what each step would settle

Do this on a staging deployment before general availability. It is the difference
between box 6 being ticked and being true.

1. **All four levers on, then all four off, one roll each.** After each roll:
   the five paths in §1 answer as expected; the eight unconditional paths still
   answer; `GET /internal/catalog-metrics` returns the same
   `proposal_backlog_count` and `draft_open_count` as before the roll. *Settles:
   "turning a lever off does not make a durable record unreachable."*
2. **Save a draft and submit a proposal with the levers on. Turn both levers off.
   Read both back through `/internal/*`.** Then turn them on and confirm the
   merchant can still see and publish the draft. *Settles the sentence
   `app.ts:254-256` and `:273-276` make about a merchant's afternoon of typing.*
3. **Load the storefront with `CATALOG_TAXONOMY_V2_ENABLED` off** and confirm the
   menu renders from the v1 tree and reports
   `source: 'category_tree_fallback'`, with no menu-shaped error. Repeat with
   `FACETS_ENABLED` off and confirm the rail is absent rather than empty.
   *Settles §3, which is currently the least defended claim here.*
4. **Empty `CATALOG_OPERATOR_OXY_USER_IDS` deliberately and confirm the nine
   surfaces 404 with a real operator token.** *Settles §0, and is the one step
   that shows the failure mode rather than the success.*
5. **Mark a category `selectable = false`, then turn every lever off and attempt a
   legacy listing write against it.** Confirm `restrict_violation`, then mark it
   selectable and confirm the write succeeds. *Settles §4 item 2, the one
   behaviour change no lever undoes.*

### Cheapest things that would move box 6 from documented to defended

1. A `routes/__tests__/catalog-rollout.realdb.test.ts` in the shape of
   `search-rollout.realdb.test.ts`: build the app once per lever value and assert
   the five paths 404 while `/categories`, `/listings`, `/cart` and `/checkout`
   answer, and that a row written with the lever on is readable through
   `/internal/*` with it off.
2. A frontend test for `useCatalogNavigation`'s fallback, in the shape of
   `compatibility.test.ts:146`.
3. Widen `catalog-authoring-isolation.test.ts`'s predicate from
   `db/catalogAuthoring` to the whole domain (excluding the controller, whose
   lever reads are page bounds and a TTL rather than gates), fix its mutation
   self-test to run the real `offenders` filter, and give
   `facet-isolation.test.ts`, `navigation-isolation.test.ts` and
   `catalog-proposal-isolation.test.ts` the same wall —
   `services/__tests__/product-type-isolation.test.ts:92` already has the
   strongest form of it, aimed at a lever that does not exist.
4. Correct D12 to name the four levers that exist, record `FACETS_ENABLED`, and
   state that the staged rollout order needs a cohort expression nobody built.
