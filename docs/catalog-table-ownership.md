# Catalog table ownership and migration conventions

> #367 Workstream 19. Which module owns which table, who may write it, and the
> protocol that keeps a shared drizzle journal usable while a dozen branches run
> in parallel. Binding: [ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md)
> D2, D5, D11, D13. Schema-level rules for the whole repository are
> `packages/backend/src/db/schema/CONVENTIONS.md`.

## The tables the epic added, and who owns them

One module owns a table. Owning it means: its repository issues the statements,
and another domain reads through that repository rather than reaching for the
drizzle handle. Where a wall is a scanned gate rather than a convention, the
gate is named.

**Owning it is the intent, and it is not everywhere true — four of these tables
are written from a second directory.** That is measured rather than asserted:
[`catalog-architecture-diagrams.md`](catalog-architecture-diagrams.md) §2 derives
every writer from the production source, names the four and cites the file each
statement sits in. Three are `db/catalogProposals/backfillRepository.ts` reaching
into the authoring and variant-axes tables; the fourth is #59's merge rehoming in
`services/curation/merge-conflicts.ts`, which repoints foreign keys by design.
The same section names the four tables **no** application code writes, which this
document's prose below already lists — the two lists were derived independently
and agree, which is the evidence that either can be trusted.

**The table below is GATED.**
`packages/backend/src/db/__tests__/catalog-table-ownership-census.test.ts`
derives the population from the migration SQL — every table created by a
migration at or after `0088`, the epic's first — and fails the build if one of
them is not named in a row here. A table that legitimately does not belong gets
a `NOT_IN_THE_MAP` entry with a reason; silence is not a disposition. The
boundary is anchored rather than asserted: `0088` is pinned to the tables it
actually creates, and every table this document names is checked to sit at or
above it unless it is one of the six pre-epic write-chokepoint subjects the
second table below is about. `0086` is the trap the anchor exists for — it
creates four `referral_pilot_*` tables and sits immediately under a long run of
catalogue migrations, so it reads as the start of the run to anyone who finds
the boundary by scrolling.

