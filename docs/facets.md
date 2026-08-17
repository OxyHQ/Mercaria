# Facets, filters and the same-variant / same-offer semantics (#367 Workstream 10)

`services/facets/` (9 modules) + `db/facets/` (2 repositories) +
`POST /facets` + `@mercaria/shared-types` `facets.ts`. **No new tables and no
migration** — the whole domain is a projection, the #92 / #73 shape taken for
the #61 reason: this graph was measured at a million offers and adopted no
materialized view, so a facet rail is composed at request time from aggregates
over indexes that already exist.

Binding decisions: ADR 0007 D1 (identity), D2 (taxonomy), D4 (localization),
D5 (product types), D14 (JSONB). It CONSUMES #94's registry, ADR 0007 D5's
product types, ADR 0007 D2's taxonomy, #57's offers, #68's freshness and #90's
condition segments, and decides nothing any of them already decides.

---

## The two semantics, which are the whole point

A filter set is **not** a bag of independent predicates over a product.

### Same-variant

> Every variant-level requirement must be satisfiable by **one** variant.

A product with a red 41 and a black 43 must not answer "red **and** 43". Every
predicate is individually true; the result is a **false match**; the page renders
perfectly; the shopper finds out at the size chart.

### Same-offer

> Every offer-level requirement must be satisfiable by **one** offer.

A price from the cheapest seller and availability from a different one is the
same failure a layer down, and it is the one a shopper discovers at checkout.

### How they are held — on THIS rail, and the scope is load-bearing

