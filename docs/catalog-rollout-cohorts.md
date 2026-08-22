# Catalog rollout cohorts — market, locale, store, category, product type

The operational half of ADR 0007 **D12** is
[`catalog-migration-operations.md`](catalog-migration-operations.md) and the
rollback procedure is
[`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md).
This file is about the fifth lever: **which slice of a deployment the four
catalog levers are switched on FOR**.

#367 Workstream 0 asks for "feature flags by market, locale, store, category and
product type". D12 decided a rollout order that needs exactly those five —
*internal users → selected stores → selected product types and categories →
locales and markets → general availability* — named a lever for it
(`CATALOG_AUTHORING_COHORTS`), and then recorded, in its own text, that nobody
built it and that **"selected stores" was therefore not a state this system
could be in**.

`CATALOG_ROLLOUT_COHORTS` is that lever. It is spelled `ROLLOUT` rather than
D12's `AUTHORING` because it narrows all four levers' surfaces and not only
authoring, and a variable whose name promises less than it does is the kind a
runbook step gets wrong.

---

## Part 1 — what already existed, per dimension

Answering "can a rollout be scoped by X today?" **before** building anything,
because four of the five turned out to be expressible somewhere already, under
other names, and a fifth mechanism that duplicated them would be two vocabularies
for one idea. What follows is the measured state of the repository **outside**
this domain; every entry is a live production path, not a plan.

### `market` — yes, in the most places of the five

These seven environment levers name a market, and they disagree about what empty
means — which is itself the reason a new one has to say. Every name below was
checked to exist in `config/index.ts`; the set is what a census of the config and
service layers found rather than a claim that no eighth exists:

| Lever | Kind | Empty means |
|---|---|---|
| `CHECKOUT_DESTINATION_COUNTRIES` | allow | unrestricted |
| `GUEST_CHECKOUT_BLOCKED_MARKETS` | block | no-op |
| `RETAIL_BLOCKED_MARKETS` | block | no-op |
| `STRIPE_SELLER_COUNTRIES` | allow | nobody may onboard (defaults to `ES`) |
| `EBAY_MARKETS` | allow | falls back to `EBAY_ES` |
| `MERCHANT_DEMAND_MARKETS` | allow | the undimensioned bucket only |
| `NL_INTENT_BLOCKED_COHORTS` | block | no-op |

Plus durable per-row market scopes: `retail_pilot_cohorts.market_country`,
`retail_suppressions` and `supplier_preflight_suppressions` (both carry a
`market` member in their scope vocabulary), `retail_market_capabilities`,
`procurement_offers.eligible_destination_countries`,
`commerce_relationships.territories`, `referral_pilot_cohorts.markets`.

### `locale` — yes, but only twice, and one of those is half-wired

- **`NL_INTENT_BLOCKED_COHORTS`** (`services/search-intent/enablement.ts`,
  `isCohortBlocked`) is the only environment lever in the repository that scopes
  by language. Its grammar is `<MARKET>:<language>`, with `<MARKET>:*` and
  `*:<language>` — the only place market and locale are composed.
- **`search_intent_enablements`** (`db/schema/searchIntent.ts`) is a durable
  per-`(category_id, language)` enablement row, where `category_id IS NULL` is
  the language-wide row. It is also the closest existing precedent for what this
  domain does, since it scopes by **two** of the five at once.
- **`retail_market_capabilities.support_languages`** blocks a retail sale on the
  customer's language (`support_language_unavailable`), and the input is
  currently hardcoded `null` in `retail-eligibility.service.ts` pending #129 — so
  the mechanism is live and the shopper-language half is not.

Everything else that looks like a locale flag is not one. `LAUNCH_LOCALES`
(`catalog-localization-desk.ts`) is a **reporting denominator**;
`SERVABLE_LOCALIZATION_STATUSES` (`catalog-localization/resolve.ts`) selects
which *string* is served and always falls through to base;
`STOREFRONT_LOCALES` / `DASHBOARD_LOCALES` decide which locales an app offers, not
what any feature does. `CATALOG_LOCALIZATION_ENABLED` was named by D12 and
deliberately not built — and note that it would have gated the localization
*domain*, not scoped anything *by* locale, so it was never this dimension.

### `store` — yes, but thinly

Exactly one environment lever names a store — **`GUEST_CHECKOUT_BLOCKED_SELLER_KEYS`**,
block-only — plus one cohort kind, **`CANONICAL_READ_COHORTS`**'s `store:`
(`services/backfill/cohort.ts`). The richer per-store machinery is
`merchant_activation_settings`, which is an *activation state* an operator sets
per store rather than a rollout scope, and merchant entitlements
(`services/entitlements/`), which is a per-store capability framework with **no
callers by design**.

### `category` — yes, and with the strongest enforcement of the five

- **`CANONICAL_READ_COHORTS`**'s `category:` kind (#60).
- **`SEO_CANARY_CATEGORY_IDS`** + `services/seo/rollout.ts`
  (`indexingPermittedFor`), which is the closest thing in the repository to what
  this domain does: a **canary keyed on a category rather than a hash bucket**,
  with the reasoning written down in that file.
- **`match_category_gates`** (#58): a per-category automatic-matching gate,
  closed by default, that must cite the benchmark run justifying it.
- **`search_intent_enablements.category_id`** (#95).
- **`retail_category_rules`** (#121).

Note the deliberate split the two closest precedents make: `SEO_CANARY_CATEGORY_IDS`
empty means **nothing**, `CANONICAL_READ_COHORTS` empty means **everything**, and
each file argues against the other explicitly. A new list has to pick one and say
why.

### `product_type` — **no. Genuinely absent, and this is the real gap.**

No flag, cohort, allow-list, block-list or enablement row anywhere takes a
product type as a scope value. `CATALOG_BACKFILL_COHORT_KINDS` is
`all | store | category | owner_type | connector_provider`. No pilot or cohort
table (`retail_pilot_cohorts`, `referral_pilot_cohorts`,
`search_intent_enablements`, `catalog_backfill_runs`) carries a product-type
column. `PRODUCT_TYPES_ENABLED` was named by D12 and deliberately not built.

The one product-type-shaped control is **`product_type_definitions.lifecycle =
'published'`**, and it genuinely withholds surfaces — the authoring wizard's type
list, the listing-upgrade preview, `GET /product-types/:key/specification-layout`
(a 404), and facet metadata all read it. D12 calls it "the stage boundary that
does exist". It is **not a rollout scope** and cannot be made into one: it is a
per-object lifecycle, all-or-nothing per key (`one_published_per_key`), and it
can say "this type is not live yet" but never "feature X is on for product type Y
and off for Z", nor "authoring is on for these stores but only for these types".

### And what is absent for all five

There is no percentage bucketing keyed on any of these dimensions.
`analytics_experiments` (#77) has an assignment unit and a traffic allocation and
**no targeting predicate at all**. There is no third-party flag SDK.

---

## Part 2 — the lever

```
CATALOG_ROLLOUT_COHORTS=store:store_abc,product_type:footwear.sneaker,market:ES
```

Comma-separated entries, each `<dimension>:<value>` or the literal `all`.
Dimensions are `CATALOG_ROLLOUT_DIMENSIONS` in `@mercaria/shared-types`:
`market`, `locale`, `store`, `category`, `product_type`.

**No migration and no table.** Nothing is stored; the whole lever is a frozen
config value and a pure matcher (`services/catalog-rollout/cohort.ts`).

### Semantics, and the reason for each

- **EMPTY means every cohort.** The `CANONICAL_READ_COHORTS` /
  `CHECKOUT_DESTINATION_COUNTRIES` rule, and here for a sharper version of it:
  the four levers **already** decide the whole deployment, so an empty default is
  today's behaviour exactly and adding the variable withdraws nothing from a
  deployment that never sets it. Deliberately NOT the `SEO_CANARY_CATEGORY_IDS`
  rule (empty ⇒ nothing), which is right *there* because an empty canary list
  would otherwise publish a catalogue.
- **`all` short-circuits**, so an operator can say "everything, explicitly"
  rather than by deleting a variable.
- **Entries are OR-ed.** D12's stages are sequential WIDENINGS of one rollout:
  each stage is the previous stage's entries plus more. Under AND, adding
  `market:ES` at the fourth stage would REMOVE the stores admitted at the
  second — the opposite of what "stage" means there. **So the stages are
  cumulative, and a runbook that replaces the list at each step is wrong.**
- **A request that can answer NO enabled dimension is REFUSED.** A canary that
  leaks the objects it could not classify is not a canary
  (`canonicalReadAllowedFor`'s ruling, reused). The cost is real and is stated
  rather than hidden: with only `store:S1` configured, `/navigation` — which
  knows a market and a locale and never a store — is outside the rollout and
  answers as it does with its lever off. That is correct for a stage called
  "selected stores", and it is the second reason the stages are cumulative.
- **A malformed entry NARROWS.** A typo is dropped twice — a shape filter in
  `config/index.ts`, then a dimension lookup against the tuple — and then matches
  nothing. A permissive parse is how a mistyped variable silently ships a surface
  to everybody.
- **`locale` matches on the SUBTAG BOUNDARY**: `locale:es` covers `es`, `es-ES`
  and `es-MX`; `locale:es-ES` covers only `es-ES`; `locale:e` covers `e-XX` and
  emphatically **not** `en` or `es`, so a truncated value narrows. Same device as
  `claim-scope.ts`'s label-wise domain containment, which exists so
  `notapple.com` is not covered by `apple.com`.
- **Every other dimension is EXACT — `category` included.** A category cohort
  does **not** cover its descendants. Resolving a subtree needs a database read
  and the matcher is pure, and a cohort whose blast radius depends on a tree
  somebody may re-parent is not one an operator can reason about at 3am.
  `SEO_CANARY_CATEGORY_IDS` made the same choice with the same `includes`. List
  the ids.
- **A market is compared upper-cased and a locale lower-cased**; a store id, a
  category id and a product-type key are case-SENSITIVE identifiers.
- **There is no percentage and none may be added.** `services/seo/rollout.ts`'s
  reasoning: a hash bucket has to be computed identically in every place it is
  consulted, and it is not something an operator can reason about during an
  incident.

### Where it is enforced, and what each surface can state

| Surface | Lever | Gate placement | Dimensions it can answer |
|---|---|---|---|
| `GET /navigation` | `CATALOG_TAXONOMY_V2_ENABLED` | `router.use` | market, locale |
| `GET /taxonomy/*` | `CATALOG_TAXONOMY_V2_ENABLED` | `router.use` | locale |
| `POST /facets` | `FACETS_ENABLED` | `router.use`, custom subject | category, locale |
| `GET /catalog-authoring/*` | `CATALOG_AUTHORING_ENABLED` | per route | product type, category, market, locale |
| `/stores/:storeId/product-drafts/*` | `CATALOG_AUTHORING_ENABLED` | `router.use` | **all five** |
| `/catalog-proposals/*` | `CATALOG_PROPOSALS_ENABLED` | `router.use` | store |

Two placements, and the reason is `product_type`. Its value is a ROUTE parameter
(`/catalog-authoring/schemas/:productTypeKey`), and Express populates route
parameters only once a route matches — so a router-level gate would judge that
request with the key unstated and, under a `product_type:` cohort, refuse the
very request the cohort exists to admit. Parsing the key back out of `req.path`
was the alternative and was rejected: a route renamed later would silently stop
matching, which **widens** the rollout, and a widening nothing announces is what
this whole gate exists to prevent.

**`/taxonomy` deliberately does not read `:categoryId`**, even though six of its
nine routes carry one. A cohort gate is a MOUNT-shaped decision — it admits or refuses
a whole request — and a tree read's ANSWER spans categories the cohort does not
name: admitting `/categories/c1/children` because `c1` is in the cohort would
then return children that are not. Filtering a tree by cohort is a different
feature from staging one.

### The refusal

**404, and it is the same 404 the lever gives.** A cohort narrowing is the mount
decision at a finer grain, and the storefront already treats that answer as "fall
back to what we served before" — `packages/frontend/lib/catalog/__tests__/navigation-fallback.test.ts`
executes the case. Reusing the status means a narrowed rollout needs no client
change and cannot produce a menu-shaped error on a shopper's first request.

**It names no dimension**, for `services/checkout/guest-rollout.ts`'s reason: a
refusal that said which lever fired would let a caller map the switchboard by
varying one input per request. The SUBJECT that could not be admitted, and the
enabled list it was compared against, are LOGGED — there is no "which cohort
fired" to report on a refusal, because a refusal is precisely the case where none
matched.

### It gates a request and nothing durable

No repository, no outbox enqueue and no loop reads a cohort — a draft, a
proposal or a navigation tree stored while a cohort was narrow is still there and
still reachable when it widens. That is the same promise the four levers make,
and here it is a **scanned wall** rather than a census:
`services/catalog-rollout/__tests__/catalog-rollout-isolation.test.ts` walks
every non-test module under `src/` and classifies each reader by directory —
configuration, the middleware, this domain and `routes/` may read it; `db/`,
every other service, `controllers/` and `jobs/` may not.

---

## Part 3 — the gates

Three, and each fails in a way the other two cannot.

1. **`services/catalog-rollout/__tests__/cohort.test.ts`** — the pure semantics,
   with every per-dimension case DERIVED by iterating
   `CATALOG_ROLLOUT_DIMENSIONS`. Its fixtures are a `Record` over the dimension
   union, so a sixth dimension added without a fixture fails `tsc` rather than
   going silently unmeasured. It includes the cross-check that catches a
   `catalogRolloutSubjectValue` case reading the WRONG field, which a
   same-dimension test cannot see.
2. **`routes/__tests__/catalog-rollout-cohorts.test.ts`** — each dimension end to
   end through the real Express chain, plus the coverage census. The census
   derives the catalog mounts from `app.ts` (every `app.use` inside a guard whose
   config namespace starts with `catalog`), resolves each to its router module
   through `app.ts`'s own imports, and walks the real Express stack. **A new
   public catalog mount fails the build until it is gated**; `/internal/*` mounts
   are exempt by rule, because an operator surface stays readable during the
   incident that narrowed the rollout.
3. **`services/catalog-rollout/__tests__/catalog-rollout-isolation.test.ts`** —
   the durable-record wall above.

**The control that makes the second one mean anything**: a sixth deployment with
no cohorts configured, where both probes must answer 400. Without it, a route
that had been deleted, unmounted or renamed would answer 404 to every probe and
every case would pass.

Measured mutations, all four red, each naming the thing that broke:

| Mutation | What went red |
|---|---|
| `catalogRolloutSubjectValue`'s `product_type` case reads `subject.categoryId` | 3 cases, naming `product_type`, including the cross-dimension check |
| the locale boundary rule becomes a bare `startsWith` | the truncated-value case |
| an empty cohort list stops meaning "everything" | the empty-list case |
| `router.use(catalogRolloutGate())` deleted from `routes/navigation.ts` | the `market` and `locale` refusal probes **and** the coverage census, naming `/navigation` |
| the per-route gate deleted from `/catalog-authoring/schemas/:productTypeKey` | the `product_type` refusal probe **and** the census, naming the route |
| a sixth dimension added to the tuple with no wiring | `tsc`, in three files — both gates' fixture `Record`s and `cohort.ts`'s two switches |
| `config.catalog.rolloutCohorts` read from a repository | the isolation wall, naming the file |

**One of those found a real defect while being measured.** The `switch` in
`catalogRolloutSubjectValue` was documented as making a new dimension a compile
error, and it was not: this package compiles with `strict: false`, where a
`switch` missing a case falls through and returns `undefined`, which type-checks
— so a sixth dimension would have silently answered "the subject cannot state
this" and refused every request that mentioned it. Both switches now assign the
scrutinee to `never` in a `default` case, which is what actually produces the
error.

---

## What this deliberately does not do

- **It does not filter results.** A cohort admits or refuses a REQUEST. Nothing
  narrows a list, a tree or a facet count to the cohort, and nothing should:
  that is a different feature, it would make a partially-rolled-out catalogue
  internally inconsistent, and it would put the lever inside the domains whose
  isolation walls forbid them from reading configuration at all.
- **It does not replace `CANONICAL_READ_COHORTS`.** That is #60's, over
  `listings`, with its own kinds (`owner_type`, `connector_provider`) and its own
  read-mode ladder. The two share a grammar deliberately and nothing else.
- **It grants nothing.** A cohort cannot admit a request `loadStore`,
  `requireStorePermission` or an operator allow-list would refuse. It only ever
  subtracts.
- **It adds no operator surface and no seventh allow-list.** Changing a rollout
  cohort is an environment change, like the four levers it refines.

## Open

- **The census's guard set is derived; the LEVER set is not.** The coverage
  census finds mounts inside any `config.catalog*` guard, so a fifth catalog
  lever in that namespace is covered automatically — but a catalog lever placed
  under a differently-named config namespace would not be. That is the same
  shape as `catalog-rollout.realdb.test.ts`'s nine-surface hand list, recorded
  here rather than left to be discovered.
- **`product_type` is answerable on two surfaces** (the authoring schema route
  and a draft's body). A rollout that wanted to stage the storefront by product
  type would need a surface that states one, and none does today.
- **Nothing has been flipped on a running deployment.** The rehearsal in
  [`runbooks/catalog-rollout-rollback.md`](runbooks/catalog-rollout-rollback.md)
  §"The rehearsal" is still outstanding and this lever joins it.
