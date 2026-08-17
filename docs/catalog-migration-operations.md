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

**ADR 0007 D12 originally named six levers; three were never built, and one lever
a rollout needs was not among the six — so four exist, and the arithmetic is
`6 − 3 + 1` rather than a subtraction.** D12 has since been corrected (in this
branch) to name the four and record why each absent one is absent. This is the
single most important
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
   `:116` adds it nullable, `:136` backfills it from `ancestor_slugs`, `:201` sets
   `NOT NULL`. The
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

## Box 2 — legacy free text migrated only where deterministic: **partial**

The comparison baseline is #90, one domain over:
`listings_unrefined_condition_check` (`db/schema/catalog.ts:457-466`, deployed at
`drizzle/0034_closed_tattoo.sql:188-189`) is a CHECK keyed on a **provenance
value** whose consequent restricts the **typed** column, so a legacy `used` can
never become `used_like_new` whatever the writer — a service bug, a migration or
`psql`. Pinned by `db/__tests__/condition.realdb.test.ts:376`. That is the shape
box 2 asks for, and #367 ships it for some of the ambiguity space and not for the
rest.

The decision code is `services/variant-axes/legacy-resolution.ts:150-176` — pure,
no database — driven by `services/variant-axes/backfill.service.ts` and reached
from `scripts/backfill-variant-axes.ts`. Names resolve by **exact key fold only**
(five folds, `legacy-resolution.ts:104-111`, enumerated as data at `:63-69`);
values resolve through the registry alias map (`:245-251`) or #94's normalizer,
with `facts.length !== 1 → 'ambiguous'` at `:272`.

### Properties — something fails if you remove them

- **The legacy columns are retained, and it is checkable.**
  `listing_options` and `product_variant_option_values` appear in `drizzle/` only
  in `0000_superb_moondragon.sql` (CREATE at `:254`, `:316`; FKs `:1034`,
  `:1038`; indexes `:1100`, `:1114`). No later migration ALTERs, UPDATEs or DROPs
  either. Positive control: the same grep finds real drops —
  `drizzle/0025_complex_tattoo.sql:44,46`. Enforced against this domain by a
  scanned build gate, `services/variant-axes/__tests__/variant-axis-isolation.test.ts:100-102`
  plus wall 4 at `:216-243`, which carries a positive control at `:225-235`
  proving the domain does read those tables (without it the wall passes
  vacuously).
- **The preserved claim copy is frozen and undeletable.**
  `mercaria_native_listing_claim_frozen` refuses any UPDATE of
  `raw_name`/`raw_value`/`provenance`/`asserted_at`
  (`drizzle/0097_uneven_hedge_knight.sql:512-538`, variant grain `:551-590`) and
  `mercaria_native_claim_no_delete` at `:592-621`.
- **A forbidden axis is unrepresentable** —
  `native_listing_variant_axes_forbidden_key_check` (`0097:65`,
  `db/schema/variantAxes.ts:186-189`), rendered from the shared
  `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS` tuple. So a year range, a make or a
  model can never become a variant option, which is ADR 0007 D8's own acceptance
  scenario.
- **A non-variant-defining attribute cannot carry an axis** — trigger
  `mercaria_native_variant_axis_citation` (`0097:206-213`).
- **Two variants that would be indistinguishable are refused** — UNIQUE
  `native_variant_signatures_listing_signature_key` (`0097:175`) plus the
  deferrable constraint trigger `mercaria_native_variant_signature_agrees`
  (`0097:433-490`).
- **"Blocked but carrying a guess" is unrepresentable** — three biconditional
  CHECKs at both grains (`0097:100,105,107`; `db/schema/variantAxes.ts:478-492`),
  pinned by `db/__tests__/variant-axes.realdb.test.ts:588`.
- **No similarity metric can enter the domain** — a comment-stripped scan of the
  whole domain for a similarity call or import
  (`variant-axis-isolation.test.ts:157-186`), with detector self-tests at
  `:165-179`, a fold-list disjointness assertion and
  `expect(LEGACY_OPTION_NAME_FOLDS.length).toBe(5)` at `:181-186`. The comment
  stripper is itself mutation-tested at `:129-139`.

### Conventions — nothing fails if you remove them

