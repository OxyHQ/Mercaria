# Reference vertical packages (#367 Workstream 14)

Three seeded catalogues — **footwear**, **smartphone**, **brake pad** — whose
job is to prove the universal catalogue architecture on the domains that break
naive ones. They are not demo data. Each exists because a specific modelling
mistake is tempting in that domain and expensive afterwards, and each is paired
with a real-database test that measures whether the architecture actually
prevents it.

| Package | The mistake it exists to prevent | Reference |
|---|---|---|
| Footwear | Collapsing five size systems into one `size` field | [`footwear.md`](./footwear.md) |
| Smartphone | Letting a spec-sheet fact become a variant axis | [`smartphone.md`](./smartphone.md) |
| Brake pad | Modelling fitment as variants — 400 SKUs for one part | [`brake-pad.md`](./brake-pad.md) |

## Running the seed

```bash
# Dry run — the default. Reads the database and reports what it would do.
bun run seed:verticals
bun run seed:verticals -- --package=footwear

# Write.
bun run seed:verticals -- --apply
bun run seed:verticals -- --apply --package=brake_pad --namespace=demo
```

Exit code `0` means every declared row is present and agrees; `1` means a step
diverged, or the census found the wrong number of rows, or it found none.

### It is a script, not a migration

A catalogue seeded by a migration is a policy nobody signed. A taxonomy, an
attribute vocabulary and a product type are commercial decisions, and a
migration applies them to every deployment with no author, no date and no way to
decline — the `EBAY_RECOMMENDED_CONDITION_RULES` precedent, one domain over. So
the package is a value in `packages/backend/src/scripts/seed-verticals/`,
`apply.ts` is the only thing that writes it, and an operator chooses to run it.

**No migration was needed for any of this**, which is the second finding: three
hard verticals fit the schema Workstreams 1–13 landed, with no DDL.

### The dry run READS the database

`--apply` is what writes. Without it every step still runs its existence query
and reports `create` or `present`. A dry run that only echoed the fixture would
print the same output against a database where half the package already exists
and against one where none of it does — which is the measurement failure this
whole workstream is written against.

### It is idempotent, and it never corrects

Insert-only, converging on each entity's natural unique key. A stored row that
DISAGREES with the package is reported as `divergent` and the process exits
non-zero; it is never overwritten. The seed's authority is to add what is
missing, and a silent correction is how a hand-applied fix comes back.

Both halves are tested against a real server —
`verticals-footwear.realdb.test.ts` and `verticals-brake-pad.realdb.test.ts`
each re-apply their package and assert `created === 0` with the census still
matching, and the footwear file additionally hand-edits a category inside a
rolled-back transaction and asserts the DRY run names exactly that row as
divergent.

**The idempotency case exists because the property was broken and nothing caught
it.** `recordCompatibilityClaim` APPENDS — correctly, since a claim is an
observation and `compatibility_claims` carries no unique key over its raw text —
so convergence is the SEED's job, and a second apply wrote two more claims until
the executor learned to probe first. It was found by running the CLI twice by
hand, which is exactly the discovery a test should have made.

There is no destructive mode, and that is not a switch left off: a reset would
have to delete attribute definitions that have left `draft` (which
`mercaria_attribute_definition_immutable` refuses) and canonical products a
matcher may already have cited. The honest reset is a new namespace.

## The measurement discipline

A seeded vertical is the easiest place in this epic to produce something that
**looks** like proof and is not. Four mechanisms answer that, and each is
itself controlled.

### 1. The census counts Postgres, not the run

`census.ts` counts fourteen entity kinds with `count(*)` scoped by namespace and
compares them against the numbers the package DECLARES —
which `verticals-package-controls.test.ts` in turn re-derives from the package
DATA, so a fixture edit that forgets to update an expectation fails the build
rather than lowering the bar. Counting the run's own report would only find what
the run already knew about; it could not notice a row the run failed to write,
because that row has no id to look up.

### 2. The vacuity floor is a separate verdict

`total === 0` answers `vacuous`, before any comparison. Fourteen zeros compared
against fourteen zeros is `0 === 0` fourteen times, which every per-entity
equality accepts — the exact `0 = 0 + 0 + 0` failure. It is a distinct verdict
from `mismatched` because "nothing ran" and "one table is short" lead an
operator to opposite actions.

### 3. Equality, never a floor

Every count is `expected === found`. A `>=` a later edit can satisfy by adding
rows anywhere is a floor that ends at `>= 0`. The tests assert the HIGH
direction too.

### 4. A positive control per entity kind

`CENSUS_POSITIVE_CONTROL_ENTITIES` names seven kinds a package must declare a
positive count for; a package declaring zero of one answers `unmeasurable`
rather than matching. The vehicle kinds are deliberately excluded — footwear and
smartphones legitimately hold no car, and demanding one would force a fixture to
invent it.

