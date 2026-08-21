# Compatibility and automotive fitment (#367 step 8)

> Binding decision: **ADR 0007 D8**, constrained by D1 (identity is an opaque id
> plus a stable machine key, never a label), D6 (an axis is an attribute, and a
> compatibility target is refused as one), D7 (a source's claim and a canonical
> fact are different rows) and D13 (nothing existing is re-modelled).
> Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`.

"Does this fit?" is a relationship between two catalogue identities. This domain
answers it for accessories, replacement parts, consumables and software, and for
vehicles — which is the hard case, and the one every decision below is shaped
around.

## The sentence the whole domain exists to hold

**A year range, a make or a model may never be stored as a variant option.**

A mid-range brake pad fits on the order of a thousand vehicle configurations.
Expressed as variant options that is one SKU with a thousand variants: a thousand
rows of stock nobody counts, a thousand canonical variant signatures that
describe a car rather than a part, a thousand offers to compare against each
other, and a variant matrix the authoring wizard (D10) would try to render. The
part did not change. Only the question did.

Two independent walls hold it, in opposite directions, and neither is a rule
somebody follows:

- **No module of this domain can write an option row.** Not by policy — by the
  import graph. Nothing under `services/compatibility/` or `db/compatibility/`
  names `listing_options`, `product_variant_option_values`, their drizzle
  constants, or the two repositories that write them.
- **No option-writing module can reach this domain**, so a vehicle fact cannot
  arrive at those tables through the front door either.

`services/compatibility/__tests__/compatibility-isolation.test.ts` scans both,
plus a third census over the real drizzle columns of both option tables. That
third one is deliberately a COLUMN census and nothing more: the option tables
store their axis in a free-text `name`, and no static gate can see a VALUE. The
value-level guarantee is the first wall; the census catches the other shape of
the same mistake — somebody adding `listing_options.vehicle_generation_id`
because it seemed like the tidy place for it.

D6's axis CHECK (refusing a compatibility target as an axis) is the other half
and belongs to merge-order step 4. The two are independent walls around one hole.

## Unknown is not false

`CompatibilityApplicability` has FOUR members and `does_not_apply` is a different
value from `unknown`, not a nullable boolean's two faces.

| Value | Means |
|---|---|
| `applies` | It fits, on the terms this row states. |
| `partially_applies` | It fits some of what the target names, and the row says which through its conditions. |
| `does_not_apply` | A POSITIVE statement that it does not fit. Somebody established this. |
| `unknown` | Nobody has established anything. |

A shopper told "does not fit" ACTS on it — they buy something else, or they
return the part they already bought. So reporting an absence of data as a refusal
is a wrong answer with a consequence, and reporting a refusal as an absence sells
somebody a part that will not go on their car. A nullable boolean can express
three of these and conflates the two that matter most.

`resolveApplicability` is the severity rule that keeps them apart:
`does_not_apply` beats `unknown` beats `partially_applies` beats `applies`, so a
set of claims about one pairing can only ever resolve UPWARD in caution. An empty
set is `unknown`, never `does_not_apply`.

## An exclusion is an ordinary row

`FITMENT_TARGET_SCOPES` is a ladder — make, model, generation, configuration —
ordered broadest first, and `resolveFitment` lets the NARROWEST scope that said
anything decide. That single ordering is why exclusions need no separate table
and no `is_exclusion` boolean:

- "Fits the 2012–2019 Golf" is a generation-scoped `applies`.
- "But not the GTI" is a configuration-scoped `does_not_apply`.
- "Does not fit the Focus, EXCEPT the 2019 facelift" is a model-scoped
  `does_not_apply` with a configuration-scoped `applies` under it — and the
  specificity rule works in that direction too, which is what makes it a
  specificity rule rather than a pessimism rule.

Within one scope, `resolveApplicability` decides, so two sources contradicting
each other at the same specificity resolve to the more cautious answer rather
than to whichever row was written last.

A make-scoped fitment is rare and legitimate — a universal wiper connector, a
manufacturer-wide diagnostic tool — and having the scope means such a claim does
not have to be exploded into ten thousand configuration rows that then rot
independently.

## A claim and a selected fact are different rows (D7)

`compatibility_claims` keeps what a source SAID, verbatim, including a target
Mercaria could not resolve. `generic_compatibility_relations` and
`automotive_fitments` hold the canonical answer.

- **A claim never becomes canonical by being stored.** `recordCompatibilityClaim`
  creates no relation, whatever the claim says and whoever made it; its return
  type has no relation id to hand back. A feed asserting a million fitments
  produces a million claims and zero published facts.
- **`promoteClaimToRelation` / `promoteClaimToFitment` are the other half** — an
  explicit act that opens the canonical row and marks the claim as the one it was
  selected from, in ONE transaction.
- **An unresolved claim is a first-class outcome.** There is deliberately no code
  path that DROPS a claim Mercaria could not read: the class of claims that
  resolve to nothing is the one an operator most needs, because it is the only
  evidence of what a feed was trying to say, and a feed whose format changed
  produces thousands of them at once — which is a signal, and an empty table is
  not. `countUnresolvedBySource` reports the breakdown BY REASON, because
  `unknown_target` at scale means the vehicle tree is missing rows somebody can
  import while `unparsed_target` at the same scale means no amount of reference
  data will help.
- **The raw text is frozen by trigger** and DELETE is refused outright. The edit
  that would actually happen is not malice — it is a re-import that finds the row
  and updates every column, quietly replacing the raw text an operator was about
  to read.

## A title can never establish a fit

`COMPATIBILITY_VERIFICATION_METHODS` has no `title_similarity`, `name_match` or
`category_match` member, so "verified because the names looked alike" has no
value to be stored as. `COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS` names seven
prohibitions as VALUES and a test asserts the two unions are disjoint.

The reason is sharper here than in #55: two products whose titles match to four
decimal places are routinely a 2016 part and a 2017 part that do not interchange.

`disputed` is the sixth verification state and the divergence from #55's five
that earns this domain its own tuple. A brand relationship has one truth and a
rival claimant is a dispute about who holds it; a compatibility claim can have
two well-sourced parties flatly contradicting each other about one pairing — the
manufacturer's catalogue and an aftermarket supplier's, routinely — and that has
to be storable without either being called `rejected`. A `disputed` relation
publishes `unknown`, never a side.

## The publication policy, and its asymmetry

`services/compatibility/compatibility.service.ts` and `fitment.service.ts` both
publish a positive claim only from `verified`, and a NEGATIVE one from
`verified`, `candidate` and `disputed`.

An unreviewed claim that a part FITS is a guess somebody would spend money on. An
unreviewed claim that it does NOT is a reason to check, and suppressing it sells
the part anyway. "We are not sure this fits" is the cheapest possible thing to be
wrong about.

## The seven tables

| Table | Holds |
|---|---|
| `generic_compatibility_relations` | The selected canonical answer for a non-vehicle pairing. |
| `compatibility_claims` | What a source said, for BOTH halves of the domain. |
| `vehicle_makes` | A manufacturer, as vehicle reference data. |
| `vehicle_models` | One model line of one make. |
| `vehicle_generations` | One production run of a model. |
| `vehicle_configurations` | One buildable specification within a generation. |
| `automotive_fitments` | One statement that a part does (or does not) go on a class of vehicle. |

Design notes worth reading before editing any of them:

- **`vehicle_makes` is deliberately NOT `brands`.** A brand (#54/#55) is a
  commercial identity that can be owned, claimed, verified and badged; a make is
  a classification node in a fitment tree, and a fitment claiming "fits
  Volkswagen" asserts nothing about Volkswagen the organization. Collapsing them
  would let a vehicle-data import mint rows in the table #55's badges are keyed
  on — and, in reverse, would make a brand merge rehome fitments.
- **`UNIQUE(make_id, key)` on models, not a global unique on `key`.** `golf` is
  Volkswagen's and nobody else's, but `focus`, `civic` and `500` recur across
  manufacturers, and a global unique would make the SECOND importer of a
  colliding name unable to store a real model. That is `product_variants.sku`'s
  finding (#296) asked of a different column: what does a legitimate second row
  look like?
- **A generation's production span and a configuration's availability span are
  different facts.** A generation ran 2012–2019; the 2.0 TDI within it was
  offered 2012–2016 and the facelift engine 2017–2019. Storing one and deriving
  the other puts every configuration on a span nobody offered it for.
- **Every discriminating column on a configuration is nullable**, and that is the
  design. A configuration imported from a feed that publishes engine and body but
  not transmission is a real, useful row, and defaulting the missing one would
  put a fabricated fact into a column a shopper filters on.
- **There is no evidence table.** #55 has one because a brand relationship's
  proof is a document with a digest that outlives the claim. A compatibility
  claim's evidence IS the claim: what a source said, where, when, and with what
  raw text.
- **No labels beyond `name`.** Localized display belongs to the localization
  family (D4), which is merge-order step 2 and a different module. A typed
  compatibility target carries a namespaced KEY (`connector.usb_c`) and no
  display string at all — a label here would be a second name for the concept,
  unlocalized and unversioned.
- **No VIN, plate, buyer, order or price column exists anywhere.** A VIN
  identifies one physical car with an owner and a service history attached.
  `COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS` names six such facts and a column
  census walks all seven tables against it, with the three ATTRIBUTION columns
  (`verified_by_oxy_user_id`, `revoked_by_oxy_user_id`,
  `reviewed_by_oxy_user_id`) exempted by an exact-count list that also asserts
  each exempted column really exists.

## Reverse lookup is an index, not a second row

`COMPATIBILITY_DIRECTIONS` has two members, not three: "B fits A" is the row
"A fits B" with its endpoints swapped, and admitting both spellings means one
fact has two rows that can be verified separately, expire separately and
eventually contradict each other. `mutual` exists because `works_with` genuinely
is symmetric and forcing a direction onto it would make the choice of subject
arbitrary — and an arbitrary choice is one a second source makes differently.

D8 requires "accessories compatible with this product" to be an indexed read.
Four target-side partial indexes serve it, one per target kind, each leading with
the target id and carrying the kind and the verification state. Two subject-side
indexes serve the forward question. Six indexes on one table is a lot, and it is
the cost of a relation genuinely read from both ends.

`listFitmentsForVehicle` is the one to read before editing: it takes a vehicle
ANCESTRY and returns every fitment attached at ANY of the four levels, in one
statement, with each branch pairing the SCOPE with the id. The pairing is
load-bearing — `vehicle_model_id` is set on model-, generation- AND
configuration-scoped rows, so a bare `vehicle_model_id = $1` would return every
generation-specific fitment to a shopper who only told us the model.

## What is enforced by the database

`compatibility.realdb.test.ts` drives all of it against a real server. The two
worth naming:

- **`cardinality`, never `array_length`.** On an empty array `array_length` is
  NULL and a CHECK rejects only FALSE, so `array_length(col,1) >= 1` ADMITS `{}`
  — the exact row it exists to refuse. This schema has hit that twice (#68). The
  suite asserts the arithmetic itself, and the mutation was measured: swapping
  the spelling turns the `partially_applies` case red.
- **Two implications, because the claim states partition THREE ways.**
  `unresolved` must point at nothing, `selected`/`corroborating`/`conflicting` at
  exactly one row, and `rejected`/`superseded` at either — a claim rejected
  before anybody attached it never had a target. A biconditional expresses two
  groups, so the tempting single constraint
  `(state = 'unresolved') = (num_nonnulls(...) = 0)` refuses exactly the
  rejection an operator makes on an unparseable claim. Also measured: it turns
  the rejection case red.

Six triggers, in migration `0092_brainy_deathstrike.sql`, each inside its own
`-- oxy:handwritten-begin=` / `-- oxy:handwritten-end=` pair so a regeneration
that drops them fails the build rather than silently enforcing nothing:

| Trigger | Refuses |
|---|---|
| `mercaria_vehicle_makes_key_freeze` (and three siblings) | Renaming a vehicle record's stable key. A wrong key is corrected by a MERGE, never a rename — to every seed and mapping that cited the old key, a rename is indistinguishable from the concept having been deleted. |
| `mercaria_automotive_fitment_ancestry` | A fitment whose denormalized `vehicle_make_id` disagrees with its narrower target. A Ford part claiming a Volkswagen generation would render perfectly and answer the picker under both. |
| `mercaria_compatibility_claims_raw_freeze` | Editing what a source said, and deleting a claim at all. |

Two generated columns, `relation_key` and `fitment_key`, carry the
duplicate-prevention uniques. The raw columns cannot: Postgres treats NULLs as
distinct, and three of the four target pointers are NULL on a make-scoped row.
`position` is IN the fitment key and the qualifiers are not — one part
legitimately has a front and a rear fitment on one car, while two rows differing
only by qualifier are one fact stated twice.

Both keys are re-rendered in TypeScript (`relationKeyOf`, `fitmentKeyOf`) so a
conflicting row can be read back, and the realdb suite compares each against the
value Postgres actually stored. A second spelling of a generated expression is a
thing that can disagree.

## The merge plan (#59), and the guard spelling that measures nothing

Nine columns of this domain reference a mergeable canonical entity, so
`merge-plan-census.test.ts` fails the build until each has a disposition.

- The four `generic_compatibility_relations` endpoints and the two
  `automotive_fitments` subjects are **`repoint_if_absent`**: a claim the winner
  already carries stays on the tombstone rather than colliding, and nothing is
  lost because the winner already answers it.
- The two `compatibility_claims` subjects are **`retained_by_tombstone`**.
  Repointing would rewrite what a source SAID into a claim about an entity it
  never named, which is the one thing the claim layer exists to prevent — and
  `mercaria_compatibility_claims_raw_freeze` refuses the UPDATE anyway, so a
  wrong disposition fails the phase rather than corrupting the record. The
  SELECTED canonical fact still follows the winner, through the six entries
  above.

**`uniqueWith` must name the RAW components of the generated key, never the
generated column itself.** This is the part that looks obvious and is wrong.

`generic_compatibility_relations_open_key` is `(kind, relation_key)` and
`automotive_fitments_open_key` is `(fitment_key)`, so naming `relation_key` in
`uniqueWith` reads as the exact statement of the constraint. It measures
nothing. The runner's `absenceGuard` compares
`other.<uniqueWith> IS NOT DISTINCT FROM <the row being moved>.<uniqueWith>`, and
the key CONTAINS the id being moved — so the loser row's pre-move key can never
equal a winner row's key, the guard never fires, and the collision it exists to
prevent lands as a `23505` that fails the merge phase. Measured against a real
server, both spellings, on the same fixture:

```
uniqueWith = [relation_key]                       -> 23505, guard VACUOUS, phase FAILED
uniqueWith = kind + the six OTHER key components  -> moved=0, guard fired
```

So the rule is: **every component of the key except the one being moved.** For
`generic_compatibility_relations` that is `kind` plus six of
`subject_product_id`, `subject_variant_id`, `target_family_id`,
`target_product_id`, `target_variant_id`, `target_type`, `target_key`; for
`automotive_fitments` it is six of `subject_product_id`, `subject_variant_id`,
`vehicle_make_id`, `vehicle_model_id`, `vehicle_generation_id`,
`vehicle_configuration_id`, `position`. Each entry also carries
`guardWhereNullColumn: validTo`, so the guard is exactly as wide as the partial
unique it guards and never wider.

**Known limitation — [#405](https://github.com/OxyHQ/Mercaria/issues/405).** A
relation naming the loser on BOTH ends cannot be repointed at all: the move makes
subject and target equal and
`generic_compatibility_relations_distinct_endpoints_check` raises `23514`. No
`uniqueWith` can express "skip this row because the OTHER endpoint is also
becoming the winner" — the guard only looks for a colliding winner row. #55 has
the identical hazard (`commerce_relationships_distinct_brands_check` plus
`related_brand_id`) and solved it with `conflict_gated`, which here would need a
new `CATALOG_MERGE_CONFLICT_KINDS` member, a column pair on
`catalog_merge_conflicts`, a probe and a resolution branch — four files across
three domains, so it is #405 rather than part of this one. The failure direction
is the safe one: `23514` blocks the phase loudly, `blocked` is not claimable so
no dispatcher spins on it, and each phase is its own transaction so nothing is
half-moved. The remedy is to close the relation before merging.

## The public read surface

`routes/compatibility.ts` + `controllers/compatibility.controller.ts` +
`middleware/compatibility-schemas.ts`, mounted at `/compatibility`
**unconditionally**. Eight reads, no writes.

| Route | Answers |
|---|---|
| `GET /compatibility/relations` | Both directions. Exactly one selector: a subject (`subjectProductId` / `subjectVariantId`) or a target (`targetProductId` / `targetVariantId` / `targetFamilyId` / the `targetType`+`targetKey` pair). The response names the `lookup` it answered. |
| `GET /compatibility/fitments` | The vehicles one part is stated to fit, **exclusions included**. |
| `GET /compatibility/fitments/verdict` | One part against one car: the `FitmentVerdict` plus every statement it rested on. `makeId` required, the three narrower rungs optional, `year` optional. |
| `GET /compatibility/vehicles/makes` | The picker's first rung. |
| `GET /compatibility/vehicles/makes/:makeId/models` | …its second. |
| `GET /compatibility/vehicles/models/:modelId/generations` | …its third. |
| `GET /compatibility/vehicles/generations/:generationId/configurations` | …its fourth, optionally narrowed by `year`. |

The rules that are load-bearing, each pinned by
`services/compatibility/__tests__/compatibility-public-read.realdb.test.ts`:

- **No `applicability`, `applicabilities`, `verification` or `includeUnpublished`
  parameter exists, and `.strict()` refuses one.** A fitment read narrowed to
  `applies` answers a confident yes for every vehicle somebody explicitly
  excluded — the failure the four-valued applicability exists to prevent,
  arriving through a query string. The repository's `FitmentLookupFilter` accepts
  those narrowings because a merchandising caller that has already resolved a
  verdict needs them; a shopper's URL is not that caller.
- **`disputed` obeys the publication ASYMMETRY rather than escaping it.** A
  disputed POSITIVE publishes nothing (picking one of two contradicting sources
  is picking the side that makes a sale); a disputed NEGATIVE is published, as a
  caution. Two modules used to claim in prose that it published nothing either
  way while `PUBLISHABLE_NEGATIVE` listed it and nothing tested the sentence.
  The tuples were right; the comments were wrong, and both are now pinned in both
  directions.
- **`truncated` is measured on what the QUERY examined, not on what survived the
  policy.** The filter runs after the query (the `stale_at` posture), so
  `rows.length < limit` is no evidence the end was reached. The bound is measured
  with `limit + 1` and the extra row discarded. Filtering first and comparing the
  length against the limit reports NOT truncated exactly when the discarded row
  was one the policy withheld — a page claiming to be complete because part of it
  was suppressed.
- **A vehicle named at ANY rung resolves upward.** `findPartialVehicleAncestry`
  widens from the narrowest id given and re-reads the levels above it, so a
  generation named under somebody else's model cannot collect that model's
  statements. The narrower rungs stay `null` — choosing a generation for somebody
  who named only a model is inventing the question. `answerFitment` previously
  widened only from a configuration, which left most of the picker's states with
  no vehicle rows and made the verdict projection drop every statement it was
  built from: `determined` with an empty evidence list and nothing reporting it.
- **Mounted unconditionally**, unlike `/price-history` and `/price-signals`. Those
  publish a derived claim over data production already holds, so a lever is the
  only way to withdraw one; here the claim is withheld by the publication policy,
  which is narrower than a mount, and withdrawal is per row through
  `closeCompatibilityRelation`. A lever would additionally have to default false
  to preserve today's behaviour, and today's behaviour is that a product page
  renders no fitment at all.
- **No analytics event is emitted.** `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES` has
  no compatibility member and `analytics_events.event_type` CHECKs against that
  tuple, so an emission would be refused at the row. "This shopper asked whether a
  part fits their car" is also a fact about a person's vehicle.
- **The domain's five isolation walls now cover the HTTP surface.**
  `compatibility-isolation.test.ts` enumerated `services/compatibility/`,
  `db/compatibility/` and the schema file, and carried a comment claiming the
  domain had no HTTP surface "checked against the tree, not assumed" — **there was
  no such check**. The enumeration now derives `routes/`, `controllers/` and
  `middleware/` files named for the domain by the same filename convention, with a
  floor per layer, and prints its population size on success.

## The two boundaries a year and a nameplate cannot decide (#820)

`services/compatibility/__tests__/fitment-boundaries.realdb.test.ts` builds the
vehicle tree the other two realdb files do not: two generations of one model
whose production windows OVERLAP, and two configurations of one generation
sharing a `name` AND a `trim` and differing only in `engine_code`.

**Both properties were already correct when the file was written.** Nothing was
fixed; what changed is that neither could previously fail. They are:

- **`listFitmentsForVehicle` pairs every SCOPE with its own id.** So a
  generation-scoped statement is collected by generation id, and a year inside
  two overlapping windows answers for one generation and not the other. Pinning
  it needed a fitment verdict taken ACROSS the boundary — at `9c5268d7` exactly
  one `answerFitment` call in the repository passed a `year` at all, and it named
  one generation. `verticals-brake-pad.realdb.test.ts` and
  `verticals-package-controls.test.ts` already covered the other two halves (the
  windows genuinely overlap, derived from the stored rows; the picker returns
  each generation's own configurations at a shared year), so this file does not
  restate them.
- **`upsertVehicleConfiguration` keys on the stable machine KEY** (D1), never on
  the name, so one nameplate over two engines stays two rows. This is the FALSE
  MERGE #58 is shaped around, one domain over: collapsing the pair looks exactly
  like a correct match, every page renders, and the person who finds out is the
  one who fitted the wrong pad. `engine_code` had zero occurrences in any
  `*.test.ts` in the repository before this file.

Both fixtures are ADVERSE and self-tested — the overlap is re-derived
arithmetically from the stored production windows rather than restated from the
constants, and the ambiguous pair is asserted equal on every other
discriminating column — so a later reader who gives the two configurations
different names, or moves a generation so the windows no longer meet, turns a
control red instead of leaving two cases that measure nothing.

**One thing this deliberately does not change.** `projectVehicleReference`
publishes `{id, key, name}` and no engine code, so the ambiguous pair reaches a
client under one identical `name`, separable only by the stable `key`. The
resolver does not collapse them — that is what the file pins — but a picker
rendering from `name` alone would show one label for two different cars. D1/D4
keep display out of this domain, so it is written into the test rather than
changed here.

## What the storefront renders

`packages/frontend/lib/api/compatibility.ts` (the read),
`lib/catalog/compatibility.ts` (the pure partition), `lib/catalog/use-compatibility.ts`
(the query) and `components/catalog/CompatibilityPanel.tsx` (the rendering), reached
from `app/(app)/p/[handle].tsx`. Pinned by
`lib/catalog/__tests__/compatibility.test.ts` in the storefront's own `lib/**`
runner.

- **An exclusion renders AS an exclusion, and that is the whole of the client
  half.** The read publishes `does_not_apply` statements with no parameter to
  remove them, so the burden is entirely on the renderer — and it used to fail:
  `CompatibilityPanel` printed a flat list of vehicle names under one
  "Compatibility" heading, so an exclusion read as a fit. `partitionFitment` groups
  by the statement's own applicability and the panel takes each heading from a
  `Record` over the whole union, so a fifth applicability fails `tsc` rather than
  inheriting whichever heading an `else` named. `unknown` has its own group and its
  own words ("not confirmed"), because "we have no data for your car" is not "this
  does not fit your car".
- **`FITMENT_GROUP_POSITION` is a `Record`, never a member array.** The first
  version re-listed `COMPATIBILITY_APPLICABILITIES` as an ordered array and
  `validate:storefront-catalog` refused it by name — the hand-relisted-union shape
  that has already shipped a live bug here. Members are iterated from the shared
  tuple; only the ORDER is local, and it is deliberately not
  `COMPATIBILITY_APPLICABILITY_SEVERITY` (that resolves contradicting statements
  about ONE vehicle; this orders a list of different vehicles).
- **Two subjects, at most, and the count matters.** Always the product; plus the
  one configuration IN VIEW — the selected variant, or the product's only variant
  when it has exactly one. That last clause is not a convenience: the brake-pad
  reference vertical is "a product with ZERO variant axes, one canonical variant"
  and attaches its eleven statements to that variant, so without it every one of
  them is invisible until a shopper selects the only option there is, through a
  selector the page does not render. With SEVERAL variants and none selected
  nothing configuration-specific is shown, because a statement about one
  configuration is not a statement about its siblings. The two sets are disjoint by
  CHECK, so they concatenate with no deduplication question.
- **A failed read and an absent fitment are different answers**, checked in that
  order, so a broken endpoint is never presented as "this part fits nothing". Both
  render as ABSENCE: a section saying "we do not publish fitment for this product"
  on every product in the catalogue would be a permanent apology on a page where
  the vast majority have no fitment relationship at all.
- **Truncation is ORed across the subjects and surfaced.** A part fitting eleven
  hundred vehicles is ordinary, and presenting a page as the whole set would tell a
  shopper their car is absent from a list that simply ends.
- **The generic RELATION lookup is served and deliberately not called.**
  `CompatibilityRelationView.target` is a bare id union with no display name — a
  typed target's localized name is ADR 0007 D4's and the public read resolves none
  — so a relation fetched here would have nothing renderable in it. Counting them
  is possible and is not done: "compatible with 4 things" helps nobody. The
  resolution is what is owed, not the fetch.

## Seams, each named rather than stubbed
- **The vehicle picker and the shopper's own verdict.** DEFERRED, with a
  condition — not merely unbuilt.

  `GET /compatibility/fitments/verdict` and the four `/compatibility/vehicles/…`
  rungs are served, PROVEN over HTTP by
  `routes/__tests__/compatibility-routes.realdb.test.ts`, and the storefront calls
  neither. That is an interaction rather than a read — a cascading selection, a
  remembered vehicle, an answer that narrows as the shopper chooses — and when it
  is built, `resolveFitment` on the SERVER stays the only thing that may produce
  the verdict; a rule re-derived on the client from the rendered list would be the
  second implementation the shared resolver exists to prevent.

  **What would CLOSE it: a populated vehicle tree.** No adapter is registered, so
  `vehicle_makes` is empty on a real deployment and a picker shipped today would
  cascade a shopper through four empty dropdowns. This repository has a name for
  that — a control that renders only in a state nobody can reach, which is worse
  than an absent one because it looks built. The reference-data import is the seam
  below (`upsertVehicleMake` and its three siblings are ready for one); the picker
  is downstream of it and of nothing else. Both routes and their four rungs are
  finished, so the UI is the only remaining piece once a tree exists.

  Recorded here deliberately rather than left implicit: #367 Workstream 14's box
  asks that the selector and the reverse display be PROVEN, and they are — the
  reverse list is rendered by `CompatibilityPanel.tsx` in twelve locales, and the
  walk is proven at the service, HTTP and end-to-end layers. A green box must not
  be read as "a shopper can pick their car today".
- **D6's axis CHECK** (merge-order step 4) — the other wall around the option
  tables.
- **The localization family** (merge-order step 2) — every display name for a
  vehicle record and a typed target.
- **Ranking (#74).** A scanned gate keeps this domain out of it: "fits your
  vehicle" is an eligibility fact a shopper asked for, not a weight.
- **The OPERATOR surface.** PARTLY built (#367 Workstream 14), and the part that
  exists is the claim queue: `GET /internal/catalog-governance/reviews/compatibility-claims`
  lists the unresolved claims the `unresolved_compatibility_claim` count was only
  counting, and `POST .../:claimId/fitment` promotes one — the vehicle named in
  full by the operator, audited with a mandatory reason, opening a fitment that
  records `operator_review` so the row says a person decided. It is on the
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#56 use and NOT a seventh
  list, and it sits on the governance router beside the review route that was
  already there rather than in an `internal-compatibility.ts` of its own.

  **An ambiguous fitment is never resolved to the likeliest vehicle**, and that
  is four mechanisms rather than a rule: the vehicle is required input at every
  rung the scope demands, the promotion never reads `raw_target_text`,
  `COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS` names ten shapes a
  convenience would arrive under and is scanned over BOTH this domain and the
  governance one, and `assertClaimMatchesSubject` refuses a cross-subject
  promotion. See `services/catalog-governance/compatibility-claim.service.ts`.

  Still absent: a trace by RELATION id, a verification and a revocation, and
  `promoteClaimToRelation` — the generic half — which remains callerless. The
  automotive half is what Workstream 14's box asked for.
- **A vehicle picker's own reference-data import.** `upsertVehicleMake` and its
  three siblings key on the stable machine key and are ready for one; no adapter
  is registered, so nothing populates the tree today — which is also why the
  public picker answers empty lists on a real deployment.
