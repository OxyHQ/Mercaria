# The catalog-driven storefront (#367 workstream 9)

How `packages/frontend` consumes the universal catalog: categories and
navigation, the category landing page, the product detail page's specifications
and variant selectors, and comparison. Binding architecture:
[ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md) D1, D2, D3, D4,
D5, D6. The domains it reads are `docs/navigation.md`, `docs/taxonomy.md`,
`docs/catalog-localization.md`, `docs/facets.md`, `docs/product-types.md`,
`docs/variant-axes.md`, `docs/attributes.md` and `docs/comparison-basket.md`.

The one sentence the whole workstream exists to make true:

> **No category-specific or product-type-specific field list, filter list, spec
> list or controlled value anywhere in `packages/frontend`.**

`scripts/validate-storefront-catalog-driven.mjs` is what makes that a build
failure rather than a review note. Every shape it catches type-checks, lints,
builds and renders — a storefront that knows one category's filters by name
looks exactly like one that reads them from the server, right up until an
operator publishes a new attribute and nobody's screen changes.

---

## Where the code is

| | |
|---|---|
| The six request dimensions | `packages/frontend/lib/catalog/context.ts` |
| Navigation, and its parity fallback | `lib/catalog/navigation.ts`, `lib/catalog/use-navigation.ts`, `lib/api/catalog-navigation.ts` |
| Category identity and ancestry | `lib/catalog/category-tree.ts` |
| Canonical URL, `hreflang`, breadcrumbs, redirects | `lib/catalog/use-catalog-seo.ts`, `lib/api/catalog-seo.ts` |
| Filter state and its URL grammar | `lib/catalog/facet-selection.ts`, `lib/catalog/use-facets.ts`, `lib/api/facets.ts` |
| Specification composition | `lib/catalog/specifications.ts`, `lib/catalog/use-specifications.ts`, `lib/api/catalog-attributes.ts` |
| Variant axes and availability | `lib/catalog/variant-axes.ts` |
| Comparability rules | `lib/catalog/comparison.ts` |
| Compatibility (a fail-closed seam) | `lib/catalog/compatibility.ts` |
| The ONE route composer | `lib/catalog/routes.ts` |
| Components | `components/catalog/` (7 files) |
| Screen | `app/(app)/categories/[handle].tsx` |
| The gate | `scripts/validate-storefront-catalog-driven.mjs` + its self-test |
| The runner | `packages/frontend/vitest.config.ts`, `lib/catalog/__tests__/composition.test.ts` |
| The runner | `packages/frontend/vitest.config.ts`, `lib/catalog/__tests__/composition.test.ts` |

---

## The six dimensions are kept apart

ADR 0007 and the epic both insist on it:

> Treat language, locale, market, currency, unit system and size system as
> related but independent dimensions.

`useCatalogContext` resolves each from its OWN source, and no consumer derives
one from another.

| Dimension | Source | Why not something else |
|---|---|---|
| `language` / `locale` | the i18n store — the shopper's explicit choice | never the device, which they already overrode |
| `market` | the DEVICE's region | a market is where you are buying, not what you read |
| `currency` | `FxContext`'s persisted preference | never the market, which does not choose it |
| `unitSystem` | the device's CLDR measurement system | never the language |
| `sizeSystem` | nothing — see below | |

`market` is **absent** rather than guessed when the device names none. A market
decides assortment, tax treatment and which navigation tree is published, and
inventing one from the reading language would show a shopper somebody else's
shop.

**The cost of that is real and is stated rather than left to be discovered.**
`GET /navigation` requires a market, so a client whose device reports no region
— a browser sending a bare `en` rather than `en-GB` — never reaches taxonomy-v2
navigation at all and always takes the v1 parity fallback. The obvious repair is
to read the region off the shopper's CHOSEN locale, every one of which is
region-tagged in the language selector (`es-ES`, `es-MX`, `ca-ES`), and it is
deliberately not done: that is precisely the collapse this section exists to
prevent, and somebody reading Spanish on an unregioned device is not thereby in
Spain. The right repair is an explicit market control, which is a product
decision nobody has made.