**There is deliberately no count in this heading any more, and the reason is
what happened to the last one.** It read *"the forty-seven tables the epic
added"*, and forty-seven was EXACTLY right: `0088`–`0102` create exactly 47
tables and this table listed all 47. It stopped being true on **2026-08-18**,
when `0112` added `product_type_aliases` and `product_type_field_localizations`,
and it went on being wrong through `0118`, `0120`, `0130` and `0133` — seven
tables, none of them here, the last of them (`product_variant_images`, #850)
landing on **2026-08-21**, the same day this was written. **Nothing could
notice**:
`git grep -l catalog-table-ownership -- packages/backend/src` returned nothing
at all, so the only thing checking this document was whoever happened to be
reading it. A figure in prose has no failure mode; the set does, and the set is
now what is enforced. If you want the number, the gate's vacuity floor carries
it and can only rise.

| Module | Schema file | Repositories | Tables |
|---|---|---|---|
| Taxonomy | `db/schema/taxonomy.ts` | `db/taxonomy/taxonomyRepository.ts` | `category_aliases`, `category_redirects`, `category_external_mappings` — plus `categories` itself, which lives in `db/schema/catalog.ts:128` and was widened in place (D2) |
| Classification | `db/schema/taxonomyClassification.ts` | `db/taxonomy/classificationRepository.ts` | `listing_secondary_categories`, `canonical_product_secondary_categories` — the JUSTIFIED secondary filings (#367 W1). There is deliberately no primary table: the primary category IS `listings.category_id` / `canonical_products.category_id`, so "exactly one" is held by a scalar column rather than by a partial unique on an `is_primary` flag |
| Product types | `db/schema/productTypes.ts` | `db/productTypes/productTypeRepository.ts`, `productTypeFieldRepository.ts` | `product_type_definitions`, `product_type_category_scopes`, `product_type_field_groups`, `product_type_fields`, `product_type_field_allowed_values`, `product_type_aliases` |
| Localization | `db/schema/catalogLocalization.ts` | `db/catalogLocalization/` (7) | `category_localizations`, `category_localized_slugs`, `product_type_localizations`, `product_type_field_localizations`, `attribute_value_localizations`, `listing_localizations`, `canonical_product_localizations`, `canonical_product_family_localizations`, `catalog_localization_revisions` |
| Variant axes and claims | `db/schema/variantAxes.ts` | `db/variantAxes/` (3) | `native_listing_variant_axes`, `native_variant_axis_assignments`, `native_variant_signatures`, `native_listing_attribute_claims`, `native_variant_attribute_claims` |
| Authoring | `db/schema/catalogAuthoring.ts` | `db/catalogAuthoring/` (4) | `catalog_authoring_drafts`, `catalog_authoring_draft_variants`, `catalog_authoring_draft_values`, `catalog_authoring_schema_invalidations` |
| Proposals | `db/schema/catalogProposals.ts` | `db/catalogProposals/` (3) | `catalog_proposals`, `catalog_proposal_duplicate_candidates`, `catalog_proposal_references`, `catalog_review_events` |
| Governance | `db/schema/catalogGovernance.ts` | `db/catalogGovernance/` (3) | `catalog_governance_change_requests`, `catalog_governance_impact_counts`, `catalog_governance_audit_events`, `catalog_governance_role_grants`, `catalog_governance_definition_snapshots` |
| Navigation | `db/schema/navigation.ts` | `db/navigation/` (2) | `navigation_saved_queries`, `navigation_saved_query_attribute_filters`, `navigation_trees`, `navigation_nodes`, `navigation_node_localizations` |
| Compatibility | `db/schema/compatibility.ts` | `db/compatibility/` (4) | `generic_compatibility_relations`, `vehicle_makes`, `vehicle_models`, `vehicle_generations`, `vehicle_configurations`, `automotive_fitments`, `compatibility_claims` |
| External mappings | `db/schema/catalogExternalMappings.ts` | `db/catalogExternalMappings/` (2) | `catalog_external_mappings`, `catalog_external_mapping_reviews`, `catalog_external_token_observations`, `catalog_external_mapping_runs`, `catalog_external_mapping_run_items` |
| Connector pins | `db/schema/connectorPins.ts` | — | `listing_pin_releases` |
| Native variant images | `db/schema/catalog.ts` | `db/catalog/variantRepository.ts` | `product_variant_images` |

Two tables in that list are owned by a module their NAME does not name, and both
were argued rather than assumed:

- **`product_type_category_scopes` is the product-type domain's, not the
  taxonomy's** (ADR D2). A published version is immutable and its category
  eligibility is part of what that version means; owned by taxonomy, the scope
  rows would sit outside the version's freeze, and the hole would be exactly
  where somebody widens a published version's scope.
- **`attribute_value_localizations` is the localization family's, not the
  attribute registry's** (D4), because the localization triggers — the machine
  write guard and the `stale` marker — are the family's and have to reach it.

The registry itself was **not** forked: `attribute_definitions` and its seven
siblings stay #94's, extended in place. There is one attribute registry
(`db/schema/attributeRegistry.ts`).

**Two rows are not #367's, and they are here anyway.** `listing_pin_releases`
came from #427 (`0099`) and `product_variant_images` from #850 (`0133`). A
reader arriving with the question "who owns this table" does not know which
issue number it landed under, so scoping the map to one issue would answer them
with silence — which is the failure this document just had. The census is
scoped by MIGRATION BOUNDARY for the same reason.

**`product_variant_images` lives in `db/schema/catalog.ts`, not in a schema file
of its own** — the `categories` situation one row up, and the reason a
census keyed on the epic's schema FILES would not have caught it. A table added
to a shared, pre-existing schema module is exactly the one a file-scoped
derivation misses, and it is also the one most likely to acquire a second
writer.

**Three of these tables have no application writer today**, which is a fact
about the map rather than a gap in it:

- **`product_type_aliases`** has neither a reader nor a writer.
  `db/__tests__/product-type-alias-seam.test.ts` (#732) is the gate that records
  why and states the prerequisite — a product-type member on `SearchFilters` —
  so the day one arrives, that test goes red rather than the table staying quiet.
- **`canonical_product_localizations`** and
  **`canonical_product_family_localizations`** are read by
  `services/catalog-localization/side-by-side.service.ts` and
  `db/catalogLocalization/completenessRepository.ts`, and the only thing that
  writes either is the `mercaria_canonical_products_localization_stale` trigger
  in `0120`. There is no insert path.
- **`catalog_localization_revisions`** is written ONLY by a trigger (`0118`) and
  is append-only against UPDATE and DELETE, which is why
  `db/catalogLocalization/revisionRepository.ts` reads it and never writes it.
  A repository that could write it would be a second author of a trail whose
  whole value is that it has one.

## Who may write, per subject

The invariant is "a merchant cannot silently create or mutate globally trusted
categories, brands, products, attributes or controlled values". It holds today
for all five, verified by call graph. It is **defended by a gate for two of
them**, and that difference is the thing to know before adding a route.

| Subject | Sole writer | Reachable over HTTP by | Add-direction gate |
|---|---|---|---|
| `categories` | `db/taxonomy/taxonomyRepository.ts` | `/internal/catalog-governance` only (operator allow-list) | **Yes** — `db/__tests__/taxonomy-write-chokepoint.test.ts:136` finds only the repository and its two named exceptions |
| controlled values (`attribute_enum_values`) | `db/attributes/definitionRepository.ts:322` | `/internal/catalog-attributes`, and proposal APPROVAL by an operator | **Yes** — `services/catalog-proposals/__tests__/catalog-proposal-isolation.test.ts:157` and `:172`, which also forbid the one writer from minting anything else |
| `attribute_definitions` | `db/attributes/definitionRepository.ts:51`, `:174` | `/internal/catalog-attributes`, governance apply | **No** — the operator mount is gated and tested, but no repo-wide writer census exists |
| `brands` | `db/canonical/brandRepository.ts` | nothing: `createBrand` has one caller, the vertical seed, reached only through governance `vertical_package_apply`; `updateBrand` has zero callers | **No** |
| `canonical_products` | `db/canonical/canonicalProductRepository.ts` | `/internal/canonical-catalog` (operator), plus #60's backfill writer behind `CANONICAL_WRITE_PUBLICATION_ENABLED` | **No** |
| `canonical_attribute_values` — the SELECTED fact | `db/canonical/attributeRepository.ts` (5 statements) | `/internal/canonical-catalog`, plus #59's operator correction, which flips `selection_state` between rows that already exist | **Yes** — `db/__tests__/canonical-attribute-value-chokepoint.test.ts` walks 1610 production modules and permits exactly three writers; `catalog-authoring-isolation.test.ts` names the table at the domain's own edge |

So: **a new store-permission-gated route that wrote `brands`, `canonical_products`
or `attribute_definitions` would land green.** The walls that exist
(`catalog-authoring-isolation.test.ts:225`, `catalog-governance-isolation.test.ts`,
`catalog-proposal-isolation.test.ts:157`) are scoped to their own directories, so
they defend the modules that exist and not a module somebody adds elsewhere.

The operator mounts themselves are gated, and the gate is tested in both
directions: `routes/__tests__/catalog-rollout.realdb.test.ts:398` asserts each
listed `/internal/*` catalog router is still MOUNTED with every rollout lever
off, and `:408` asserts each answers **404 when
`CATALOG_OPERATOR_OXY_USER_IDS` is empty**.

**Read that test's coverage before relying on it.** Its `INTERNAL` list
(`:281`) names **nine** surfaces and `:421` pins the length at nine, calling it
the vacuity floor. There are **26** `app.use` mounts inside a
`config.catalog.graphOperatorSurfaceEnabled` block in `app.ts` — the count is
`app.ts:286, 471, 519, 644, 724, 745, 749, 754, 755, 760, 765, 772, 782, 796,
810, 819, 823, 833, 844, 854, 865, 876, 886, 992, 1008, 1014`. So seventeen
surfaces are unasserted, and the floor cannot notice: it is computed from the
same hand list it guards, so deleting an entry leaves that surface unscanned and
the assertion still true. The number nine is also repeated as fact in ADR 0007
D12 (`:551`), `catalog-migration-operations.md` and
`runbooks/catalog-rollout-rollback.md`.

One gate-scope note worth carrying: a wall that scans for `.insert(`/`.update(`
against a table cannot see a repository CALL.
`services/catalog-governance/snapshot.service.ts:365` calls `insertCategory(...)`
— a real catalogue write inside a walled domain, invisible to that domain's own
wall and caught only by the taxonomy chokepoint census, which lists it as a
named exception.

## Migration conventions

The whole repository's rules are in `AGENTS.md` and
`docs/postgres-testing-and-migrations.md`. What follows is what #367 adds,
because a dozen branches sharing one journal is not the ordinary case.

### The slot is serial, and it is handed out by a person

ADR 0007 D11. `packages/backend/drizzle/meta/_journal.json` is one file. A branch
that needs DDL rebases on the current `origin/main` immediately before running
`bun run db:generate`, and its PR merges before the next branch generates.
Branches with no migration proceed in parallel freely.

Where the journal has got to is deliberately NOT written down here. It said
"idx 105 with 106 `.sql` files", written on **2026-08-17**; four days later
`0133` landed and it was **28 migrations** out of date. That is what a serial
slot handed out several times a day does to a number in prose, and the interval
is the point — this is not a figure that decays over a release cycle, it is one
that is wrong by the end of the week. Read it instead:

```
python3 -c "import json;j=json.load(open('packages/backend/drizzle/meta/_journal.json'));print(max(e['idx'] for e in j['entries']), len(j['entries']))"
```

### `bun run build:shared-types` before every `db:generate`

Every closed-value-set CHECK is rendered from the **built** `@mercaria/shared-types`.
A stale `dist/` emits `DROP CONSTRAINT … ADD CONSTRAINT` pairs that narrow a
sibling branch's tuple back, in a diff that looks entirely plausible. This has
cost this repository once already, on #61's rebase behind #107.

### Hand-written DDL, and the `.pending.sql` staging rule

drizzle-kit models no trigger, no function and no backfill, and **regeneration
drops every one of them.** So a domain whose invariants are held by triggers
stages them in `db/schema/<domain>.pending.sql` while it waits for the slot: a
plain-text file, not applied, with each block wrapped in
`-- oxy:handwritten-begin=<name>` / `-- oxy:handwritten-end=<name>` markers so
the paste into the generated `.sql` is mechanical rather than remembered.

**The two-copies rule (`CONVENTIONS.md` §"Preserve before you delete"): the
staging file is DELETED in the same commit that applies it** — "a second copy
that nothing applies is one somebody edits to no effect".

(That citation read `CONVENTIONS.md:669` until #831 and the rule had moved to
`:697` — cited by SECTION now, because a line number is a claim that expires on
somebody else's edit with nothing to notice it. The two line citations at the end
of this section were re-measured in the same pass and are correct.)

**None survives today, and the pattern is RETIRED.** One had outlived its
migration — `catalogExternalMappings.pending.sql`, whose own header still said
`NOT APPLIED` while all five trigger functions and all seven triggers had landed
in `packages/backend/drizzle/0094_dizzy_makkari.sql` (journal idx 94) — and #831
closed it, giving it the same close its three siblings had
(`catalogLocalization` → `0091`, `catalogProposals` → `0100`, `catalogGovernance`
→ `0102`; `variantAxes` likewise). **So a `<domain>.pending.sql` appearing in the
tree now means a slot is genuinely pending**, which is what the convention was
always supposed to signal and could not while a stale one sat beside it.

Two things made that survival invisible, and both are worth carrying:

- **The stale copy was CORRECT.** Its statement region was byte-identical to
  `0094`'s — 206 lines, 9885 bytes, and the five function bodies matched
  `pg_proc` on a database migrated through the whole chain. So nothing it said
  about SQL was wrong; what was wrong was the tense. A diff-based check finds
  nothing here, because there is nothing to diff.
- **The gate READ the stale copy.**
  `services/catalog-external-mappings/__tests__/external-mapping-schema.test.ts`
  asserted the triggers against the staging file rather than the migration, so it
  kept the file alive rather than catching it — and the most valuable check in it
  (the freeze trigger's frozen-column list, asserted against the real table) was
  measuring a copy that nothing applies. It now locates the statements by CONTENT
  across the whole chain and refuses anything but exactly one file, which also
  catches a later `CREATE OR REPLACE` moving a body under an unchanged name.

**No gate flags a surviving `.pending.sql`**, which is why that one outlived the
migration it was staging, and that is still true — the retirement is a fact about
the tree today, not an enforced invariant.
`packages/backend/src/db/__tests__/migration-handwritten-markers.test.ts:565` is
the gate over the marker discipline — exactly one deploy-phase marker per file,
read by the same `readMigrationPhases` the migrator uses, with a vacuity floor at
`:570` — and it says nothing about staging files.

### Exactly one deploy-phase marker per file

`-- oxy:deploy-phase=pre` for additive work, `=post` for drops, renames and
narrowings, and **every `post` statement must break a write the previous image
performs.** There is no default. A two-phase change is two generated files, never
one split by hand.

The epic's window is `0088` onward, and it is no longer a list. It was one —
*"thirteen migrations: `0088`, `0089`, `0090`, `0091`, `0093`, `0094`, `0097`,
`0098`, `0100`, `0102`, `0103`, `0104`, `0105`, twelve of them `pre`"* — and the
list was wrong in a way that is worth reading, because it is the same failure as
the table above and it was already there when it was written: **it omitted
`0099`**, whose one table (`listing_pin_releases`) this very document owns. A
hand list that contradicts the hand table two screens above it is what happens
when nothing reads either. Re-derive both:

```
grep -c '^-- oxy:deploy-phase=post' packages/backend/drizzle/*.sql | grep -v ':0'
```

What is worth stating rather than counting: **every migration in this window
that CREATES a table is `pre`** — sixteen of them, `0088` through `0133` — so no
table in the map above arrived behind a narrowing statement. The `post` files in
the window narrow behaviour on tables that already existed, and the one to know
is still `0104_axis_assignment_cites_a_resolved_claim.sql`, which
`CREATE OR REPLACE`s `mercaria_native_variant_axis_assignment_scope` to add a
refusal that breaks a write the previous image performs. **`0104` is behind no
lever** — the variant-axes domain reads no configuration at all — so "turn every
flag off" does not reverse it. The blast radius is bounded, because the narrowed
write path is an operator backfill script
(`src/scripts/backfill-variant-axes.ts:92`) rather than a request path.

### After a rebase, re-derive every count

Three things conflict on essentially every #367 rebase and none of them can be
resolved by taking a side:

- **`SCHEMA_TABLE_COUNT`** in `db/__tests__/schema-conventions.test.ts` is main's
  count plus your net delta, so neither side of the conflict is right. Count it
  empirically from the barrel's `PgTable` exports on the rebased branch. Its
  value is not repeated here — the constant is asserted by equality in both
  directions, so it is already gated, and a copy of a gated number in prose is a
  second representation that can only ever disagree with it. (It read **445**
  here and the constant is now 452.)
- **Every isolation gate's population floor**, for the same reason: two branches
  raising one guard's floor on different lines merge cleanly and git keeps one.
- **The journal's index set must equal the set of `meta/*_snapshot.json` files**
  before you push. A rebase can stage the deletion of an upstream snapshot, which
  breaks the *next* generator rather than you, and a green suite never sees it —
  the migrator reads the `.sql` files and never looks at a snapshot.

### One trap that is specific to this schema

A `BEFORE UPDATE` trigger must not compare a STORED GENERATED column: it is
computed *after* the trigger, so `NEW.<col>` is NULL and the comparison raises on
every update. `native_listing_attribute_claims` carries two generated lookup keys
(`raw_name_normalized`, `raw_value_key`, `db/schema/variantAxes.ts:592`, `:600`),
so this is live schema rather than a historical note. It cost a real bug in the
curation domain and was caught only by the realdb suite.

## What a rollback can and cannot reach

Four levers, each gating a MOUNT and none gating a stored row:

| Lever | Mount |
|---|---|
| `CATALOG_TAXONOMY_V2_ENABLED` | `/navigation` |
| `CATALOG_AUTHORING_ENABLED` | `/catalog-authoring` and `/stores/:storeId/product-drafts` (`app.ts:258`–`:260`) |
| `CATALOG_PROPOSALS_ENABLED` | `/catalog-proposals` (`app.ts:275`) |
| `FACETS_ENABLED` | `POST /facets` (`app.ts:738`) |

`catalog-rollout.realdb.test.ts:309` pins the withdrawal at **exactly five
mounts and nothing else**, which is the assertion to read rather than the count
of levers: `CATALOG_AUTHORING_ENABLED` gates two.

ADR 0007 D12 says each lever "is read in exactly one place — the `app.use` that
mounts its router". Measured over the config PROPERTY rather than the env string,
there are **six** non-test reads: four mounts, plus
`services/catalog-observability/metrics.service.ts:745` and `:746`, which decide
whether a metric reports `surface_not_mounted`. D12's substantive claim survives
— no repository, outbox enqueue, loop or checkout path reads a lever — but the
count in it does not, and `runbooks/catalog-rollout-rollback.md:109` already
states the correct six.

Two levers ADR 0007 D12 originally named do not exist — `PRODUCT_TYPES_ENABLED`
(deliberately not built) and `CATALOG_LOCALIZATION_ENABLED` (unnecessary while
localized reads stay transitively contained). The third, `CATALOG_AUTHORING_COHORTS`,
was built as **`CATALOG_ROLLOUT_COHORTS`** — renamed because it narrows all four
levers' surfaces rather than authoring alone — so the ADR's staged rollout order
is executable; see
[`catalog-rollout-cohorts.md`](catalog-rollout-cohorts.md). It owns no table.
D12 is corrected in place and states each reason; the operational detail is
[`catalog-migration-operations.md`](catalog-migration-operations.md) and
[`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md).

**Turning every lever off leaves every row readable — conditionally.** The nine
`/internal/*` catalog surfaces are gated on `CATALOG_OPERATOR_OXY_USER_IDS`
being non-empty, and an empty list answers 404. The evidence has to be readable
during the incident that turned the levers off, so that list is part of the
rollback plan and not an afterthought.