- **`Tono` → `color` staying unresolved has no database gate**, and it is the case
  ADR 0007 D6 names by name. There is no
  `native_*_claims_legacy_resolution_check`: the provenance-keyed CHECK that does
  exist (`db/schema/variantAxes.ts:551-554`, `0097:32` and `:94`) has exactly
  #90's shape and constrains a different fact —
  `provenance <> 'legacy_option_migration' or asserted_by_oxy_user_id is null`,
  i.e. *who* claimed it, not *what it resolved to*. Positive control that a
  provenance-keyed-CHECK search works: it finds this one plus
  `condition.ts:190`, `catalogExternalMappings.ts:292`, `navigation.ts:560`,
  `pickup.ts:249`, `procurement.ts:755`, `sellYours.ts:352`,
  `catalogLocalization.ts:138` and `:288`. If the name resolver grew a similarity
  branch, every resulting row would be legal: `attribute_resolution = 'resolved'`
  with a real definition id, an axis on a `variant_defining` `color` definition
  and a normalized value from the alias map. Held instead by
  `legacy-resolution.ts:154,162,174` and by two assertions —
  `variant-axis-legacy-resolution.test.ts:171-182` (`REFUSES 'Tono', which is the
  whole point (ADR 0007 D6)`) and `:184-192` for `Colour`.
- **A typed axis assignment need not cite a RESOLVED claim, or any claim.**
  `native_variant_axis_assignments.source_claim_id` is nullable (`0097:124`,
  `db/schema/variantAxes.ts:265-276`) and the scope trigger
  `mercaria_native_variant_axis_assignment_scope` (`0097:348-360`) checks only
  that the claim is about the same variant — `c.id = new.source_claim_id and
  c.variant_id = new.variant_id`, with **no clause on `c.value_resolution` or
  `c.value_refusal`**. Verified directly. So a row carrying a normalized value
  derived from a claim blocked as `ambiguous`, or from no claim at all, is
  representable. **This is precisely the row #90's constraint shape forbids, and
  it is the single cheapest thing that would move box 2 to satisfied.**
- **The sibling-collision gate is absorbed by the writer's own conflict clause.**
  `collidesWithSiblingOption` (`backfill.service.ts:179-192`, passed at `:235`)
  is the only producer of the name-grain `ambiguous` refusal, and the unique index
  `native_listing_variant_axes_listing_attribute_key` (`0097:164`) is not a
  backstop for it, because `declareVariantAxis` uses
  `.onConflictDoNothing({ target: [listingId, attributeKey] })`
  (`db/variantAxes/variantAxisRepository.ts:76-79`) — verified directly. Pass
  `false` at `:235` and the second colliding option silently converges on the
  first axis (`created: false`, counted as `axesAlreadyDeclared`) and its values
  get typed under it. The docblock at `legacy-resolution.ts:118-121` says the
  unique index prevents exactly that coin toss. It does not; it absorbs it.
- **`runVariantAxisBackfill` has no test at all.** Its only references are
  `scripts/backfill-variant-axes.ts`,
  `services/catalog-governance/impact-plan.ts` and its own module. Positive
  control: the sister backfills are tested —
  `services/catalog-proposals/__tests__/catalog-proposals.realdb.test.ts` imports
  `runProposalBackfill`, and `services/__tests__/backfill.realdb.test.ts` drives
  `runBackfill`. Consequence: the one-token change at `backfill.service.ts:235`
  passes the entire suite.
