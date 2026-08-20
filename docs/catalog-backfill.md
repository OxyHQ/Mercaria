# The legacy-catalogue migration (#367 workstream 13)

Moving Mercaria's listing-first catalogue onto the universal catalog system —
ADR 0007 **D6, D7, D12, D13**. What is here is the INVENTORY, the
CLASSIFICATION, the one deterministic backfill, the RECONCILIATION between the
old reads and the new ones, and the cutover and rollback plan.

The thing to hold on to before anything else: **a serious port bug fails by
returning something plausible.** `Tono` looks like `Color`. `Knitwear` looks like
it ought to be a product type. A merged category looks like a live one from every
read that does not check `lifecycle`. Every one of those produces a migration
report full of confident numbers, and the mistake is found by a seller whose blue
shoes are filed under somebody's idea of black.

So the deliverable of this workstream is a classification with a backlog in it,
not a clean number. ADR 0007 says so in its own consequences section: *"Ambiguous
legacy values are not resolved. They stay text, in a queue, visible. This is
deliberate and it means the migration's output includes a backlog rather than a
clean number."*

---

## The shape

| Thing | Where |
|---|---|
| Vocabulary, matrix policies, report DTOs | `@mercaria/shared-types` `catalog-backfill.ts` |
| The pure classifier | `services/catalog-backfill/classification.ts` |
| The product-type text fold | `services/catalog-backfill/product-type-text.ts` |
| The column inventory | `services/catalog-backfill/mapping-matrix.ts` |
| The `--cohort=` parse | `services/catalog-backfill/cohort-argument.ts` (over #60's `cohort.ts`) |
| The three passes | `classify.service.ts` · `reconciliation.service.ts` · `repair.service.ts` |
| Reads | `db/catalogBackfill/legacyCatalogRepository.ts` |
| Commands | `scripts/backfill-catalog-{classify,reconcile,paths}.ts` |

**No new tables and no migration.** Every verdict is DERIVED from rows that are
already there, which is the `deriveNativeCheckoutEligibility` divergence one more
time: a stored classification is a cached verdict, and the inputs sit on
`listings`, `categories`, `product_type_definitions`, `brands` and
`brand_aliases` — five tables in four domains, any of which can change without
this one being told. #367 step 4 reached the same conclusion for the same reason
("there is no run table, deliberately") and #60's `catalog_backfill_runs` remains
the canonical-graph migration's, not this one's.

---

## The mapping matrix

Six legacy fields, and the two questions that are deliberately kept apart:
what EVIDENCE would justify a write (`LEGACY_CATALOG_BACKFILL_POLICY`) and who
performs one TODAY (`LEGACY_CATALOG_WRITE_OWNERS`). Collapsing them would make
"nothing writes this yet" indistinguishable from "nothing may ever write this",
and only one of those is a seam somebody closes.

| Legacy field | Becomes | Evidence policy | Written by | Classified by |
|---|---|---|---|---|
| `listings.category_id` | `categories` (D2) | deterministic only | **nobody yet** — see below | this domain |
| `listings.category_slugs` | `categories.ancestor_slugs + slug` (D13) | deterministic only | **this domain** | this domain |
| `listings.product_type` | `product_type_definitions` (D5) | deterministic only | **nobody yet** — no column | this domain |
| `listings.vendor` | `brands` + `brand_aliases` | **never backfilled** | #60's candidate stage | this domain |
| `listing_options.name` / `.values` / `.position` | typed axes (D6) | alias evidence permitted | #367 step 4 | #367 step 4 |
| `product_variant_option_values.*` | axis assignments (D6) | alias evidence permitted | #367 step 4 | #367 step 4 |

`mapping-matrix-census.test.ts` holds the matrix to a **partition of the three
legacy tables**: every one of their 56 columns is either mapped to a subject or
excluded with a one-word reason from a closed vocabulary, and the union is the
tables' whole column set. A column added to `listings` fails the build until
somebody decides what the migration does with it — `merge-plan-census.test.ts`'s
device, and the first one it will catch is known and welcome:
`listings.product_type_definition_id`, which ADR 0007 D13 assigns to the
authoring workstream.

### Three findings the inventory turned up

- **`listings` has no product-type column at all.** D13 assigns
  `product_type_definition_id` to the authoring workstream and it has not landed,
  so `listing_product_type_text` is classified and never written. The
  classification is what that column's backfill will consume.
- **`listing_options.values` is read by nothing.** #367 step 4's
  `legacyOptionRepository` does not select it and its listing-level claim carries
  `rawValue: null`; the per-VARIANT values in `product_variant_option_values` are
  what become assignments. So a declared option value no variant uses is retained
  only as the legacy row itself (D13 keeps the table) and is typed nowhere.
  Stated rather than fixed: inventing a variant to carry it would invent a SKU.
- **`category_external_mappings` cannot reach connector listings.** It is keyed
  on `catalog_sources`, and a Shopify or WooCommerce listing comes from
  `connections`. External taxonomy mapping (workstream 11) covers INGESTION
  sources; the connector path has no mapping table and is not in this
  workstream's scope.

### The client-side inventory: hard-coded lists, and where they are gated

Workstream 13 also asks for "all hard-coded category lists, filter lists, option
names and translations in frontend/backend". When it was written, two of the four
client packages were gated and both gates were PREFIX-SCOPED to one package,
which was the whole finding: scanning the two ungated packages as TEXT turned up
exactly one hard-coded catalog list, and it was in the shared package —

> `packages/ui/src/components/marketplace/VariantSwatches.tsx`
> `const COLOR_OPTION_NAMES = new Set(["color", "colour", "shade"]);`

— which the storefront product page imports. **The storefront's own gate was
walked around by an import into a package that gate did not scan.** The
consequence there was mild and worth stating precisely: that line was a
PRESENTATION decision, not a mapping. It picked a widget; it asserted no fact,
wrote nothing, and could not make `Colour` and `Tono` the same attribute. What it
did do was render `Colour` as colour and `Tono`/`Tamaño` as pills, and
`valueToColor` hashed the value string so `Negro` and `Black` got unrelated hues.

Both halves are now closed. **#571** removed the list: every option renders as a
pill, because nothing in this codebase records what colour a value IS — there is
no swatch column and no per-value image, so a swatch could only show a cycled
gallery photo or a hash artefact. **#478** closed the topology, which is the part
that generalises:

| Tree | Read gate (WS9) | Authoring gate (WS8) |
|---|---|---|
| `packages/frontend/` | ✅ | — |
| `packages/dashboard/` | — | ✅ |
| `packages/ui/src/` | ✅ | ✅ |
| `packages/pos/` | ✅ | — (no authoring surface) |

Each gate scans the trees its app **compiles**, not the package it is filed
under: all three apps alias `@mercaria/ui` to `../ui/src` in `tsconfig.json`, so
the shared tree is part of every app's program. The shared tree is read by both
gates because they assert two different properties, and because neither
analyser is a superset of the other. Floors are per tree, so one tree dropping
out of the population cannot be masked by another clearing the total.

Widening the population was not sufficient on its own, and the measurement is
worth keeping: run against the real pre-#571 `VariantSwatches`, the widened guard
produced ZERO findings. `IDENTITY_NAMES` carried `optionName` but nothing matched
`option.name`, the spelling every DTO uses. #478 taught wall 1 a narrow
`NAME_RECEIVERS` set and made it read through case/whitespace normalisers, which
is how `NAMES.has(option.name.trim().toLowerCase())` had hidden the identity.

A real swatch still needs a schema decision — which attribute an option resolved
to is an existing unplumbed seam (`native_listing_variant_axes` cites an
`attribute_definition_id`, but no route serves an axis and `ListingOption` is
still `{name, values}`), and what a value LOOKS like is not a seam at all.

**Translations are clean, and the census size is stated so the zero can be
read:** 46 locale bundles across all four packages, walked key by key. The only
two hits under a catalog-name-shaped key are
`products.new.optionNameLabel` / `optionNamePlaceholder` in the dashboard — a
form label and its placeholder, which are copy rather than a catalog vocabulary.
No client bundle carries a category, product-type or controlled-value NAME.

**Every one of these scans reads the client packages as TEXT.** A backend test
that IMPORTED client source would compile it under `packages/backend`'s
`strict: false` program, silently dropping every null-safety check those
`strict: true` packages are written to rely on — so the pattern every
frontend-touching backend check already uses is load-bearing, not stylistic.

---

## The classification

Four classes — the epic's — plus `not_applicable`, which is **not** a fifth
confidence level: it means the row carries no legacy value for that subject at
all. It exists because the counters must sum to the population by EQUALITY, which
is `catalog_backfill_runs_counters_total_check`'s rule applied to a script.

| Class | Means | Example reason |
|---|---|---|
| `deterministic` | one target, from an identity fact already stored | `category_assignment_merged_target_live` |
| `high_confidence` | one target, from evidence a person recorded about a CLASS | `vendor_brand_single_candidate` |
| `ambiguous` | several candidates, or one the rules refuse to choose between | `product_type_key_published_not_eligible` |
| `invalid` | the legacy value names no target in the new model | `product_type_no_registered_key` |
| `not_applicable` | no legacy value to classify | `product_type_text_absent` |

`actionable` (work is owed) and `reviewOwner` (a PERSON owes it) are independent
fields, and a census asserts `(owner === 'none') === !actionable` — so a row
nobody owes anything on cannot be marked as owing work, and work cannot be owed
to nobody. That pair is workstream 13's "define explicit ownership for manual
review of ambiguous rows", as data rather than as a paragraph.

### What may decide a mapping, and what may never

`LEGACY_CATALOG_CANDIDATE_SIGNALS` (11) and `LEGACY_CATALOG_FORBIDDEN_SIGNALS`
(10) are disjoint by a test, and `catalog-backfill-isolation.test.ts` scans the
whole domain for the forbidden ones with a mutation self-test. **There is no
similarity metric, no distance, no threshold and no score anywhere in this
domain.**

`LEGACY_CATALOG_SIGNAL_MAY_DRIVE_A_WRITE` is a separate question from mere
permission, and the two brand signals are why it exists: an exact
normalized-name match against exactly one active brand is perfectly good evidence
for an operator to look at and terrible evidence to attach identity on. ADR 0007
D1 makes a label presentation, and #55's `verification_method` has no
`name_match` member.

### The three refusals worth reading

- **A product type resolves by EXACT KEY.** `legacyProductTypeTextToKey`
  performs five mechanical folds (trim, lowercase, whitespace→`_`, hyphen→`_`,
  collapse repeats) and nothing else; `LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS` names
  ten it may never perform, disjoint by a test. `Knitwear` folds to `knitwear`,
  which no version answers to, and that is `invalid` — correct, and the backlog
  IS the result. **`depluralisation` is the one to read twice**: `Shoes` → `shoe`
  is the most obviously useful fold on this dataset and the most dangerous, and a
  catalogue full of `Pants`, `Glasses` and `Scissors` has no singular to fold to.
- **It is not step 4's fold.** An attribute key is `^[a-z][a-z0-9_]*$` while a
  product-type key admits dotted namespaces, so reusing `legacyOptionNameToKey`
  would refuse every namespaced key and report it as `no_registered_key` — a
  wrong answer that looks exactly like a right one.
- **An empty product-type scope grants nothing.**
  `product_type_category_scopes` GRANTS a place a version may be used, the
  opposite reading from `attribute_definition_categories`, whose empty scope
  means everywhere. A listing with no category cannot have its eligibility
  decided at all and answers `product_type_key_category_unknown`.

### The precedence, because it is not obvious

A category can be several kinds of wrong at once, and reporting whichever branch
an `if` chain reached first would make the counts a property of the code's
layout. The order is chosen so each verdict names the fact whose REMEDY is the
right next action: no category → merged → deprecated / suppressed / draft → not
selectable → outside the effective window → current. Merged outranks everything
because the operator already said where the node's identity went; selectability
outranks the window because a structural node is never a valid assignment at any
time.

---

## The one backfill this domain performs

`listings.category_slugs`, re-derived from `listings.category_id` through the
taxonomy. It repairs a real and currently unrepaired drift:
`taxonomyRepository.moveCategory` rewrites `categories.ancestor_slugs` for a
whole subtree in one statement and **touches no listing**, so every listing under
a moved node keeps the path it was written with — and five services filter on
that path (`listingRepository`, `seoRepository`, `collectionRules`,
`conditionPolicyRepository`, `searchCandidateRepository`).

```bash
# From packages/backend. The default is a DRY RUN.
DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts
DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts --apply --limit=500
DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts --apply --after=<listingId>
DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts --apply --cohort=store:<storeId>
```

All three commands take `--cohort=<kind>[:<value>]` — `all` (the default),
`store:<id>`, `category:<id>`, `owner_type:user|store` or
`connector_provider:<id>`. It is #60's cohort vocabulary, parsed once
(`services/catalog-backfill/cohort-argument.ts`) so an operator who types
`--cohort=store:abc` gets the same slice from the classification, the
reconciliation and the repair; three copies is how the repair ends up addressing
rows the classification never looked at. Every report logs the cohort it ran
under, because a count cannot be read without its scope.

- **`--apply` is required to write anything, and there is no environment variable
  for it.** A migration that wrote because somebody forgot a flag is the one
  failure neither a report nor a rollback can undo.
- **A dry run is not a prediction.** Both modes run the identical statements
  inside a transaction; a dry run rolls back. A parallel predict path is a second
  implementation, and the two disagree exactly where a migration is dangerous.
- **The rollback is running it again.** The value is a pure function of the
  listing's category and the taxonomy, so nothing is destroyed and a second pass
  converges — `pathsRewritten: 0`, which the realdb suite asserts.
- **The write goes through `updateListingColumns`**, the sanctioned writer
  `listing-publication-chokepoint.test.ts` counts. The isolation gate asserts
  EXACTLY one module in this domain imports it.
- **One declared side effect:** `updateListingColumns` stamps `updated_at`, so a
  repaired listing gets a fresh modification time and a fresh sitemap `lastmod`.
  Defensible — its browse path genuinely changed — and declared here rather than
  discovered later.

### The repair this domain does not perform

Repointing a listing whose category was **merged** is equally deterministic
(`category_assignment_merged_target_live`) and is deliberately absent. It
overwrites `category_id`, and the value it overwrites exists nowhere afterwards,
so an undo needs a durable record of what the row said before — `category_redirects`
records `old category → target` and its inverse is not derivable, because a
listing already on the target is indistinguishable from one that was moved there.

**What would close it:** one append-only table recording every repoint —
`(listing_id, before_category_id, after_category_id, classifier_version, actor,
reason, applied_at)` — with no unique index, because the repair is idempotent by
its own PREDICATE (a listing whose category is no longer `merged` is not
selected) rather than by convergence on a key. That is one `pre` migration and
one repository. Shipping the write without it would be a migration whose rollback
strategy is "we hope it was right".

---

## The reconciliation

Three probes, each comparing a v1 read contract D13 retains against the authority
it projects. **Reads only** — a reconciliation that repaired what it found would
be a second writer racing the first and would destroy the evidence of how far the
two reads had drifted (#60's consistency sweep, same choice, same reason).

| Probe | Legacy read | Authority |
|---|---|---|
| `listing_category_path_projection` | `listings.category_slugs` | `categories.ancestor_slugs + slug` |
| `category_browse_count_agreement` | `category_slugs @> [slug]` | `category_id` ∈ node ∪ descendants |
| `category_is_active_projection` | `categories.is_active` | `lifecycle = 'published'` |

The third is the one with nothing behind it: `taxonomy-write-chokepoint.test.ts`
states plainly that the cross-column CHECK which would hold `is_active` and
`lifecycle` together is a `post`-phase statement that has **not** been applied. So
the repository keeps them in step and nothing else does, and a second writer
"writes a row that looks entirely ordinary".

**Every probe carries its own vacuity floor.** A probe that examined nothing
reports perfect agreement, and `diverged: 0` off an empty scan is exactly the
number that gets quoted in a cutover decision. The floors are per probe, because
"there are listings" says nothing about whether the category probes had subjects.

---

## What a real pass looks like

Measured on a throwaway database carrying the dev seed (`provision-taxonomy`,
`seed`, and all three vertical packages) on 2026-08-17. Nine listings, 46
categories.

```
coverage                     listingsTotal 9   withCategory 9   withoutCategory 0
                             withProductTypeText 7   withVendorText 7   withLegacyOptions 1

listing_category_assignment  deterministic 9 (category_assignment_current 9)
listing_category_path        deterministic 9 (category_path_agrees 9)
listing_product_type_text    invalid 7 (product_type_no_registered_key)  not_applicable 2
listing_vendor_text          invalid 3 (vendor_brand_no_candidate)       [3 distinct values]
retainedClaims               queued 0
```

**Seven of seven product-type strings resolve to nothing, and three of three
vendor values resolve to no brand.** That is the honest headline of this
migration and it is not a defect in the classifier: the seed's listings say
`Knitwear`, `Dresses`, `Pants`, `Shoes` and `Makeup` while the published product
types are `footwear`, `smartphone` and `brake_pad`, and the seed's `vendor` is
the SHOP's name, which is not a brand. Making those numbers smaller means
publishing product types and brand aliases, which is an operator's decision with
evidence behind it — not a fold.

Then a real `moveCategory` was performed on the seeded taxonomy (`shirts` moved
under `men`, three listings beneath it), and the whole cycle ran end to end:

```
reconcile   listing_category_path_projection   examined 9   diverged 3
            category_browse_count_agreement    examined 39  diverged 2
            category_is_active_projection      examined 46  diverged 0
paths --apply                                  scanned 9    rewritten 3   cleared 0
reconcile   (all three probes)                 diverged 0
```

---

## Why the cohort exists, and the measurement that produced it

Every assertion in `catalog-backfill.realdb.test.ts` is census-shaped —
`coverage` counts listings, the vendor pass aggregates distinct
`listings.vendor`, and both category probes scan `categories`. The first version
of that file therefore created its **own throwaway database**, following
`provision-taxonomy.realdb.test.ts`. That was measured and rejected.

It would have been the SIXTH suite file to migrate a private database
(`graph-plan-regression`, `provision-taxonomy`, `seed`, `offer-freshness-sweep`
and `ingestion/active-policy-slot` are the others). The migrator applies the
whole 102-migration chain in one transaction, holding a lock per object it
creates, and the server's lock table is `max_locks_per_transaction ×
max_connections` — 64 × 100 on `postgis/postgis:17-3.5`'s defaults. Measured
across four full-suite runs:

| Run | This file | Result |
|---|---|---|
| 1 | private database | 2 gate failures, no lock failures |
| 2 | private database | **4 realdb files failed together**, `out of shared memory` |
| 3 | private database + a narrow retry | 4 realdb files failed; this one survived on its retry |
| 4 | **file removed** (control) | **534/534 green, zero lock failures** |

The control is what settles it: the private database was the tipping point, not
a pre-existing flake to point at. So the passes take a COHORT — #60's, reused
rather than redefined, so a rollout that says "selected stores" means the same
thing to both migrations — and the suite files every fixture listing under one
fixture store and scopes by it. The listing-grain counts stay EXACT, the file
runs in 0.35 s instead of 13 s plus a migration, and nothing new competes for
the lock table.

Two subjects genuinely cannot be cohort-scoped, and each says so rather than
pretending: the **vendor pass** reports `not_in_this_pass` under a cohort (its
grain is the normalized value), and **`category_is_active_projection`** compares
two columns of `categories`, which a listing predicate cannot narrow. The suite
asserts the first with floors over its own run-suffixed values and the second as
a DELTA against the same probe moments earlier.

**The underlying capacity limit is still there and is worth fixing separately:**
one line of server configuration in `docker-compose.postgres.yml` and in
`ci.yml`'s postgres service block — `command: postgres -c
max_locks_per_transaction=256` — would help the five pre-existing files. That is
shared infrastructure this workstream does not own.

## Rollout and cutover

ADR 0007 D12's six levers are the rollout controls and **this workstream adds
none**, deliberately: nothing here gates a durable record, the classification is
derived, and the one repair is a projection whose rollback is re-running it. The
mode of the write is a command-line argument because it is an operator's decision
on the day (#367 step 4's ruling, and `PRODUCT_SAVE_MIGRATION_ENABLED`'s before
it).

The staged order the epic asks for, with the gate at each step:

1. **Internal.** Run `classify` and `reconcile` against production, read only.
   The gate is `coverage` being non-zero and every probe's `examined` being
   non-zero — a pass that measured nothing is refused rather than reported.
2. **Selected stores.** `--cohort=store:<id>` on all three commands, so the
   classification, the reconciliation and the repair address the same slice.
   Read the classification for that store, run `paths` as a dry run, then
   `--apply`, then `reconcile` the same cohort.
3. **Selected product types and categories.** `--cohort=category:<id>` narrows
   the same three. Publish product-type versions and category aliases for the
   buckets the classification named, then re-run `classify` and watch
   `product_type_no_registered_key` fall. **Falling because somebody published a
   version is a result; falling because somebody added a fold is a regression** —
   `LEGACY_PRODUCT_TYPE_FORBIDDEN_FOLDS` and its disjointness test are what tell
   the two apart.

   Two things a cohort does NOT narrow, and both say so in the report rather than
   quietly answering a smaller question: the vendor pass (whole-catalogue by
   grain — it reports `not_in_this_pass`) and `category_is_active_projection`
   (a comparison between two columns of `categories`, which a listing predicate
   cannot scope). Cohort selection for the canonical READ paths is a different
   lever again, `CANONICAL_READ_COHORTS`, and belongs to #60.
4. **Locales and markets.** Not this workstream's: labels and localized slugs are
   step 2's, and none of them is identity.
5. **GA.** `backfill-catalog-paths.ts --apply` over the whole catalogue, then
   `reconcile` clean.

### Dual operation

There is **one authoritative write path plus a compatibility projection**, which
is the arrangement workstream 13 asks to prefer, and there is no dual write
anywhere in it:

- `listings.category_id` is authoritative; `listings.category_slugs` is the
  projection this domain re-derives.
- `categories.lifecycle` is authoritative; `categories.is_active` is the
  projection `taxonomyRepository` derives.

Divergence between the two halves of each pair is not prevented by a constraint
today, which is exactly why both are reconciliation probes rather than
assumptions.

### Rollback, per change

| Change | Rollback |
|---|---|
| The classification pass | Nothing to roll back — it writes nothing and has no `--apply`. |
| The reconciliation pass | Nothing to roll back — reads only, in every probe. |
| `category_slugs` re-derivation | Run it again. The value is a function of the authority, so there is no prior state to restore and no evidence destroyed. |
| A published product type or category alias that made a bucket resolve | The taxonomy and product-type domains' own lifecycle operations. Nothing in this domain wrote them. |

**Nothing in a rollback deletes catalog evidence**, and there is nothing here for
one to delete: the classification is derived, the repair is idempotent, and the
legacy option tables are retained verbatim by D13.

### What is never touched

Historical order, payment and refund snapshots. ADR 0007 D13 restates it because
a catalog migration is exactly the change that would be tempted to, and this
domain's isolation gate fails the build on any reference to `services/payments/`.

---

## Seams, each named rather than stubbed

- **The merged-category repoint** — deterministic, unwritten, and what it needs
  is stated above.
- **`listings.product_type_definition_id`** (ADR 0007 D13, the authoring
  workstream). When it lands, `mapping-matrix-census.test.ts` goes red naming it,
  and `product_type_key_published_and_eligible` is the set its backfill covers.
- **Brand attachment** — #53/#60 own it, `never_backfilled` here, and no class
  this domain produces may author one.
- **The option subjects** — #367 step 4 classifies and writes them; this domain
  quotes `countQueuedClaims` and the isolation gate refuses the resolver import.
- **Connector taxonomy mapping** — workstream 11's, and no table joins a
  `connections`-sourced listing to `category_external_mappings` today.
