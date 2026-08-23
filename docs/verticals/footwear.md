# The footwear reference vertical

`packages/backend/src/scripts/seed-verticals/footwear.ts` ·
`__tests__/verticals-footwear.realdb.test.ts`

Footwear exists in this epic for one reason: **a shoe's size is five different
facts wearing one word**, and a marketplace that collapses them sells somebody
the wrong shoe.

## What it seeds

4 categories · 10 attribute definitions (38 controlled values) · 1 product type
(13 fields across two flows) · 2 brands · 2 families · 3 products · 16 canonical
variants · 8 GTINs · 86 observed facts.

```
footwear                                (structural)
└── footwear.athletic                    (structural)
    ├── …mens_running_shoes              (selectable)   Trailwind 3, Fjord Runner
    └── …womens_running_shoes            (selectable)   Aurora Glide
```

## Sizes: what the architecture actually offers, and what it does not

**There is no size-system table in this repository, no audience column, no size
chart and no conversion table.** That is not an omission this package works
around — it is a decision the facet domain already enforces:
`FACET_FORBIDDEN_EQUIVALENCES` names `size_system_conversion` and
`size_system_merge` as prohibitions, and `facet-isolation.test.ts` fails the
build on any function shaped like one. `catalog_external_mappings` can record
that a source's token MEANS a size system, and such a mapping now RESOLVES —
against `services/canonical/size-systems.ts`, a code registry that IDENTIFIES a
convention by key and relates nothing to anything
(`docs/catalog-external-mappings.md` §"The size-system registry"). Its keys are a
namespace of their own (`size.shoe_eu`), disjoint from the attribute keys below,
and it holds no chart and no conversion. So there
is still no size-system table, no audience column and nothing that could relate
an EU 42 to a UK 8.

So the epic's "EU/US/UK/CM size systems with audience/department context" is
modelled with the three mechanisms that exist:

| The epic asks for | The mechanism |
|---|---|
| The size SYSTEM | The attribute KEY. `shoe_size_eu`, `shoe_size_us_mens`, `shoe_size_us_womens`, `shoe_size_uk` are four definitions, so `9` under one cannot be read as `9` under another. |
| The AUDIENCE / department | The CATEGORY SCOPE. `shoe_size_us_mens` is scoped to the men's node and `shoe_size_us_womens` to the women's, so a women's authoring schema and a women's facet list cannot OFFER a men's size. |
| The measurement BASIS | `shoe_size_cm`, a `length` measurement stored in mm, so `26.5 cm` and `265 mm` are one value and comparable across brands. |
| Filtering in the shopper's preferred system | Each system is its own facet over its own attribute; a filter names a key. |

### Brand size charts

The epic asks for "brand/product-specific size charts where supplied" and for
conversions "as sourced mappings/ranges with confidence, not universal exact
truth". There is no size-chart table. What there is says the same thing more
strongly: **each canonical variant records its own size in every system, as an
observation with provenance.** The chart is the set of facts that brand's
variants carry, and it is per-brand by construction rather than by policy.

The package makes that visible on purpose:

| EU 42 | US Men's | UK | Foot length |
|---|---|---|---|
| Kestrel Trailwind 3 | **9** | 8 | 265 mm |
| Nordvik Fjord Runner | **8.5** | 7.5 | 268 mm |

Both are true. A universal conversion table would have to be wrong about one of
them. Filtering the men's department on `shoe_size_us_mens = 9` narrows from two
products to one; filtering on `8.5` returns both. That is the positive form of
the epic's "prove EU 42, US Men's 9 and UK 8 are not collapsed".

**What is NOT modelled: confidence on a conversion.** There is nowhere to put
it, because there is no conversion — only facts. If a size-system domain is ever
built, its entry point is a per-brand mapping table and this package's variant
facts are the data it would be seeded from.

## Colour: three places, and each is a different fact

A measured property of `createVariant` shapes this, and the obvious fixture gets
it backwards: **the canonical-variant axis path does NOT resolve enum aliases.**
`normalizeOption` folds case and whitespace and stores the result; it never
consults `attribute_value_aliases`. An axis carrying `Jet Black` would store
`jet black`, and `Midnight` on another product would store `midnight` — two
colours where the catalogue has one, in the exact column a facet buckets.

| Where | Value | What it is |
|---|---|---|
| `canonical_variant_attributes` (the axis) | `black` | The buyable identity; what a filter matches |
| `canonical_attribute_values` | `source_display_value = 'Jet Black'`, `normalized_text = 'black'` | The observation, with the source's own words preserved |
| `footwear_colorway` | `Jet Black / Ember` | The marketing treatment. NOT filterable — an unbounded facet is a filter that does not work |

The facet response shows this directly: **one `black` bucket, carrying
`observedLabels: ['Jet Black', 'Midnight']`**. The colourway is reported in
`suppressed` with reason `not_filterable`.

## The sparse matrix

`Trailwind 3` declares three axes — EU size × colour × width. The full cross
product is 3 × 2 × 2 = 12 and the package seeds **8**.

The four absent combinations are chosen so that every individual axis VALUE
still appears somewhere: `41`, `black` and `wide` each exist on other variants,
so `41 / black / wide` is absent as a COMBINATION rather than absent because a
value is unknown. A sparse-matrix test that could not tell those apart would
pass against a fixture that simply forgot a colour.

The test's control inserts the missing combination inside a **rolled-back
transaction** and re-runs the same absence query, asserting the mutation landed
before asserting the detector fired — and re-reads outside the transaction to
show the catalogue is unchanged.

## Authoring, publication and the product page

The E2E case composes the real `AuthoringSchema` for the men's category
(10 merchant fields; the Spanish product-type name resolves to
`Calzado deportivo`), composes it again for the `p2p` flow (3 fields, with the
width `optional` rather than `recommended` — the only axis a flow may vary),
creates a draft, patches it with a variant, validates it, publishes it, and
asserts the listing's `native_listing_variant_axes` carry the three axes in
order with the CANONICAL values (`42`, `black`, `standard`) rather than the
labels a form displayed. The product page then renders all eight configurations.

## Acceptance scenarios

| Workstream 14 asks | Status |
|---|---|
| Seed category paths, product types, field groups, localized labels | Done |
| Model brand, product/model identity, merchant listing boundaries | Done |
| EU/US/UK/CM size systems with audience/department context | Done, as attribute keys + category scopes. No size-system entity exists |
| Width and brand size charts | Width is a variant axis. Charts are per-variant facts; there is no chart entity |
| Normalized colour family plus commercial colorway | Done, in three places |
| Multi-axis size/colour matrices | Done — three axes |
| Prove sparse/unavailable combinations | Done, with a rolled-back mutation control |
| Prove localized authoring, filters and PDP | Authoring, filters and PDP done. **Comparison is not covered** — the comparison surface is `services/comparison/`, which is not this workstream's |