- **"Visible in a review queue" is one integer over one of the two claim
  tables.** The design decision to have no queue table is recorded
  (`db/schema/variantAxes.ts:705-727`, "the claim's own resolution columns ARE the
  queue") and two partial indexes serve it (`variantAxes.ts:644-648`, `:697-701`).
  But `countQueuedClaims` (`db/variantAxes/attributeClaimRepository.ts:278-345`)
  queries `.from(nativeVariantAttributeClaims)` at `:313` and nothing else, so
  `native_listing_attribute_claims_queue_idx` has **no reader** and an
  `axis_declaration` claim refused on a listing with no variants is invisible to
  every count. And there is **no row-level read path**:
  `listListingAttributeClaims` (`:207-217`) and `listVariantAttributeClaims`
  (`:219-…`) have zero callers repo-wide — positive control, the same grep shape
  returns 11 hits for `countQueuedClaims`. So an operator can see that `n` things
  are unresolved and cannot enumerate them.

### Two docblocks asserting facts the code does not

1. **`services/catalog-backfill/mapping-matrix.ts:182-185`** gives
   `product_variant_option_values.position` the target
   `native_variant_axis_assignments.position (ADR 0007 D6)`. **That table has no
   `position` column** — `0097:113-131` and `db/schema/variantAxes.ts:240-277`
   list ten columns and none is `position`; the `position` in that file
   (`:165,180,197`) belongs to `native_listing_variant_axes`, a different table.
   The guarding census only checks the target string is non-empty
   (`services/catalog-backfill/__tests__/mapping-matrix-census.test.ts:149-156`),
   so it cannot catch a target naming a column that does not exist.
2. **`mapping-matrix.ts:141-153`** says of `listing_options.values`: "READ BY
   NOTHING. Step 4's `legacyOptionRepository` does not select it." It does —
   `db/variantAxes/legacyOptionRepository.ts:105-109` is a bare `db.select()`
   with no projection and `LegacyListingOptionRow = typeof
   listingOptions.$inferSelect` (`:96`) includes `values`. The substantive claim
   (nothing *types* it) holds; the stated reason is false, and it is the kind of
   reason a later reader relies on.

### One caveat that belongs to the pre-existing write path, not to #367

#367 does not delete the legacy rows, but `db/catalog/listingRepository.ts:278-280`
and `db/catalog/variantRepository.ts:238-241` are delete-then-reinsert on every
listing edit, and neither legacy table is in `db/protectedColumns.ts` (zero hits).
So retention of the **source** rows is a fact about who writes them; retention of
the **claim** is a trigger. A seller editing options after the backfill loses the
original text and keeps the frozen claim — which is the right outcome, and is not
what the ADR's wording ("preserved verbatim") would lead a reader to expect of the
source column.

**Verdict: partial.** Retention, forbidden axes, indistinguishable variants,
blocked-value shape and the no-similarity wall are properties. The ADR's own named
case (`Tono`), the sibling-collision refusal, and the link from a typed value to a
*resolved* claim are conventions — and the last of the three has a ready-made
constraint shape sitting in #90.

---

## Box 3 — no historical commerce snapshot is rewritten: **satisfied as a fact, partial as a property**

Two claims that must be kept apart. Note that **#367's migration surface is TEN
files, not twelve** — attributed by `git log --diff-filter=A --name-only --
packages/backend/drizzle/`: `0088, 0089, 0090, 0091, 0093, 0094, 0097, 0098,
0100, 0102`, every one carrying exactly one `-- oxy:deploy-phase=pre` on line 1.
The interleaved `0092, 0095, 0096, 0099, 0101` belong to #390, #431, #427 and
#445; the later #367 commits (W13, W14, W16/W17, W18, seams) added no migration.

### The fact about the past — satisfied, strongly

**No #367 migration writes, alters, deletes from or even references a commerce
table.** Four independent searches over exactly those ten files:

- Word-boundary mention of `orders`, `order_items`, `order_status_history`,
  `payments`, `refunds`, `ledger_transactions`, `ledger_entries`,
  `order_fee_snapshots`, `guest_checkouts`, `retail_procurement_intents`,
  `purchase_orders`, `draft_orders` — **one hit and it is prose**
  (`0100_same_iron_man.sql:261`, a comment).
- All `UPDATE` / `DELETE FROM` / `INSERT INTO` — five statements, all catalog:
  `0088:136`, `0088:162`, `0088:196` (the `categories` backfills) and `0091:173`,
  `0091:198` (staleness marks inside trigger bodies).
- All 133 `ALTER TABLE` statements — `ADD CONSTRAINT`/`ADD COLUMN` on catalog
  tables, plus one `native_listing_links DROP CONSTRAINT` and 0088's
  `categories ALTER COLUMN`. No `DROP COLUMN`, no `ALTER COLUMN` and no
  `DROP CONSTRAINT` against any commerce table.
- All 36 `REFERENCES "public"."…"` targets — catalog, vehicle and store only. No
  foreign key reaches a placed order, so not even an `ON DELETE CASCADE`.
- No dynamic SQL: no `EXECUTE format(...)` anywhere; every `EXECUTE` is
  `EXECUTE FUNCTION` in a `CREATE TRIGGER`.

**Positive control, and it fires.** The identical DML regex over all 103
migrations finds exactly the shape #367 is accused of, in *pre*-#367 files:
`0023_ambitious_proemial_gods.sql:91` (`UPDATE "orders" SET "buyer_origin" = …`),
`0030_giant_energizer.sql:51` (`UPDATE "order_status_history" SET "actor_kind" =
…`) and `0030:68`. So the search shape is sound, the repository *has* rewritten
historical order rows before — deliberately, under ADR 0003 M4 — and the
temptation D13 names was not taken this time. Note the ordering inside 0023: it
backfills `orders` at `:91` and installs `orders_buyer_origin_immutable` at
`:170`, so the same statement run today would be refused by the trigger that
file created.

Because all ten are `pre` — which `db/migrate.ts:46-58` defines as additive only,
applied **before** the rollout while the previous image is still serving — a
rewrite here would have corrupted live history. None does. **Vacuity control on
that "all ten":** nine other migrations in `drizzle/` carry
`-- oxy:deploy-phase=post`, so `pre` is a value this field genuinely varies over
rather than the only one it can take.

### The property — partial, and the boundary is worth knowing exactly

Three real triggers protect commerce snapshots, all plain `BEFORE … FOR EACH ROW`
`plpgsql` raising `check_violation`. **None is row-level security**, which is the
distinction that matters: RLS is bypassed by the table owner and a migration runs
as the owner; a plain trigger is not bypassed. Only `ALTER TABLE … DISABLE
TRIGGER` or `SET session_replication_role = replica` suppresses them and no
migration does either.

| Surface | Gated? | Where |
|---|---|---|
| `ledger_transactions`, `ledger_entries` | **yes** — whole table, UPDATE + DELETE | `mercaria_ledger_append_only`, `drizzle/0002_payment_domain.sql:258`, triggers `:267`, `:270` |
| `order_fee_snapshots`, `order_fee_snapshot_lines`, `fee_schedule_acceptances` | **yes** — whole table, UPDATE + DELETE | `mercaria_fee_record_append_only`, `drizzle/0016_volatile_wiccan.sql:168`, triggers `:176`, `:179`, `:182` |
| `order_items.condition_{key,assertion,notes}` | **yes** — 3 columns, UPDATE, refuses NULL → value too | `mercaria_order_item_condition_immutable`, `drizzle/0034_closed_tattoo.sql:358`, trigger `:371-373` |
| `orders.buyer_origin`, `.buyer_guest_checkout_id`, `.buyer_oxy_user_id` | **yes** — 3 columns, UPDATE only | `orders_buyer_origin_immutable`, `drizzle/0023_ambitious_proemial_gods.sql:170` (function `mercaria_order_buyer_origin_immutable`, `:155`) |
| `guest_checkouts` (5 columns) | **yes** — UPDATE only | `guest_checkouts_immutable`, `drizzle/0023_ambitious_proemial_gods.sql:132` (function `mercaria_guest_checkout_immutable`, `:110`) |
| `purchase_orders`, `purchase_order_lines` | **yes** | `drizzle/0014_fantastic_patriot.sql:490`, `:439` |
| **`order_items`' price, quantity and snapshot columns** | **no** | — |
| **`orders`' money and status columns; `DELETE FROM orders`** | **no** | there is no `BEFORE DELETE` on `orders` at all |
| **`order_status_history`, any column, any verb** | **no** — convention only | `db/schema/orders.ts:635-640`: "the ABSENCE of `updated_at` is the append-only contract". A missing column stops an ORM idiom, not an `UPDATE` |
| **`payments`** | **no trigger exists** | — |
| **`refunds`** | **no trigger exists** | — |
| **`draft_orders`, `retail_procurement_intents`** | **no** | only `retail_procurement_intent_lines` is triggered |

So the sharp answer depends entirely on the SET list.
`UPDATE order_items SET condition_key = …` fires and aborts the migration;
`UPDATE order_items SET unit_price = …` **applies silently**, and that is proven
deliberately — `db/__tests__/condition.realdb.test.ts:519-529` asserts
`db.update(orderItems).set({ position: 3 })` **resolves**, because a trigger
refusing every update to `order_items` would break refunds. The vacuity guard is
also the hole.

**The three refusal tests are real and non-vacuous.**
`condition.realdb.test.ts:486-530` (including the sharper
`refuses a BACKFILL of a pre-#90 line`), `db/fees/__tests__/fee-schedules.realdb.test.ts:298-317`,
and `db/payments/__tests__/ledger.realdb.test.ts:305-345`. All three assert
`rejects`, which is what makes them self-defending: **a zero-row UPDATE succeeds
in Postgres, so a vacuous version of any of them would go red rather than
green.** Each also proves its row exists first. The ledger file walks
`error.cause` and adds a fifth case (`leaves the row untouched after a refused
UPDATE`) because "a trigger that raised AFTER the row version was written would
pass every test above and still corrupt the book". They run in CI at
`.github/workflows/ci.yml:257`.

**Two absent gates, and neither is a capability gap.**

1. **Nothing scans migration SQL for write targets.**
   `db/__tests__/migration-handwritten-markers.test.ts` reads the whole `drizzle/`
   directory and gates the `oxy:handwritten-*` pairing and the
   `oxy:deploy-phase` marker through `@oxyhq/db`'s `readMigrationPhases` — it says
   nothing about what a statement writes. No `validate:*` script in the root
   `package.json` points at SQL. Positive control that the device is house
   standard: `validate-no-mongo.mjs` and `validate-money-formatting.mjs` are
   source-scanning gates with their own `test-validate-*.mjs` self-tests.
2. **No census demands a trigger for a new commerce-adjacent table.** Searched
   for `APPEND_ONLY`, `IMMUTABLE_TABLES`, `SNAPSHOT_TABLES`, `NEVER_REWRITTEN`
   across `packages/` — only prose in comments (`schema/reviews.ts:725`,
   `db/fees/feeScheduleRepository.ts:16`) and `disable trigger` statements in test
   fixtures. No data structure. The four `pg_trigger` assertions in the suite are
   per-domain vacuity floors naming their own triggers. Positive controls that the
   device exists and is applied to four *other* properties:
   `services/curation/__tests__/merge-plan-census.test.ts:1-28` (walks
   `getTableConfig(...).foreignKeys` over the drizzle barrel and fails until every
   referencing table has a disposition — and at `:219-236` enforces box 3's
   sibling, `no plan entry names an order or a listing table`),
   `db/__tests__/guest-data-inventory-census.test.ts:1-17`,
   `services/catalog-governance/__tests__/catalog-governance-isolation.test.ts:109-115`
   (a #367 wall forbidding order, payment and buyer **reads** in governance
   source — TypeScript, not SQL), and
   `db/__tests__/advisory-lock-census.test.ts:476-479`.

**Verdict.** The narrowest true statement the evidence supports: *#367 did not
rewrite a commerce snapshot, and a future migration cannot rewrite the ledger, the
fee snapshots, an order line's recorded condition, or an order's buyer identity.
It can still rewrite an order's money, its status trail, a payment and a refund.*

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
| `translation_machine_share` | rows `status = 'machine_translated'` / all localization rows that exist for the locale | `instant` | `category_localizations` | 900 s | `:751` |
| `translation_fallback_use_rate` | *(would be)* localized reads answered from a fallback locale / all localized reads | `rolling_24h` | `category_localizations` | 300 s | **`unmeasured`**, `not_instrumented`, `:790` |
| `attribute_localized_label_completeness` | active attribute definitions carrying at least one `attribute_labels` row / all active attribute definitions | `instant` | `product_type_definitions` | 900 s | `:720` |

Two attribution limits an operator has to read together, or the dashboard misleads
in the dangerous direction:

- **`translation_machine_share` is "of rows that EXIST".** A locale with nothing
  translated has a machine share of **zero**, which is the worst case and looks
  like the best. It is only readable beside `translation_coverage`.
- **`attribute_localized_label_completeness` counts LOCALIZED label coverage
  deliberately, not "does the attribute have a label"** — `attribute_definitions.label`
  is `NOT NULL`, so the latter would be vacuously 100% and could never fall. One
  label in one locale satisfies it, so it says nothing about whether the locales
  this deployment serves are covered.

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
| `proposal_creation_count` | `catalog_proposals` rows created in the window | `rolling_7d` | `catalog_proposals` | 300 s | `:653` |

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
scrape format; scraping, thresholds and routing belong to `oxy-infra`. A metrics
collection runs of the order of six hundred statements including a 60-scope facet
sweep, so the probe cadence is minutes, not seconds.

### The thresholds are deliberately left unset, and this is the honest reason

Every number in the six runbooks is a **proposal, and no alert has ever fired**
(`catalog-observability.md` §"What has not been rehearsed"). Nothing here picks
one, because a threshold chosen before any traffic is a guess with a runbook
wrapped around it, and the wrapping is what makes it look settled. What can be
stated without traffic is the **shape** of each threshold and the **measurement
that would set it** — so whoever wires `oxy-infra` knows what to collect first
rather than what to type.

| Signal | Threshold shape | The measurement that would set it |
|---|---|---|
| **Failures** | any non-zero on the three `mustStayZero` counters (no calibration needed — the conditions are structurally impossible, so one is as alarming as a thousand); a **rate** on `authoring_schema_error_rate` | for the rate: the p99 of that rate over two weeks of authoring traffic with `CATALOG_AUTHORING_ENABLED` on. Until then it answers `surface_not_mounted`, so there is nothing to calibrate against |
| **Lag** | an **age** on `unresolved_subject_oldest_age` and `proposal_backlog_oldest_age`, never a depth | the observed distribution of time-to-decision once the review desk is staffed. The age is the right shape because a deep queue draining fast is healthier than a shallow stuck one; the number is a service-level choice somebody makes, not a fact to discover |
| **Missing translations** | a **drop** in `translation_coverage` per locale relative to its own trailing value, plus an absolute floor per locale before that locale is advertised | the coverage series per locale over one translation cycle. A cross-locale constant is wrong on its face — a launch locale and a long-tail one are not comparable |
| **Review backlog** | an **age**, as above, plus a rate-of-arrival alert on `proposal_creation_count` (`rolling_7d`) to catch a taxonomy gap rather than a staffing one | the arrival rate once merchants are authoring. The definition's own attribution limit is the trap: a rise means the taxonomy is missing concepts OR that more merchants are authoring, and only the completeness metrics separate them |

**Three that must not get a threshold at all**, and the reason is in the metric
rather than in the number: `reindex_pending_count` (only grows, no consumer),
`backfill_dead_letter_count` (`unmeasured` — a zero would be a permanently green
tile for a condition that cannot occur) and `translation_machine_share` read
alone (zero is the worst case, not the best).

---

## Box 4 — backfill/reindex jobs resume safely after interruption: **partial, and vacuous for three of the four queues**

Procedure and the per-job operator steps:
[`runbooks/catalog-backfill-resumption.md`](runbooks/catalog-backfill-resumption.md).
The audit:

**Exactly one job in the epic is genuinely leased, cursored and drained.**
`catalog_backfill_runs`: `SELECT … FOR UPDATE SKIP LOCKED`
(`db/backfill/backfillRunRepository.ts:145-200`, `SKIP LOCKED` at `:169`), a
per-process owner UUID (`services/backfill/backfill.service.ts:110`) with an
owner-checked release (`backfillRunRepository.ts:319-324`), a durable cursor
(`db/schema/backfill.ts:161`) advanced only after the page commits
(`backfill.service.ts:224`) and left untouched by a page that throws (`:197-219`),
per-record identity keys with `ON CONFLICT`, and a real dispatcher
(`startCatalogBackfillDispatcher`, `src/index.ts:164`).

**Three queues carry lease-shaped columns that no production code writes, and none
has a consumer.** For these the acceptance sentence is not failing — it is
vacuous, because nothing runs:

| Queue | Claim columns | Consumer |
|---|---|---|
| `attribute_reindex_requests` | `db/schema/attributeRegistry.ts:557-559`, CHECK `:566-571`, `attempts` `:560` | **none.** Only reader is `listPendingReindexRequests` (`db/attributes/attributeOpsRepository.ts:225-227`) → one read-only operator listing (`controllers/internal-catalog-attributes.controller.ts:285`). `grep "update(attributeReindexRequests"` exits 1; `processed_at` appears once, as an `is null` predicate |
| `catalog_external_mapping_runs` | `db/schema/catalogExternalMappings.ts:792-794`, CHECK `:826-828` | **none, and NO PRODUCER PATH EITHER** — verified: `openReprocessRun` and `runReprocessPage` have zero callers outside `services/catalog-external-mappings/reprocess.service.ts`. No route, no controller, no CLI, no dispatcher. `RUN_COLUMNS` (`db/catalogExternalMappings/externalMappingRepository.ts:824-842`) deliberately omits the claim columns |
| `catalog_external_token_observations` reprocess stamps | `db/schema/catalogExternalMappings.ts:666-668`, CHECK `:723` | **none.** `reprocessed_at` is written exactly once in the repository, as `null` (`externalMappingRepository.ts:816`), and `applyObservationResolution` (`:799`) is called only from the unreachable `reprocess.service.ts:259` |

Positive control for those three absences, with the same grep shape: the
moderation outbox has a claim at
`db/moderation/moderationOutboxRepository.ts:195-217` (`for update skip locked`
at `:213`), four production writers and a loop at `src/index.ts:120`; `offer_outboxes`
has one at `db/offers/offerOutboxRepository.ts:110-140`, three production writers,
a loop at `src/index.ts:143` and a real `dead_letter` state.

**Two real holes on the one job that works.**

1. **A page-level failure strands the run permanently, and the operator endpoint
   misreports it.** `RESUMABLE = ['pending','paused']`
   (`backfillRunRepository.ts:38`) and the claim additionally admits a `running`
   row whose lease expired (`:158-166`) — `failed` is in neither, and
   `listResumableBackfillRuns` (`:336-352`) excludes it, so the dispatcher never
   touches that run again. There is no `attempts` on the run, no `available_at`
   and no backoff. And `POST /internal/backfill/runs/:id/page` answers **409
   "Another task is running this backfill page"**
   (`controllers/backfill-operator.controller.ts:135-138`) when nothing is running
   it. Both verified directly. The remedy is a new run over the same cohort, which
   re-scans from zero and converges by record idempotency.
2. **The reclaim path is untested**, and it is the single mechanism box 4 rests
   on. No test calls `claimBackfillRun` — its four references are all production —
   so the expired-lease branch (`backfillRunRepository.ts:158-166`) and the
   mid-page reclaim guard (`backfill.service.ts:230-237`) are unexercised.
   `services/__tests__/backfill.realdb.test.ts`'s `runToCompletion` (`:285-313`)
   treats a lost lease as a test failure (`:301`) — it is a
   runs-to-completion-once test.
   `services/catalog-observability/__tests__/integrity.realdb.test.ts:761` tests
   the stalled-lease **detector** against synthetic rows.

**The stalled-lease detector is real for one table and permanently `0/0` for the
other two.** `checkStalledQueueLeases`
(`services/catalog-observability/integrity.service.ts:671-730`, registered `:749`)
covers `catalog_backfill_runs`, `catalog_external_mapping_runs` and
`catalog_external_token_observations`; two of the three can never populate,
because nothing writes their claim columns — its own tests hand-INSERT them with
raw SQL to make the check fire (`integrity.realdb.test.ts:796-838`).

**No dead-letter or capped backoff anywhere in #367.** Confirmed by column:
neither run table has an `attempts` column at all
(`db/schema/backfill.ts:140-200`, `db/schema/catalogExternalMappings.ts:764-802`);
positive control, `attribute_reindex_requests` does have one and it is never
incremented. This is W17's declared seam 6 and it is correctly reported as
`unmeasured` rather than zero.

**Three more docblocks asserting mechanisms the code does not implement:**
`db/schema/attributeRegistry.ts:544-548` ("claims are leases with an owner check"
— no claim function exists); `services/catalog-external-mappings/reprocess.service.ts:13-17`
("the next claim re-reads that page" — no claim and no caller); and, in the
opposite direction, `services/catalog-proposals/backfill.service.ts:178-186`
warns of an orphaned stamp a crash cannot leave, because the claim and the value
write share one transaction (`:218-272`) — harmless, except that it sends an
operator hunting for rows that cannot exist.

**Verdict: partial.** True and mechanised for `catalog_backfill_runs`, untested at
the reclaim boundary, with a permanent-strand hole on page failure. Vacuous for
the other three, which is a stronger statement than "broken": there is nothing to
resume because nothing runs.

---

## Box 6 — rollback is documented and tested: **documented, NOT tested**

Full procedure, the four things a rollback does not undo, and the rehearsal:
[`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md).

**Documented: yes, and the design is sound.** Turning a lever off withdraws a
mount and nothing else; every stored row stays readable through nine `/internal/*`
surfaces gated on no rollout lever; the storefront degrades by design, with the
navigation fallback INSIDE one React Query query
(`packages/frontend/lib/catalog/use-navigation.ts:89`) catching the 404, the empty
tree list and a network error alike, and the facet rail rendering absence rather
than an empty panel (`lib/catalog/use-facets.ts:18-22,73,75`).

**Tested: no.** Nothing has been executed — no lever has been flipped on a running
deployment anywhere — and **no automated test flips one.** The house pattern
exists (`routes/__tests__/search-rollout.realdb.test.ts:1-18`,
`routes/__tests__/guest-session.disabled.integration.test.ts`,
`routes/__tests__/cart-guest.disabled.integration.test.ts`) and the catalog epic
has no counterpart. Neither storefront fallback has a test either — confirmed with
a positive control, and the exact precedent sits one file away
(`packages/frontend/lib/catalog/__tests__/compatibility.test.ts:146`).

So of box 6's two halves:

- **"turning any lever off must NOT make a durable record unreachable"** — the
  strongest available evidence, and it is structural rather than behavioural: the
  four levers are read in six places, four of them the mount, none in a
  repository, a loop, an outbox or checkout. Reproducible in one grep.
  **Conditional on `CATALOG_OPERATOR_OXY_USER_IDS` being non-empty**, because
  `graphOperatorSurfaceEnabled` is derived from its length
  (`config/index.ts:3716`) and an empty list 404s all nine internal surfaces.
- **"turning a read lever off must restore the previous behaviour"** — true by
  reading, defended by nothing. This is the half to be careful about, because the
  mechanism that carries it lives in the FRONTEND, where the epic has no
  isolation gate and two test files.

**Four things a rollback does not undo**, each with a remedy that is a data change
rather than a lever: `categories.key NOT NULL`
(`drizzle/0088_redundant_korvac.sql:201`); the selectability trigger on the legacy
listing-write path (`0088:461-469`, narrow — see Box 1); localized reads, which
are contained transitively and ungated; and `/product-types`, which has no lever
and is unpublished rather than unmounted. Authoring additionally **cannot be
narrowed to a cohort**, so D12's staged rollout order is not executable as
written.

---

## Summary: what can be ticked

| Box | Verdict | The one-line reason |
|---|---|---|
| 1. Existing products remain readable and sellable | **partial** | True and measurable — five lever-gated mounts, all new surfaces; no commerce path imports the epic. The gate covers 4 repository files of 1 domain of 9, and three docblocks claim more. |
| 2. Legacy free text migrated only where deterministic | **partial** | Retention, forbidden axes, indistinguishable variants and the no-similarity wall are properties. The ADR's own `Tono` case, the sibling-collision refusal and the typed-value → resolved-claim link are conventions; the last has a ready-made #90-shaped constraint. |
| 3. No historical commerce snapshot is rewritten | **satisfied as a fact, partial as a property** | No #367 migration touches a commerce table (ten files, four search shapes, a positive control that fires on pre-#367 files). The ledger, fee snapshots, recorded condition and buyer identity are trigger-protected; an order's money, its status trail, payments and refunds are not, and nothing scans migration SQL. |
| 4. Backfill/reindex jobs resume safely after interruption | **partial** | One job resumes, untested at the reclaim boundary, with a permanent strand on page failure. Three queues are vacuous — no consumer, and one has no producer path either. |
| 5. Dashboards and alerts expose failures, lag, missing translations, review backlog | **partial** | The numbers exist as DATA with numerator, denominator, window, source, freshness and attribution limit, and each of the four has a runbook. No metric counts a failed publication; alerts and dashboards do not exist and belong to `oxy-infra`; no alert has ever fired. |
| 6. Rollback is documented and tested before GA | **documented, NOT tested** | Nothing has been executed, no test flips a lever, and neither storefront fallback has a test. The rehearsal is five steps. |

**None of the six is tickable as written.** Boxes 1–4 are tickable if the box is
read as "the mechanism exists and is documented"; none is tickable if it is read as
"a check would fail if somebody removed it". Box 3's *fact* half is tickable
outright. Box 6 must not be ticked at all until §"The rehearsal" in the rollback
runbook has been run, because that is the one whose failure mode is discovered
during an incident.

**Cheapest work that would change those verdicts**, in order of how much each buys:

1. **A `routes/__tests__/catalog-rollout.realdb.test.ts`** in the shape of
   `search-rollout.realdb.test.ts` — one module graph per lever value, asserting
   the five paths 404 while `/categories`, `/listings`, `/cart` and `/checkout`
   answer, and that a row written with a lever on is readable through `/internal/*`
   with it off. Moves boxes 1 and 6 together.
2. **A CHECK or trigger requiring a typed axis assignment to cite a
   `value_resolution = 'resolved'` claim** (`native_variant_axis_assignments.source_claim_id`
   is nullable and the scope trigger is silent on resolution state). Moves box 2's
   remaining half, and the constraint shape already exists in #90.
3. **A migration-SQL gate** in the `validate-no-mongo.mjs` shape, refusing DML and
   destructive ALTER against a named commerce set, with the exact-count exemption
   list `migration-handwritten-markers.test.ts` already uses. Moves box 3's
   property half; and a snapshot-immutability census in the
   `merge-plan-census.test.ts` shape would immediately report
   `order_status_history`, `payments` and `refunds` as unprotected.
4. **A terminal state plus a retry budget on `catalog_backfill_runs`**, which
   closes box 4's strand hole and W17's seam 6 at once, and a test that calls
   `claimBackfillRun` across an expired lease.
5. **Widen the lever walls**: `catalog-authoring-isolation.test.ts`'s predicate to
   the whole domain, its mutation self-test to run the real `offenders` filter, and
   the same wall onto `facet-isolation.test.ts`,
   `navigation-isolation.test.ts` and `catalog-proposal-isolation.test.ts`.
   `services/__tests__/product-type-isolation.test.ts:92` already holds the
   strongest form, aimed at a lever that was never built.
6. **Correct ADR 0007 D12** to name the four levers that exist, record
   `FACETS_ENABLED`, and state that the staged rollout order needs a cohort
   expression nobody built. Five documents quote D12 today.