**Neither `unitSystem` nor `sizeSystem` converts anything in this package.**
Units are already composed by the server into `PublicAttributeValue.displayValue`
under the registry's own recorded conversion rules and versions; converting here
would be a second authority with no version behind it. `CatalogSizeSystem` has
exactly ONE member, `unspecified`, because Mercaria publishes no size-system
mapping over HTTP and workstream 4 states outright that conversions are sourced
mappings with confidence rather than universal truth — so there is no value that
member could take that would authorize collapsing EU 42 into US 9.

What the storefront DOES apply is CLDR **presentation** — a date, a money amount
and a bare numeric magnitude, in `specifications.ts` — which is workstream 2's
"keep canonical numeric/unit storage independent from localized formatting".
Money goes through `@mercaria/ui`'s `formatMoney` chokepoint and never through
arithmetic here. A MEASUREMENT keeps its server-composed form untouched: the
number and its unit token were composed together under a recorded conversion,
and re-rendering only the number would leave the two spelled by different
authorities.

---

## Navigation: two sources, one shape, and the source is REPORTED

`GET /navigation` is mounted only behind `CATALOG_TAXONOMY_V2_ENABLED`, which
defaults OFF. ADR 0007 D13 conditions the storefront rewire on parity with what
shipped before it, so `useCatalogNavigation` falls back to `GET /categories` —
the v1 tree, always mounted, reading the SAME `categories` rows — and every
consumer is told which source answered.

Three distinct causes take the fallback and it deliberately does not tell them
apart: the flag being off (a 404), a market nobody has configured (a 200 with an
empty tree list), and an unreachable API. None of the three is a state a shopper
should see a menu-shaped error in. What distinguishes them for anybody who needs
to know is `CatalogNavigation.source`.

**An EMPTY taxonomy-v2 answer falls back too.** `GET /navigation` answers
`{trees: []}` for an unconfigured market, deliberately, so that market does not
look like a broken deployment — and a storefront rendering that as an empty menu
would withdraw navigation on the deploy that enabled the flag, which is exactly
what D13's parity condition forbids.

What the v1 branch costs, stated rather than hidden: no localization (a v1 name
is whatever the row stores, and there is no `fallbackLocale` field on that
branch to claim otherwise), no lifecycle (v1 filters `is_active` in SQL, so a
withdrawn category is absent rather than reported as withheld), and no
redirects — which is closed by a different surface, below.

**A node whose target kind the storefront has no screen for renders as TEXT.**
`navigationTargetHref` answers `undefined` for `product_type`, `saved_query` and
`collection`; such an entry keeps its label and its children and gets no press
handler at all. That is the discriminated shape `NAV_ITEMS` already uses for an
unbuilt screen, for the same reason: a control that does nothing is worse than a
word that never claimed to be one.

---

## Redirects, canonical URLs and `hreflang` come from ONE registry

