# Catalog migration and operations (#367)

The operational half of ADR 0007: what a staged rollout of the catalog epic
guarantees about existing commerce, which of those guarantees are **properties**
(something fails if you remove them) and which are **conventions** (nothing
fails), what an operator watches, how an interrupted job resumes, and what
rolling back actually does.

> **Scope.** This file audits and operates what the seven implementation
> workstreams shipped. It adds no schema, no lever and no metric. The domain
> references are [`catalog-observability.md`](catalog-observability.md) (W16/W17,
> the metric registry and the integrity sweep),
> [`catalog-backfill.md`](catalog-backfill.md),
> [`catalog-localization.md`](catalog-localization.md),
> [`catalog-governance.md`](catalog-governance.md) and
> [`catalog-proposals.md`](catalog-proposals.md). Procedures live in
> [`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md)
> and
> [`runbooks/catalog-backfill-resumption.md`](runbooks/catalog-backfill-resumption.md).

**The distinction this file keeps making, and the reason it exists.** ADR 0007
D12 says "no flag gates a durable record" and D13 says "historical order,
payment and refund snapshots are never rewritten". Both sentences are TRUE of
the code as shipped. Only some of them are true of the code as *defended*. A
mechanism with nothing behind it is a convention, and a convention survives
exactly as long as the next person who reads the docblock — which is why three of
the findings below are docblocks asserting more than the code under them does.

---

## The lever inventory, measured rather than quoted

**ADR 0007 D12 names six levers. Four exist.** This is the single most important
operational fact in the epic, because a runbook step naming a variable that does
not exist is worse than no step, and D12 is quoted in five other documents.

| D12 lever | State | Where |
|---|---|---|
| `CATALOG_TAXONOMY_V2_ENABLED` | **exists**, default false | `config/index.ts:1936` (decl), `:3721` (read) → `config.catalog.taxonomyV2Enabled` |
| `CATALOG_AUTHORING_ENABLED` | **exists**, default false | `config/index.ts:3468`, `:4388` → `config.catalogAuthoring.enabled` |
| `CATALOG_PROPOSALS_ENABLED` | **exists**, default false | `config/index.ts:3501`, `:4395` → `config.catalogProposals.enabled` |
| `CATALOG_LOCALIZATION_ENABLED` | **DOES NOT EXIST** | nowhere in `packages/backend/src` |
| `PRODUCT_TYPES_ENABLED` | **DOES NOT EXIST** | nowhere in `packages/backend/src` |
| `CATALOG_AUTHORING_COHORTS` | **DOES NOT EXIST** | nowhere in `packages/backend/src` |

And one lever that D12 does not name but a rollout must:

| Lever | State | Where |
|---|---|---|
| `FACETS_ENABLED` | **exists**, default false | `config/index.ts:1949`, `:3722` → `config.catalog.facetsEnabled` |

Two of the three absences were already recorded by W17
(`catalog-observability.md` §"No prometheus, no sweep loop, no configuration");
`PRODUCT_TYPES_ENABLED` is the third and had not been. The consequences are
different in each case and none of them is "the lever was forgotten":

- **`PRODUCT_TYPES_ENABLED` was deliberately not built, and the reasoning is in
  the code.** `app.ts:1040` mounts `/product-types` unconditionally, with the
  argument on the block above it: a published product type's group headings are
  catalogue metadata of the same kind `/categories` and `/catalog-attributes`
  already serve unconditionally, and a key with no published version answers 404,
  so a deployment that has published nothing exposes nothing. That is a sound
  divergence. **What is wrong is D12 still claiming the lever**, and
  `docs/product-types.md:412` quoting it.
- **`CATALOG_LOCALIZATION_ENABLED` is not needed, because localized reads are
  transitively contained.** `services/catalog-localization/read.service.ts`
  exports exactly two readers (`readLocalizedCategories:54`,
  `readLocalizedAttributeValues:156`) and they have exactly two external
  consumers: `services/facets/facet.service.ts:82` (behind `FACETS_ENABLED`) and
  `services/catalog-authoring/schema.service.ts:92` (behind
  `CATALOG_AUTHORING_ENABLED`). `routes/categories.ts` contains **zero**
  occurrences of `locale` — positive control: `routes/navigation.ts` contains
  two, so the search finds the word where it exists. So with the four levers off
  no public surface serves a localized label, and the base-locale behaviour D12
  promises is what a shopper gets. **This containment has no gate** (see below),
  which is the whole reason it is written down here.
- **`CATALOG_AUTHORING_COHORTS` is a real missing capability.** Authoring
  rollout is all-or-nothing on `CATALOG_AUTHORING_ENABLED`. D12's rollout order
  — internal users → selected stores → selected product types and categories →
  locales and markets → GA — is **not executable as written**, because nothing
  narrows the mount to a cohort. The nearest existing mechanism is
  `CANONICAL_READ_COHORTS` (`config/index.ts:882`), which is #60's and does not
  cover these routes.

### Every read site of every surviving lever

A comment-stripped census of `packages/backend/src`. The four levers are read in
**six** places, and four of them are the mount:

| Site | Kind |
|---|---|
| `app.ts:258` → mounts `/stores/:storeId/product-drafts` (`:259`), `/catalog-authoring` (`:260`) | MOUNT |
| `app.ts:274` → mounts `/catalog-proposals` (`:275`) | MOUNT |
| `app.ts:737` → mounts `/facets` (`:738`) | MOUNT |
| `app.ts:978` → mounts `/navigation` (`:979`) | MOUNT |
| `services/catalog-observability/metrics.service.ts:745` | report shaping — decides `surface_not_mounted` vs a reading |
| `services/catalog-observability/metrics.service.ts:746` | ditto |

**No repository, no outbox enqueue, no loop and no checkout path reads one.**
The other `config.catalogAuthoring.*` / `config.catalogProposals.*` reads are
bounds rather than gates — page sizes, a schema TTL, proposal thresholds —
in `controllers/catalog-authoring.controller.ts:123,215,252,274`,
`controllers/catalog-proposals-operator.controller.ts:59`,
`services/catalog-proposals/proposal.service.ts:164,165,208,209,352,353,394` and
`services/catalog-proposals/backfill.service.ts:140`.

### What each lever removes when you turn it off

A static census of `app.ts`, attributing all 101 single-quoted `app.use(<path>)`
mounts to the `if` blocks enclosing them. Reproducible; the completeness control
is that the 11 residual `app.use(` calls are body parsers, rate limiters, the
error handler, and four multi-line canonical mounts (`app.ts:486,491,508,548`)
that belong to #60's `CANONICAL_PUBLIC_ROUTES_ENABLED` (`app.ts:485`) and to no
#367 lever.

| Lever off | Mounts withdrawn |
|---|---|
| `CATALOG_AUTHORING_ENABLED` | `/stores/:storeId/product-drafts`, `/catalog-authoring` |
| `CATALOG_PROPOSALS_ENABLED` | `/catalog-proposals` |
| `FACETS_ENABLED` | `/facets` |
| `CATALOG_TAXONOMY_V2_ENABLED` | `/navigation` |

**Five mounts, every one of them a surface this epic ADDED.** Nothing a shopper
or a buyer used before the epic is behind any of them: `/listings`
(`app.ts:243`), `/categories` (`:245`), `/cart` (`:316`), `/checkout` (`:318`),
`/search` (`:589`), `/catalog-attributes` (`:729`), `/compatibility` (`:1028`)
and `/product-types` (`:1040`) are all unconditional.

**Nine `/internal/*` catalog surfaces are gated on the operator allow-list and on
no rollout lever** — `/internal/catalog-proposals` (`app.ts:286`),
`/internal/canonical-catalog` (`:519`), `/internal/offers` (`:745`),
`/internal/catalog-attributes` (`:755`), `/internal/catalog-condition` (`:760`),
`/internal/matching` (`:782`), `/internal/navigation` (`:992`),
`/internal/catalog-governance` (`:1008`) and `/internal/catalog-metrics`
(`:1014`), each behind `config.catalog.graphOperatorSurfaceEnabled`. That is
what makes D12's "the evidence has to be readable during the incident that
turned the levers off" true.

> **The precondition nobody has written down until now.**
> `graphOperatorSurfaceEnabled` is **derived**:
> `config/index.ts:3716` is `resolveCatalogOperatorIds().length > 0`. So an
> **empty `CATALOG_OPERATOR_OXY_USER_IDS` makes all nine surfaces 404** — and
> then every rollout lever off means the catalogue evidence is reachable through
> no HTTP surface at all. The readability half of D12 is conditional on that list
> being populated, and it is the first line of the rollback runbook for that
> reason.

---

## Box 1 — existing products remain readable and sellable: **satisfied as code, partial as property**

**What holds, and structurally.**

1. **No `#367` migration adds a column to `listings` or `product_variants`.**
   The epic's migrations are `drizzle/0088, 0089, 0090, 0091, 0093, 0094, 0097,
   0098, 0100, 0102`, all `-- oxy:deploy-phase=pre`. Every new fact about a
   listing or a variant lives in a side table with a foreign key back
   (`drizzle/0097_uneven_hedge_knight.sql:144,148,151,155,159,160`,
   `drizzle/0098_young_lorna_dane.sql:135`). The only `ALTER TABLE "listings" ADD
   COLUMN` in the range is `drizzle/0092_daffy_pandemic.sql:21-22`, which is
   #390's archival columns and both nullable. Positive control: the same grep
   finds `drizzle/0034_closed_tattoo.sql:157-159` and
   `drizzle/0006_tag_search_stemming.sql:51`.
2. **The commerce path cannot see the epic.** `services/checkout.service.ts`
   imports nothing from `taxonomy`, `productTypes`, `catalogLocalization`,
   `variantAxes`, `facets`, `navigation`, `catalogAuthoring` or
   `catalogProposals`; neither does `services/catalog-write.service.ts`.
3. **The five lever-gated mounts are all new surfaces** (above), so "off"
   restores the state in which those routes did not exist.

**What does not hold: the gate.**

- **Three of the four levers have no gate whatsoever.**
  `CATALOG_TAXONOMY_V2_ENABLED`, `CATALOG_PROPOSALS_ENABLED` and
  `FACETS_ENABLED` can be read from a repository, an outbox enqueue or a
  checkout path with a fully green build.
  `services/facets/__tests__/facet-isolation.test.ts` and
  `services/__tests__/navigation-isolation.test.ts` contain zero occurrences of
  `config.` or `process.env`; positive control for that grep shape —
  `services/__tests__/product-type-isolation.test.ts` returns `:92,:243,:263`
  and `services/catalog-governance/__tests__/catalog-governance-isolation.test.ts`
  returns `:204`.
- **The fourth lever's gate is narrower than its own title.**
  `services/catalog-authoring/__tests__/catalog-authoring-isolation.test.ts:306`
  is titled *"a flag gates the MOUNT and never a stored row"* and its assertion
  at `:307` reads *"no repository **or read path** in this domain reads
  `config.catalogAuthoring`"* — but the predicate at `:312-316` is
  `file.path.includes('db/catalogAuthoring') && /config\s*\.\s*catalogAuthoring/`,
  so it scans **4 repository files of the domain's 10**. Every read path in
  `services/catalog-authoring/` — `draft.service.ts`, `publish.service.ts`,
  `schema.service.ts`, `canonical-search.service.ts` — may read the lever and
  the gate stays green. The mutation self-test at `:320-327` cannot see the
  narrowing, because it seeds the mutation into a file selected by the same
  `db/catalogAuthoring` path predicate (`:321`) and then asserts the **regex**
  matches (`:326`) rather than that the real `offenders` filter went red.
- **Two docblocks and the ADR claim the wider property.**
  `config/index.ts:3459-3460` says the isolation test "fails the build if a
  repository **or a read path** starts reading it". It fails the build if a
  repository does. `docs/adr/0007-…:495-497` states the rollback guarantee with
  no mention that only one domain's repository layer defends it. Both are
  comments asserting a mechanism the code below them does not implement.
- **The strongest form of the rule in the epic guards a lever that does not
  exist.** `services/__tests__/product-type-isolation.test.ts:92` bans reading
  configuration at all — `` /from\s+'[^']*\/config[^']*'|process\.env\b/ `` —
  asserted at `:243-253` with a real mutation self-test at `:255-265`. Its
  subject is `PRODUCT_TYPES_ENABLED`, which was never built. So the epic's most
  rigorous lever wall protects the one domain with no lever, and the domain that
  holds the epic's only non-mount lever read
  (`services/catalog-observability/`) is outside every catalog isolation test's
  scan population.
- **The localization containment described above is a convention.** There is no
  `catalog-localization` isolation test at all, so a third consumer of
  `readLocalizedCategories` on an unconditionally-mounted route would ship green
  and make localized reads un-rollbackable.

**Two un-levered durable changes, both in `drizzle/0088_redundant_korvac.sql`.**
Neither breaks reading or buying an existing listing; both qualify "turning every
lever off restores listing-first behaviour":

1. **`categories.key` is narrowed to `NOT NULL` in a `pre` migration** —
   `:116` adds it nullable, `:196` backfills, `:201` sets `NOT NULL`. The
   migration header states the trade and it checks out: the previously serving
   image writes `categories` only from `src/scripts/provision-taxonomy.ts` and
   `src/scripts/seed.ts`, never from a request path. Recorded because it is the
   epic's only `SET NOT NULL` on a pre-existing table and no lever affects it.
2. **A trigger on `listings` enforces ADR 0007 D2's selectability rule on the
   legacy write path**, active with every lever off —
   `mercaria_category_assignment_selectable`, `drizzle/0088:461-464` on
   `listings` and `:465-469` on `canonical_products`, function at `:442-459`,
   raising `restrict_violation`. **Its reach is narrow and it is worth being
   precise about why**, because the alarming reading is wrong: it is
   `BEFORE INSERT OR UPDATE OF category_id … WHEN (NEW.category_id IS NOT NULL)`,
   so an ordinary status, price or facet write never reaches it; `selectable`
   defaults `true NOT NULL` (`:119`), so **every pre-existing category and every
   pre-existing assignment is unaffected**. It can only refuse once an operator
   has marked a node `selectable = false` through the new governance surface —
   and at that point turning the rollout levers off does **not** undo the
   refusal. The remedy is a data change (mark the node selectable again), not a
   lever. That belongs in the rollback runbook, and it is there.

**No test flips any of the four levers.** The only test file naming one is
`services/catalog-observability/__tests__/metrics.realdb.test.ts:467`, and it
asserts a *string* in a report (`expect(entry.seam).toMatch(/CATALOG_AUTHORING_ENABLED|FACETS_ENABLED/)`).
The house pattern for this exists and is documented —
`routes/__tests__/search-rollout.realdb.test.ts:1-18` builds one module graph
per lever value with `vi.resetModules()`, because `config/index.ts` reads
`process.env` once at import; `routes/__tests__/guest-session.disabled.integration.test.ts`
and `routes/__tests__/cart-guest.disabled.integration.test.ts` are the
`*.disabled` counterparts. **The catalog epic has no `*-rollout` or `*.disabled`
test.** The levers-off case is covered *incidentally*, because the whole realdb
suite runs at default env and every existing cart and checkout test is therefore
a levers-off sellability proof — but that is a coincidence of the defaults, not a
named property, and it stops being evidence the moment somebody sets a lever in a
test's environment.

**Verdict: partial.** The property is true and measurable today. The defence is
one narrow assertion over one domain's repository layer, and three docblocks
claim more than it delivers.

---

## Box 2 — legacy free text migrated only where deterministic

See [§Box 2 verdict](#box-2-verdict) below; it is recorded after the backfill
mechanics so the review queue and the provenance columns are already in view.

---

## Box 3 — no historical commerce snapshot is rewritten

See [§Box 3 verdict](#box-3-verdict).

---

## Box 5 — the four signals, as data

W17 shipped the metric registry, and it already carries exactly what an
operational document needs: `CatalogMetricDefinition`
(`packages/shared-types/src/catalog-metrics.ts:132-161`) has `numerator`,
`denominator`, `window`, `source`, `freshnessSeconds` and `attributionLimit` as
required fields, and `unmeasured` as the one optional field whose **absence** is
the assertion that the metric is produced. So this section does not restate the
definitions — it maps box 5's four named signals onto them, names the runbook,
and says which of the four is not actually answerable.

Everything below is read from `GET /internal/catalog-metrics`
(`app.ts:1014`), behind `CATALOG_OPERATOR_OXY_USER_IDS`.

### 1. Failures

| Metric | Numerator / denominator | Window | Source | Fresh | Definition |
|---|---|---|---|---|---|
| `authoring_schema_error_rate` | `GET /catalog-authoring/schema` responses ≥ 500 / all such responses this process served | `since_process_start` | `route_observations` | 0 s | `catalog-metrics.ts:470` |
| `backfill_failed_run_count` | `catalog_backfill_runs` with `status = 'failed'` | `instant` | `catalog_backfill_runs` | 300 s | `:967` |
| `backfill_retry_count` | `catalog_backfill_records` with `attempts > 1` | `instant` | `catalog_backfill_records` | 300 s | `:954` |
| `match_queue_dead_letter_count` | `match_queue` rows `status = 'dead_letter'` | `instant` | `match_queue` | 60 s | `:637` |
| `backfill_dead_letter_count` | — | — | — | — | **`unmeasured`**, `no_dead_letter_state`, `:980` |
| `mustStayZero.metricCollectionFailures` and its two siblings | see `catalog-observability.md:465-504` | process-local | in-process counters | per task | — |

**The gap, and it is the sharp one: there is no metric that counts a failed
publication.** `POST /stores/:storeId/product-drafts/:draftId/publish` is not an
observed route and nothing persists a validation refusal (that is W17's
`draft_validation_failure_rate` seam, `catalog-metrics.ts:560`).
`authoring_schema_error_rate` observes the **schema read**, not the publish, and
counts only 5xx — a composition refusal is a 4xx and a correct answer.
So "publication failures" is diagnosed from draft OUTCOMES in aggregate plus the
per-publication row trace, which is exactly what
[`runbooks/catalog-publication-failures.md`](runbooks/catalog-publication-failures.md)
does. **Operator action:** that runbook.

`backfill_dead_letter_count` being `unmeasured` rather than `0` is the correct
reading and must be rendered as a gap: **none of #367's own queues has a
dead-letter state**, so a run that has given up is indistinguishable from one
still retrying. Closing it is a terminal state on `catalog_backfill_runs`,
`catalog_external_mapping_runs` and `catalog_external_token_observations`, or the
explicit decision that their retries are unbounded.

### 2. Lag

| Metric | Numerator | Window | Source | Fresh | Definition |
|---|---|---|---|---|---|
| `unresolved_subject_oldest_age` | seconds since the oldest incomplete `match_queue` row was enqueued | `instant` | `match_queue` | 60 s | `:624` |
| `unresolved_subject_count` | incomplete `match_queue` rows (DEPTH, not lag) | `instant` | `match_queue` | 60 s | `:611` |
| `backfill_progress` | terminal-successful `catalog_backfill_runs` / all `catalog_backfill_runs` | `instant` | `catalog_backfill_runs` | 300 s | `:941` |
| `translation_stale_count` | localization rows `status = 'stale'` | `instant` | `category_localizations` | 900 s | `:764` |
| `reindex_pending_count` | `attribute_reindex_requests` with no `processed_at` | `instant` | `attribute_reindex_requests` | 300 s | `:1005` |
| `reindex_throughput` | — | — | — | — | **`unmeasured`**, `no_consumer_registered`, `:1020` |
| `stalled_queue_lease` (integrity finding, not a metric) | leases held past their deadline | probe cadence | integrity sweep | — | `catalog-metrics.ts:313` |

**The age is the alert, not the depth** — a deep queue draining fast is healthier
than a shallow one that has stopped, and only the `*_oldest_age` pair can tell
them apart.

**`reindex_pending_count` is NOT a lag signal and must be excluded from any queue-depth
alert.** `attribute_reindex_requests` has enqueuers, a deterministic id, a
lease-shaped schema and **no consumer** — nothing writes `processed_at` anywhere
in the repository — so **a rising count is the expected reading and is not an
incident.** There is no worker to restart, no lease to clear and no queue to
drain. That is why `reindex_throughput` is `unmeasured` rather than zero: a
throughput of zero and a stalled consumer are the same number and only one of
them describes this deployment. **Operator action:**
[`runbooks/catalog-indexing-lag.md`](runbooks/catalog-indexing-lag.md), whose
honest content is that there is no indexer to recover.

### 3. Missing translations

| Metric | Numerator / denominator | Window | Source | Fresh | Definition |
|---|---|---|---|---|---|
| `translation_missing_count` | eligible entity-locale pairs with **no localization row at all** | `instant` | `catalog_governance_queues` | 900 s | `:777` |
| `translation_coverage` | rows `reviewed` or `approved` / eligible entity-locale pairs | `instant` | `catalog_governance_quality` | 900 s | `:738` |
| `translation_stale_count` | rows `status = 'stale'` | `instant` | `category_localizations` | 900 s | `:764` |
| `translation_machine_share` | — | `instant` | — | 900 s | `:751` |
| `translation_fallback_use_rate` | — | — | — | — | **`unmeasured`**, `not_instrumented`, `:790` |
| `attribute_localized_label_completeness` | — | `instant` | `catalog_governance_quality` | — | `:720` |

`machine_translated` is deliberately **not** in `translation_coverage`'s
numerator — counting it is how a locale reports 98% while a shopper reads a
machine's guess at a legal category name.

**Four of the five measure what the CATALOGUE contains; none measures what a
shopper hit.** That is `translation_fallback_use_rate`, a declared seam:
`services/catalog-localization/read.service.ts` resolves the fallback chain per
read and records nothing. Coverage cannot substitute — an untranslated category
nobody visits costs nothing, and a translated one whose locale variant is missing
costs every visit. **Operator action:**
[`runbooks/catalog-translation-regressions.md`](runbooks/catalog-translation-regressions.md).

### 4. Review backlog

| Metric | Numerator | Window | Source | Fresh | Definition |
|---|---|---|---|---|---|
| `proposal_backlog_oldest_age` | seconds since the oldest undecided `catalog_proposals` row was submitted | `instant` | `catalog_proposals` | 300 s | `:679` |
| `proposal_backlog_count` | undecided `catalog_proposals` rows | `instant` | `catalog_proposals` | 300 s | `:666` |
| `external_mapping_review_backlog` | `catalog_external_mapping_reviews` in state `open` | `instant` | `catalog_external_mappings` | 300 s | `:928` |
| `proposal_creation_count` | — | — | `catalog_proposals` | — | `:653` |

`proposal_backlog_count` counts a **deferred** proposal with a future
`deferred_until` too, so a planned deferral reads as backlog — the attribution
limit is on the definition and belongs on the dashboard.
`external_mapping_review_backlog` counts rows, not sources: one source can hold
the whole backlog. **Operator action:**
[`runbooks/catalog-proposal-backlog.md`](runbooks/catalog-proposal-backlog.md).
This is a staffing alert far more often than an engineering one.

### What box 5 does not have, stated once

Alerts and dashboards **do not exist**. This backend emits a JSON endpoint plus
structured logs and has no prometheus dependency, no registry, no exporter and no
scrape format; scraping, thresholds and routing belong to `oxy-infra`. Every
threshold in the six runbooks is a **proposal, and no alert has ever fired**
(`catalog-observability.md` §"What has not been rehearsed"). A metrics collection
runs of the order of six hundred statements including a 60-scope facet sweep, so
the probe cadence is minutes, not seconds.

---

## Boxes 4 and 6

Box 4 (resumption) is
[`runbooks/catalog-backfill-resumption.md`](runbooks/catalog-backfill-resumption.md).
Box 6 (rollback) is
[`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md),
including the honest statement of which half of the rollback claim is tested and
which is not.
