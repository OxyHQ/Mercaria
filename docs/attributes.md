# Category attributes, units and hard-constraint semantics (#94)

The reference for the versioned attribute registry, the normalized values it
types, and the constraint language deterministic search, grounded comparison
(#96) and natural-language interpretation (#95) all read from.

Schema decisions live in `packages/backend/src/db/schema/CONVENTIONS.md`
§"The versioned attribute registry (#94)". The canonical entities this layer
annotates are bound by ADR 0002 (`docs/adr/0002-canonical-commerce-graph.md`).

---

## What problem this solves

Product specifications arrive as prose. One feed writes `6.1 in`, another
`155.6 mm`, a third `Blazing fast 6.1-inch display`. A shopper asks for a laptop
with at least 16 GB of memory, 14 inches or smaller, USB-C, not refurbished,
under 900 € delivered.

Answering that deterministically needs three things, and #56's first cut of the
registry had none of them:

1. A definition that is **versioned**, so an evaluation can name the rules it
   ran under and a change of meaning does not silently reinterpret stored facts.
2. A value that records **which definition version and which normalization
   rules** produced it, keeps the source's own words, and can say why it could
   not be read.
3. A constraint vocabulary in which **a hard requirement and a preference are
   different types**, so nothing can quietly turn one into the other to produce
   more results.

## The registry

`attribute_definitions` holds one VERSION of one attribute's meaning.
`(key, version)` is the identity; the `key` is the stable machine name every
stored value cites and is never renamed (a rename is a new key plus a migration
of the values using it). Labels and descriptions are free to change at any time
and no stored value carries one — which is the whole of "stored keys remain
stable when labels change".

| Field | What it decides |
|---|---|
| `value_type` | `boolean \| integer \| decimal \| string \| enum \| date \| money \| measurement \| structured` |
| `cardinality` | `single \| set \| ordered_list \| range` |
| `objectivity` | Whether the attribute states a measurable fact or an opinion |
| `unit_family` + `base_unit` | The dimension a `measurement`/`structured` value normalizes into |
| `rating_scale_max` | 4.5 out of 5 is not 4.5 out of 10 |
| `currency` | A `money` attribute names exactly ONE currency |
| `component_axes` | The named axes of a `structured` value, in order |
| `min/max_value`, `decimal_places`, `max_length` | Validation and precision rules |
| `implausible_above/below` | The scale-error detector, deliberately NOT the same as min/max |
| `variant_defining`, `filterable`, `sortable`, `comparable`, `hard_constraint_capable` | What may be done with it |
| `display_policy`, `evidence_policy` | Whether values may be shown publicly, and what backing they need |
| `lifecycle_state` | `draft → active → deprecated → retired`, one active per key |

Enum values and their aliases are child tables (`attribute_enum_values`,
`attribute_value_aliases`), because an alias must resolve to exactly ONE
canonical value and that needs a row to point at. Localized labels are
`attribute_labels`. Category scope is `attribute_definition_categories`, with
`include_descendants` per scope row.

**The category scope is frozen with its version** —
`attribute_definition_categories_frozen`, added by `0136` for epic #367 line
143. It is the same guarantee `attribute_enum_values` and
`attribute_value_aliases` already had from `mercaria_attribute_enum_frozen`, and
it had been missing here since the table landed: with the parent `active`, an
INSERT of a new scope, an UPDATE of `include_descendants` and a DELETE of a
scope were all accepted, measured against a real server. That is the widening
ADR 0007 D2 calls "the one edit the immutability guarantee exists to refuse",
and it matters more here than for an enum value because `include_descendants`
IS the inheritance rule: flipping it silently changes which categories a
published definition applies under, and every value authored under it was
authored on the old answer. Changing what a live attribute covers is a NEW
version — `version-carry-forward.ts` copies the scopes into it — and never an
edit.

Which tables may say something category-specific about a versioned contract, and
which trigger freezes each, is declared in `src/db/categoryScopeFreeze.ts`; the
population is walked out of the drizzle schema by
`category-scope-freeze-census.test.ts` and every declaration is executed against
a real server by `category-scope-freeze.realdb.test.ts`.

### The lifecycle

- **`draft`** — editable.
- **`active`** — the meaning new observations are read under. Publishing
  deprecates the previous active version, enqueues a re-index for every entity
  carrying a value for the key, and freezes every semantic column by trigger.
  One active version per key is a partial unique index, so two concurrent
  publishes cannot both win.
- **`deprecated`** — stored values still resolve (they cite their version); new
  assignments are refused; a constraint on it validates with a warning.
- **`retired`** — no facet, no filter, no new value. A constraint on it is
  refused.

Nothing goes backwards. A retired attribute that turns out to be needed is a NEW
version, because "un-retire" would make the meaning of every value recorded
during the retirement ambiguous.

## Normalization

`services/attributes/normalization.service.ts` turns one source string into one
or more typed FACTS — several when the cardinality says so. **A refusal is a
first-class outcome**: there is no path that returns a magnitude the source did
not express.

| State | Means |
|---|---|
| `normalized` | Read, converted into the base unit, within bounds |
| `unparsed` | Not a value of the declared type at all, or a bare number with no recorded per-source unit |
| `unknown_unit` | A unit token the table does not know, or one from the wrong family |
| `out_of_range` | Well-formed, and outside the definition's declared bounds |
| `implausible` | In range and almost certainly a source SCALE error |
| `marketing_claim` | Promotional language on an `objective` attribute |

Only `normalized` may carry a normalized value, enforced by one CHECK covering
every typed column at once.

### Where a unit may come from

Exactly two places: the source's own token (`256GB`), or a recorded
`attribute_source_mappings.assumed_unit` — a human statement about the FEED
("this supplier's `weight` column is in grams"). Never from the attribute's base
unit, never from a sibling value, never from the magnitude's size. A bare number
with no mapping is `unparsed`, which is visible and fixable.

### The conversion table

`services/canonical/units.ts` — one table, shared with #56's variant signature.
Factors are exact RATIONALS, so `toBaseUnit`/`fromBaseUnit` multiply and divide
by the same two integers and the round trip is exact. Sixteen families:
`length, mass, volume, digital_storage, duration, power, energy, frequency,
data_rate, pixel_count, luminance, electric_charge, count` plus the three
DIMENSIONLESS ones — `percentage`, `ratio`, `rating`. Cross-family conversion is
refused, which is what makes percentages, ratios and ratings genuinely distinct
types rather than three bare numbers.

Ambiguous spellings are deliberately absent from the alias table (`mw`, `mwh`,
`mhz`, a bare `b`, every byte-per-second spelling). Their unambiguous forms
resolve; a genuinely ambiguous token becomes `unknown_unit`, which is a taxonomy
gap somebody can see rather than a wrong number nobody can.

### Precision

The STORED magnitude is always the full converted value. `source_decimals`
records how many decimal places the source itself carried, and comparison uses
the definition's `decimal_places` when it declares one, else the coarser of the
two sources' own counts. That is what lets `6.1 in`, `154.94 mm` and `15.494 cm`
compare EQUAL — they mean the same thing, and IEEE-754 equality would report a
conflict on the third.

### Structured values and ranges

A `structured` attribute declares its axes in order; `155.6 x 71.5 x 8.25 mm`
becomes three facts with `component_axis` height/width/depth. A reading with the
wrong number of components produces three `unparsed` facts rather than a guess:
`155.6 x 71.5` could be width×height or width×depth, and the two are different
products.

The axis vocabulary is TWO groups in one tuple: five that name the geometry of
an object (`width`, `height`, `depth`, `diagonal`, `circumference`) and five
that name a position on a body or garment (`waist`, `inseam`, `chest`, `sleeve`,
`neck`), so a 32×34 jean is one size with two named components rather than the
string `32x34` compared as text. A definition DECLARES its own axes, which is
why one tuple is safe — nothing can reach an axis its definition did not name.
The garment set is exactly the components of the compound size tokens merchants
write (waist × inseam, neck × sleeve, and chest for jackets); `hip`, `shoulder`,
`rise` and `outseam` are rows of a size CHART, each its own attribute, and are
deliberately absent. A bra (`34B`) or suit (`40R`) size is still not a
structured measurement: its components are not in one unit family, and a
`structured` definition pins one for all of them.

A `range` attribute keeps both bounds and their strictness. Prose ranges are
inclusive at both ends; an EXCLUSIVE bound arrives only through the structured
API, because inferring strictness from punctuation would be a guess. An inverted
interval (`30-7 d`) is refused rather than reordered.

## Selection, conflict and corroboration

`services/attributes/attribute-observation.service.ts` records what a source said
and decides what Mercaria shows:

1. Nothing else has been said: the fact is **selected**.
2. Another source said the SAME thing (at declared precision): recorded, the
   selection stands, and both become **corroborated**.
3. Another source said something DIFFERENT at comparable standing: neither is
   selected, both are **conflicting**, and a review is opened.

There is no confidence tie-break at equal standing, no "most recent wins" and no
source ranking. A strictly STRONGER source (or a deterministic/human one, whose
confidence is absent and outranks every number) replaces a weaker selection
without a conflict — filling absence and improving evidence are not the same act
as contradicting a peer.

A conflicting row KEEPS its normalized columns. An operator resolving it must be
able to see what they are choosing between.

## The constraint language

`@mercaria/shared-types` `./constraint`. One schema, three consumers.

```
ConstraintSet          AND across its members
├── AttributeConstraint    eq ne gt gte lt lte between in not_in exists missing is
├── TaxonomyConstraint     category | brand | product_family | merchant, in/not_in
├── CommerceConstraint     offer_price, known_total, availability, condition, market,
│                          official_channel, offer_channel, proximity  ← OFFERS ONLY
├── TextPreference         always `strength: 'preference'`
└── ConstraintGroup        "any of", LEAF members only, ≤8 wide, ≤4 per set
```

Every constraint carries a stable `id`, a `scope` (`product` | `variant`), a
one-line `explanation`, and — except a text preference — a `strength` and a
`missingDataPolicy`.

### Hard versus preference, made structural

Four mechanisms, not one convention:

1. `strength` is assigned at CONSTRUCTION and is a `readonly` literal. The
   evaluator takes no strength argument, so there is no parameter to pass the
   wrong value to.
2. Validation partitions a set into `HardConstraint[]` and
   `PreferenceConstraint[]` — genuinely different types. Moving a member between
   them is a compile error.
3. `TextPreference.strength` is the literal `'preference'` with no other
   inhabitant, and the request schema has no `strength` field at all. A hard
   text requirement has no wire representation and no type.
4. The verdict is DERIVED from the hard outcomes inside the evaluator and
   returned beside them, so two readers cannot disagree.

`services/attributes/__tests__/hard-constraint-isolation.test.ts` fails the build
if any of that stops being true, with a mutation self-test on each pattern.

### Three-valued outcomes

`satisfied | failed | unknown`. Missing data is `unknown` through the SAME code
path for both strengths — there is no branch where a preference's missing fact
becomes generous. A HARD constraint's `unknown` is then resolved by its NAMED
policy:

- `exclude_when_unknown` (default) — excluded, and the reason says so.
- `admit_and_report_unknown` — admitted, flagged `unknown`, and **never**
  reported satisfied.

An "any of" group is `unknown` when one member is unknown and none succeeded:
collapsing that to `failed` would exclude a product for a fact nobody recorded.

### Variant scope

A variant-scoped evaluation is handed ONE variant's facts, so a sibling's 1 TB
cannot satisfy this variant's storage requirement (#94 acceptance 4). A
product-scoped evaluation reports WHICH variants qualified rather than collapsing
them, so "some variant is 1 TB and some variant is black" can never read as "this
variant is a black 1 TB".

## The offer seam (#57)

`services/attributes/offer-facts.port.ts` is the ONE way a commercial fact
reaches an evaluation. #57 supplies one function, `factsForVariants`, batch-
shaped and returning a snapshot rather than a query builder — so "which offers
are eligible" has exactly one definition.

Until #57 registers a port, `unavailableOfferFacts` answers an empty map: every
commerce constraint is `unknown`, and a hard one with the default policy
EXCLUDES. Fail-closed, and nothing anywhere reports such a constraint satisfied.

The other half of the seam is the registry's refusal to define a key naming an
offer fact (`RESERVED_OFFER_FACT_KEYS`), so a feed cannot assert `price` as a
specification and have a price filter find it.

## Coverage, review and re-indexing

- **Coverage** is a live query, keyed off the REGISTRY rather than off existing
  values — an attribute nobody has recorded reports `observedCount: 0` against a
  real denominator, which is the most interesting cell in the report. Ordered by
  hard-constraint capability first, because a gap there costs a shopper results.
- **The review queue** takes conflicting values, implausible magnitudes, unknown
  units and marketing claims. `unparsed` and `out_of_range` deliberately open no
  review: an unreadable free-text field is the normal state of a messy feed and
  would flood the queue past the point anyone works it.
- **Re-index requests** are written on every selection change and on every
  definition publication/deprecation, with a deterministic id so a repeat
  converges. The CONSUMER is #61's; the record is written now.

## API

Public — `/catalog-attributes`, no auth, `listings` rate-limit scope:

| Route | Answers |
|---|---|
| `GET /definitions?categoryId=` / `?key=&version=` | Definitions by category, or one key's active/named version |
| `GET /facets?categoryId=` | Filter facets, derived from the same registry |
| `POST /constraints/validate` | Whether a set is answerable, with EVERY issue |
| `POST /constraints/evaluate` | One product or variant, with its explanation |
| `GET /values/:entityKind/:entityId[?unitSystem=][&market=]` | SELECTED values, no provenance, in the preferred display unit |

Operator — `/internal/catalog-attributes`, behind `CATALOG_OPERATOR_OXY_USER_IDS`
(empty ⇒ not mounted, 404):

| Route | Does |
|---|---|
| `POST /definitions` | Draft a NEW version |
| `POST /definitions/:key/versions/:version/{publish,deprecate,retire}` | Move the lifecycle |
| `GET /definitions/:key[/versions]` | The active version, or the full history |
| `POST /source-mappings` | Record how a feed's fields map |
| `POST /observations` | Record what a SOURCE said — never a canonical value |
| `GET /values/:entityKind/:entityId` | Every recorded fact, with provenance |
| `GET /reviews`, `POST /reviews/:id/resolve` | Work the conflicting-value queue |
| `GET /coverage` | Completeness by category and source |
| `GET /reindex-requests` | What is waiting |

Provenance never appears in a public DTO, and the explanation composes from the
evaluation alone — no source record, confidence, method or rule version. The one
deliberate exception is `sourceBacked`, which says a recorded fact was behind the
answer without saying which.

## Display units and size systems (#367 workstream 4)

#94 decided what a measurement MEANS and what it is stored in. Two questions it
left open have answers now, and both are pure code with no schema behind them.

### Which unit a shopper is SHOWN

`services/canonical/display-units.ts`. `GET /catalog-attributes/values/…`
composes `displayValue` in the unit the request prefers; with NEITHER parameter
the response is what it always was — the source feed's own words.

- **`unitSystem` (`metric | us | uk`) is the shopper's own preference**, which
  the storefront reads off the DEVICE's CLDR measurement system. `market` is the
  fallback for a client that has one and no stated preference, and it encodes
  CLDR's own supplemental override list — the United States, Liberia and Myanmar
  on US customary, the United Kingdom on imperial, everything else metric. A
  market it cannot read answers `null`, never `metric`: "nobody stated a
  preference" and "this shopper is metric" are different facts.
- **Nothing is derived from the reading LANGUAGE.** A shopper reading Spanish in
  Ohio is in a US-customary market, and taking the system off the language is
  the collapse ADR 0007 D4 forbids. There is no locale parameter on this route.
- **The override table is small, and its three ABSENCES are the load-bearing
  part.** UK volume has no override, because the `fl_oz` in the unit table is
  the US ounce (29.5735… ml) and the imperial one is 28.4130625 ml — mapping one
  onto the other prints a number four per cent wrong on every bottle. Digital
  storage, frequency and the three dimensionless families have no customary
  variant at all. And selection never reads the MAGNITUDE: one unit per (family,
  system), so a 900 g laptop and a 1.2 kg one stay comparable by eye.
- **Precision is significant DIGITS, not decimal places.** A declared
  `decimal_places` wins; otherwise a converted magnitude is printed to the
  digits the source actually knew, so `6.1 in` becomes `155 mm` and `155 mm`
  becomes `6.10 in`. A decimal-places rule gets the second direction wrong and
  silently drops a digit the source had.
- **An unknown stored unit REFUSES.** The route then serves the source's words;
  printing the magnitude beside a base unit would assert a dimension the row
  never claimed. Nothing on this path writes — `renderMeasurement` takes a
  magnitude and has no parameter through which it could reach a row.
- A PER-ATTRIBUTE display unit (a screen size in inches for every market) is the
  right next refinement and is deliberately not faked: it belongs on the
  definition, as a `display_unit` column, and arrives with that migration.

### What a size system IS

`@mercaria/shared-types` `size-system.ts`. A size system is still an ATTRIBUTE
DEFINITION — `shoe_size_eu` and `shoe_size_uk` are two keys with two facets and
two bucket sets — and what this adds is the four facts that were implicit in the
spelling of the key: **domain**, **region**, **audience** and **measurement
basis**, as four closed tuples.

- **There is now a SECOND key namespace, and it is disjoint from this one.**
  `catalog_external_mappings.target_size_system_key` is a different column with a
  different CHECK, so `services/canonical/size-systems.ts` mints keys for it
  (`size.shoe_eu`). The key there is OPAQUE and the four facets are required
  FIELDS on the entry — the `unit.gigabyte` shape, where the family is a column
  and not a key segment — which is what keeps `no_sourced_mapping` reachable.
  Nothing relates the two namespaces and a gate says so;
  `docs/catalog-external-mappings.md` §"The size-system registry" carries the
  reasoning and the cost.
- **`compareSizeDeclarations` is the only comparison over sizes, and it does not
  convert.** It answers `equal`, `different_value` (one system, two values) or
  `refused` naming the facet that differs. There is no return value in which
  "a UK 8 is an EU 42" could be expressed.
- **Each facet is independently load-bearing**, driven by one constructed pair
  per facet in `size-system-non-equivalence.test.ts` — the real-world pairs
  differ in two or three facets at once, so a test built only from them stays
  green when three of the four checks are dropped.
- **`unspecified` audience is not a department.** Two systems that both declined
  to say who they are cut for are refused, checked BEFORE equality.
- **The reason there is no conversion table is measured, not stylistic.** Two
  real footwear brands in the launch package put EU 42 at US 9 and at US 8.5, so
  a universal table would be wrong for one of them on every product. A
  cross-system statement is a fact about ONE product, recorded as that product's
  own attribute value with its own source and confidence.
- `SIZE_SYSTEM_FORBIDDEN_OPERATIONS` names the seven operations that may never
  exist, and the whole backend source tree is scanned for them.

### The one registry, gated

`unit-registry-authority.test.ts` holds three properties nothing held before: no
module outside `services/canonical/units.ts` carries a unit conversion constant
(measured at zero across the tree, so a future one is a second authority rather
than noise); every module naming a unit symbol imports it from that module; and
a SNAPSHOT of the unit keys, which is the only check that can see a key being
REMOVED — `normalized_unit` is plain text with no foreign key, so a rename
orphans every stored row that names it and a table walked against itself would
agree with the new table about anything.

## The benchmark dataset

`services/attributes/__tests__/fixtures/benchmark-catalog.ts` — the launch
categories (laptops, phones, headphones, PC components, cameras) with eighteen
definitions across every value type and cardinality, and thirty-odd labelled
observations covering mixed units, missing values, conflicting values,
variant-specific specifications, enum aliases, ranges, regional model
differences, source scale errors, hard and soft constraints, and invalid
category-attribute combinations. The whole table drives
`normalization.test.ts`, so a fixture added there is exercised without a code
change.

## What this issue deliberately did NOT build

- **The offer model (#57).** A port and a fail-closed default; no offer table,
  no import from a branch that has not merged.
- **Natural-language intent parsing (#95).** The constraint schema is the seam:
  #95 produces a `ConstraintSet` and gets the same validation and evaluation
  search does.
- **Grounded comparison and basket optimization (#96).** They read the same
  evaluation output.
- **Ranking (#74).** Nothing here scores a product for placement;
  `preferenceScore` is satisfied-over-total and is an input somebody else owns.
- **The manual correction workflow UI (#59).** The review queue and its resolve
  endpoint exist; the tooling around them does not.
- **A search index.** `attribute_reindex_requests` accumulates; #61 decides what
  drains it.