`GET /seo/resolve?path=` (#75) owns the redirect registry, the canonical URL,
the `hreflang` alternates, the `robots` string and the breadcrumb trail. The
category page asks; it does not decide. Composing a canonical URL here would be
a second answer that disagrees with the sitemap and the HTTP 301 the moment
either moves.

A deprecated or localized slug therefore answers `outcome: 'redirect'`, and the
page applies it with **`replace`, never `push`** — the requested address was a
redirect and putting it in the history would let the back button walk into it
again. This is the client half; the HTTP 301 a crawler needs is #75's.

`categoryHandleOfPath` is deliberately narrow: it recognises exactly
`/categories/:handle` and answers nothing for any other path, so a redirect
pointing at a brand or a product cannot be applied on a category screen as if it
were one.

**`SEO_ROUTES_ENABLED` defaults false**, so on most deployments this 404s. The
page then emits its own title and NO canonical tag and NO alternates, which is
the honest degradation: an absent `rel=canonical` leaves the address as its own
canonical, which is what it in fact is.

**Breadcrumbs prefer the registry's trail and fall back to the tree's ancestry.**
Both are real; the registry's is authoritative because it is the same trail the
page's own `BreadcrumbList` structured data is built from, so what a shopper
reads and what a crawler is told cannot disagree.

---

## The category landing page

Four server surfaces compose it and the screen composes none of them:

| What | Where it comes from |
|---|---|
| identity, children | `GET /categories` |
| breadcrumbs, canonical URL, `hreflang`, redirects | `GET /seo/resolve` |
| the filter rail | `POST /facets`, scoped to this category |
| the products | `GET /listings?category=` |

The address is `/categories/:handle`, which is `PublicRouteId`'s own recorded
pattern for `category_browse`. The handle is an id OR the current slug and both
resolve — the id is tried FIRST, because an id is opaque and cannot collide with
a slug, so trying the slug first would let a category whose slug happened to
equal another's id shadow it.

**The filter selection lives in the URL, in stable keys.** `?filters=` carries
origins, facet keys and bucket keys and never a translated word, so a shopper
sharing a filtered category shares the same filter into any language. The
grammar is one parameter, entries separated by `;`:

```
attribute~color=black|white;commerce~condition=new;attribute~screen_size=5..7
commerce~offer_price=1000..5000@EUR
taxonomy~category=<categoryId>
```

The origin is part of the key and cannot be dropped: `condition` is a commerce
dimension and `color` is an attribute, two facets may legitimately share a key
across origins, and `POST /facets` requires the origin on every entry. Parsing
is TOTAL and lossy in one direction only — an entry the parser cannot read is
DROPPED rather than guessed at, and the count is reported on screen, so a link
carrying a filter that could not be restored says so instead of silently showing
unfiltered results under a filtered URL.

Every construction switches on the origin, because the three SHAPES differ: an
attribute range is in the definition's BASE units, a commerce range is in a
currency's MINOR units, and a taxonomy entry has values and no range at all.
Two different numeric scales must never be read into one field.

**A price bound says what it could not include.** `#463` widened
`FacetMoneyRange.unconvertibleCurrencies` from `CurrencyCode` to `string`
precisely so a currency Mercaria does not model can be NAMED, and the rail
renders that list: "from 10 € to 900 €" with no note gives a shopper no way to
know some offers were left out of it, which restores the silence #463 exists to
end one layer up. `unmodelledCurrencies` is a subset and is deliberately not
rendered separately — permanent-versus-transient is an operator's distinction
and both mean the same thing to somebody choosing a price bound.

**A selected filter the current results cannot offer stays removable.**
`facetOffered: false` is the server echoing an entry back and saying it could not
offer the facet — #367's "preserve selected filters even if the current result
set makes a facet count zero" arriving as a fact rather than as client memory.
Those render as their own chips ABOVE the rail, because the remedy for "no
results" is to remove one and a shopper cannot remove a chip from a rail that
has stopped listing it.

---

## Product detail

### Specifications

`GET /catalog-attributes/definitions?categoryId=` and
`GET /catalog-attributes/values/:entityKind/:entityId` — the SAME registry the
authoring wizard composes its form from, which is workstream 9's "render
localized labels and formatted values from the same definitions used by
authoring". Both are anonymous and unflagged, which is why the specification
table is the one part of this workstream that works with every #367 lever off.

Which rows exist is the registry's own selected values (already filtered by
`displayPolicy`, already excluding the conflicting and unparsed ones Mercaria is
unwilling to state); their ORDER is `position`, the registry's own display
order. Nothing sorts by label, because sorting by label reorders the table when
the locale changes.

Labels follow ADR 0007 D4's chain — exact locale, then the language, then the
definition's default-locale label — and the STEP that answered is reported, so a
surface can say what is untranslated instead of presenting a base-locale string
as if it were the shopper's language.

**Two groups, and both are facts rather than an arrangement:** `product` and
`variant` are the two entity kinds the value surface has, so the split is "true
of the model" versus "true of this exact configuration". A group is emitted only
when it has rows.

**`verificationState` is carried and rendered by nothing**, deliberately: the
public projection already excludes what Mercaria will not state, so decorating a
subset of what remains with a trust mark invites the reading that the
undecorated rows are doubted.

