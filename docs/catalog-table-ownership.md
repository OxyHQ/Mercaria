# Catalog table ownership and migration conventions

> #367 Workstream 19. Which module owns which table, who may write it, and the
> protocol that keeps a shared drizzle journal usable while a dozen branches run
> in parallel. Binding: [ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md)
> D2, D5, D11, D13. Schema-level rules for the whole repository are
> `packages/backend/src/db/schema/CONVENTIONS.md`.

## The forty-seven tables the epic added, and who owns them

One module owns a table. Owning it means: its repository issues the statements,
and another domain reads through that repository rather than reaching for the
drizzle handle. Where a wall is a scanned gate rather than a convention, the
gate is named.

| Module | Schema file | Repositories | Tables |
|---|---|---|---|
| Taxonomy | `db/schema/taxonomy.ts` | `db/taxonomy/taxonomyRepository.ts` | `category_aliases`, `category_redirects`, `category_external_mappings` — plus `categories` itself, which lives in `db/schema/catalog.ts:128` and was widened in place (D2) |
| Product types | `db/schema/productTypes.ts` | `db/productTypes/productTypeRepository.ts`, `productTypeFieldRepository.ts` | `product_type_definitions`, `product_type_category_scopes`, `product_type_field_groups`, `product_type_fields` |
| Localization | `db/schema/catalogLocalization.ts` | `db/catalogLocalization/` (3) | `category_localizations`, `category_localized_slugs`, `product_type_localizations`, `attribute_value_localizations` |
| Variant axes and claims | `db/schema/variantAxes.ts` | `db/variantAxes/` (3) | `native_listing_variant_axes`, `native_variant_axis_assignments`, `native_variant_signatures`, `native_listing_attribute_claims`, `native_variant_attribute_claims` |
| Authoring | `db/schema/catalogAuthoring.ts` | `db/catalogAuthoring/` (4) | `catalog_authoring_drafts`, `catalog_authoring_draft_variants`, `catalog_authoring_draft_values`, `catalog_authoring_schema_invalidations` |
| Proposals | `db/schema/catalogProposals.ts` | `db/catalogProposals/` (3) | `catalog_proposals`, `catalog_proposal_duplicate_candidates`, `catalog_proposal_references`, `catalog_review_events` |
| Governance | `db/schema/catalogGovernance.ts` | `db/catalogGovernance/` (3) | `catalog_governance_change_requests`, `_impact_counts`, `_audit_events`, `_role_grants`, `_definition_snapshots` |
| Navigation | `db/schema/navigation.ts` | `db/navigation/` (2) | `navigation_saved_queries`, `navigation_saved_query_attribute_filters`, `navigation_trees`, `navigation_nodes`, `navigation_node_localizations` |
| Compatibility | `db/schema/compatibility.ts` | `db/compatibility/` (4) | `generic_compatibility_relations`, `vehicle_makes`, `vehicle_models`, `vehicle_generations`, `vehicle_configurations`, `automotive_fitments`, `compatibility_claims` |
| External mappings | `db/schema/catalogExternalMappings.ts` | `db/catalogExternalMappings/` (2) | `catalog_external_mappings`, `_reviews`, `catalog_external_token_observations`, `_runs`, `_run_items` |
| Connector pins | `db/schema/connectorPins.ts` | — | `listing_pin_releases` |

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

So: **a new store-permission-gated route that wrote `brands`, `canonical_products`
or `attribute_definitions` would land green.** The walls that exist
(`catalog-authoring-isolation.test.ts:225`, `catalog-governance-isolation.test.ts`,
`catalog-proposal-isolation.test.ts:157`) are scoped to their own directories, so
they defend the modules that exist and not a module somebody adds elsewhere.

The operator mounts themselves are gated and the gate is tested in both
directions: `routes/__tests__/catalog-rollout.realdb.test.ts:398` asserts each of
the **nine** `/internal/*` catalog routers is still MOUNTED with every rollout
lever off, `:408` asserts each answers **404 when `CATALOG_OPERATOR_OXY_USER_IDS`
is empty**, and `:421` pins the router count at nine — the vacuity floor, so the
loop above it cannot shrink to nothing and stay green.

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
Branches with no migration proceed in parallel freely. The journal is at
**idx 105** with **106** `.sql` files as of this document.

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

**The two-copies rule (`CONVENTIONS.md:669`): the staging file is DELETED in the
same commit that applies it.** A surviving `.pending.sql` therefore means its DDL
is *not in the database*, which is a fact about production and not a tidiness
issue.

One survives today:
`packages/backend/src/db/schema/catalogExternalMappings.pending.sql` — five
trigger functions and seven triggers for the external-mapping domain, additive,
waiting for a slot. Read it as unenforced until it is gone.

`packages/backend/src/db/__tests__/migration-handwritten-markers.test.ts` is the
gate over the marker discipline.

### Exactly one deploy-phase marker per file

`-- oxy:deploy-phase=pre` for additive work, `=post` for drops, renames and
narrowings, and **every `post` statement must break a write the previous image
performs.** There is no default. A two-phase change is two generated files, never
one split by hand.

### After a rebase, re-derive every count

Three things conflict on essentially every #367 rebase and none of them can be
resolved by taking a side:

- **`SCHEMA_TABLE_COUNT`** in `db/__tests__/schema-conventions.test.ts` is main's
  count plus your net delta, so neither side of the conflict is right. Count it
  empirically from the barrel's `PgTable` exports on the rebased branch. It is
  **445** at the time of writing, asserted by equality in both directions.
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

Three levers ADR 0007 D12 originally named do not exist — `PRODUCT_TYPES_ENABLED`
(deliberately not built), `CATALOG_LOCALIZATION_ENABLED` (unnecessary while
localized reads stay transitively contained) and `CATALOG_AUTHORING_COHORTS` (not
built, which is why the ADR's staged rollout order is not executable as written).
D12 is corrected in place and states each reason; the operational detail is
[`catalog-migration-operations.md`](catalog-migration-operations.md) and
[`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md).

**Turning every lever off leaves every row readable — conditionally.** The nine
`/internal/*` catalog surfaces are gated on `CATALOG_OPERATOR_OXY_USER_IDS`
being non-empty, and an empty list answers 404. The evidence has to be readable
during the incident that turned the levers off, so that list is part of the
rollback plan and not an afterthought.
