# The smartphone reference vertical

`packages/backend/src/scripts/seed-verticals/smartphone.ts` ·
`__tests__/verticals-smartphone.realdb.test.ts`

Smartphones exist in this epic to draw one line: **which of a product's thirty
published properties are things a buyer chooses between, and which are facts
about the model.** A catalogue that lets a merchant declare "chipset" an option
produces one variant per spec-sheet line and a variant selector nobody can use.

## What it seeds

3 categories · 13 attribute definitions (18 controlled values) · 1 product type
(16 fields across two flows) · 2 brands · 2 families · 2 products · 12 canonical
variants · 12 identifiers · 24 observed fact rows.

```
electronics                              (structural)
└── electronics.phones                    (structural)
    └── …phones.smartphones               (selectable)   Axon 9 Pro, Vero 5
```

`Lumira` (brand) → `Axon` (family) → `Axon 9 Pro` (product) →
`256 GB / Black / EU` (variant). Four levels, four real foreign keys.

## Three axes, ten facts

| Axis | Type | Why it is variation |
|---|---|---|
| `storage_capacity` | `measurement`, digital storage | A buyer chooses 256 or 512 |
| `phone_color` | `enum` | A buyer chooses |
| `device_region` | `enum` | The EU and US models carry different cellular bands and are not interchangeable. A market a product is merely SOLD in belongs to the offer |

| Fact | Type |
|---|---|
| `screen_size` | measurement, length |
| `screen_refresh_rate` | measurement, frequency |
| `chipset` | enum |
| `ram_capacity` | measurement, digital storage |
| `battery_capacity` | measurement, electric charge |
| `charging_port` | enum |
| `device_dimensions` | **structured**, `[height, width, depth]` |
| `cellular_generation` | enum |
| `wifi_standard` | enum |
| `nfc` | boolean |

### Connectivity is three facts, not one bag

The epic names connectivity among the typed facts, and the tempting shape is a
`set`-cardinality enum holding `{5g, wifi_6e, nfc}`. It is refused here: those
are three questions with three different answer types, and a bag cannot be
filtered, compared or constrained on any one of them. Three definitions is more
rows and strictly more answerable.

### `device_dimensions` is ONE declaration and THREE rows

A structured value writes one `canonical_attribute_values` row per declared
component axis, each with its own `component_axis` and `position`, and the
trailing unit applies to every component that has none of its own. The census
counts it that way — `deriveExpectation` resolves each fact's attribute and adds
`componentAxes.length` for a structured one — so a package that seeded correctly
does not report a mismatch.

## What stops a fact becoming an axis, and the ORDER it stops it in

Four walls, and the test drives them in the order the database applies them.

1. **`assessVariantAxis`** (pure) refuses `variantCapable` at a non-`variant`
   scope, and refuses every key in `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`.
2. **`mercaria_native_variant_axis_citation`** refuses an axis citing a
   definition whose `variant_defining` is not true — which is the default. The
   test drives this against `chipset` and drives the CONTROL (the same statement
   with `phone_color`) to show the refusal is about the flag.
3. **`native_listing_variant_axes_forbidden_key_check`** and
   **`product_type_fields_variant_axis_check`**, rendered from one tuple.

**Measured, and recorded rather than worked around: the CITATION trigger is the
first wall, not the CHECK.** A row may only name the key its cited definition
carries, so `vehicle_make` is refused before the CHECK is evaluated — and
reaching the CHECK would need a definition literally named `vehicle_make`, which
is the thing nobody should create. The test asserts the trigger's refusal by
message, and asserts the CHECKs exist and name the forbidden keys by reading
`pg_get_constraintdef` out of `pg_constraint`, with a vacuity floor on the
constraint count. A case that claimed to drive the CHECK here would be
describing a wall that nothing reaches first.

## The measurement axis collapses two spellings

Kaido's storage is spelled `256GB` and Lumira's `256 GB`. Both store
`256000000000B` — the family's base unit — with no mapping table between them.
That is the `Color`/`Colour`/`color ` duplication this epic exists to end, in
the place a merchant is most likely to introduce it, and it is why storage is a
`measurement` rather than an enum.

## Direct linking