**Only LABELS are localized; names and values never are.** `CanonicalProduct.name`
is the canonical model name and is rendered verbatim, an attribute's
`displayValue` is the server's own rendering, and `axisLabel` falls back to the
stable KEY rather than prettifying `storage_capacity` into "Storage capacity" —
a label this package would have invented. That is workstream 9's "keep official
brand/model names unchanged when translation is inappropriate", held by there
being no path through which a name reaches a translator.

**What the public attribute surface cannot distinguish, stated rather than
implied:** `PublicAttributeValue` carries no source record, confidence, method
or normalization rule version (#94 API rule 7 keeps provenance on the operator
surface), so a merchant CLAIM and a selected canonical fact are not tellable
apart from it. The specification table reports the distinction it CAN make and
does not manufacture the one it cannot. Offer STATE is separate by construction
— it arrives on `ProductPageOffers` and never on an attribute row.

### Variant selectors

`CanonicalProduct.variantDefiningAttributeKeys` is the authority when the product
declares any, in the order it declares them (workstream 3: "make the product's
declared variant axes authoritative for that product"). A product that declares
none falls back to what its configurations actually differ on. There is no
per-category axis map and no parameter one could arrive through.

Four availability states, and only two are selectable:

| State | What it means | Selectable |
|---|---|---|
| `available` | a configuration carries it and this page shows offers for it | yes |
| `unavailable` | a configuration carries it and it has no offer on this page | no |
| `impossible` | NO configuration carries it beside the other choices | no |
| `unknown` | configurations carry it and none reports an offer count | **yes** |

`impossible` is the sparse matrix and is kept apart from `unavailable`, because
"we do not make that one" and "that one is out of stock" lead a shopper to
opposite next actions. **`unknown` stays selectable and that is the load-bearing
case**: `ProductPageVariant.offerCount` is ABSENT when the offers half was
withheld, and reading absence as "no offers" would disable every control on the
page and present a withheld comparison as a discontinued product.

A value's availability is evaluated against the selection with **its own axis
removed**, so every value on an axis stays reachable while the other choices
hold. Evaluating against the full selection would make each axis show exactly
one enabled value — its own — which is a selector nobody can move.

The URL carries the RESOLVED configuration (`?variant=`) and nothing else, which
is what a shared link should mean. A partial selection is transient UI state.

A product whose variants carry no option assignments has no axis to build a
control from, so the page falls back to the existing `VariantSelector`, which
names each configuration by the only thing that identifies it.

---

## Comparison

`POST /comparison` returns the server's grounded package, and
`lib/catalog/comparison.ts` decides two things over it.

**Whether these subjects can be compared**, by four explicit rules evaluated in
order. The order is load-bearing: `no_shared_facts` is checked BEFORE the
category scope, because two products in one category with nothing recorded in
common produce a table of dashes, and telling a shopper "these are comparable"
over it is an empty claim. A shared row is one every subject has a STATED value
on, and `conflicting` is excluded — #94 selects NEITHER candidate when two
sources disagree, so counting it would let a comparison claim common ground that
rests on a disagreement nobody resolved.

`comparable_across_categories` renders WITH the table and a caveat: comparing a
laptop against a tablet is a legitimate question whose answer has fewer shared
rows. `no_shared_facts` renders INSTEAD of the table.

**Never implying a requirement is met when data is missing** is the ABSENCE of a
function. `ComparisonConstraintColumn` keeps `satisfied`, `failed`, `unknown` and
`notApplicable` as four lists; `requirementOutcomeCounts` reports four numbers
and there is deliberately no `met` count that adds `satisfied` to anything else
and no helper that folds `unknown` into either side. A renderer that wanted to
claim an unknown requirement was met would have to write the addition out loud.

**Units are normalized once, by the server, and precision is not re-rounded.**
`ComparisonTableRow.unit` is the unit every numeric cell in that row is expressed
in, and a converted cell carries `state: 'inferred'` with
`basis: 'unit_conversion'`. This package neither converts nor re-rounds; a
second rounding would be the false precision workstream 4 forbids.

**Exact variants are comparable** — `?p=handle:variantId` alongside `?p=handle`,
so a shopper can compare one phone's 256 GB configuration against another phone
as a whole. `lib/catalog/comparison.ts` owns both halves of that grammar, beside
each other, so a page composing a "compare this configuration" link writes
exactly the spelling the comparison screen reads.

---

## The gate

`scripts/validate-storefront-catalog-driven.mjs`, wired as
`bun run validate:storefront-catalog` and as CI's "Guard the catalog-driven
storefront". Five walls, each with a vacuity floor and a mutation self-test
(`scripts/test-validate-storefront-catalog-driven.mjs`, 25 cases).

1. **No branch on a catalog concept's identity** — a comparison, a `switch` or a
   membership test whose subject is `categoryId`, `attributeKey`, `facetKey`,
   `productTypeKey`, `enumValueId`, `facet.key`, `row.key` … against a string
   LITERAL, or an in-file constant bound to one. Membership is narrowed to a list
   this tree AUTHORED, because the correct implementation does exactly the same
   call against a set built from the server's answer at runtime.
2. **No namespaced concept key in the catalog subtree** — a dotted lowercase key
   in a constant is how wall 1 is walked around. Scoped to the subtree, because
   repo-wide a dotted lowercase string is also what an AsyncStorage key looks
   like.
3. **No hardcoded concept identity in a payload.**
4. **No translated label as identity** — a `t(...)` in the value position of an
   identity property.
5. **No re-listed server vocabulary** — an array or `new Set([...])` of two or
   more string literals whose declaration's type annotation mentions a type
   imported from `@mercaria/shared-types`.

**The catalog's closed VOCABULARIES are deliberately absent from wall 1's
identity list.** `origin`, `shape`, `kind`, `state`, `level`, `valueType`,
`availability`, `scope` — a renderer MUST switch on those; that is what makes it
schema-driven rather than what makes it hardcoded. The difference is whether the
subject is one concept's NAME or the finite set of forms a concept can take, and
a rule that fired on the second would be flagging the code it exists to protect.

### Wall 5 is the workstream's own, and it had four live findings

The distinction it draws is enforceable rather than stylistic: a
`Record<Union, string>` cannot omit a member, so adding one to the union fails
`tsc` at the copy — while an ARRAY is a SUBSET that goes on compiling while the
control silently stops offering the new value.

Measured, on the tree as it stood:

- `app/(app)/compare.tsx` re-listed `ConditionGroup` as
  `["new", "open_box", "refurbished", "used"]` — **silently omitting
  `for_parts`**, which #90 added. A shopper could not filter for it and nothing
  anywhere said so.
- The same file's `CHANNEL_CHOICES` and `OBJECTIVE_CHOICES` re-listed
  `BasketChannelPolicy` and `BasketObjective` as `{value, label}` arrays.
- `app/(app)/p/[handle].tsx` carried **two** copies of the offer-intent list, one
  in the picker and one in the query-parameter validator.

All five are now the imported tuple plus, where copy is needed, a `Record` over
the union. Copy MAPS are untouched by the rule, and the self-test asserts both
directions.

### Both exemption lists are reconciled in BOTH directions

An entry that no longer fires fails the build, not just an entry that appears.
That caught a defect in this guard's own first draft: `CATALOG_PATH_LITERALS`
carried `category_tree`, and `NAMESPACED_KEY` requires at least one dot — so the
exemption excused a finding that could never occur. An exemption that cannot
fire is indistinguishable from one doing real work. The list is now EMPTY, its
size is asserted at zero, and a dead entry is a failure with its own message.

### The one reasoned exception

`KNOWN_VOCABULARY_EXCEPTIONS` holds exactly one entry, its size is asserted, and
it is reconciled in BOTH directions — an entry that has stopped firing fails the
build too, so the list cannot rot into things somebody once silenced.

`app/(app)/orders/[id].tsx`'s `BUYER_CANCELLABLE` is a POLICY subset of
`OrderStatus` ("which statuses permit a buyer cancellation", commented "mirrors
the backend graph"), not a catalog vocabulary. The shape is identical to a
vocabulary copy and the risk is real — the backend adding a cancellable status
does not reach that screen — so it is recorded rather than pattern-exempted.
#110 publishes `CancellationEligibility` derived server-side; wiring that screen
to it deletes the declaration and the entry together.

---

## What this document does NOT cover

Workstream 9's fourth section — **recommendations and related products** — is
not here. Its four items ("expose taxonomy, product type and normalized
attributes to recommendation systems through stable IDs", "support related
products using compatibility and category relationships", "prevent
presentation-only collections from becoming false product facts", "track
schema/version dependencies so changed mappings can trigger controlled
recomputation") are properties of a recommendation SYSTEM and its indexing, not
of a storefront screen, and the storefront reads no recommendation surface
today. Two of the four additionally depend on the compatibility domain, which this
package now reads for a product's own fitment list — but a RELATED-PRODUCTS use of
it needs the relation lookup, whose targets carry no display name (below).

---

## The storefront gained a test runner, narrowly

`packages/frontend` had none: every storefront check in this repository lives in
the backend suite and SCANS source as text — `route-reachability.test.ts`,
`seller-identity-isolation.test.ts` (#92), `product-page-isolation.test.ts`
(#71). That is not an aesthetic choice. The backend's `rootDir` is its own
package root by an explicit decision in its `tsconfig.json`, so a test there
**cannot import a file from another package at all** (TS6059), and excluding one
test from that program to get around it also stops `parserOptions.project`
parsing it — leaving the file neither typechecked nor linted. Both measured on
this branch, in that order, the second by CI failing `Lint API`.

So `lib/**` gets a runner: node environment, no jsdom, no React. What is
testable without a renderer is exactly the pure composition, and a config that
could mount a component would invite tests this package has no shape for yet.
The scanning gates are NOT moved here and should not be — they cover the whole
tree, including files that import a renderer.

**What it buys, concretely.** A gate checks SHAPE; only running the code checks
BEHAVIOUR. `parseComparisonSubjects` trimmed a whole `?p=` entry instead of each
half, so `?p= a-handle :var` kept a trailing space inside the handle and would
have 404'd — with `tsc`, ESLint, `expo export` and all five walls of
`validate:storefront-catalog` green on it. Restoring that one character turns
exactly one case red.

**The gate skips test files, and the exclusion has a control.** A test's job is
to name fixtures — a facet keyed `color`, an axis called `storage` — which is
what the walls refuse in production code. It is a CATEGORY (`__tests__/` or
`*.test.ts`) rather than a list of paths, so there is nothing to maintain; what
keeps it honest is a self-test case that runs BYTE-IDENTICAL source at a
non-test path and requires every wall to still refuse it. The count of skipped
files is reported on success, so production modules renamed into `__tests__`
would show up as a number nobody expected.

### A day was lost to a stale base, and the lesson is cheap to state

The runner was accused of breaking CI's `Typecheck App` with eight
`TS2307: Cannot find module '@/hooks/useTranslation'` errors, and it was
innocent. **CI's `pull_request` job checks out the PR MERGED INTO `main`, so a
branch that is green locally is red in CI the moment `main` removes something it
uses.** #467 converged the storefront onto the shared locale registry and
deleted `hooks/useTranslation.ts`, `lib/i18n/rtl.ts` and
`lib/stores/i18n-store.ts`; every pre-existing importer moved to `@/lib/i18n` in
that same commit, which is why only the files this branch added were flagged and
why nothing reproduced locally against the stale base.

**The tell was in the guards' own output, hours before the diagnosis.** CI
reported `192 source files under packages/frontend/` where the local run
reported `195`, and the RTL guard was three lower in exactly the same way — the
three deleted files. A count printed on SUCCESS is what made a red typecheck
legible; a guard that only spoke when it failed would have said nothing. Compare
the numbers a guard prints against the ones CI prints before believing a failure
is about the thing that changed last.

---

## Seams, each named rather than stubbed

- **An `/categories` index hub, and the SEO decision it needs.** The category
  LANDING page is what workstream 9 asks for and is what shipped; a hub whose
  entire content is links to pages each indexed on their own is a different
  thing, and whether it earns a `PublicRouteId` member of its own or a reasoned
  `NON_PUBLIC_SCREENS` entry is an SEO call rather than a mechanical one. It is
  deliberately not shipped, because a page carrying an unmade decision is worse
  than an absent one — `seo-routes.test.ts` DIRECTION 2 would have had to be
  answered by whoever happened to need the page. `NAV_ITEMS`'s `explore` entry
  therefore stays `available: false`, which is the discriminated shape that
  repository already uses for an unbuilt screen. **The question to file: is a
  category index hub a public indexable route?** The storefront reaches every
  category from the home feed's pills and from a published navigation tree, so
  nothing is unreachable without it.

- **The vehicle picker and a verdict for the shopper's OWN car (#367 workstream 5).**
  Fitment itself now RENDERS — `lib/catalog/compatibility.ts`,
  `lib/catalog/use-compatibility.ts` and `components/catalog/CompatibilityPanel.tsx`,
  grouped by applicability so an exclusion reads as an exclusion; see
  `docs/compatibility.md` §"What the storefront renders". What is still absent is
  the picker: `GET /compatibility/fitments/verdict` and the four
  `/compatibility/vehicles/…` rungs are served and this package calls neither,
  because that is a cascading interaction rather than a read. When it is built the
  verdict must come from the server's `resolveFitment` and never from a rule
  re-derived here over the rendered list.
- **The product type's ordered field GROUPS — the read now EXISTS.**
  `GET /product-types/:key/specification-layout` serves the published version's
  group keys, labels, order and attribute placement, unauthenticated and behind
  no flag; it is a narrower TYPE than the authoring schema and carries none of
  the five authoring facts `PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS` names.
  `SpecificationGrouping` still has one member, `entity_scope`, because this
  package does not consume it yet: closing it is a second member plus the fetch,
  keying rows by `attributeKey` and rendering `ungroupedAttributeKeys` under
  their own heading.
- **A canonical CATEGORY BROWSE endpoint.** `GET /search` REQUIRES `q` ("a
  canonical search with no term is a browse, and browse already exists"), and the
  only category-scoped product read is the v1 `GET /listings?category=`. So the
  landing page's grid is the v1 read while its identity, breadcrumbs and facets
  are taxonomy-v2's. `POST /facets` already answers `matchedProductCount` for the
  same scope.
- **A taxonomy HTTP surface.** `db/taxonomy/taxonomyRepository.ts` implements
  `findCategoryByKey`, `findCategoryAncestors`, `findCategoryBreadcrumb`,
  `findChildCategories` and `resolveCategoryRedirect`, and `docs/taxonomy.md`
  says outright that step 1 shipped "schema, repository and gates only". Category
  identity therefore comes from the v1 tree; see `lib/catalog/category-tree.ts`
  for exactly what that costs.
- **A range facet control.** `FacetValues`' `range` and `money_range` branches
  need a two-handle control this workstream did not build. Their BOUNDS are
  stated, because a shopper reading "4.7 – 6.9 in" learns something true where an
  absent block would say the attribute does not exist. The URL grammar and the
  request shape already carry a bound, so the control is the whole of what is
  owed.
- **A saved-query destination.** A navigation node may point at a curated search
  with FILTERS and no term, and `/search` takes a term. Routing one there with an
  empty `q` would run a different query than the one an operator curated.
- **Merchandising collections** stay separate from taxonomy (ADR 0007 D3) and
  have no storefront route yet, so a `collection` node renders as a heading.
- **The `category_browse` SEO document — CLOSED, and the gate is what found
  it.** `seo-routes.test.ts` DIRECTION 3 refused the tree the moment a screen
  served a `planned` pattern, and what it caught was a half-done acceptance
  criterion rather than a typo: the storefront asks `GET /seo/resolve` for this
  page's canonical URL and `hreflang` alternates, and the registry answered
  `category_browse: null` — so the page would have shipped with neither tag on
  every deployment while "SEO metadata where applicable" read as satisfied.
  Closed by `resolveCategoryPage` in `seo.service.ts`, the `categories` reader
  in `sitemap.service.ts` and the category reads in `db/seo/seoRepository.ts`.
  A merged category answers a 301 to its successor; every other withdrawn state
  answers `not_found`, because a shelf nobody may browse into is an address that
  leads nowhere rather than a page with a `noindex` on it.