### And every scenario assertion has a mutation behind it

`verticals-package-controls.test.ts` reads no database and carries the controls
that cannot be driven from one: the vacuity floor over hand-built counts, the
sparse matrix noticing a seeded combination, and the brake-pad fixture reduced
to a single vehicle so the "many vehicles" assertion is shown to notice.

## What the packages deliberately do NOT create

No store, no listing, no offer, no draft. A reference vertical is a
CATALOGUE — taxonomy, attributes, a product type, canonical identity and, for
the brake pad, fitment. Merchant commerce state on top of it is what the E2E
tests drive, through the real authoring service, because "a merchant can publish
against this catalogue" is a behaviour and not a row.

## The namespace, and the one identity it cannot cover

Every key, slug and handle is prefixed. Production uses the package's own name;
a test run uses a random token, because category `key`/`slug`, attribute `key`,
product-type `(key, version)`, brand/family/product `slug` and vehicle-make
`key` are all unique over the whole database and vitest runs files in parallel
against one.

**A GTIN is the exception, and it was found by running the seed twice.**
`product_identifiers_canonical_active_key` is unique over the whole database
because a GTIN is unique over the whole world; a literal EAN in a package is
claimed by whichever namespace applied first and every later one is answered
`disputed` — correctly. So a package declares a per-package ORDINAL and never a
number, and `namespacedEan` derives one in the GS1 prefix `2`, the range
reserved for numbers that are not registered trade items. An MPN needs no such
treatment: it is unique only within a manufacturer, and each namespace mints its
own brands.

## Files

| Path | What it is |
|---|---|
| `scripts/seed-verticals/types.ts` | The package shape, as data |
| `scripts/seed-verticals/apply.ts` | The ONE writer, plus the namespace |
| `scripts/seed-verticals/census.ts` | The counts, the judgement and the vacuity floor |
| `scripts/seed-verticals/index.ts` | The CLI |
| `scripts/seed-verticals/{footwear,smartphone,brake-pad}.ts` | The three packages |
| `scripts/seed-verticals/__tests__/vertical-fixture.ts` | Seeding and teardown for a test run |
| `scripts/seed-verticals/__tests__/verticals-package-controls.test.ts` | The pure controls |
| `scripts/seed-verticals/__tests__/verticals-*.realdb.test.ts` | The three E2E suites |

## What the teardown cannot remove, and why

A test run leaves exactly three kinds of row behind, and all three are refusals
by the server rather than omissions:

- **Attribute definitions** — `mercaria_attribute_definition_immutable` refuses
  to DELETE a version that has left `draft`, and the seed must publish them
  (`applyAttributeObservation` resolves the ACTIVE definition; `createVariant`
  collapses measurement units only against one).
- **Product-type definitions** — `product_type_definitions_immutable_once_published`,
  for the same reason.
- **The categories those two cite**, whose scope rows point at them with
  `ON DELETE restrict`.

The categories are moved to `deprecated` instead, which
`isCategoryLifecycleActive` reads as inactive, so `findActiveCategories` — what
`GET /categories` and `feed.service` serve — never sees them again. The
definitions stay ACTIVE and SCOPED: deleting the scope rows is the obvious
tidy-up and is wrong, because `listActiveDefinitionsForCategory` includes
UNSCOPED definitions and thirty of them would appear in every sibling test's
category.

Measured after a full brake-pad run: everything else is zero, and zero of the
retained categories are active.

**Stores go through `deleteTestStores`, never a bare delete.**
`services/backfill/stages/store-merchants.ts` pages EVERY active store in the
shared database and writes a `native_store_links` row under its own merchant,
and that foreign key is `ON DELETE restrict` — so a store these fixtures own can
acquire a dependent they cannot know about. Measured: the first full-suite run
with these files failed `store-linkage.realdb.test.ts` in its teardown while the
same run without them was green.

## Two findings worth keeping

**Nothing here needed a migration.** Three deliberately hard verticals — five
size systems, a three-axis sparse matrix, thirteen vehicle configurations behind
one SKU — fit the schema Workstreams 1–13 landed with no DDL at all. That is the
strongest single statement this workstream can make about the architecture.

**The measured behaviours that shaped the fixtures**, each recorded where it
bites rather than worked around:

- `createVariant` does NOT resolve enum aliases; an axis must carry the
  canonical value or two commercial names become two colours.
- `mercaria_native_variant_axis_citation` is the FIRST wall against a vehicle
  key as an axis, not `native_listing_variant_axes_forbidden_key_check` — a row
  may only name the key its cited definition carries.
- `ResolvedAttributeDefinition.aliases` is keyed on the canonical VALUE plus the
  declared aliases and NEVER on the label, so observing `Engineered mesh` is
  `unparsed` while observing `Malla` resolves.
- A GTIN cannot be namespaced by a prefix; see above.