The E2E case selects an existing canonical product AND an existing canonical
variant on the draft, publishes, and asserts the resulting
`native_listing_links` row:

```
method       = merchant_declared
match_rule   = authoring.merchant_declared
confidence   = NULL
status       = active
```

`NULL` and not zero: `native_listing_links_confidence_check` admits a number
only for the `matcher` method, so a merchant's own declaration cannot be scored
as if a heuristic produced it. Both halves are needed — the product selection
says which model, the variant selection says which exact buyable thing.

## A genuinely new model, through the proposal flow

`submitProposal({ type: 'canonical_product', … })` records the request with a
duplicate scan (the test asserts the scan's POPULATION is positive — a scan over
an empty catalogue reports no duplicates for a reason that is not about the
label).

**Approval does not mint a canonical product.** `mintForProposal` refuses every
link-only type by name; the only entity an approval creates is a controlled
value. The operator creates the product on the canonical surface and RESOLVES
the proposal onto it with `mergeProposalIntoExisting`, from a DIFFERENT Oxy id —
`catalog_proposals_decider_distinct_check` refuses the same one, so nobody
approves their own request. A second decision on the resolved proposal is
refused. That is the shape that keeps a merchant request from becoming globally
trusted data by itself.

## Localized search aliases

`mobile`, `móvil` and `celular` reach the product, and they do so through two
mechanisms read by DIFFERENT retrieval stages against DIFFERENTLY FOLDED
queries:

| Mechanism | Query folding | Stored as |
|---|---|---|
| `canonical_product_aliases` | trim + lowercase, **no accent folding**; whole-query match | `móvil Lumira Axon 9 Pro` — WITH the accent |
| `canonical_products.search_tokens` | `normalizeEntityName`, which DOES fold accents | `movil` — accent-FOLDED, ≥5 characters |

**The test asserts the `exact_alias` STAGE, not the result count**, and removes
the alias row inside a rolled-back transaction to show the stage disappears. A
count would not move: the token stage matches the same product for the same
query, so a fixture whose alias never worked would report the same number. The
control asserts the row was actually deleted before asserting the stage was
lost, and re-reads afterwards to show it is back.

`category_aliases` carries the regional vocabulary too, and since #732 it is
**read by the deterministic search-intent interpreter** — see
`docs/taxonomy.md` §"Who reads them". This package is where epic #367's
"support aliases `mobile`, `móvil`, `celular`, `smartphone`" actually holds:
all four are seeded here, in the singular as well as the plural, because the
match is on a whole word and the plural does not cover the singular.

They are here rather than in `CATEGORY_COLLOQUIALISMS` for two reasons. That
dictionary's stated population is "the words no product name contains", and
`smartphone` is in half the product names in this package and IS the category's
slug. And a colloquialism entry names a SLUG, which is a per-deployment fact:
recording the word beside the category that creates the slug means the two are
written in one place and cannot disagree.

`services/search-intent/benchmark/registry.ts` mirrors these rows so the
labelled dataset can measure them with no database, and `benchmark.test.ts`
fails the build if the two stop agreeing — with one deliberate exception it
names, `handset`, which is fixture-only precisely so one benchmark case can
pass through nothing but an operator-authored row.

## Same-variant filter semantics

512 GB exists only on the Axon and `white` only on the Vero. Each half of the
filter matches one product ALONE; the conjunction matches **zero**, because no
single canonical variant carries both. A conjunction that IS satisfiable
(512 GB + black) still matches one — so the zero is about that conjunction and
not about conjunctions.

## Acceptance scenarios

| Workstream 14 asks | Status |
|---|---|
| Seed category paths, `smartphone` product type, localized schema | Done |
| Model brand → family → product → variant | Done, four foreign keys |
| Storage, commercial colour and region as actual variant axes | Done |
| Screen, chipset, RAM, battery, ports, dimensions, connectivity as typed facts | Done |
| Select an existing canonical product and publish through direct linking | Done — `merchant_declared`, NULL confidence |
| Create a genuinely new model through proposal/review | Done — submit, mint, merge, and a re-decision refused |
| Prove localized search aliases | Done, with alias-removal as the control |
| Prove filters and same-variant constraint semantics | Done |