> **Read this before quoting either guarantee elsewhere.** Everything below is
> true of the **facet rail** (`POST /facets`). It is **not** true of the two rails
> a shopper's result LIST comes from: canonical search
> (`services/search/canonical-search.service.ts:487`, which loops one statement
> per variant constraint) and category browse
> (`services/catalog-pages/product-browse.service.ts:205`, which intersects
> PRODUCT id sets one constraint at a time). Neither correlates to a single
> variant: the candidate reader resolves a match through
> `coalesce(v.product_id, cv.product_id)`
> (`db/search/searchCandidateRepository.ts:1011`, `:1015`). That is
> [#567](https://github.com/OxyHQ/Mercaria/issues/567), and the sharp edge is that
> the correlated rail produces the **count** while an uncorrelated rail produces
> the **list** — so a page can render `matchedProductCount: 1` above a result set
> containing the crossed product.
>
> So the epic-level invariant *"filters and constraints are variant-aware"* is
> **unmet** today, on the ordinary filtered-search path and behind no flag. This
> document previously stated the guarantee without that qualification, which is
> how a domain-scoped truth gets read as a system-wide one. Same-OFFER is
> genuinely held on both rails (see the fixed observation at the end of this file).

`buildEntityPredicate` in `db/facets/facetRepository.ts` is the **only** place a
selection becomes SQL, and it takes the variant and offer requirement sets
**together**:

```
exists (variant cv of p, active
         … every VARIANT requirement, against THIS cv
         … exists (offer o on cv, active and fresh
                    … every OFFER requirement, against THIS o))
```

The offer claim is never a *sibling* of the variant claim. There is no function
in the repository that accepts one variant requirement on its own, so the shape
that produces the bug has no way to be spelled.

Both are tested twice, and the two tests catch different regressions:

- **Structurally**, in `same-variant-same-offer.test.ts`, which renders the
  fragment with `PgDialect().sqlToQuery` and counts the existence claims. A
  behavioural test can pass on a wrong statement that happens to be right for the
  fixture — with one variant per product the correct and incorrect statements
  agree exactly.
- **Behaviourally**, in `facets.realdb.test.ts`, against a real server, with a
  fixture built for the false match (a `crossed` product whose axes are
  deliberately mismatched) — **and a mutation case that writes the naive
  per-requirement predicate out and asserts it returns 2**. Without that, "returns
  1" would pass just as well against a predicate that had stopped matching
  anything.

---

## Facets are GENERATED from metadata; there is no filter list anywhere

`services/facets/metadata.ts` is pure and takes only rows somebody published:

| Decision | Source |
| --- | --- |
| Is it offered at all? | `attribute_definitions.filterable` (#94) |
| At which grain does its requirement bind? | `product_type_fields.scope` / `variant_capable`, else `attribute_definitions.variant_defining` |
| What shape are its answers? | `attribute_definitions.value_type` |
| May it be a hard requirement? | `attribute_definitions.hard_constraint_capable` |
| May it sort? | `attribute_definitions.sortable` |
| Where does it sit in the rail? | `product_type_field_groups.position`, then `product_type_fields.position` — **versioned with the product type** |
| What order do its answers come in? | `attribute_enum_values.position`, or a shipped vocabulary tuple |
| What is it called? | `attribute_labels`, `attribute_value_localizations`, `category_localizations` |

`facet-isolation.test.ts` fails the build on a category-keyed filter map or a
`filtersForCategory`-shaped function, **in either package** — the storefront is
scanned too, because it has no test runner of its own and a frontend constant is
where a hard-coded rail comes back (#92's precedent). Each scanned set carries
its **own** vacuity floor: one total floor stays satisfied while half the walk
finds nothing, which is exactly how a cross-package scan goes quietly vacuous.

### An attribute the product type does not mention is still a facet

The registry scoped it to this category deliberately, and every deployment today
has no published product type — so the alternative is a rail with nothing in it.
It is offered, and sorts **after** everything the type did name
(`FACET_UNTYPED_GROUP_POSITION`), because a published order is a statement about
prominence and its absence is not.

### The ordering flow

`product_type_fields` is unique on `(definition, flow, attribute)`, so one
attribute has a position **per authoring flow** and a rail needs exactly one.
There is no `shopper` member in `PRODUCT_TYPE_AUTHORING_FLOWS` — the vocabulary
is about who is *authoring*. `PRODUCT_TYPE_FACET_ORDERING_FLOW = 'merchant'` is
named, with the fallback being the lowest position across every flow. A
shopper-facing flow belongs in that tuple with a migration, owned by Workstream
3 — never as a second ordering table here.

### Two value types are refused rather than faced

`FACET_SHAPE_BY_VALUE_TYPE` is a `Record` over the whole union, so a value type
added to #94 without a decision here is a compile error. Two map to `null`:

- **`date`** — its normalized value lives in `normalized_date`, not
  `normalized_number`, so a numeric range facet would aggregate an always-NULL
  column and report an empty span for an attribute that is fully recorded.
- **`structured`** — a structured value is several **named axes** (#94
  normalization rule 7), and one span across them compares a width against a
  height. Facing it needs `component_axis` in the facet key, which is a
  vocabulary decision rather than an aggregate.

Both are reported as `unsupported_value_type` rather than rendered as an empty
control.

---

## Counting

Every count in the domain is `count(distinct p.id)` — distinct canonical
**products**. A product with forty variants and two hundred offers is one result;
`count(*)` over the value or offer rows would report it forty or two hundred
times, and that number sits beside a checkbox that will then produce fewer.

**A facet's counts are taken with its own selection LIFTED** (`liftFacet`). A
multi-select rail asks "how many if I pick blue **instead of** red", not "…as
well as red"; the other way round every unselected answer reads zero the moment
one is picked. It is also what makes "selected filters preserved at a zero count"
a property rather than a special case.

`unknownCount` is on every facet: the in-scope products for which Mercaria holds
no value at all. Narrowing on a spec half the catalogue does not record is a
decision about that half, and a facet that hides the gap makes it for the shopper.

### Statement budget

Constant in the size of the scope, and growing only with the number of
**selected** facets:

| | Statements |
| --- | ---: |
| Scope + metadata (subtree, product type, fields, #94 definitions, enum values, labels, localizations) | ~8 |
| Matched count | 1 |
| Attribute aggregates, unselected group (product buckets, variant buckets, product ranges, variant ranges, presence) | 5 |
| Observed labels | 1 |
| Taxonomy facet (children + counts) | 2 |
| Commerce facets (availability, condition, market, channel, price span) | 5 |
| Per SELECTED facet | +6 |
| Empty state | +1 per selection |

An empty key list issues no statement, so a scope with no numeric attributes
pays nothing for the range aggregates.

---

## Measurements

`services/graph-benchmark/workload.ts` gained six shapes (Q28–Q33) calling the
real repository functions, and `dataset.ts` gained the attribute population they
need — #61's generator seeded neither `canonical_attribute_values` nor
`canonical_variant_attributes`, so a facet shape appended without it would have
returned zero rows and tripped its own vacuity floor.

At `scale=small` (10,001 products, 10,056 variants, 50,000 offers, 12,000
attribute values, 10,055 axis assignments), 25 latency runs per statement:

| Shape | p50 | p95 | Rows scanned | Buffers | Index |
| --- | ---: | ---: | ---: | ---: | --- |
| Q28 product-grain buckets | 2.880 | 4.121 | 12,417 | 717 | `canonical_products_category_id_idx` |
| Q29 variant-grain buckets (the union) | 3.564 | 5.437 | 10,913 | 2,852 | `canonical_variant_attrs_key_unique`, `canonical_attribute_values_variant_selected_key` |
| Q30 offer aggregate (same-offer) | 7.042 | 9.376 | 13,113 | 4,516 | `offers_variant_country_idx` |
| Q31 full nested conjunction | 3.502 | 5.034 | 835 | 2,926 | five, incl. `canonical_variants_product_id_idx` |
| Q32 presence count | 3.300 | 5.436 | 834 | 4,301 | five |
| Q33 category subtree | 0.090 | 0.122 | 24 | 1 | (none) |

### The measurement that changed the code

**Q32's first implementation asked the negative question directly** — two
`NOT EXISTS` over a `CROSS JOIN UNNEST` of the key list, so the count *was* the
unknown one. The harness measured it:

| | p50 | p95 | Rows scanned | Buffers |
| --- | ---: | ---: | ---: | ---: |
| `countProductsWithoutAttribute` (first draft) | 1,538.7 ms | 1,621.3 ms | 763,336 | 2,253,471 |
| `countProductsWithAttribute` (shipped) | 3.300 ms | 5.436 ms | 834 | 4,301 |

**298× on p95, 915× on rows scanned**, on a read every facet performs on every
load. The negative form gives the planner a doubly-correlated double negation
with nothing to push down; asking which products *have* a value is the same fact
and three indexed lookups inside one lateral.

The reason the first draft was written that way is worth keeping: `matched −
present` drifts if the two counts are taken over **different** requirement sets,
which happens the moment a facet's own requirement is lifted. The answer is to
**pair** the two counts — a facet's unknown figure is measured against the matched
count of its own lifted context — not to ask the question backwards.

### Two more findings from the gate, both caught on the first run

- **Q30's index pin was wrong.** The gate went red naming what the planner
  actually chose: `offers_variant_country_idx` (`canonical_variant_id, country,
  price_amount` where `status='active'`) rather than
  `offers_variant_comparison_idx` (`canonical_variant_id, price_amount, id`, same
  predicate) — correctly, since the aggregate reads no price. Both are keyed on
  the same column with the same partial predicate, so the choice is **statistics**
  and pinning either name would be a gate that fails for a reason about the seed.
  #70 records the identical decision. What is pinned instead is the category scope,
  which is the bound that is load bearing.
- **Q32 measured nothing.** The seed put the numeric attribute on every *second*
  product while a category holds every product whose index is `0 mod 24` — so
  every product of every category had one and the unknown count was structurally
  zero. The row floor caught it; the stride is now 5, coprime with 24.

### No DDL is needed and none is proposed

Every statement lands on an index that already exists:

| Read | Index |
| --- | --- |
| Category scope | `canonical_products_category_id_idx` |
| Category subtree | `categories_ancestor_ids_idx` (GIN) |
| Product-grain requirement | `canonical_attribute_values_product_selected_key` |
| Variant-grain requirement | `canonical_attribute_values_variant_selected_key`, `canonical_variant_attrs_key_unique` |
| Numeric range | `canonical_attribute_values_numeric_idx` |
| Offer requirement | `offers_variant_comparison_idx` / `offers_variant_country_idx` |

`db/schema/facets.pending.sql` does not exist because nothing is pending.

---

## Money

The price filter is a SQL predicate, and SQL cannot call `fx.service`. So **the
bound is converted, not the amounts**: `fx.convert` — the one authority — is
called once per request to express the shopper's bound in every currency present
in scope, and each offer is compared against the bound in its **own** currency.
The comparison is then exact integer arithmetic on a `bigint` column, with no
float rate anywhere near the planner.

The approximation is stated rather than hidden: converting a bound and converting
an amount both round, so an offer within one minor unit of the boundary may fall
on either side. Converting the amounts instead would move the rounding, not
remove it. What this arrangement buys is that every offer of one currency is
judged by **one** converted number, so two identically-priced offers can never
disagree.

A currency the rate map cannot serve produces no bound, is reported in
`unconvertibleCurrencies`, and its offers satisfy no price filter — the
`SearchFxContext` posture. An unconvertible price is never shown as "too
expensive".

**That includes a currency Mercaria does not model at all**, which this facet
used to drop instead (#450): `composePriceSpan` skipped it in both loops, and
`FacetMoneyRange.unconvertibleCurrencies` was typed `CurrencyCode[]`, so an
out-of-tuple code was unreportable BY TYPE rather than merely unreported —
silent in the DTO, in the logs and in the types at once. The field is now
`string[]`, and `unmodelledCurrencies` names the permanent subset beside it, as
in search. A scope priced ENTIRELY in such a currency has no span at all, and
`composePriceSpan` returns its exclusions anyway so the facet is suppressed as
`unconvertible_currency` rather than `no_values` — the second says the catalogue
has no prices, when what happened is that none could be read.

The price **span** is grouped by the offer's own currency in SQL and converted
afterwards, because `min(price_amount)` across currencies compares raw minor
units.

---

## Size systems and colour families

**A size system IS an attribute definition.** `shoe_size_eu` and `shoe_size_uk`
are two keys, so no bucket of one can reach a bucket of the other — false
equivalence is *unrepresentable* rather than checked. There is no row, column or
function in the domain that could map between them, and
`FACET_FORBIDDEN_EQUIVALENCES` names the prohibition as a value so the shapes
that would introduce one (`convertSize`, `toSizeSystem`, `mergeBucketsAcross`)
can be scanned for, with a mutation self-test.

**A colour family keeps the commercial name.** The bucket key is the canonical
controlled value (`black`), resolved through #94's `attribute_value_aliases`; the
bucket carries `observedLabels` — the distinct `source_display_value`s that
normalized into it ("Midnight", "Jet Black"), capped and display-only. Collapsing
the two in either direction is `colour_family_collapse`. Nothing about this is
colour-specific code: any enum bucket carries its observed spellings.

---

## Sorting

This domain **does not sort anything**, and that is the design. Ordering results
is #74's, behind its versioned policy; a second module that put products in an
order would be a second ranking authority arriving through the filter rail.

What it owns is the **closed set** of sortable keys, generated from
`attribute_definitions.sortable` plus one commerce dimension (`offer_price` —
price is a magnitude every offer publishes; availability, condition, market and
channel are categorical and a sort by one is a merchandising decision wearing a
sort control's clothing), and the validation that refuses everything else with a
**stable code**: `unknown_key`, `not_sortable`, `unsupported_direction`. A
refused sort is a 400, never a silent fallback to the default order.

`FacetSortDirective` carries a **mandatory** `tiebreak: 'canonical_product_id'`.
Without a total order a keyset page repeats and drops rows silently.

A **suppressed** facet contributes no sort option: offering "sort by screen size"
for an attribute the product type hides exposes the withheld field through the
ordering.

---

## Suppression, and never withdrawing what the shopper chose

Two rules that pull in opposite directions.

**Suppress what cannot narrow anything** — a facet whose every product gives the
same answer is a control that does nothing; a zero-count bucket is a control that
empties the page. Reasons: `not_filterable`, `hidden_by_product_type`,
`compatibility_scope`, `no_values`, `single_value`, `degenerate_range`,
`unsupported_value_type`, `unconvertible_currency`. Every one is **reported** in
`suppressed[]` — a facet that vanished and a facet that never existed look
identical to whoever is debugging a rail.

**Selection wins** at both grains: a selected bucket is always rendered, count and
all, and a facet carrying one is always offered. Otherwise a shopper's filter
stays applied while the chip explaining it disappears — a page lying about its own
state, unrecoverable without clearing everything.

**But a METADATA refusal survives a selection.** The order of the tests is the
decision: a facet the registry says is not filterable, or the product type hides,
stays hidden even if a stale client sends a selection for it — otherwise a
selection would be a way to summon a control somebody deliberately withheld.

---

## Empty states never silently relax anything

`FacetSuggestion` has **no results member**, so a suggestion cannot carry the
products it would have produced. Nothing in the domain can compute a page under a
selection the shopper did not make; the only thing a suggestion holds is a count
and the identity of what to drop, and applying it is a request the client makes
next with the shopper having pressed something.

Each candidate is **measured** with exactly that one selection lifted — deriving
them from the facet counts would be wrong in a way that is hard to see, since a
bucket's count is already taken with its own facet lifted and says nothing about
abandoning a different one. A suggestion that would still leave nothing is
dropped: a control offering to remove a filter and then showing an empty page
twice is worse than no control.

`no_products_in_scope` and `selection_excludes_everything` are kept apart because
they lead to opposite next actions.

---

## Identity and localization

Every key that travels in a URL or in client state is stable and untranslated: a
#94 attribute key, a controlled value, a category id, a commerce dimension. Every
rendered string carries a `FacetLabelSource` — `localization`, `attribute_label`,
`registry_base` or `stable_key` — so a client can tell real copy in the reader's
language from a machine key rendered because Mercaria holds none.

**There is one resolver and it is not in this domain.**
`services/catalog-localization/resolve.ts` owns the fallback chain and the status
rules; this module calls it through `read.service.ts` for categories and
controlled values, and through its exported pure `localeFallbackChain` for
attribute names.

The attribute-name gap is real and named rather than papered over:
`LOCALIZED_ENTITY_KINDS` is `['category', 'product_type', 'attribute_value']` and
`attribute_labels` is the single recorded exemption from the family columns
(`LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS`), so it carries no `status` and no
`provenance` for a resolution to report. It is walked with the **same** chain and
reported as `attribute_label`. Making `attribute_definition` a full family member
is Workstream 2's, and closing it deletes the one bespoke walk here.

**Commerce dimension labels are `stable_key`.** There is no
`commerce_dimension` entity, no localization table for one and no place a
translator could put "Precio". Emitting the key and *saying* it is the key is
honest; the client owns that copy, the way `@mercaria/ui`'s `lib/condition.ts`
already owns the nine condition labels. Inventing English copy would be worse
than the key: it would look like copy, so nobody would translate it, and a
Spanish rail would read "Price" with every value beside it in Spanish.

---

## A commercial payment can never influence facet ordering or relevance

Four mechanisms, none of them a review note:

1. **Disjoint vocabularies.** `FACET_ORDERING_INPUTS` (7) and
   `FACET_FORBIDDEN_ORDERING_INPUTS` (8) are disjoint by a test, and each
   forbidden input has its **own detector** — a census that fired on its first run
   (`paid_ranking_slot` was prohibited and scanned for by nothing).
2. **Nowhere to put a weight.** Every comparator in `ordering.ts` reads a
   published position or a shipped tuple. There is no numeric score, weight or
   blend in the file, so there is no term a fee could become.
3. **The domain never orders results at all.** It publishes sort options and
   returns no products.
4. **A scanned wall**, mirroring `search-relevance-isolation.test.ts`: no module
   on the facet path may reach a fee, a commission, a referral reward, a merchant
   plan, a sponsored placement, a paid slot, a retail margin, a payment rail — or
   `services/ranking/`, where a facet module reaching in would make this a second
   ordering authority.

Comments are stripped before matching (this domain documents its refusals in the
same vocabulary), every file carries a size floor, and every detector has a
positive fixture plus a shared negative.

---

## Commerce dimensions: the subset, and the three that are out

`FACET_COMMERCE_DIMENSIONS` is a **subset** of #94's `COMMERCE_FACETS`, never a
second list — a facet a shopper picks and a hard constraint the evaluator answers
have to be the same concept or the count and the filter disagree. Five are
generated: `offer_price`, `availability`, `condition`, `market`, `offer_channel`.

Three are deferred, each with an owner:

- **`known_total`** — a delivered total is #74's derivation over a projected
  offer, not a stored column, so bucketing it here would be a second spelling of
  that arithmetic.
- **`proximity`** — a distance is not a value an offer carries. Its facet arrives
  with #93's collection points.
- **`official_channel`** — the tempting one. It is not an offer column: it is
  whether the offer's merchant holds a **live** relationship for the product's own
  brand, read from #55's temporal rows so a lapsed authorization stops qualifying
  with no sweep having run. `findCurrentRelationships` is that read's one
  authority and it is keyed on **one** brand — a bound a twenty-row page has and a
  category subtree does not. Facing it here would mean sixty statements or a
  second batched spelling of the same predicate, and two spellings of "is this
  authorization live" can disagree exactly where a badge is decided. It stays
  available as a #70 filter.

Condition buckets are **segments** (#90), and segments collapse into **one** key
membership test — two ANDed `IN` lists answer with the empty set for a rail that
sent both a segment and a key. The key → group map is `CONDITION_KEY_GROUP` in
shared-types, applied in TypeScript rather than as a `CASE` in SQL: a second copy
would come apart the first time a key is added.

Channel buckets use #94's two-member `OfferChannelKind` (`native | external`),
not `offers.kind`'s four — `affiliate` and `informational` are both "this leaves
Mercaria", which is the distinction a shopper is drawing.

---

## Scope

```ts
type FacetScope =
  | { kind: 'category'; categoryId: string; includeDescendants?: boolean }
  | { kind: 'canonical_products'; canonicalProductIds: string[] };   // bounded at 1,000
```

The split is a statement about who retrieved what. A category scope is an
indexable predicate over a whole subtree, so its counts are exact over a set
nobody had to materialise. A `canonical_products` scope is a bounded id list a
caller **already** retrieved — #70's candidates, a comparison basket, a saved
query — and it exists so this domain never grows a second answer to "what matches
this text", which is search's.

---

## Surface

`POST /facets`, public, no auth (public catalogue metadata plus counts over
public rows — the `/catalog-attributes` precedent), rate-limited under the
`'listings'` scope. `.strict()` throughout: an undeclared field is either a
client sending a label where a key belongs or a client sending a weight where
none may exist.

A POST rather than a GET because the selection is a nested, repeated structure
with per-entry numeric bounds, and every URL encoding of one is a parser somebody
has to agree on. The response carries nothing viewer-specific, so a caching layer
keys on the body.

**There is deliberately no operator surface and no seventh allow-list.** A facet
rail is a projection over rows other domains own, every one of which already has
an operator surface behind its own gate.

**Flag:** `FACETS_ENABLED`, default false. It gates the MOUNT and nothing
durable — the domain owns no table and writes no row, so a rollback is one
variable and loses no evidence.

---

## Seams, each named rather than stubbed

- **#74** — the ranking policy. This domain publishes sort options and applies
  none; a scanned gate keeps it out of `services/ranking/` entirely.
- **#70** — search. `FacetScope.canonical_products` is the seam: search hands
  down its candidate ids and gets counts back. Nothing here re-implements
  retrieval, and there is no free-text parameter to accept.
- **#93** — proximity. No parameter exists to accept, so it is unrepresentable
  rather than ignored.
- **#55** — `official_channel`, above.
- **Workstream 2** — `attribute_definition` as a localization family member,
  which deletes `attributeNameLabel`'s bespoke walk.
- **Workstream 3** — a shopper-facing `PRODUCT_TYPE_AUTHORING_FLOW`, which would
  replace `PRODUCT_TYPE_FACET_ORDERING_FLOW`'s named choice.
- **`date` and `structured` facets**, above.
- **The storefront rail itself.** Every endpoint a filter UI needs exists; no
  frontend component was added, and the isolation gate already scans the
  storefront so the first one cannot arrive with a hard-coded list.

---

## An observation about `services/search/offer-context.ts` — FIXED, and the record kept

> **This section documented an open bug that has been fixed, and read as open for
> as long as it stood.** It was true when written. `c867eada`
> (*fix(search): answer offer-side filters from ONE offer, not two* — #438/#449)
> landed afterwards and nobody swept this page. The finding is kept rather than
> deleted, because a reader who remembers it needs to be able to tell that it was
> resolved rather than that they imagined it — and because it is the clearest
> worked example this repository has of the failure the workstream is named after.

**What was wrong.** `buildSearchOfferContexts` applied `market`, `offerKinds`,
`availability`, `conditionGroups` and `merchantIds` in the SQL scope — same-offer
by construction, one WHERE on one row — but then computed `satisfiesPrice` and
`fromOfficialChannel` in a loop over the surviving offers, each set by the *first*
offer that satisfied it:

```ts
// as it WAS — do not restore this shape
for (const offer of current) {
  if (… && !satisfiesPrice) { … satisfiesPrice = true; }
  if (officialMerchants?.has(offer.merchantId)) fromOfficialChannel = true;
}
```

So a product passed `price ≤ X` **and** `officialChannelOnly` when offer A was
cheap and a different offer B was official.

**What it is now.** `matchOfferRequirements`
(`services/search/offer-context.ts:373`) evaluates the whole requirement set
against ONE offer and is called per product at `:603`; `satisfiesPrice` and
`fromOfficialChannel` no longer exist as independent accumulators — a grep for
either returns zero, against three hits for `matchOfferRequirements`. The
negative case is pinned by
`services/search/__tests__/same-offer-filters.realdb.test.ts:379`, with an
assertion at `:342` that the fixture really is crossed — so the test cannot pass
by measuring an uncrossed product.
